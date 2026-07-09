import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Isolated LOCALAPPDATA so the inline server never reads/writes a real
// machine broker-token. Combined with ALLOW_TOKENLESS this pins the tokenless
// single-session behavior these guards target, independent of the host box.
const APPDATA_DIR = mkdtempSync(join(tmpdir(), "roblox-mcp-itest-"));
// Env every spawned server.mjs inherits: inline (pre-broker) mode + no token.
const INLINE_ENV = { ROBLOX_MCP_MODE: "inline", ROBLOX_MCP_ALLOW_TOKENLESS: "1", LOCALAPPDATA: APPDATA_DIR };

// Integration tests for the inline HTTP bridge in server.mjs. We spawn the real
// server.mjs on an isolated port (never 8765 — that's the live Studio bridge)
// and exercise its guards over HTTP. This tests the shipped artifact end-to-end
// without extracting the bridge (which would collide with the broker branch's
// lib/http-bridge.mjs superset on merge).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "server.mjs");

// Grab a free TCP port from the OS, then release it for the child to claim.
// (Small TOCTOU window, acceptable for a local test.)
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Minimal HTTP request helper. `agent: false` disables socket pooling so a
// server-side req.destroy() surfaces cleanly instead of poisoning a kept-alive
// socket for the next request.
function req(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1", port, method, path, agent: false,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
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

let child;
let PORT;

before(async () => {
  PORT = await getFreePort();
  child = spawn(process.execPath, [SERVER_PATH], {
    // INLINE_ENV pins the pre-broker single-session server (the inline
    // createBridge that logs "bridge on ..." and owns the port), tokenless and
    // with an isolated LOCALAPPDATA — the artifact these guards were written
    // against. Without it server.mjs defaults to broker mode (no "bridge on"
    // line -> startup timeout) and mints a machine token (-> 401 on /submit).
    env: { ...process.env, ...INLINE_ENV, ROBLOX_MCP_PORT: String(PORT) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Wait for the "bridge on ..." line on stderr (server.mjs logs it in the
  // listen callback), or fail fast if the child dies during startup.
  await new Promise((resolve, reject) => {
    let buf = "";
    const onErr = (c) => {
      buf += c;
      if (buf.includes(`bridge on 127.0.0.1:${PORT}`)) {
        child.stderr.off("data", onErr);
        resolve();
      }
    };
    child.stderr.on("data", onErr);
    child.once("exit", (code) => reject(new Error(`child exited early: ${code}\n${buf}`)));
    setTimeout(() => reject(new Error(`server did not start in time\n${buf}`)), 8000);
  });
});

after(() => {
  if (child && !child.killed) child.kill();
  rmSync(APPDATA_DIR, { recursive: true, force: true });
});

test("GET /health -> 200 ok:true", async () => {
  const res = await req(PORT, { path: "/health" });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.queued, 0);
  assert.equal(body.inFlight, 0);
});

test("GET /connection_status -> 200, plugin not connected", async () => {
  const res = await req(PORT, { path: "/connection_status" });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.pluginConnected, false);
  assert.equal(body.ready, false);
});

test("bad Host header -> 403 forbidden host", async () => {
  const res = await req(PORT, { path: "/health", headers: { Host: "evil.example.com" } });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden host/);
});

test("localhost Host header is allowed", async () => {
  const res = await req(PORT, { path: "/health", headers: { Host: `localhost:${PORT}` } });
  assert.equal(res.status, 200);
});

test("unknown route -> 404", async () => {
  const res = await req(PORT, { path: "/nope" });
  assert.equal(res.status, 404);
});

test("malformed JSON on /submit -> 400 bad request (no parser internals)", async () => {
  const res = await req(PORT, { method: "POST", path: "/submit", body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal(res.body, '{"error":"bad request"}');
});

test("late POST /result/<id> -> 200 ok:true (dropped, caller already timed out)", async () => {
  const res = await req(PORT, { method: "POST", path: "/result/nonexistent-id", body: "{}" });
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"ok":true}');
});

test("body over 8MB cap -> 413 payload too large, server stays alive", async () => {
  // 9 MB > MAX_BODY_BYTES (8 MB). The server must 413 and NOT crash.
  const big = "x".repeat(9 * 1024 * 1024);
  const res = await req(PORT, { method: "POST", path: "/submit", body: big });
  assert.equal(res.status, 413);
  assert.match(res.body, /payload too large/);
  // Liveness probe: a follow-up request must still succeed (no self-DoS).
  const health = await req(PORT, { path: "/health" });
  assert.equal(health.status, 200);
});

test("EADDRINUSE -> server.mjs exits 1 with FATAL log", async () => {
  // Bind a holder on a fresh port, then spawn server.mjs on the SAME port.
  const holder = http.createServer(() => {});
  await new Promise((r) => holder.listen(0, "127.0.0.1", r));
  const busyPort = holder.address().port;
  const r = spawnSync(process.execPath, [SERVER_PATH], {
    // Inline mode so the EADDRINUSE FATAL path under test is the createBridge
    // lifecycle (broker mode elects/spawns differently and won't bind here).
    env: { ...process.env, ...INLINE_ENV, ROBLOX_MCP_PORT: String(busyPort) },
    encoding: "utf8",
    timeout: 8000,
  });
  holder.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /already in use/);
});
