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

const { submit, getStatus } = createBridge({
  port: HTTP_PORT,
  authToken: (process.env.ROBLOX_MCP_TOKEN || "").trim(),
  brandPrefix: "[roblox-mcp]",
});

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

async function importViaEditableMesh(args) {
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
    last = await submit("editable_mesh_build", {
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
    const status = getStatus();
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
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
    return await importViaEditableMesh(args); // EditableMesh fallback (Task 7) — builds its own content shape
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
      payload = { path: args.path };
      break;
    case "update_script":
      payload = { path: args.path, source: args.source };
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

  // Long-running, plugin-side-bounded tools need a server timeout that clears
  // their own deadline plus slack — otherwise the fixed 30s wall fires while
  // the handler is still legitimately running and its real result is dropped.
  const result = await submit(name, payload, toolTimeoutMs(name, args));
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

// ---------------------------------------------------------------------------
// Connect MCP transport
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
