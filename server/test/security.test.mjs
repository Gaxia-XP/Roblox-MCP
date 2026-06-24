/**
 * server/test/security.test.mjs
 * Security suite for the multi-session broker (spec §2.7, §2.8, §3.4, §4.1, §8).
 * Zero-dep: node builtins + the extracted lib helpers only.
 * Runs under `node --test server/test/security.test.mjs` with NO node_modules.
 *
 * Tests:
 *   1+2: session_token gate: /session/submit 401 BEFORE resolveTarget (wrong token),
 *         and 200 envelope (not 401) with the correct minted token.
 *   3:    spawn env allowlist: buildSpawnEnv contains NO ROBLOX_OPEN_CLOUD_* / *_KEY
 *         and DOES contain the required keys.
 *   4:    redactHeaders on /session/submit (non-parking): x-mcp-token / x-api-key
 *         log as [REDACTED]; non-secret headers stay visible.
 *   5:    minimal /health body is exactly {ok,role,proto,brokerId} — no topology.
 *   6:    non-loopback Host -> 403 forbidden host.
 *   7:    C4 machine-token file lifecycle: created on first loadOrMintMachineToken(),
 *         reused (same value) on the second call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../lib/registry.mjs";
import { createBrokerCore } from "../lib/broker-core.mjs";
import { buildSpawnEnv } from "../lib/broker-client.mjs";

// ── Boot a real broker-core on an ephemeral port; return {port, core, close}. ──
function startBroker(opts = {}) {
  const registry = createRegistry({ now: Date.now, thresholds: {}, ...( opts.registryOpts || {}) });
  const core = createBrokerCore({
    registry,
    now: Date.now,
    authToken: opts.authToken || "",
    brandPrefix: "[sectest]",
    ...(opts.coreOpts || {}),
  });
  return new Promise((resolve) => {
    core.httpServer.listen(0, "127.0.0.1", () => {
      const { port } = core.httpServer.address();
      resolve({ port, core, close: () => core.httpServer.close() });
    });
  });
}

// ── Minimal HTTP helper — always sends a valid loopback Host unless overridden. ──
function req(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    r.on("error", reject);
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

// ── Register a session and return its minted session_token. ──
async function register(port, sessionId, { authToken } = {}) {
  const res = await req(port, {
    method: "POST",
    path: "/fe/register",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": sessionId,
      ...(authToken ? { "x-mcp-token": authToken } : {}),
    },
    body: JSON.stringify({
      session_id: sessionId,
      kind: "mcp",
      label: "sec-test",
      pid: process.pid,
      cwd: process.cwd(),
    }),
  });
  assert.equal(res.status, 200, `register expected 200, got ${res.status}: ${res.body}`);
  return JSON.parse(res.body).session_token;
}

// ── Test 1: session_token gate: /session/submit with WRONG token -> 401 BEFORE resolveTarget ──
test("session_token gate: /session/submit with WRONG token -> 401 BEFORE resolveTarget", async () => {
  const { port, close } = await startBroker();
  try {
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await register(port, sid);
    // Submit with a bogus x-session-token AND an unresolvable target. If the gate
    // runs first (correct), we get 401. If resolveTarget ran first (bug), we'd get
    // a 200 JSON error envelope { error:"UNKNOWN_TARGET" } / NO_TARGET.
    const res = await req(port, {
      method: "POST",
      path: "/session/submit",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": sid,
        "x-session-token": "WRONG-TOKEN",
      },
      body: JSON.stringify({
        session_id: sid,
        type: "run_luau",
        payload: { code: "print(1)" },
        target: "no-such-studio-xyz",
      }),
    });
    assert.equal(
      res.status,
      401,
      `expected 401 (token gate before resolveTarget), got ${res.status}: ${res.body}`
    );
  } finally {
    close();
  }
});

// ── Test 2: session_token gate: /session/submit with the CORRECT minted token passes the gate ──
test("session_token gate: /session/submit with the CORRECT minted token passes the gate", async () => {
  const { port, close } = await startBroker();
  try {
    const sid = "11111111-2222-3333-4444-555555555555";
    const token = await register(port, sid);
    // Correct token → gate passes → resolveTarget runs → with no paired/auto studio
    // and an unknown explicit target, we get a 200 JSON error envelope (NOT 401).
    const res = await req(port, {
      method: "POST",
      path: "/session/submit",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": sid,
        "x-session-token": token,
      },
      body: JSON.stringify({
        session_id: sid,
        type: "run_luau",
        payload: { code: "print(1)" },
        target: "no-such-studio-xyz",
      }),
    });
    assert.equal(
      res.status,
      200,
      `expected 200 envelope past the gate, got ${res.status}: ${res.body}`
    );
    const r = JSON.parse(res.body);
    assert.ok(r.error, `expected an error envelope from resolveTarget, got ${res.body}`);
    assert.match(r.code || r.error, /UNKNOWN_TARGET|NO_TARGET/);
  } finally {
    close();
  }
});

// ── Test 3: spawn env allowlist: buildSpawnEnv copies ONLY allowlisted keys, never Open Cloud / *_KEY ──
test("spawn env allowlist: buildSpawnEnv copies ONLY allowlisted keys, never Open Cloud / *_KEY", () => {
  // Poison process.env with secrets that must NOT leak into the detached broker.
  const saved = { ...process.env };
  process.env.ROBLOX_OPEN_CLOUD_API_KEY = "OC-SECRET-DO-NOT-LEAK";
  process.env.ROBLOX_OPEN_CLOUD_CREATOR_ID = "12345";
  process.env.ROBLOX_OPEN_CLOUD_CREATOR_TYPE = "User";
  process.env.SOME_OTHER_KEY = "ALSO-SECRET";
  process.env.RANDOM_TOKEN = "NOPE";
  try {
    const env = buildSpawnEnv({
      port: 8765,
      host: "127.0.0.1",
      authToken: "broker-machine-token",
      idleMs: "90000",
    });

    // 1) The allowlisted values are present and correct.
    assert.equal(env.MCP_BROKER_PORT, "8765");
    assert.equal(env.MCP_BROKER_HOST, "127.0.0.1");
    assert.equal(env.MCP_BROKER_ROLE, "spawned");
    assert.equal(env.ROBLOX_MCP_TOKEN, "broker-machine-token");
    assert.equal(env.ROBLOX_MCP_BROKER_IDLE_MS, "90000");
    assert.ok("PATH" in env, "PATH must be forwarded for Node to start");

    // 2) NO Open Cloud secrets leaked.
    assert.equal(env.ROBLOX_OPEN_CLOUD_API_KEY, undefined);
    assert.equal(env.ROBLOX_OPEN_CLOUD_CREATOR_ID, undefined);
    assert.equal(env.ROBLOX_OPEN_CLOUD_CREATOR_TYPE, undefined);

    // 3) No stray *_KEY / *_TOKEN beyond the broker token leaked. Scan EVERY key.
    for (const k of Object.keys(env)) {
      if (k === "ROBLOX_MCP_TOKEN") continue; // the one allowed token
      assert.ok(!/_KEY$/i.test(k), `leaked *_KEY env var into spawn env: ${k}`);
      assert.ok(!/_TOKEN$/i.test(k), `leaked *_TOKEN env var into spawn env: ${k}`);
    }
    assert.equal(env.SOME_OTHER_KEY, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
  } finally {
    // Restore env exactly.
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
});

// ── Test 4 (C7a): redactHeaders on POST /session/submit (non-parking) ──
// Use a request with BAD session token → 401, which logs and returns immediately.
// Validates x-mcp-token and x-api-key appear as [REDACTED] in broker logs.
test("redaction on /session/submit (non-parking): x-mcp-token / x-api-key log as [REDACTED]", async () => {
  const { port, close } = await startBroker();
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    // A session that doesn't exist → wrong session token → 401 path (logs and returns immediately).
    // Send secret headers that must be redacted in the log.
    await req(port, {
      method: "POST",
      path: "/session/submit",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "nonexistent-session-id-xyz",
        "x-session-token": "BOGUS-SESSION-TOKEN",
        "x-mcp-token": "SUPER-SECRET-OUTER-TOKEN",
        "x-api-key": "API-KEY-SECRET",
      },
      body: JSON.stringify({
        session_id: "nonexistent-session-id-xyz",
        type: "run_luau",
        payload: {},
      }),
    });

    const joined = lines.join("\n");
    // Secrets never appear verbatim in any log line.
    assert.ok(
      !joined.includes("SUPER-SECRET-OUTER-TOKEN"),
      `x-mcp-token leaked into logs:\n${joined}`
    );
    assert.ok(
      !joined.includes("API-KEY-SECRET"),
      `x-api-key leaked into logs:\n${joined}`
    );
    // The redaction marker is present (proves a log line ran through redactHeaders).
    assert.ok(
      joined.includes("[REDACTED]"),
      `expected [REDACTED] in logs, got:\n${joined}`
    );
  } finally {
    console.error = orig;
    close();
  }
});

// ── Test 5: minimal /health body is exactly {ok,role,proto,brokerId} — no topology counts ──
test("minimal /health: body is exactly {ok,role,proto,brokerId} — no session/studio counts", async () => {
  const { port, close } = await startBroker();
  try {
    const res = await req(port, { path: "/health" });
    assert.equal(res.status, 200);
    const h = JSON.parse(res.body);
    assert.equal(h.ok, true);
    assert.equal(h.role, "broker");
    assert.equal(h.proto, 1);
    assert.equal(typeof h.brokerId, "string");
    assert.ok(h.brokerId.length > 0);
    // Reconnaissance fields MUST be absent.
    assert.equal("sessions" in h, false, "/health leaked session count");
    assert.equal("studios" in h, false, "/health leaked studio count");
    assert.equal("draining" in h, false, "/health leaked draining state");
    assert.equal("queued" in h, false, "/health leaked queue depth");
    assert.equal("inFlight" in h, false, "/health leaked inFlight count");
    // Exactly the 4 keys, nothing else.
    assert.deepEqual(Object.keys(h).sort(), ["brokerId", "ok", "proto", "role"]);
  } finally {
    close();
  }
});

// ── Test 6: non-loopback Host -> 403 forbidden host on a new endpoint ──
test("non-loopback Host -> 403 forbidden host on a new endpoint", async () => {
  const { port, close } = await startBroker();
  try {
    const res = await req(port, {
      path: "/session/list",
      headers: { Host: "evil.example.com" },
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /forbidden host/);
  } finally {
    close();
  }
});

// ── Test 7 (C4): machine-token file lifecycle ──
// loadOrMintMachineToken() creates the file on first call, then reuses it (same value).
test("C4 machine-token file: created on first loadOrMintMachineToken(), reused on second", async () => {
  // Use a fresh sandbox so we don't touch the real per-user Roblox-MCP dir.
  const SANDBOX = mkdtempSync(join(tmpdir(), "rbxmcp-sec-"));
  const savedLocalAppData = process.env.LOCALAPPDATA;
  const savedAllowTokenless = process.env.ROBLOX_MCP_ALLOW_TOKENLESS;
  const savedToken = process.env.ROBLOX_MCP_TOKEN;

  try {
    process.env.LOCALAPPDATA = SANDBOX;
    // Clear these so the function mints fresh (no env overrides).
    delete process.env.ROBLOX_MCP_TOKEN;
    delete process.env.ROBLOX_MCP_ALLOW_TOKENLESS;

    // Dynamic import so BROKER_TOKEN_PATH resolves inside the sandbox.
    const { loadOrMintMachineToken } = await import(
      `../lib/broker-client.mjs?sandbox=${Date.now()}`
    );
    const tokenFilePath = join(SANDBOX, "Roblox-MCP", "broker-token");

    // First call: file must NOT yet exist, then gets created, returns a non-empty token.
    assert.equal(existsSync(tokenFilePath), false, "token file must not exist before first call");
    const tok1 = loadOrMintMachineToken({ tokenPath: tokenFilePath });
    assert.ok(tok1.length > 0, `expected non-empty token, got: ${JSON.stringify(tok1)}`);
    assert.equal(existsSync(tokenFilePath), true, "token file must exist after first call");
    const onDisk = readFileSync(tokenFilePath, "utf8").trim();
    assert.equal(onDisk, tok1, "persisted file content must match the returned token");

    // Second call: file exists → reuse the same token, no new mint.
    const tok2 = loadOrMintMachineToken({ tokenPath: tokenFilePath });
    assert.equal(tok2, tok1, "second call must reuse the same token (no new mint)");
  } finally {
    // Restore env.
    if (savedLocalAppData !== undefined) process.env.LOCALAPPDATA = savedLocalAppData;
    else delete process.env.LOCALAPPDATA;
    if (savedAllowTokenless !== undefined) process.env.ROBLOX_MCP_ALLOW_TOKENLESS = savedAllowTokenless;
    else delete process.env.ROBLOX_MCP_ALLOW_TOKENLESS;
    if (savedToken !== undefined) process.env.ROBLOX_MCP_TOKEN = savedToken;
    else delete process.env.ROBLOX_MCP_TOKEN;
    try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  }
});
