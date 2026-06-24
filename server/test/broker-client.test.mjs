/**
 * server/test/broker-client.test.mjs
 * Integration suite for the FE broker client (broker-client.mjs):
 *   - per-cwd session_id persistence + the C4 machine-token load/mint
 *   - the §3.2 direct-bind election (STEP A in-proc win, STEP B connect,
 *     STEP C detached spawn) reconciled to the REAL createBrokerCore (registry
 *     injected; un-listened httpServer; HTTP-only session plane — there is no
 *     in-proc `core.submitFromSession`, so the in-proc leader talks to its own
 *     bound loopback exactly like a remote client, tagged role:"inproc").
 *   - the §3.4 detached-spawn env ALLOWLIST (no ROBLOX_OPEN_CLOUD_* / *_KEY leak)
 *   - the §3.3 older/stranger /health discrimination
 *   - the two-simultaneous-FE race (exactly one leader, the other connects)
 *
 * Runs under `node --test server/test/broker-client.test.mjs` with NO node_modules.
 * Every server binds an EPHEMERAL port (0) — never 8765 (Roblox) / 8766 (Blender).
 *
 * Isolation: LOCALAPPDATA is repointed at a fresh temp dir BEFORE the module is
 * imported (dynamic import after the env mutation) so the exported SESSION_DIR /
 * BROKER_TOKEN_PATH constants resolve inside the sandbox — the real per-user
 * Roblox-MCP dir is never touched.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── sandbox the per-user dir, then import the module under test ──
const SANDBOX = mkdtempSync(join(tmpdir(), "rbxmcp-bc-"));
process.env.LOCALAPPDATA = SANDBOX;
// Make sure no stray token from the real env forces auth in the election tests.
delete process.env.ROBLOX_MCP_TOKEN;
process.env.ROBLOX_MCP_ALLOW_TOKENLESS = "1"; // tokenless election in tests

const mod = await import("../lib/broker-client.mjs");
const {
  loadOrMintSessionId,
  loadOrMintMachineToken,
  ensureBroker,
  SESSION_DIR,
  BROKER_TOKEN_PATH,
} = mod;

const CLIENT_URL = new URL("../lib/broker-client.mjs", import.meta.url).href;

after(() => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });

// ── helpers ──────────────────────────────────────────────────────────────
// GET /health JSON from a port.
function getHealth(port) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/health", headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } });
      }
    );
    r.on("error", reject);
    r.end();
  });
}
// A free ephemeral port: bind :0, read the assigned port, close.
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
// Stand up a REAL broker-core server (registry injected) on a concrete port.
async function startRealBroker(port, authToken = "") {
  const { createRegistry } = await import("../lib/registry.mjs");
  const { createBrokerCore } = await import("../lib/broker-core.mjs");
  const registry = createRegistry({ now: Date.now, thresholds: {} });
  const core = createBrokerCore({ registry, now: Date.now, authToken, brandPrefix: "[t-broker]" });
  await new Promise((r) => core.httpServer.listen(port, "127.0.0.1", r));
  return { core, registry, close: () => core.httpServer.close() };
}

// ───────────────────────────────────────────────────────────────────────────
// Step 1/3: per-cwd session_id persistence
// ───────────────────────────────────────────────────────────────────────────
test("loadOrMintSessionId: stable per-cwd, file persisted, distinct cwds differ", () => {
  const a = loadOrMintSessionId("C:/fake/cwd/alpha");
  const a2 = loadOrMintSessionId("C:/fake/cwd/alpha");
  const b = loadOrMintSessionId("C:/fake/cwd/beta");
  assert.match(a, /^[0-9a-f-]{36}$/i, "minted a UUID");
  assert.equal(a, a2, "same cwd -> same id across calls (persisted)");
  assert.notEqual(a, b, "different cwd -> different id");
  assert.ok(existsSync(SESSION_DIR), "session dir created");
});

// ───────────────────────────────────────────────────────────────────────────
// C4: machine token load-or-mint (single implementation, shared with broker.mjs)
// ───────────────────────────────────────────────────────────────────────────
test("loadOrMintMachineToken: mints once, persists to BROKER_TOKEN_PATH, stable across calls", () => {
  // Force the mint path (ignore the ALLOW_TOKENLESS we set for the election tests).
  const t1 = loadOrMintMachineToken({ allowTokenless: false });
  assert.ok(typeof t1 === "string" && t1.length >= 16, "minted a non-trivial token");
  assert.ok(existsSync(BROKER_TOKEN_PATH), "token file written");
  const onDisk = readFileSync(BROKER_TOKEN_PATH, "utf8").trim();
  assert.equal(onDisk, t1, "file holds exactly the minted token");
  const t2 = loadOrMintMachineToken({ allowTokenless: false });
  assert.equal(t2, t1, "second call reads the same persisted token");
});

test("loadOrMintMachineToken: ROBLOX_MCP_ALLOW_TOKENLESS=1 (or allowTokenless) -> '' when no file & no override", () => {
  // Use a throwaway sandbox path so the persisted token above doesn't satisfy it.
  const saved = process.env.LOCALAPPDATA;
  const tmp = mkdtempSync(join(tmpdir(), "rbxmcp-tokenless-"));
  process.env.LOCALAPPDATA = tmp;
  try {
    // The module's BROKER_TOKEN_PATH was bound at import to the original sandbox,
    // so exercise the explicit knobs instead: allowTokenless short-circuits to "".
    const tok = loadOrMintMachineToken({ allowTokenless: true, tokenPath: join(tmp, "broker-token") });
    assert.equal(tok, "", "tokenless opt-out returns empty string (no mint)");
    assert.equal(existsSync(join(tmp, "broker-token")), false, "no file written under tokenless");
  } finally {
    process.env.LOCALAPPDATA = saved;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("C4 token agreement: spawned broker.mjs and loadOrMintMachineToken read the SAME token from the SAME path", async () => {
  // A fresh sandbox with NO pre-existing token and NO tokenless opt-out: the
  // real broker.mjs entry must MINT a broker-token, and the shared helper (what
  // ensureBroker's in-proc leader uses) must then read back the exact same value.
  const tmp = mkdtempSync(join(tmpdir(), "rbxmcp-c4-"));
  const tokenPath = join(tmp, "Roblox-MCP", "broker-token");
  const brokerPath = fileURLToPath(new URL("../broker.mjs", import.meta.url));
  const port = await freePort();
  const child = spawn(process.execPath, [brokerPath], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: tmp, MCP_BROKER_PORT: String(port), MCP_BROKER_HOST: "127.0.0.1",
      // no ROBLOX_MCP_TOKEN, no ROBLOX_MCP_ALLOW_TOKENLESS -> default-ON mint
    },
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  child.stderr.setEncoding("utf8");
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  try {
    // Wait until the broker reports it is listening (auth ON => it minted a token).
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`broker did not start; stderr=${err}`)), 5_000);
      child.stderr.on("data", () => { if (/listening/.test(err)) { clearTimeout(to); resolve(); } });
      child.on("error", reject);
    });
    assert.match(err, /auth ON/, "broker.mjs minted a machine token (auth ON)");
    assert.ok(existsSync(tokenPath), "broker.mjs persisted broker-token under the sandbox path");
    const onDisk = readFileSync(tokenPath, "utf8").trim();
    // The shared helper, pointed at the SAME path, returns the SAME token the
    // broker minted — the single-implementation agreement C4 requires.
    const viaHelper = loadOrMintMachineToken({ tokenPath });
    assert.equal(viaHelper, onDisk, "in-proc leader's helper agrees with the spawned broker's token");
  } finally {
    child.kill();
    await new Promise((r) => child.on("close", r));
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Step 5/7: STEP B — connect as a CLIENT to an already-running broker
// ───────────────────────────────────────────────────────────────────────────
test("ensureBroker STEP B: connects as CLIENT to an already-running broker; submit round-trips", async () => {
  const port = await freePort();
  const { close } = await startRealBroker(port, "");
  try {
    const client = await ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]", sessionId: "deadbeef-dead-dead-dead-deadbeef0001" });
    assert.equal(client.role, "client", "second arrival is a CLIENT, not the in-proc leader");
    assert.equal(typeof client.brokerId, "string");
    assert.equal(client.httpServer, null, "a remote client owns no httpServer");

    // register mints + holds a session_token (round-trips through HTTP).
    const reg = await client.register();
    assert.equal(reg.ok, true);
    assert.equal(typeof reg.session_token, "string");

    // submit() is byte-identical signature; with no plugin/studio the real broker
    // resolves the session-plane result to a NO_TARGET typed error (not a timeout).
    const r = await client.submit("ping", { x: 1 }, 300);
    assert.ok(r && r.error, "submit resolves a typed-error object when no studio is reachable");
    assert.equal(r.code, "NO_TARGET", "no studio paired -> NO_TARGET (today's session-plane contract)");

    // getStatus() ALWAYS returns a Promise, resolving to the 5 legacy keys.
    const statusP = client.getStatus();
    assert.equal(typeof statusP.then, "function", "getStatus() is a Promise");
    const status = await statusP;
    for (const k of ["pluginConnected", "msSinceLastPoll", "queued", "inFlight", "ready"]) assert.ok(k in status, `status has ${k}`);
    assert.equal(typeof status.then, "undefined", "resolved status is a plain object, not a thenable");

    // listStudios round-trips the registry snapshot.
    const list = await client.listStudios();
    assert.ok(Array.isArray(list.studios), "listStudios returns a studios array");

    client.stopHeartbeat();
    await client.deregister();
  } finally {
    close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// FIX 1: detach_studio admin-steal is REACHABLE — self-unpair leaves another
// session's pair intact; a targeted detach_studio force-frees it (the only
// documented escape from STUDIO_BUSY).
// ───────────────────────────────────────────────────────────────────────────
test("detach_studio: self-unpair does NOT free another session's studio; targeted detach_studio admin-steals it", async () => {
  const port = await freePort();
  const { registry, close } = await startRealBroker(port, "");
  try {
    // A live studio S that session A will attach.
    const t = Date.now();
    registry.upsertStudio({ studioId: "5d1ea101", label: "Steal", connId: 1 }, t);
    registry.touchStudio("5d1ea101", t);

    const clientA = await ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]", sessionId: "aaaa1111-aaaa-1111-aaaa-1111aaaa1111" });
    const clientB = await ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]", sessionId: "bbbb2222-bbbb-2222-bbbb-2222bbbb2222" });
    assert.equal(clientB.role, "client", "second arrival is a CLIENT");
    try {
      await clientA.register();
      await clientB.register();

      // A attaches S → A is paired to S.
      const att = await clientA.attachStudio("5d1ea101");
      assert.equal(att.ok, true);
      assert.equal(att.studio_id, "5d1ea101");
      assert.equal(registry.getStudio("5d1ea101").pairedSessionId, "aaaa1111-aaaa-1111-aaaa-1111aaaa1111");

      // B's SELF-unpair (no target) must NOT touch A's pair of S.
      const selfUnpair = await clientB.detachStudio();
      assert.equal(selfUnpair.ok, true);
      assert.equal(registry.getStudio("5d1ea101").pairedSessionId, "aaaa1111-aaaa-1111-aaaa-1111aaaa1111",
        "self-unpair by B leaves A↔S intact");

      // B attaching S now hits STUDIO_BUSY (it is paired to A).
      const busy = await clientB.attachStudio("5d1ea101");
      assert.equal(busy.code, "STUDIO_BUSY", "attach onto another session's studio is busy");

      // B's TARGETED detach_studio { target:S } admin-steals it → A no longer paired.
      const steal = await clientB.detachStudio("5d1ea101");
      assert.equal(steal.ok, true, `admin steal envelope: ${JSON.stringify(steal)}`);
      assert.equal(steal.freed.studio_id, "5d1ea101");
      assert.equal(steal.freed.former_session_id, "aaaa1111-aaaa-1111-aaaa-1111aaaa1111");
      assert.equal(registry.getStudio("5d1ea101").pairedSessionId, null, "S is freed after the steal");

      // B can now attach S with no STUDIO_BUSY.
      const ok = await clientB.attachStudio("5d1ea101");
      assert.equal(ok.ok, true, `attach after steal succeeds: ${JSON.stringify(ok)}`);
      assert.equal(registry.getStudio("5d1ea101").pairedSessionId, "bbbb2222-bbbb-2222-bbbb-2222bbbb2222");

      // A targeted detach against a NON-EXISTENT label surfaces a typed error (resolution).
      const miss = await clientB.detachStudio("no-such-studio-xyz");
      assert.ok(miss && miss.error, "unresolved target → typed error envelope");
    } finally {
      clientA.stopHeartbeat();
      clientB.stopHeartbeat();
    }
  } finally {
    close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Step 9: STEP A — first arrival wins the direct bind, becomes the in-proc leader
// ───────────────────────────────────────────────────────────────────────────
test("ensureBroker STEP A: first arrival wins the direct bind and becomes the in-proc leader", async () => {
  const port = await freePort();
  const leader = await ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]", sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0001" });
  try {
    assert.equal(leader.role, "inproc", "lone session is the in-proc leader (zero-config short-circuit)");
    assert.ok(leader.httpServer, "in-proc leader exposes its httpServer for idle-reap");
    // /health is served by the in-proc broker, classifying as a real broker.
    const h = await getHealth(leader.httpServer.address().port);
    assert.equal(h.status, 200);
    assert.equal(h.json.role, "broker");
    assert.equal(h.json.proto, 1);
    // submit() round-trips to the in-proc broker over loopback; no plugin -> NO_TARGET.
    const r = await leader.submit("ping", { x: 1 }, 300);
    assert.ok(r && r.error, "in-proc submit returns a typed-error object with no studio");
    assert.equal(r.code, "NO_TARGET");
    // getStatus is still a Promise even in-proc.
    const sp = leader.getStatus();
    assert.equal(typeof sp.then, "function");
    const st = await sp;
    assert.ok("pluginConnected" in st);
    leader.stopHeartbeat();
  } finally {
    leader.httpServer.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Step 11: REQUIRED — two simultaneous FEs race the same port
// ───────────────────────────────────────────────────────────────────────────
test("REQUIRED: two simultaneous FEs race the same port — exactly one leader, the other connects", async () => {
  const port = await freePort();
  // NOTE: under \`node --input-type=module -e <script> A B\`, the user args land
  // at process.argv[1]/[2] (there is no script-path slot for -e), so port=argv[1].
  const childScript = `
    import { ensureBroker } from ${JSON.stringify(CLIENT_URL)};
    const port = Number(process.argv[1]);
    const sid = process.argv[2];
    const c = await ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[race]", sessionId: sid });
    process.stdout.write(JSON.stringify({ role: c.role }));
    // Keep the in-proc leader alive briefly so the loser can connect; client exits immediately.
    if (c.role === "inproc") { await new Promise((r) => setTimeout(r, 1500)); c.httpServer.close(); }
    else { c.stopHeartbeat(); }
  `;
  const spawnChild = (sid) => new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", childScript, String(port), sid],
      { env: { ...process.env, LOCALAPPDATA: SANDBOX, ROBLOX_MCP_ALLOW_TOKENLESS: "1" } });
    let out = "", err = "";
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => resolve({ code, out, err }));
  });
  const [a, b] = await Promise.all([
    spawnChild("11111111-1111-1111-1111-111111111111"),
    spawnChild("22222222-2222-2222-2222-222222222222"),
  ]);
  const roles = [a.out, b.out].map((s) => { try { return JSON.parse(s).role; } catch { return null; } });
  const leaders = roles.filter((r) => r === "inproc").length;
  const clients = roles.filter((r) => r === "client").length;
  assert.equal(leaders, 1, `exactly one leader (roles=${JSON.stringify(roles)}; a.err=${a.err} b.err=${b.err})`);
  assert.equal(clients, 1, `the other connected as a client (roles=${JSON.stringify(roles)})`);
});

// ───────────────────────────────────────────────────────────────────────────
// Step 13: REQUIRED — detached-spawn env ALLOWLIST (no secret leakage)
// ───────────────────────────────────────────────────────────────────────────
test("REQUIRED: detached spawn env is an allowlist — no ROBLOX_OPEN_CLOUD_* / *_KEY leaks", async () => {
  // Build the allowlist EXACTLY as spawnDetachedBroker() does and spawn a probe
  // that dumps its env — asserting forbidden vars are absent, required ones present.
  const probe = `process.stdout.write(JSON.stringify(process.env));`;
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    MCP_BROKER_PORT: "65000",
    MCP_BROKER_HOST: "127.0.0.1",
    MCP_BROKER_ROLE: "spawned",
    ROBLOX_MCP_TOKEN: "tok123",
    ROBLOX_MCP_BROKER_IDLE_MS: process.env.ROBLOX_MCP_BROKER_IDLE_MS ?? "",
  };
  const child = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["-e", probe], { env, windowsHide: true });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.on("close", () => resolve(out));
  });
  const got = JSON.parse(child);
  for (const k of Object.keys(got)) {
    assert.ok(!/^ROBLOX_OPEN_CLOUD_/i.test(k), `leaked ${k}`);
    assert.ok(!/_KEY$/i.test(k), `leaked ${k}`);
    assert.ok(!/_API_KEY$/i.test(k), `leaked ${k}`);
  }
  assert.equal(got.MCP_BROKER_PORT, "65000");
  assert.equal(got.MCP_BROKER_ROLE, "spawned");
  assert.equal(got.ROBLOX_MCP_TOKEN, "tok123");
});

test("REQUIRED: spawnDetachedBroker source carries no {...process.env} spread", () => {
  const src = readFileSync(new URL("../lib/broker-client.mjs", import.meta.url), "utf8");
  // Guard against a future regression that copies the full env into the child.
  assert.ok(!/spawn\([\s\S]*?env:\s*\{\s*\.\.\.process\.env/.test(src), "spawn env must be an explicit allowlist, not a spread");
  assert.ok(!/env:\s*\{[\s\S]*?ROBLOX_OPEN_CLOUD/.test(src), "ROBLOX_OPEN_CLOUD_* must never appear in the spawn env block");
});

// ───────────────────────────────────────────────────────────────────────────
// Step 15: §3.3 older / stranger /health discrimination
// ───────────────────────────────────────────────────────────────────────────
test("ensureBroker STEP B: older same-family server on the port -> clear restart error (no competitor spawn)", async () => {
  const port = await freePort();
  // An OLD inline createBridge answers /health as { ok, queued, inFlight } — no role/proto.
  const old = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, queued: 0, inFlight: 0 })); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => old.listen(port, "127.0.0.1", r));
  try {
    await assert.rejects(
      ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]", sessionId: "cccccccc-cccc-cccc-cccc-cccccccc0001" }),
      /older\/incompatible/i,
    );
  } finally { old.close(); }
});

test("ensureBroker STEP B: unrelated process on the port -> FATAL non-broker error after retry window", async () => {
  const port = await freePort();
  const stranger = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => stranger.listen(port, "127.0.0.1", r));
  try {
    await assert.rejects(
      ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]", sessionId: "dddddddd-dddd-dddd-dddd-dddddddd0001" }),
      /non-broker process/i,
    );
  } finally { stranger.close(); }
});
