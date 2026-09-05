#!/usr/bin/env node
/**
 * MCP server for Roblox Studio (Node.js).
 *
 *   Claude Code  <--stdio (MCP)-->  server.mjs  <--HTTP-->  Roblox Studio plugin
 *
 * MCP side exposes tools (run_luau, create_part, ...).
 * HTTP side runs on 127.0.0.1:8765 — the Studio plugin polls /poll for commands
 * and posts results to /result/<id>.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "node:child_process";
import { createBridge, redactHeaders } from "./lib/http-bridge.mjs";
import { ensureBroker, loadOrMintMachineToken, loadOrMintSessionId } from "./lib/broker-client.mjs";
import { routeCall, CONTROL_TOOLS } from "./lib/dispatch-routing.mjs";
import { uploadAsset, pollOperation } from "./lib/open-cloud.mjs";
import { tmpdir } from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseGlb } from "./lib/glb.mjs";
import { toInt, sanitizeRegion, coerceMcpValue, coerceProps, toolTimeoutMs } from "./lib/helpers.mjs";

// ---------------------------------------------------------------------------
// HTTP bridge (Roblox plugin talks to this)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

const HTTP_PORT = (() => {
  const p = Number(process.env.ROBLOX_MCP_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8765;
})();

// ── Session identity + per-session studio pin ──
// A session is identified by its working directory (per-cwd, persisted by the
// broker-client helper). Reusing the id on MCP restart preserves an established
// pairing; different worktrees → different cwd → different sessions.
const SESSION_ID = loadOrMintSessionId();

// Optional per-session studio pin (mode-2 convenience). Empty → null. Read by the
// routing chokepoint as the fallback when a call carries no `studio_target`.
const SESSION_TARGET = (process.env.ROBLOX_MCP_TARGET || "").trim() || null;

// C4: resolve the outer/machine token ONCE so both modes agree on one secret.
// An explicit ROBLOX_MCP_TOKEN wins; otherwise mint/load the persisted machine
// token (the same single source the detached broker child uses).
const OUTER_TOKEN = (process.env.ROBLOX_MCP_TOKEN || "").trim() || loadOrMintMachineToken();

// ROBLOX_MCP_MODE: `inline` = the one-env single-session rollback (today's
// createBridge); anything else (default) = the multi-session broker.
const BROKER_MODE = (process.env.ROBLOX_MCP_MODE || "broker").trim().toLowerCase() !== "inline";

// In broker mode the FE is an HTTP client of (or in-proc leader for) the broker.
// In inline mode it is byte-for-bit today's single-session createBridge server.
// Both expose `submit(type,payload,timeout)` with the IDENTICAL public signature.
const bridge = BROKER_MODE
  ? await ensureBroker({
      port: HTTP_PORT,
      host: "127.0.0.1",
      authToken: OUTER_TOKEN,
      brandPrefix: "[roblox-mcp]",
      sessionId: SESSION_ID,
    })
  : (() => {
      // Inline rollback: createBridge returns a SYNC getStatus; wrap it in a
      // Promise so the single call site can `await getStatus()` uniformly, and
      // shim the broker-only methods so the chokepoint has one shape. A stray
      // `studio_target` in inline mode degrades to a plain single-studio submit —
      // byte-identical to today for the no-target single-session path.
      const b = createBridge({
        port: HTTP_PORT,
        authToken: OUTER_TOKEN,
        brandPrefix: "[roblox-mcp]",
      });
      const noBroker = (op) => ({ error: `${op} requires broker mode (ROBLOX_MCP_MODE=broker)`, code: "INLINE_MODE" });
      return {
        httpServer: b.httpServer,
        submit: b.submit,
        submitTo: (_studioId, type, payload, timeoutMs) => b.submit(type, payload, timeoutMs),
        submitControl: (_t, type, payload, timeoutMs) => b.submit(type, payload, timeoutMs),
        fanoutSubmit: async (type, payload, timeoutMs) => {
          const r = await b.submit(type, payload, timeoutMs);
          return { fanout: true, results: [{ studioId: "inline", label: "inline", result: r }], ok: r && r.error ? 0 : 1, failed: r && r.error ? 1 : 0 };
        },
        getStatus: async () => b.getStatus(),
        resolveSessionTarget: async () => ({ ok: true, studioId: "inline", via: "inline" }),
        listStudios: async () => noBroker("list_studios"),
        attachStudio: async () => noBroker("attach_studio"),
        detachStudio: async () => noBroker("detach_studio"),
        sessionStatus: async () => noBroker("session_status"),
        stopHeartbeat: () => {},
      };
    })();

const {
  submit, submitTo, submitControl, fanoutSubmit, resolveSessionTarget, getStatus,
  listStudios, attachStudio, detachStudio, sessionStatus,
} = bridge;

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

import { TOOLS } from "./tools.mjs";

import { simulateInputOS, screenshotDiff, captureStudioWindow, captureScreenshot } from "./os-tools.mjs";

const server = new Server(
  { name: "roblox-studio", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ---------------------------------------------------------------------------
// MCP tool handler
// ---------------------------------------------------------------------------

const EM_VERT_BATCH = 4000; // triangles ride the final vertex batch (see note); no separate tri batching in v1.
// importViaEditableMesh is a TOP-LEVEL function (not inside the CallTool handler),
// so it has no access to the local `jsonResult` — it builds the content shape itself.
const emResult = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

// `submitFn(type,payload,timeoutMs)` is pre-pinned to ONE studio by the caller so
// every batch of a single mesh lands on the same Studio (a mid-sequence re-pair
// cannot split a mesh across two studios). Defaults to the global `submit`.
async function importViaEditableMesh(args, submitFn = submit) {
  let mesh;
  try {
    mesh = parseGlb(await readFile(args.local_path));
  } catch (e) {
    return emResult({ ok: false, via: "editable_mesh", error: `glb parse failed: ${e.message}` });
  }
  // Guard: a valid glb whose first primitive has no geometry would otherwise send
  // zero batches and report a false success (no MeshPart created). No silent truncation.
  if (mesh.vertices.length === 0 || mesh.triangles.length === 0) {
    return emResult({ ok: false, via: "editable_mesh", error: "parsed mesh has no geometry (0 verts/tris)" });
  }
  if (mesh.triangles.length > 20000 || mesh.vertices.length > 60000) {
    return emResult({ ok: false, via: "editable_mesh", error: "exceeds EditableMesh limits (20k tris / 60k verts) — decimate in Blender" });
  }
  const sessionId = randomUUID();
  // Stream vertices in batches; triangles ride along with the LAST batch so all
  // vertex ids exist before any triangle references them.
  let last;
  for (let v = 0; v < mesh.vertices.length; v += EM_VERT_BATCH) {
    const isLastVertBatch = v + EM_VERT_BATCH >= mesh.vertices.length;
    last = await submitFn("editable_mesh_build", {
      sessionId,
      name: args.name || "BlenderMesh",
      parent: args.parent_path || "Workspace",
      vertexBase: v,
      vertices: mesh.vertices.slice(v, v + EM_VERT_BATCH),
      triangles: isLastVertBatch ? mesh.triangles : [],
      finalize: isLastVertBatch,
    }, 120_000);
    if (last && last.error) return emResult({ ok: false, via: "editable_mesh", ...last });
  }
  if (!last) return emResult({ ok: false, via: "editable_mesh", error: "no batches sent (empty mesh)" });
  return emResult({ ok: true, via: "editable_mesh", ...last });
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const jsonResult = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

  // ── OS-level tools handled directly (no plugin) ──
  if (name === "take_screenshot") {
    try {
      const region = sanitizeRegion(args.region);
      const { base64, mimeType, sizeBytes } = captureScreenshot({
        format: args.format === "png" ? "png" : "jpeg",
        maxWidth: toInt(args.max_width, 1280, { max: 16_384 }),
        region,
      });
      const tag = region
        ? `region ${region.width}x${region.height}`
        : "full screen";
      return {
        content: [
          { type: "text", text: `Screenshot captured (${tag}, ${(sizeBytes / 1024).toFixed(1)} KB).` },
          { type: "image", data: base64, mimeType },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Screenshot failed: ${err.message}` }],
        isError: true,
      };
    }
  }

  if (name === "capture_studio_window") {
    try {
      const { base64, mimeType, sizeBytes, window } = captureStudioWindow({
        format: args.format === "png" ? "png" : "jpeg",
        maxWidth: toInt(args.max_width, 1280, { max: 16_384 }),
      });
      const dims = window?.width ? `${window.width}x${window.height} at (${window.left},${window.top})` : "?";
      return {
        content: [
          {
            type: "text",
            text: `Studio window captured (${dims}, ${(sizeBytes / 1024).toFixed(1)} KB).\n` +
              `window: ${JSON.stringify(window ?? {})}`,
          },
          { type: "image", data: base64, mimeType },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `capture_studio_window failed: ${err.message}` }],
        isError: true,
      };
    }
  }

  if (name === "screenshot_diff") {
    try {
      const target = args.target === "screen" ? "screen" : "studio";
      const threshold = toInt(args.threshold, 10, { min: 0, max: 765 });
      const r = screenshotDiff({
        delay_seconds: toInt(args.delay_seconds, 1, { min: 0, max: 60 }),
        threshold,
        target,
      });
      return {
        content: [
          { type: "text", text: `Diff (${target}): ${r.percent_changed}% of ${r.pixels_sampled} sampled pixels changed (threshold ${threshold}, ${r.width}x${r.height}).` },
          { type: "image", data: r.before_b64, mimeType: "image/png" },
          { type: "image", data: r.after_b64,  mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `screenshot_diff failed: ${err.message}` }], isError: true };
    }
  }

  if (name === "simulate_input") {
    try {
      const result = simulateInputOS(args.actions ?? []);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `simulate_input failed: ${err.message}` }],
        isError: true,
      };
    }
  }

  // get_connection_status answers from server state — never reaches plugin
  if (name === "get_connection_status") {
    const status = await getStatus();
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }

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

  if (name === "roblox_upload_asset") {
    const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    const creatorId = process.env.ROBLOX_OPEN_CLOUD_CREATOR_ID;
    const creatorType = process.env.ROBLOX_OPEN_CLOUD_CREATOR_TYPE || "User";
    if (!apiKey || !creatorId) {
      return jsonResult({ ok: false, error: "ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_OPEN_CLOUD_CREATOR_ID must be set" });
    }
    try {
      const { operationId } = await uploadAsset({ apiKey, creatorId, creatorType, filePath: args.local_path, displayName: args.name, description: args.description });
      const { assetId } = await pollOperation({ apiKey, operationId });
      return jsonResult({ ok: true, assetId, kind: args.asset_type || "Model" });
    } catch (e) {
      return jsonResult({ ok: false, error: String(e.message || e) });
    }
  }

  if (name === "roblox_insert_uploaded_model") {
    // NOTE: command type is "insert_uploaded_model" (plugin handler), NOT the tool name.
    const result = await submit("insert_uploaded_model", {
      assetId: args.assetId, parent: args.parent_path || "Workspace", name: args.name,
    });
    return jsonResult(result);
  }

  if (name === "import_blender_model") {
    const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    const creatorId = process.env.ROBLOX_OPEN_CLOUD_CREATOR_ID;
    const creatorType = process.env.ROBLOX_OPEN_CLOUD_CREATOR_TYPE || "User";
    if (apiKey && creatorId) {
      try {
        const { operationId } = await uploadAsset({ apiKey, creatorId, creatorType, filePath: args.local_path, displayName: args.name || "BlenderModel" });
        const { assetId } = await pollOperation({ apiKey, operationId });
        const result = await submit("insert_uploaded_model", { assetId: Number(assetId), parent: args.parent_path || "Workspace", name: args.name });
        return jsonResult({ ...result, ok: true, via: "open_cloud", assetId });
      } catch (e) {
        return jsonResult({ ok: false, via: "open_cloud", error: String(e.message || e) });
      }
    }
    // ── C7d: composite studio-pinning is handled HERE (upstream early-return),
    // NOT in the routeCall chokepoint switch. import_blender_model fans out many
    // editable_mesh_build submits that MUST all land on ONE studio, so we resolve
    // the studio ONCE and pin every batch to it. If this early-return is ever
    // removed, re-add pin_composite handling to the chokepoint or meshes can split
    // across studios on a mid-sequence re-pair.
    const pin = await resolveSessionTarget(args.studio_target);
    if (pin && pin.error) return emResult({ ok: false, via: "editable_mesh", ...pin });
    // Composite batches build their payloads INSIDE importViaEditableMesh, so
    // they used to bypass the CallTool chokepoint injection. That whole
    // mechanism moved to the TRANSPORT layer (watchdogBudget in http-bridge/
    // broker-client) — every submit path is budgeted there now, so nothing is
    // injected here. (scrutinize 2026-09-05 MAJOR 2: composite submits must
    // never skip timeout_s.)
    const pinnedSubmit = pin && pin.studioId
      ? (type, payload, timeoutMs) => submitTo(pin.studioId, type, payload, timeoutMs)
      : undefined; // default param = the global submit
    return await importViaEditableMesh(args, pinnedSubmit); // EditableMesh fallback (Task 7) — builds its own content shape
  }

  // ── Plugin-routed tools ──
  let payload;
  switch (name) {
    case "run_luau":
      payload = { code: args.code };
      break;
    case "get_tree":
      payload = { path: args.path ?? "game.Workspace", depth: args.depth ?? 3 };
      break;
    case "create_part": {
      const props = {
        Name: args.name ?? "Part",
        Anchored: args.anchored ?? true,
        Material: args.material ?? "Plastic",
      };
      if (args.position) props.Position = args.position;
      if (args.size) props.Size = args.size;
      if (args.color) props.Color = args.color;
      payload = { parent: args.parent ?? "Workspace", properties: props };
      break;
    }
    case "create_script":
      payload = {
        parent: args.parent,
        name: args.name,
        source: args.source,
        type: args.script_type ?? "Script",
      };
      break;
    case "set_property":
      payload = { path: args.path, property: args.property, value: coerceMcpValue(args.value) };
      break;
    case "delete_instance":
      payload = { path: args.path };
      break;
    case "read_script":
      payload = { path: args.path, offset: args.offset, limit: args.limit };
      break;
    case "update_script":
      payload = { path: args.path, source: args.source };
      break;
    case "script_grep":
      payload = { pattern: args.pattern, max_results: args.max_results, pattern_mode: args.pattern_mode };
      break;
    case "multi_edit":
      payload = { scripts: args.scripts };
      break;
    case "get_console_output":
      payload = {
        lines: args.lines ?? 50,
        filter: args.filter,
        channels: args.channels,
        since_seconds: args.since_seconds,
        pattern: args.pattern,
      };
      break;
    case "get_selection":
      payload = {};
      break;
    case "create_instance":
      payload = {
        className: args.class_name,
        parent: args.parent ?? "Workspace",
        name: args.name,
        properties: coerceProps(args.properties ?? {}),
      };
      break;
    case "find_instances":
      payload = {
        name: args.name,
        className: args.class_name,
        root: args.root ?? "game",
        maxResults: args.max_results ?? 50,
        matchMode: args.match_mode ?? "substring",
      };
      break;
    case "validate_path":
      payload = { path: args.path };
      break;
    case "clear_console_output":
      payload = {};
      break;
    case "get_attributes":
      payload = { path: args.path };
      break;
    case "set_attribute":
      payload = {
        path: args.path,
        name: args.name,
        value: coerceMcpValue(args.value),
        valueType: args.type,
        remove: args.remove ?? false,
      };
      break;
    case "find_by_attribute":
      payload = {
        name: args.name,
        value: coerceMcpValue(args.value),
        root: args.root ?? "game",
        maxResults: args.max_results ?? 50,
      };
      break;
    case "play_animation":
      payload = {
        target: args.target,
        assetId: args.asset_id,
        looped: args.looped,
        fadeTime: args.fade_time ?? 0.1,
        weight: args.weight ?? 1,
        speed: args.speed ?? 1,
      };
      break;
    case "stop_animations":
      payload = {
        target: args.target,
        fadeTime: args.fade_time ?? 0.1,
      };
      break;
    case "batch_set_property":
      payload = {
        updates: Array.isArray(args.updates)
          ? args.updates.map(u => ({ ...u, value: coerceMcpValue(u?.value) }))
          : args.updates,
      };
      break;
    case "array_clone":
      payload = {
        source: args.source,
        mode: args.mode,
        parent: args.parent,
        namePattern: args.name_pattern,
        count: args.count,
        offset: args.offset,
        countX: args.count_x,
        countZ: args.count_z,
        spacingX: args.spacing_x,
        spacingZ: args.spacing_z,
        origin: args.origin,
        radius: args.radius,
        center: args.center,
        rotateToFace: args.rotate_to_face,
      };
      break;
    case "tween_multi":
      payload = {
        path: args.path,
        properties: coerceProps(args.properties),
        duration: args.duration ?? 1,
        easing_style: args.easing_style,
        easing_direction: args.easing_direction,
        repeat_count: args.repeat_count,
        reverses: args.reverses,
        delay: args.delay,
        wait: args.wait,
      };
      break;
    case "add_highlight":
      payload = {
        path: args.path,
        fillColor: args.fill_color,
        outlineColor: args.outline_color,
        fillTransparency: args.fill_transparency,
        outlineTransparency: args.outline_transparency,
        name: args.name,
        clear: args.clear,
      };
      break;
    case "weld_parts":
      payload = {
        partA: args.part_a,
        partB: args.part_b,
        type: args.type ?? "WeldConstraint",
        name: args.name,
      };
      break;
    case "set_collision_group":
      payload = { path: args.path, group: args.group };
      break;
    case "set_collision_groups_collidable":
      payload = {
        groupA: args.group_a,
        groupB: args.group_b,
        collidable: args.collidable,
      };
      break;
    case "give_tool":
      payload = {
        toolPath: args.tool_path,
        playerName: args.player_name,
        destination: args.destination ?? "Backpack",
      };
      break;
    case "fire_remote":
      payload = {
        path: args.path,
        args: args.args ?? [],
        playerName: args.player_name,
      };
      break;
    case "get_player_info":
      payload = { playerName: args.player_name };
      break;
    case "set_humanoid":
      payload = { playerName: args.player_name, props: args.props ?? {} };
      break;
    case "teleport_player":
      payload = {
        playerName: args.player_name,
        position: args.position,
        lookAt: args.look_at,
      };
      break;
    case "respawn_player":
      payload = { playerName: args.player_name };
      break;
    case "insert_model":
      payload = { assetId: args.asset_id, parent: args.parent ?? "Workspace" };
      break;
    case "get_studio_mode":
      payload = {};
      break;
    case "rename_instance":
      payload = { path: args.path, newName: args.new_name };
      break;
    case "move_instance":
      payload = { path: args.path, newParent: args.new_parent };
      break;
    case "start_stop_play":
      payload = { mode: args.mode };
      break;
    case "run_script_in_play_mode":
      payload = {
        code: args.code,
        timeout: args.timeout ?? 30,
        mode: args.mode ?? "start_play",
      };
      break;
    case "get_properties":
      payload = { path: args.path, names: args.names };
      break;
    case "undo":
      payload = { count: args.count ?? 1 };
      break;
    case "redo":
      payload = { count: args.count ?? 1 };
      break;
    case "duplicate_instance":
      payload = {
        path: args.path,
        parent: args.parent,
        name: args.name,
        offset: args.offset,
      };
      break;
    case "set_camera":
      payload = {
        position: args.position,
        look_at: args.look_at,
        preset: args.preset,
        target_path: args.target_path,
        distance: args.distance,
      };
      break;
    case "select_instance":
      payload = { paths: args.paths, focus: args.focus };
      break;
    case "apply_tag":
      payload = { path: args.path, tag: args.tag, remove: args.remove };
      break;
    case "get_tagged":
      payload = { tag: args.tag, root: args.root };
      break;
    case "get_bounds":
      payload = { path: args.path };
      break;
    case "raycast":
      payload = {
        from: args.from, to: args.to, direction: args.direction, distance: args.distance,
        filter: args.filter, filter_mode: args.filter_mode, ignore_water: args.ignore_water,
      };
      break;
    case "get_parts_in_region":
      payload = {
        center: args.center, radius: args.radius, min: args.min, max: args.max,
        filter: args.filter, filter_mode: args.filter_mode, max_parts: args.max_parts,
      };
      break;
    case "find_path":
      payload = { start: args.start, goal: args.goal, agent: args.agent };
      break;
    case "npc_walk_path":
      payload = { start: args.start, goal: args.goal, timeout: args.timeout, radius: args.radius, height: args.height };
      break;
    case "drop_to_ground":
      payload = { path: args.path, max_drop: args.max_drop };
      break;
    case "align_to":
      payload = { source: args.source, target: args.target, side: args.side, gap: args.gap };
      break;
    case "create_parts":
      payload = { parts: args.parts };
      break;
    case "humanoid_move":
      payload = {
        direction: args.direction, duration: args.duration, jump: args.jump,
        player: args.player, path: args.path,
        wait_for_character: args.wait_for_character,
      };
      break;
    case "play_sound_preview":
      payload = { sound_id: args.sound_id, duration: args.duration, volume: args.volume };
      break;
    case "play_sound_in_world":
      payload = {
        soundId: args.sound_id,
        position: args.position,
        duration: args.duration ?? 5,
        volume: args.volume ?? 1,
        rollOffMin: args.roll_off_min ?? 10,
        rollOffMax: args.roll_off_max ?? 100,
      };
      break;
    case "create_beam":
      payload = {
        partA: args.part_a,
        partB: args.part_b,
        width: args.width ?? 1,
        color: args.color,
        transparency: args.transparency ?? 0,
        name: args.name ?? "Beam",
      };
      break;
    case "create_particle_burst":
      payload = {
        target: args.target,
        textureAssetId: args.texture_asset_id,
        count: args.count ?? 30,
        rate: args.rate ?? 50,
        lifetime: args.lifetime ?? 1,
        speed: args.speed ?? 5,
        color: args.color,
        duration: args.duration ?? 0.5,
        continuous: args.continuous ?? false,
      };
      break;
    case "tween_property":
      payload = {
        path: args.path, property: args.property, goal: coerceMcpValue(args.goal),
        duration: args.duration, easing_style: args.easing_style,
        easing_direction: args.easing_direction, repeat_count: args.repeat_count,
        reverses: args.reverses, delay: args.delay, wait: args.wait,
      };
      break;
    case "luau_typecheck":
      payload = { source: args.source };
      break;
    case "diff_workspace":
      payload = { root: args.root, name: args.name, action: args.action };
      break;
    case "profile_play_mode":
      payload = { duration: args.duration };
      break;
    case "fill_terrain":
      payload = {
        material: args.material, shape: args.shape,
        center: args.center, radius: args.radius, min: args.min, max: args.max,
      };
      break;
    case "set_lighting":
      payload = { preset: args.preset, properties: args.properties };
      break;
    case "workspace_overview":
      payload = {};
      break;
    case "add_marker":
      payload = {
        label: args.label, position: args.position, attach_path: args.attach_path,
        color: args.color, clear: args.clear,
      };
      break;
    case "snapshot_camera":
      payload = { name: args.name };
      break;
    case "restore_camera":
      payload = { name: args.name };
      break;
    case "get_asset_info":
      payload = { asset_id: args.asset_id, info_type: args.info_type };
      break;
    case "create_humanoid_model":
      payload = {
        user_id: args.user_id, parent: args.parent,
        name: args.name, position: args.position,
      };
      break;
    default:
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }

  // ── Routing chokepoint ──
  // The public submit(type,payload,timeout) signature is never changed; target
  // routing is decided here and dispatched via submit / submitTo / fanout /
  // control-queue. `args.studio_target` is read for routing but NEVER written
  // into `payload` (the per-tool payload is built from named fields above and
  // never spreads `args`), so every plugin handler is untouched. The per-tool
  // wall-clock budget clears the tool's own deadline plus slack (a long-running
  // plugin op must not be cut off by the fixed 30s wall).
  const budget = toolTimeoutMs(name, args);
  // (Plugin watchdog budgeting lives in the TRANSPORT layer now — watchdogBudget
  // in http-bridge/broker-client — so EVERY submit path, including early-return
  // composites (insert_uploaded_model / import_blender_model), is covered and
  // no call site can bypass it. The per-call wall-clock budget is passed to the
  // submit calls below, which is exactly what the transport derives
  // payload.timeout_s from.)
  const route = routeCall({ name, args, sessionTarget: SESSION_TARGET });
  let result;
  switch (route.kind) {
    case "stop_control":
      // C3: start_stop_play{stop} →
      //   broker mode: __stop_play on the studio's CONTROL queue (carries no
      //     payload) so it reaches a plugin whose COMMAND loop is yielded inside
      //     a play test (§5.9).
      //   inline mode: no control loop — route the stop through the NORMAL command
      //     path exactly as today (single session handles it on the command loop).
      result = BROKER_MODE
        ? await submitControl(route.target, "__stop_play", {}, budget)
        : await submit(name, payload, budget);
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
      // routeCall never reaches the chokepoint with `control_tool` (handled by
      // the early returns above) or `pin_composite` (only import_blender_model is
      // a composite, handled at its own call site). So only stop_control / fanout
      // / submit_to / submit_default land here; default covers submit_default.
      result = await submit(name, payload, budget);
      break;
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

// ---------------------------------------------------------------------------
// Connect MCP transport
// ---------------------------------------------------------------------------

// ── Session teardown ──
// Forward concern from Task 4: an in-proc broker leader owns an httpServer with
// no free-running idle-reaper, so it must not outlive THIS session. When the
// stdio transport ends (the MCP client/host disconnects), stop the heartbeat and
// close the bound httpServer (if any) so the in-proc broker dies with the
// session. Idempotent; safe in both modes (inline createBridge also exposes one).
let teardownDone = false;
function teardownBridge() {
  if (teardownDone) return;
  teardownDone = true;
  try { bridge.stopHeartbeat?.(); } catch {}
  try { bridge.httpServer?.close?.(); } catch {}
}

const transport = new StdioServerTransport();
// server.onclose is the SDK's public teardown hook — it fires when the stdio
// transport closes (the host disconnects). We do NOT set transport.onclose
// directly: server.connect() overwrites it to route into server.onclose, so
// hooking the Server is the stable contract. Signals cover an external kill.
server.onclose = teardownBridge;
process.once("SIGINT", () => { teardownBridge(); process.exit(0); });
process.once("SIGTERM", () => { teardownBridge(); process.exit(0); });
await server.connect(transport);
