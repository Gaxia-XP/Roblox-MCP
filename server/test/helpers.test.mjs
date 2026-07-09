import { test } from "node:test";
import assert from "node:assert/strict";
import { toInt, sanitizeRegion, coerceMcpValue, coerceProps, toolTimeoutMs } from "../lib/helpers.mjs";

// ── toInt ──

test("toInt: valid integer within bounds -> clamped value", () => {
  assert.equal(toInt(42, 0), 42);
  assert.equal(toInt(100, 0, { min: 0, max: 50 }), 50); // clamp to max
  assert.equal(toInt(-10, 0, { min: 0, max: 100 }), 0); // clamp to min
  assert.equal(toInt(25, 0, { min: 10, max: 30 }), 25);
});

test("toInt: floats are truncated", () => {
  assert.equal(toInt(42.7, 0), 42);
  assert.equal(toInt(-3.9, 0, { min: -10, max: 10 }), -3);
});

test("toInt: NaN/Infinity/non-numeric -> default", () => {
  assert.equal(toInt(NaN, 99), 99);
  assert.equal(toInt(Infinity, 99), 99);
  assert.equal(toInt(-Infinity, 99), 99);
  assert.equal(toInt("not a number", 99), 99);
  assert.equal(toInt(undefined, 99), 99);
  assert.equal(toInt(null, 99), 99);
});

test("toInt: numeric strings are coerced", () => {
  assert.equal(toInt("42", 0), 42);
  assert.equal(toInt("-5", 0, { min: -10, max: 10 }), -5);
});

test("toInt: default bounds (0, 1_000_000)", () => {
  assert.equal(toInt(500_000, 0), 500_000);
  assert.equal(toInt(2_000_000, 0), 1_000_000); // clamp to default max
  assert.equal(toInt(-100, 0), 0); // clamp to default min
});

// ── sanitizeRegion ──

test("sanitizeRegion: valid region -> integer fields", () => {
  const r = sanitizeRegion({ x: 10.5, y: 20.9, width: 100, height: 50 });
  assert.deepEqual(r, { x: 10, y: 20, width: 100, height: 50 });
});

test("sanitizeRegion: missing fields -> defaults to 0", () => {
  const r = sanitizeRegion({ x: 5 });
  assert.deepEqual(r, { x: 5, y: 0, width: 0, height: 0 });
});

test("sanitizeRegion: null/undefined -> null", () => {
  assert.equal(sanitizeRegion(null), null);
  assert.equal(sanitizeRegion(undefined), null);
  assert.equal(sanitizeRegion("not an object"), null);
});

test("sanitizeRegion: negative x/y allowed (min -100_000)", () => {
  const r = sanitizeRegion({ x: -500, y: -1000, width: 200, height: 100 });
  assert.deepEqual(r, { x: -500, y: -1000, width: 200, height: 100 });
});

test("sanitizeRegion: width/height clamped to 0 minimum", () => {
  const r = sanitizeRegion({ x: 0, y: 0, width: -50, height: -10 });
  assert.deepEqual(r, { x: 0, y: 0, width: 0, height: 0 });
});

// ── coerceMcpValue ──

test("coerceMcpValue: primitives pass through unchanged", () => {
  assert.equal(coerceMcpValue(42), 42);
  assert.equal(coerceMcpValue("hello"), "hello");
  assert.equal(coerceMcpValue(true), true);
  assert.equal(coerceMcpValue(null), null);
});

test("coerceMcpValue: already-parsed arrays/objects pass through", () => {
  const arr = [1, 2, 3];
  const obj = { foo: "bar" };
  assert.deepEqual(coerceMcpValue(arr), arr);
  assert.deepEqual(coerceMcpValue(obj), obj);
});

test("coerceMcpValue: JSON-stringified array is parsed", () => {
  const result = coerceMcpValue("[1,2,3]");
  assert.deepEqual(result, [1, 2, 3]);
});

test("coerceMcpValue: JSON-stringified object is parsed", () => {
  const result = coerceMcpValue('{"x":10,"y":20}');
  assert.deepEqual(result, { x: 10, y: 20 });
});

test("coerceMcpValue: malformed JSON string stays as string", () => {
  assert.equal(coerceMcpValue("[not json"), "[not json");
  assert.equal(coerceMcpValue("{incomplete"), "{incomplete");
});

test("coerceMcpValue: plain text starting with [ or { but not JSON stays string", () => {
  assert.equal(coerceMcpValue("[hello world]"), "[hello world]");
  assert.equal(coerceMcpValue("{not: valid}"), "{not: valid}");
});

// ── coerceProps ──

test("coerceProps: coerces every value in a dict", () => {
  const input = { Position: "[1,2,3]", Size: "[10,20,30]", Name: "Floor" };
  const result = coerceProps(input);
  assert.deepEqual(result, {
    Position: [1, 2, 3],
    Size: [10, 20, 30],
    Name: "Floor",
  });
});

test("coerceProps: null/undefined/non-object -> returns input", () => {
  assert.equal(coerceProps(null), null);
  assert.equal(coerceProps(undefined), undefined);
  assert.equal(coerceProps("not an object"), "not an object");
});

test("coerceProps: nested objects are not recursively coerced (shallow)", () => {
  const input = { outer: '{"inner":"[1,2,3]"}' };
  const result = coerceProps(input);
  // outer string is parsed to object, but inner stays as string (no deep recursion)
  assert.deepEqual(result, { outer: { inner: "[1,2,3]" } });
});

// ── toolTimeoutMs ──

test("toolTimeoutMs: default tools -> 30s", () => {
  assert.equal(toolTimeoutMs("create_part", {}), 30_000);
  assert.equal(toolTimeoutMs("run_luau", {}), 30_000);
  assert.equal(toolTimeoutMs("get_tree", {}), 30_000);
});

test("toolTimeoutMs: run_script_in_play_mode -> timeout + 15s slack (clamped ≥30s)", () => {
  assert.equal(toolTimeoutMs("run_script_in_play_mode", { timeout: 10 }), 30_000); // 10s+15s=25s < 30s → clamp to 30s
  assert.equal(toolTimeoutMs("run_script_in_play_mode", { timeout: 20 }), 35_000); // 20s + 15s = 35s
  assert.equal(toolTimeoutMs("run_script_in_play_mode", { timeout: 60 }), 75_000); // 60s + 15s
  assert.equal(toolTimeoutMs("run_script_in_play_mode", {}), 45_000); // default 30s + 15s
});

test("toolTimeoutMs: npc_walk_path -> timeout + 15s slack", () => {
  assert.equal(toolTimeoutMs("npc_walk_path", { timeout: 20 }), 35_000); // 20s + 15s
  assert.equal(toolTimeoutMs("npc_walk_path", {}), 45_000); // default 30s + 15s
});

test("toolTimeoutMs: profile_play_mode -> duration + 15s slack (clamped ≥30s)", () => {
  assert.equal(toolTimeoutMs("profile_play_mode", { duration: 5 }), 30_000); // 5s+15s=20s < 30s → clamp
  assert.equal(toolTimeoutMs("profile_play_mode", { duration: 20 }), 35_000); // 20s + 15s = 35s
  assert.equal(toolTimeoutMs("profile_play_mode", {}), 30_000); // default 10s+15s=25s → clamp to 30s
});

test("toolTimeoutMs: humanoid_move -> duration + 2*wait_for_character + 15s slack (clamped ≥30s)", () => {
  // duration=2, wait_for_character=5 -> 2 + 2*5 + 15 = 27s < 30s → clamp to 30s
  assert.equal(toolTimeoutMs("humanoid_move", { duration: 2, wait_for_character: 5 }), 30_000);
  // duration=5, wait_for_character=6 -> 5 + 2*6 + 15 = 32s > 30s
  assert.equal(toolTimeoutMs("humanoid_move", { duration: 5, wait_for_character: 6 }), 32_000);
  // defaults: duration=1, wait_for_character=10 -> 1 + 2*10 + 15 = 36s
  assert.equal(toolTimeoutMs("humanoid_move", {}), 36_000);
});

test("toolTimeoutMs: per-tool budget never shortens below 30s default", () => {
  // Even a very short duration, the result is clamped to >= 30s (safety feature)
  assert.equal(toolTimeoutMs("profile_play_mode", { duration: 0.1 }), 30_000); // 0.1s+15s=15.1s < 30s → 30s
  assert.equal(toolTimeoutMs("humanoid_move", { duration: 0.1, wait_for_character: 0.1 }), 30_000); // 0.1+2*0.1+15=15.3s → 30s
});

test("toolTimeoutMs: invalid/non-numeric timeout/duration -> uses default then clamps", () => {
  assert.equal(toolTimeoutMs("npc_walk_path", { timeout: "not a number" }), 45_000); // default 30s + 15s = 45s
  assert.equal(toolTimeoutMs("profile_play_mode", { duration: NaN }), 30_000); // default 10s+15s=25s → clamp to 30s
});
