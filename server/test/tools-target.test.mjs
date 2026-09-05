import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, CONTROL_OR_OS_LOCAL } from "../tools.mjs";

// ── helpers ───────────────────────────────────────────────────────────────
const byName = (n) => TOOLS.find((t) => t.name === n);
const hasStudioTarget = (t) =>
  !!(t && t.inputSchema && t.inputSchema.properties &&
     Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "studio_target"));
const hasDomainTarget = (t) =>
  !!(t && t.inputSchema && t.inputSchema.properties &&
     Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "target"));

// The four OS-local tools that never touch a plugin, plus get_connection_status,
// must NOT gain a `studio_target` prop (they are answered locally / route nowhere).
const OS_LOCAL = ["get_connection_status", "take_screenshot", "capture_studio_window", "screenshot_diff", "simulate_input"];
const CONTROL = ["list_studios", "attach_studio", "detach_studio", "session_status"];

// ── count ─────────────────────────────────────────────────────────────────
test("TOOLS count is 81 raw + 4 control = 85", () => {
  assert.equal(TOOLS.length, 85);
  // names are unique
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 85);
});

// ── studio_target present on representative data tools ────────────────────
test("data tools gain an optional studio_target string property", () => {
  for (const n of ["run_luau", "create_part", "set_property", "start_stop_play", "import_blender_model"]) {
    const t = byName(n);
    assert.ok(t, `${n} missing`);
    assert.ok(hasStudioTarget(t), `${n} should have studio_target`);
    assert.equal(t.inputSchema.properties.studio_target.type, "string");
    // injection is additive: the original required[] and other props survive
    if (n === "set_property") {
      assert.deepEqual(t.inputSchema.required, ["path", "property", "value"]);
      assert.ok(t.inputSchema.properties.path, "original props preserved");
    }
  }
  // `studio_target` is NEVER added to required[]
  for (const t of TOOLS) {
    if (Array.isArray(t.inputSchema?.required)) {
      assert.ok(!t.inputSchema.required.includes("studio_target"), `${t.name} must not require studio_target`);
    }
  }
});

// ── studio_target ABSENT on OS-local + status + the 4 control tools ─────
test("OS-local + status + control tools have NO studio_target", () => {
  for (const n of [...OS_LOCAL, ...CONTROL]) {
    const t = byName(n);
    assert.ok(t, `${n} missing`);
    assert.equal(hasStudioTarget(t), false, `${n} must NOT have studio_target`);
  }
});

// ── C2: 4 collision domain tools keep `target` AND gain `studio_target` ──
test("play_animation: keeps domain target (required) AND gains studio_target", () => {
  const t = byName("play_animation");
  assert.ok(t, "play_animation missing");
  // domain target preserved
  assert.ok(hasDomainTarget(t), "play_animation must still have domain target");
  assert.equal(t.inputSchema.properties.target.type, "string");
  assert.ok(t.inputSchema.required.includes("target"), "play_animation must still require target");
  assert.ok(t.inputSchema.required.includes("asset_id"), "play_animation must still require asset_id");
  // studio_target injected (and not in required)
  assert.ok(hasStudioTarget(t), "play_animation should also have studio_target");
  assert.equal(t.inputSchema.properties.studio_target.type, "string");
  assert.ok(!t.inputSchema.required.includes("studio_target"), "studio_target must NOT be required");
});

test("stop_animations: keeps domain target (required) AND gains studio_target", () => {
  const t = byName("stop_animations");
  assert.ok(t, "stop_animations missing");
  assert.ok(hasDomainTarget(t), "stop_animations must still have domain target");
  assert.equal(t.inputSchema.properties.target.type, "string");
  assert.ok(t.inputSchema.required.includes("target"), "stop_animations must still require target");
  assert.ok(hasStudioTarget(t), "stop_animations should also have studio_target");
  assert.ok(!t.inputSchema.required.includes("studio_target"), "studio_target must NOT be required");
});

test("align_to: keeps domain target (required) AND gains studio_target", () => {
  const t = byName("align_to");
  assert.ok(t, "align_to missing");
  assert.ok(hasDomainTarget(t), "align_to must still have domain target");
  assert.equal(t.inputSchema.properties.target.type, "string");
  assert.ok(t.inputSchema.required.includes("target"), "align_to must still require target");
  assert.ok(t.inputSchema.required.includes("source"), "align_to must still require source");
  assert.ok(t.inputSchema.required.includes("side"), "align_to must still require side");
  assert.ok(hasStudioTarget(t), "align_to should also have studio_target");
  assert.ok(!t.inputSchema.required.includes("studio_target"), "studio_target must NOT be required");
});

test("create_particle_burst: keeps domain target (required) AND gains studio_target", () => {
  const t = byName("create_particle_burst");
  assert.ok(t, "create_particle_burst missing");
  assert.ok(hasDomainTarget(t), "create_particle_burst must still have domain target");
  assert.equal(t.inputSchema.properties.target.type, "string");
  assert.ok(t.inputSchema.required.includes("target"), "create_particle_burst must still require target");
  assert.ok(hasStudioTarget(t), "create_particle_burst should also have studio_target");
  assert.ok(!t.inputSchema.required.includes("studio_target"), "studio_target must NOT be required");
});

// ── CONTROL_OR_OS_LOCAL skip set ───────────────────────────────────────────
test("CONTROL_OR_OS_LOCAL is a Set of size 9, no whoami, excludes data tools", () => {
  assert.ok(CONTROL_OR_OS_LOCAL instanceof Set);
  assert.equal(CONTROL_OR_OS_LOCAL.size, 9, "skip set must be exactly size 9");
  // all expected members present
  for (const n of [...CONTROL, ...OS_LOCAL]) {
    assert.ok(CONTROL_OR_OS_LOCAL.has(n), `${n} should be in CONTROL_OR_OS_LOCAL`);
  }
  // whoami is NOT in the set (size 9, dispatch-routing.mjs does not include it)
  assert.equal(CONTROL_OR_OS_LOCAL.has("whoami"), false, "whoami must NOT be in the skip set");
  // data tools are NOT in the skip set
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
