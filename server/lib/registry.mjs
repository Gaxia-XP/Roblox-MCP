/**
 * server/lib/registry.mjs
 * Pure pairing + claim state machine for the Roblox MCP broker.
 * No I/O, no sockets, no real clock — time is injected via now(). Imports only
 * node:crypto. broker-core.mjs wires HTTP endpoints around this; the registry
 * holds ALL pairing/claim/resolution logic. See design spec §5–§6.
 */
import { randomUUID } from "node:crypto";

// ── Thresholds (spec §3.6 authoritative table) ──
export const DEFAULT_THRESHOLDS = Object.freeze({
  PLUGIN_STALE_MS: 12_000,
  STUDIO_DROP_MS: 120_000,
  SESSION_STALE_MS: 90_000,
  SESSION_DROP_MS: 300_000,
  CLAIM_TTL_DEFAULT_MS: 60_000,
  CLAIM_TTL_MIN_MS: 5_000,
  CLAIM_TTL_MAX_MS: 600_000,
});

const ID_RE = /^[0-9a-fA-F:\-]{8,64}$/;

// ── Label hygiene (spec §2.8): strip control chars, truncate to 80 ──
function cleanLabel(raw, fallback = "Studio") {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1F\x7F]/g, "");
  return (stripped.length === 0 ? fallback : stripped).slice(0, 80);
}

function err(code, message, extra = {}) {
  return { error: code, code, message, ...extra };
}

export function createRegistry({
  now,
  thresholds = {},
  queueFactory = () => null,
  requireExplicitPair = false,
} = {}) {
  if (typeof now !== "function") throw new TypeError("createRegistry requires now()");
  const TH = { ...DEFAULT_THRESHOLDS, ...thresholds };

  /** @type {Map<string, any>} */ const sessions = new Map();
  /** @type {Map<string, any>} */ const studios = new Map();
  /** @type {Map<string, any>} */ const pairs = new Map();      // key = sessionId
  /** @type {Map<string, string>} */ const tokens = new Map();  // sessionId -> token
  /** @type {Map<string, number>} */ const tokenPids = new Map(); // sessionId -> pid

  // ── Sessions / studios ──
  function upsertSession({ sessionId, kind = "mcp", label, cwd = "", pid = 0 }, t = now()) {
    let s = sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId, sessionToken: null, label: cleanLabel(label, "Session"), cwd, pid,
        kind, firstSeenAt: t, lastSeenAt: t, pairedStudioId: null, state: "live",
      };
      sessions.set(sessionId, s);
    } else {
      s.lastSeenAt = t; s.state = "live";
      if (label !== undefined) s.label = cleanLabel(label, "Session");
      if (pid) s.pid = pid;
    }
    return s;
  }

  function upsertStudio({ studioId, label, placeId = 0, connId, legacy = false }, t = now()) {
    let st = studios.get(studioId);
    if (!st) {
      st = {
        studioId, label: cleanLabel(label, "Studio"), placeId,
        connIds: new Set(connId == null ? [] : [connId]),
        lastPollAt: t, pairedSessionId: null, legacy, contested: false,
        claim: null, state: "live", queue: queueFactory(studioId),
      };
      studios.set(studioId, st);
    } else {
      st.lastPollAt = t; st.state = "live";
      if (label !== undefined) st.label = cleanLabel(label, "Studio");
      if (connId != null) st.connIds.add(connId);
      if (legacy === false) st.legacy = false;
    }
    return st;
  }

  function touchSession(sessionId, t = now()) {
    const s = sessions.get(sessionId);
    if (s) { s.lastSeenAt = t; s.state = "live"; }
  }

  function touchStudio(studioId, t = now(), connId) {
    const st = studios.get(studioId);
    if (st) { st.lastPollAt = t; st.state = "live"; if (connId != null) st.connIds.add(connId); }
  }

  function mintSessionToken(sessionId, pid) {
    const token = randomUUID().replace(/-/g, "");
    tokens.set(sessionId, token);
    tokenPids.set(sessionId, pid);
    const s = sessions.get(sessionId);
    if (s) { s.sessionToken = token; s.pid = pid; }
    return token;
  }

  function validateSessionToken(sessionId, token) {
    const expected = tokens.get(sessionId);
    return !!expected && typeof token === "string" && token === expected;
  }

  // ── Liveness helpers (computed on the fly; tick only DROPs) ──
  function sessionLive(s, t) {
    return s.state !== "dropped" && (t - s.lastSeenAt) < TH.SESSION_STALE_MS;
  }

  function studioLive(st, t, hasInFlight) {
    if (hasInFlight(st.studioId)) return true; // in-flight is absolute keepalive (§3.6)
    return st.state !== "dropped" && (t - st.lastPollAt) < TH.PLUGIN_STALE_MS;
  }

  // ── Pair bookkeeping (strict 1:1 invariant) ──
  function bindPair(sessionId, studioId, t, origin) {
    const s = sessions.get(sessionId), st = studios.get(studioId);
    let detached_from = null;
    // break any prior pair on the session side
    if (s.pairedStudioId && s.pairedStudioId !== studioId) {
      const old = studios.get(s.pairedStudioId);
      if (old) old.pairedSessionId = null;
      pairs.delete(sessionId);
      detached_from = s.pairedStudioId;
    }
    // break any prior pair on the studio side
    if (st.pairedSessionId && st.pairedSessionId !== sessionId) {
      const otherSess = sessions.get(st.pairedSessionId);
      if (otherSess) otherSess.pairedStudioId = null;
      pairs.delete(st.pairedSessionId);
    }
    s.pairedStudioId = studioId;
    st.pairedSessionId = sessionId;
    const pr = { sessionId, studioId, boundAt: t, origin };
    pairs.set(sessionId, pr);
    return { pr, detached_from };
  }

  function dissolvePair(sessionId) {
    const s = sessions.get(sessionId);
    if (!s || !s.pairedStudioId) return null;
    const studioId = s.pairedStudioId;
    const st = studios.get(studioId);
    if (st) st.pairedSessionId = null;
    s.pairedStudioId = null;
    pairs.delete(sessionId);
    return studioId;
  }

  // ── Target resolution (spec §5.6): id > exact label > ci-substring ──
  function liveStudioList(t) {
    const out = [];
    for (const st of studios.values()) if (studioLive(st, t, () => false)) out.push(st);
    return out;
  }

  function candidateList(t) {
    return liveStudioList(t).map((st) => ({ studioId: st.studioId, label: st.label }));
  }

  function resolveStudioRef(ref, t = now()) {
    if (typeof ref !== "string" || ref.length === 0)
      return err("UNKNOWN_TARGET", "no target given", { candidates: candidateList(t) });
    if (ref === "all") return err("TARGET_ALL_NOT_ALLOWED", "'all' is not valid here");
    // 1. exact id
    if (studios.has(ref)) return { ok: true, studioId: ref };
    // 2. exact, case-sensitive label
    const exact = [...studios.values()].filter((st) => st.label === ref);
    if (exact.length === 1) return { ok: true, studioId: exact[0].studioId };
    if (exact.length > 1)
      return err("AMBIGUOUS_TARGET", `label '${ref}' matches ${exact.length} studios`,
        { candidates: exact.map((st) => ({ studioId: st.studioId, label: st.label })) });
    // 3. case-insensitive substring
    const lc = ref.toLowerCase();
    const subs = [...studios.values()].filter((st) => st.label.toLowerCase().includes(lc));
    if (subs.length === 1) return { ok: true, studioId: subs[0].studioId };
    if (subs.length > 1)
      return err("AMBIGUOUS_TARGET", `'${ref}' matches ${subs.length} studios`,
        { candidates: subs.map((st) => ({ studioId: st.studioId, label: st.label })) });
    // 4. literal "auto"
    if (ref === "auto") {
      const ap = maybeAutoPair(t);
      if (ap) return { ok: true, studioId: ap.studioId };
      return err("AMBIGUOUS_TARGET", "no unambiguous auto target", { candidates: candidateList(t) });
    }
    return err("UNKNOWN_TARGET", `no studio matches '${ref}'`, { candidates: candidateList(t) });
  }

  // ── Auto 1:1 (spec §5.3) — C6: kill-switch via requireExplicitPair ──
  // Fires ONLY when the global headcount is exactly 1 live session and 1 live studio
  // (both unpaired). Any additional registered entity — even an already-paired one —
  // puts the topology above 1×1 and suppresses auto-pairing.
  function maybeAutoPair(t = now()) {
    if (requireExplicitPair) return null; // C6: admin has disabled auto-pairing
    const liveS = [...sessions.values()].filter((s) => sessionLive(s, t));
    const liveT = [...studios.values()].filter((st) => studioLive(st, t, () => false));
    // Global headcount must be exactly 1×1 (regardless of paired state).
    if (liveS.length !== 1 || liveT.length !== 1) return null;
    const S = liveS[0], T = liveT[0];
    // Already paired to each other — idempotent.
    if (S.pairedStudioId === T.studioId && T.pairedSessionId === S.sessionId)
      return null;
    // Not paired yet (the only 1×1 case that matters).
    if (S.pairedStudioId === null && T.pairedSessionId === null && !T.contested) {
      const { pr } = bindPair(S.sessionId, T.studioId, t, "auto");
      return pr;
    }
    return null;
  }

  // ── pair / attach / unpair / detach ──
  function pair(sessionId, target, t = now()) {
    if (!sessions.get(sessionId)) upsertSession({ sessionId }, t);
    touchSession(sessionId, t);
    const r = resolveStudioRef(target, t);
    if (r.error) return r;
    const st = studios.get(r.studioId);
    if (st.pairedSessionId && st.pairedSessionId !== sessionId) {
      const occ = sessions.get(st.pairedSessionId);
      return err("STUDIO_BUSY", `studio ${st.studioId} is paired to another session`,
        { occupiedBy: { sessionId: st.pairedSessionId, label: occ ? occ.label : null } });
    }
    const { pr, detached_from } = bindPair(sessionId, r.studioId, t, "manual");
    return { ok: true, pair: pr, ...(detached_from ? { detached_from } : {}) };
  }

  // ── Claims (spec §6.2): at most one active claim per studio; lazy TTL expiry ──
  function getActiveClaim(studioId, t = now()) {
    const st = studios.get(studioId);
    if (!st || !st.claim) return null;
    if (t > st.claim.expiresAt) { st.claim = null; return null; } // lazy expiry
    return st.claim;
  }

  function acquireClaim(sessionId, studioId, spec = {}, t = now()) {
    const st = studios.get(studioId);
    if (!st) return err("UNKNOWN_TARGET", `no studio ${studioId}`);
    const mode = spec.mode === "exclusive" ? "exclusive" : "soft";
    const ttlMs = Math.min(TH.CLAIM_TTL_MAX_MS,
      Math.max(TH.CLAIM_TTL_MIN_MS, Number(spec.ttlMs) || TH.CLAIM_TTL_DEFAULT_MS));
    const active = getActiveClaim(studioId, t); // expires stale first
    if (active && active.sessionId !== sessionId) {
      if (active.mode === "exclusive")
        return err("STUDIO_LOCKED", `studio ${studioId} is exclusively claimed`,
          { heldBy: active.sessionId, expiresAt: active.expiresAt });
      // active soft, different session: new soft is allowed but warned;
      // new exclusive over a soft held by another is rejected
      if (mode === "exclusive")
        return err("STUDIO_LOCKED", `studio ${studioId} has a soft claim by another session`,
          { heldBy: active.sessionId, expiresAt: active.expiresAt });
      // keep the first soft claim record but tell the 2nd it's held
      return { ok: true, claim: active, warning: "CLAIM_HELD" };
    }
    // free, or owned by this session (renew)
    const claim = {
      studioId, sessionId, label: cleanLabel(spec.label, "claim"),
      mode, ttlMs, acquiredAt: t, expiresAt: t + ttlMs,
    };
    st.claim = claim;
    return { ok: true, claim };
  }

  function releaseClaim(sessionId, studioId, t = now()) {
    if (!studioId) return { ok: true, released: false };
    const st = studios.get(studioId);
    const active = getActiveClaim(studioId, t);
    if (st && active && active.sessionId === sessionId) {
      st.claim = null;
      return { ok: true, released: true };
    }
    return { ok: true, released: false };
  }

  // ── Enqueue gate (spec §6.2): exclusive claim enforced before enqueue ──
  function enqueueGate(sessionId, studioId, t = now()) {
    const active = getActiveClaim(studioId, t);
    if (active && active.mode === "exclusive" && active.sessionId !== sessionId)
      return err("STUDIO_LOCKED", `studio ${studioId} is exclusively claimed`,
        { heldBy: active.sessionId, expiresAt: active.expiresAt });
    return { ok: true };
  }

  function attach(sessionId, target, claimSpec, t = now()) {
    const p = pair(sessionId, target, t);
    if (p.error) return p;
    const st = studios.get(p.pair.studioId);
    const out = { ok: true, studio_id: st.studioId, label: st.label };
    if (claimSpec && claimSpec.mode) {
      const c = acquireClaim(sessionId, st.studioId, claimSpec, t);
      if (c.error) return c;
      out.claim = c.claim;
      if (c.warning) out.warning = c.warning;
    }
    return out;
  }

  function unpair(sessionId, target, t = now()) {
    // target is advisory for self-unpair; we always drop the caller's own pair.
    const released = releaseClaim(sessionId, sessions.get(sessionId)?.pairedStudioId, t).released;
    const studioId = dissolvePair(sessionId);
    return { ok: true, detached: studioId != null, released_claim: released, studio_id: studioId };
  }

  function detach(sessionId, t = now()) { return unpair(sessionId, undefined, t); }

  function detachStudio(sessionId, studioId, t = now()) {
    const st = studios.get(studioId);
    if (!st) return err("UNKNOWN_TARGET", `no studio ${studioId}`);
    const former = st.pairedSessionId;
    if (former) {
      const fs = sessions.get(former);
      if (fs) fs.pairedStudioId = null;
      pairs.delete(former);
      st.pairedSessionId = null;
    }
    if (st.claim) st.claim = null; // admin steal frees the claim too
    return { ok: true, freed: { studio_id: studioId, former_session_id: former || null } };
  }

  // ── resolveTarget (spec §5.4): explicit > bound > auto > NO_TARGET ──
  function resolveTarget(sessionId, explicitTarget, t = now()) {
    touchSession(sessionId, t);
    if (explicitTarget != null && explicitTarget !== "") {
      const r = resolveStudioRef(explicitTarget, t);
      if (r.error) return r;
      return { ok: true, studioId: r.studioId, via: "explicit", warnIfOwnedByOther: true };
    }
    const sess = sessions.get(sessionId);
    if (sess && sess.pairedStudioId) {
      const st = studios.get(sess.pairedStudioId);
      if (st) return { ok: true, studioId: st.studioId, via: "pair", studioState: st.state };
      return err("PAIR_TARGET_GONE", "your paired studio is gone", { candidates: candidateList(t) });
    }
    const auto = maybeAutoPair(t);
    if (auto && auto.sessionId === sessionId) return { ok: true, studioId: auto.studioId, via: "auto" };
    return err("NO_TARGET", "no studio is paired and auto-pair is ambiguous",
      { candidates: candidateList(t), hint: "call attach_studio or pass an explicit target" });
  }

  // ── Atomic legacy→real upgrade (spec §2.5) ──
  function rekeyStudio(oldId, newId, t = now()) {
    const st = studios.get(oldId);
    if (!st) return { ok: false };
    if (studios.has(newId)) {
      // real id already exists (rare): merge pending into the existing real studio, drop the shell.
      const real = studios.get(newId);
      if (st.queue && real.queue && Array.isArray(st.queue.pending) && Array.isArray(real.queue.pending))
        real.queue.pending.unshift(...st.queue.pending);
      studios.delete(oldId);
      return { ok: true, studio: real };
    }
    // move the SAME record under the new key (queue/connIds/claim travel with it).
    studios.delete(oldId);
    st.studioId = newId;
    st.legacy = false;
    studios.set(newId, st);
    // re-point the pair caches on both sides.
    if (st.pairedSessionId) {
      const s = sessions.get(st.pairedSessionId);
      if (s) s.pairedStudioId = newId;
      const pr = pairs.get(st.pairedSessionId);
      if (pr) pr.studioId = newId;
    }
    if (st.claim) st.claim.studioId = newId;
    return { ok: true, studio: st };
  }

  // ── Sweep: only DROP happens here; live/stale is computed on the fly elsewhere (§3.6 note) ──
  function tick(t = now(), { hasInFlight = () => false } = {}) {
    const droppedStudios = [], droppedSessions = [];
    for (const st of [...studios.values()]) {
      if (hasInFlight(st.studioId)) {
        // In-flight is an absolute keepalive: skip the drop check entirely.
        // We intentionally do NOT reset lastPollAt — the idle clock keeps ticking
        // so that once the command completes (hasInFlight returns false), the studio
        // drops on the very next tick if it hasn't polled since.
        st.state = "live";
        continue;
      }
      const idle = t - st.lastPollAt;
      if (idle >= TH.STUDIO_DROP_MS) {
        if (st.pairedSessionId) dissolvePair(st.pairedSessionId);
        studios.delete(st.studioId);
        droppedStudios.push(st.studioId);
      } else if (idle >= TH.PLUGIN_STALE_MS) {
        st.state = "stale";
      }
    }
    for (const s of [...sessions.values()]) {
      const idle = t - s.lastSeenAt;
      if (idle >= TH.SESSION_DROP_MS) {
        dissolvePair(s.sessionId);
        sessions.delete(s.sessionId);
        tokens.delete(s.sessionId);
        tokenPids.delete(s.sessionId);
        droppedSessions.push(s.sessionId);
      } else if (idle >= TH.SESSION_STALE_MS) {
        s.state = "stale";
      }
    }
    return { droppedStudios, droppedSessions };
  }

  function snapshot(t = now()) {
    return {
      studios: [...studios.values()].map((st) => ({
        studioId: st.studioId, label: st.label, placeId: st.placeId,
        legacy: st.legacy, contested: st.contested,
        pairedSessionId: st.pairedSessionId, state: st.state,
        live: studioLive(st, t, () => false),
        claim: getActiveClaim(st.studioId, t),
      })),
      sessions: [...sessions.values()].map((s) => ({
        sessionId: s.sessionId, label: s.label, pid: s.pid, kind: s.kind,
        pairedStudioId: s.pairedStudioId, state: s.state, live: sessionLive(s, t),
      })),
      pairs: [...pairs.values()].map((p) => ({ ...p })),
      claims: [...studios.values()].map((st) => getActiveClaim(st.studioId, t)).filter(Boolean),
    };
  }

  return {
    // accessors
    getSession: (id) => sessions.get(id) || null,
    getStudio: (id) => studios.get(id) || null,
    // lifecycle
    upsertSession, upsertStudio, touchSession, touchStudio,
    mintSessionToken, validateSessionToken,
    // resolution
    resolveStudioRef, resolveTarget, maybeAutoPair,
    // pairing
    pair, unpair, attach, detach, detachStudio,
    // claims
    acquireClaim, releaseClaim, getActiveClaim, enqueueGate,
    // advanced
    rekeyStudio, tick, snapshot,
  };
}
