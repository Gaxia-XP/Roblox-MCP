/**
 * server/test/broker-core.test.mjs
 * Integration suite for the Broker's own HTTP server (broker-core.mjs) + the
 * thin broker.mjs entry. Runs under `node --test server/test/broker-core.test.mjs`
 * with NO node_modules. Every server binds an EPHEMERAL port (0) — never 8765/8766.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRegistry } from "../lib/registry.mjs";
import { createBrokerCore } from "../lib/broker-core.mjs";

// ── harness ──────────────────────────────────────────────────────────────
function startCore(opts = {}) {
  let t = opts.now ? opts.now() : Date.now();
  const clock = { read: () => t, set: (v) => (t = v), adv: (d) => (t += d) };
  const registry = createRegistry({ now: clock.read, thresholds: {} });
  const core = createBrokerCore({
    registry,
    now: clock.read,
    authToken: opts.authToken || "",
    brandPrefix: "[test-broker]",
    idleReapMs: opts.idleReapMs ?? 90_000,
  });
  return new Promise((resolve) => {
    core.httpServer.listen(0, "127.0.0.1", () => {
      const { port } = core.httpServer.address();
      resolve({ port, core, registry, clock, close: () => core.httpServer.close() });
    });
  });
}

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
const j = (s) => JSON.parse(s);

// ── /health: role/proto, unguarded ───────────────────────────────────────
test("GET /health -> {ok,role:'broker',proto:1,brokerId}, no token needed, no topology", async () => {
  const { port, close } = await startCore({ authToken: "s3cret" });
  try {
    const res = await req(port, { path: "/health" }); // NO x-mcp-token
    assert.equal(res.status, 200);
    const b = j(res.body);
    assert.equal(b.ok, true);
    assert.equal(b.role, "broker");
    assert.equal(b.proto, 1);
    assert.equal(typeof b.brokerId, "string");
    assert.ok(b.brokerId.length >= 16);
    assert.equal("sessions" in b, false); // no reconnaissance counts
    assert.equal("studios" in b, false);
    assert.equal("draining" in b, false);
  } finally { close(); }
});

test("forbidden Host -> 403 on a guarded endpoint", async () => {
  const { port, close } = await startCore();
  try {
    const res = await req(port, { path: "/studio/poll", headers: { Host: "evil.example.com" } });
    assert.equal(res.status, 403);
    assert.match(res.body, /forbidden host/);
  } finally { close(); }
});

test("token set: /studio/poll without x-mcp-token -> 401; /health stays open", async () => {
  const { port, close } = await startCore({ authToken: "s3cret" });
  try {
    const noTok = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "abc12345" } });
    assert.equal(noTok.status, 401);
    const health = await req(port, { path: "/health" });
    assert.equal(health.status, 200);
  } finally { close(); }
});

// ── studio plane: enqueue -> poll -> result roundtrip ────────────────────
test("enqueueToStudio delivers via /studio/poll; result resolves the promise", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    registry.upsertStudio({ studioId: "5701d001", label: "Alpha", connId: 1, legacy: false });
    const studio = { id: "5701d001", queue: core._internals.cmdQueue("5701d001") };
    const p = core.enqueueToStudio(studio, "create_part", { name: "X" }, 5_000);

    const poll = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "5701d001" } });
    assert.equal(poll.status, 200);
    const cmd = j(poll.body);
    assert.equal(cmd.type, "create_part");
    assert.deepEqual(cmd.payload, { name: "X" });
    assert.equal(typeof cmd.id, "string");

    const r = await req(port, {
      method: "POST", path: `/studio/result/${cmd.id}`,
      headers: { "x-studio-id": "5701d001" }, body: JSON.stringify({ ok: true, ref: "Workspace.X" }),
    });
    assert.equal(r.status, 200);
    assert.equal(j(r.body).ok, true);

    const result = await p;
    assert.deepEqual(result, { ok: true, ref: "Workspace.X" });
  } finally { close(); }
});

test("per-studio routing isolation: B's queue never holds A's command", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    registry.upsertStudio({ studioId: "a1a1aaaa", label: "A", connId: 1 });
    registry.upsertStudio({ studioId: "b1b1bbbb", label: "B", connId: 2 });
    const A = { id: "a1a1aaaa", queue: core._internals.cmdQueue("a1a1aaaa") };
    core.enqueueToStudio(A, "set_property", { p: 1 }, 5_000);

    // Deterministic: B's queue is empty; A's holds exactly one pending (no 10 s poll).
    assert.equal(core._internals.cmdQueue("b1b1bbbb").pending.length, 0);
    assert.equal(core._internals.cmdQueue("a1a1aaaa").pending.length, 1);

    // A polls: gets its own command immediately.
    const pollA = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "a1a1aaaa" } });
    assert.equal(j(pollA.body).type, "set_property");
  } finally { close(); }
});

test("missing x-studio-id maps to legacy:default; bare /poll alias too", async () => {
  const { port, core, close } = await startCore();
  try {
    const studio = { id: "legacy:default", queue: core._internals.cmdQueue("legacy:default") };
    core.enqueueToStudio(studio, "run_luau", { src: "print(1)" }, 5_000);
    // header-less /studio/poll → legacy:default
    const poll = await req(port, { path: "/studio/poll" });
    assert.equal(j(poll.body).type, "run_luau");

    // bare legacy alias /poll also routes to legacy:default
    core.enqueueToStudio(studio, "run_luau", { src: "print(2)" }, 5_000);
    const legacy = await req(port, { path: "/poll" });
    assert.equal(j(legacy.body).payload.src, "print(2)");
  } finally { close(); }
});

// ── contested studio: two distinct connIds → __assign_studio_id on control ─
test("two distinct connIds within window mark contested; control-poll gets __assign_studio_id; commands held", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    registry.upsertStudio({ studioId: "d00e0001", label: "Dup", connId: 0 });
    const studio = { id: "d00e0001", queue: core._internals.cmdQueue("d00e0001") };
    core.enqueueToStudio(studio, "create_part", { n: 1 }, 5_000);

    // Drive contested explicitly: two distinct connIds within the window.
    core._internals.noteConn("d00e0001", 101);
    core._internals.noteConn("d00e0001", 102); // 2 distinct → contested
    assert.equal(registry.getStudio("d00e0001").contested, true);

    // While contested, the command stays queued (never first-poll-stolen).
    assert.equal(core._internals.cmdQueue("d00e0001").pending.length, 1);

    // Broker injects __assign_studio_id on the CONTROL queue; control-poll gets it.
    core.enqueueControl("d00e0001", "__assign_studio_id", { studio_id: "fec50000ddaa0001" });
    const ctrl = await req(port, { path: "/studio/control-poll", headers: { "x-studio-id": "d00e0001" } });
    assert.equal(ctrl.status, 200);
    const c = j(ctrl.body);
    assert.equal(c.type, "__assign_studio_id");
    assert.equal(c.payload.studio_id, "fec50000ddaa0001");
  } finally { close(); }
});

// ── drain blocks new dequeues; refuses while in-flight ────────────────────
test("draining: /studio/poll returns {} (no new dequeue) and sweep stays non-idle while inFlight>0", async () => {
  const { port, core, registry, clock, close } = await startCore({ idleReapMs: 10 });
  try {
    registry.upsertStudio({ studioId: "d4a10001", label: "D", connId: 1 });
    const studio = { id: "d4a10001", queue: core._internals.cmdQueue("d4a10001") };
    // Put a command in flight (delivered, not resolved): enqueue + poll delivers it.
    core.enqueueToStudio(studio, "long_op", {}, 5_000);
    await req(port, { path: "/studio/poll", headers: { "x-studio-id": "d4a10001" } }); // delivers → inFlight

    assert.equal(core.inFlight.size, 1);
    core.beginShutdown();

    // Queue a fresh command; a draining poll must NOT dequeue it.
    core.enqueueToStudio(studio, "new_op", {}, 5_000);
    assert.equal(core._internals.cmdQueue("d4a10001").pending.length, 1);
    const drainPoll = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "d4a10001" } });
    assert.equal(drainPoll.body, "{}"); // draining → no new dequeue
    assert.equal(core._internals.cmdQueue("d4a10001").pending.length, 1);

    // sweep is NOT idle while inFlight>0 (idle-reap blocked).
    clock.adv(1_000);
    const sw = core.sweep(clock.read());
    assert.equal(sw.idle, false);
    assert.equal(sw.shouldReap, false);
  } finally { close(); }
});

// ── redaction on a new endpoint ──────────────────────────────────────────
test("secret headers to /studio/poll log as [REDACTED]", async () => {
  const { port, close } = await startCore();
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    // Fire the poll but DON'T await it (empty queue → 10 s long-poll). The log
    // line is emitted at request entry, before parking, so a short wait suffices.
    req(port, { path: "/studio/poll", headers: { "x-studio-id": "5edac701", "x-mcp-token": "TOPSECRET", "x-api-key": "KEY123" } });
    await new Promise((r) => setTimeout(r, 60));
    const line = logs.find((l) => l.includes("/studio/poll"));
    assert.ok(line, "expected a log line for /studio/poll");
    assert.ok(!line.includes("TOPSECRET"), "x-mcp-token must be redacted");
    assert.ok(!line.includes("KEY123"), "x-api-key must be redacted");
    assert.ok(line.includes("[REDACTED]"));
  } finally { console.error = orig; close(); }
});

// ── C5.1 + C5.3: /session/resolve-target round-trips UNKNOWN_TARGET; target:"all" fans out ─
test("C5: POST /session/resolve-target is token-gated and returns the registry envelope", async () => {
  const { port, registry, close } = await startCore();
  try {
    registry.upsertSession({ sessionId: "sessR001", pid: 1, label: "R" });
    const token = registry.mintSessionToken("sessR001", 1);

    // unauthenticated → 401 (same gate as /session/submit)
    const noTok = await req(port, {
      method: "POST", path: "/session/resolve-target",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "sessR001", target: "nope-nope-nope" }),
    });
    assert.equal(noTok.status, 401);

    // authenticated, unknown target → 200 with an UNKNOWN_TARGET envelope
    const r = await req(port, {
      method: "POST", path: "/session/resolve-target",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify({ session_id: "sessR001", target: "nope-nope-nope" }),
    });
    assert.equal(r.status, 200);
    const env = j(r.body);
    assert.equal(env.error, "UNKNOWN_TARGET");
    assert.equal(env.code, "UNKNOWN_TARGET");
    assert.ok(Array.isArray(env.candidates));
  } finally { close(); }
});

test("C5: /session/submit target:'all' fans out to live studios -> { fanout:true, results, ok, failed }", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    registry.upsertSession({ sessionId: "sessAll1", pid: 1, label: "All" });
    const token = registry.mintSessionToken("sessAll1", 1);
    const t = Date.now();
    registry.upsertStudio({ studioId: "fa0040aa", label: "FA", connId: 1 }, t);
    registry.upsertStudio({ studioId: "fb0040bb", label: "FB", connId: 2 }, t);
    registry.touchStudio("fa0040aa", t); registry.touchStudio("fb0040bb", t);

    // Submit with target:"all"; auto-answer both studios' polls so the fan-out resolves fast.
    const submitP = req(port, {
      method: "POST", path: "/session/submit",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify({ session_id: "sessAll1", type: "run_luau", payload: { src: "x" }, target: "all", timeout_ms: 5_000 }),
    });

    // Drain both control/command queues by polling + posting a result for each.
    for (const sid of ["fa0040aa", "fb0040bb"]) {
      const poll = await req(port, { path: "/studio/poll", headers: { "x-studio-id": sid } });
      const cmd = j(poll.body);
      await req(port, {
        method: "POST", path: `/studio/result/${cmd.id}`,
        headers: { "x-studio-id": sid }, body: JSON.stringify({ ok: true, from: sid }),
      });
    }

    const res = await submitP;
    assert.equal(res.status, 200);
    const b = j(res.body);
    assert.equal(b.fanout, true);
    assert.ok(Array.isArray(b.results));
    assert.equal(b.results.length, 2);
    assert.equal(b.ok, 2);
    assert.equal(b.failed, 0);
    const froms = b.results.map((r) => r.result.from).sort();
    assert.deepEqual(froms, ["fa0040aa", "fb0040bb"]);
  } finally { close(); }
});

test("§6.2: fan-out target:'all' enforces the exclusive-claim gate — locked studio reported STUDIO_LOCKED & gets NO command; unclaimed studio enqueues normally", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    const t = Date.now();
    // Session A holds an EXCLUSIVE claim on S1.
    registry.upsertSession({ sessionId: "sessHoldA", pid: 1, label: "A" });
    registry.mintSessionToken("sessHoldA", 1);
    registry.upsertStudio({ studioId: "5100c1aa", label: "S1", connId: 1 }, t);
    registry.upsertStudio({ studioId: "5200c2bb", label: "S2", connId: 2 }, t);
    registry.touchStudio("5100c1aa", t); registry.touchStudio("5200c2bb", t);
    const claim = registry.acquireClaim("sessHoldA", "5100c1aa", { mode: "exclusive" }, t);
    assert.equal(claim.ok, true);
    assert.equal(claim.claim.mode, "exclusive");

    // Session B (does NOT hold S1's claim) fires studio_target:"all".
    registry.upsertSession({ sessionId: "sessFireB", pid: 2, label: "B" });
    const tokenB = registry.mintSessionToken("sessFireB", 2);
    const submitP = req(port, {
      method: "POST", path: "/session/submit",
      headers: { "content-type": "application/json", "x-session-token": tokenB },
      body: JSON.stringify({ session_id: "sessFireB", type: "set_property", payload: { p: 9 }, target: "all", timeout_ms: 5_000 }),
    });

    // Only S2 should receive/answer a command; S1 must be gated (no command to drain).
    const poll = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "5200c2bb" } });
    const cmd = j(poll.body);
    assert.equal(cmd.type, "set_property"); // S2 got the command
    await req(port, {
      method: "POST", path: `/studio/result/${cmd.id}`,
      headers: { "x-studio-id": "5200c2bb" }, body: JSON.stringify({ ok: true, from: "5200c2bb" }),
    });

    const res = await submitP;
    assert.equal(res.status, 200);
    const b = j(res.body);
    assert.equal(b.fanout, true);
    assert.equal(b.results.length, 2);

    const s1 = b.results.find((r) => r.studioId === "5100c1aa");
    const s2 = b.results.find((r) => r.studioId === "5200c2bb");
    // S1: locked entry, NOT mutated. enqueueGate's envelope is preserved.
    assert.equal(s1.result.code, "STUDIO_LOCKED");
    assert.equal(s1.result.error, "STUDIO_LOCKED");
    assert.equal(s1.result.heldBy, "sessHoldA");
    assert.equal(typeof s1.result.expiresAt, "number");
    // S1 received NO command: its command queue is empty and nothing is in flight.
    assert.equal(core._internals.cmdQueue("5100c1aa").pending.length, 0);
    assert.equal(core._internals.countInFlight("5100c1aa"), 0);
    // S2: enqueued + resolved normally.
    assert.equal(s2.result.from, "5200c2bb");
    assert.equal(s2.result.ok, true);
    // Aggregate counts the locked studio as a failure, the resolved one as ok.
    assert.equal(b.ok, 1);
    assert.equal(b.failed, 1);
  } finally { close(); }
});

test("C5.2: /session/submit control:true routes onto the control queue", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    registry.upsertSession({ sessionId: "sessCtl1", pid: 1, label: "Ctl" });
    const token = registry.mintSessionToken("sessCtl1", 1);
    const t = Date.now();
    registry.upsertStudio({ studioId: "c715d001", label: "C", connId: 1 }, t);
    registry.touchStudio("c715d001", t);
    registry.pair("sessCtl1", "c715d001", t);

    // A control submit must NOT block on a plugin result; it returns immediately.
    const res = await req(port, {
      method: "POST", path: "/session/submit",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify({ session_id: "sessCtl1", type: "__stop_play", payload: {}, control: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(j(res.body).ok, true);

    // The command landed on the CONTROL queue, retrievable via control-poll.
    const ctrl = await req(port, { path: "/studio/control-poll", headers: { "x-studio-id": "c715d001" } });
    assert.equal(j(ctrl.body).type, "__stop_play");
    // ...and NOT on the normal command queue.
    assert.equal(core._internals.cmdQueue("c715d001").pending.length, 0);
  } finally { close(); }
});

// ── broker.mjs entry: binds, /health, exit 0 on EADDRINUSE ────────────────
test("broker.mjs: binds a free port, answers /health, then a 2nd instance on the same port exits 0", async () => {
  const brokerUrl = new URL("../broker.mjs", import.meta.url);
  const brokerPath = decodeURIComponent(brokerUrl.pathname).replace(/^\/([A-Za-z]:)/, "$1");
  // pick a free port
  const probe = http.createServer(() => {});
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const freePort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const env = { ...process.env, MCP_BROKER_PORT: String(freePort), ROBLOX_MCP_ALLOW_TOKENLESS: "1", ROBLOX_MCP_BROKER_IDLE_MS: "999999" };
  const child = spawn(process.execPath, [brokerPath], { env, stdio: "ignore" });
  try {
    // wait for /health
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      try { const r = await req(freePort, { path: "/health" }); ok = r.status === 200 && j(r.body).role === "broker"; } catch {}
      if (!ok) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ok, "broker.mjs should answer /health with role:broker");

    // a 2nd broker on the same port must exit 0 (race loser)
    const loser = spawn(process.execPath, [brokerPath], { env, stdio: "ignore" });
    const code = await new Promise((r) => loser.on("exit", r));
    assert.equal(code, 0);
  } finally {
    child.kill();
  }
});
