/**
 * server/test/registry.test.mjs
 * TDD suite for the pure pairing + claim state machine.
 * Runs under `node --test server/test/registry.test.mjs` with NO node_modules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, DEFAULT_THRESHOLDS } from "../lib/registry.mjs";

// A controllable clock: tests advance `clock.t` and pass clock.now to the registry.
function makeClock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("upsertSession/Studio create records; tokens mint and validate by (sessionId,pid)", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });

  const s = reg.upsertSession({ sessionId: "sess-1", kind: "mcp", label: "repo", cwd: "/r", pid: 100 }, clk.now());
  assert.equal(s.sessionId, "sess-1");
  assert.equal(s.pairedStudioId, null);
  assert.equal(s.state, "live");

  const st = reg.upsertStudio({ studioId: "stud-1", label: "Game", connId: 1 }, clk.now());
  assert.equal(st.studioId, "stud-1");
  assert.equal(st.pairedSessionId, null);
  assert.equal(st.legacy, false);

  const tok = reg.mintSessionToken("sess-1", 100);
  assert.equal(typeof tok, "string");
  assert.ok(tok.length >= 16);
  assert.equal(reg.validateSessionToken("sess-1", tok), true);
  assert.equal(reg.validateSessionToken("sess-1", "wrong"), false);
  assert.equal(reg.validateSessionToken("sess-2", tok), false); // bound to sess-1
  // Re-mint after pid change rotates the token (rebinds (sessionId,pid)).
  const tok2 = reg.mintSessionToken("sess-1", 999);
  assert.notEqual(tok2, tok);
  assert.equal(reg.validateSessionToken("sess-1", tok), false);
  assert.equal(reg.validateSessionToken("sess-1", tok2), true);
});

test("maybeAutoPair fires exactly 1×1, stops the instant a 2nd of either side appears", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());

  const p = reg.maybeAutoPair(clk.now());
  assert.ok(p, "auto-pair fires for the lone 1×1 topology");
  assert.equal(p.origin, "auto");
  assert.equal(p.sessionId, "sess-1");
  assert.equal(p.studioId, "stud-1");
  // idempotent: already paired => no new pair
  assert.equal(reg.maybeAutoPair(clk.now()), null);

  // A 2nd unpaired session + a 2nd unpaired studio must NOT auto-pair.
  reg.upsertSession({ sessionId: "sess-2", pid: 2 }, clk.now());
  reg.upsertStudio({ studioId: "stud-2", connId: 2 }, clk.now());
  assert.equal(reg.maybeAutoPair(clk.now()), null, "ambiguous 2×2 never auto-pairs");
});

test("resolveTarget precedence: explicit > bound pair > auto > NO_TARGET", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", label: "Alpha", connId: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-2", label: "Beta", connId: 2 }, clk.now());

  // No pair yet and 2 studios => targetless is NO_TARGET (auto can't pick 1×2).
  const none = reg.resolveTarget("sess-1", undefined, clk.now());
  assert.equal(none.code, "NO_TARGET");
  assert.ok(Array.isArray(none.candidates));

  // Explicit by label resolves regardless of pairing.
  const ex = reg.resolveTarget("sess-1", "Beta", clk.now());
  assert.equal(ex.ok, true);
  assert.equal(ex.studioId, "stud-2");
  assert.equal(ex.via, "explicit");

  // Bind a pair, then targetless resolves via that pair.
  reg.pair("sess-1", "Alpha", clk.now());
  const viaPair = reg.resolveTarget("sess-1", undefined, clk.now());
  assert.equal(viaPair.ok, true);
  assert.equal(viaPair.studioId, "stud-1");
  assert.equal(viaPair.via, "pair");

  // Explicit STILL overrides the bound pair (mode-2 escape hatch).
  const override = reg.resolveTarget("sess-1", "Beta", clk.now());
  assert.equal(override.studioId, "stud-2");
  assert.equal(override.via, "explicit");
});

test("resolveStudioRef: AMBIGUOUS on duplicate substring, UNKNOWN on no match, id beats label", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertStudio({ studioId: "aaaaaaaa-1111", label: "Forest", connId: 1 }, clk.now());
  reg.upsertStudio({ studioId: "bbbbbbbb-2222", label: "Forest Annex", connId: 2 }, clk.now());

  // "fore" ci-substring matches both => AMBIGUOUS.
  const amb = reg.resolveStudioRef("fore");
  assert.equal(amb.code, "AMBIGUOUS_TARGET");
  // exact id wins even though it could be read as a label substring of nothing.
  const byId = reg.resolveStudioRef("aaaaaaaa-1111");
  assert.equal(byId.ok, true);
  assert.equal(byId.studioId, "aaaaaaaa-1111");
  // exact (case-sensitive) label is unique => resolves.
  const exact = reg.resolveStudioRef("Forest Annex");
  assert.equal(exact.studioId, "bbbbbbbb-2222");
  // no match => UNKNOWN with candidate list.
  const unk = reg.resolveStudioRef("Desert");
  assert.equal(unk.code, "UNKNOWN_TARGET");
});

test("soft claim is advisory; 2nd soft claimant gets warning CLAIM_HELD", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertStudio({ studioId: "stud-1", label: "Game", connId: 1 }, clk.now());

  const c1 = reg.acquireClaim("sess-1", "stud-1", { mode: "soft", label: "A" }, clk.now());
  assert.equal(c1.ok, true);
  assert.equal(c1.claim.mode, "soft");
  assert.equal(c1.warning, undefined);

  const c2 = reg.acquireClaim("sess-2", "stud-1", { mode: "soft", label: "B" }, clk.now());
  assert.equal(c2.ok, true);
  assert.equal(c2.warning, "CLAIM_HELD");

  // enqueueGate never blocks under a soft claim, even for a different session.
  assert.equal(reg.enqueueGate("sess-2", "stud-1", clk.now()).ok, true);
});

test("exclusive claim: enqueueGate rejects a different session with STUDIO_LOCKED", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertStudio({ studioId: "stud-1", label: "Game", connId: 1 }, clk.now());

  const c1 = reg.acquireClaim("sess-1", "stud-1", { mode: "exclusive", ttlMs: 60_000 }, clk.now());
  assert.equal(c1.ok, true);
  // Owner passes the gate.
  assert.equal(reg.enqueueGate("sess-1", "stud-1", clk.now()).ok, true);
  // Other session is blocked.
  const blocked = reg.enqueueGate("sess-2", "stud-1", clk.now());
  assert.equal(blocked.code, "STUDIO_LOCKED");
  assert.equal(blocked.heldBy, "sess-1");
  // Racing acquire by a 2nd session is rejected too.
  const c2 = reg.acquireClaim("sess-2", "stud-1", { mode: "exclusive" }, clk.now());
  assert.equal(c2.code, "STUDIO_LOCKED");
});

test("claim TTL expires lazily on read; a crashed holder never wedges a studio", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  reg.acquireClaim("sess-1", "stud-1", { mode: "exclusive", ttlMs: 5_000 }, clk.now());

  assert.ok(reg.getActiveClaim("stud-1", clk.now())); // live now
  clk.t += 5_001;                                      // TTL elapses
  assert.equal(reg.getActiveClaim("stud-1", clk.now()), null); // lazily expired
  // Gate now open; a NEW session can claim.
  assert.equal(reg.enqueueGate("sess-2", "stud-1", clk.now()).ok, true);
  const c2 = reg.acquireClaim("sess-2", "stud-1", { mode: "exclusive" }, clk.now());
  assert.equal(c2.ok, true);

  // ttl is clamped to [5_000, 600_000].
  const clamped = reg.acquireClaim("sess-2", "stud-1", { mode: "soft", ttlMs: 999_999 }, clk.now());
  assert.equal(clamped.claim.ttlMs, 600_000);
});

test("rekeyStudio atomically moves queue, pair, contested, and label to the real id", () => {
  const clk = makeClock();
  let built = 0;
  const reg = createRegistry({ now: clk.now, queueFactory: () => ({ qid: ++built, pending: [] }) });
  // legacy studio with a pair and a queued command
  const st = reg.upsertStudio({ studioId: "legacy:default", label: "Studio (legacy)", connId: 1, legacy: true }, clk.now());
  st.queue.pending.push({ id: "cmd-1" });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.pair("sess-1", "legacy:default", clk.now());

  const r = reg.rekeyStudio("legacy:default", "aaaaaaaa-bbbb-cccc", clk.now());
  assert.equal(r.ok, true);
  assert.equal(reg.getStudio("legacy:default"), null, "old key removed");
  const real = reg.getStudio("aaaaaaaa-bbbb-cccc");
  assert.ok(real, "real key present");
  assert.equal(real.legacy, false);
  assert.equal(real.queue.pending[0].id, "cmd-1", "same queue object moved (command preserved)");
  assert.equal(real.pairedSessionId, "sess-1", "pair moved");
  assert.equal(reg.getSession("sess-1").pairedStudioId, "aaaaaaaa-bbbb-cccc", "session's cache re-pointed");
});

test("tick drops a stale studio but NOT one with an in-flight command; unpairs on drop", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  reg.pair("sess-1", "stud-1", clk.now());

  // advance past STUDIO_DROP_MS but pretend a command is in flight -> NOT dropped.
  clk.t += DEFAULT_THRESHOLDS.STUDIO_DROP_MS + 1;
  let out = reg.tick(clk.now(), { hasInFlight: (id) => id === "stud-1" });
  assert.deepEqual(out.droppedStudios, [], "in-flight studio is never dropped");
  assert.ok(reg.getStudio("stud-1"), "studio still present");
  assert.equal(reg.getSession("sess-1").pairedStudioId, "stud-1", "pair survives");

  // now no in-flight -> it drops and the pair dissolves.
  out = reg.tick(clk.now(), { hasInFlight: () => false });
  assert.deepEqual(out.droppedStudios, ["stud-1"]);
  assert.equal(reg.getStudio("stud-1"), null, "dropped");
  assert.equal(reg.getSession("sess-1").pairedStudioId, null, "session unpaired on drop");
});

// ── C6: requireExplicitPair option ──
test("requireExplicitPair:true prevents auto-1:1; default false still auto-pairs", () => {
  const clk = makeClock();

  // With requireExplicitPair:true — lone 1×1 must NOT auto-pair.
  const regExplicit = createRegistry({ now: clk.now, requireExplicitPair: true });
  regExplicit.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  regExplicit.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  assert.equal(regExplicit.maybeAutoPair(clk.now()), null,
    "requireExplicitPair:true must suppress auto-pair even for clean 1×1");

  // Default (requireExplicitPair:false) — lone 1×1 auto-pairs normally.
  const regAuto = createRegistry({ now: clk.now, requireExplicitPair: false });
  regAuto.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  regAuto.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  const p = regAuto.maybeAutoPair(clk.now());
  assert.ok(p, "default registry still auto-pairs 1×1");
  assert.equal(p.origin, "auto");
});

test("pairStudioToSession binds studio→session (origin 'studio') and switches", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertSession({ sessionId: "sess-2", pid: 2 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", label: "Win1", connId: 1 }, clk.now());

  const r = reg.pairStudioToSession("stud-1", "sess-1", clk.now());
  assert.equal(r.ok, true);
  assert.equal(r.pair.origin, "studio");
  assert.equal(r.pair.sessionId, "sess-1");
  assert.equal(r.pair.studioId, "stud-1");
  assert.equal(reg.getStudio("stud-1").pairedSessionId, "sess-1");
  assert.equal(reg.getSession("sess-1").pairedStudioId, "stud-1");

  // Switch this window to sess-2 → sess-1 is detached on the studio side.
  const r2 = reg.pairStudioToSession("stud-1", "sess-2", clk.now());
  assert.equal(r2.ok, true);
  assert.equal(reg.getStudio("stud-1").pairedSessionId, "sess-2");
  assert.equal(reg.getSession("sess-2").pairedStudioId, "stud-1");
  assert.equal(reg.getSession("sess-1").pairedStudioId, null);
});

test("pairStudioToSession steals a session held by another studio; reports detached_from", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-2", connId: 2 }, clk.now());
  reg.pairStudioToSession("stud-1", "sess-1", clk.now());

  const r = reg.pairStudioToSession("stud-2", "sess-1", clk.now()); // steal
  assert.equal(r.ok, true);
  assert.equal(r.detached_from, "stud-1"); // session sess-1's prior studio
  assert.equal(reg.getStudio("stud-2").pairedSessionId, "sess-1");
  assert.equal(reg.getStudio("stud-1").pairedSessionId, null);
  assert.equal(reg.getSession("sess-1").pairedStudioId, "stud-2");
});

test("pairStudioToSession errors on unknown studio / session", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  assert.equal(reg.pairStudioToSession("ghost", "sess-1", clk.now()).code, "UNKNOWN_TARGET");
  assert.equal(reg.pairStudioToSession("stud-1", "ghost", clk.now()).code, "UNKNOWN_SESSION");
});

test("unpairStudio drops the studio's pairing on both sides", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  reg.pairStudioToSession("stud-1", "sess-1", clk.now());

  const u = reg.unpairStudio("stud-1", clk.now());
  assert.equal(u.detached, true);
  assert.equal(u.former_session_id, "sess-1");
  assert.equal(reg.getStudio("stud-1").pairedSessionId, null);
  assert.equal(reg.getSession("sess-1").pairedStudioId, null);

  const u2 = reg.unpairStudio("stud-1", clk.now()); // idempotent
  assert.equal(u2.detached, false);
  assert.equal(u2.former_session_id, null);
});
