/**
 * server/lib/broker-core.mjs
 * The Broker's own HTTP server: §4 endpoints on 127.0.0.1, assembled from the
 * extracted http-bridge helpers around an injected (Task 2) registry + a
 * per-studio command/control CommandQueue + a broker-global inFlight Map.
 * Pure node builtins + lib helpers; NO MCP SDK. The /studio/* contract mirrors
 * the legacy /poll,/result wire shape ({ id, type, payload }).
 *
 * Consumes from server/lib/http-bridge.mjs (Task 1):
 *   - hostAllowed(hostHeader, hosts)  (NOTE: takes the Host *string*, not req)
 *   - makeHostSet(host, port)
 *   - redactHeaders(headers)
 *   - readBody(req, res, onComplete, { maxBodyBytes, bodyTimeoutMs })
 *   - attachClientError(httpServer)
 *   - createCommandQueue() -> { pending, waiters, deliverOrQueue, removePending, parkWaiter }
 * The injected registry (Task 2) owns ALL pairing/claim/resolution logic.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  hostAllowed,
  makeHostSet,
  redactHeaders,
  readBody,
  attachClientError,
  createCommandQueue,
} from "./http-bridge.mjs";

// ── Constants (spec §3.6 authoritative table) ──
const PLUGIN_STALE_MS = 12_000;
const DRAIN_CEILING_MS = 60_000;
const POLL_TIMEOUT_MS = 10_000;
const CONTROL_POLL_TIMEOUT_MS = 10_000;
const CONTESTED_WINDOW_MS = 3_000; // two distinct connIds within this → contested
const PROTO = 1;
const LEGACY_STUDIO_ID = "legacy:default";
const LEGACY_SESSION_ID = "session:legacy";
const ID_RE = /^[0-9a-fA-F:\-]{8,64}$/;

export function createBrokerCore({
  registry,
  now = Date.now,
  authToken = "",
  brandPrefix = "[roblox-mcp]",
  idleReapMs = 90_000,
  maxBodyBytes = 8 * 1024 * 1024,
  bodyTimeoutMs = 30_000,
} = {}) {
  if (!registry) throw new TypeError("createBrokerCore requires a registry");
  const brokerId = randomUUID();
  let draining = false;
  let drainSince = 0;
  let idleSince = 0;
  let connSeq = 0;

  // broker-global in-flight: id -> { resolve, timeout, studioId }
  const inFlight = new Map();
  // per-studio command + control queues, keyed by studioId
  const cmdQueues = new Map();
  const ctrlQueues = new Map();
  // recent connIds per studioId, for contested detection: id -> Map<connId, ts>
  const recentConns = new Map();

  function cmdQueue(studioId) {
    let q = cmdQueues.get(studioId);
    if (!q) { q = createCommandQueue(); cmdQueues.set(studioId, q); }
    return q;
  }
  function ctrlQueue(studioId) {
    let q = ctrlQueues.get(studioId);
    if (!q) { q = createCommandQueue(); ctrlQueues.set(studioId, q); }
    return q;
  }
  function countInFlight(studioId) {
    let n = 0;
    for (const v of inFlight.values()) if (v.studioId === studioId) n++;
    return n;
  }
  function hasInFlight(studioId) { return countInFlight(studioId) > 0; }

  // ── logging / responses (§2.8: redactHeaders on EVERY new endpoint's log) ──
  function logLine(req) {
    console.error(`${brandPrefix} ${req.method} ${req.url} ${JSON.stringify(redactHeaders(req.headers))}`);
  }
  function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }
  function readJson(req, res, cb) {
    readBody(req, res, (body) => {
      let parsed;
      try { parsed = JSON.parse(body || "{}"); }
      catch { return sendJson(res, 400, { error: "bad request", code: "BAD_REQUEST" }); }
      cb(parsed);
    }, { maxBodyBytes, bodyTimeoutMs });
  }

  // ── broker token gate (§2.7): everything except /health is guarded ──
  // NOTE: Task 1's exported tokenGuarded() covers only the LEGACY set
  // (/poll,/submit,/result/*). The broker guards the full §4 surface, so the
  // gate is implemented here: /studio/*, /session/*, /fe/*, and the legacy
  // aliases /poll + /result/* are guarded; /health is always open.
  function brokerTokenGuarded(p) {
    if (p === "/health") return false;
    return (
      p.startsWith("/studio/") ||
      p.startsWith("/session/") ||
      p.startsWith("/fe/") ||
      p === "/poll" ||
      p.startsWith("/result/")
    );
  }

  // ── long-poll parking built from Task 1's parkWaiter + a manual timer ──
  // (Task 1's createCommandQueue exposes parkWaiter, not a high-level park().)
  // onSettle (optional) runs exactly once when the poll resolves (delivery,
  // timeout, or client drop) — used to release a command-poll's active connId.
  function parkPoll(queue, req, res, timeoutMs, onSettle) {
    let sent = false;
    let unpark;
    const settle = () => { if (onSettle) { const f = onSettle; onSettle = null; f(); } };
    const timer = setTimeout(() => {
      if (sent) return;
      sent = true;
      if (unpark) unpark();
      settle();
      sendJson(res, 200, {});
    }, timeoutMs);
    const waiter = (cmd) => {
      if (sent) return false;
      sent = true;
      clearTimeout(timer);
      settle();
      sendJson(res, 200, cmd);
      return true;
    };
    // parkWaiter's onAbandon fires on client drop: clear the timer AND settle.
    unpark = queue.parkWaiter(waiter, req, () => { clearTimeout(timer); settle(); });
  }

  // ── connId / contested bookkeeping (§2.6) ──
  // Concurrency detection by OVERLAPPING command-poll timing, not socket identity
  // (spec §2.6 + edges #8/#9/#13). A connId is "active" only while its command
  // poll is currently parked/in-flight; two distinct connIds whose command polls
  // overlap → contested. A reopened window (sequential, prior poll already
  // returned) never overlaps → NOT contested. A stale entry past the window is
  // swept so a wedged poll cannot pin `contested` forever.
  function recomputeContested(studioId) {
    const m = recentConns.get(studioId);
    const t = now();
    if (m) for (const [c, ts] of m) if (t - ts > CONTESTED_WINDOW_MS) m.delete(c);
    const contested = !!m && m.size >= 2;
    // Task 2's registry has no markContested(); the studio record carries a
    // `contested` field — set it directly through getStudio().
    const st = registry.getStudio(studioId);
    if (st) st.contested = contested;
    return contested;
  }
  // Register connId as an active command poll; returns contested state now.
  function noteConn(studioId, connId) {
    let m = recentConns.get(studioId);
    if (!m) { m = new Map(); recentConns.set(studioId, m); }
    m.set(connId, now());
    return recomputeContested(studioId);
  }
  // Release a command poll's connId when it settles; re-evaluates contested.
  function releaseConn(studioId, connId) {
    const m = recentConns.get(studioId);
    if (m) m.delete(connId);
    recomputeContested(studioId);
  }

  // ── enqueue (§4.3) ──
  function enqueueToStudio(studio, type, payload, timeoutMs) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const cmd = { id, type, payload };
      const timeout = setTimeout(() => {
        inFlight.delete(id);
        studio.queue.removePending(id);
        resolve({
          error: `timeout after ${timeoutMs}ms — ${brandPrefix} studio ${studio.id} busy (queued:${studio.queue.pending.length}, inFlight:${countInFlight(studio.id)}) — is the plugin connected?`,
          code: "TIMEOUT",
        });
      }, timeoutMs);
      inFlight.set(id, { resolve, timeout, studioId: studio.id });
      studio.queue.deliverOrQueue(cmd);
    });
  }
  function enqueueControl(studioId, type, payload) {
    const id = randomUUID();
    ctrlQueue(studioId).deliverOrQueue({ id, type, payload });
    return id;
  }

  // ── fan-out (§6.5): target:"all" → Promise.all per live studio, never throws ──
  function liveStudioIds(t) {
    return registry.snapshot(t).studios
      .filter((s) => s.live || hasInFlight(s.studioId))
      .map((s) => s.studioId);
  }
  async function fanoutSubmit(type, payload, timeoutMs, t) {
    const ids = liveStudioIds(t);
    const results = await Promise.all(ids.map(async (sid) => {
      const st = registry.getStudio(sid);
      const studio = { id: sid, queue: cmdQueue(sid) };
      let result;
      try { result = await enqueueToStudio(studio, type, payload, timeoutMs); }
      catch (e) { result = { error: String(e && e.message || e), code: "FANOUT_ERROR" }; }
      return { studioId: sid, label: st ? st.label : null, result };
    }));
    const failed = results.filter((r) => r.result && r.result.error).length;
    return { fanout: true, results, ok: results.length - failed, failed };
  }

  // ── status (§4.3.1: five legacy fields + additive pairing) ──
  function getStudioStatus(studioId, t) {
    const st = registry.getStudio(studioId);
    if (!st) {
      return { pluginConnected: false, msSinceLastPoll: null, queued: 0, inFlight: 0, ready: false, paired: false };
    }
    const q = cmdQueue(studioId);
    const since = st.lastPollAt ? t - st.lastPollAt : null;
    const inflight = countInFlight(studioId);
    const pluginConnected = (st.lastPollAt && since < PLUGIN_STALE_MS) || inflight > 0;
    return {
      pluginConnected,
      msSinceLastPoll: since,
      queued: q.pending.length,
      inFlight: inflight,
      ready: pluginConnected && q.pending.length === 0 && inflight === 0,
      paired: !!st.pairedSessionId,
      studio_id: studioId,
      studio_label: st.label,
    };
  }

  function getSnapshot() {
    return { brokerId, draining, ...registry.snapshot(now()) };
  }

  // ── sweep / idle (§3.6) ──
  function sweep(t) {
    // Pass the in-flight keepalive so an in-flight studio is never dropped (§3.6).
    registry.tick(t, { hasInFlight });
    const snap = registry.snapshot(t);
    const liveStudios = snap.studios.filter((s) => s.live || hasInFlight(s.studioId));
    const liveSessions = snap.sessions.filter((s) => s.live);
    const idle = liveSessions.length === 0 && liveStudios.length === 0 && inFlight.size === 0;
    if (idle) { if (!idleSince) idleSince = t; }
    else idleSince = 0;
    const shouldReap = idle && !!idleSince && t - idleSince >= idleReapMs;
    return { idle, shouldReap };
  }

  function beginShutdown() {
    if (draining) return;
    draining = true;
    drainSince = now();
  }
  function drainExpired(t) { return draining && t - drainSince >= DRAIN_CEILING_MS; }

  // ── studio-plane helpers ──
  function studioIdFrom(req) {
    const raw = (req.headers["x-studio-id"] || "").toString();
    return ID_RE.test(raw) ? raw : LEGACY_STUDIO_ID;
  }
  function studioLabelFrom(req) {
    // x-studio-label capped 160 bytes pre-parse (§2.8); strip control chars,
    // truncate to 80. NOTE: written with proper escape sequences (never raw bytes).
    const raw = (req.headers["x-studio-label"] || "").toString().slice(0, 160);
    return raw ? raw.replace(/[\x00-\x1F]/g, "").slice(0, 80) : undefined;
  }

  function handleStudioPoll(req, res, isControl) {
    const t = now();
    const studioId = studioIdFrom(req);
    const connId = ++connSeq;
    const legacy = studioId === LEGACY_STUDIO_ID;
    registry.upsertStudio({ studioId, label: studioLabelFrom(req), connId, legacy }, t);
    registry.touchStudio(studioId, t, connId);
    registry.tick(t, { hasInFlight });
    registry.maybeAutoPair(t);

    if (isControl) {
      // Control loop is never blocked by command handlers, and is NOT held by
      // contested/draining — it is the channel that delivers __assign_studio_id.
      // It also does NOT participate in contested detection (a single window
      // runs both a command loop AND a control loop; counting the control poll
      // would falsely mark every single-window studio contested).
      const cq = ctrlQueue(studioId);
      if (cq.pending.length > 0) return sendJson(res, 200, cq.pending.shift());
      return parkPoll(cq, req, res, CONTROL_POLL_TIMEOUT_MS);
    }

    // Command poll: this connId is active for the life of the poll.
    const contested = noteConn(studioId, connId);

    if (contested) { releaseConn(studioId, connId); return sendJson(res, 200, {}); } // §2.6: hold while contested
    if (draining) { releaseConn(studioId, connId); return sendJson(res, 200, {}); }   // §3.6: stop new dequeues

    const q = cmdQueue(studioId);
    if (q.pending.length > 0) { releaseConn(studioId, connId); return sendJson(res, 200, q.pending.shift()); }
    return parkPoll(q, req, res, POLL_TIMEOUT_MS, () => releaseConn(studioId, connId));
  }

  function handleStudioResult(req, res, id) {
    readBody(req, res, (body) => {
      let parsed;
      try { parsed = JSON.parse(body || "{}"); }
      catch { parsed = { error: "invalid JSON from plugin" }; }
      const handler = inFlight.get(id);
      if (handler) {
        // owner-check: reject ONLY when this id maps to a DIFFERENT still-live
        // studio's command (a re-keyed/reassigned id whose studioId was updated
        // matches fine — §2.5/§4.3).
        const claimedBy = (req.headers["x-studio-id"] || "").toString();
        if (claimedBy && ID_RE.test(claimedBy) &&
            handler.studioId && claimedBy !== handler.studioId &&
            registry.getStudio(claimedBy)) {
          return sendJson(res, 200, { ok: true }); // not your command; ignore quietly
        }
        clearTimeout(handler.timeout);
        inFlight.delete(id);
        handler.resolve(parsed);
        return sendJson(res, 200, { ok: true });
      }
      // C1 late-result log preserved verbatim (verified http-bridge.mjs:157).
      console.error(`late result for ${id}, op may have completed plugin-side`);
      return sendJson(res, 200, { ok: true });
    }, { maxBodyBytes, bodyTimeoutMs });
  }

  // ── session-plane (§2.7 token gate before resolveTarget) ──
  function sessionTokenOk(req, sessionId) {
    return registry.validateSessionToken(sessionId, (req.headers["x-session-token"] || "").toString());
  }

  function handleSessionPlane(req, res, url, p) {
    const t = now();

    if (req.method === "POST" && p === "/fe/register") {
      readJson(req, res, (b) => {
        if (draining) return sendJson(res, 503, { error: "broker draining" });
        registry.upsertSession({
          sessionId: b.session_id, kind: b.kind, label: b.label, pid: b.pid, cwd: b.cwd,
        }, t);
        const token = registry.mintSessionToken(b.session_id, b.pid);
        if (b.target) registry.attach(b.session_id, b.target, undefined, t);
        registry.maybeAutoPair(t);
        const sess = registry.getSession(b.session_id);
        idleSince = 0;
        sendJson(res, 200, {
          ok: true, brokerId, session_token: token,
          paired_studio_id: sess?.pairedStudioId || null,
          origin: null,
        });
      });
      return true;
    }

    if (req.method === "POST" && p === "/fe/heartbeat") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        registry.touchSession(b.session_id, t);
        idleSince = 0;
        const sess = registry.getSession(b.session_id);
        sendJson(res, 200, { ok: true, brokerId, paired_studio_id: sess?.pairedStudioId || null, origin: null });
      });
      return true;
    }

    if (req.method === "POST" && p === "/fe/deregister") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        registry.detach(b.session_id, t);
        sendJson(res, 200, { ok: true });
      });
      return true;
    }

    // C5.1: token-gated resolve-target — returns the registry envelope verbatim.
    if (req.method === "POST" && p === "/session/resolve-target") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        sendJson(res, 200, registry.resolveTarget(b.session_id, b.target, t));
      });
      return true;
    }

    if (req.method === "POST" && p === "/session/submit") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        if (!b.type) return sendJson(res, 400, { error: "bad request", code: "BAD_REQUEST" });
        registry.touchSession(b.session_id, t);

        // C5.3: target:"all" → fan out to all live studios (§6.5).
        if (b.target === "all") {
          fanoutSubmit(b.type, b.payload, b.timeout_ms || 30_000, t).then((r) => sendJson(res, 200, r));
          return;
        }

        const sel = registry.resolveTarget(b.session_id, b.target, t);
        if (sel.error) return sendJson(res, 200, sel); // typed error as a normal tool result
        const studioId = sel.studioId;

        // C5.2: control:true → route onto the control queue (non-blocking).
        if (b.control === true) {
          enqueueControl(studioId, b.type, b.payload);
          return sendJson(res, 200, { ok: true, control: true, studio_id: studioId });
        }

        // exclusive-claim gate (§6.2) — never blocks control-plane calls.
        const gate = registry.enqueueGate(b.session_id, studioId, t);
        if (gate.error) return sendJson(res, 200, gate);

        const studio = { id: studioId, queue: cmdQueue(studioId) };
        enqueueToStudio(studio, b.type, b.payload, b.timeout_ms || 30_000).then((r) => sendJson(res, 200, r));
      });
      return true;
    }

    if (req.method === "GET" && /^\/session\/[^/]+\/status$/.test(p)) {
      const sid = decodeURIComponent(p.split("/")[2]);
      if (!sessionTokenOk(req, sid)) { sendJson(res, 401, { error: "unauthorized" }); return true; }
      const sess = registry.getSession(sid);
      const targetId = sess?.pairedStudioId;
      const base = targetId
        ? getStudioStatus(targetId, t)
        : { pluginConnected: false, msSinceLastPoll: null, queued: 0, inFlight: 0, ready: false, paired: false };
      sendJson(res, 200, { ...base, session_id: sid, session_label: sess?.label, origin: targetId ? "paired" : "unpaired" });
      return true;
    }

    if (req.method === "GET" && p === "/session/list") {
      const sid = (req.headers["x-session-id"] || "").toString();
      if (!sessionTokenOk(req, sid)) { sendJson(res, 401, { error: "unauthorized" }); return true; }
      const snap = registry.snapshot(t);
      const you = registry.getSession(sid);
      sendJson(res, 200, {
        studios: snap.studios, sessions: snap.sessions, pairs: snap.pairs,
        you: { session_id: sid, paired_studio_id: you?.pairedStudioId || null },
      });
      return true;
    }

    if (req.method === "POST" && (p === "/session/pair" || p === "/session/attach")) {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        sendJson(res, 200, registry.attach(b.session_id, b.target, b.claim, t));
      });
      return true;
    }

    if (req.method === "POST" && p === "/session/unpair") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        sendJson(res, 200, registry.unpair(b.session_id, b.target, t));
      });
      return true;
    }

    if (req.method === "POST" && p === "/session/detach-studio") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        // Admin steal: detachStudio(callerSessionId, targetStudioId, now).
        sendJson(res, 200, registry.detachStudio(b.session_id, b.studio_id, t));
      });
      return true;
    }

    return false;
  }

  // ── HTTP dispatch ──
  function dispatch(req, res, url, p) {
    // plugin plane + legacy aliases
    if (req.method === "GET" && (p === "/studio/poll" || p === "/poll")) return handleStudioPoll(req, res, false);
    if (req.method === "GET" && p === "/studio/control-poll") return handleStudioPoll(req, res, true);
    if (req.method === "POST" && p.startsWith("/studio/result/")) return handleStudioResult(req, res, p.slice("/studio/result/".length));
    if (req.method === "POST" && p.startsWith("/result/")) return handleStudioResult(req, res, p.slice("/result/".length));
    if (req.method === "POST" && p === "/studio/register") {
      return readJson(req, res, (b) => {
        const studioId = (b.studio_id && ID_RE.test(b.studio_id)) ? b.studio_id : LEGACY_STUDIO_ID;
        registry.upsertStudio({ studioId, label: b.studio_label, connId: ++connSeq, legacy: studioId === LEGACY_STUDIO_ID }, now());
        registry.touchStudio(studioId, now());
        registry.maybeAutoPair(now());
        const st = registry.getStudio(studioId);
        sendJson(res, 200, { ok: true, paired_session: st?.pairedSessionId || null });
      });
    }

    // session plane
    if (handleSessionPlane(req, res, url, p)) return;

    sendJson(res, 404, { error: "not found" });
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (!hostAllowed(req.headers.host, httpServer.__hosts || new Set())) {
      return sendJson(res, 403, { error: "forbidden host" });
    }

    if (p !== "/health") logLine(req);

    if (authToken && brokerTokenGuarded(p) && req.headers["x-mcp-token"] !== authToken) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (req.method === "GET" && p === "/health") {
      // §4.1: unauthenticated, NO topology counts (no reconnaissance).
      return sendJson(res, 200, { ok: true, role: "broker", proto: PROTO, brokerId });
    }

    return dispatch(req, res, url, p);
  });

  // host allowlist rebuilt on listen (port 0 → ephemeral). Until then, the
  // server hasn't accepted connections, so __hosts is populated before any req.
  httpServer.__hosts = null;
  httpServer.on("listening", () => {
    const real = httpServer.address().port;
    httpServer.__hosts = makeHostSet("127.0.0.1", real);
  });
  attachClientError(httpServer);

  return {
    httpServer, inFlight, brokerId,
    enqueueToStudio, enqueueControl, beginShutdown, sweep,
    getSnapshot, getStudioStatus,
    // exposed for the entry / tests:
    _internals: { cmdQueue, ctrlQueue, noteConn, countInFlight, hasInFlight, drainExpired, isDraining: () => draining, fanoutSubmit },
    LEGACY_STUDIO_ID, LEGACY_SESSION_ID,
  };
}
