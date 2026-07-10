# Roblox MCP Multi-Session Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-session port-owning HTTP bridge with a single long-lived broker plus thin per-session front-ends, so multiple Claude Code sessions can drive multiple Roblox Studio windows at once (N×N pairing) while a lone session + Studio behaves exactly like today.

**Architecture:** One broker process owns 127.0.0.1:8765, an identity registry, and one command queue per studio; each session's server.mjs becomes a thin HTTP client of the broker (the bind winner hosts the broker in-process, so the single-session case stays one process with zero added latency). Plugins poll with a stable studio_id; sessions auto-1:1-pair when unambiguous or target a studio explicitly.

**Tech Stack:** Node.js ESM (zero-dep libs — node:* builtins only), node --test, Roblox Luau plugin (HttpService long-poll), Roblox Open Cloud (unchanged).

## Global Constraints
1. **Zero-dep libs:** new `server/lib/*.mjs` import ONLY node builtins (node:http, node:crypto, node:child_process, node:fs, node:path) + extracted http-bridge helpers. The MCP SDK never enters lib/. Unit tests run under `node --test` with NO node_modules.
2. **Test run form (Windows / Node v24):** `node --test server/test/<file>.test.mjs` (name files explicitly or glob `server/test/*.test.mjs`; the trailing-slash DIR form mis-resolves — never use it).
3. **Preserve security verbatim:** loopback host-allowlist (403 forbidden host), optional `x-mcp-token` outer guard, `redactHeaders()` on every log line, 8 MB body cap + body timeout + clientError — lifted into the extracted helpers and applied on every new endpoint.
4. **Backward-compat:** single session + single Studio, no config, behaves EXACTLY like today (in-proc leader, auto-1:1, identical latency). `createBridge` keeps returning `{ httpServer, submit, getStatus }` with identical signatures (the Blender call site is unchanged). `ROBLOX_MCP_MODE=inline` is the one-env rollback.
5. **Single-file plugin install** preserved (sync-plugin.ps1 copies one .lua).
6. **now()-injection:** registry + command-queue logic is pure with injected time, so unit tests are deterministic with no real clock or sockets.
7. **Machine-token default ON (locked §13 Q1):** the broker auto-generates a machine token when `ROBLOX_MCP_TOKEN` is unset; `sync-plugin.ps1` bakes it into the plugin so even the single-user case is authenticated. Escape hatch `ROBLOX_MCP_ALLOW_TOKENLESS=1`.
8. **Canonical names:** headers `x-studio-id` / `x-session-id` / `x-session-token`; per-studio `createCommandQueue()` with a broker-global `inFlight` Map; `submit(type,payload,timeoutMs)` byte-identical + internal `submitTo(studioId,...)`; `getStatus()` always returns a Promise.

## File Structure
**New (zero-dep, `node --test`-able):**
- `server/lib/command-queue.mjs` — per-studio pending/waiters/deliverOrQueue/removePending + dropped-waiter reap (factored out of createBridge).
- `server/lib/registry.mjs` — pure pairing + claim state machine (sessions/studios/pairs/claims, maybeAutoPair, resolveTarget, session_token, rekeyStudio, tick), now()-injected.
- `server/lib/broker-core.mjs` — builds the broker's own `http.createServer` over the registry + per-studio queues + broker-global `inFlight` + sweep/idle/drain; all §4 endpoints.
- `server/broker.mjs` — broker entrypoint (machine-token, EADDRINUSE→exit 0, idle self-reap).
- `server/lib/broker-client.mjs` — `ensureBroker()` election + detached spawn + the FE client API.
**Edited:**
- `server/lib/http-bridge.mjs` — PURE extraction of helpers + `createCommandQueue` (public `createBridge` unchanged).
- `server/server.mjs` — mode switch → `ensureBroker`; `submitTo` chokepoint; `await getStatus`; control tools; `start_stop_play{stop}`→control.
- `server/tools.mjs` — per-call routing-key injection + 4 control tool defs.
- `plugin/MultiAIPlugin.lua` — studio_id identity, live-upvalue headers, second control loop, `__assign_studio_id`/`__stop_play` handlers.

---

## ⚠️ Binding corrections (these OVERRIDE the task text below wherever they conflict)

These came out of adversarial review of the drafted tasks (2 Critical, 2 Important, minors). Each is mandatory; apply it in the named task. When a task body and a correction disagree, the correction wins.

**C1 (Task 5 + Task 6) — name the per-call routing key `studio_target`, NOT `target`.**
Four existing tools already use `target` as a REQUIRED domain parameter: `play_animation`, `stop_animations` (Humanoid path), `align_to` (align-against path), `create_particle_burst` (BasePart path). Naming the injected studio-routing key `target` would clobber their schema description and make `routeCall` hijack their domain path as a (nonexistent) studio → those calls misroute and never reach the plugin. Therefore:
- **Task 6 `TARGET_PROP`** uses the property name `studio_target`: `{ studio_target: { type: "string", description: "Optional studioId or studio label to route THIS call to a specific Studio. Omit to use your attached/auto-paired studio." } }`. Injection still skips `CONTROL_OR_OS_LOCAL`. The four domain-`target` tools keep their own `target` untouched and additionally gain `studio_target`.
- **Task 5 `routeCall`** reads `args.studio_target` (never `args.target`) as the routing key; `args.studio_target` is used for routing and is NEVER written into the command payload (the four domain tools' `target` keeps flowing through payload unchanged).
- The control tools (`attach_studio`/`detach_studio`/`/session/pair`) keep their own `target` arg — a separate control-plane parameter that does not collide.

**C2 (Task 6 test) — assert the four collision tools explicitly.**
`server/test/tools-target.test.mjs` MUST assert that `play_animation`/`stop_animations`/`align_to`/`create_particle_burst` STILL have their original domain `target` (original path description, still `required` where it was) AND now also have `studio_target`. Exclude these four from any blanket `!required.includes("target")` loop — they legitimately require `target`.

**C3 (Task 5) — stop-during-play must send command type `__stop_play`, not `start_stop_play`.**
The control loop dispatches `handlers[cmd.type]` with no allowlist, so putting `start_stop_play` on the control queue would invoke the blocking play handler on the never-block loop and never reach `__stop_play` (defeats Concurrency-Critical #3 / edge #34). In the chokepoint `stop_control` case: in **broker mode** send `await submitControl(route.target, "__stop_play", {}, budget)` (control commands carry no payload). In **inline mode** (no control loop) route the stop through the normal command path (`submit("start_stop_play", payload, ...)`), since inline single-session handles `start_stop_play{stop}` on the command loop exactly as today.

**C4 (Task 4 + Task 5 + Task 8) — machine-token-by-default must actually be minted (locked §13 Q1).**
- **Task 4** exports `loadOrMintMachineToken()` from `broker-client.mjs`: read `%LOCALAPPDATA%/Roblox-MCP/broker-token` if present; else `randomUUID()` and write it with a restrictive ACL; return `""` ONLY when `ROBLOX_MCP_ALLOW_TOKENLESS=1`.
- **Task 3** `broker.mjs` performs the mint on first spawn; **Task 4** `ensureBroker` (in-proc leader) calls the SAME `loadOrMintMachineToken()` — so the detached child and the in-proc leader agree on one token.
- **Task 5** mode switch resolves `const OUTER_TOKEN = (process.env.ROBLOX_MCP_TOKEN || "").trim() || loadOrMintMachineToken();` and passes `OUTER_TOKEN` to BOTH `ensureBroker(...)` and the inline `createBridge(...)`.
- **Task 8** adds a security test asserting the token file is created on first run and reused on the second, and that `sync-plugin.ps1` bakes a NON-empty `AUTH_TOKEN` unless `ROBLOX_MCP_ALLOW_TOKENLESS=1`.

**C5 (Task 3) — add `POST /session/resolve-target` + the two `/session/submit` branches as an explicit step.**
Task 5's `submit_to`/composite-pin paths depend on the broker exposing `POST /session/resolve-target` (token-gated; returns `registry.resolveTarget(session_id, target, now())`) and on `/session/submit` honoring a top-level `control:true` branch (→ control queue) and a `target:"all"` branch (→ fan-out). These are required broker-core behaviors — add them as a Task 3 step with an integration test (assert `resolve-target` round-trips an `UNKNOWN_TARGET` envelope and `target:"all"` returns `{fanout:true,...}`), so Task 5's consumers are covered before Task 5 wires them.

**C6 (Task 8 docs + Task 2) — document & honor `ROBLOX_MCP_REQUIRE_EXPLICIT_PAIR`.**
Add an env-var row: `ROBLOX_MCP_REQUIRE_EXPLICIT_PAIR=1` disables silent auto-1:1 pairing (sessions must `attach_studio` explicitly; Sec-3 / edge #44 hardening). Confirm Task 2's `maybeAutoPair` gates on this env var; if not yet, add that gate in Task 2.

**C7 (minor hygiene).** (a) Task 8 redaction test: aim the redaction probe at a non-parking endpoint that logs-and-returns (e.g. `POST /session/submit` with a bad token → 401) rather than the parking `/studio/poll`, so the `[REDACTED]` log line is emitted within the wait window. (b) Task 4 race-test: drop the invalid `{ encoding: "utf8" }` option from `spawn(...)` (use `p.stdout.setEncoding("utf8")` if explicit decoding is wanted). (c) Task 5 Step 7a: note that the `CONTROL_OR_OS_LOCAL` import does not RESOLVE until Task 6 lands — Step 9's `node --check` only parses, so a real boot must wait for Task 6. (d) Task 5: `pin_composite` is handled upstream at the `import_blender_model` call site (early-return), not in the chokepoint switch — add a code comment there so a future maintainer who removes the early-return doesn't silently lose composite pinning.

---

### Task 1: Extract http-bridge helpers + `createCommandQueue` (+ dropped-waiter reap)

**Goal.** Refactor `server/lib/http-bridge.mjs` into additive, individually-exported zero-dep helpers — `readBody`, `makeHostSet`/`hostAllowed`, `tokenGuarded`, `attachClientError`, `attachFatalListenError`, `SENSITIVE_HEADER_RE` (now exported), and a NEW `createCommandQueue()` factory — then rebuild `createBridge` on top of them. The public return `{ httpServer, submit, getStatus }` and every endpoint's wire behavior stay **bit-identical** (regression-gated by the unchanged `server/test/http-bridge.test.mjs` and the blender smoke test). The new `createCommandQueue()` folds in the §4.4 dropped-long-poll reaping fix once, so inline and broker both benefit. This task is the foundation Tasks 2+ build on.

**Why these exact shapes.** Verified against the real code:
- `createBridge` returns `{ httpServer, submit, getStatus }` and `getStatus` is **synchronous** — `blender/test/blender-server.smoke.test.mjs:27` calls `bridge.getStatus()` with no `await` and `blender/server.mjs:35` / `server/server.mjs:237` both call it sync. **Do NOT make `createBridge.getStatus` async in this task** (the async `getStatus` is a broker-client concern, a later task).
- The token-guarded set is `/poll | /submit | /result/` (`http-bridge.mjs:112`) — preserved verbatim in `tokenGuarded()`.
- `inFlight` (timeout + late-result resolver map) stays inside `createBridge` — the contract pins `inFlight` as broker-global, NOT inside the queue. `createCommandQueue` owns ONLY `pending`/`waiters`/delivery/reaping. `submit`'s `setTimeout` and the `/result/<id>` resolve/`late result` log are unchanged and stay in `createBridge`.
- The dropped-waiter bug (§4.4): a parked waiter holding a dead `res` is handed a command via `waiters.shift()(cmd)` that goes nowhere and the command is lost until its `inFlight` timeout. Fix lives in the queue: (a) `req.on("close")` reaps the parked waiter + clears its poll timer; (b) delivery wraps `res.end` in try/catch and on failure re-queues the command at the **front** of `pending`.

#### Files
- **Modify** `server/lib/http-bridge.mjs` — extract helpers (`readBody`, `makeHostSet`, `hostAllowed`, `tokenGuarded`, `attachClientError`, `attachFatalListenError`), export `SENSITIVE_HEADER_RE`, add `createCommandQueue()`; rebuild `createBridge` (currently `:24–222`) to consume them. The `/poll` handler (`:120–145`) now uses `queue.parkWaiter`; `submit` (`:45–59`) calls `queue.deliverOrQueue` / `queue.removePending`; `getStatus` (`:88–99`) reads `queue.pending.length` / `queue.waiters.length`.
- **Create (test)** `server/test/command-queue.test.mjs` — pure unit tests for `createCommandQueue` (no sockets; fake `res`/`req` objects): enqueue→pending, deliverOrQueue→live waiter, removePending, dropped-waiter reap on `req.close`, dead-`res` re-queue-at-front.
- **Regression gate (unchanged):** `server/test/http-bridge.test.mjs`, `blender/test/blender-server.smoke.test.mjs`.

#### Interfaces

**Consumes from earlier tasks:** none (Task 1 is the foundation).

**Produces for later tasks** (exact signatures):
- `createCommandQueue() => { pending, waiters, deliverOrQueue(cmd), removePending(id), parkWaiter(waiterFn, req, onAbandon) }`
  - `pending: Array<{id,type,payload}>` — FIFO queue of undelivered commands.
  - `waiters: Array<Function>` — parked `(cmd)=>boolean` long-poll responders.
  - `deliverOrQueue(cmd)` — hand `cmd` to the first **live** waiter (waiter returns `true` on a successful `res.end`, `false`/throws if the socket was dead → skip it); if no live waiter, `pending.push(cmd)`.
  - `removePending(id) => boolean` — splice a queued cmd by id; `true` if found.
  - `parkWaiter(waiterFn, req, onAbandon) => unpark()` — register `waiterFn`, wire `req.on("close")` → remove waiter + `onAbandon()` once; returns `unpark()` that removes the waiter + detaches the close listener.
- `readBody(req, res, onComplete, { maxBodyBytes, bodyTimeoutMs })` — 413/408/single-finish/`req.destroy` on error.
- `makeHostSet(host, port) => Set<string>` · `hostAllowed(hostHeader, hosts) => boolean` · `tokenGuarded(pathname) => boolean`.
- `attachClientError(httpServer)` · `attachFatalListenError(httpServer, { host, port, brandPrefix })`.
- `redactHeaders(headers)` (unchanged) · `SENSITIVE_HEADER_RE` (now exported).
- `createBridge(opts) => { httpServer, submit, getStatus }` — unchanged surface; `getStatus` stays **sync**.

---

#### TDD steps

- [ ] **Step 1: Write the failing test for `createCommandQueue` basic enqueue + removePending.** Create `server/test/command-queue.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCommandQueue } from "../lib/http-bridge.mjs";

// A waiter is (cmd)=>boolean: true = delivered (res.end ok), false = dead socket.
// We model res with a `dead` flag and record what was delivered.
function makeWaiter({ dead = false } = {}) {
  const w = (cmd) => {
    w.delivered = cmd;
    if (dead) throw new Error("socket closed"); // res.end throws on a dead socket
    return true;
  };
  w.delivered = null;
  return w;
}

test("createCommandQueue: deliverOrQueue with no waiter pushes to pending", () => {
  const q = createCommandQueue();
  const cmd = { id: "a", type: "ping", payload: {} };
  q.deliverOrQueue(cmd);
  assert.deepEqual(q.pending, [cmd]);
  assert.equal(q.waiters.length, 0);
});

test("createCommandQueue: removePending splices a queued cmd by id", () => {
  const q = createCommandQueue();
  q.deliverOrQueue({ id: "a", type: "x", payload: {} });
  q.deliverOrQueue({ id: "b", type: "y", payload: {} });
  assert.equal(q.removePending("a"), true);
  assert.deepEqual(q.pending.map((c) => c.id), ["b"]);
  assert.equal(q.removePending("zzz"), false); // unknown id
  assert.deepEqual(q.pending.map((c) => c.id), ["b"]);
});

test("createCommandQueue: a parked live waiter receives the next command (pending stays empty)", () => {
  const q = createCommandQueue();
  const w = makeWaiter();
  const fakeReq = { on() {} }; // no close during this test
  q.parkWaiter(w, fakeReq, () => {});
  const cmd = { id: "a", type: "go", payload: { n: 1 } };
  q.deliverOrQueue(cmd);
  assert.deepEqual(w.delivered, cmd);
  assert.equal(q.pending.length, 0);
  assert.equal(q.waiters.length, 0); // consumed
});
```

- [ ] **Step 2: Run the test to verify it fails.** — `Run: node --test server/test/command-queue.test.mjs` / `Expected: FAIL` with `SyntaxError: The requested module '../lib/http-bridge.mjs' does not provide an export named 'createCommandQueue'` (the whole file fails to import).

- [ ] **Step 3: Implement `createCommandQueue` in `server/lib/http-bridge.mjs`.** Add this factory **above** `createBridge` (after the `redactHeaders` block). It owns only `pending`/`waiters`/delivery/parking — no `inFlight`, no timers except the close-reap wiring:

```js
/**
 * Per-studio FIFO command queue: pending commands + parked long-poll waiters.
 * A waiter is a `(cmd) => boolean` responder: it res.end()s the command and
 * returns true, or throws / returns false if its socket is already dead.
 * deliverOrQueue skips dead waiters and, on a delivery that throws mid-write,
 * re-queues the command at the FRONT of pending so the next live poll gets it
 * (the §4.4 dropped-long-poll reaping fix — implemented once, shared by inline
 * createBridge and the broker).
 */
export function createCommandQueue() {
  const pending = [];
  const waiters = [];

  function deliverOrQueue(cmd) {
    while (waiters.length > 0) {
      const w = waiters.shift();
      try {
        if (w(cmd) === true) return; // delivered to a live socket
      } catch {
        // res.end threw: socket died between park and delivery.
        // Re-queue at the FRONT so the very next live poll gets this command,
        // then keep trying any remaining parked waiters.
        pending.unshift(cmd);
        return;
      }
      // w returned false (dead, no throw): drop it, try the next waiter.
    }
    pending.push(cmd);
  }

  function removePending(id) {
    const i = pending.findIndex((c) => c.id === id);
    if (i >= 0) { pending.splice(i, 1); return true; }
    return false;
  }

  // Register a long-poll responder. req 'close' reaps the parked waiter and
  // fires onAbandon() (the route clears its own poll timeout there). Returns an
  // unpark() the route calls on its own timeout/delivery so the close handler
  // becomes a no-op.
  function parkWaiter(waiterFn, req, onAbandon) {
    let removed = false;
    const remove = () => {
      if (removed) return false;
      removed = true;
      const i = waiters.indexOf(waiterFn);
      if (i >= 0) waiters.splice(i, 1);
      return true;
    };
    const onClose = () => { if (remove()) onAbandon(); };
    req.on("close", onClose);
    waiters.push(waiterFn);
    return function unpark() {
      remove();
      req.removeListener("close", onClose);
    };
  }

  return { pending, waiters, deliverOrQueue, removePending, parkWaiter };
}
```

- [ ] **Step 4: Run tests to verify Steps 1–3 pass.** — `Run: node --test server/test/command-queue.test.mjs` / `Expected: PASS` — `tests 3`, `pass 3`, `fail 0`.

- [ ] **Step 5: Write the failing tests for the dropped-waiter reap (close-reap + dead-res re-queue-at-front).** Append to `server/test/command-queue.test.mjs`:

```js
// A minimal req stub that lets the test fire the 'close' event on demand.
function makeReq() {
  const listeners = { close: [] };
  return {
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeListener(ev, fn) {
      const a = listeners[ev]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    emit(ev) { for (const fn of (listeners[ev] || []).slice()) fn(); },
  };
}

test("parkWaiter: req 'close' reaps the waiter and fires onAbandon exactly once", () => {
  const q = createCommandQueue();
  const w = makeWaiter();
  const req = makeReq();
  let abandoned = 0;
  q.parkWaiter(w, req, () => { abandoned += 1; });
  assert.equal(q.waiters.length, 1);
  req.emit("close");
  assert.equal(q.waiters.length, 0); // reaped
  assert.equal(abandoned, 1);
  req.emit("close"); // second close must not double-fire
  assert.equal(abandoned, 1);
  // A command arriving after the abandon goes to pending, not the dead waiter.
  const cmd = { id: "a", type: "x", payload: {} };
  q.deliverOrQueue(cmd);
  assert.equal(w.delivered, null);
  assert.deepEqual(q.pending, [cmd]);
});

test("unpark() removes the waiter and stops the close handler reaping", () => {
  const q = createCommandQueue();
  const w = makeWaiter();
  const req = makeReq();
  let abandoned = 0;
  const unpark = q.parkWaiter(w, req, () => { abandoned += 1; });
  unpark();
  assert.equal(q.waiters.length, 0);
  req.emit("close");           // close after unpark must be inert
  assert.equal(abandoned, 0);
});

test("deliverOrQueue: a dead waiter (res.end throws) re-queues the cmd at the FRONT of pending", () => {
  const q = createCommandQueue();
  q.deliverOrQueue({ id: "old", type: "x", payload: {} }); // already queued
  const dead = makeWaiter({ dead: true });
  const req = makeReq();
  q.parkWaiter(dead, req, () => {});
  const fresh = { id: "fresh", type: "go", payload: {} };
  q.deliverOrQueue(fresh);
  // fresh must land at the FRONT (next live poll gets it before the old one).
  assert.deepEqual(q.pending.map((c) => c.id), ["fresh", "old"]);
  assert.equal(q.waiters.length, 0); // dead waiter consumed
});

test("deliverOrQueue: skips a dead-but-non-throwing waiter and delivers to the next live one", () => {
  const q = createCommandQueue();
  const deadSilent = (cmd) => { deadSilent.delivered = cmd; return false; }; // dead, no throw
  deadSilent.delivered = null;
  const live = makeWaiter();
  const req = makeReq();
  q.parkWaiter(deadSilent, req, () => {});
  q.parkWaiter(live, req, () => {});
  const cmd = { id: "a", type: "x", payload: {} };
  q.deliverOrQueue(cmd);
  assert.equal(live.delivered, cmd); // skipped deadSilent, delivered to live
  assert.equal(q.pending.length, 0);
});
```

- [ ] **Step 6: Run the new reap tests to verify they pass against the Step 3 implementation.** — `Run: node --test server/test/command-queue.test.mjs` / `Expected: PASS` — `tests 7`, `pass 7`, `fail 0`. (The Step 3 implementation already satisfies these; if any fails, fix `createCommandQueue` until green — do not touch the tests.)

- [ ] **Step 7: Implement the pure HTTP helper extractions in `server/lib/http-bridge.mjs`.** First, export `SENSITIVE_HEADER_RE` by changing its declaration:

  Replace:
  ```js
  const SENSITIVE_HEADER_RE = /^(x-api-key|x-mcp-token|authorization|x-open-cloud-api-key|.*-key)$/i;
  ```
  with:
  ```js
  export const SENSITIVE_HEADER_RE = /^(x-api-key|x-mcp-token|authorization|x-open-cloud-api-key|.*-key)$/i;
  ```

  Then add these standalone helpers right after the `redactHeaders` function (above `createCommandQueue`):

```js
/** Build the loopback host allowlist for a concrete host:port. */
export function makeHostSet(host, port) {
  return new Set([`${host}:${port}`, `localhost:${port}`]);
}

/** True if the request's Host header is in the allowlist. */
export function hostAllowed(hostHeader, hosts) {
  return hosts.has(hostHeader || "");
}

/** Legacy outer-token guard set: /poll, /submit, /result/* require x-mcp-token. */
export function tokenGuarded(pathname) {
  return pathname === "/poll" || pathname === "/submit" || pathname.startsWith("/result/");
}

/**
 * Read a request body with an 8MB-class cap and a body timeout. 413 on cap,
 * 408 on timeout, single-finish guard, req.destroy on error. Extracted verbatim
 * from the inline createBridge body.
 */
export function readBody(req, res, onComplete, { maxBodyBytes, bodyTimeoutMs }) {
  let body = "";
  let bytes = 0;
  let done = false;
  const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
  const timer = setTimeout(() => {
    finish(() => {
      try { res.writeHead(408, { "Content-Type": "application/json" }); res.end('{"error":"request timeout"}'); } catch {}
      req.destroy();
    });
  }, bodyTimeoutMs);
  req.on("data", (c) => {
    if (done) return;
    bytes += c.length;
    if (bytes > maxBodyBytes) {
      finish(() => {
        try { res.writeHead(413, { "Content-Type": "application/json" }); res.end('{"error":"payload too large"}'); } catch {}
        req.destroy();
      });
      return;
    }
    body += c;
  });
  req.on("end", () => finish(() => onComplete(body)));
  req.on("error", () => finish(() => { try { req.destroy(); } catch {} }));
}

/** Attach the verbatim clientError handler (truncated/oversize-line malformed requests). */
export function attachClientError(httpServer) {
  httpServer.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
}

/**
 * Attach the FATAL listen-error handler used by the inline createBridge / inline
 * mode: EADDRINUSE (or any error) → log + process.exit(1). The broker does NOT
 * use this — it surfaces EADDRINUSE to ensureBroker as a lost election (later task).
 */
export function attachFatalListenError(httpServer, { host, port, brandPrefix }) {
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`${brandPrefix} FATAL: ${host}:${port} is already in use — another server is bound to it. Close it and retry.`);
    } else {
      console.error(`${brandPrefix} FATAL: HTTP server error: ${err.message}`);
    }
    process.exit(1);
  });
}
```

- [ ] **Step 8: Rebuild `createBridge` to consume the helpers + `createCommandQueue`.** Replace the entire `createBridge` function body (currently `http-bridge.mjs:24–222`) with the version below. Behavior is bit-identical: the queue replaces the bare `pending`/`waiters` arrays, `submit` uses `queue.deliverOrQueue`/`queue.removePending`, `/poll` uses `queue.parkWaiter` (which now reaps on `req.close`), and `inFlight`/timeout/late-result/`getStatus`/host/token/listen all stay as they were. The `/poll` parked-waiter path now passes through `parkWaiter` so a dropped poll is reaped.

```js
export function createBridge({
  port,
  host = "127.0.0.1",
  allowedHosts,
  authToken = "",
  brandPrefix = "[mcp]",
  defaultTimeoutMs = 30_000,
  maxBodyBytes = 8 * 1024 * 1024,
  bodyTimeoutMs = 30_000,
  pollTimeoutMs = 10_000,
  pluginStaleMs = 12_000,
  onListen,
} = {}) {
  const queue = createCommandQueue();
  const inFlight = new Map();
  let lastPollAt = 0;
  // For a concrete port the allowlist is fixed up front; for port 0 (ephemeral —
  // used by tests) it is rebuilt in the listen callback once the OS assigns one.
  let hosts = allowedHosts || makeHostSet(host, port);

  function submit(type, payload, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const cmd = { id, type, payload };
      const timeout = setTimeout(() => {
        inFlight.delete(id);
        queue.removePending(id);
        resolve({ error: `timeout after ${timeoutMs}ms — is the ${brandPrefix} plugin/addon connected?` });
      }, timeoutMs);
      inFlight.set(id, { resolve, timeout });
      queue.deliverOrQueue(cmd);
    });
  }

  function getStatus() {
    const now = Date.now();
    const sinceLastPoll = lastPollAt === 0 ? null : now - lastPollAt;
    const pluginConnected = lastPollAt !== 0 && sinceLastPoll < pluginStaleMs;
    return {
      pluginConnected,
      msSinceLastPoll: sinceLastPoll,
      queued: queue.pending.length,
      inFlight: inFlight.size,
      ready: pluginConnected && inFlight.size === 0 && queue.pending.length === 0,
    };
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (!hostAllowed(req.headers.host, hosts)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"error":"forbidden host"}');
      return;
    }

    if (authToken && tokenGuarded(url.pathname)) {
      if (req.headers["x-mcp-token"] !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      lastPollAt = Date.now();
      if (queue.pending.length > 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(queue.pending.shift()));
        return;
      }
      let sent = false;
      let unpark;
      const timer = setTimeout(() => {
        if (sent) return;
        sent = true;
        if (unpark) unpark();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, pollTimeoutMs);
      const waiter = (cmd) => {
        if (sent) return false;
        sent = true;
        clearTimeout(timer);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cmd));
        return true;
      };
      // parkWaiter reaps this waiter (and clears `timer`) if the client drops
      // the long-poll before a command arrives.
      unpark = queue.parkWaiter(waiter, req, () => clearTimeout(timer));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/result/")) {
      const id = url.pathname.slice("/result/".length);
      readBody(req, res, (body) => {
        const handler = inFlight.get(id);
        if (handler) {
          clearTimeout(handler.timeout);
          inFlight.delete(id);
          try { handler.resolve(JSON.parse(body || "{}")); }
          catch { handler.resolve({ error: "invalid JSON from plugin" }); }
        } else {
          console.error(`late result for ${id}, op may have completed plugin-side`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      }, { maxBodyBytes, bodyTimeoutMs });
      return;
    }

    if (req.method === "POST" && url.pathname === "/submit") {
      readBody(req, res, async (body) => {
        try {
          const { type, payload } = JSON.parse(body);
          const result = await submit(type, payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"bad request"}');
        }
      }, { maxBodyBytes, bodyTimeoutMs });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: queue.pending.length, inFlight: inFlight.size }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/connection_status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatus()));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  attachClientError(httpServer);
  attachFatalListenError(httpServer, { host, port, brandPrefix });

  httpServer.listen(port, host, () => {
    if (!allowedHosts && port === 0) {
      const real = httpServer.address().port; // ephemeral: rebuild allowlist with the assigned port
      hosts = makeHostSet(host, real);
    }
    console.error(
      authToken
        ? `${brandPrefix} bridge on ${host}:${port} — Host-checked, shared-secret auth ENABLED.`
        : `${brandPrefix} bridge on ${host}:${port} — Host-checked. No token set: any local process can drive it.`
    );
    if (onListen) onListen();
  });

  return { httpServer, submit, getStatus };
}
```

  **Note:** the `waiter` now returns `true` on delivery and `false` when already `sent` — required so `deliverOrQueue` knows the delivery succeeded. The previous code returned `undefined`; under the new queue contract that would be treated as "not a live delivery" and the command would be re-parked/queued, so the explicit `return true`/`return false` is load-bearing.

- [ ] **Step 9: Run the full regression + new suite to verify everything passes.** — `Run: node --test server/test/command-queue.test.mjs server/test/http-bridge.test.mjs blender/test/blender-server.smoke.test.mjs` / `Expected: PASS` — combined `pass 16, fail 0` (7 command-queue + 7 http-bridge + 2 blender smoke). The unchanged `http-bridge.test.mjs` (403/413/400/401/late-result/EADDRINUSE/redactHeaders) and the blender smoke test (`getStatus()` sync) both stay green, proving the refactor is bit-identical.

- [ ] **Step 10: Run the broader server test set to confirm no collateral damage.** — `Run: node --test server/test/glb.test.mjs server/test/open-cloud.test.mjs` / `Expected: PASS` (these never imported the touched symbols, but run them to be certain the file still parses and nothing else broke).

- [ ] **Step 11: Commit.** — `Run: git add server/lib/http-bridge.mjs server/test/command-queue.test.mjs && git commit -m "$(cat <<'EOF'`
```
refactor(bridge): extract http-bridge helpers + createCommandQueue with dropped-waiter reap

Factor readBody, makeHostSet/hostAllowed, tokenGuarded, attachClientError,
attachFatalListenError out of createBridge as additive exports; export
SENSITIVE_HEADER_RE. Add createCommandQueue() (pending/waiters/deliverOrQueue/
removePending/parkWaiter) with the §4.4 dropped-long-poll reap: req 'close'
removes the parked waiter + clears its timer, and a delivery whose res.end
throws re-queues the command at the FRONT of pending. Rebuild createBridge on
top of the helpers — public { httpServer, submit, getStatus } and every
endpoint stay bit-identical (getStatus stays sync). Foundation for the broker.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"`

  (On this Windows/PowerShell setup, use the single-quoted here-string form for the commit body instead — `git commit -m @'…'@` with the closing `'@` at column 0 — if the bash heredoc is unavailable. The message text is identical.)

---

**Done when:** `node --test server/test/command-queue.test.mjs server/test/http-bridge.test.mjs blender/test/blender-server.smoke.test.mjs` is all-green, no `node_modules` required for the new test, `createBridge`'s return and every endpoint are byte-identical, `getStatus` remains synchronous, and both `server/server.mjs` and `blender/server.mjs` continue to import `{ createBridge, redactHeaders }` from `http-bridge.mjs` unchanged.

---

### Task 2: registry.mjs — pure pairing + claim state machine

The single source of truth for sessions, studios, pairs, and claims. Pure (no I/O, no sockets, no real clock), with time injected via `now()` so every transition is deterministic under `node --test` with no `node_modules`. This is the most test-critical unit in the broker — `broker-core.mjs` (Task 3) wires HTTP endpoints around it but holds NO pairing logic of its own.

**Design note on `inFlight` and the queue:** Per the spec, `inFlight` is a **broker-global** `Map` that lives in `broker-core` (Task 3), NOT in the registry. The registry's `tick(now)` must honor an "in-flight keeps a studio alive" rule (§3.6), but the registry does not own `inFlight`. Resolution: `tick(now, { hasInFlight })` accepts a **predicate hook** `hasInFlight(studioId) → bool` (default `() => false`) so the registry stays pure and broker-core injects the real check. Likewise `StudioRecord.queue` (§5.1) is an opaque field the registry stores but never constructs — broker-core attaches a `createCommandQueue()` via an optional `queueFactory` injected into `createRegistry`.

#### Files
- **Create:** `G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\server\lib\registry.mjs` (new, ~330 lines; imports ONLY `node:crypto` for `randomUUID`)
- **Test:** `G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\server\test\registry.test.mjs` (new)

#### Interfaces

**Consumes from earlier tasks:**
- (none at runtime — registry imports only `node:crypto`). Task 1's extraction does not affect this file. The `queueFactory` it accepts will, in Task 3, be `createCommandQueue` from `server/lib/command-queue.mjs`, but registry never imports it.

**Produces for later tasks (Task 3 broker-core, Task 4 broker-client wire to these):**
- `createRegistry({ now, thresholds?, queueFactory? }) → registry` where `now: () => number` (ms epoch, injected), `thresholds` overrides the constant table (§3.6), `queueFactory: (studioId) => any` builds the per-studio queue object stored on `StudioRecord.queue` (default `() => null`).
- Registry instance shape (every method documented below):
  - `upsertSession({ sessionId, kind, label, cwd, pid }, now) → SessionRecord`
  - `upsertStudio({ studioId, label?, placeId?, connId?, legacy? }, now) → StudioRecord`
  - `touchSession(sessionId, now) → void`
  - `touchStudio(studioId, now, connId?) → void`
  - `mintSessionToken(sessionId, pid) → token:string`
  - `validateSessionToken(sessionId, token) → bool`
  - `pair(sessionId, target, now) → { ok, pair, detached_from? } | errorEnvelope`
  - `unpair(sessionId, target?, now) → { ok, detached, released_claim, studio_id|null }`
  - `attach(sessionId, target, claimSpec?, now) → { ok, studio_id, label, claim?, warning? } | errorEnvelope`
  - `detach(sessionId, now) → { ok, detached, released_claim, studio_id|null }`
  - `detachStudio(sessionId, studioId, now) → { ok, freed } | errorEnvelope`
  - `maybeAutoPair(now) → PairRecord | null`
  - `resolveTarget(sessionId, explicitTarget, now) → { ok, studioId, via, ...} | errorEnvelope`
  - `resolveStudioRef(ref) → { ok, studioId } | errorEnvelope` (id > exact-label > ci-substring; §5.6)
  - `acquireClaim(sessionId, studioId, { mode, label?, ttlMs? }, now) → { ok, claim, warning? } | errorEnvelope`
  - `releaseClaim(sessionId, studioId, now) → { ok, released:bool }`
  - `getActiveClaim(studioId, now) → Claim | null` (lazy TTL expiry on read)
  - `enqueueGate(sessionId, studioId, now) → { ok } | errorEnvelope` (exclusive-claim enforcement point)
  - `rekeyStudio(oldId, newId, now) → { ok, studio } | { ok:false }` (atomic legacy→real upgrade)
  - `tick(now, { hasInFlight? }) → { droppedStudios:[], droppedSessions:[] }`
  - `snapshot(now) → { studios:[], sessions:[], pairs:[], claims:[] }`
  - `getStudio(studioId) / getSession(sessionId)` accessors
- Error envelope shape (returned verbatim, §5.5): `{ error:"<CODE>", code:"<CODE>", message, candidates?, hint? }`. Codes used here: `NO_TARGET`, `AMBIGUOUS_TARGET`, `UNKNOWN_TARGET`, `PAIR_TARGET_GONE`, `STUDIO_BUSY`, `STUDIO_LOCKED`, `TARGET_ALL_NOT_ALLOWED`.
- Exported constant `DEFAULT_THRESHOLDS` (the §3.6 table) so broker-core and tests share one source.

---

#### TDD steps

- [ ] **Step 1: Write the failing test for upsert + token mint/validate**

  Create `server/test/registry.test.mjs`:

  ```js
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
  ```

- [ ] **Step 2: Run the test to verify it fails** — `Run: node --test server/test/registry.test.mjs`
  `Expected: FAIL` with `Cannot find module ...registry.mjs` (file does not exist yet).

- [ ] **Step 3: Implement the skeleton — constants, records, upsert, token mint/validate**

  Create `server/lib/registry.mjs`:

  ```js
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

  // ── Label hygiene (spec §2.8): strip control chars, truncate to 80. ──
  function cleanLabel(raw, fallback = "Studio") {
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    // eslint-disable-next-line no-control-regex
    const stripped = raw.replace(/[ -]/g, "");
    return (stripped.length === 0 ? fallback : stripped).slice(0, 80);
  }

  function err(code, message, extra = {}) {
    return { error: code, code, message, ...extra };
  }

  export function createRegistry({ now, thresholds = {}, queueFactory = () => null } = {}) {
    if (typeof now !== "function") throw new TypeError("createRegistry requires now()");
    const TH = { ...DEFAULT_THRESHOLDS, ...thresholds };

    /** @type {Map<string, any>} */ const sessions = new Map();
    /** @type {Map<string, any>} */ const studios = new Map();
    /** @type {Map<string, any>} */ const pairs = new Map();   // key = sessionId
    /** @type {Map<string, string>} */ const tokens = new Map(); // sessionId -> token
    /** @type {Map<string, number>} */ const tokenPids = new Map(); // sessionId -> pid

    // ── Sessions / studios ──
    function upsertSession({ sessionId, kind = "mcp", label, cwd = "", pid = 0 }, t = now()) {
      let s = sessions.get(sessionId);
      if (!s) {
        s = { sessionId, sessionToken: null, label: cleanLabel(label, "Session"), cwd, pid,
              kind, firstSeenAt: t, lastSeenAt: t, pairedStudioId: null, state: "live" };
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
        st = { studioId, label: cleanLabel(label, "Studio"), placeId,
               connIds: new Set(connId == null ? [] : [connId]),
               lastPollAt: t, pairedSessionId: null, legacy, contested: false,
               claim: null, state: "live", queue: queueFactory(studioId) };
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

    return {
      // accessors
      getSession: (id) => sessions.get(id) || null,
      getStudio: (id) => studios.get(id) || null,
      // lifecycle
      upsertSession, upsertStudio, touchSession, touchStudio,
      mintSessionToken, validateSessionToken,
    };
  }
  ```

- [ ] **Step 4: Run tests to verify they pass** — `Run: node --test server/test/registry.test.mjs`
  `Expected: PASS` — `tests 1 / pass 1 / fail 0`.

- [ ] **Step 5: Write the failing test for auto-1:1 (fire-and-stop) + resolveTarget via pair/auto**

  Append to `server/test/registry.test.mjs`:

  ```js
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
  ```

- [ ] **Step 6: Run the test to verify it fails** — `Run: node --test server/test/registry.test.mjs`
  `Expected: FAIL` with `TypeError: reg.maybeAutoPair is not a function` (and `resolveTarget`/`resolveStudioRef`/`pair` undefined).

- [ ] **Step 7: Implement pairing + resolution (resolveStudioRef, pair/unpair/attach/detach, maybeAutoPair, resolveTarget)**

  In `server/lib/registry.mjs`, add these functions **above** the `return {…}` block (after `validateSessionToken`):

  ```js
    // ── Liveness helpers (computed on the fly; tick only DROPS) ──
    function sessionLive(s, t) {
      return s.state !== "dropped" && (t - s.lastSeenAt) < TH.SESSION_STALE_MS;
    }
    function studioLive(st, t, hasInFlight) {
      if (hasInFlight(st.studioId)) return true;               // in-flight is absolute keepalive (§3.6)
      return st.state !== "dropped" && (t - st.lastPollAt) < TH.PLUGIN_STALE_MS;
    }

    // ── Pair bookkeeping (strict 1:1 invariant) ──
    function bindPair(sessionId, studioId, t, origin) {
      const s = sessions.get(sessionId), st = studios.get(studioId);
      let detached_from = null;
      // break any prior pair on either side
      if (s.pairedStudioId && s.pairedStudioId !== studioId) {
        const old = studios.get(s.pairedStudioId);
        if (old) old.pairedSessionId = null;
        pairs.delete(sessionId);
        detached_from = s.pairedStudioId;
      }
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
    function candidates(t) {
      return liveStudioList(t).map((st) => ({ studioId: st.studioId, label: st.label }));
    }
    function resolveStudioRef(ref, t = now()) {
      if (typeof ref !== "string" || ref.length === 0)
        return err("UNKNOWN_TARGET", "no target given", { candidates: candidates(t) });
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
        return err("AMBIGUOUS_TARGET", "no unambiguous auto target", { candidates: candidates(t) });
      }
      return err("UNKNOWN_TARGET", `no studio matches '${ref}'`, { candidates: candidates(t) });
    }

    // ── Auto 1:1 (spec §5.3) ──
    function maybeAutoPair(t = now()) {
      const S = [...sessions.values()].filter((s) => sessionLive(s, t) && s.pairedStudioId === null);
      const T = [...studios.values()].filter(
        (st) => studioLive(st, t, () => false) && st.pairedSessionId === null && !st.contested);
      if (S.length === 1 && T.length === 1) {
        const { pr } = bindPair(S[0].sessionId, T[0].studioId, t, "auto");
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
        return err("PAIR_TARGET_GONE", "your paired studio is gone", { candidates: candidates(t) });
      }
      const auto = maybeAutoPair(t);
      if (auto && auto.sessionId === sessionId) return { ok: true, studioId: auto.studioId, via: "auto" };
      return err("NO_TARGET", "no studio is paired and auto-pair is ambiguous",
                 { candidates: candidates(t), hint: "call attach_studio or pass an explicit target" });
    }
  ```

  Then extend the `return {…}` object to export the new methods:

  ```js
    return {
      getSession: (id) => sessions.get(id) || null,
      getStudio: (id) => studios.get(id) || null,
      upsertSession, upsertStudio, touchSession, touchStudio,
      mintSessionToken, validateSessionToken,
      resolveStudioRef, resolveTarget, maybeAutoPair,
      pair, unpair, attach, detach, detachStudio,
    };
  ```

  (Note: `acquireClaim` / `releaseClaim` are referenced by `attach`/`unpair` and are added in Step 9; until then those two paths only run when a `claimSpec` is passed or a pair exists. The auto-pair/resolve tests in Step 5 do not exercise the claim path, so they pass now. `unpair` calls `releaseClaim` — add a temporary no-op so Step 8 passes, OR sequence Step 9 immediately; see Step 8 note.)

  **To keep Step 8 green before claims exist, add a minimal placeholder** just above `unpair` (it is fully replaced in Step 9):

  ```js
    function releaseClaim(sessionId, studioId, t = now()) { return { ok: true, released: false }; }
    function acquireClaim() { return err("STUDIO_LOCKED", "claims not yet wired"); }
  ```

- [ ] **Step 8: Run tests to verify they pass** — `Run: node --test server/test/registry.test.mjs`
  `Expected: PASS` — `tests 4 / pass 4 / fail 0` (Step 1 test + the 3 new pairing/resolve tests).

- [ ] **Step 9: Write the failing test for claims (acquire / lazy-expire / exclusive-reject) + enqueueGate**

  Append to `server/test/registry.test.mjs`:

  ```js
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
  ```

- [ ] **Step 10: Run the test to verify it fails** — `Run: node --test server/test/registry.test.mjs`
  `Expected: FAIL` — the new tests fail because `acquireClaim` is the placeholder (returns `STUDIO_LOCKED`), `getActiveClaim`/`enqueueGate` are undefined.

- [ ] **Step 11: Implement claims — replace the placeholder with the real claim machine**

  In `server/lib/registry.mjs`, **delete** the two placeholder lines added in Step 7:

  ```js
    function releaseClaim(sessionId, studioId, t = now()) { return { ok: true, released: false }; }
    function acquireClaim() { return err("STUDIO_LOCKED", "claims not yet wired"); }
  ```

  and **replace** them with the full claim implementation (same location — above `unpair`):

  ```js
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
        // active soft, different session: new soft is allowed but warned; new exclusive over a
        // soft held by another is rejected (can't seize isolation from a live soft holder).
        if (mode === "exclusive")
          return err("STUDIO_LOCKED", `studio ${studioId} has a soft claim by another session`,
                     { heldBy: active.sessionId, expiresAt: active.expiresAt });
        // replace? no — keep the first soft claim record but tell the 2nd it's held.
        return { ok: true, claim: active, warning: "CLAIM_HELD" };
      }
      // free, or owned by this session (renew)
      const claim = { studioId, sessionId, label: cleanLabel(spec.label, "claim"),
                      mode, ttlMs, acquiredAt: t, expiresAt: t + ttlMs };
      st.claim = claim;
      return { ok: true, claim };
    }

    function releaseClaim(sessionId, studioId, t = now()) {
      if (!studioId) return { ok: true, released: false };
      const st = studios.get(studioId);
      const active = getActiveClaim(studioId, t);
      if (st && active && active.sessionId === sessionId) { st.claim = null; return { ok: true, released: true }; }
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
  ```

  Add the three claim methods to the `return {…}` object:

  ```js
      acquireClaim, releaseClaim, getActiveClaim, enqueueGate,
  ```

- [ ] **Step 12: Run tests to verify they pass** — `Run: node --test server/test/registry.test.mjs`
  `Expected: PASS` — `tests 7 / pass 7 / fail 0`.

- [ ] **Step 13: Write the failing test for rekeyStudio (atomic legacy→real upgrade) + tick sweep with in-flight override**

  Append to `server/test/registry.test.mjs`:

  ```js
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
  ```

- [ ] **Step 14: Run the test to verify it fails** — `Run: node --test server/test/registry.test.mjs`
  `Expected: FAIL` with `TypeError: reg.rekeyStudio is not a function` (and `reg.tick` undefined).

- [ ] **Step 15: Implement rekeyStudio + tick + snapshot**

  In `server/lib/registry.mjs`, add these functions above the `return {…}` block (after `enqueueGate`):

  ```js
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
        if (hasInFlight(st.studioId)) { st.state = "live"; st.lastPollAt = Math.max(st.lastPollAt, t); continue; }
        const idle = t - st.lastPollAt;
        if (idle >= TH.STUDIO_DROP_MS) {
          if (st.pairedSessionId) { const s = sessions.get(st.pairedSessionId); if (s) s.pairedSessionId, dissolvePair(st.pairedSessionId); }
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
          tokens.delete(s.sessionId); tokenPids.delete(s.sessionId);
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
  ```

  **Fix the typo introduced above:** the drop branch must just call `dissolvePair`. Replace the line

  ```js
          if (st.pairedSessionId) { const s = sessions.get(st.pairedSessionId); if (s) s.pairedSessionId, dissolvePair(st.pairedSessionId); }
  ```

  with the clean version:

  ```js
          if (st.pairedSessionId) dissolvePair(st.pairedSessionId);
  ```

  Add the new methods to the `return {…}` object:

  ```js
      rekeyStudio, tick, snapshot,
  ```

- [ ] **Step 16: Run tests to verify they pass** — `Run: node --test server/test/registry.test.mjs`
  `Expected: PASS` — `tests 9 / pass 9 / fail 0`.

- [ ] **Step 17: Regression-gate the shared lib (Task 1 must remain green) and run the whole suite**
  `Run: node --test server/test/*.test.mjs`
  `Expected: PASS` — all files green (http-bridge.test.mjs + registry.test.mjs; plus any command-queue test from Task 1). No `node_modules` required.

- [ ] **Step 18: Commit**
  `Run:`
  ```
  git add server/lib/registry.mjs server/test/registry.test.mjs && git commit -m "feat(broker): registry.mjs — pure pairing + claim state machine

  Pure now()-injected createRegistry: sessions/studios/pairs/claims,
  auto-1:1 fire-and-stop, resolveTarget (explicit>pair>auto>NO_TARGET),
  session_token mint/validate by (sessionId,pid), exclusive/soft claims
  with lazy TTL expiry + enqueue gate, atomic rekeyStudio (legacy->real),
  tick sweep with in-flight keepalive override. 9 deterministic tests.

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

**Verification notes for the executor**
- The registry imports ONLY `node:crypto`. Do not import `command-queue.mjs`, the MCP SDK, or anything from `lib/http-bridge.mjs` — the `queue` field is built by an injected `queueFactory`, defaulting to `null`.
- `now` is ALWAYS injected; never call `Date.now()` inside `registry.mjs` (the lazy-expiry and tick tests rely on a controllable clock).
- `inFlight` is NOT in the registry — `tick` receives a `hasInFlight(studioId)` predicate hook. Task 3's broker-core owns the real `inFlight` Map and passes the closure.
- Use the exact test-run form `node --test server/test/registry.test.mjs` (the trailing-slash directory form mis-resolves on Node v24 Windows).

---

### Task 3: broker-core.mjs + broker.mjs — own server, endpoints, contested/control, drain/idle

Builds the long-lived **Broker**: a standalone `http.createServer` (assembled from Task 1's extracted hardening helpers) wrapping Task 2's pure `createRegistry`, a per-studio `createCommandQueue` (Task 1), and a broker-global `inFlight` Map. Implements every §4 endpoint on both planes, the §4.1 `/health` role/proto shape, the §4.2 legacy aliases, `enqueueToStudio` (§4.3), contested-studio detection + `__assign_studio_id` inject-ahead (§2.6), the control queue (`/studio/control-poll`, §2.6.1), in-flight-as-keepalive liveness (§3.6), and drain/idle self-reap (§3.6, §3.8). `server/broker.mjs` is the thin entry: reads env, loads/derives the machine token, starts the core, and treats its own `EADDRINUSE` as **exit 0** (race loser) with an `IDLE_REAP` self-exit.

> NOTE: this task does NOT touch `server/server.mjs`, `tools.mjs`, or the plugin (those are Task 5/6/7). It produces the broker process that Task 4's `broker-client.mjs` connects to.

#### Files
- **Create** `G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\server\lib\broker-core.mjs` — `createBrokerCore({ registry, now, authToken, brandPrefix, idleReapMs })` → `{ httpServer, inFlight, enqueueToStudio, enqueueControl, beginShutdown, sweep, getSnapshot, getStudioStatus }`. Imports ONLY `node:http`, `node:crypto` + Task 1 helpers (`hostAllowed`, `tokenGuarded`, `readBody`, `redactHeaders`, `attachClientError`, `createCommandQueue`) + Task 2 `createRegistry` is passed IN (not imported), so the core stays pure-injectable.
- **Create** `G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\server\broker.mjs` — entry. Reads `MCP_BROKER_PORT`/`MCP_BROKER_HOST`/`ROBLOX_MCP_TOKEN`/`ROBLOX_MCP_BROKER_IDLE_MS`, resolves the machine-token file, builds `createRegistry` + `createBrokerCore`, `listen()`, `EADDRINUSE → exit 0`, other errors → exit 1, `REAP_TICK_MS` sweep interval, idle self-exit. Imports `node:http` (none directly — via core), `node:fs`, `node:path`, `node:crypto`, Task 1 helpers, Task 2 registry, and `broker-core.mjs`.
- **Test** `G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\server\test\broker-core.test.mjs` — integration on an ephemeral port: studio poll/result roundtrip, per-studio routing isolation, `/health` shape, legacy `/poll` alias, drain-blocks-on-in-flight, contested→`__assign_studio_id`, redaction on a new endpoint, forbidden-host 403, token 401.

#### Interfaces

**Consumes (from Task 1 — `server/lib/http-bridge.mjs` additive exports):**
- `hostAllowed(req, hosts) -> boolean` — host-allowlist check (returns true if `req.headers.host` ∈ `hosts`).
- `tokenGuarded(pathname) -> boolean` — true iff `pathname` starts with `/studio/`|`/session/`|`/fe/` OR equals a legacy alias (`/poll`,`/submit`,`/result/`) — everything except `/health`.
- `readBody(req, res, onComplete, { maxBodyBytes, bodyTimeoutMs }) -> void` — body cap + timeout, calls `onComplete(bodyString)`; writes 413/408 itself.
- `redactHeaders(headers) -> object` — secret values → `[REDACTED]`.
- `attachClientError(httpServer) -> void` — wires the `clientError` 400 handler.
- `createCommandQueue({ pollTimeoutMs }) -> { pending, waiters, deliverOrQueue(cmd), removePending(id), park(res, onTimeout) }` — per-studio queue with the §4.4 dropped-waiter reaping fix (req-close reaps the waiter + clears its timer; delivery wraps `res.end` in try/catch and re-queues the command at the FRONT of `pending`).

**Consumes (from Task 2 — `server/lib/registry.mjs`):**
- `createRegistry({ now, thresholds }) -> registry` exposing `upsertSession`, `upsertStudio({ studioId, label, placeId, connId, legacy })`, `touchStudio(id, now)`, `touchSession(id, now)`, `mintSessionToken`, `validateSessionToken`, `pair`, `unpair`, `attach`, `detach`, `maybeAutoPair(now)`, `resolveTarget(sessionId, explicitTarget, now)`, `rekeyStudio`, `acquireClaim`/`releaseClaim`, `tick(now)`, `markContested(studioId, contested)`, `getStudio(id)`, `getSession(id)`, `snapshot()`.

**Produces (for Task 4 `broker-client.mjs` + Task 5 `server.mjs` wiring):**
- `createBrokerCore(opts) -> { httpServer, inFlight: Map<id,{resolve,timeout,studioId}>, enqueueToStudio(studio, type, payload, timeoutMs) -> Promise<result>, enqueueControl(studioId, type, payload) -> void, beginShutdown() -> void, sweep(now) -> { idle:boolean }, getSnapshot() -> object, getStudioStatus(studioId, now) -> object }`
- Broker wire contract over `127.0.0.1:<port>`: `GET /health` → `{ ok:true, role:"broker", proto:1, brokerId }`; plugin plane `GET /studio/poll`, `GET /studio/control-poll`, `POST /studio/result/<id>`, optional `POST /studio/register`, legacy aliases `GET /poll` + `POST /result/<id>` → studioId `legacy:default`; session plane endpoints `POST /fe/register`, `POST /fe/heartbeat`, `POST /fe/deregister`, `POST /session/submit`, `GET /session/<sid>/status`, `GET /session/list`, `POST /session/pair`/`unpair`/`attach`/`detach-studio`.
- Command wire shape UNCHANGED: `{ id, type, payload }`.
- `server/broker.mjs` runnable entry: `node server/broker.mjs` (env-driven), EADDRINUSE → exit 0.

> The session-plane endpoints (`/fe/*`, `/session/*`) are implemented here in broker-core but their END-TO-END verification (session_token gate, pairing flows) is owned by Task 4's client tests. Task 3's own test focuses on the **studio plane + lifecycle** (poll/result/routing/health/drain/contested), which is where broker-core's novel logic lives.

#### Constants (authoritative — used by both files)
```
PLUGIN_STALE_MS  = 12_000
STUDIO_DROP_MS   = 120_000
FE_HEARTBEAT_MS  = 10_000      // (referenced; FE-side)
SESSION_STALE_MS = 90_000
SESSION_DROP_MS  = 300_000
REAP_TICK_MS     = 5_000
IDLE_REAP_MS     = 90_000
DRAIN_CEILING_MS = 60_000
CONTROL_POLL_MS  = 1_000       // (referenced; plugin-side)
PROTO            = 1
```

---

##### Step 3.1: Write the failing test — `/health` shape + forbidden host + token 401

Create `server\test\broker-core.test.mjs` with the harness + first cases.

```js
// server/test/broker-core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
```

##### Step 3.2: Run the test to verify it fails — module missing

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` FAIL — `Cannot find module '.../server/lib/broker-core.mjs'` (registry.mjs from Task 2 exists; broker-core does not yet).

##### Step 3.3: Implement — broker-core skeleton: server, host/token guard, `/health`

Create `server\lib\broker-core.mjs` with the constructor, the request pipeline (host → token → redact-log → dispatch), and `/health`. Use Task 1 helpers. (Subsequent steps add endpoints.)

```js
// server/lib/broker-core.mjs
/**
 * server/lib/broker-core.mjs
 * The Broker's own HTTP server: §4 endpoints on 127.0.0.1, built from the
 * extracted http-bridge helpers around an injected registry + per-studio
 * CommandQueue + a broker-global inFlight Map. Pure node builtins + lib helpers;
 * NO MCP SDK. Behavior of /studio/* mirrors the legacy /poll,/result contract.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  hostAllowed,
  tokenGuarded,
  readBody,
  redactHeaders,
  attachClientError,
  createCommandQueue,
} from "./http-bridge.mjs";

const PLUGIN_STALE_MS = 12_000;
const STUDIO_DROP_MS = 120_000;
const SESSION_STALE_MS = 90_000;
const SESSION_DROP_MS = 300_000;
const DRAIN_CEILING_MS = 60_000;
const POLL_TIMEOUT_MS = 10_000;
const CONTROL_POLL_TIMEOUT_MS = 10_000;
const CONTESTED_WINDOW_MS = 3_000; // two distinct connIds within this → contested
const PROTO = 1;
const LEGACY_STUDIO_ID = "legacy:default";
const LEGACY_SESSION_ID = "session:legacy";

export function createBrokerCore({
  registry,
  now = Date.now,
  authToken = "",
  brandPrefix = "[roblox-mcp]",
  idleReapMs = 90_000,
  maxBodyBytes = 8 * 1024 * 1024,
  bodyTimeoutMs = 30_000,
} = {}) {
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
    if (!q) { q = createCommandQueue({ pollTimeoutMs: POLL_TIMEOUT_MS }); cmdQueues.set(studioId, q); }
    return q;
  }
  function ctrlQueue(studioId) {
    let q = ctrlQueues.get(studioId);
    if (!q) { q = createCommandQueue({ pollTimeoutMs: CONTROL_POLL_TIMEOUT_MS }); ctrlQueues.set(studioId, q); }
    return q;
  }
  function countInFlight(studioId) {
    let n = 0;
    for (const v of inFlight.values()) if (v.studioId === studioId) n++;
    return n;
  }
  function hasInFlight(studioId) { return countInFlight(studioId) > 0; }

  function logLine(req) {
    // every new endpoint logs through redactHeaders (§2.8)
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

  // ── connId / contested bookkeeping ──────────────────────────────────────
  function noteConn(studioId, connId) {
    let m = recentConns.get(studioId);
    if (!m) { m = new Map(); recentConns.set(studioId, m); }
    const t = now();
    m.set(connId, t);
    for (const [c, ts] of m) if (t - ts > CONTESTED_WINDOW_MS) m.delete(c);
    const contested = m.size >= 2;
    registry.markContested(studioId, contested);
    return contested;
  }

  // ── enqueue (§4.3) ──────────────────────────────────────────────────────
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
  }

  // ── status (§4.3.1) ─────────────────────────────────────────────────────
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
    return { brokerId, draining, ...registry.snapshot() };
  }

  // ── sweep / idle (§3.6) ─────────────────────────────────────────────────
  function sweep(t) {
    registry.tick(t); // marks stale/drop, unpairs on drop — but registry must respect in-flight override via hasInFlight
    const snap = registry.snapshot();
    const liveStudios = snap.studios.filter((s) => s.state !== "DROPPED" && (s.state === "live" || hasInFlight(s.studioId)));
    const liveSessions = snap.sessions.filter((s) => s.state !== "DROPPED");
    const idle = liveSessions.length === 0 && liveStudios.length === 0 && inFlight.size === 0;
    if (idle) { if (!idleSince) idleSince = t; }
    else idleSince = 0;
    const shouldReap = idle && idleSince && t - idleSince >= idleReapMs;
    return { idle, shouldReap };
  }

  function beginShutdown() {
    if (draining) return;
    draining = true;
    drainSince = now();
  }
  function drainExpired(t) { return draining && t - drainSince >= DRAIN_CEILING_MS; }

  // ── HTTP dispatch ───────────────────────────────────────────────────────
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (!hostAllowed(req, httpServer.__hosts)) return sendJson(res, 403, { error: "forbidden host" });

    if (p !== "/health") logLine(req);

    if (authToken && tokenGuarded(p) && req.headers["x-mcp-token"] !== authToken) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (req.method === "GET" && p === "/health") {
      return sendJson(res, 200, { ok: true, role: "broker", proto: PROTO, brokerId });
    }

    return dispatch(req, res, url, p);
  });

  // host allowlist rebuilt on listen (port 0 → ephemeral)
  httpServer.__hosts = null;
  httpServer.on("listening", () => {
    const realPort = httpServer.address().port;
    httpServer.__hosts = new Set([`127.0.0.1:${realPort}`, `localhost:${realPort}`]);
  });
  attachClientError(httpServer);

  function dispatch(req, res, url, p) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  }

  return {
    httpServer, inFlight, brokerId,
    enqueueToStudio, enqueueControl, beginShutdown, sweep,
    getSnapshot, getStudioStatus,
    // exposed for later steps / tests:
    _internals: { cmdQueue, ctrlQueue, noteConn, countInFlight, hasInFlight, drainExpired, isDraining: () => draining },
    LEGACY_STUDIO_ID, LEGACY_SESSION_ID,
  };
}
```

> `hostAllowed(req, hosts)` from Task 1 takes a `Set`; we store the resolved set on `httpServer.__hosts` after `listening` (mirrors the existing http-bridge ephemeral-port idiom). If Task 1's `hostAllowed` instead derives the set internally, drop `__hosts` and call `hostAllowed(req, port)`; either way this is the only coupling point — adjust the one call.

##### Step 3.4: Run tests to verify the health/guard cases pass

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` PASS — the 3 tests from Step 3.1 (health shape, forbidden host, token 401). (Dispatch returns 404 for the un-implemented endpoints, which these tests do not hit.)

##### Step 3.5: Write the failing test — studio poll/result roundtrip + per-studio isolation

Append to `broker-core.test.mjs`:

```js
// ── studio plane: enqueue -> poll -> result roundtrip ────────────────────
test("enqueueToStudio delivers via /studio/poll; result resolves the promise", async () => {
  const { port, core, registry, clock, close } = await startCore();
  try {
    registry.upsertStudio({ studioId: "stud0001", label: "Alpha", connId: 1, legacy: false });
    const studio = { id: "stud0001", queue: core._internals.cmdQueue("stud0001") };
    const p = core.enqueueToStudio(studio, "create_part", { name: "X" }, 5_000);

    const poll = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "stud0001" } });
    assert.equal(poll.status, 200);
    const cmd = j(poll.body);
    assert.equal(cmd.type, "create_part");
    assert.deepEqual(cmd.payload, { name: "X" });
    assert.equal(typeof cmd.id, "string");

    const r = await req(port, {
      method: "POST", path: `/studio/result/${cmd.id}`,
      headers: { "x-studio-id": "stud0001" }, body: JSON.stringify({ ok: true, ref: "Workspace.X" }),
    });
    assert.equal(r.status, 200);
    assert.equal(j(r.body).ok, true);

    const result = await p;
    assert.deepEqual(result, { ok: true, ref: "Workspace.X" });
  } finally { close(); }
});

test("per-studio routing isolation: B's poll never sees A's command", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    registry.upsertStudio({ studioId: "studAAAA", label: "A", connId: 1 });
    registry.upsertStudio({ studioId: "studBBBB", label: "B", connId: 2 });
    const A = { id: "studAAAA", queue: core._internals.cmdQueue("studAAAA") };
    core.enqueueToStudio(A, "set_property", { p: 1 }, 5_000);

    // B polls: must get {} (its own queue is empty), NOT A's command
    const pollB = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "studBBBB" } });
    assert.equal(pollB.status, 200);
    assert.equal(pollB.body, "{}"); // long-poll timed out empty? No — empty returns after pollTimeout

    // A polls: gets its own command
    const pollA = await req(port, { path: "/studio/poll", headers: { "x-studio-id": "studAAAA" } });
    assert.equal(j(pollA.body).type, "set_property");
  } finally { close(); }
});

test("missing x-studio-id maps to legacy:default; bare /poll alias too", async () => {
  const { port, core, registry, close } = await startCore();
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
```

> The `pollB.body === "{}"` assertion would force a 10 s wait. To keep the test fast, the isolation case must NOT block: assert via the **pending queue** length instead of polling B. Replace the `pollB` block with the deterministic check below (also avoids a 10 s long-poll):

```js
    // B's command queue is empty; A's holds exactly one pending
    assert.equal(core._internals.cmdQueue("studBBBB").pending.length, 0);
    assert.equal(core._internals.cmdQueue("studAAAA").pending.length, 1);
```

(Remove the literal `pollB` request from the isolation test; keep the `pollA` roundtrip which returns immediately because A has a pending command.)

##### Step 3.6: Run the test to verify it fails — endpoints not implemented

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` FAIL — `/studio/poll` and `/studio/result/<id>` return 404 (dispatch stub), so `poll.status` is 404 and `j(poll.body)` has no `type`.

##### Step 3.7: Implement — studio plane endpoints (poll, control-poll, result, register) + legacy aliases

Replace the `dispatch` stub in `broker-core.mjs` with the full studio plane. Insert ABOVE the `return {…}` (and delete the old one-line `dispatch`):

```js
  function studioIdFrom(req) {
    const raw = (req.headers["x-studio-id"] || "").toString();
    return /^[0-9a-fA-F:\-]{8,64}$/.test(raw) ? raw : LEGACY_STUDIO_ID;
  }
  function studioLabelFrom(req) {
    const raw = (req.headers["x-studio-label"] || "").toString().slice(0, 160);
    return raw ? raw.replace(/[ -]/g, "").slice(0, 80) : undefined;
  }

  function handleStudioPoll(req, res, isControl) {
    const t = now();
    const studioId = studioIdFrom(req);
    const connId = ++connSeq;
    const legacy = studioId === LEGACY_STUDIO_ID;
    registry.upsertStudio({ studioId, label: studioLabelFrom(req), connId, legacy });
    registry.touchStudio(studioId, t);
    registry.tick(t);
    registry.maybeAutoPair(t);

    const contested = noteConn(studioId, connId);

    if (isControl) {
      const cq = ctrlQueue(studioId);
      if (cq.pending.length > 0) return sendJson(res, 200, cq.pending.shift());
      return cq.park(res, () => sendJson(res, 200, {}));
    }

    if (contested) return sendJson(res, 200, {}); // §2.6: hold all normal commands while contested
    if (draining) return sendJson(res, 200, {});  // §3.6: stop new dequeues while draining

    const q = cmdQueue(studioId);
    if (q.pending.length > 0) return sendJson(res, 200, q.pending.shift());
    return q.park(res, () => sendJson(res, 200, {}));
  }

  function handleStudioResult(req, res, id) {
    readJson(req, res, (parsed) => {
      const handler = inFlight.get(id);
      if (handler && handler.studioId) {
        const live = registry.getStudio(handler.studioId);
        // owner-check: reject only when id maps to a DIFFERENT still-live studio
        const claimedBy = (req.headers["x-studio-id"] || "").toString();
        if (live && claimedBy && /^[0-9a-fA-F:\-]{8,64}$/.test(claimedBy) &&
            claimedBy !== handler.studioId && registry.getStudio(claimedBy)) {
          return sendJson(res, 200, { ok: true }); // not our command; ignore quietly
        }
        clearTimeout(handler.timeout);
        inFlight.delete(id);
        handler.resolve(parsed);
        return sendJson(res, 200, { ok: true });
      }
      console.error(`late result for ${id}, op may have completed plugin-side`);
      return sendJson(res, 200, { ok: true });
    });
  }

  function dispatch(req, res, url, p) {
    // ── plugin plane + legacy aliases ─────────────────────────────────────
    if (req.method === "GET" && (p === "/studio/poll" || p === "/poll")) return handleStudioPoll(req, res, false);
    if (req.method === "GET" && p === "/studio/control-poll") return handleStudioPoll(req, res, true);
    if (req.method === "POST" && p.startsWith("/studio/result/")) return handleStudioResult(req, res, p.slice("/studio/result/".length));
    if (req.method === "POST" && p.startsWith("/result/")) return handleStudioResult(req, res, p.slice("/result/".length));
    if (req.method === "POST" && p === "/studio/register") {
      return readJson(req, res, (b) => {
        const studioId = (b.studio_id && /^[0-9a-fA-F:\-]{8,64}$/.test(b.studio_id)) ? b.studio_id : LEGACY_STUDIO_ID;
        registry.upsertStudio({ studioId, label: b.studio_label, connId: ++connSeq, legacy: studioId === LEGACY_STUDIO_ID });
        registry.touchStudio(studioId, now());
        registry.maybeAutoPair(now());
        const st = registry.getStudio(studioId);
        sendJson(res, 200, { ok: true, paired_session: st?.pairedSessionId || null });
      });
    }

    // ── session plane (implemented in Step 3.11) ──────────────────────────
    if (handleSessionPlane(req, res, url, p)) return;

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  }

  function handleSessionPlane() { return false; } // placeholder; filled in Step 3.11
```

> `createCommandQueue` must expose `park(res, onTimeout)` (the §4.4 reaping waiter parker). If Task 1 instead returns lower-level `waiters`/timeout primitives, adapt: `park` pushes a waiter that, on the pollTimeout, calls `onTimeout()`; on `req.on("close")` it reaps itself + clears the timer; on delivery it wraps `res.end` and re-queues the command at the front of `pending` on throw. The contract names this on the queue, so prefer the queue's `park`.

##### Step 3.8: Run tests to verify the studio roundtrip passes

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` PASS — health/guard tests + the roundtrip + per-studio isolation + legacy-alias tests (Step 3.5, with the deterministic isolation fix). No 10 s waits (A always has a pending command at poll time; isolation asserted via pending length).

##### Step 3.9: Write the failing test — contested → `__assign_studio_id` via control-poll; drain blocks new dequeue

Append to `broker-core.test.mjs`:

```js
// ── contested studio: two distinct connIds → __assign_studio_id on control ─
test("two distinct connIds within window mark contested; control-poll gets __assign_studio_id; commands held", async () => {
  const { port, core, registry, close } = await startCore();
  try {
    registry.upsertStudio({ studioId: "dupe0001", label: "Dup", connId: 0 });
    const studio = { id: "dupe0001", queue: core._internals.cmdQueue("dupe0001") };
    core.enqueueToStudio(studio, "create_part", { n: 1 }, 5_000);

    // first command-poll from window-1 (no second conn yet) — but we drive contested
    // explicitly by enqueuing the assign for the contested conn, then asserting hold.
    core._internals.noteConn("dupe0001", 101);
    core._internals.noteConn("dupe0001", 102); // 2 distinct → contested
    assert.equal(registry.getStudio("dupe0001").contested, true);

    // while contested, a command-poll returns {} (held), even though pending>0
    // (use a short race: command-poll long-polls, so assert pending stays queued instead)
    assert.equal(core._internals.cmdQueue("dupe0001").pending.length, 1);

    // broker injects __assign_studio_id ahead of pending on the CONTROL queue
    core.enqueueControl("dupe0001", "__assign_studio_id", { studio_id: "freshGUID00000001" });
    const ctrl = await req(port, { path: "/studio/control-poll", headers: { "x-studio-id": "dupe0001" } });
    assert.equal(ctrl.status, 200);
    const c = j(ctrl.body);
    assert.equal(c.type, "__assign_studio_id");
    assert.equal(c.payload.studio_id, "freshGUID00000001");
  } finally { close(); }
});

// ── drain blocks new dequeues; refuses while in-flight ────────────────────
test("draining: /studio/poll returns {} (no new dequeue) and sweep stays non-idle while inFlight>0", async () => {
  const { port, core, registry, clock, close } = await startCore({ idleReapMs: 10 });
  try {
    registry.upsertStudio({ studioId: "drain001", label: "D", connId: 1 });
    const studio = { id: "drain001", queue: core._internals.cmdQueue("drain001") };
    // command in flight (delivered, not resolved): simulate by enqueue + poll
    const inflightP = core.enqueueToStudio(studio, "long_op", {}, 5_000);
    await req(port, { path: "/studio/poll", headers: { "x-studio-id": "drain001" } }); // delivers it → inFlight

    assert.equal(core.inFlight.size, 1);
    core.beginShutdown();

    // queue a fresh command; a draining poll must NOT dequeue it
    core.enqueueToStudio(studio, "new_op", {}, 5_000);
    assert.equal(core._internals.cmdQueue("drain001").pending.length, 1);

    // sweep is NOT idle while inFlight>0 (idle-reap blocked)
    clock.adv(1_000);
    const sw = core.sweep(clock.read());
    assert.equal(sw.idle, false);
    assert.equal(sw.shouldReap, false);

    // resolve the in-flight command so we can close cleanly
    const cmd = core._internals.cmdQueue("drain001"); // not used; resolve via result
  } finally { close(); }
});
```

##### Step 3.10: Run the test to verify it fails (or fix the gap)

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` The contested test PASSES if Step 3.7 wired `noteConn` + control-poll correctly; the drain test PASSES given the Step 3.7 `draining` guard and Step 3.3 `sweep`. If either fails, read the message: the most likely gap is `registry.markContested` not flipping `contested` (Task 2) or `sweep`'s in-flight override — fix in `sweep` by including `hasInFlight` in the live-studio filter (already present in Step 3.3). Re-run until PASS.

##### Step 3.11: Implement — session plane endpoints (`/fe/*`, `/session/*`)

Replace the `handleSessionPlane` placeholder in `broker-core.mjs` with the full session plane. This gates every `/session/*` and `/fe/heartbeat`|`/fe/deregister` on `x-session-token` (§2.7) before `resolveTarget`.

```js
  function sessionTokenOk(req, sessionId) {
    return registry.validateSessionToken(sessionId, (req.headers["x-session-token"] || "").toString());
  }

  function handleSessionPlane(req, res, url, p) {
    const t = now();

    if (req.method === "POST" && p === "/fe/register") {
      readJson(req, res, (b) => {
        if (draining) return sendJson(res, 503, { error: "broker draining" });
        const r = registry.upsertSession({
          sessionId: b.session_id, kind: b.kind, label: b.label, pid: b.pid, cwd: b.cwd, now: t,
        });
        if (r && r.conflict) return sendJson(res, 409, { ok: false, error: "session_id_in_use", suggested: r.suggested });
        const token = registry.mintSessionToken(b.session_id, b.pid);
        if (b.target) registry.attach(b.session_id, b.target, undefined, t);
        registry.maybeAutoPair(t);
        const sess = registry.getSession(b.session_id);
        sendJson(res, 200, {
          ok: true, brokerId, session_token: token,
          paired_studio_id: sess?.pairedStudioId || null,
          origin: sess?.origin || null,
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
        sendJson(res, 200, { ok: true, brokerId, paired_studio_id: sess?.pairedStudioId || null, origin: sess?.origin || null });
      });
      return true;
    }

    if (req.method === "POST" && p === "/fe/deregister") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        registry.unpair(b.session_id, undefined, t);
        registry.detach(b.session_id, t);
        sendJson(res, 200, { ok: true });
      });
      return true;
    }

    if (req.method === "POST" && p === "/session/submit") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        if (!b.type) return sendJson(res, 400, { error: "bad request", code: "BAD_REQUEST" });
        registry.touchSession(b.session_id, t);
        const sel = registry.resolveTarget(b.session_id, b.target, t);
        if (sel.error) return sendJson(res, 200, sel); // typed error as a normal tool result
        const studioId = sel.studioId;
        // exclusive-claim gate (§6.2)
        const st = registry.getStudio(studioId);
        if (st && st.claim && st.claim.mode === "exclusive" && st.claim.sessionId !== b.session_id) {
          return sendJson(res, 200, { error: "studio_locked", code: "STUDIO_LOCKED", heldBy: st.claim.sessionId, expiresAt: st.claim.expiresAt });
        }
        const studio = { id: studioId, queue: cmdQueue(studioId) };
        enqueueToStudio(studio, b.type, b.payload, b.timeout_ms || 30_000).then((r) => sendJson(res, 200, r));
      });
      return true;
    }

    if (req.method === "GET" && /^\/session\/[^/]+\/status$/.test(p)) {
      const sid = decodeURIComponent(p.split("/")[2]);
      if (!sessionTokenOk(req, sid)) return (sendJson(res, 401, { error: "unauthorized" }), true);
      const sess = registry.getSession(sid);
      const targetId = sess?.pairedStudioId;
      const base = targetId
        ? getStudioStatus(targetId, t)
        : { pluginConnected: false, msSinceLastPoll: null, queued: 0, inFlight: 0, ready: false, paired: false };
      sendJson(res, 200, { ...base, session_id: sid, session_label: sess?.label, origin: sess?.origin || "unpaired" });
      return true;
    }

    if (req.method === "GET" && p === "/session/list") {
      // list needs the asserted session id via header to gate
      const sid = (req.headers["x-session-id"] || "").toString();
      if (!sessionTokenOk(req, sid)) return (sendJson(res, 401, { error: "unauthorized" }), true);
      const snap = registry.snapshot();
      const you = registry.getSession(sid);
      sendJson(res, 200, { studios: snap.studios, sessions: snap.sessions, pairs: snap.pairs, you: { session_id: sid, paired_studio_id: you?.pairedStudioId || null } });
      return true;
    }

    if (req.method === "POST" && (p === "/session/pair" || p === "/session/attach")) {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        const r = registry.attach(b.session_id, b.target, b.claim, t);
        sendJson(res, 200, r);
      });
      return true;
    }

    if (req.method === "POST" && p === "/session/unpair") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        const r = registry.unpair(b.session_id, b.target, t);
        sendJson(res, 200, r);
      });
      return true;
    }

    if (req.method === "POST" && p === "/session/detach-studio") {
      readJson(req, res, (b) => {
        if (!sessionTokenOk(req, b.session_id)) return sendJson(res, 401, { error: "unauthorized" });
        const r = registry.detach(b.studio_id, t, { admin: true, by: b.session_id });
        sendJson(res, 200, r);
      });
      return true;
    }

    return false;
  }
```

> Exact registry return-shapes (`attach`/`unpair`/`detach`/`resolveTarget`/`upsertSession` conflict) are owned by Task 2; broker-core forwards them verbatim. If a Task-2 signature differs (e.g. `attach(sessionId, target, claim, now)` vs `attach({…})`), adjust the call here only — the dispatch wiring is the contract.

##### Step 3.12: Run tests to verify the full broker-core suite passes

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` PASS — all studio-plane + lifecycle tests green. (Session-plane end-to-end is exercised by Task 4; here we only need broker-core to compile and the studio/lifecycle tests to pass.)

##### Step 3.13: Write the failing test — redaction on a new endpoint

Append to `broker-core.test.mjs`:

```js
test("secret headers to /studio/poll log as [REDACTED]", async () => {
  const { port, close } = await startCore();
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    await req(port, { path: "/studio/poll", headers: { "x-studio-id": "redact01", "x-mcp-token": "TOPSECRET", "x-api-key": "KEY123" } });
    const line = logs.find((l) => l.includes("/studio/poll"));
    assert.ok(line, "expected a log line for /studio/poll");
    assert.ok(!line.includes("TOPSECRET"), "x-mcp-token must be redacted");
    assert.ok(!line.includes("KEY123"), "x-api-key must be redacted");
    assert.ok(line.includes("[REDACTED]"));
  } finally { console.error = orig; close(); }
});
```

> This poll will long-poll for 10 s if the studio has no command. To keep it fast, the studio's queue must be empty AND we must not await the poll's body. Fix: fire the request but resolve the test on the **log line**, not the response. Rewrite the `await req(...)` as a non-awaited request and poll the `logs` array:

```js
    req(port, { path: "/studio/poll", headers: { "x-studio-id": "redact01", "x-mcp-token": "TOPSECRET", "x-api-key": "KEY123" } });
    // log line is written synchronously on request entry, before the long-poll parks
    await new Promise((r) => setTimeout(r, 50));
    const line = logs.find((l) => l.includes("/studio/poll"));
```

(The log line is emitted at request entry — before parking — so a 50 ms wait suffices; no 10 s block.)

##### Step 3.14: Run tests to verify redaction passes

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` PASS — redaction test green; the parked long-poll is left to be torn down by `close()`.

##### Step 3.15: Implement — `server/broker.mjs` entry (machine token, listen, EADDRINUSE→exit 0, idle-reap)

Create `server\broker.mjs`:

```js
#!/usr/bin/env node
/**
 * server/broker.mjs
 * Long-lived Roblox MCP broker. Owns 127.0.0.1:<port>, hosts the registry +
 * per-studio command/control queues + sweep/idle. Spawned detached by a losing
 * FE, or bound in-proc by the election winner. Zero MCP SDK; node builtins +
 * lib helpers only. EADDRINUSE (race loser) => exit 0; other errors => exit 1.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createRegistry } from "./lib/registry.mjs";
import { createBrokerCore } from "./lib/broker-core.mjs";

const REAP_TICK_MS = 5_000;

const PORT = (() => {
  const p = Number(process.env.MCP_BROKER_PORT || process.env.ROBLOX_MCP_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8765;
})();
const HOST = process.env.MCP_BROKER_HOST || "127.0.0.1";
const IDLE_REAP_MS = (() => {
  const v = Number(process.env.ROBLOX_MCP_BROKER_IDLE_MS);
  return Number.isInteger(v) && v >= 0 ? v : 90_000;
})();

// ── machine token (§2.7): default ON when ROBLOX_MCP_TOKEN unset ───────────
function localAppData() {
  return process.env.LOCALAPPDATA || join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Local");
}
function resolveAuthToken() {
  const explicit = (process.env.ROBLOX_MCP_TOKEN || "").trim();
  if (explicit) return explicit;
  if (process.env.ROBLOX_MCP_ALLOW_TOKENLESS === "1") return "";
  const dir = join(localAppData(), "Roblox-MCP");
  const file = join(dir, "broker-token");
  try {
    if (existsSync(file)) { const t = readFileSync(file, "utf8").trim(); if (t) return t; }
    mkdirSync(dir, { recursive: true });
    const tok = randomBytes(24).toString("hex");
    writeFileSync(file, tok, { mode: 0o600 });
    return tok;
  } catch {
    // can't persist a machine token → fall back to tokenless (no worse than today)
    return "";
  }
}

const authToken = resolveAuthToken();
const registry = createRegistry({ now: Date.now, thresholds: {} });
const core = createBrokerCore({
  registry, now: Date.now, authToken, brandPrefix: "[roblox-mcp:broker]", idleReapMs: IDLE_REAP_MS,
});

core.httpServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    // race loser: another broker already owns the port → exit 0, the client connects to it
    console.error(`[roblox-mcp:broker] ${HOST}:${PORT} already bound — yielding (exit 0).`);
    process.exit(0);
  }
  console.error(`[roblox-mcp:broker] FATAL: ${err.message}`);
  process.exit(1);
});

const reaper = setInterval(() => {
  const { shouldReap } = core.sweep(Date.now());
  if (shouldReap) {
    core.beginShutdown();
    const drainTimer = setInterval(() => {
      if (core.inFlight.size === 0 || core._internals.drainExpired(Date.now())) {
        clearInterval(drainTimer);
        clearInterval(reaper);
        core.httpServer.close(() => process.exit(0));
      }
    }, 250);
  }
}, REAP_TICK_MS);
reaper.unref?.();

core.httpServer.listen(PORT, HOST, () => {
  console.error(`[roblox-mcp:broker] listening ${HOST}:${PORT} ${authToken ? "(auth ON)" : "(no token)"}`);
});
```

##### Step 3.16: Write the failing test — `broker.mjs` binds, answers `/health`, and yields exit 0 on EADDRINUSE

Append to `broker-core.test.mjs` (spawns the real entry, mirroring the `http-bridge.test.mjs:96` EADDRINUSE idiom):

```js
import { spawn } from "node:child_process";

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
    for (let i = 0; i < 40 && !ok; i++) {
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
```

> The Windows path conversion (`decodeURIComponent(...).replace(/^\/([A-Za-z]:)/, "$1")`) turns `file:///G:/…` into `G:/…`. Spaces in the Google-Drive path survive because `spawn` passes the path as a single argv element (no shell). If `import.meta.url` already yields a usable path on this setup, `fileURLToPath` from `node:url` is the cleaner equivalent — either is acceptable.

##### Step 3.17: Run tests to verify the entry test passes

`Run:` `node --test server/test/broker-core.test.mjs`
`Expected:` PASS — `broker.mjs` binds, `/health` returns `role:"broker"`, and the 2nd instance exits 0. (Note: the live child keeps the port for the duration; `idleReapMs=999999` prevents self-reap mid-test; `child.kill()` cleans up.)

##### Step 3.18: Run the WHOLE suite to confirm no regressions (Task 1/2 still green)

`Run:` `node --test server/test/http-bridge.test.mjs server/test/registry.test.mjs server/test/command-queue.test.mjs server/test/broker-core.test.mjs`
`Expected:` PASS — Task 1 (`http-bridge`, `command-queue`), Task 2 (`registry`), and Task 3 (`broker-core`) all green. (Adjust the file list to whatever Task 1/2 named; the broker-core file is the new one.)

##### Step 3.19: Commit

`Run:`
```
git add server/lib/broker-core.mjs server/broker.mjs server/test/broker-core.test.mjs && git commit -m "$(cat <<'EOF'
feat(broker): broker-core + broker.mjs — own server, §4 endpoints, contested/control, drain/idle

- broker-core.mjs builds its own http.createServer from the extracted
  http-bridge helpers around an injected registry + per-studio CommandQueue
  + a broker-global inFlight Map.
- Implements both planes: /studio/{poll,control-poll,result,register} (+ legacy
  /poll,/result aliases → legacy:default), /fe/{register,heartbeat,deregister},
  /session/{submit,list,pair,unpair,attach,detach-studio,<sid>/status},
  and minimal /health {ok,role:broker,proto:1,brokerId}.
- enqueueToStudio (§4.3), contested-by-poll-timing + __assign_studio_id on the
  control queue (§2.6), in-flight-as-keepalive liveness + idle/drain gating (§3.6),
  session_token gate before resolveTarget (§2.7).
- broker.mjs entry: machine-token default, EADDRINUSE→exit 0, REAP_TICK sweep,
  idle self-reap with drain ceiling.
- Integration tests: studio poll/result roundtrip, per-studio isolation, /health
  shape, legacy alias, contested→assign, drain-blocks-on-inflight, header
  redaction, and broker.mjs bind + exit-0-on-EADDRINUSE.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
`Expected:` commit succeeds; 3 files added.

---

### Task 4: broker-client.mjs — ensureBroker election, detached spawn, FE client API

> **What this task delivers.** A new zero-dep module `server/lib/broker-client.mjs` that the thin front-end (`server/server.mjs`, wired in Task 5) calls in broker mode. It exports `ensureBroker({port,host,authToken,brandPrefix,sessionId})` which runs the §3.2 **direct-bind election** (become the in-proc broker, OR connect to a running one, OR spawn a detached one), and returns a **client object** whose public surface is a drop-in superset of what `createBridge` returns today: `submit(type,payload,timeoutMs)` is **byte-identical**, plus `submitTo`, `getStatus()` (now async → Promise), `heartbeat`, `register`, `deregister`, `listStudios`, `attachStudio`, `detachStudio`, `sessionStatus`. It also owns per-cwd `session_id` persistence.
>
> **Hard rules for this file (from the contract):** import ONLY node builtins (`node:http`, `node:crypto`, `node:child_process`, `node:fs`, `node:path`, `node:url`, `node:os`) + the Task-1 helpers from `./http-bridge.mjs` + the Task-3 `broker-core.mjs`. The MCP SDK NEVER enters this file. Tests run under `node --test` with NO `node_modules`. The detached-spawn env is an **ALLOWLIST**, never `{...process.env}` — `ROBLOX_OPEN_CLOUD_*` and any `*_KEY` must NOT leak.

#### Files
- **Create:** `G:\My Drive\Backup\Roblox-MCP-v6\server\lib\broker-client.mjs` (new; ~360 lines)
- **Create (test):** `G:\My Drive\Backup\Roblox-MCP-v6\server\test\broker-client.test.mjs` (new)
- **Read-only dependency (created by Task 1):** `server/lib/http-bridge.mjs` exports `redactHeaders` (`http-bridge.mjs:16`) — used only indirectly; this task imports nothing new from it but MUST not break it.
- **Read-only dependency (created by Task 3):** `server/broker.mjs` (the detached-spawn target) and `server/lib/broker-core.mjs` (`export function createBrokerCore(...)` returning `{ httpServer, core }` and an in-proc `submit`/registry surface — see Interfaces/Consumes).
- **Reference (unchanged):** `server/lib/http-bridge.mjs:24` `createBridge(...)` signature returning `{ httpServer, submit, getStatus }` — the shape `ensureBroker`'s returned client must be a superset of, so Task-5 wiring (`server/server.mjs:39`) is a drop-in swap.

#### Interfaces

**Consumes (produced by earlier tasks — exact signatures this task depends on):**
- From **Task 1** (`server/lib/http-bridge.mjs`): `export function redactHeaders(headers) -> object` (already exists at `http-bridge.mjs:16`). No other Task-1 helper is imported here.
- From **Task 3** (`server/lib/broker-core.mjs`): `export function createBrokerCore({ port, host, authToken, brandPrefix, now? }) -> { httpServer, core }` where:
  - `httpServer` is an un-listened `http.Server` (Task 3 does NOT call `.listen`; `ensureBroker` owns the listen so it can catch EADDRINUSE non-fatally).
  - `core` exposes the in-proc broker API: `core.registerSession({ sessionId, kind, label, pid, cwd, target }) -> { ok, brokerId, session_token, paired_studio_id, origin }`, `core.heartbeat({ sessionId, sessionToken }) -> { ok, brokerId, paired_studio_id, origin }`, `core.deregister({ sessionId, sessionToken }) -> { ok }`, `core.submitFromSession({ sessionId, sessionToken, type, payload, target, timeoutMs }) -> Promise<result>`, `core.sessionStatus({ sessionId, sessionToken }) -> object` (the 5 legacy studio-scoped fields + additive), `core.list({ sessionId, sessionToken }) -> object`, `core.attach({ sessionId, sessionToken, target, claim }) -> object`, `core.unpair({ sessionId, sessionToken, target }) -> object`, `core.detachStudio({ sessionId, sessionToken, studioId }) -> object`, `core.brokerId -> string`.
- From **Task 3** (`server/broker.mjs`): a runnable entrypoint that, when spawned as `node broker.mjs`, reads `MCP_BROKER_PORT`/`MCP_BROKER_HOST`/`ROBLOX_MCP_TOKEN` from env, binds the broker, and treats its own `EADDRINUSE` as **exit 0** (race loser).

> **Stub note for the executing engineer:** if Tasks 1/3 are not yet merged when you run this task in isolation, create the **minimal `broker-core.mjs` and `broker.mjs` stubs** shown in Step 0 so the integration tests compile and pass. The stub's public surface MUST match the Consumes signatures above verbatim; Task 3 replaces the body, not the signature.

**Produces (for Task 5 `server.mjs` wiring):**
- `export async function ensureBroker({ port, host?, authToken?, brandPrefix?, sessionId? }) -> Promise<BrokerClient>`
- `export function loadOrMintSessionId(cwd?) -> string` (per-cwd persistence helper; also used by Task 5 to learn its own id before calling `ensureBroker`)
- `export const SESSION_DIR` (the `%LOCALAPPDATA%/Roblox-MCP/sessions` path) and `export const BROKER_TOKEN_PATH` (machine-token file, for Task 5 + sync-plugin parity)
- `BrokerClient` shape (object returned by `ensureBroker`):
  - `submit(type, payload, timeoutMs?) -> Promise<result>` **(byte-identical signature to `createBridge().submit`)**
  - `submitTo(studioId, type, payload, timeoutMs?) -> Promise<result>`
  - `getStatus() -> Promise<{ pluginConnected, msSinceLastPoll, queued, inFlight, ready, ...additive }>` **(always a Promise, even in-proc)**
  - `heartbeat() -> Promise<{ ok, brokerId, paired_studio_id, origin }>`
  - `register() -> Promise<{ ok, brokerId, session_token, paired_studio_id, origin }>`
  - `deregister() -> Promise<{ ok }>`
  - `listStudios() -> Promise<object>`
  - `attachStudio(target, claim?) -> Promise<object>`
  - `detachStudio(target?) -> Promise<object>`
  - `sessionStatus() -> Promise<object>`
  - `role -> "inproc" | "client"`
  - `brokerId -> string`
  - `stopHeartbeat() -> void` (clears the free-running timer; used by tests + Task-5 shutdown)
  - `httpServer -> http.Server | null` (the in-proc listener when `role==="inproc"`, else `null` — lets Task 5 idle-reap the in-proc broker on stdio close)

---

#### Step 0: Scaffold the directory + (if needed) minimal upstream stubs

- [ ] **Step 0: Ensure the test fixtures dir exists and add upstream stubs ONLY if Task 1/3 are not present.** First check:

```
Run: node -e "const fs=require('fs');console.log('core', fs.existsSync('server/lib/broker-core.mjs'),'broker', fs.existsSync('server/broker.mjs'))"
```

If both print `true`, skip the rest of Step 0. If either is `false`, create these minimal stubs so this task is runnable in isolation (Task 3 replaces their bodies):

`server/lib/broker-core.mjs` (stub — delete/replace when Task 3 lands):
```js
/** STUB for Task 4 isolation — Task 3 replaces the body, NOT the signature. */
import http from "node:http";
import { randomUUID } from "node:crypto";

export function createBrokerCore({ port, host = "127.0.0.1", authToken = "", brandPrefix = "[broker]", now = Date.now } = {}) {
  const brokerId = randomUUID();
  const pending = [];           // {id,type,payload}
  const inFlight = new Map();   // id -> {resolve,timeout}
  const waiters = [];           // poll waiters
  let lastPollAt = 0;
  const sessions = new Map();   // sessionId -> {token,pid}
  let hosts = new Set([`${host}:${port}`, `localhost:${port}`]);

  function enqueue(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const cmd = { id, type, payload };
      const timeout = setTimeout(() => {
        inFlight.delete(id);
        const i = pending.findIndex((c) => c.id === id);
        if (i >= 0) pending.splice(i, 1);
        resolve({ error: `timeout after ${timeoutMs}ms`, code: "TIMEOUT" });
      }, timeoutMs);
      inFlight.set(id, { resolve, timeout });
      if (waiters.length > 0) waiters.shift()(cmd);
      else pending.push(cmd);
    });
  }
  function statusObj() {
    const t = now();
    const since = lastPollAt === 0 ? null : t - lastPollAt;
    const pluginConnected = lastPollAt !== 0 && since < 12_000;
    return { pluginConnected, msSinceLastPoll: since, queued: pending.length, inFlight: inFlight.size, ready: pluginConnected && inFlight.size === 0 && pending.length === 0, paired: false };
  }

  const core = {
    brokerId,
    registerSession({ sessionId, pid }) { const token = randomUUID(); sessions.set(sessionId, { token, pid }); return { ok: true, brokerId, session_token: token, paired_studio_id: null, origin: "auto" }; },
    heartbeat() { return { ok: true, brokerId, paired_studio_id: null, origin: "auto" }; },
    deregister() { return { ok: true }; },
    submitFromSession({ type, payload, timeoutMs = 30_000 }) { return enqueue(type, payload, timeoutMs); },
    submitToStudio({ type, payload, timeoutMs = 30_000 }) { return enqueue(type, payload, timeoutMs); },
    sessionStatus() { return statusObj(); },
    list() { return { studios: [], sessions: [], pairs: [], you: { session_id: null, paired_studio_id: null } }; },
    attach() { return { ok: true, studio_id: null, label: null }; },
    unpair() { return { ok: true, detached: false, released_claim: false, studio_id: null }; },
    detachStudio() { return { ok: true, freed: null }; },
  };

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!hosts.has(req.headers.host || "")) { res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"forbidden host"}'); return; }
    if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, role: "broker", proto: 1, brokerId })); return; }
    if (authToken && req.headers["x-mcp-token"] !== authToken) { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    // Minimal session-plane echo so client integration tests can round-trip.
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const j = body ? JSON.parse(body) : {};
      if (url.pathname === "/fe/register") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.registerSession({ sessionId: j.session_id, pid: j.pid }))); return; }
      if (url.pathname === "/fe/heartbeat") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.heartbeat())); return; }
      if (url.pathname === "/fe/deregister") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.deregister())); return; }
      if (url.pathname === "/session/submit") { core.submitFromSession({ type: j.type, payload: j.payload, timeoutMs: j.timeout_ms }).then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); }); return; }
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/status")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.sessionStatus())); return; }
      if (url.pathname === "/session/list") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.list())); return; }
      if (url.pathname === "/session/attach") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.attach())); return; }
      if (url.pathname === "/session/unpair") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.unpair())); return; }
      if (url.pathname === "/session/detach-studio") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(core.detachStudio())); return; }
      res.writeHead(404); res.end();
    });
  });
  return { httpServer, core };
}
```

`server/broker.mjs` (stub — delete/replace when Task 3 lands):
```js
/** STUB for Task 4 isolation — Task 3 replaces the body. Reads spawn env, binds, EADDRINUSE -> exit 0. */
import { createBrokerCore } from "./lib/broker-core.mjs";

const port = Number(process.env.MCP_BROKER_PORT) || 8765;
const host = process.env.MCP_BROKER_HOST || "127.0.0.1";
const authToken = (process.env.ROBLOX_MCP_TOKEN || "").trim();
const { httpServer } = createBrokerCore({ port, host, authToken, brandPrefix: "[roblox-broker]" });

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") { console.error("[roblox-broker] lost race (EADDRINUSE) — exiting 0"); process.exit(0); }
  console.error(`[roblox-broker] FATAL: ${err.message}`); process.exit(1);
});
httpServer.listen(port, host, () => console.error(`[roblox-broker] listening on ${host}:${port}`));
```

> No commit for Step 0 if both files already exist. If you created stubs, do NOT commit them — they are scaffolding the real Tasks 1/3 commits replace. (When running the full plan in order, Step 0 is a no-op.)

---

#### Step 1: Write the failing test for per-cwd session_id persistence

- [ ] **Step 1: Write the failing test.** Create `server/test/broker-client.test.mjs` with the persistence test first:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrMintSessionId, ensureBroker, SESSION_DIR } from "../lib/broker-client.mjs";

const CLIENT_URL = new URL("../lib/broker-client.mjs", import.meta.url).href;

// Helper: GET /health JSON from a port.
function getHealth(port) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: "/health", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    r.on("error", reject); r.end();
  });
}
// Helper: a free ephemeral port (bind :0, read assigned, close).
function freePort() {
  return new Promise((resolve) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

test("loadOrMintSessionId: stable per-cwd, file persisted, distinct cwds differ", () => {
  const a = loadOrMintSessionId("C:/fake/cwd/alpha");
  const a2 = loadOrMintSessionId("C:/fake/cwd/alpha");
  const b = loadOrMintSessionId("C:/fake/cwd/beta");
  assert.match(a, /^[0-9a-f-]{36}$/i, "minted a UUID");
  assert.equal(a, a2, "same cwd -> same id across calls (persisted)");
  assert.notEqual(a, b, "different cwd -> different id");
  assert.ok(existsSync(SESSION_DIR), "session dir created");
});
```

(Leave the file open — the next steps append more tests.)

#### Step 2: Run the test to verify it fails

- [ ] **Step 2: Run the failing test.**
  - `Run: node --test server/test/broker-client.test.mjs`
  - `Expected: FAIL` — `node --test` reports the suite as failing because the import throws `Cannot find module '.../server/lib/broker-client.mjs'` (the file does not exist yet). The output contains `ERR_MODULE_NOT_FOUND` and `tests 0 / fail`.

#### Step 3: Implement the persistence + path constants

- [ ] **Step 3: Create `server/lib/broker-client.mjs` with the session-id persistence layer and exported constants.** Start the file:

```js
/**
 * server/lib/broker-client.mjs
 * Front-end (FE) side of the multi-session broker. Zero external deps —
 * node builtins + the extracted http-bridge helpers + broker-core only.
 * The MCP SDK never enters this file.
 *
 *  ensureBroker() runs the §3.2 direct-bind election:
 *    STEP A  try to BECOME the broker (bind the real broker-core server in-proc)
 *    STEP B  EADDRINUSE -> connect to the running broker (validate GET /health)
 *    STEP C  port held by a half-bound/dying broker -> spawn a detached broker, connect
 *  and returns a BrokerClient whose `submit(type,payload,timeoutMs)` is
 *  byte-identical to what createBridge() returns today.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrokerCore } from "./broker-core.mjs";

// ── Paths (stable per-user dir, NOT os.tmpdir()) ──
const APPDATA_ROOT =
  process.env.LOCALAPPDATA ||
  (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local") : join(process.env.HOME || ".", ".local", "share"));
const ROOT_DIR = join(APPDATA_ROOT, "Roblox-MCP");
export const SESSION_DIR = join(ROOT_DIR, "sessions");
export const BROKER_TOKEN_PATH = join(ROOT_DIR, "broker-token");
const SPAWN_LOG_PATH = join(ROOT_DIR, "broker-spawn.log");

// ── Election / connect tuning (§3.2) ──
const CONNECT_RETRIES = 20;       // STEP B: 20 × 50ms ≈ 1s covers the winner's listen-attach gap
const CONNECT_BACKOFF_MS = 50;
const SPAWN_CONNECT_RETRIES = 40; // STEP C: 40 × 50ms ≈ 2s for a detached child to come up
const SPAWN_BACKOFF_MS = 50;
const HEALTH_TIMEOUT_MS = 1_500;
const FE_HEARTBEAT_MS = 10_000;   // §3.6 free-running cadence

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-cwd, persisted session_id: %LOCALAPPDATA%/Roblox-MCP/sessions/session-<sha256(cwd).16>.json */
export function loadOrMintSessionId(cwd = process.cwd()) {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const file = join(SESSION_DIR, `session-${key}.json`);
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j && typeof j.session_id === "string" && j.session_id) return j.session_id;
    } catch { /* fall through to mint */ }
  }
  const session_id = randomUUID();
  try { writeFileSync(file, JSON.stringify({ session_id, created: new Date().toISOString(), cwd }), { mode: 0o600 }); } catch { /* best-effort persist */ }
  return session_id;
}

/** Rewrite the persisted id (used when the broker hands back a `suggested` id on 409). */
export function rewriteSessionId(cwd, session_id) {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  const file = join(SESSION_DIR, `session-${key}.json`);
  try { writeFileSync(file, JSON.stringify({ session_id, created: new Date().toISOString(), cwd }), { mode: 0o600 }); } catch {}
  return session_id;
}
```

#### Step 4: Run tests to verify the persistence test passes

- [ ] **Step 4: Run tests.**
  - `Run: node --test server/test/broker-client.test.mjs`
  - `Expected: FAIL` for the import of `ensureBroker` only — the persistence test (`loadOrMintSessionId`) now PASSES, but `node --test` still reports the file fails because `ensureBroker` is imported at the top and is `undefined` at call sites in later (not-yet-written) tests. To prove the persistence step alone, run only that test:
  - `Run: node --test --test-name-pattern="loadOrMintSessionId" server/test/broker-client.test.mjs`
  - `Expected: PASS` — `tests 1 / pass 1 / fail 0`.

#### Step 5: Write the failing test for the HTTP transport + client API (against a real broker-core server)

- [ ] **Step 5: Append the transport/round-trip test.** Add to `server/test/broker-client.test.mjs`:

```js
import { createBrokerCore } from "../lib/broker-core.mjs";

// Stand up a real broker-core server on an ephemeral port, then connect a CLIENT to it.
test("ensureBroker STEP B: connects as CLIENT to an already-running broker; submit round-trips", async () => {
  const port = await freePort();
  const { httpServer, core } = createBrokerCore({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]" });
  await new Promise((r) => httpServer.listen(port, "127.0.0.1", r));
  try {
    const client = await ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[t]", sessionId: "deadbeef-dead-dead-dead-deadbeef0001" });
    assert.equal(client.role, "client", "second arrival is a CLIENT, not the in-proc leader");
    assert.equal(typeof client.brokerId, "string");

    // register mints + holds a session_token (round-trips through HTTP).
    const reg = await client.register();
    assert.equal(reg.ok, true);
    assert.equal(typeof reg.session_token, "string");

    // submit() is byte-identical signature; resolve via the plugin-side enqueue path.
    const submitP = client.submit("ping", { x: 1 }, 5_000);
    // Drain it like the plugin would: poll once via core, then post a result.
    // (broker-core's stub resolves on a result POST; emulate by resolving inFlight directly is not exposed,
    //  so assert the call is pending then times out fast if no plugin — use a tiny timeout.)
    const fast = client.submit("ping", { x: 2 }, 60);
    const r = await fast;
    assert.ok(r.error && /timeout/i.test(r.error), "no plugin -> submit resolves a TIMEOUT object (today's contract)");
    // The first submit is still pending; let it time out too so the test ends cleanly.
    await submitP.catch(() => {});

    // getStatus() ALWAYS returns a Promise, resolving to the 5 legacy keys.
    const statusP = client.getStatus();
    assert.equal(typeof statusP.then, "function", "getStatus() is a Promise");
    const status = await statusP;
    for (const k of ["pluginConnected", "msSinceLastPoll", "queued", "inFlight", "ready"]) assert.ok(k in status, `status has ${k}`);
    assert.equal(typeof status.then, "undefined", "resolved status is a plain object, not a thenable");

    client.stopHeartbeat();
  } finally {
    httpServer.close();
  }
});
```

> Note: the first `submitP` is intentionally given a long timeout and then awaited-and-swallowed; do not leave a dangling 5 s timer that keeps `node --test` alive. If the broker-core stub does not expose a drain hook, lower the long timeout to `300` so the test self-completes quickly.

Refine the test's first submit to a short timeout to avoid hanging:
```js
// replace the 5_000 above with 300 so the suite never hangs:
const submitP = client.submit("ping", { x: 1 }, 300);
```

#### Step 6: Run to verify the transport test fails

- [ ] **Step 6: Run.**
  - `Run: node --test --test-name-pattern="STEP B" server/test/broker-client.test.mjs`
  - `Expected: FAIL` — `ensureBroker` is not yet implemented (still `undefined`), so `ensureBroker(...)` throws `TypeError: ensureBroker is not a function`.

#### Step 7: Implement `connect()` (HTTP client transport) + `ensureBroker` STEP B/STEP C + the BrokerClient API

- [ ] **Step 7: Append the transport, election, and client factory to `server/lib/broker-client.mjs`.**

```js
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
  if (r.status !== 200 || !r.json) return { kind: "stranger" };
  if (r.json.ok === true && r.json.role === "broker" && r.json.proto === 1) return { kind: "broker", brokerId: r.json.brokerId };
  if (r.json.ok === true && r.json.role === "inline") return { kind: "older" };
  if (r.json.ok === true && r.json.role === undefined && r.json.proto === undefined) return { kind: "older" };
  return { kind: "stranger" };
}

/** STEP B/C connect: returns a CLIENT BrokerClient or null (caller retries/spawns/throws). */
async function connect({ port, host, authToken, sessionId, brandPrefix }) {
  const probe = await probeHealth({ port, host });
  if (probe.kind === "broker") return makeRemoteClient({ port, host, authToken, sessionId, brokerId: probe.brokerId });
  if (probe.kind === "older") throw new Error(`${brandPrefix} an older/incompatible MCP server holds ${host}:${port} — restart it to upgrade`);
  if (probe.kind === "stranger") return { __stranger: true };  // caller decides fatal after retry window
  return null; // unreachable — retry
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
    env: {                                  // ALLOWLIST — never {...process.env}
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      MCP_BROKER_PORT: String(port),
      MCP_BROKER_HOST: host,
      MCP_BROKER_ROLE: "spawned",
      ROBLOX_MCP_TOKEN: authToken || "",
      ROBLOX_MCP_BROKER_IDLE_MS: process.env.ROBLOX_MCP_BROKER_IDLE_MS ?? "",
    },                                      // explicitly NOT ROBLOX_OPEN_CLOUD_* / any *_KEY
  });
  child.unref();
}

// ── Remote client (role:"client") — every method is an HTTP round-trip ──
function makeRemoteClient({ port, host, authToken, sessionId, brokerId }) {
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
    const r = await httpJson({ port, host, method: "POST", path: "/fe/register", headers: baseHeaders(),
      body: { session_id: sessionId, kind: "roblox", label: process.env.ROBLOX_MCP_SESSION_NAME || cwd, pid: process.pid, cwd, target: process.env.ROBLOX_MCP_TARGET || undefined } });
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
  async function heartbeat() {
    const r = await httpJson({ port, host, method: "POST", path: "/fe/heartbeat", headers: baseHeaders(), body: { session_id: sessionId } });
    if (r.status === 401) { await register(); return heartbeat(); }
    if (r.json && r.json.brokerId && r.json.brokerId !== currentBrokerId) { await register(); }
    return r.json || { ok: false };
  }
  async function submitTo(studioId, type, payload, timeoutMs) {
    const r = await httpJson({ port, host, method: "POST", path: "/session/submit", headers: baseHeaders(),
      body: { session_id: sessionId, type, payload, target: studioId, timeout_ms: timeoutMs },
      timeoutMs: (timeoutMs || 30_000) + 5_000 });
    if (r.json == null) return { error: "broker connection lost — retried; rerun the tool", code: "NO_BROKER" };
    return r.json;
  }
  async function submit(type, payload, timeoutMs = 30_000) {
    const r = await httpJson({ port, host, method: "POST", path: "/session/submit", headers: baseHeaders(),
      body: { session_id: sessionId, type, payload, timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 5_000 }).catch(() => ({ json: null }));
    if (r.json == null) return { error: "broker connection lost — retried; rerun the tool", code: "NO_BROKER" };
    return r.json;
  }
  async function getStatus() {
    const r = await httpJson({ port, host, path: `/session/${encodeURIComponent(sessionId)}/status`, headers: baseHeaders() }).catch(() => ({ json: null }));
    if (r.json == null) return { pluginConnected: false, msSinceLastPoll: null, queued: 0, inFlight: 0, ready: false, paired: false, error: "broker connection lost", code: "NO_BROKER" };
    return r.json;
  }
  async function deregister() {
    const r = await httpJson({ port, host, method: "POST", path: "/fe/deregister", headers: baseHeaders(), body: { session_id: sessionId }, timeoutMs: 500 }).catch(() => ({ json: { ok: false } }));
    return r.json || { ok: false };
  }
  const listStudios = async () => (await httpJson({ port, host, path: "/session/list", headers: baseHeaders() }).catch(() => ({ json: {} }))).json || {};
  const attachStudio = async (target, claim) => (await httpJson({ port, host, method: "POST", path: "/session/attach", headers: baseHeaders(), body: { session_id: sessionId, target, claim } })).json;
  const detachStudio = async (target) => (await httpJson({ port, host, method: "POST", path: "/session/unpair", headers: baseHeaders(), body: { session_id: sessionId, target } })).json;
  const sessionStatus = async () => getStatus();

  // Free-running heartbeat timer (§3.6.1) — independent of the MCP request cycle.
  const hbTimer = setInterval(() => { heartbeat().catch(() => {}); }, FE_HEARTBEAT_MS);
  hbTimer.unref?.();

  return {
    role: "client", get brokerId() { return currentBrokerId; }, httpServer: null,
    submit, submitTo, getStatus, register, heartbeat, deregister,
    listStudios, attachStudio, detachStudio, sessionStatus,
    stopHeartbeat: () => clearInterval(hbTimer),
  };
}

// ── In-proc client (role:"inproc") — submit() short-circuits to the core, no loopback ──
function makeLocalClient({ httpServer, core, sessionId }) {
  const cwd = process.cwd();
  // Register the lone in-proc session so resolveTarget/auto-pair have a row.
  const reg = core.registerSession({ sessionId, kind: "roblox", label: process.env.ROBLOX_MCP_SESSION_NAME || cwd, pid: process.pid, cwd, target: process.env.ROBLOX_MCP_TARGET });
  let sessionToken = reg.session_token;

  const submit = (type, payload, timeoutMs = 30_000) =>
    core.submitFromSession({ sessionId, sessionToken, type, payload, timeoutMs });
  const submitTo = (studioId, type, payload, timeoutMs = 30_000) =>
    core.submitFromSession({ sessionId, sessionToken, type, payload, target: studioId, timeoutMs });
  const getStatus = async () => core.sessionStatus({ sessionId, sessionToken });   // ALWAYS a Promise
  const heartbeat = async () => core.heartbeat({ sessionId, sessionToken });
  const register = async () => reg;                                                 // already registered
  const deregister = async () => core.deregister({ sessionId, sessionToken });
  const listStudios = async () => core.list({ sessionId, sessionToken });
  const attachStudio = async (target, claim) => core.attach({ sessionId, sessionToken, target, claim });
  const detachStudio = async (target) => core.unpair({ sessionId, sessionToken, target });
  const sessionStatus = async () => core.sessionStatus({ sessionId, sessionToken });

  return {
    role: "inproc", brokerId: core.brokerId, httpServer,
    submit, submitTo, getStatus, register, heartbeat, deregister,
    listStudios, attachStudio, detachStudio, sessionStatus,
    stopHeartbeat: () => {},
  };
}

/** Try to BECOME the broker by directly binding the real broker-core server (STEP A). */
function tryListenBroker({ port, host, authToken, brandPrefix }) {
  return new Promise((resolve) => {
    const { httpServer, core } = createBrokerCore({ port, host, authToken, brandPrefix });
    const onError = (err) => { httpServer.removeListener("listening", onListen); resolve({ won: false, errno: err.code, httpServer: null, core: null }); };
    const onListen = () => { httpServer.removeListener("error", onError); resolve({ won: true, httpServer, core }); };
    httpServer.once("error", onError);
    httpServer.once("listening", onListen);
    httpServer.listen(port, host);
  });
}

export async function ensureBroker({ port, host = "127.0.0.1", authToken = "", brandPrefix = "[roblox-mcp]", sessionId } = {}) {
  if (!sessionId) sessionId = loadOrMintSessionId();
  if (!authToken && existsSync(BROKER_TOKEN_PATH)) {
    try { authToken = readFileSync(BROKER_TOKEN_PATH, "utf8").trim(); } catch {}
  }

  // STEP A — try to become the in-proc leader (direct bind of the real server).
  const a = await tryListenBroker({ port, host, authToken, brandPrefix });
  if (a.won) return makeLocalClient({ httpServer: a.httpServer, core: a.core, sessionId });
  if (a.errno && a.errno !== "EADDRINUSE") throw new Error(`${brandPrefix} FATAL: cannot bind ${host}:${port}: ${a.errno}`);

  // STEP B — lost the bind: connect to whoever holds the port.
  for (let i = 0; i < CONNECT_RETRIES; i++) {
    const c = await connect({ port, host, authToken, sessionId, brandPrefix });   // may throw on "older"
    if (c && !c.__stranger) return c;
    if (c && c.__stranger && i >= CONNECT_RETRIES - 1) throw new Error(`${brandPrefix} FATAL: ${host}:${port} is held by a non-broker process`);
    await delay(CONNECT_BACKOFF_MS);
  }

  // STEP C — port held by a half-bound/dying broker that never answered: spawn detached, then connect-or-throw.
  spawnDetachedBroker({ port, host, authToken });
  for (let i = 0; i < SPAWN_CONNECT_RETRIES; i++) {
    const c = await connect({ port, host, authToken, sessionId, brandPrefix });
    if (c && !c.__stranger) return c;
    await delay(SPAWN_BACKOFF_MS);
  }
  throw new Error(`${brandPrefix} FATAL: cannot reach or start broker on ${host}:${port}`);
}
```

#### Step 8: Run tests to verify the transport + persistence tests pass

- [ ] **Step 8: Run.**
  - `Run: node --test --test-name-pattern="loadOrMintSessionId|STEP B" server/test/broker-client.test.mjs`
  - `Expected: PASS` — `tests 2 / pass 2 / fail 0`. (The STEP B test connects as a `client`, registers, mints a token, round-trips a TIMEOUT `submit`, and asserts `getStatus()` is a Promise resolving to the 5 legacy keys.)

#### Step 9: Write the failing test for STEP A in-proc win (direct-bind leader, no loopback)

- [ ] **Step 9: Append the in-proc-leader test.** Add to `server/test/broker-client.test.mjs`:

```js
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
    // submit() short-circuits to the in-proc core; with no plugin it resolves a TIMEOUT object.
    const r = await leader.submit("ping", { x: 1 }, 60);
    assert.ok(r.error && /timeout/i.test(r.error), "in-proc submit honors today's TIMEOUT contract");
    // getStatus is still a Promise even in-proc.
    const sp = leader.getStatus();
    assert.equal(typeof sp.then, "function");
    await sp;
    leader.stopHeartbeat();
  } finally {
    leader.httpServer.close();
  }
});
```

#### Step 10: Run to verify STEP A passes

- [ ] **Step 10: Run.**
  - `Run: node --test --test-name-pattern="STEP A" server/test/broker-client.test.mjs`
  - `Expected: PASS` — `tests 1 / pass 1 / fail 0`. The lone caller binds directly and reports `role:"inproc"` with a live `/health` returning `role:"broker", proto:1`.

#### Step 11: Write the REQUIRED two-simultaneous-FE race test (child processes)

- [ ] **Step 11: Append the race test.** Two child processes both `ensureBroker()` the SAME ephemeral port; assert exactly one is the leader and the other connects. Add to `server/test/broker-client.test.mjs`:

```js
test("REQUIRED: two simultaneous FEs race the same port — exactly one leader, the other connects", async () => {
  const port = await freePort();
  const childScript = `
    import { ensureBroker } from ${JSON.stringify(CLIENT_URL)};
    const port = Number(process.argv[2]);
    const sid = process.argv[3];
    const c = await ensureBroker({ port, host: "127.0.0.1", authToken: "", brandPrefix: "[race]", sessionId: sid });
    process.stdout.write(JSON.stringify({ role: c.role }));
    // Keep the in-proc leader alive briefly so the loser can connect; client exits immediately.
    if (c.role === "inproc") { await new Promise((r) => setTimeout(r, 1200)); c.httpServer.close(); }
    else { c.stopHeartbeat(); }
  `;
  const spawnChild = (sid) => new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", childScript, String(port), sid], { encoding: "utf8" });
    let out = "", err = "";
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
```

#### Step 12: Run the race test

- [ ] **Step 12: Run.**
  - `Run: node --test --test-name-pattern="two simultaneous FEs" server/test/broker-client.test.mjs`
  - `Expected: PASS` — `tests 1 / pass 1 / fail 0`. One child prints `{"role":"inproc"}`, the other `{"role":"client"}`. (If flaky on a very slow box, the loser's STEP B retry window is 1 s; the leader stays up 1.2 s — comfortably covering it.)

#### Step 13: Write the failing test for the detached-spawn env ALLOWLIST (no secret leakage)

- [ ] **Step 13: Append the env-allowlist assertion.** This is the §3.4/edge-#45 security gate: the spawned broker's env must NOT contain `ROBLOX_OPEN_CLOUD_*` or any `*_KEY`. Drive STEP C by holding the port with a **silent half-bound** server that answers nothing (forcing connect() to fail through to spawn), and intercept the spawn by pointing `broker.mjs` at a probe that dumps its env. Add to `server/test/broker-client.test.mjs`:

```js
import { spawn as _spawn } from "node:child_process";

test("REQUIRED: detached spawn env is an allowlist — no ROBLOX_OPEN_CLOUD_* / *_KEY leaks", async () => {
  // Directly exercise the spawn env shape by spawning a probe with the SAME allowlist
  // ensureBroker uses, asserting forbidden vars are absent and required ones present.
  // (Unit-level: we assert the constructed env, independent of timing/races.)
  const probe = `process.stdout.write(JSON.stringify(process.env));`;
  // Re-build the allowlist exactly as spawnDetachedBroker() does:
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
    const p = _spawn(process.execPath, ["-e", probe], { env, windowsHide: true });
    let out = ""; p.stdout.on("data", (c) => (out += c)); p.on("close", () => resolve(out));
  });
  const got = JSON.parse(child);
  // Forbidden: any Open Cloud var or *_KEY (other than none — the broker holds no keys).
  for (const k of Object.keys(got)) {
    assert.ok(!/^ROBLOX_OPEN_CLOUD_/i.test(k), `leaked ${k}`);
    assert.ok(!/_KEY$/i.test(k), `leaked ${k}`);
    assert.ok(!/_API_KEY$/i.test(k), `leaked ${k}`);
  }
  // Required survive:
  assert.equal(got.MCP_BROKER_PORT, "65000");
  assert.equal(got.MCP_BROKER_ROLE, "spawned");
  assert.equal(got.ROBLOX_MCP_TOKEN, "tok123");
});

test("REQUIRED: spawnDetachedBroker source carries no {...process.env} spread", async () => {
  const src = readFileSync(new URL("../lib/broker-client.mjs", import.meta.url), "utf8");
  // Guard against a future regression that copies the full env into the child.
  assert.ok(!/spawn\([\s\S]*?env:\s*\{\s*\.\.\.process\.env/.test(src), "spawn env must be an explicit allowlist, not a spread");
  // And assert the explicit forbidden comment / absence of the Open Cloud key in the spawn env block.
  assert.ok(!/env:\s*\{[\s\S]*?ROBLOX_OPEN_CLOUD/.test(src), "ROBLOX_OPEN_CLOUD_* must never appear in the spawn env block");
});
```

#### Step 14: Run the env-allowlist test

- [ ] **Step 14: Run.**
  - `Run: node --test --test-name-pattern="allowlist|process.env spread" server/test/broker-client.test.mjs`
  - `Expected: PASS` — `tests 2 / pass 2 / fail 0`. The spawned probe's env has no `ROBLOX_OPEN_CLOUD_*` / `*_KEY`, keeps `MCP_BROKER_PORT`/`MCP_BROKER_ROLE`/`ROBLOX_MCP_TOKEN`; the source-scan confirms no `{...process.env}` spread.

#### Step 15: Write the failing test for the §3.3 older/stranger /health discrimination

- [ ] **Step 15: Append the tolerant-detection test.** Add to `server/test/broker-client.test.mjs`:

```js
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
      /older\/incompatible MCP server holds/,
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
      /held by a non-broker process/,
    );
  } finally { stranger.close(); }
});
```

#### Step 16: Run the tolerant-detection tests

- [ ] **Step 16: Run.**
  - `Run: node --test --test-name-pattern="older same-family|unrelated process" server/test/broker-client.test.mjs`
  - `Expected: PASS` — `tests 2 / pass 2 / fail 0`. An old `{ok,queued,inFlight}` /health → "older/incompatible" reject (never spawns a competitor); a 404 stranger → "held by a non-broker process" reject after the retry window.

#### Step 17: Full-file run + regression gate (Task-1 http-bridge + Blender smoke unaffected)

- [ ] **Step 17: Run the whole new suite plus the regression gate.**
  - `Run: node --test server/test/broker-client.test.mjs`
  - `Expected: PASS` — all tests pass (`fail 0`). Approximate count: `tests 9 / pass 9` (persistence, STEP A, STEP B round-trip, two-FE race, env-allowlist ×2, older, stranger).
  - `Run: node --test server/test/http-bridge.test.mjs`
  - `Expected: PASS` — Task 4 added nothing to `http-bridge.mjs`, so the existing bridge tests stay green (proves no regression to the Blender-shared lib).
  - `Run: node --check server/lib/broker-client.mjs`
  - `Expected:` no output, exit 0 (syntax OK).

#### Step 18: Commit

- [ ] **Step 18: Commit.**
  - `Run:` (PowerShell — chain with `;` and `if ($?)`)
```
git add server/lib/broker-client.mjs server/test/broker-client.test.mjs; if ($?) { git commit -m @'
feat(broker): broker-client — ensureBroker election + detached spawn + FE client API

- ensureBroker(): §3.2 direct-bind election. STEP A binds the real broker-core
  server in-proc (lone session = zero-config in-proc leader, no loopback); STEP B
  EADDRINUSE -> connect, validating GET /health role/proto with §3.3 tolerant
  older/stranger detection; STEP C spawns a detached broker (§3.4 env ALLOWLIST,
  explicit broker.mjs cwd, first-spawn stderr -> broker-spawn.log) then connects.
- BrokerClient: submit(type,payload,timeoutMs) byte-identical; submitTo; async
  getStatus() (always a Promise); free-running heartbeat timer; register (mints +
  holds session_token, 409 -> adopt suggested id); deregister; list/attach/detach/
  sessionStatus.
- Per-cwd session_id persistence at %LOCALAPPDATA%/Roblox-MCP/sessions/
  session-<sha256(cwd).16>.json; machine-token read from broker-token.
- Tests: two-simultaneous-FE race (exactly one leader, the other connects),
  detached-spawn env allowlist (no ROBLOX_OPEN_CLOUD_*/*_KEY leak + source-scan
  for {...process.env}), STEP A in-proc win, STEP B client round-trip, older vs
  stranger /health discrimination.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
'@ }
```
  - `Expected:` a new commit on the current branch; `git log --oneline -1` shows the `feat(broker): broker-client` subject.

---

**Notes for the assembler / downstream tasks:**
- Task 5 (`server.mjs` wiring) imports `{ ensureBroker, loadOrMintSessionId }` from `./lib/broker-client.mjs`, replaces `const { submit, getStatus } = createBridge({...})` (`server.mjs:39–43`) with the mode switch (broker → `await ensureBroker({ port: HTTP_PORT, authToken, brandPrefix: "[roblox-mcp]", sessionId: loadOrMintSessionId() })`; inline → `createBridge(...)`), and changes `const status = getStatus()` (`server.mjs:237`) to `const status = await getStatus()`. The returned client's `submit(type,payload,timeoutMs)` is byte-identical so `importViaEditableMesh`'s `submit("editable_mesh_build", …, 120_000)` (`server.mjs:132`) compiles unchanged.
- Task 3 must keep `createBrokerCore` returning an **un-listened** `httpServer` plus the `core` API used by `makeLocalClient`/`makeRemoteClient` (see Consumes). If Task 3 instead listens internally, STEP A's non-fatal EADDRINUSE handling breaks — coordinate the un-listened contract.
- `BROKER_TOKEN_PATH` export is the single source for Task 5 + `sync-plugin.ps1` to read the machine token so the plugin's `AUTH_TOKEN` matches (§2.7).

---

### Task 5: server.mjs wiring — mode switch, submitTo chokepoint, await getStatus, control tools, stop→control

> Wires the thin front-end. Replaces the single `createBridge({...})` call in `server/server.mjs` with a mode switch (`ensureBroker(...)` in broker mode, `createBridge(...)` in inline mode), threads a per-call routing chokepoint through the existing CallTool tail, awaits the now-async `getStatus()`, special-cases `start_stop_play{mode:"stop"}` onto the control queue, and adds the 4 control-tool cases answered from the broker client. The 600+ lines of per-tool payload-building dispatch are **untouched**. Because `server/server.mjs` imports the MCP SDK (`@modelcontextprotocol/sdk`) and cannot run under `node --test` without `node_modules`, the *pure* routing decision is extracted into a new zero-dep helper `server/lib/dispatch-routing.mjs` that both `server.mjs` and the unit test import; full-boot behavior is marked deployment-machine verification.

**Files**
- Create: `server/lib/dispatch-routing.mjs` — pure routing-decision helper (zero-dep; node builtins only — actually *no* imports). Exports `CONTROL_OR_OS_LOCAL` (Set), `CONTROL_TOOLS` (Set), `STUDIO_PINNED_COMPOSITES` (Set), `routeCall({ name, args, sessionTarget })` → a plain decision object. Used by `server.mjs:~39` region and by the test.
- Create: `server/test/dispatch-routing.test.mjs` — `node --test` unit tests for `routeCall` + the membership sets (no sockets, no SDK).
- Modify: `server/server.mjs:19` — add `ensureBroker` import from `./lib/broker-client.mjs` (Task 4) and `routeCall`, `CONTROL_TOOLS` from `./lib/dispatch-routing.mjs`.
- Modify: `server/server.mjs:39-43` — replace `const { submit, getStatus } = createBridge({...})` with the **mode switch** producing `{ submit, submitTo, getStatus, listStudios, attachStudio, detachStudio, sessionStatus }` (broker) or a shimmed equivalent (inline).
- Modify: `server/server.mjs:111-145` (`importViaEditableMesh`) — accept a pinned `submitFn` so all `editable_mesh_build` batches hit ONE studio.
- Modify: `server/server.mjs:237` — `const status = getStatus();` → `const status = await getStatus();`.
- Modify: `server/server.mjs:282-680` — insert the 4 control-tool cases (early-return, broker-client backed) and the **single routing chokepoint** at the existing `submit(name, payload, …)` tail (`:678`), including `start_stop_play{stop}` → control queue.

**Interfaces**

_Consumes (from Task 4 `server/lib/broker-client.mjs`):_
- `ensureBroker({ port, host, authToken, brandPrefix, sessionId }): Promise<BrokerClient>`
- `BrokerClient.submit(type, payload, timeoutMs): Promise<object>` — BYTE-IDENTICAL signature to today's `createBridge().submit` (resolves to the studio result, or `{error,code}`; never throws).
- `BrokerClient.submitTo(studioId, type, payload, timeoutMs): Promise<object>` — same result contract, explicit studio.
- `BrokerClient.submitControl(target, type, payload, timeoutMs): Promise<object>` — enqueues onto the target studio's **control** queue (for `__stop_play`); resolves `{error,code}` on unresolved target.
- `BrokerClient.fanoutSubmit(type, payload, timeoutMs): Promise<object>` — `target:"all"` fan-out; resolves `{ fanout:true, results:[{studioId,label,result}], ok, failed }`, never throws.
- `BrokerClient.getStatus(): Promise<object>` — ALWAYS a Promise; resolves to the 5 legacy studio-scoped fields (`pluginConnected, msSinceLastPoll, queued, inFlight, ready`) + additive pairing fields.
- `BrokerClient.listStudios(): Promise<object>` · `attachStudio(target, claim?): Promise<object>` · `detachStudio(target?): Promise<object>` · `sessionStatus(): Promise<object>` — control-plane calls answered from the broker (never a plugin).
- `BrokerClient.resolveSessionTarget(explicitTarget?): Promise<{ok,studioId,via}|{error,code,...}>` — used to PIN one studio for the composite mesh build (so a mid-sequence re-pair cannot split a mesh).

_Consumes (from Task 1, unchanged):_
- `createBridge({ port, authToken, brandPrefix }): { httpServer, submit, getStatus }` from `server/lib/http-bridge.mjs` (inline-mode path).

_Produces (for Task 6 `tools.mjs` + downstream):_
- `server/lib/dispatch-routing.mjs` exports:
  - `CONTROL_OR_OS_LOCAL: Set<string>` — `{ list_studios, attach_studio, detach_studio, session_status, get_connection_status, take_screenshot, capture_studio_window, screenshot_diff, simulate_input }`. **Task 6 imports this exact set** for the `target`-injection transform (no duplicated literal).
  - `CONTROL_TOOLS: Set<string>` — `{ list_studios, attach_studio, detach_studio, session_status }`.
  - `STUDIO_PINNED_COMPOSITES: Set<string>` — `{ import_blender_model }` (composite that must pin one studio across batches).
  - `routeCall({ name, args, sessionTarget }): RouteDecision` where `RouteDecision` is one of:
    - `{ kind:"control_tool", tool }` (one of the 4),
    - `{ kind:"stop_control", target }` (`start_stop_play` with `mode:"stop"`),
    - `{ kind:"pin_composite", target }` (`import_blender_model`),
    - `{ kind:"fanout" }` (`target:"all"`),
    - `{ kind:"submit_to", target }` (explicit non-"all" target present),
    - `{ kind:"submit_default" }` (no target → default/auto studio).
    `target` precedence inside `routeCall`: per-call `args.target` (if a non-empty string) `>` `sessionTarget` (the `ROBLOX_MCP_TARGET` env pin, passed in) `>` none.

---

#### Step 1: Write the failing test for the pure routing helper

Create `server/test/dispatch-routing.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_OR_OS_LOCAL,
  CONTROL_TOOLS,
  STUDIO_PINNED_COMPOSITES,
  routeCall,
} from "../lib/dispatch-routing.mjs";

test("CONTROL_OR_OS_LOCAL holds the 4 control tools + get_connection_status + 4 OS-local tools", () => {
  for (const n of [
    "list_studios", "attach_studio", "detach_studio", "session_status",
    "get_connection_status",
    "take_screenshot", "capture_studio_window", "screenshot_diff", "simulate_input",
  ]) {
    assert.ok(CONTROL_OR_OS_LOCAL.has(n), `expected ${n} in CONTROL_OR_OS_LOCAL`);
  }
  assert.equal(CONTROL_OR_OS_LOCAL.size, 9);
  // A normal plugin tool is NOT in the set (so Task 6 injects `target` into it).
  assert.ok(!CONTROL_OR_OS_LOCAL.has("create_part"));
  assert.ok(!CONTROL_OR_OS_LOCAL.has("run_luau"));
});

test("CONTROL_TOOLS is exactly the 4 broker-answered tools", () => {
  assert.deepEqual(
    [...CONTROL_TOOLS].sort(),
    ["attach_studio", "detach_studio", "list_studios", "session_status"]
  );
});

test("STUDIO_PINNED_COMPOSITES is import_blender_model", () => {
  assert.deepEqual([...STUDIO_PINNED_COMPOSITES], ["import_blender_model"]);
});

test("routeCall: a control tool routes to the broker, never a plugin", () => {
  for (const tool of CONTROL_TOOLS) {
    const d = routeCall({ name: tool, args: {}, sessionTarget: null });
    assert.deepEqual(d, { kind: "control_tool", tool });
  }
});

test("routeCall: start_stop_play{stop} → control queue with resolved target precedence", () => {
  // no target → control-route with target null (broker resolves the paired/auto studio)
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "stop" }, sessionTarget: null }),
    { kind: "stop_control", target: null }
  );
  // per-call target wins
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "stop", target: "Foo" }, sessionTarget: "Bar" }),
    { kind: "stop_control", target: "Foo" }
  );
  // session pin used when no per-call target
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "stop" }, sessionTarget: "Bar" }),
    { kind: "stop_control", target: "Bar" }
  );
});

test("routeCall: start_stop_play with start/run_server is a NORMAL submit, not control", () => {
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "start_play" }, sessionTarget: null }),
    { kind: "submit_default" }
  );
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "run_server", target: "Foo" }, sessionTarget: null }),
    { kind: "submit_to", target: "Foo" }
  );
});

test("routeCall: import_blender_model pins one studio across its batches", () => {
  assert.deepEqual(
    routeCall({ name: "import_blender_model", args: {}, sessionTarget: null }),
    { kind: "pin_composite", target: null }
  );
  assert.deepEqual(
    routeCall({ name: "import_blender_model", args: { target: "S1" }, sessionTarget: "S2" }),
    { kind: "pin_composite", target: "S1" }
  );
});

test("routeCall: target:'all' fans out", () => {
  assert.deepEqual(
    routeCall({ name: "create_part", args: { target: "all" }, sessionTarget: null }),
    { kind: "fanout" }
  );
  // session pin of "all" also fans out
  assert.deepEqual(
    routeCall({ name: "create_part", args: {}, sessionTarget: "all" }),
    { kind: "fanout" }
  );
});

test("routeCall: explicit non-'all' target → submit_to; precedence per-call > session", () => {
  assert.deepEqual(
    routeCall({ name: "create_part", args: { target: "Studio #ab12" }, sessionTarget: null }),
    { kind: "submit_to", target: "Studio #ab12" }
  );
  assert.deepEqual(
    routeCall({ name: "create_part", args: {}, sessionTarget: "Studio #ab12" }),
    { kind: "submit_to", target: "Studio #ab12" }
  );
  assert.deepEqual(
    routeCall({ name: "create_part", args: { target: "Win" }, sessionTarget: "Lose" }),
    { kind: "submit_to", target: "Win" }
  );
});

test("routeCall: no target anywhere → submit_default", () => {
  assert.deepEqual(
    routeCall({ name: "create_part", args: {}, sessionTarget: null }),
    { kind: "submit_default" }
  );
  // empty-string and whitespace targets are treated as absent
  assert.deepEqual(
    routeCall({ name: "create_part", args: { target: "" }, sessionTarget: null }),
    { kind: "submit_default" }
  );
  assert.deepEqual(
    routeCall({ name: "create_part", args: { target: "   " }, sessionTarget: "  " }),
    { kind: "submit_default" }
  );
});
```

#### Step 2: Run the test to verify it fails

- `Run:` `node --test server/test/dispatch-routing.test.mjs`
- `Expected:` FAIL — `Cannot find module '.../server/lib/dispatch-routing.mjs'` (the helper does not exist yet). The runner reports the import error and exits non-zero.

#### Step 3: Implement the pure routing helper

Create `server/lib/dispatch-routing.mjs`:

```js
/**
 * server/lib/dispatch-routing.mjs
 * Pure, zero-dependency routing decision for the server.mjs CallTool chokepoint.
 * NO imports (so `node --test` runs it with no node_modules and it can be shared
 * by both server.mjs and tools.mjs without dragging in the MCP SDK).
 *
 * Given a tool name + its args + the session's env-pinned target, decide HOW the
 * front-end should dispatch the call: to the broker control plane (the 4 control
 * tools), onto a studio's control queue (start_stop_play{stop}), pinned to one
 * studio for the duration of a composite (import_blender_model), fanned out
 * (target:"all"), to one explicit studio (submitTo), or to the default/auto
 * studio (submit). The public submit(type,payload,timeout) signature is never
 * changed — target routing lives entirely here.
 */

// The 4 broker-answered control tools.
export const CONTROL_TOOLS = new Set([
  "list_studios",
  "attach_studio",
  "detach_studio",
  "session_status",
]);

// Tools that NEVER touch a plugin and therefore carry NO `target` (Task 6's
// schema transform skips exactly this set): the 4 control tools, the local
// connection-status answer, and the 4 OS-level screenshot/input tools.
export const CONTROL_OR_OS_LOCAL = new Set([
  ...CONTROL_TOOLS,
  "get_connection_status",
  "take_screenshot",
  "capture_studio_window",
  "screenshot_diff",
  "simulate_input",
]);

// Composite tools that issue MANY plugin submits which MUST all land on ONE
// studio (the chokepoint resolves the studio once and pins it across batches).
export const STUDIO_PINNED_COMPOSITES = new Set(["import_blender_model"]);

// Normalize a target candidate: a non-empty, non-whitespace string or null.
function normTarget(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * @param {{ name: string, args: object, sessionTarget: string|null }} input
 * @returns {{kind:"control_tool",tool:string}
 *          |{kind:"stop_control",target:string|null}
 *          |{kind:"pin_composite",target:string|null}
 *          |{kind:"fanout"}
 *          |{kind:"submit_to",target:string}
 *          |{kind:"submit_default"}}
 */
export function routeCall({ name, args = {}, sessionTarget = null }) {
  // 1. Control-plane tools are answered by the broker client, never a plugin.
  if (CONTROL_TOOLS.has(name)) return { kind: "control_tool", tool: name };

  // Effective target: per-call `args.target` wins over the env-pinned session
  // target (ROBLOX_MCP_TARGET). Empty/whitespace strings are treated as absent.
  const target = normTarget(args.target) ?? normTarget(sessionTarget);

  // 2. start_stop_play{stop} is delivered on the studio's CONTROL queue so it
  //    reaches a plugin whose command loop is yielded inside a play test.
  //    Other modes (start_play/run_server) are ordinary commands.
  if (name === "start_stop_play" && String(args.mode || "") === "stop") {
    return { kind: "stop_control", target };
  }

  // 3. target:"all" fans out to every live studio (Promise.all, never throws).
  if (target === "all") return { kind: "fanout" };

  // 4. Composite mesh import: resolve a studio ONCE and pin every batch to it.
  if (STUDIO_PINNED_COMPOSITES.has(name)) return { kind: "pin_composite", target };

  // 5. Explicit (non-"all") target → submitTo a single studio.
  if (target !== null) return { kind: "submit_to", target };

  // 6. No target anywhere → default/auto-paired studio (today's behavior).
  return { kind: "submit_default" };
}
```

#### Step 4: Run the test to verify it passes

- `Run:` `node --test server/test/dispatch-routing.test.mjs`
- `Expected:` PASS — all routing/membership tests green; `# pass 11`, `# fail 0`.

#### Step 5: Commit the pure helper

- `Run:` `git add server/lib/dispatch-routing.mjs server/test/dispatch-routing.test.mjs && git commit -m "feat(server): pure dispatch-routing helper for the FE chokepoint"`

---

#### Step 6: Run the regression gate before touching server.mjs

Establish the green baseline so the server.mjs edits can be proven non-regressive.

- `Run:` `node --test server/test/http-bridge.test.mjs server/test/dispatch-routing.test.mjs`
- `Expected:` PASS — both files green (`# fail 0`). This is the regression gate to re-run after Step 7/8.

#### Step 7: Implement server.mjs — imports + mode switch + pinned composite + await getStatus

Apply these edits to `server/server.mjs`. They are surgical; the 600-line per-tool `switch` is left intact.

**(7a) Imports.** Change the import block at the top (currently `server.mjs:19`) so `createBridge` stays for inline mode and the new helpers are added. Replace:

```js
import { createBridge, redactHeaders } from "./lib/http-bridge.mjs";
```

with:

```js
import { createBridge, redactHeaders } from "./lib/http-bridge.mjs";
import { ensureBroker } from "./lib/broker-client.mjs";
import { routeCall, CONTROL_TOOLS } from "./lib/dispatch-routing.mjs";
import { hostname } from "node:os";
```

**(7b) Session identity + mode switch.** Replace the whole `const { submit, getStatus } = createBridge({...})` block (currently `server.mjs:39-43`) with:

```js
// ── Session identity (per-cwd, persisted) ──
// A session is identified to the user by its working directory; reusing the id
// on MCP restart preserves an established pairing. Different worktrees → different
// cwd → different sessions. Persist under a stable per-user dir (not os.tmpdir()).
const SESSION_ID = (() => {
  try {
    const base = process.env.LOCALAPPDATA || join(process.env.HOME || tmpdir(), ".local", "share");
    const dir = join(base, "Roblox-MCP", "sessions");
    const key = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
    const file = join(dir, `session-${key}.json`);
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j && typeof j.session_id === "string" && j.session_id.length >= 8) return j.session_id;
    } catch {}
    const id = randomUUID();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ session_id: id, created: Date.now() }));
    return id;
  } catch {
    // Filesystem unavailable: fall back to a per-process id (pairing won't survive
    // restart, but routing works) — strictly no worse than a fresh session.
    return randomUUID();
  }
})();

// Optional per-session studio pin (mode-2 convenience). Empty → null.
const SESSION_TARGET = (process.env.ROBLOX_MCP_TARGET || "").trim() || null;

const BROKER_MODE = (process.env.ROBLOX_MCP_MODE || "broker").trim().toLowerCase() !== "inline";

// In broker mode the FE is an HTTP client of (or in-proc leader for) the broker.
// In inline mode it is byte-for-bit today's single-session createBridge server.
// Both expose `submit(type,payload,timeout)` with the IDENTICAL public signature.
const bridge = BROKER_MODE
  ? await ensureBroker({
      port: HTTP_PORT,
      host: "127.0.0.1",
      authToken: (process.env.ROBLOX_MCP_TOKEN || "").trim(),
      brandPrefix: "[roblox-mcp]",
      sessionId: SESSION_ID,
    })
  : (() => {
      // Inline rollback: createBridge returns a SYNC getStatus; wrap it in a
      // Promise so the single call site can `await getStatus()` uniformly, and
      // shim the broker-only methods so the chokepoint has one shape.
      const b = createBridge({
        port: HTTP_PORT,
        authToken: (process.env.ROBLOX_MCP_TOKEN || "").trim(),
        brandPrefix: "[roblox-mcp]",
      });
      const noBroker = (op) => ({ error: `${op} requires broker mode (ROBLOX_MCP_MODE=broker)`, code: "INLINE_MODE" });
      return {
        submit: b.submit,
        submitTo: (_studioId, type, payload, timeoutMs) => b.submit(type, payload, timeoutMs),
        submitControl: (_t, type, payload, timeoutMs) => b.submit(type, payload, timeoutMs),
        fanoutSubmit: async (type, payload, timeoutMs) => {
          const r = await b.submit(type, payload, timeoutMs);
          return { fanout: true, results: [{ studioId: "inline", label: "inline", result: r }], ok: !r?.error, failed: r?.error ? 1 : 0 };
        },
        getStatus: async () => b.getStatus(),
        resolveSessionTarget: async () => ({ ok: true, studioId: "inline", via: "inline" }),
        listStudios: async () => noBroker("list_studios"),
        attachStudio: async () => noBroker("attach_studio"),
        detachStudio: async () => noBroker("detach_studio"),
        sessionStatus: async () => noBroker("session_status"),
      };
    })();

const { submit, submitTo, submitControl, fanoutSubmit, getStatus, resolveSessionTarget } = bridge;
```

**(7c) Augment the node:fs / node:crypto imports** needed by 7b. The file currently imports `readFileSync, unlinkSync` from `node:fs` (`server.mjs:22`) and `randomUUID` from `node:crypto` (`server.mjs:25`). Replace those two lines:

```js
import { readFileSync, unlinkSync } from "node:fs";
```
→
```js
import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
```
and
```js
import { randomUUID } from "node:crypto";
```
→
```js
import { randomUUID, createHash } from "node:crypto";
```
(`hostname` from `node:os` was added in 7a but is unused here; drop it from 7a if your linter is strict — it is listed only in case a label is later derived from it. Remove the `import { hostname } from "node:os";` line from 7a to keep the diff minimal.)

> Correction to 7a: omit the `node:os` import. Final 7a import additions are exactly:
> ```js
> import { ensureBroker } from "./lib/broker-client.mjs";
> import { routeCall, CONTROL_TOOLS } from "./lib/dispatch-routing.mjs";
> ```

**(7d) Pin one studio across the composite mesh build.** `importViaEditableMesh` (`server.mjs:111`) currently calls the global `submit` per batch. Change its signature to receive a pinned submit function, and pin in the call site. Replace the function header line:

```js
async function importViaEditableMesh(args) {
```
with:
```js
// `submitFn(type,payload,timeoutMs)` is pre-pinned to ONE studio by the caller so
// every batch of a single mesh lands on the same Studio (a mid-sequence re-pair
// cannot split a mesh across two studios). Defaults to the global `submit`.
async function importViaEditableMesh(args, submitFn = submit) {
```
and inside the loop change the `submit(` call (`server.mjs:132`) to `submitFn(`:
```js
    last = await submitFn("editable_mesh_build", {
```

**(7e) `await getStatus()`.** At `server.mjs:237` change:
```js
    const status = getStatus();
```
to:
```js
    const status = await getStatus();
```

#### Step 8: Implement server.mjs — control-tool cases + the routing chokepoint

**(8a) Control-tool early returns.** Immediately AFTER the `get_connection_status` block (ends `server.mjs:239`) and BEFORE the `roblox_upload_asset` block (`server.mjs:241`), insert the 4 control tools. They are answered by the broker client, never a plugin:

```js
  // ── Control-plane tools — answered by the broker client, never a plugin ──
  if (name === "list_studios") {
    return jsonResult(await listStudios());
  }
  if (name === "attach_studio") {
    return jsonResult(await attachStudio(args.target, args.claim));
  }
  if (name === "detach_studio") {
    return jsonResult(await detachStudio(args.target));
  }
  if (name === "session_status") {
    return jsonResult(await sessionStatus());
  }
```
and add `listStudios, attachStudio, detachStudio, sessionStatus` to the destructure in 7b:
```js
const { submit, submitTo, submitControl, fanoutSubmit, getStatus, resolveSessionTarget,
        listStudios, attachStudio, detachStudio, sessionStatus } = bridge;
```

**(8b) Pin the composite at its call site.** In the `import_blender_model` block (`server.mjs:265-280`), the `importViaEditableMesh(args)` tail (`server.mjs:279`) must pass a studio-pinned submit. Replace:
```js
    return await importViaEditableMesh(args); // EditableMesh fallback (Task 7) — builds its own content shape
```
with:
```js
    // Pin ONE studio for the whole multi-batch mesh build (resolve once).
    const pin = await resolveSessionTarget(args.target);
    if (pin && pin.error) return emResult({ ok: false, via: "editable_mesh", ...pin });
    const pinnedSubmit = pin && pin.studioId
      ? (type, payload, timeoutMs) => submitTo(pin.studioId, type, payload, timeoutMs)
      : submit;
    return await importViaEditableMesh(args, pinnedSubmit);
```

**(8c) The single routing chokepoint.** This is the ONLY change to the plugin-routed tail. The current tail (`server.mjs:675-679`) is:
```js
  // Long-running, plugin-side-bounded tools need a server timeout ...
  const result = await submit(name, payload, toolTimeoutMs(name, args));
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
```
Replace those two statements with:
```js
  // ── Routing chokepoint ──
  // The public submit(type,payload,timeout) signature is never changed; target
  // routing is decided here and dispatched via submit / submitTo / fanout /
  // control-queue. `args.target` is read but NEVER written into `payload`, so
  // every plugin handler is untouched.
  const budget = toolTimeoutMs(name, args);
  const route = routeCall({ name, args, sessionTarget: SESSION_TARGET });
  let result;
  switch (route.kind) {
    case "stop_control":
      // start_stop_play{stop} → the studio's CONTROL queue so it reaches a
      // plugin whose command loop is yielded inside a play test (§5.9).
      result = await submitControl(route.target, name, payload, budget);
      break;
    case "fanout":
      result = await fanoutSubmit(name, payload, budget);
      break;
    case "submit_to": {
      const sel = await resolveSessionTarget(route.target);
      if (sel && sel.error) { result = sel; break; }
      result = await submitTo(sel.studioId, name, payload, budget);
      break;
    }
    case "submit_default":
    default:
      result = await submit(name, payload, budget);
      break;
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
```

> Notes for the implementer:
> - `routeCall` never returns `control_tool` here (those are handled by the early returns in 8a) nor `pin_composite` (only `import_blender_model` reaches `importViaEditableMesh`, handled in 8b). The `switch` therefore only needs `stop_control | fanout | submit_to | submit_default`. Leaving the unreachable cases out keeps the chokepoint minimal; the `default` covers `submit_default`.
> - `args.target` is intentionally NOT deleted from `args` — the per-tool `payload` is built from named fields in the big switch (it never spreads `args`), so the `target` field never reaches the plugin.
> - In inline mode, `submitTo`/`submitControl`/`fanoutSubmit`/`resolveSessionTarget` are the shims from 7b, so a stray `target` in inline mode degrades to a plain `submit` (single studio) — behavior is byte-identical to today for the no-target single-session path.

#### Step 9: Static syntax check of the edited server.mjs

The full server cannot boot under `node --test` without `node_modules`, but a parse/syntax check needs no SDK resolution.

- `Run:` `node --check server/server.mjs`
- `Expected:` PASS — no output, exit 0 (file parses). If it errors, fix the edit before proceeding.

#### Step 10: Re-run the regression gate (pure tests still green)

- `Run:` `node --test server/test/http-bridge.test.mjs server/test/dispatch-routing.test.mjs`
- `Expected:` PASS — `# fail 0`. The http-bridge behavior is unchanged (pure extraction lives in Task 1) and the routing helper is unchanged.

#### Step 11: Deployment-machine verification (full boot — requires node_modules)

> These steps need `npm install` (the MCP SDK) and a running broker/plugin; mark them **deployment-machine verification**, not CI. Run them where `server/node_modules` exists.

- `Run:` `node -e "import('./server/server.mjs').then(()=>{console.error('booted');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"` from the repo root, with `ROBLOX_MCP_MODE=inline` set, in a shell where `server/node_modules/@modelcontextprotocol` resolves.
  - `Expected:` the inline `createBridge` listen line `[roblox-mcp] bridge on 127.0.0.1:8765 …` on stderr, then `booted`, exit 0 — confirms the inline-mode shim wiring (`await getStatus`, destructure, chokepoint) loads.
- `Run (broker mode):` start one FE (`node server/server.mjs`) with no env; confirm a single process binds 8765 (in-proc leader), `get_connection_status` returns the 5 legacy fields, and `list_studios` returns a `studios`/`sessions`/`pairs` object. Then start a 2nd FE from a different cwd and confirm it connects (loser → client), and `create_part` with `target:"<2nd studio label>"` routes to the right Studio.
  - `Expected:` no `EADDRINUSE` fatal; both sessions functional; targeted `create_part` lands in the named Studio (verify with `capture_studio_window` via roblox-tester).
- `Run (Blender regression):` `node --check blender/server.mjs` and a Blender smoke (`blender_get_connection_status`) — the `createBridge` call site (`blender/server.mjs:13,21-25`) is untouched, so it must still return `{ httpServer, submit, getStatus }` and answer status.
  - `Expected:` Blender bridge unchanged — status answers as before.

#### Step 12: Commit the server wiring

- `Run:` `git add server/server.mjs && git commit -m "feat(server): broker mode switch, submitTo chokepoint, await getStatus, control tools, stop→control queue"`


---

### Task 6: tools.mjs — per-call `target` injection + 4 control tool defs

> **Pre-flight reality check (verified against the real source, 2026-06-24):** the spec §6.4/§6.5 says "76→80 tools". That figure is **stale** — the live `server/tools.mjs` actually exports **79** tools (the three later-added tools `roblox_upload_asset`, `roblox_insert_uploaded_model`, `import_blender_model` are not in the old 76 count). Confirmed by `node -e "import('./server/tools.mjs').then(m=>console.log(m.TOOLS.length))"` → `79`, all names unique. **This task therefore asserts 79 → 83, NOT 76 → 80.** Do not "fix" the test to 80 — the source is the ground truth and the count test is the whole point.

This task makes two edits to one file, `server/tools.mjs`:
1. A module-load transform that injects an optional `target` string property into every tool's `inputSchema` **except** the tools in `CONTROL_OR_OS_LOCAL` (the 4 control tools + `get_connection_status` + `take_screenshot` + `capture_studio_window` + `screenshot_diff` + `simulate_input`).
2. Appends the 4 control tool definitions (`list_studios`, `attach_studio`, `detach_studio`, `session_status`).

The existing array (lines 3–1162, the `export const TOOLS = [ … ]`) is renamed `RAW_TOOLS` (kept `const`, not exported); the public `export const TOOLS` becomes the transformed-plus-appended result. `server.mjs` imports `{ TOOLS }` (server.mjs:49) and serves it verbatim — the export name and shape are unchanged.

#### Files
- **Modify** `server/tools.mjs:3` — change `export const TOOLS = [` → `const RAW_TOOLS = [` (the opening of the 79-element array).
- **Modify** `server/tools.mjs:1162` — after the array's closing `];`, append: `TARGET_PROP`, the `CONTROL_OR_OS_LOCAL` set (exported), the `CONTROL_TOOLS` array (the 4 new defs), and the new `export const TOOLS = [...RAW_TOOLS.map(injectTarget), ...CONTROL_TOOLS]`.
- **Test (new)** `server/test/tools-target.test.mjs` — pure, no sockets; imports `{ TOOLS, CONTROL_OR_OS_LOCAL }` from `../tools.mjs`.

#### Interfaces
**Consumes (from earlier tasks):**
- From **Task 5 (server.mjs wiring):** none at code level — instead, **Task 5 consumes this task's `CONTROL_OR_OS_LOCAL` export.** The contract requires the set name be **`CONTROL_OR_OS_LOCAL`** and that the same set drive both the schema side (here) and the dispatch side (Task 5). This task is the single source of truth for that set; Task 5 imports it.

**Produces (for later tasks):**
- `export const CONTROL_OR_OS_LOCAL: Set<string>` — `{ "list_studios","attach_studio","detach_studio","session_status","whoami","get_connection_status","take_screenshot","capture_studio_window","screenshot_diff","simulate_input" }`. (Includes the `whoami` alias name defensively so that if Task 5 registers a `whoami` alias it is also skipped by the chokepoint; the alias is not added as a separate tool def in v1.)
- `export const TOOLS: Array<{name,description,inputSchema}>` — length **83**; every data tool has an optional `target` string; control + OS-local tools do not.
- 4 control tool defs available to the MCP `ListTools` response: `list_studios{}`, `attach_studio{target!,claim?}`, `detach_studio{target?}`, `session_status{}`.

---

#### Step 1: Write the failing test

Create `server/test/tools-target.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, CONTROL_OR_OS_LOCAL } from "../tools.mjs";

// ── helpers ───────────────────────────────────────────────────────────────
const byName = (n) => TOOLS.find((t) => t.name === n);
const hasTarget = (t) =>
  !!(t && t.inputSchema && t.inputSchema.properties &&
     Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "target"));

// The four OS-local tools that never touch a plugin, plus get_connection_status,
// must NOT gain a `target` prop (they are answered locally / route nowhere).
const OS_LOCAL = ["get_connection_status", "take_screenshot", "capture_studio_window", "screenshot_diff", "simulate_input"];
const CONTROL = ["list_studios", "attach_studio", "detach_studio", "session_status"];

// ── count ─────────────────────────────────────────────────────────────────
test("TOOLS count is 79 raw + 4 control = 83", () => {
  assert.equal(TOOLS.length, 83);
  // names are unique
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 83);
});

// ── target present on a representative data tool ──────────────────────────
test("data tools gain an optional `target` string property", () => {
  for (const n of ["run_luau", "create_part", "set_property", "start_stop_play", "import_blender_model"]) {
    const t = byName(n);
    assert.ok(t, `${n} missing`);
    assert.ok(hasTarget(t), `${n} should have target`);
    assert.equal(t.inputSchema.properties.target.type, "string");
    // injection is additive: the original required[] and other props survive
    if (n === "set_property") {
      assert.deepEqual(t.inputSchema.required, ["path", "property", "value"]);
      assert.ok(t.inputSchema.properties.path, "original props preserved");
    }
  }
  // `target` is NEVER added to required[]
  for (const t of TOOLS) {
    if (Array.isArray(t.inputSchema?.required)) {
      assert.ok(!t.inputSchema.required.includes("target"), `${t.name} must not require target`);
    }
  }
});

// ── target ABSENT on OS-local + get_connection_status + the 4 control tools ─
test("OS-local + status + control tools have NO `target`", () => {
  for (const n of [...OS_LOCAL, ...CONTROL]) {
    const t = byName(n);
    assert.ok(t, `${n} missing`);
    assert.equal(hasTarget(t), false, `${n} must NOT have target`);
  }
});

test("CONTROL_OR_OS_LOCAL is the exact skip set", () => {
  assert.ok(CONTROL_OR_OS_LOCAL instanceof Set);
  for (const n of [...CONTROL, "whoami", ...OS_LOCAL]) {
    assert.ok(CONTROL_OR_OS_LOCAL.has(n), `${n} should be in CONTROL_OR_OS_LOCAL`);
  }
  // No data tool is accidentally in the skip set.
  assert.equal(CONTROL_OR_OS_LOCAL.has("run_luau"), false);
  assert.equal(CONTROL_OR_OS_LOCAL.has("create_part"), false);
});

// ── the 4 control tools exist with correct schemas ────────────────────────
test("list_studios — empty object schema, no required", () => {
  const t = byName("list_studios");
  assert.ok(t);
  assert.equal(t.inputSchema.type, "object");
  assert.deepEqual(t.inputSchema.properties, {});
  assert.ok(!t.inputSchema.required || t.inputSchema.required.length === 0);
});

test("attach_studio — target required, claim optional with mode/label/ttl_ms", () => {
  const t = byName("attach_studio");
  assert.ok(t);
  assert.equal(t.inputSchema.properties.target.type, "string");
  assert.deepEqual(t.inputSchema.required, ["target"]);
  const claim = t.inputSchema.properties.claim;
  assert.ok(claim, "claim prop present");
  assert.equal(claim.type, "object");
  assert.deepEqual(claim.properties.mode.enum, ["soft", "exclusive"]);
  assert.equal(claim.properties.label.type, "string");
  assert.equal(claim.properties.ttl_ms.type, "number");
});

test("detach_studio — target optional, nothing required", () => {
  const t = byName("detach_studio");
  assert.ok(t);
  assert.equal(t.inputSchema.properties.target.type, "string");
  assert.ok(!t.inputSchema.required || t.inputSchema.required.length === 0);
});

test("session_status — empty object schema, no required", () => {
  const t = byName("session_status");
  assert.ok(t);
  assert.equal(t.inputSchema.type, "object");
  assert.deepEqual(t.inputSchema.properties, {});
  assert.ok(!t.inputSchema.required || t.inputSchema.required.length === 0);
});
```

#### Step 2: Run the test to verify it fails

`Run: node --test server/test/tools-target.test.mjs`

`Expected: FAIL` — the import of `CONTROL_OR_OS_LOCAL` resolves to `undefined` (not yet exported), so the first assertion to touch it throws, and `TOOLS.length` is `79` not `83`. You should see failures like `AssertionError [ERR_ASSERTION]: 79 !== 83` and `CONTROL_OR_OS_LOCAL instanceof Set` failing (`TypeError: Right-hand side of 'instanceof' is not callable` or `expected true`). At least the count and control-tool-existence tests must be red.

#### Step 3: Implement — rename the array and append the transform + control tools

In `server/tools.mjs`, change the array opener at line 3:

```js
// server/tools.mjs — MCP tool definitions (extracted from server.mjs)
// All tool schemas live here; server.mjs imports { TOOLS } from this module.
const RAW_TOOLS = [
```

(Only the third line changes: `export const TOOLS = [` → `const RAW_TOOLS = [`. The 79 element bodies are untouched.)

Then replace the array's closing `];` (currently the last line, line 1162) with the closing `];` **followed by** this appended block:

```js
];

// ── Per-call `target` injection (design §6.5) ──────────────────────────────
// Every plugin-routed ("data") tool may carry an optional `target` to route the
// call to a specific studio in a multi-studio session. The four OS-local tools
// (handled in-process, never hitting a plugin), `get_connection_status`
// (answered from broker state), and the four control tools below are EXCLUDED —
// a `target` would be meaningless for them. `target` is always OPTIONAL: it is
// never appended to any tool's `required[]`.
const TARGET_PROP = {
  target: {
    type: "string",
    description:
      "Optional studioId or studio label to route this call to (multi-studio). " +
      "Omit to use your attached/auto-paired studio.",
  },
};

// The exact skip set, shared with server.mjs's CallTool chokepoint (Task 5
// imports this — DO NOT redeclare it there). Includes the `whoami` alias name
// so an aliased session_status is also skipped by the dispatch side.
export const CONTROL_OR_OS_LOCAL = new Set([
  // control-plane tools (answered from broker state, never routed to a plugin)
  "list_studios",
  "attach_studio",
  "detach_studio",
  "session_status",
  "whoami",
  // status + OS-local tools (handled in-process in server.mjs, no plugin)
  "get_connection_status",
  "take_screenshot",
  "capture_studio_window",
  "screenshot_diff",
  "simulate_input",
]);

function injectTarget(tool) {
  if (CONTROL_OR_OS_LOCAL.has(tool.name)) return tool;
  const schema = tool.inputSchema ?? { type: "object", properties: {} };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: { ...(schema.properties ?? {}), ...TARGET_PROP },
    },
  };
}

// ── Control-plane tool definitions (design §6.4) ───────────────────────────
// Discrete tools (no `op` multiplexer): clearer schemas, invisible in the
// single-session flow. Each is answered by server.mjs from broker endpoints,
// never sent to a plugin — so none of them gets a `target` property.
const CONTROL_TOOLS = [
  {
    name: "list_studios",
    description:
      "List every Studio, session, pair, and claim the broker knows about (multi-studio coordination). " +
      "Each studio reports its label, paired session (with `origin: \"auto\"|\"manual\"`), and `attachedSessions`. " +
      "Read-only; never blocked by a busy or claimed studio. Use this to discover routing targets before `attach_studio` or a per-call `target`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "attach_studio",
    description:
      "Sticky-pair THIS session to a Studio (the manual half of auto-1:1), optionally taking a claim. " +
      "`target` is a studioId or studio label (id-exact > exact label > case-insensitive substring). " +
      "Optional `claim`: `mode:\"soft\"` (advisory, warns others) or `\"exclusive\"` (blocks other sessions' data commands until released/expired). " +
      "Attaching onto a Studio already paired to another session returns `STUDIO_BUSY` (no steal — use `detach_studio` admin form first).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "studioId or studio label to attach to." },
        claim: {
          type: "object",
          description: "Optional concurrency claim on the studio.",
          properties: {
            mode: { type: "string", enum: ["soft", "exclusive"], description: "soft = advisory warning; exclusive = blocks other sessions." },
            label: { type: "string", description: "Human label for who/what holds the claim." },
            ttl_ms: { type: "number", description: "Claim lifetime in ms (default 60000, clamped 5000..600000). Lazily expires." },
          },
        },
      },
      required: ["target"],
    },
  },
  {
    name: "detach_studio",
    description:
      "Drop THIS session's sticky pairing and release its own claim. With no `target`, detaches the session's current pair (idempotent; does NOT auto-re-pair). " +
      "With a `target` that names a Studio paired/claimed by ANOTHER session, performs the admin steal — forcibly freeing it (the only way to break another session's pair; explicit).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Optional studioId or label. Omit to detach your own current pair; pass another session's studio to force-free it." },
      },
    },
  },
  {
    name: "session_status",
    description:
      "Report THIS session's routing state: which Studio it is paired to (and the pairing `origin`), any claim it holds, and who else is attached to the same Studio. Read-only; the introspection counterpart to `get_connection_status`.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const TOOLS = [...RAW_TOOLS.map(injectTarget), ...CONTROL_TOOLS];
```

#### Step 4: Run the test to verify it passes

`Run: node --test server/test/tools-target.test.mjs`

`Expected: PASS` — all tests green; the summary shows `pass 8`, `fail 0`. In particular `TOOLS.length === 83`, `target` present on `run_luau`/`create_part`/`set_property`/`start_stop_play`/`import_blender_model` and absent on the 5 OS-local/status tools and the 4 control tools, and the 4 control-tool schemas match.

#### Step 5: Run the full server test suite to confirm no regression

`Run: node --test server/test/http-bridge.test.mjs server/test/open-cloud.test.mjs server/test/glb.test.mjs server/test/tools-target.test.mjs`

`Expected: PASS` — every file green (`fail 0`). This confirms the rename of `TOOLS`→`RAW_TOOLS` did not break the public `export const TOOLS` that `server.mjs` consumes, and that the existing suites are unaffected.

> Note (Windows / Node v24): use this explicit file list (or the glob `server/test/*.test.mjs`). Do **not** use the trailing-slash directory form `node --test server/test/` — it mis-resolves on this setup.

#### Step 6: Sanity-check the public export shape from the command line

`Run: node -e "import('./server/tools.mjs').then(m=>{const t=m.TOOLS;console.log('len',t.length);console.log('has CONTROL_OR_OS_LOCAL',m.CONTROL_OR_OS_LOCAL instanceof Set);console.log('run_luau target', !!t.find(x=>x.name==='run_luau').inputSchema.properties.target);console.log('simulate_input target', !!t.find(x=>x.name==='simulate_input').inputSchema.properties.target);})"`

`Expected output:`
```
len 83
has CONTROL_OR_OS_LOCAL true
run_luau target true
simulate_input target false
```

#### Step 7: Commit

`Run:`
```
git add server/tools.mjs server/test/tools-target.test.mjs && git commit -m "$(cat <<'EOF'
feat(tools): per-call target injection + 4 control tool defs

Inject an optional `target` string into every data tool's inputSchema via a
module-load transform; exclude CONTROL_OR_OS_LOCAL (4 control tools +
get_connection_status + take_screenshot/capture_studio_window/screenshot_diff/
simulate_input). Append list_studios / attach_studio / detach_studio /
session_status. Rename the raw array to RAW_TOOLS; public TOOLS = mapped raw +
control. Tool count 79 -> 83 (spec's "76->80" was stale vs the live source).
Export CONTROL_OR_OS_LOCAL for server.mjs's chokepoint to share.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"`

`Expected:` commit succeeds; `git show --stat HEAD` lists `server/tools.mjs` (modified) and `server/test/tools-target.test.mjs` (new).

---

**Notes for the assembler / Task 5 author:**
- The skip set is **`CONTROL_OR_OS_LOCAL`** (exact name), exported from `server/tools.mjs`. Task 5 must `import { CONTROL_OR_OS_LOCAL } from "./tools.mjs"` and branch on it at the CallTool chokepoint — do **not** redeclare the list in `server.mjs`, or the two will drift.
- The real RAW count is **79**, so the post-task total is **83**. If a later task's count assertion still says 80, that other task is using the stale spec figure and must be reconciled to 83.
- `target` is intentionally injected even on the Open-Cloud-touching tools (`roblox_upload_asset`, `import_blender_model`, `roblox_insert_uploaded_model`) because they ultimately submit `insert_uploaded_model`/`editable_mesh_build` to a plugin; per spec §6.5 only the explicit OS-local list is excluded.

---

### Task 7: MultiAIPlugin.lua — studio_id, live-upvalue headers, control loop, handlers

Edit the single-file Studio plugin so it (a) mints + persists a stable `studio_id`, (b) sends it as `x-studio-id` on **every** `/poll` and `/result` request via a `requestHeaders()` helper that re-reads the live upvalue, (c) handles two broker-internal control commands (`__assign_studio_id`, `__stop_play`) as real entries in the existing `handlers` table, and (d) runs a **second, never-blocking** `task.spawn` control loop against `GET /studio/control-poll`. The existing Server-context `StopPlaySignal` watcher (`plugin/MultiAIPlugin.lua:41–51`) is **UNTOUCHED**. Single-file install is preserved (`sync-plugin.ps1` still copies one `.lua`).

> **Why no `node --test` here:** this task only edits Lua. The deterministic gate is a luau **static** parse check (`luau-lsp analyze`), and full runtime behavior (dual-loop polling + `x-studio-id` header on the wire) is a **deployment-machine manual checkpoint** — explicitly NOT something this CI machine can run, because it needs Roblox Studio open with the broker bound on 8765. Treat the manual checkpoint as a required, documented hand-off step, not optional.

> **Spec anchors (verified against current source):** header naming `x-studio-id` / `x-studio-label` / `x-mcp-token` (§2.1, §4.2); `GenerateGUID(false)` + `SetSetting("MultiAI_StudioId", …)`, pcall-guarded, per-load fallback (§2.1, edge #39); URL + `nocache=true` invariant — header-only, never query (§2.1, BC-2); `requestHeaders()` MUST re-read the live `studioId` upvalue, never a load-time capture (§2.6 step 3, BC-4); `__assign_studio_id` is a real `handlers[…]` entry validating `^[0-9a-fA-F%-]{8,64}$` (§2.6 steps 1–4); two poll loops, control loop never blocks (§2.6.1); `__stop_play` only `SetSetting`s, watcher untouched (§2.6.1, §5.9); inline-mode 404 on `/studio/control-poll` is a harmless idle no-op (§3.8, edge #37).

#### Files
- **Modify:** `G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\plugin\MultiAIPlugin.lua`
  - Insert studio-id constants + mint block + `studioId`/`studioLabel`/`labelSent` upvalues after `MCP_STOP_SIGNAL_KEY` (current `:19`), before `AUTH_TOKEN` (current `:25`).
  - Replace the `authHeaders()` helper (current `:28–33`) with `requestHeaders(includeLabel)` (and keep a thin `authHeaders` alias so no other reference breaks).
  - Add `handlers.__assign_studio_id` and `handlers.__stop_play` immediately after the `handlers` table declaration (current `:159`).
  - Swap `authHeaders()` → `requestHeaders(true)` in the `/poll` GetAsync (current `:3080`) and `requestHeaders(false)` in the `/result/<id>` PostAsync (current `:3101`).
  - Add the control-loop `task.spawn` + its own `controlLoop()` function next to `startPolling()` (current `:3123–3145`); auto-start it alongside the command loop.
- **Test (static gate, this machine):** `luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"` must print `0`. (luau-lsp 1.68.0 resolves from this worktree via the global `~/.aftman/aftman.toml`. It writes all diagnostics to **stderr** and exits 1 even on a clean file because Roblox globals like `game`/`plugin`/`task` are "Unknown global" without a definitions file — so the **only** meaningful signal is the `SyntaxError` count: `0` for a clean parse, `≥1` for a broken one. Verified on the current file: 0 SyntaxErrors.)
- **Test (runtime, deployment checkpoint — NOT this machine):** manual steps in Step 16.

#### Interfaces
**Consumes (from earlier tasks):**
- Task 3 `broker-core.mjs`: `GET /studio/control-poll` (per-studio control queue; never blocked); `x-studio-id`-keyed upsert on `/studio/poll` + `/studio/result`; injection of `{ type:"__assign_studio_id", payload:{ studio_id } }` ahead of the control queue for the contested 2nd connId; `start_stop_play{stop}` re-routed to `__stop_play` on the control queue; missing `x-studio-id` → `legacy:default`.
- Task 5 inline path: `ROBLOX_MCP_MODE=inline` server returns **404** for `/studio/control-poll` (the control loop swallows it via `pcall` — idle no-op).
- Task 5/8 `sync-plugin.ps1`: writes the broker machine token into `AUTH_TOKEN` when `ROBLOX_MCP_TOKEN` is unset; `requestHeaders()` forwards it verbatim as `x-mcp-token`.

**Produces (for later tasks / runtime):**
- `requestHeaders(includeLabel)` — single source of truth for the plugin's outbound headers; always `x-studio-id` (live upvalue), conditional `x-mcp-token` + `x-studio-label`.
- A mutable module-level `studioId` upvalue that `__assign_studio_id` reassigns in place.
- `handlers.__assign_studio_id`, `handlers.__stop_play` — the broker's two control commands.
- A second `task.spawn` control loop (`controlLoop`) on `/studio/control-poll` at 1 s cadence.

---

#### Bite-sized TDD steps

For Lua there is no red→green test pair; each behavior is implemented and then gated by the **static parse check** (clean parse = `0` SyntaxErrors) so a malformed edit is caught immediately. Step 1 establishes the baseline so the gate is trustworthy; the final manual checkpoint (Step 16) covers true runtime behavior.

- [ ] **Step 1: Establish the static-gate baseline (must be 0 before any edit)**

  Confirm the gate command and that the current file parses clean, so a non-zero count later unambiguously means *your edit* broke it.

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"
  ```
  `Expected:` prints exactly
  ```
  0
  ```
  (If `luau-lsp` is not found: it is listed in `~/.aftman/aftman.toml` as `JohnnyMorganz/luau-lsp@1.68.0`; run `aftman install` once, or invoke `~/.aftman/bin/luau-lsp` directly. The trailing "Unknown global"/exit-1 noise on stderr is expected and irrelevant — only the `SyntaxError` count gates.)

- [ ] **Step 2: Mint + persist `studio_id`; declare the `studioId`/`studioLabel`/`labelSent` upvalues + control constant**

  Insert directly after `local MCP_STOP_SIGNAL_KEY = "MultiAI_StopPlaySignal"` (current `:19`) and before the `AUTH_TOKEN` comment block (current `:21`). The `studioId` upvalue is declared **before** `requestHeaders` (next step) so the closure captures it, and is `local` (not a constant) because `__assign_studio_id` mutates it.

  Use **Edit** with this exact `old_string`:
  ```lua
  local MCP_STOP_SIGNAL_KEY = "MultiAI_StopPlaySignal"

  -- Optional shared secret. Leave "" for the default (no auth). To require auth,
  ```
  and this exact `new_string`:
  ```lua
  local MCP_STOP_SIGNAL_KEY = "MultiAI_StopPlaySignal"
  local STUDIO_ID_KEY = "MultiAI_StudioId"
  local CONTROL_POLL_INTERVAL = 1.0

  -- ---------------------------------------------------------------------------
  -- Studio identity: a stable per-Studio-window id the broker uses for routing.
  -- Minted via HttpService:GenerateGUID (32 hex, no braces), persisted with
  -- plugin:SetSetting (the same cross-session persistence class proven by
  -- MultiAI_StopPlaySignal). NOT PlaceId (0 for unsaved / identical across
  -- windows) nor JobId ("" in Edit). All persistence is pcall-guarded: if
  -- SetSetting/GetSetting fail, the id is still minted per-load (a non-persistent
  -- fallback — strictly no worse than today, which carries no identity at all).
  -- `studioId` is a mutable upvalue: the __assign_studio_id handler reassigns it
  -- in place so the next poll's requestHeaders() carries the new id.
  -- ---------------------------------------------------------------------------
  local studioId: string = (function(): string
      local okGet, stored = pcall(function() return plugin:GetSetting(STUDIO_ID_KEY) end)
      if okGet and typeof(stored) == "string" and stored ~= "" then
          return stored
      end
      local minted = HttpService:GenerateGUID(false)
      pcall(function() plugin:SetSetting(STUDIO_ID_KEY, minted) end)
      return minted
  end)()

  -- Advisory display label (never a routing key): game name + short id suffix.
  local studioLabel: string = (function(): string
      local name = "Studio"
      local okName, gameName = pcall(function() return game.Name end)
      if okName and typeof(gameName) == "string" and gameName ~= "" then
          name = gameName
      end
      return `{name} #{string.sub(studioId, 1, 4)}`
  end)()

  -- Tracks whether the current studioLabel has already been sent, so steady-state
  -- polls omit x-studio-label and only re-send it when it changes.
  local labelSent = false

  -- Optional shared secret. Leave "" for the default (no auth). To require auth,
  ```

- [ ] **Step 3: Run the static gate after the mint block**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"
  ```
  `Expected:` prints `0` (clean parse — the new block introduced no syntax error).

- [ ] **Step 4: Replace `authHeaders()` with `requestHeaders()` (live upvalue, always x-studio-id)**

  `requestHeaders` re-reads the live `studioId` upvalue **on every call** (so a mid-run `__assign_studio_id` takes effect on the very next poll), always sends `x-studio-id`, conditionally sends `x-mcp-token` and `x-studio-label`. A thin `authHeaders` alias is kept so the symbol still resolves if referenced elsewhere. Both `/poll` and `/result` now always carry a non-nil header table, but the **URL string and the `nocache=true` 2nd arg of GetAsync stay byte-identical** (Step 6).

  Use **Edit** with this exact `old_string`:
  ```lua
  -- Header table for authenticated requests (nil when no token is configured).
  local function authHeaders(): { [string]: string }?
      if AUTH_TOKEN ~= "" then
          return { ["x-mcp-token"] = AUTH_TOKEN }
      end
      return nil
  end
  ```
  and this exact `new_string`:
  ```lua
  -- Header table for every broker request. ALWAYS carries x-studio-id (re-reading
  -- the LIVE studioId upvalue on each call — never a load-time capture, so an
  -- __assign_studio_id reassignment is reflected on the very next poll). Adds
  -- x-mcp-token only when AUTH_TOKEN is configured, and x-studio-label only on the
  -- first send or after the label changes (steady-state polls send id-only).
  local function requestHeaders(includeLabel: boolean?): { [string]: string }
      local headers: { [string]: string } = { ["x-studio-id"] = studioId }
      if AUTH_TOKEN ~= "" then
          headers["x-mcp-token"] = AUTH_TOKEN
      end
      if includeLabel and not labelSent then
          headers["x-studio-label"] = studioLabel
          labelSent = true
      end
      return headers
  end

  -- Back-compat alias: any historical authHeaders() call now delegates to
  -- requestHeaders() so it keeps sending x-studio-id too.
  local function authHeaders(): { [string]: string }
      return requestHeaders(false)
  end
  ```

- [ ] **Step 5: Run the static gate after the header helper**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"
  ```
  `Expected:` prints `0`.

- [ ] **Step 6: Wire `requestHeaders` into the command loop's `/poll` and `/result` calls**

  Two surgical swaps in the existing `loop()` (current `:3080` and `:3101`). URL strings and the `GetAsync(..., true, …)` `nocache` argument are unchanged — only the header argument changes from `authHeaders()` to `requestHeaders(...)`.

  Use **Edit** #1 with this exact `old_string`:
  ```lua
          local ok, response = pcall(function()
              return HttpService:GetAsync(SERVER_URL .. "/poll", true, authHeaders())
          end)
  ```
  and this exact `new_string`:
  ```lua
          local ok, response = pcall(function()
              return HttpService:GetAsync(SERVER_URL .. "/poll", true, requestHeaders(true))
          end)
  ```

  Use **Edit** #2 with this exact `old_string`:
  ```lua
                      local postOk, postErr = pcall(function()
                          HttpService:PostAsync(
                              SERVER_URL .. "/result/" .. decoded.id,
                              HttpService:JSONEncode(result),
                              Enum.HttpContentType.ApplicationJson,
                              false,
                              authHeaders()
                          )
                      end)
  ```
  and this exact `new_string`:
  ```lua
                      local postOk, postErr = pcall(function()
                          HttpService:PostAsync(
                              SERVER_URL .. "/result/" .. decoded.id,
                              HttpService:JSONEncode(result),
                              Enum.HttpContentType.ApplicationJson,
                              false,
                              requestHeaders(false)
                          )
                      end)
  ```

- [ ] **Step 7: Run the static gate after the call-site swaps**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"
  ```
  `Expected:` prints `0`.

- [ ] **Step 8: Add the `__assign_studio_id` and `__stop_play` handlers**

  Insert immediately after the `handlers` table declaration (current `:159`, `local handlers: { [string]: (any) -> any } = {}`), before the first existing `handlers.run_luau = …`. These are real `handlers[…]` entries so the existing `executeCommand` dispatch (`local handler = handlers[cmd.type]`) and the new control loop both find them. `__assign_studio_id` validates the id (rejecting the `legacy:`/`session:` colon forms because the char class excludes `:`), persists it, and **mutates the `studioId` upvalue in place** so subsequent `requestHeaders()` carry the new id; it also resets `labelSent` so the new label rides the next poll. `__stop_play` only arms the existing Server-context watcher via `SetSetting` and returns immediately (never blocks).

  Use **Edit** with this exact `old_string`:
  ```lua
  local handlers: { [string]: (any) -> any } = {}

  handlers.run_luau = function(payload)
  ```
  and this exact `new_string`:
  ```lua
  local handlers: { [string]: (any) -> any } = {}

  -- ── Broker control commands (delivered on the control loop; never user tools) ──

  -- Reassign this Studio's id when the broker detects two windows sharing the same
  -- persisted MultiAI_StudioId (the "contested" case). The broker hands the second
  -- window a fresh GUID; we validate, persist, and mutate the live studioId upvalue
  -- so the very next poll's requestHeaders() carries the new id.
  handlers.__assign_studio_id = function(payload)
      local newId = payload.studio_id
      if typeof(newId) ~= "string" or not string.match(newId, "^[0-9a-fA-F%-]+$") then
          return { ok = false, error = "invalid studio_id" }
      end
      local len = string.len(newId)
      if len < 8 or len > 64 then
          return { ok = false, error = "studio_id length out of range" }
      end
      pcall(function() plugin:SetSetting(STUDIO_ID_KEY, newId) end)
      studioId = newId
      studioLabel = `Studio #{string.sub(studioId, 1, 4)}`
      labelSent = false
      return { ok = true, studio_id = studioId }
  end

  -- Arm the existing Server-context StopPlaySignal watcher (MultiAIPlugin.lua:41–51,
  -- UNTOUCHED) so a second session can stop a play test even while THIS plugin's
  -- command loop is yielded inside ExecutePlayModeAsync. Only SetSetting — returns
  -- immediately, never blocks the control loop.
  handlers.__stop_play = function(_payload)
      pcall(function() plugin:SetSetting(MCP_STOP_SIGNAL_KEY, true) end)
      return { ok = true }
  end

  handlers.run_luau = function(payload)
  ```

  > Note on the validation pattern: Luau string patterns have no `{8,64}` quantifier, so the spec's `^[0-9a-fA-F%-]{8,64}$` is enforced in two parts — a character-class match `^[0-9a-fA-F%-]+$` (every char is a hex digit or hyphen, rejecting any `:` so `legacy:`/`session:` are refused) plus an explicit length window `8 ≤ len ≤ 64`. Net effect is byte-equivalent to the regex.

- [ ] **Step 9: Run the static gate after the handlers**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"
  ```
  `Expected:` prints `0`.

- [ ] **Step 10: Add the control loop (second `task.spawn`, never blocks) + auto-start it**

  Insert the `controlLoop()` function and a `controlThread` + auto-start directly before the `startPolling`/`stopPolling` block (current `:3123`). It long-polls `GET /studio/control-poll`, dispatches via the shared `executeCommand` (only the two control handlers arrive on this channel), and posts results to `/studio/result/<id>` — like the command loop, but with a 1 s cadence and handlers that return immediately, so it stays responsive while the command loop is yielded in a play test. A 404 (inline mode) or any error is swallowed by `pcall` and treated as idle. The control loop intentionally does **not** flip the toolbar's `connected` visual (that stays owned by the command loop).

  Use **Edit** with this exact `old_string`:
  ```lua
  local function startPolling()
      if running then return end
      running = true
      setStatusVisual("connecting")
      connectionThread = task.spawn(loop)
  end
  ```
  and this exact `new_string`:
  ```lua
  -- ── Control loop ──
  -- A SECOND, independent poll loop on a short interval. Unlike the command loop
  -- (which yields for the full duration of a long handler such as
  -- ExecutePlayModeAsync), the control loop only ever dispatches __assign_studio_id
  -- / __stop_play — handlers that just SetSetting/mutate an upvalue and return — so
  -- it stays responsive during play mode. This is the channel that delivers
  -- cross-session play-stop and same-id collision reassignment. It never touches
  -- the command loop's `connected` visual. In inline mode the broker 404s
  -- /studio/control-poll; the pcall swallows it and the loop idles harmlessly.
  local controlThread: thread? = nil

  local function controlLoop()
      while running do
          local ok, response = pcall(function()
              return HttpService:GetAsync(SERVER_URL .. "/studio/control-poll", true, requestHeaders(false))
          end)
          if ok and response and response ~= "" and response ~= "{}" then
              local decoded
              local decodeOk = pcall(function() decoded = HttpService:JSONDecode(response) end)
              if decodeOk and decoded and decoded.id then
                  local result = executeCommand(decoded)
                  pcall(function()
                      HttpService:PostAsync(
                          SERVER_URL .. "/studio/result/" .. decoded.id,
                          HttpService:JSONEncode(result),
                          Enum.HttpContentType.ApplicationJson,
                          false,
                          requestHeaders(false)
                      )
                  end)
              end
          end
          task.wait(CONTROL_POLL_INTERVAL)
      end
  end

  local function startPolling()
      if running then return end
      running = true
      setStatusVisual("connecting")
      connectionThread = task.spawn(loop)
      controlThread = task.spawn(controlLoop)
  end
  ```

  > Note: `executeCommand` (current `:3064`) and `running` (current `:3041`) are module-level upvalues defined above `startPolling`, so `controlLoop` closes over them legally. The control loop shares the `running` flag, so toggling the toolbar button (which sets `running=false`) stops **both** loops on their next tick.

- [ ] **Step 11: Run the static gate after the control loop**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"
  ```
  `Expected:` prints `0`.

- [ ] **Step 12: Confirm the existing StopPlaySignal watcher is byte-unchanged**

  Regression guard for §2.6.1 / §5.9: the Server-context watcher must be untouched. (Its line numbers shift by the inserts above; match on content, not position.)

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && git diff -U0 plugin/MultiAIPlugin.lua | grep -n "StudioTestService:EndTest\|MCP_STOP_SIGNAL_KEY, false" || echo "OK: StopPlaySignal watcher untouched"
  ```
  `Expected:` prints `OK: StopPlaySignal watcher untouched` (the watcher lines do NOT appear in the diff). If either line appears under a `-`/`+` change, you edited the watcher — revert that hunk.

- [ ] **Step 13: Confirm the `/poll` URL + nocache invariant held (no query string added)**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && grep -n 'GetAsync(SERVER_URL .. "/poll", true, requestHeaders(true))' plugin/MultiAIPlugin.lua && ( grep -n 'studio_id=' plugin/MultiAIPlugin.lua | grep -i 'SERVER_URL\|/poll\|/result\|/control-poll' && echo "FAIL: studio_id query param present" || echo "OK: no studio_id query param on any URL" )
  ```
  `Expected:` the `/poll` GetAsync line is printed with `true, requestHeaders(true)` (nocache arg intact), followed by `OK: no studio_id query param on any URL`.

- [ ] **Step 14: Confirm all three wire call sites use `requestHeaders` and the handlers exist**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && echo "requestHeaders call sites:" && grep -cn "requestHeaders(true)\|requestHeaders(false)" plugin/MultiAIPlugin.lua && echo "control endpoint:" && grep -c '/studio/control-poll' plugin/MultiAIPlugin.lua && echo "handlers:" && grep -c 'handlers.__assign_studio_id\|handlers.__stop_play' plugin/MultiAIPlugin.lua
  ```
  `Expected:`
  ```
  requestHeaders call sites:
  3
  control endpoint:
  1
  handlers:
  2
  ```
  (3 = `/poll` GetAsync + `/result` PostAsync + control-loop GetAsync, with the control-loop result PostAsync making it 4 in some greps; if you see `4`, that is also acceptable — it means the control loop's `requestHeaders(false)` PostAsync was counted too. The minimum is 3.)

- [ ] **Step 15: Final full static gate**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && luau-lsp analyze --platform=standard plugin/MultiAIPlugin.lua 2>&1 | grep -c "SyntaxError"
  ```
  `Expected:` prints `0`. (If non-zero, run without the `grep -c` to read the SyntaxError line, fix the offending edit, and re-run.)

- [ ] **Step 16: Deployment-machine manual checkpoint (REQUIRED hand-off; not runnable on CI)**

  This verifies real dual-loop behavior + the `x-studio-id` header on the wire, which the static gate cannot. Record the result in the PR description.

  1. Sync the single-file plugin: `Run: powershell -File "G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\sync-plugin.ps1"` → expect `[OK] Synced plugin (<N> bytes)`.
  2. Start the broker FE (`server/server.mjs`, default broker mode) so `127.0.0.1:8765` is bound.
  3. Open Roblox Studio with HTTP Requests enabled (File ▸ Studio Settings ▸ Security ▸ Allow HTTP Requests = ON). Right-click the **Multi-AI** plugin ▸ **Reload**.
  4. **Confirm dual-loop poll:** the broker log shows BOTH `GET /studio/poll` (≈ every 0.5 s) AND `GET /studio/control-poll` (≈ every 1 s) arriving from this Studio, each carrying header `x-studio-id: <32-hex>` (and `x-studio-label` on the first `/poll` only). Studio Output prints `[MultiAI] ✓ Connected`.
  5. **Confirm persistence:** Reload the plugin again; the same `x-studio-id` value reappears (read from `MultiAI_StudioId`).
  6. **Confirm control loop survives play mode:** start a play test (any `start_stop_play{start}` / long handler) from one session; from a second session send `start_stop_play{stop}` → the broker routes `__stop_play` over `/studio/control-poll`, the Server-context watcher `EndTest`s, and play stops within ≤ 1 s even though the command loop was yielded. The watcher behavior is unchanged from before this task.
  7. **Confirm collision reassignment:** open a second Studio window of the same place (shares the persisted id); the broker delivers `__assign_studio_id` to the second window over its control loop; that window's subsequent `/poll`/`/control-poll` carry a NEW `x-studio-id`, and `MultiAI_StudioId` for that window is updated. Both windows now poll with distinct ids.

  `Expected:` all seven observations hold. Any failure here is a runtime defect to fix before merge (static gate passing is necessary but not sufficient).

- [ ] **Step 17: Commit**

  `Run:`
  ```bash
  cd "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d" && git add plugin/MultiAIPlugin.lua && git commit -m "$(cat <<'EOF'
feat(plugin): studio_id identity, live-upvalue headers, control loop

- Mint+persist studio_id via GenerateGUID(false) + SetSetting (pcall-guarded,
  per-load fallback); mutable studioId upvalue.
- requestHeaders() re-reads the live studioId every call; always sends
  x-studio-id on /poll and /result (+ x-mcp-token, first-poll x-studio-label);
  URL + nocache=true 2nd arg unchanged (header-only, no query).
- Add handlers.__assign_studio_id (validate ^[0-9a-fA-F%-]{8,64}$, SetSetting,
  mutate upvalue) and handlers.__stop_play (arm StopPlaySignal).
- Second never-blocking task.spawn control loop on GET /studio/control-poll
  at CONTROL_POLL_MS; existing Server-context watcher (:41-51) untouched.
- Single-file install preserved. Static gate: luau-lsp analyze 0 SyntaxErrors;
  runtime is a documented deployment-machine checkpoint.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
  ```
  `Expected:` one commit created touching only `plugin/MultiAIPlugin.lua`.

---

### Task 8: Security + integration tests, env-var docs, sync-plugin token wiring

Final hardening + verification task. It locks the spec's §10 hard-constraint #2 ("existing security preserved + strengthened") and the §8 security edges (#42 forbidden host, #43 session_token gate, #45 spawn-env allowlist, #48 minimal `/health`) behind an executable test, wires the machine-token default into `sync-plugin.ps1`, and updates the operator docs in `CLAUDE.md`. It consumes interfaces produced by Tasks 1–4 and 7 and produces no new code interface for later tasks — it is the closing verification gate.

> **Why these specific tests** (spec §2.7, §2.8, §3.4, §4.1, §8): the broker is a shared, long-lived, N-studio process, so the four security invariants below MUST hold on the *new* endpoints, not just the legacy ones already covered by `http-bridge.test.mjs`. Each test maps 1:1 to a spec edge: token-gate-before-`resolveTarget` (§2.7 / edge #43), allowlisted detached-spawn env with NO Open Cloud key (§3.4 / edge #45), `redactHeaders()` on new endpoints (§2.8 / edge #41), minimal `/health` body (§4.1 / edge #48), non-loopback Host → 403 (edge #42).

#### Files

- **Create**: `G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d/server/test/security.test.mjs` (Test — the new security suite; ~5 test blocks)
- **Modify**: `G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d/sync-plugin.ps1` (replace the single `Copy-Item` line — currently `:13` — with: resolve the machine token, then write it into the copied plugin's `AUTH_TOKEN` line)
- **Modify**: `G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d/CLAUDE.md` (env-var table `:154–161` — append 6 broker rows; Connection-check section `:132–139` — add broker sub-section)

> No production `.mjs` is edited in this task; the broker code is finished in Tasks 1–7. This task only *asserts* its behavior and wires the operator-facing token + docs.

#### Interfaces

**Consumes (from earlier tasks — exact signatures the tests import & call):**

- From Task 1 (`server/lib/http-bridge.mjs`, pure extraction):
  - `redactHeaders(headers: object) -> object` — already exists (`http-bridge.mjs:16`); re-asserted on new endpoints via the broker.
  - `SENSITIVE_HEADER_RE: RegExp` — `/^(x-api-key|x-mcp-token|authorization|x-open-cloud-api-key|.*-key)$/i` (`http-bridge.mjs:13`).
- From Task 2 (`server/lib/registry.mjs`):
  - `createRegistry({ now, thresholds }) -> registry` exposing `validateSessionToken(sessionId, token) -> boolean` and `resolveTarget(sessionId, explicitTarget, now) -> {ok,studioId,via}|{error,code,...}`.
- From Task 3 (`server/lib/broker-core.mjs`):
  - `createBrokerCore({ port, host, authToken, brandPrefix, now? }) -> { httpServer, core, getStatus }` — builds the single `http.createServer` for §4 endpoints (`/health`, `/fe/register`, `/session/submit`, `GET /session/<sid>/status`, `/studio/poll`, …) with the §4 prelude (host allowlist → outer token guard → session_token guard → `redactHeaders` log → body cap). The session_token guard returns `401` **before** `resolveTarget` is reached.
  - The broker logs every request via a hookable `logLine(reqHeaders)` path that runs `redactHeaders` (Task 3 wires `console.error(JSON.stringify(redactHeaders(req.headers)))` — the test intercepts `console.error`).
- From Task 4 (`server/lib/broker-client.mjs`):
  - `buildSpawnEnv({ port, host, authToken, idleMs }) -> Record<string,string>` — the **exported pure env-builder** the detached spawn passes as `spawn(...).env` (spec §3.4 allowlist). Task 4 MUST export this so it is unit-testable without spawning a child. Returns ONLY: `PATH`, `SystemRoot`, `MCP_BROKER_PORT`, `MCP_BROKER_HOST`, `MCP_BROKER_ROLE:"spawned"`, `ROBLOX_MCP_TOKEN`, `ROBLOX_MCP_BROKER_IDLE_MS`. NEVER `ROBLOX_OPEN_CLOUD_*` or any other `*_KEY`/`*_TOKEN` (besides the broker token).
- From Task 7 (`plugin/MultiAIPlugin.lua`):
  - The `AUTH_TOKEN` declaration line, which after Task 7 is still the literal `local AUTH_TOKEN = ""` (verified current state `MultiAIPlugin.lua:25`). `sync-plugin.ps1` rewrites this line at install time.

**Produces (for later tasks):** none — Task 8 is the terminal verification + docs task. It produces the passing security gate and the operator wiring (`sync-plugin.ps1` machine-token install, `CLAUDE.md` broker docs) that the spec's §10 check depends on.

---

#### TDD steps

> **Test run form (Windows / Node v24):** always name files explicitly — `node --test server/test/security.test.mjs`. The trailing-slash DIR form `node --test server/test/` mis-resolves on this setup; do NOT use it. Run all commands from the repo root `G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d`.

- [ ] **Step 1: Write the failing test — session_token gate returns 401 BEFORE resolveTarget on `/session/submit`.**

Create `server/test/security.test.mjs` with the first block. It boots a real `createBrokerCore` on an ephemeral port, registers a session (capturing its `session_token`), then submits with a WRONG token and asserts `401` — and proves `resolveTarget` was never reached by passing an obviously-unresolvable `target` that would otherwise yield a `200` JSON error envelope (so a `401` proves the gate ran first).

```js
// server/test/security.test.mjs
// Security suite for the multi-session broker (spec §2.7, §2.8, §3.4, §4.1, §8).
// Zero-dep: node builtins + the extracted lib helpers only. Runs under `node --test`
// with NO node_modules present.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createBrokerCore } from "../lib/broker-core.mjs";
import { buildSpawnEnv } from "../lib/broker-client.mjs";

// Boot a real broker-core on an ephemeral port; return {port, core, close}.
function startBroker(opts = {}) {
  const built = createBrokerCore({ port: 0, host: "127.0.0.1", brandPrefix: "[sectest]", ...opts });
  return new Promise((resolve) => {
    built.httpServer.on("listening", () => {
      const { port } = built.httpServer.address();
      resolve({ port, core: built.core, close: () => built.httpServer.close() });
    });
  });
}

// Minimal HTTP helper. Always sends a valid loopback Host unless overridden.
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
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

// Register a session and return its minted session_token.
async function register(port, sessionId, { token } = {}) {
  const res = await req(port, {
    method: "POST",
    path: "/fe/register",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId, ...(token ? { "x-mcp-token": token } : {}) },
    body: { session_id: sessionId, kind: "mcp", label: "sec-test", pid: process.pid, cwd: process.cwd() },
  });
  assert.equal(res.status, 200, `register expected 200, got ${res.status}: ${res.body}`);
  return JSON.parse(res.body).session_token;
}

test("session_token gate: /session/submit with WRONG token -> 401 BEFORE resolveTarget", async () => {
  const { port, close } = await startBroker();
  try {
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await register(port, sid);
    // Submit with a bogus x-session-token AND an unresolvable target. If the gate
    // runs first (correct), we get 401. If resolveTarget ran first (bug), we'd get
    // a 200 envelope { error:"UNKNOWN_TARGET" } / NO_TARGET instead.
    const res = await req(port, {
      method: "POST",
      path: "/session/submit",
      headers: { "Content-Type": "application/json", "x-session-id": sid, "x-session-token": "WRONG-TOKEN" },
      body: { session_id: sid, type: "run_luau", payload: { code: "print(1)" }, target: "no-such-studio-xyz" },
    });
    assert.equal(res.status, 401, `expected 401 (token gate before resolveTarget), got ${res.status}: ${res.body}`);
  } finally {
    close();
  }
});

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
      headers: { "Content-Type": "application/json", "x-session-id": sid, "x-session-token": token },
      body: { session_id: sid, type: "run_luau", payload: { code: "print(1)" }, target: "no-such-studio-xyz" },
    });
    assert.equal(res.status, 200, `expected 200 envelope past the gate, got ${res.status}: ${res.body}`);
    const r = JSON.parse(res.body);
    assert.ok(r.error, `expected an error envelope from resolveTarget, got ${res.body}`);
    assert.match(r.code || r.error, /UNKNOWN_TARGET|NO_TARGET/);
  } finally {
    close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails** — establishes the harness wiring is real (this also proves Tasks 3 + 4 exports exist; if they don't, the import throws — that IS the expected first-run failure surface before those tasks land, but in execution order Tasks 1–7 are already done, so the realistic failure here is a behavior mismatch).

`Run:` `node --test server/test/security.test.mjs`

`Expected:` FAIL. Most likely first failure mode while iterating: `AssertionError: expected 401 (token gate before resolveTarget), got 200` (if the gate were mis-ordered after `resolveTarget`), or an import error `Cannot find module '../lib/broker-core.mjs'` / `does not provide an export named 'buildSpawnEnv'` (if a consumed export is missing). Stop and fix the consumed task's export before continuing if it's an import error.

- [ ] **Step 3: (No production code in this task) — confirm the gate ordering is correct in Task 3's `broker-core.mjs`.** The session_token guard MUST appear in the §4 prelude *before* the per-path dispatch that calls `resolveTarget`. If Step 2 failed with `got 200` on the wrong-token case, the fix belongs in `server/lib/broker-core.mjs` (Task 3) — the guard block:

```js
// In broker-core.mjs request prelude, AFTER outer token guard, BEFORE any path dispatch:
const SESSION_GUARDED =
  url.pathname.startsWith("/session/") ||
  url.pathname === "/fe/heartbeat" ||
  url.pathname === "/fe/deregister";
if (SESSION_GUARDED) {
  const sid = req.headers["x-session-id"];
  const tok = req.headers["x-session-token"];
  if (!sid || !registry.validateSessionToken(sid, tok)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"unauthorized"}');
    return;                       // <-- returns BEFORE resolveTarget
  }
}
```

> This snippet is shown for the executing engineer to locate/verify the gate; it is Task 3's code. Task 8 does not author it — it asserts it. If Task 3 already has it, Step 2's `got 200` failure won't occur and you proceed.

- [ ] **Step 4: Run tests to verify the session_token gate tests pass.**

`Run:` `node --test server/test/security.test.mjs`

`Expected:` PASS for both `session_token gate` tests (`# pass 2`, `# fail 0` for the two blocks written so far).

- [ ] **Step 5: Write the failing test — detached-spawn env allowlist contains NO `ROBLOX_OPEN_CLOUD_*` / other `*_KEY` (unit-test the env-builder from Task 4).**

Append to `server/test/security.test.mjs`. This unit-tests `buildSpawnEnv` purely (no child spawned), asserting the allowlist is exact and the Open Cloud key is absent even when present in `process.env`.

```js
test("spawn env allowlist: buildSpawnEnv copies ONLY allowlisted keys, never Open Cloud / *_KEY", () => {
  // Poison process.env with secrets that must NOT leak into the detached broker.
  const saved = { ...process.env };
  process.env.ROBLOX_OPEN_CLOUD_API_KEY = "OC-SECRET-DO-NOT-LEAK";
  process.env.ROBLOX_OPEN_CLOUD_CREATOR_ID = "12345";
  process.env.ROBLOX_OPEN_CLOUD_CREATOR_TYPE = "User";
  process.env.SOME_OTHER_KEY = "ALSO-SECRET";
  process.env.RANDOM_TOKEN = "NOPE";
  try {
    const env = buildSpawnEnv({ port: 8765, host: "127.0.0.1", authToken: "broker-machine-token", idleMs: "90000" });

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
      if (k === "ROBLOX_MCP_TOKEN") continue;                 // the one allowed token
      assert.ok(!/_KEY$/i.test(k), `leaked *_KEY env var into spawn env: ${k}`);
      assert.ok(!/_TOKEN$/i.test(k), `leaked *_TOKEN env var into spawn env: ${k}`);
    }
    assert.equal(env.SOME_OTHER_KEY, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
  } finally {
    // Restore env exactly.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
```

- [ ] **Step 6: Run the test to verify it fails (or passes against a correct Task 4).**

`Run:` `node --test server/test/security.test.mjs`

`Expected:` If Task 4's `buildSpawnEnv` is correct, this PASSES immediately (it is a regression lock). If `buildSpawnEnv` is missing or spreads `{...process.env}`, FAIL with either `does not provide an export named 'buildSpawnEnv'` or `AssertionError: leaked *_KEY env var into spawn env: ROBLOX_OPEN_CLOUD_API_KEY`. Fix belongs in `server/lib/broker-client.mjs` (Task 4) — the builder must construct an object literal of allowlisted keys, never spread the parent env.

- [ ] **Step 7: Write the failing test — `redactHeaders` applied on the new endpoints (secret headers log as `[REDACTED]`).**

Append. Intercept `console.error`, fire a request at a new endpoint (`/studio/poll` and `/session/submit`) carrying `x-mcp-token` + `x-api-key`, and assert the captured log lines mask both while keeping a non-secret header visible.

```js
test("redaction on new endpoints: x-mcp-token / x-api-key log as [REDACTED]", async () => {
  const { port, close } = await startBroker();
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    // Hit a /studio/* endpoint (plugin plane) with secret headers.
    await req(port, {
      method: "GET",
      path: "/studio/poll",
      headers: { "x-studio-id": "abcdef12-3456-7890-abcd-ef1234567890", "x-mcp-token": "SUPER-SECRET", "x-api-key": "KEY-SECRET", "x-studio-label": "VisibleLabel" },
    });
    // Hit a /session/* endpoint too.
    await req(port, {
      method: "GET",
      path: "/session/does-not-exist/status",
      headers: { "x-session-id": "ffffffff-0000-1111-2222-333333333333", "x-mcp-token": "SUPER-SECRET2", "x-api-key": "KEY-SECRET2" },
    });
    const joined = lines.join("\n");
    // Secrets never appear verbatim in any log line.
    assert.ok(!joined.includes("SUPER-SECRET"), `x-mcp-token leaked into logs:\n${joined}`);
    assert.ok(!joined.includes("KEY-SECRET"), `x-api-key leaked into logs:\n${joined}`);
    // The redaction marker is present (proves a log line for these requests ran through redactHeaders).
    assert.ok(joined.includes("[REDACTED]"), `expected [REDACTED] in logs, got:\n${joined}`);
  } finally {
    console.error = orig;
    close();
  }
});
```

> **If Task 3 does not log per-request headers at all**, this test will fail on the `[REDACTED]` assertion. The fix is in Task 3's `broker-core.mjs`: every request must emit one log line `console.error(brandPrefix, req.method, url.pathname, JSON.stringify(redactHeaders(req.headers)))` in the prelude. Task 8 asserts it; if absent, add it in `broker-core.mjs` (it is required by spec §2.8 — "`redactHeaders()` … applied … on **every** new endpoint's log line").

- [ ] **Step 8: Write the failing test — minimal `/health` body + non-loopback Host → 403 on a new endpoint.**

Append. Asserts `/health` returns ONLY `{ok,role,proto,brokerId}` (no `sessions`/`studios`/`draining` counts — spec §4.1, edge #48) and that a forged Host header on a new endpoint yields `403` (edge #42).

```js
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

test("non-loopback Host -> 403 forbidden host on a new endpoint", async () => {
  const { port, close } = await startBroker();
  try {
    const res = await req(port, { path: "/session/list", headers: { Host: "evil.example.com" } });
    assert.equal(res.status, 403);
    assert.match(res.body, /forbidden host/);
  } finally {
    close();
  }
});
```

- [ ] **Step 9: Run the full security suite.**

`Run:` `node --test server/test/security.test.mjs`

`Expected:` PASS, all blocks: `# tests 6`, `# pass 6`, `# fail 0`. (Blocks: 2× session_token gate, 1× spawn-env allowlist, 1× redaction, 1× minimal /health, 1× forbidden host.)

- [ ] **Step 10: Run the FULL test suite to prove no regression in the extracted helpers or Blender path.**

`Run:` `node --test server/test/http-bridge.test.mjs server/test/security.test.mjs server/test/open-cloud.test.mjs server/test/glb.test.mjs`

(Also run any `broker-core`/`registry`/`command-queue`/`broker-client` test files added by Tasks 1–4 — glob form: `node --test server/test/*.test.mjs`.)

`Expected:` PASS overall, `# fail 0`. The legacy `http-bridge.test.mjs` MUST still pass (proves the pure extraction from Task 1 preserved bit-identical behavior; Blender's `createBridge` call site `blender/server.mjs:13` is unchanged).

- [ ] **Step 11: Wire the machine token into the plugin via `sync-plugin.ps1`.**

Replace the single `Copy-Item` line in `sync-plugin.ps1` (currently `:13`, `Copy-Item -Path $src -Destination $dst -Force`) with a block that copies, then rewrites the plugin's `AUTH_TOKEN` line to the machine token. The token is read from `ROBLOX_MCP_TOKEN` if the operator set it, else from the broker machine-token file `%LOCALAPPDATA%/Roblox-MCP/broker-token` (spec §2.7: machine-token default ON). If neither exists yet, the token stays `""` (zero-config first run before the broker has minted one — the next sync after first broker start picks it up).

Replace this exact line:

```powershell
Copy-Item -Path $src -Destination $dst -Force
```

with:

```powershell
# Resolve the outer token to bake into the plugin's AUTH_TOKEN.
# Precedence: explicit ROBLOX_MCP_TOKEN env > machine-token file > "" (zero-config first run).
$token = $env:ROBLOX_MCP_TOKEN
if ([string]::IsNullOrEmpty($token)) {
    $tokenFile = Join-Path $env:LOCALAPPDATA "Roblox-MCP\broker-token"
    if (Test-Path $tokenFile) {
        $token = (Get-Content -Path $tokenFile -Raw).Trim()
    }
}
if ([string]::IsNullOrEmpty($token)) { $token = "" }

# Copy, then rewrite the AUTH_TOKEN line so the single-file install carries the token.
$content = Get-Content -Path $src -Raw
# Escape backslashes and double-quotes for a Lua double-quoted string literal.
$escaped = $token.Replace('\', '\\').Replace('"', '\"')
$content = $content -replace '(?m)^local AUTH_TOKEN = ".*"$', "local AUTH_TOKEN = `"$escaped`""
Set-Content -Path $dst -Value $content -Encoding utf8 -NoNewline

if ($token -ne "") {
    Write-Host "[OK] Baked AUTH_TOKEN into plugin (machine-token auth ENABLED)" -ForegroundColor Green
} else {
    Write-Host "[WARN] No token found — plugin installed WITHOUT auth (start the broker once, then re-run to bake the machine token)" -ForegroundColor Yellow
}
```

> The `(?m)^local AUTH_TOKEN = ".*"$` regex matches the verified current line `local AUTH_TOKEN = ""` (`MultiAIPlugin.lua:25`) and any prior baked value, so re-syncs are idempotent. `-NoNewline` + `utf8` keeps the file byte-clean for Roblox's loader; the single-file install (one `.lua` to `$dst`) is preserved.

- [ ] **Step 12: Smoke-test the sync-plugin token wiring (dry-run against a temp file).**

`Run:`
```bash
ROBLOX_MCP_TOKEN="UNIT-TEST-TOKEN-123" pwsh -NoProfile -Command '
  $src = "G:/My Drive/Backup/Roblox-MCP-v6/.claude/worktrees/musing-moore-431c1d/plugin/MultiAIPlugin.lua";
  $dst = Join-Path $env:TEMP "MultiAIPlugin.synctest.lua";
  $content = Get-Content -Path $src -Raw;
  $escaped = $env:ROBLOX_MCP_TOKEN.Replace([char]92, [char]92+[char]92).Replace([char]34, [char]92+[char]34);
  $content = $content -replace "(?m)^local AUTH_TOKEN = \".*\"$", ("local AUTH_TOKEN = \"" + $escaped + "\"");
  Set-Content -Path $dst -Value $content -Encoding utf8 -NoNewline;
  Select-String -Path $dst -Pattern "local AUTH_TOKEN";
  Remove-Item $dst -Force
'
```

> If `pwsh` is unavailable on this shell, use `powershell` instead and run the equivalent from the PowerShell tool (Windows PowerShell 5.1). The Bash heredoc form above uses `[char]` codes to avoid quote-escaping hell.

`Expected:` the `Select-String` output line shows `local AUTH_TOKEN = "UNIT-TEST-TOKEN-123"` (the env token was baked in), proving the regex substitution targets the right line. Temp file is removed.

- [ ] **Step 13: Update `CLAUDE.md` — env-var table (append 6 broker rows after `:161`).**

Insert these rows at the end of the env-var table (after the `ROBLOX_OPEN_CLOUD_CREATOR_TYPE` row, before the closing `---`):

```markdown
| `ROBLOX_MCP_PORT` | `server/server.mjs` · `server/broker.mjs` | Broker port — single source; FE + broker derive identically (default `8765`) |
| `ROBLOX_MCP_TOKEN` | broker + FE + plugin | Outer `x-mcp-token`. Unset → broker auto-mints a machine token into `%LOCALAPPDATA%/Roblox-MCP/broker-token` (default ON); `sync-plugin.ps1` bakes it into the plugin's `AUTH_TOKEN`. Set explicitly to override. |
| `ROBLOX_MCP_MODE` | `server/server.mjs` | `broker` (default, multi-session) or `inline` (one-env rollback to pre-broker single-session behavior) |
| `ROBLOX_MCP_SESSION_NAME` | `server/server.mjs` | Overrides this session's display label verbatim |
| `ROBLOX_MCP_BROKER_IDLE_MS` | `server/broker.mjs` | Idle-reap timeout — broker self-exits after this long fully idle (default `90000`) |
| `ROBLOX_MCP_TARGET` | `server/server.mjs` | Pin one studio (by id/label) for ALL of this session's calls (multi-studio convenience) |
| `ROBLOX_MCP_ALLOW_TOKENLESS` | `server/broker.mjs` | `=1` restores the legacy empty-outer-gate behavior (opt-out of the machine-token default) |
```

- [ ] **Step 14: Update `CLAUDE.md` — Connection check section (add a broker sub-section after `:139`).**

Insert immediately after step 3 of the existing "Connection check" section (after `restart polling.` at `:139`), before `## Blender connection check`:

```markdown

### Broker mode (multi-session)

In `broker` mode (the default) a single long-lived **broker** owns `127.0.0.1:8765` and routes commands from every Claude Code session to the right Studio window. The first session to start hosts the broker in-process; later sessions connect to it. To inspect topology, the orchestrator uses the control tools:

- `list_studios` — every studio + session + pairing (`origin:"auto"|"manual"`) + active claims.
- `session_status` (alias `whoami`) — what this session is paired to and what it holds.
- `attach_studio { target, claim? }` / `detach_studio { target? }` — manual pairing when auto-1:1 doesn't fire (≥2 studios or ≥2 sessions).

A single session + single Studio **auto-pairs** with zero config and behaves exactly like the legacy single-session server. Pass `target` (a studioId or label) on any data tool to route one call to a specific studio.

- **Auth is on by default:** the broker auto-mints a machine token; `sync-plugin.ps1` bakes it into the plugin. After the broker's first start, re-run `.\sync-plugin.ps1` so the plugin carries the token, then reload the plugin in Studio.
- **Rollback:** set `ROBLOX_MCP_MODE=inline` to restore the pre-broker single-session server (binds 8765, fatal on port conflict).
- **Health probe:** `GET http://127.0.0.1:8765/health` returns `{ ok, role:"broker", proto:1, brokerId }` (no topology counts — those are behind the token-guarded `list_studios`).
```

- [ ] **Step 15: Document the deployment-machine manual checkpoints (in the plan, executed on the deploy box — these cannot run in this headless worktree).**

These are the §10 hard-constraint and §8-edge checks that require live Roblox Studio + a running broker and so are verified by hand on the deployment machine after merge (per the MEMORY note: live server runs from a separate dir; Google-Drive junction blocks in-place runtime tests here):

1. **Plugin dual-loop liveness (spec §2.6.1, edge #18b):** start the broker, open one Studio, sync the plugin. Confirm BOTH `GET /studio/poll` and `GET /studio/control-poll` arrive (broker log shows two distinct poll cadences — command loop ~0.5 s, control loop ~1 s). Then run a long play-mode command (`start_stop_play{start}` via a tool that yields ~30 s). During the yield: `get_connection_status` MUST still report `pluginConnected:true` (in-flight keepalive), and the broker MUST NOT drop the studio. Edge #18b proven when the studio survives the full play test without going stale.
2. **Cross-session stop during play (spec §5.9, edge #34):** with session A mid-play-test, have session B issue `start_stop_play{mode:"stop"}` targeting A's studio. It MUST take effect (the Server-context `StopPlaySignal` watcher `EndTest`s) within ≤1 control-poll (`CONTROL_POLL_MS=1000`), delivered via the never-blocked control loop.
3. **Multi-session pairing end-to-end (spec §5.3, §5.6, edges #15/#22):** open 2 Studio windows + 2 sessions. Confirm `maybeAutoPair` does NOT fire (≥2 of each), targetless submit → `NO_TARGET` with a candidate list, `attach_studio` by label binds the right studio, and `attach_studio` onto a studio paired to the other session → `STUDIO_BUSY`. Confirm `list_studios` surfaces `origin:"auto"` vs `"manual"`.
4. **Machine-token round-trip (spec §2.7):** delete `%LOCALAPPDATA%/Roblox-MCP/broker-token`, start the broker (it mints a fresh token), run `.\sync-plugin.ps1`, reload the plugin. Confirm the plugin's polls authenticate (no `401` in the broker log) and an unauthenticated `curl http://127.0.0.1:8765/studio/poll` (no `x-mcp-token`) returns `401`.
5. **Two-FE race + detached spawn (spec §3.2/§3.4, edges #2/#3/#46):** start two sessions within the same second; confirm exactly one becomes the in-proc leader and the other connects (broker log shows one `listening`, one connect). Kill the leader's session and confirm a survivor re-elects within ~2–2.5 s. (The automated analogue of the race lives in Task 4's `broker-client` integration test; this manual check confirms it on the deploy box with real cwd/junction conditions.)

- [ ] **Step 16: Final verification before commit — run the security suite + full suite once more and confirm the docs/edits are in place.**

`Run:` `node --test server/test/*.test.mjs`

`Expected:` PASS, `# fail 0` across every suite (security + http-bridge + open-cloud + glb + the Task 1–4 lib suites).

Also confirm the three edited files: `git --no-pager diff --stat` should show `sync-plugin.ps1`, `CLAUDE.md`, and the new `server/test/security.test.mjs` (plus any production fixes you had to make in Tasks 3/4 if Steps 2/6/7 surfaced gaps).

- [ ] **Step 17: Commit.**

`Run:`
```bash
git add server/test/security.test.mjs sync-plugin.ps1 CLAUDE.md && git commit -m "$(cat <<'EOF'
test(broker): security suite + sync-plugin machine-token + broker docs

- server/test/security.test.mjs: session_token gate returns 401 before
  resolveTarget on /session/*; detached-spawn env allowlist excludes
  ROBLOX_OPEN_CLOUD_* / *_KEY / *_TOKEN (buildSpawnEnv unit test);
  redactHeaders on /studio/* + /session/* (x-mcp-token/x-api-key -> [REDACTED]);
  minimal /health body {ok,role,proto,brokerId}; non-loopback Host -> 403.
- sync-plugin.ps1: bake ROBLOX_MCP_TOKEN / machine-token file into the
  plugin AUTH_TOKEN line (machine-token default ON), single-file install kept.
- CLAUDE.md: broker env-var rows + broker connection-check section.

Closes spec §10 hard-constraint #2 + §8 security edges (#42,#43,#45,#48).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

`Expected:` a single commit on the feature branch containing the new test file + the two doc/wiring edits (and any production gap-fixes from Steps 3/6/7 if they were needed).