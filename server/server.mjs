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
import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Shared command queue
// ---------------------------------------------------------------------------

/** @type {Array<{id:string,type:string,payload:any,resolve:(r:any)=>void,timeout:NodeJS.Timeout}>} */
const pending = [];
/** @type {Map<string, {resolve:(r:any)=>void, timeout:NodeJS.Timeout}>} */
const inFlight = new Map();
/** @type {Array<(cmd:any)=>void>} */
const waiters = [];

const DEFAULT_TIMEOUT_MS = 30_000;

// Plugin liveness tracking. Every successful /poll updates this; an external
// client can query /connection_status (or call the MCP tool) to learn whether
// a plugin is actively polling.
let lastPollAt = 0;
const PLUGIN_STALE_MS = 12_000; // poll long-poll is 10s + slack

function submit(type, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const cmd = { id, type, payload };
    const timeout = setTimeout(() => {
      inFlight.delete(id);
      resolve({ error: `timeout after ${timeoutMs}ms — is the Roblox Studio plugin connected?` });
    }, timeoutMs);
    inFlight.set(id, { resolve, timeout });

    if (waiters.length > 0) {
      const w = waiters.shift();
      w(cmd);
    } else {
      pending.push(cmd);
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP server (Roblox plugin talks to this)
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // GET /poll  — long-poll up to 10s for the next command
  if (req.method === "GET" && url.pathname === "/poll") {
    lastPollAt = Date.now();
    if (pending.length > 0) {
      const cmd = pending.shift();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cmd));
      return;
    }
    let sent = false;
    const timer = setTimeout(() => {
      if (sent) return;
      sent = true;
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    }, 10_000);
    const waiter = (cmd) => {
      if (sent) return;
      sent = true;
      clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cmd));
    };
    waiters.push(waiter);
    return;
  }

  // POST /result/<id>  — plugin returns a result for a command
  if (req.method === "POST" && url.pathname.startsWith("/result/")) {
    const id = url.pathname.slice("/result/".length);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const handler = inFlight.get(id);
      if (handler) {
        clearTimeout(handler.timeout);
        inFlight.delete(id);
        try {
          handler.resolve(JSON.parse(body || "{}"));
        } catch {
          handler.resolve({ error: "invalid JSON from plugin" });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    return;
  }

  // POST /submit  — manual submission for agents without tool access
  if (req.method === "POST" && url.pathname === "/submit") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { type, payload } = JSON.parse(body);
        const result = await submit(type, payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /health
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, queued: pending.length, inFlight: inFlight.size }));
    return;
  }

  // GET /connection_status  — plugin liveness + queue depth
  if (req.method === "GET" && url.pathname === "/connection_status") {
    const now = Date.now();
    const sinceLastPoll = lastPollAt === 0 ? null : now - lastPollAt;
    const pluginConnected = lastPollAt !== 0 && sinceLastPoll < PLUGIN_STALE_MS;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      pluginConnected,
      msSinceLastPoll: sinceLastPoll,
      queued: pending.length,
      inFlight: inFlight.size,
      ready: pluginConnected && inFlight.size === 0 && pending.length === 0,
    }));
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(8765, "127.0.0.1");

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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // ── OS-level tools handled directly (no plugin) ──
  if (name === "take_screenshot") {
    try {
      const { base64, mimeType, sizeBytes } = captureScreenshot({
        format: args.format ?? "jpeg",
        maxWidth: args.max_width ?? 1280,
        region: args.region ?? null,
      });
      const tag = args.region
        ? `region ${args.region.width}x${args.region.height}`
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
        format: args.format ?? "jpeg",
        maxWidth: args.max_width ?? 1280,
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
      const target = args.target ?? "studio";
      const r = screenshotDiff({
        delay_seconds: args.delay_seconds ?? 1,
        threshold: args.threshold ?? 10,
        target,
      });
      return {
        content: [
          { type: "text", text: `Diff (${target}): ${r.percent_changed}% of ${r.pixels_sampled} sampled pixels changed (threshold ${args.threshold ?? 10}, ${r.width}x${r.height}).` },
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
    const now = Date.now();
    const sinceLastPoll = lastPollAt === 0 ? null : now - lastPollAt;
    const pluginConnected = lastPollAt !== 0 && sinceLastPoll < PLUGIN_STALE_MS;
    const status = {
      pluginConnected,
      msSinceLastPoll: sinceLastPoll,
      queued: pending.length,
      inFlight: inFlight.size,
      ready: pluginConnected && inFlight.size === 0 && pending.length === 0,
    };
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
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
      payload = { path: args.path, property: args.property, value: args.value };
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
        properties: args.properties ?? {},
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
        value: args.value,
        valueType: args.type,
        remove: args.remove ?? false,
      };
      break;
    case "find_by_attribute":
      payload = {
        name: args.name,
        value: args.value,
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
      payload = { updates: args.updates };
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
        properties: args.properties,
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
        path: args.path, property: args.property, goal: args.goal,
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

  const result = await submit(name, payload);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
