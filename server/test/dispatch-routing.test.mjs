/**
 * server/test/dispatch-routing.test.mjs
 * Unit tests for the PURE routing helper (server/lib/dispatch-routing.mjs).
 * No sockets, no MCP SDK — runs under `node --test` with NO node_modules.
 *
 * BINDING CORRECTION C1: the per-call studio-routing key is `studio_target`,
 * NEVER `target`. Four domain tools (play_animation/stop_animations/align_to/
 * create_particle_burst) already use `args.target` as a REQUIRED domain param;
 * routing must read `args.studio_target` so it never hijacks their domain path.
 */
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
  // A normal plugin tool is NOT in the set (so Task 6 injects `studio_target` into it).
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

test("routeCall: start_stop_play{stop} → control queue with resolved studio_target precedence", () => {
  // no studio_target → control-route with target null (broker resolves the paired/auto studio)
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "stop" }, sessionTarget: null }),
    { kind: "stop_control", target: null }
  );
  // per-call studio_target wins over the session pin
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "stop", studio_target: "Foo" }, sessionTarget: "Bar" }),
    { kind: "stop_control", target: "Foo" }
  );
  // session pin used when no per-call studio_target
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "stop" }, sessionTarget: "Bar" }),
    { kind: "stop_control", target: "Bar" }
  );
});

test("routeCall: start_stop_play{stop} ignores the DOMAIN `target` field (C1)", () => {
  // A stray `target` must NOT be read as a routing key — only `studio_target` is.
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "stop", target: "DomainNotRouting" }, sessionTarget: null }),
    { kind: "stop_control", target: null }
  );
});

test("routeCall: start_stop_play with start/run_server is a NORMAL submit, not control", () => {
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "start_play" }, sessionTarget: null }),
    { kind: "submit_default" }
  );
  assert.deepEqual(
    routeCall({ name: "start_stop_play", args: { mode: "run_server", studio_target: "Foo" }, sessionTarget: null }),
    { kind: "submit_to", target: "Foo" }
  );
});

test("routeCall: import_blender_model pins one studio across its batches", () => {
  assert.deepEqual(
    routeCall({ name: "import_blender_model", args: {}, sessionTarget: null }),
    { kind: "pin_composite", target: null }
  );
  assert.deepEqual(
    routeCall({ name: "import_blender_model", args: { studio_target: "S1" }, sessionTarget: "S2" }),
    { kind: "pin_composite", target: "S1" }
  );
});

test("routeCall: studio_target:'all' fans out", () => {
  assert.deepEqual(
    routeCall({ name: "create_part", args: { studio_target: "all" }, sessionTarget: null }),
    { kind: "fanout" }
  );
  // session pin of "all" also fans out
  assert.deepEqual(
    routeCall({ name: "create_part", args: {}, sessionTarget: "all" }),
    { kind: "fanout" }
  );
});

test("routeCall: a DOMAIN `target` field never causes fanout/submit_to (C1)", () => {
  // play_animation uses `args.target` as a REQUIRED domain param (a Humanoid path).
  // Routing must IGNORE it: with no studio_target, this is a plain default submit.
  assert.deepEqual(
    routeCall({ name: "play_animation", args: { target: "Workspace.Dummy", asset_id: "1" }, sessionTarget: null }),
    { kind: "submit_default" }
  );
  // Even a domain target literally equal to "all" must not fan out.
  assert.deepEqual(
    routeCall({ name: "create_particle_burst", args: { target: "all" }, sessionTarget: null }),
    { kind: "submit_default" }
  );
});

test("routeCall: explicit non-'all' studio_target → submit_to; precedence per-call > session", () => {
  assert.deepEqual(
    routeCall({ name: "create_part", args: { studio_target: "Studio #ab12" }, sessionTarget: null }),
    { kind: "submit_to", target: "Studio #ab12" }
  );
  assert.deepEqual(
    routeCall({ name: "create_part", args: {}, sessionTarget: "Studio #ab12" }),
    { kind: "submit_to", target: "Studio #ab12" }
  );
  assert.deepEqual(
    routeCall({ name: "create_part", args: { studio_target: "Win" }, sessionTarget: "Lose" }),
    { kind: "submit_to", target: "Win" }
  );
});

test("routeCall: no studio_target anywhere → submit_default", () => {
  assert.deepEqual(
    routeCall({ name: "create_part", args: {}, sessionTarget: null }),
    { kind: "submit_default" }
  );
  // empty-string and whitespace studio_targets are treated as absent
  assert.deepEqual(
    routeCall({ name: "create_part", args: { studio_target: "" }, sessionTarget: null }),
    { kind: "submit_default" }
  );
  assert.deepEqual(
    routeCall({ name: "create_part", args: { studio_target: "   " }, sessionTarget: "  " }),
    { kind: "submit_default" }
  );
});

test("routeCall: tolerates a missing args object", () => {
  assert.deepEqual(
    routeCall({ name: "create_part" }),
    { kind: "submit_default" }
  );
  assert.deepEqual(
    routeCall({ name: "list_studios" }),
    { kind: "control_tool", tool: "list_studios" }
  );
});
