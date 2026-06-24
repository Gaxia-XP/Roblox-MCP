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
 * (studio_target:"all"), to one explicit studio (submitTo), or to the default/
 * auto studio (submit). The public submit(type,payload,timeout) signature is
 * never changed — target routing lives entirely here.
 *
 * ── BINDING CORRECTION C1 ──
 * The per-call studio-routing key is `studio_target`, NEVER `target`. Four
 * existing domain tools (play_animation, stop_animations, align_to,
 * create_particle_burst) already take `args.target` as a REQUIRED DOMAIN
 * parameter (a Humanoid/part path, an alignment anchor, an emitter host). If
 * routing read `args.target`, it would hijack their domain path. `studio_target`
 * is read ONLY for routing and is NEVER written into the command payload, so the
 * four domain tools' own `args.target` keeps flowing through the payload
 * untouched.
 */

// The 4 broker-answered control tools.
export const CONTROL_TOOLS = new Set([
  "list_studios",
  "attach_studio",
  "detach_studio",
  "session_status",
]);

// Tools that NEVER touch a plugin and therefore carry NO `studio_target`
// (Task 6's schema transform skips exactly this set): the 4 control tools, the
// local connection-status answer, and the 4 OS-level screenshot/input tools.
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

// Normalize a routing-target candidate: a non-empty, non-whitespace string or null.
function normTarget(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * @param {{ name: string, args?: object, sessionTarget?: string|null }} input
 * @returns {{kind:"control_tool",tool:string}
 *          |{kind:"stop_control",target:string|null}
 *          |{kind:"pin_composite",target:string|null}
 *          |{kind:"fanout"}
 *          |{kind:"submit_to",target:string}
 *          |{kind:"submit_default"}}
 */
export function routeCall({ name, args = {}, sessionTarget = null } = {}) {
  // 1. Control-plane tools are answered by the broker client, never a plugin.
  if (CONTROL_TOOLS.has(name)) return { kind: "control_tool", tool: name };

  // Effective routing target: per-call `args.studio_target` wins over the
  // env-pinned session target (ROBLOX_MCP_TARGET). C1: read `studio_target`,
  // NEVER `args.target` (that is a domain field for some tools). Empty/whitespace
  // strings are treated as absent.
  const target = normTarget(args.studio_target) ?? normTarget(sessionTarget);

  // 2. start_stop_play{stop} is delivered on the studio's CONTROL queue so it
  //    reaches a plugin whose command loop is yielded inside a play test.
  //    Other modes (start_play/run_server) are ordinary commands.
  if (name === "start_stop_play" && String(args.mode || "") === "stop") {
    return { kind: "stop_control", target };
  }

  // 3. studio_target:"all" fans out to every live studio (Promise.all, never throws).
  if (target === "all") return { kind: "fanout" };

  // 4. Composite mesh import: resolve a studio ONCE and pin every batch to it.
  if (STUDIO_PINNED_COMPOSITES.has(name)) return { kind: "pin_composite", target };

  // 5. Explicit (non-"all") target → submitTo a single studio.
  if (target !== null) return { kind: "submit_to", target };

  // 6. No target anywhere → default/auto-paired studio (today's behavior).
  return { kind: "submit_default" };
}
