/**
 * server/lib/broker-client.mjs
 * Front-end (FE) side of the multi-session broker. Zero external deps —
 * node builtins + the extracted http-bridge helper (redactHeaders) +
 * broker-core / registry only. The MCP SDK never enters this file.
 *
 *  ensureBroker() runs the §3.2 direct-bind election:
 *    STEP A  try to BECOME the broker — build a registry + broker-core in-proc
 *            and bind it ourselves (we own .listen so EADDRINUSE is non-fatal).
 *    STEP B  EADDRINUSE -> connect to the running broker (validate GET /health,
 *            §3.3 tolerant older/stranger discrimination).
 *    STEP C  port held by a half-bound/dying broker -> spawn a detached broker
 *            (§3.4 env ALLOWLIST) and connect-or-throw.
 *
 *  Reconciliation with the REAL upstream (Tasks 1–3, post-merge):
 *    - createBrokerCore's signature is { registry, now, authToken, brandPrefix,
 *      idleReapMs, ... } — it takes an INJECTED registry (Task 2) and returns an
 *      UN-LISTENED httpServer; there is NO in-proc `core.submitFromSession`. So
 *      the session plane is HTTP-only, and the in-proc leader talks to its OWN
 *      bound loopback exactly like a remote client (tagged role:"inproc"). This
 *      keeps submit()'s result byte-identical to createBridge().submit while
 *      reusing the real, tested session-plane endpoints.
 *    - The machine token is loaded/minted by loadOrMintMachineToken() here, the
 *      single source of truth that broker.mjs delegates to (C4) — so the detached
 *      child and the in-proc leader always agree on one token.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// redactHeaders is imported to keep the Task-1 lib in this file's dependency
// graph (parity with the broker's logging surface); the FE client logs nothing
// secret itself, so it is re-exported for callers that need it.
import { redactHeaders } from "./http-bridge.mjs";
import { createRegistry } from "./registry.mjs";
import { createBrokerCore } from "./broker-core.mjs";

export { redactHeaders };

// ── Paths (stable per-user dir, NOT os.tmpdir()) ──
function appDataRoot() {
  return (
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE
      ? join(process.env.USERPROFILE, "AppData", "Local")
      : join(process.env.HOME || ".", ".local", "share"))
  );
}
const ROOT_DIR = join(appDataRoot(), "Roblox-MCP");
export const SESSION_DIR = join(ROOT_DIR, "sessions");
export const BROKER_TOKEN_PATH = join(ROOT_DIR, "broker-token");
const SPAWN_LOG_PATH = join(ROOT_DIR, "broker-spawn.log");

// ── Election / connect tuning (§3.2) ──
const CONNECT_RETRIES = 20;        // STEP B: 20 × 50ms ≈ 1s covers the winner's listen-attach gap
const CONNECT_BACKOFF_MS = 50;
const SPAWN_CONNECT_RETRIES = 40;  // STEP C: 40 × 50ms ≈ 2s for a detached child to come up
const SPAWN_BACKOFF_MS = 50;
const HEALTH_TIMEOUT_MS = 1_500;
const FE_HEARTBEAT_MS = 10_000;    // §3.6 free-running cadence

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Per-cwd, persisted session_id ──
// %LOCALAPPDATA%/Roblox-MCP/sessions/session-<sha256(cwd).16>.json
function sessionFileFor(cwd) {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(SESSION_DIR, `session-${key}.json`);
}

export function loadOrMintSessionId(cwd = process.cwd()) {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  const file = sessionFileFor(cwd);
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j && typeof j.session_id === "string" && j.session_id) return j.session_id;
    } catch { /* fall through to mint */ }
  }
  const session_id = randomUUID();
  try {
    writeFileSync(file, JSON.stringify({ session_id, created: new Date().toISOString(), cwd }), { mode: 0o600 });
  } catch { /* best-effort persist */ }
  return session_id;
}

/** Rewrite the persisted id (used when the broker hands back a `suggested` id on 409). */
export function rewriteSessionId(cwd, session_id) {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  const file = sessionFileFor(cwd);
  try {
    writeFileSync(file, JSON.stringify({ session_id, created: new Date().toISOString(), cwd }), { mode: 0o600 });
  } catch { /* best-effort */ }
  return session_id;
}

// ── C4: single machine-token implementation (broker.mjs delegates to this) ──
// Load the persisted broker token, or mint + persist one with a restrictive ACL.
// Returns "" ONLY when tokenless is explicitly opted in (env or arg) and no
// explicit token / file is present. Keeping ONE implementation + ONE path here
// guarantees the in-proc leader and the detached child agree on the same token.
export function loadOrMintMachineToken({
  explicit = (process.env.ROBLOX_MCP_TOKEN || "").trim(),
  allowTokenless = process.env.ROBLOX_MCP_ALLOW_TOKENLESS === "1",
  tokenPath = BROKER_TOKEN_PATH,
} = {}) {
  if (explicit) return explicit;                  // operator override wins
  try {
    if (existsSync(tokenPath)) {
      const t = readFileSync(tokenPath, "utf8").trim();
      if (t) return t;
    }
  } catch { /* fall through */ }
  if (allowTokenless) return "";                  // explicit opt-out (no mint)
  try {
    mkdirSync(dirname(tokenPath), { recursive: true });
    const tok = randomBytes(24).toString("hex");
    writeFileSync(tokenPath, tok, { mode: 0o600 });
    return tok;
  } catch {
    // Can't persist a machine token → fall back to tokenless (no worse than today).
    return "";
  }
}

// ── HTTP transport (zero-dep) ──
function httpJson({ port, host, method = "GET", path, headers = {}, body, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      { host, port, method, path, headers: { Host: `${host}:${port}`, "Content-Type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = data ? JSON.parse(data) : {}; } catch { json = null; }
          resolve({ status: res.statusCode, json, raw: data });
        });
      }
    );
    const t = setTimeout(() => { req.destroy(new Error("http timeout")); }, timeoutMs);
    req.on("close", () => clearTimeout(t));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Validate GET /health and classify the port holder (§3.3 tolerant detection). */
async function probeHealth({ port, host }) {
  let r;
  try { r = await httpJson({ port, host, path: "/health", timeoutMs: HEALTH_TIMEOUT_MS }); }
  catch { return { kind: "unreachable" }; }
  // 403 = the just-bound winner hasn't populated its Host allowlist yet (the
  // listen→attach gap), or a momentary refusal — RETRY rather than declaring a
  // terminal stranger (a real stranger keeps 403-ing and still FATALs after the
  // retry window).
  if (r.status === 403) return { kind: "unreachable" };
  if (r.status !== 200 || !r.json) return { kind: "stranger" };
  // A real broker: { ok:true, role:"broker", proto:1, brokerId }.
  if (r.json.ok === true && r.json.role === "broker" && r.json.proto === 1) {
    return { kind: "broker", brokerId: r.json.brokerId };
  }
  // An OLDER same-family inline bridge: { ok:true, queued, inFlight } — no role/proto.
  if (r.json.ok === true && r.json.role === undefined && r.json.proto === undefined
      && ("queued" in r.json || "inFlight" in r.json)) {
    return { kind: "older" };
  }
  return { kind: "stranger" };
}

/** STEP B/C connect: returns a CLIENT BrokerClient, an {__stranger} sentinel, or null. */
async function connect({ port, host, authToken, sessionId, brandPrefix }) {
  const probe = await probeHealth({ port, host });
  if (probe.kind === "broker") return makeRemoteClient({ port, host, authToken, sessionId, brokerId: probe.brokerId });
  if (probe.kind === "older") throw new Error(`${brandPrefix} an older/incompatible MCP server holds ${host}:${port} — restart it to upgrade`);
  if (probe.kind === "stranger") return { __stranger: true }; // caller decides fatal after retry window
  return null; // unreachable — retry
}

// ── buildSpawnEnv (§3.4 allowlist) ──
// Pure function: returns only the explicitly-allowlisted env keys needed by the
// detached broker child. NEVER spreads or copies process.env — Open-Cloud creds
// and any *_KEY / *_TOKEN (besides ROBLOX_MCP_TOKEN) are never forwarded.
export function buildSpawnEnv({ port, host, authToken, idleMs } = {}) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    MCP_BROKER_PORT: String(port),
    MCP_BROKER_HOST: host,
    MCP_BROKER_ROLE: "spawned",
    ROBLOX_MCP_TOKEN: authToken || "",
    ROBLOX_MCP_BROKER_IDLE_MS: idleMs !== undefined ? String(idleMs) : (process.env.ROBLOX_MCP_BROKER_IDLE_MS ?? ""),
  };
}

// ── Detached spawn (§3.4) — ALLOWLIST env, explicit cwd, first-spawn log ──
function spawnDetachedBroker({ port, host, authToken }) {
  if (!existsSync(ROOT_DIR)) mkdirSync(ROOT_DIR, { recursive: true });
  let logFd = "ignore";
  try { logFd = openSync(SPAWN_LOG_PATH, "a"); } catch { logFd = "ignore"; }
  const brokerPath = fileURLToPath(new URL("../broker.mjs", import.meta.url));
  const child = spawn(process.execPath, [brokerPath], {
    detached: true,
    cwd: dirname(brokerPath),               // broker.mjs's dir, NOT the inherited (Drive-junction) cwd
    stdio: ["ignore", "ignore", logFd],     // capture stderr to broker-spawn.log for the startup window
    windowsHide: true,
    env: buildSpawnEnv({ port, host, authToken }), // ALLOWLIST — never {...process.env}
  });
  child.unref();
}

// ── Remote client (role:"client") — every method is an HTTP round-trip ──
// Also serves the in-proc leader, which points it at its own bound loopback port
// (there is no in-proc session API on the real broker-core).
function makeRemoteClient({ port, host, authToken, sessionId, brokerId, httpServer = null, role = "client" }) {
  let sessionToken = "";
  let currentBrokerId = brokerId;
  const cwd = process.cwd();
  const baseHeaders = () => {
    const h = {};
    if (authToken) h["x-mcp-token"] = authToken;
    h["x-session-id"] = sessionId;
    if (sessionToken) h["x-session-token"] = sessionToken;
    return h;
  };

  async function register() {
    const r = await httpJson({
      port, host, method: "POST", path: "/fe/register", headers: baseHeaders(),
      body: {
        session_id: sessionId, kind: "roblox",
        label: process.env.ROBLOX_MCP_SESSION_NAME || cwd, pid: process.pid, cwd,
        target: process.env.ROBLOX_MCP_TARGET || undefined,
      },
    });
    if (r.status === 409 && r.json && r.json.suggested) {
      sessionId = rewriteSessionId(cwd, r.json.suggested);
      return register();
    }
    if (r.status === 401) throw new Error("broker token mismatch; restart broker or align ROBLOX_MCP_TOKEN");
    if (r.status === 503) throw new Error("broker draining");
    if (!r.json || r.json.ok !== true) throw new Error(`register failed: ${r.status} ${r.raw}`);
    sessionToken = r.json.session_token || "";
    currentBrokerId = r.json.brokerId || currentBrokerId;
    return r.json;
  }

  // Lazily register before the first token-gated call so callers can `submit`
  // straight away without an explicit register() (parity with createBridge).
  async function ensureRegistered() {
    if (!sessionToken) await register();
  }

  async function heartbeat() {
    await ensureRegistered();
    const r = await httpJson({ port, host, method: "POST", path: "/fe/heartbeat", headers: baseHeaders(), body: { session_id: sessionId } });
    if (r.status === 401) { await register(); return heartbeat(); }
    if (r.json && r.json.brokerId && r.json.brokerId !== currentBrokerId) { await register(); }
    return r.json || { ok: false };
  }

  async function submitTo(studioId, type, payload, timeoutMs = 30_000) {
    await ensureRegistered();
    const r = await httpJson({
      port, host, method: "POST", path: "/session/submit", headers: baseHeaders(),
      body: { session_id: sessionId, type, payload, target: studioId, timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 5_000,
    }).catch(() => ({ json: null }));
    if (r.json == null) return { error: "broker connection lost — retried; rerun the tool", code: "NO_BROKER" };
    return r.json;
  }

  async function submit(type, payload, timeoutMs = 30_000) {
    await ensureRegistered();
    const r = await httpJson({
      port, host, method: "POST", path: "/session/submit", headers: baseHeaders(),
      body: { session_id: sessionId, type, payload, timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 5_000,
    }).catch(() => ({ json: null }));
    if (r.json == null) return { error: "broker connection lost — retried; rerun the tool", code: "NO_BROKER" };
    return r.json;
  }

  // ── Control queue (C3) — start_stop_play{stop} → __stop_play, non-blocking ──
  // Routes onto the target studio's CONTROL queue so it reaches a plugin whose
  // COMMAND loop is yielded inside a play test. `control:true` makes broker-core
  // enqueue + return immediately ({ ok:true, control:true, ... }) rather than
  // blocking on a plugin result. `target` may be null → broker resolves the
  // paired/auto studio (returns a typed {error,code} on an unresolved target).
  async function submitControl(target, type, payload, timeoutMs = 30_000) {
    await ensureRegistered();
    const r = await httpJson({
      port, host, method: "POST", path: "/session/submit", headers: baseHeaders(),
      body: { session_id: sessionId, type, payload, target: target || undefined, control: true, timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 5_000,
    }).catch(() => ({ json: null }));
    if (r.json == null) return { error: "broker connection lost — retried; rerun the tool", code: "NO_BROKER" };
    return r.json;
  }

  // ── Fan-out (target:"all") — broker-core resolves { fanout, results, ok, failed } ──
  async function fanoutSubmit(type, payload, timeoutMs = 30_000) {
    await ensureRegistered();
    const r = await httpJson({
      port, host, method: "POST", path: "/session/submit", headers: baseHeaders(),
      body: { session_id: sessionId, type, payload, target: "all", timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 5_000,
    }).catch(() => ({ json: null }));
    if (r.json == null) return { fanout: true, results: [], ok: 0, failed: 0, error: "broker connection lost", code: "NO_BROKER" };
    return r.json;
  }

  // ── Resolve one studio for the caller (used to PIN a composite mesh build) ──
  // Returns the registry envelope verbatim: { ok, studioId, via } | { error, code, ... }.
  async function resolveSessionTarget(explicitTarget) {
    await ensureRegistered();
    const r = await httpJson({
      port, host, method: "POST", path: "/session/resolve-target", headers: baseHeaders(),
      body: { session_id: sessionId, target: explicitTarget || undefined },
    }).catch(() => ({ json: null }));
    if (r.json == null) return { error: "broker connection lost", code: "NO_BROKER" };
    return r.json;
  }

  async function getStatus() {
    await ensureRegistered();
    const r = await httpJson({
      port, host, path: `/session/${encodeURIComponent(sessionId)}/status`, headers: baseHeaders(),
    }).catch(() => ({ json: null }));
    if (r.json == null) {
      return { pluginConnected: false, msSinceLastPoll: null, queued: 0, inFlight: 0, ready: false, paired: false, error: "broker connection lost", code: "NO_BROKER" };
    }
    return r.json;
  }

  async function deregister() {
    if (!sessionToken) return { ok: true };
    const r = await httpJson({
      port, host, method: "POST", path: "/fe/deregister", headers: baseHeaders(),
      body: { session_id: sessionId }, timeoutMs: 500,
    }).catch(() => ({ json: { ok: false } }));
    return r.json || { ok: false };
  }

  const listStudios = async () => {
    await ensureRegistered();
    return (await httpJson({ port, host, path: "/session/list", headers: baseHeaders() }).catch(() => ({ json: {} }))).json || {};
  };
  const attachStudio = async (target, claim) => {
    await ensureRegistered();
    return (await httpJson({ port, host, method: "POST", path: "/session/attach", headers: baseHeaders(), body: { session_id: sessionId, target, claim } })).json;
  };
  // detach_studio: documented two-form semantics.
  //   no target  → self-unpair (drop THIS session's own pair) via /session/unpair.
  //   has target → admin steal: force-free the named studio even if it is paired
  //                to ANOTHER session, via /session/detach-studio. The registry's
  //                detachStudio() keys on a resolved studioId (not a label), so we
  //                resolve the same id/label forms attach_studio accepts (§5.6)
  //                first, then POST the concrete studio_id.
  const detachStudio = async (target) => {
    await ensureRegistered();
    const t = typeof target === "string" ? target.trim() : "";
    if (!t) {
      return (await httpJson({ port, host, method: "POST", path: "/session/unpair", headers: baseHeaders(), body: { session_id: sessionId } })).json;
    }
    const resolved = await resolveSessionTarget(t);
    if (resolved && resolved.error) return resolved; // surface UNKNOWN/AMBIGUOUS_TARGET verbatim
    const studioId = resolved && resolved.studioId;
    if (!studioId) return { error: "UNKNOWN_TARGET", code: "UNKNOWN_TARGET", message: `no studio matches '${t}'` };
    return (await httpJson({
      port, host, method: "POST", path: "/session/detach-studio", headers: baseHeaders(),
      body: { session_id: sessionId, studio_id: studioId },
    })).json;
  };
  const sessionStatus = async () => getStatus();

  // Free-running heartbeat timer (§3.6.1) — independent of the MCP request cycle.
  const hbTimer = setInterval(() => { heartbeat().catch(() => {}); }, FE_HEARTBEAT_MS);
  hbTimer.unref?.();

  return {
    role, get brokerId() { return currentBrokerId; }, httpServer,
    submit, submitTo, submitControl, fanoutSubmit, resolveSessionTarget,
    getStatus, register, heartbeat, deregister,
    listStudios, attachStudio, detachStudio, sessionStatus,
    stopHeartbeat: () => clearInterval(hbTimer),
  };
}

/**
 * Try to BECOME the broker (STEP A): build a registry + broker-core and bind it
 * ourselves so EADDRINUSE is recoverable. Resolves { won, httpServer, core,
 * brokerId } or { won:false, errno }.
 */
function tryListenBroker({ port, host, authToken, brandPrefix }) {
  return new Promise((resolve) => {
    // C6: the broker is the consumer that supplies requireExplicitPair from env.
    const requireExplicitPair = process.env.ROBLOX_MCP_REQUIRE_EXPLICIT_PAIR === "1";
    const idleReapMs = (() => {
      const v = Number(process.env.ROBLOX_MCP_BROKER_IDLE_MS);
      return Number.isInteger(v) && v >= 0 ? v : 90_000;
    })();
    const registry = createRegistry({ now: Date.now, thresholds: {}, requireExplicitPair });
    const core = createBrokerCore({ registry, now: Date.now, authToken, brandPrefix, idleReapMs });
    const { httpServer } = core;
    const onError = (err) => {
      httpServer.removeListener("listening", onListen);
      resolve({ won: false, errno: err.code, httpServer: null, core: null });
    };
    const onListen = () => {
      httpServer.removeListener("error", onError);
      resolve({ won: true, httpServer, core, brokerId: core.brokerId });
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListen);
    httpServer.listen(port, host);
  });
}

export async function ensureBroker({ port, host = "127.0.0.1", authToken = "", brandPrefix = "[roblox-mcp]", sessionId } = {}) {
  if (!sessionId) sessionId = loadOrMintSessionId();
  // Resolve the machine token once (C4): same source the detached child will use.
  if (!authToken) authToken = loadOrMintMachineToken();

  // STEP A — try to become the in-proc leader (direct bind of the real server).
  const a = await tryListenBroker({ port, host, authToken, brandPrefix });
  if (a.won) {
    // No in-proc session API exists on broker-core; the leader drives its OWN
    // loopback port like a client, tagged role:"inproc" + exposing httpServer.
    const boundPort = a.httpServer.address().port;
    return makeRemoteClient({
      port: boundPort, host, authToken, sessionId,
      brokerId: a.brokerId, httpServer: a.httpServer, role: "inproc",
    });
  }
  if (a.errno && a.errno !== "EADDRINUSE") {
    throw new Error(`${brandPrefix} FATAL: cannot bind ${host}:${port}: ${a.errno}`);
  }

  // STEP B — lost the bind: connect to whoever holds the port.
  for (let i = 0; i < CONNECT_RETRIES; i++) {
    const c = await connect({ port, host, authToken, sessionId, brandPrefix }); // may throw on "older"
    if (c && !c.__stranger) return c;
    if (c && c.__stranger && i >= CONNECT_RETRIES - 1) {
      throw new Error(`${brandPrefix} FATAL: ${host}:${port} is held by a non-broker process`);
    }
    await delay(CONNECT_BACKOFF_MS);
  }

  // STEP C — port held by a half-bound/dying broker that never answered: spawn
  // a detached broker, then connect-or-throw.
  spawnDetachedBroker({ port, host, authToken });
  for (let i = 0; i < SPAWN_CONNECT_RETRIES; i++) {
    const c = await connect({ port, host, authToken, sessionId, brandPrefix });
    if (c && !c.__stranger) return c;
    await delay(SPAWN_BACKOFF_MS);
  }
  throw new Error(`${brandPrefix} FATAL: cannot reach or start broker on ${host}:${port}`);
}
