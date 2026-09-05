import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createBridge, redactHeaders, watchdogBudget } from "../lib/http-bridge.mjs";

// Start a bridge on an ephemeral port; return {port, bridge, close}.
function startBridge(opts = {}) {
  const bridge = createBridge({ port: 0, brandPrefix: "[test]", ...opts });
  return new Promise((resolve) => {
    bridge.httpServer.on("listening", () => {
      const { port } = bridge.httpServer.address();
      resolve({ port, bridge, close: () => bridge.httpServer.close() });
    });
  });
}

// Minimal HTTP request helper.
function req(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test("redactHeaders masks secret headers, keeps the rest", () => {
  const out = redactHeaders({
    "x-api-key": "SECRET", "x-mcp-token": "T", authorization: "Bearer z",
    "x-open-cloud-api-key": "K", "content-type": "application/json", host: "127.0.0.1:1",
  });
  assert.equal(out["x-api-key"], "[REDACTED]");
  assert.equal(out["x-mcp-token"], "[REDACTED]");
  assert.equal(out["authorization"], "[REDACTED]");
  assert.equal(out["x-open-cloud-api-key"], "[REDACTED]");
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["host"], "127.0.0.1:1");
});

test("bad Host header -> 403 forbidden host", async () => {
  const { port, close } = await startBridge();
  const res = await req(port, { path: "/health", headers: { Host: "evil.example.com" } });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden host/);
  close();
});

test("body over cap -> 413 payload too large", async () => {
  const { port, close } = await startBridge({ maxBodyBytes: 16 });
  const res = await req(port, { method: "POST", path: "/submit", body: "x".repeat(64) });
  assert.equal(res.status, 413);
  assert.match(res.body, /payload too large/);
  close();
});

test("malformed JSON on /submit -> 400 bad request (no parser internals)", async () => {
  const { port, close } = await startBridge();
  const res = await req(port, { method: "POST", path: "/submit", body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal(res.body, '{"error":"bad request"}');
  close();
});

test("auth: with token set, /poll without x-mcp-token -> 401", async () => {
  const { port, close } = await startBridge({ authToken: "s3cret" });
  const res = await req(port, { path: "/poll" });
  assert.equal(res.status, 401);
  assert.match(res.body, /unauthorized/);
  close();
});

test("late POST /result/<id> -> 200 ok and logs 'late result'", async () => {
  const { port, close } = await startBridge();
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const res = await req(port, { method: "POST", path: "/result/nonexistent-id", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"ok":true}');
    assert.ok(errs.some((e) => e.includes("late result for nonexistent-id")));
  } finally {
    console.error = orig;
    close();
  }
});

test("EADDRINUSE -> child process exits 1 with FATAL log", async () => {
  // Bind a server, then spawn a child that tries the SAME port via createBridge.
  const holder = http.createServer(() => {});
  await new Promise((r) => holder.listen(0, "127.0.0.1", r)); // wait for the async bind before reading .address()
  const port = holder.address().port;
  // Absolute import so the child resolves the lib regardless of its cwd.
  const libUrl = new URL("../lib/http-bridge.mjs", import.meta.url).href;
  const script = `
    import { createBridge } from ${JSON.stringify(libUrl)};
    createBridge({ port: ${port}, brandPrefix: "[child]" });
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  holder.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /already in use/);
});

// ── watchdogBudget: transport-level anti-wedge injection ────────────────────
test("watchdogBudget: wall+5s slack floored at 30; explicit preserved; null-safe", () => {
  assert.equal(watchdogBudget({ a: 1 }, 30_000).timeout_s, 35);
  assert.equal(watchdogBudget({ a: 1 }, 65_000).timeout_s, 70);
  assert.equal(watchdogBudget({ a: 1 }, 300).timeout_s, 30); // floor
  assert.equal(watchdogBudget({ a: 1, timeout_s: 99 }, 60_000).timeout_s, 99);
  assert.deepEqual(watchdogBudget(null, 30_000), { timeout_s: 35 });
  assert.deepEqual(watchdogBudget(undefined), { timeout_s: 35 }); // default 30s
});

test("inline submit injects payload.timeout_s into the delivered command; /result resolves the submit", async () => {
  const { port, bridge, close } = await startBridge();
  try {
    const done = bridge.submit("watchdog_ping", { x: 1 }, 30_000);
    const res = await req(port, { path: "/poll" });
    assert.equal(res.status, 200);
    const cmd = JSON.parse(res.body);
    assert.equal(cmd.type, "watchdog_ping");
    assert.equal(cmd.payload.x, 1);
    assert.equal(cmd.payload.timeout_s, 35); // injected by the transport, not the caller
    const rres = await req(port, { method: "POST", path: `/result/${cmd.id}`, body: JSON.stringify({ ok: true }) });
    assert.equal(rres.status, 200);
    const r = await done;
    assert.ok(!r.error, "submit promise resolves via the /result round-trip");
  } finally { close(); }
});
