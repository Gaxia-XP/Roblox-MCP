// ── Pure helper functions (no I/O, no state, no side-effects) ──
// Extracted from server.mjs for unit testing.

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Force a value to a bounded integer.
 * Defense-in-depth for numeric args passed to OS-level tools (screenshots/input).
 * @param {any} v - Value to coerce
 * @param {number} def - Default if coercion fails
 * @param {{min?: number, max?: number}} opts - Bounds (default: min=0, max=1_000_000)
 * @returns {number}
 */
export function toInt(v, def, { min = 0, max = 1_000_000 } = {}) {
  if (v == null) return def; // null or undefined → default (Number(null) is 0, unwanted)
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/**
 * Sanitize a screenshot region object into integer-only fields (or null).
 * @param {any} region
 * @returns {{x: number, y: number, width: number, height: number} | null}
 */
export function sanitizeRegion(region) {
  if (!region || typeof region !== "object") return null;
  return {
    x: toInt(region.x, 0, { min: -100_000 }),
    y: toInt(region.y, 0, { min: -100_000 }),
    width: toInt(region.width, 0, { min: 0 }),
    height: toInt(region.height, 0, { min: 0 }),
  };
}

/**
 * MCP value coercion. Some MCP clients stringify untyped list/object values
 * (e.g. `value: "[1,2,3]"` instead of `[1,2,3]`). Detect and JSON-parse them.
 * Already-typed values pass through unchanged.
 * @param {any} v
 * @returns {any}
 */
export function coerceMcpValue(v) {
  if (typeof v !== "string" || v.length < 2) return v;
  const first = v[0];
  if (first !== "[" && first !== "{") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Coerce every value inside a property dict (shallow).
 * Used by tools that accept a `{ propName: value, ... }` map.
 * @param {any} obj
 * @returns {any}
 */
export function coerceProps(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = coerceMcpValue(v);
  return out;
}

/**
 * Per-tool wall-clock timeout (ms). Tools that forward their own `timeout`/`duration`
 * to the plugin get that budget + slack; everything else uses the 30s default.
 * The per-tool budget may only EXTEND the default, never shorten it.
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {number}
 */
export function toolTimeoutMs(name, args) {
  const SLACK_MS = 15_000;
  const secs = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  let budget;
  switch (name) {
    case "run_script_in_play_mode":
    case "npc_walk_path":
      budget = secs(args.timeout, 30) * 1000 + SLACK_MS;
      break;
    case "profile_play_mode":
      budget = secs(args.duration, 10) * 1000 + SLACK_MS;
      break;
    case "humanoid_move":
      // The plugin may wait up to wait_for_character TWICE (player join, then
      // character/Humanoid/HRP spawn) before driving for `duration`. Budget all three.
      budget = (secs(args.duration, 1) + 2 * secs(args.wait_for_character, 10)) * 1000 + SLACK_MS;
      break;
    default:
      budget = DEFAULT_TIMEOUT_MS;
  }
  // A per-tool budget may only EXTEND the default wall, never shorten it — so a
  // new/under-counted case can't make a tool time out earlier than before.
  return Math.max(DEFAULT_TIMEOUT_MS, budget);
}
