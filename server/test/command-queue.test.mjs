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
