// server/tools.mjs — MCP tool definitions (extracted from server.mjs)
// All tool schemas live here; server.mjs imports { TOOLS } from this module.
import { CONTROL_OR_OS_LOCAL } from "./lib/dispatch-routing.mjs";
export { CONTROL_OR_OS_LOCAL };
const RAW_TOOLS = [
  {
    name: "run_luau",
    description:
      "Execute arbitrary Luau code inside Roblox Studio. The code runs with full access to `game`, `workspace`, all services. Use `print(...)` to capture output. A bare expression's value is returned as return_value. Errors are caught and returned with a traceback. NOTE: the code must yield periodically (e.g. task.wait) if it loops — a non-yielding infinite loop cannot be preempted and wedges the executor until Studio restarts.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "Luau source code" } },
      required: ["code"],
    },
  },
  {
    name: "get_tree",
    description:
      "Inspect the Instance hierarchy of an object in Studio. path is a dotted path like 'game.Workspace'. depth is recursion levels (1-6). For project-wide overview, prefer `workspace_overview` (cheaper).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", default: "game.Workspace" },
        depth: { type: "number", default: 3, minimum: 1, maximum: 6 },
      },
    },
  },
  {
    name: "create_part",
    description:
      "Create a Part in Roblox Studio. position/size are [x,y,z]. color is [r,g,b] in 0..1.",
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string", default: "Workspace" },
        name: { type: "string", default: "Part" },
        position: { type: "array", items: { type: "number" } },
        size: { type: "array", items: { type: "number" } },
        color: { type: "array", items: { type: "number" } },
        anchored: { type: "boolean", default: true },
        material: { type: "string", default: "Plastic" },
      },
    },
  },
  {
    name: "create_script",
    description:
      "Create a Script / LocalScript / ModuleScript in Studio. parent is a dotted path (e.g. 'game.ServerScriptService').",
    inputSchema: {
      type: "object",
      properties: {
        parent: { type: "string" },
        name: { type: "string" },
        source: { type: "string" },
        script_type: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], default: "Script" },
      },
      required: ["parent", "name", "source"],
    },
  },
  {
    name: "set_property",
    description:
      "Set a property on any Instance. path is dotted, property is the property name, value is the new value (lists for Vector3/Color3).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        property: { type: "string" },
        value: {},
      },
      required: ["path", "property", "value"],
    },
  },
  {
    name: "delete_instance",
    description: "Destroy an Instance at the given dotted path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_script",
    description:
      "Read the source code of a Script / LocalScript / ModuleScript at the given dotted path. Use BEFORE update_script when iterating on existing code.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-indexed line to start reading from (line-range read for big scripts)." },
        limit: { type: "number", description: "Max lines to return (with offset). Without offset, reads the whole file." },
      },
      required: ["path"],
    },
  },
  {
    name: "update_script",
    description:
      "Replace the source code of an existing Script / LocalScript / ModuleScript. Use this to iterate on scripts (read_script first, then update_script).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        source: { type: "string" },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "get_console_output",
    description:
      "Get recent console output from Roblox Studio (print, warn, error, info). Returns the most recent N messages plus per-type counts. Use the filters to drill down — e.g. `channels:[\"Error\",\"Warning\"]` to find problems, or `since_seconds:30` to see only output from the last 30 s (great right after running a script).",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", default: 50, description: "Max number of recent entries to return." },
        filter: {
          type: "string",
          enum: ["Output", "Warning", "Error", "Info"],
          description: "Legacy: filter to a single channel. Prefer `channels` for multi-select.",
        },
        channels: {
          type: "array",
          items: { type: "string", enum: ["Output", "Warning", "Error", "Info"] },
          description: "Restrict to these channels. Empty/omitted = all.",
        },
        since_seconds: {
          type: "number",
          description: "Only return messages from the last N seconds (uses LogService timestamps).",
        },
        pattern: {
          type: "string",
          description: "Case-insensitive substring; only messages containing this text are returned.",
        },
      },
    },
  },
  {
    name: "get_selection",
    description:
      "Return the list of Instances currently selected by the user in the Studio Explorer. Useful before modifying — operate on what the user is looking at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_instance",
    description:
      "Create ANY Instance class — Folder, Model, RemoteEvent, BindableEvent, ProximityPrompt, ParticleEmitter, Sound, Animation, Tool, Attachment, etc. Use this for non-Part / non-Script objects. For Parts use create_part; for Scripts use create_script.",
    inputSchema: {
      type: "object",
      properties: {
        class_name: {
          type: "string",
          description: "Roblox ClassName, e.g. 'Folder', 'Model', 'RemoteEvent', 'Tool'",
        },
        parent: { type: "string", default: "Workspace" },
        name: { type: "string" },
        properties: { type: "object", description: "Optional property overrides" },
      },
      required: ["class_name"],
    },
  },
  {
    name: "find_instances",
    description:
      "Search the Instance tree by Name and/or ClassName. Returns full paths. `match_mode` controls how `name` is compared:\n  • `substring` (default) — case-insensitive contains (e.g. \"coin\" matches \"Coin_01\")\n  • `exact` — case-sensitive equal (e.g. \"Coin\" matches only \"Coin\")\n  • `pattern` — Lua string pattern (e.g. \"^Coin_%d+$\")",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name to search for (interpretation depends on match_mode)" },
        class_name: { type: "string", description: "Filter by ClassName via IsA() — e.g. 'BasePart', 'Script'" },
        root: { type: "string", default: "game", description: "Where to start searching" },
        max_results: { type: "number", default: 50 },
        match_mode: {
          type: "string",
          enum: ["substring", "exact", "pattern"],
          default: "substring",
          description: "How to match `name` against instance names.",
        },
      },
    },
  },
  {
    name: "validate_path",
    description:
      "Quickly check whether a dotted path resolves to an Instance. Returns `{ exists, className, name, fullPath }` without serializing properties or children. Much cheaper than `get_properties` when you only need to know 'does this exist?' — useful before `set_property`/`delete_instance`/`update_script` to avoid silent no-ops.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Dotted path, e.g. 'game.Workspace.Map.Floor'" } },
      required: ["path"],
    },
  },
  {
    name: "clear_console_output",
    description:
      "Clear the Studio Output window AND the LogService history buffer. Use this BEFORE running a test to establish a clean baseline — subsequent `get_console_output` calls will then only return new messages from after the clear.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_attributes",
    description:
      "Read all Attributes on an Instance. Attributes are the modern way to attach arbitrary metadata (Damage, Owner, Locked, etc.) — they replicate, save to file, and don't require subclassing. Returns `{ attributes: { [name]: { value, type } }, count }`. Values are serialized (Vector3→[x,y,z], Color3→[r,g,b], BrickColor→name, etc.). Use BEFORE `set_attribute` to know what's already set.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "set_attribute",
    description:
      "Set (or remove with `remove: true`) an Attribute on an Instance. `type` disambiguates list values (e.g. `[1,0,0]` could be Vector3 or Color3). For number/string/boolean, omit `type` — auto-detected. Attribute changes replicate to clients automatically. To delete the attribute, pass `remove: true` (value is ignored).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        name: { type: "string" },
        value: { description: "New value. Primitive (number/string/boolean) or list. Ignored when remove:true." },
        type: {
          type: "string",
          enum: ["Vector3", "Vector2", "Color3", "UDim", "UDim2", "BrickColor", "CFrame", "number", "string", "boolean"],
          description: "Explicit type. Required for list-shaped values; auto for primitives.",
        },
        remove: { type: "boolean", default: false },
      },
      required: ["path", "name"],
    },
  },
  {
    name: "find_by_attribute",
    description:
      "Find all Instances under `root` carrying a given Attribute. `name` is required. If `value` is provided, only instances where the attribute equals that value are returned (component-wise for Vector3/Color3 — pass `[x,y,z]`). Returns `{ results: [{ path, className, name, value }], count, capped }`. Use to query 'all enemies with Faction=red', 'all parts with Loot>0', 'all checkpoints in stage 3', etc.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Attribute name to match." },
        value: { description: "Optional: filter to instances where the attribute equals this value." },
        root: { type: "string", default: "game" },
        max_results: { type: "number", default: 50 },
      },
      required: ["name"],
    },
  },
  {
    name: "play_animation",
    description:
      "Play an animation asset on a Humanoid / AnimationController / Model containing one. Auto-creates an Animator child if missing. `target` is the dotted path. `asset_id` is the numeric Animation AssetId. Returns `{ ok, animatorPath, trackName }`. Best results in Play mode — Edit mode may load the track but won't visually animate.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Path to Humanoid, AnimationController, or a Model containing one." },
        asset_id: { type: "number", description: "Numeric Animation AssetId (just the ID — rbxassetid:// is added automatically)." },
        looped: { type: "boolean", description: "Override the animation's looped flag." },
        fade_time: { type: "number", default: 0.1 },
        weight: { type: "number", default: 1 },
        speed: { type: "number", default: 1 },
      },
      required: ["target", "asset_id"],
    },
  },
  {
    name: "stop_animations",
    description:
      "Stop ALL currently playing animations on the target's Animator. `fade_time` controls blend-out duration. Use to clean up after a test or before playing a new animation that should fully replace.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        fade_time: { type: "number", default: 0.1 },
      },
      required: ["target"],
    },
  },
  {
    name: "batch_set_property",
    description:
      "Set multiple properties on multiple Instances in ONE round-trip. Each item is `{ path, property, value }`. Failures are collected per-item — successful ones still apply. Returns `{ total, succeeded, results: [{ ok, error? }] }`. Wrap many tweaks (recolor a Model's parts, retag walls, bulk-anchor) without paying N round-trips.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              property: { type: "string" },
              value: {},
            },
            required: ["path", "property", "value"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "array_clone",
    description:
      "Clone an Instance multiple times in one round-trip. Three modes:\n  • `linear` — N copies along an offset vector: needs `count` + `offset:[dx,dy,dz]`\n  • `grid` — 2D grid in XZ plane: needs `count_x`, `count_z`, `spacing_x`, `spacing_z` (origin defaults to source pos)\n  • `radial` — N copies around a circle: needs `count`, `radius` (axis defaults to Y; set `rotate_to_face:true` to make clones face the center)\nFar faster than calling `duplicate_instance` N times. Works on both BaseParts and Models (uses PivotTo to preserve orientation). `name_pattern` like \"Coin_{i}\" replaces `{i}` with 1-based index.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        mode: { type: "string", enum: ["linear", "grid", "radial"] },
        parent: { type: "string", description: "Override parent (default = source's parent)." },
        name_pattern: { type: "string", description: "Pattern with {i} for index, e.g. \"Coin_{i}\"." },
        count: { type: "number", description: "Linear & radial: number of copies." },
        offset: { type: "array", items: { type: "number" }, description: "Linear: per-step offset [dx,dy,dz]." },
        count_x: { type: "number", description: "Grid: copies along X." },
        count_z: { type: "number", description: "Grid: copies along Z." },
        spacing_x: { type: "number", description: "Grid: X stride between clones." },
        spacing_z: { type: "number", description: "Grid: Z stride between clones." },
        origin: { type: "array", items: { type: "number" }, description: "Grid: origin point (default = source pos)." },
        radius: { type: "number", description: "Radial: circle radius." },
        center: { type: "array", items: { type: "number" }, description: "Radial: circle center (default = source pos)." },
        rotate_to_face: { type: "boolean", description: "Radial: orient each clone to face the center." },
      },
      required: ["source", "mode"],
    },
  },
  {
    name: "tween_multi",
    description:
      "Tween MULTIPLE properties on an Instance simultaneously (in sync, one TweenInfo). `properties` is a dict `{ Position: [x,y,z], Color: [r,g,b], Transparency: 0.5, ... }`. Values are coerced to the existing property's type. Use this instead of multiple `tween_property` calls — they fire at slightly different times and don't share a timeline.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        properties: { type: "object", description: "Dict of property → goal value." },
        duration: { type: "number", default: 1 },
        easing_style: { type: "string" },
        easing_direction: { type: "string" },
        repeat_count: { type: "number" },
        reverses: { type: "boolean" },
        delay: { type: "number" },
        wait: { type: "boolean" },
      },
      required: ["path", "properties"],
    },
  },
  {
    name: "add_highlight",
    description:
      "Add a real `Highlight` outline around a Part/Model — better than `add_marker` for 'look at THIS thing'. The Highlight follows the instance automatically. Pass `clear: true` to remove all MCP highlights. Colors default to readable cyan/white.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Instance to outline. Omit when clear:true." },
        fill_color: { type: "array", items: { type: "number" }, description: "[r,g,b] 0..1. Default light cyan." },
        outline_color: { type: "array", items: { type: "number" }, description: "[r,g,b] 0..1. Default cyan." },
        fill_transparency: { type: "number", default: 0.5 },
        outline_transparency: { type: "number", default: 0 },
        name: { type: "string", description: "Highlight name for later targeted removal." },
        clear: { type: "boolean", description: "Remove all MCP highlights." },
      },
    },
  },
  {
    name: "weld_parts",
    description:
      "Create a constraint between two BaseParts. `type`:\n  • `WeldConstraint` (default) — rigid weld, modern API, no C0/C1 math\n  • `Motor6D` — animatable joint (for character rigs, hinged contraptions)\nReturns `{ ok, constraintPath, type }`. Parent of the new constraint is `part_a`.",
    inputSchema: {
      type: "object",
      properties: {
        part_a: { type: "string", description: "Path to first BasePart (becomes Part0)." },
        part_b: { type: "string", description: "Path to second BasePart (becomes Part1)." },
        type: { type: "string", enum: ["WeldConstraint", "Motor6D"], default: "WeldConstraint" },
        name: { type: "string", description: "Optional constraint name." },
      },
      required: ["part_a", "part_b"],
    },
  },
  {
    name: "set_collision_group",
    description:
      "Set a Part's (or all BaseParts in a Model's) `CollisionGroup` to `group`. Auto-registers the group via `PhysicsService:RegisterCollisionGroup` if it doesn't exist. Pair with `set_collision_groups_collidable` to control which groups collide.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        group: { type: "string" },
      },
      required: ["path", "group"],
    },
  },
  {
    name: "set_collision_groups_collidable",
    description:
      "Set whether two collision groups physically collide. Auto-registers both groups if needed. Common pattern: `set_collision_groups_collidable(\"NPC\", \"Player\", false)` — NPCs walk through players.",
    inputSchema: {
      type: "object",
      properties: {
        group_a: { type: "string" },
        group_b: { type: "string" },
        collidable: { type: "boolean" },
      },
      required: ["group_a", "group_b", "collidable"],
    },
  },
  {
    name: "give_tool",
    description:
      "Clone a Tool into a player's Backpack or equip directly. `tool_path` points to the source Tool (typically in ServerStorage). `destination`: `\"Backpack\"` (default) or `\"Character\"` (auto-equips). `player_name` selects target — defaults to first player. Requires Play mode (Players service is empty in Edit).",
    inputSchema: {
      type: "object",
      properties: {
        tool_path: { type: "string" },
        player_name: { type: "string" },
        destination: { type: "string", enum: ["Backpack", "Character"], default: "Backpack" },
      },
      required: ["tool_path"],
    },
  },
  {
    name: "fire_remote",
    description:
      "Fire a `RemoteEvent` or `BindableEvent` from the plugin (server context). For RemoteEvent: `FireAllClients(...args)` by default, or `FireClient(player, ...args)` if `player_name` is provided. For BindableEvent: just `Fire(...args)`. Use for testing client handlers without writing a server script. Requires Play mode for RemoteEvent.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        args: { type: "array", description: "Arguments to pass to the event." },
        player_name: { type: "string", description: "RemoteEvent only: target specific player via FireClient." },
      },
      required: ["path"],
    },
  },
  {
    name: "get_player_info",
    description:
      "Read live state of a player: character path, Humanoid info (Health/MaxHealth/WalkSpeed/JumpPower/state), HRP position/velocity, leaderstats. `player_name` defaults to first player. Requires Play mode. Returns `{}` if no players in game. Use to verify health/position after a test action without `run_luau`.",
    inputSchema: {
      type: "object",
      properties: { player_name: { type: "string" } },
    },
  },
  {
    name: "set_humanoid",
    description:
      "Bulk-set Humanoid properties on a player's character. Pass `props: { WalkSpeed?: number, JumpPower?: number, Health?: number, MaxHealth?: number, ... }`. Per-property failures are ignored (returned in `skipped`). Use for test setup — easier than `set_property` × N on the Humanoid path. Requires Play mode.",
    inputSchema: {
      type: "object",
      properties: {
        player_name: { type: "string" },
        props: { type: "object", description: "Humanoid property dict." },
      },
      required: ["props"],
    },
  },
  {
    name: "teleport_player",
    description:
      "Move a player's character via HumanoidRootPart CFrame. Pass `position: [x,y,z]`. Optional `look_at: [x,y,z]` to face a direction. Use for test setup (put player near an obstacle, then test interaction). NOT for tester end-to-end runs — use real input there. Requires Play mode.",
    inputSchema: {
      type: "object",
      properties: {
        player_name: { type: "string" },
        position: { type: "array", items: { type: "number" } },
        look_at: { type: "array", items: { type: "number" } },
      },
      required: ["position"],
    },
  },
  {
    name: "respawn_player",
    description:
      "Force a player to respawn via `player:LoadCharacter()`. Gives a fresh character with full health, ResetOnSpawn-flagged GUIs reset, etc. Use to clean up between tests. Requires Play mode.",
    inputSchema: {
      type: "object",
      properties: { player_name: { type: "string" } },
    },
  },
  {
    name: "insert_model",
    description:
      "Insert an asset from the Roblox Creator Store / Toolbox by AssetId. The asset is unpacked and parented at the given location. Use this to bring in pre-made models (trees, weapons, characters, kits) instead of building from scratch.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "number", description: "Numeric AssetId of the model on Roblox" },
        parent: { type: "string", default: "Workspace" },
      },
      required: ["asset_id"],
    },
  },
  {
    name: "get_studio_mode",
    description:
      "Returns the current Studio mode: { isRunning, isEdit, isStudio, isClient, isServer }. Use to check whether Play test is running before modifying things.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rename_instance",
    description: "Rename an Instance at the given path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        new_name: { type: "string" },
      },
      required: ["path", "new_name"],
    },
  },
  {
    name: "move_instance",
    description: "Reparent an Instance to a new parent path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        new_parent: { type: "string" },
      },
      required: ["path", "new_parent"],
    },
  },
  {
    name: "start_stop_play",
    description: `Control Roblox Studio Play/Run mode.
  mode options:
    "start_play"  — start Play mode (clients + server, like pressing F5)
    "run_server"  — start Run mode (server only, like pressing F8)
    "stop"        — stop whichever mode is currently running
  Returns immediately after sending the signal; actual mode change takes ~0.1–1s.`,
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["start_play", "run_server", "stop"],
          description: "start_play | run_server | stop",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "run_script_in_play_mode",
    description: `Run Luau code inside an active play-test session and capture the results.
  Automatically starts Play mode, waits for the code to finish (or timeout), then stops.
  Captures logs (print/warn/error), duration, and whether it timed out.
  Use this to test gameplay logic, validate server state, or run integration checks.`,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Luau code to run inside the play session (server context)",
        },
        timeout: {
          type: "number",
          default: 30,
          description: "Max seconds to wait before timing out (default 30)",
        },
        mode: {
          type: "string",
          enum: ["start_play", "run_server"],
          default: "start_play",
          description: "Whether to start full play (client+server) or server-only run mode",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "duplicate_instance",
    description:
      "Clone an Instance (with all descendants). Optionally reparent (`parent`), rename (`name`), and offset position (`offset: [dx,dy,dz]`). Great for repeating elements — bridges, fences, pillars, checkpoints — without re-running `create_part` for each piece.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Source instance dotted path." },
        parent: { type: "string", description: "Optional new parent. Defaults to source's parent." },
        name: { type: "string", description: "Optional new name for the clone." },
        offset: {
          type: "array",
          items: { type: "number" },
          description: "Optional [dx,dy,dz] world offset applied to the clone's pivot.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "set_camera",
    description:
      "Move Studio's Edit-mode camera. Three modes (in priority order): (1) explicit `position` + `look_at` vectors, (2) `preset` + `target_path` + optional `distance` — auto-frames a part/model from a preset angle, (3) `preset` alone — rotates around origin. Useful before `capture_studio_window` to see a build from a different angle.",
    inputSchema: {
      type: "object",
      properties: {
        position: { type: "array", items: { type: "number" }, description: "[x,y,z] camera world position." },
        look_at:  { type: "array", items: { type: "number" }, description: "[x,y,z] world point the camera should face." },
        preset: {
          type: "string",
          enum: ["top", "bottom", "front", "back", "left", "right", "isometric"],
          description: "Standard angle. Combine with `target_path` to frame a specific instance.",
        },
        target_path: { type: "string", description: "Optional: dotted path to a Model/Part to frame." },
        distance: { type: "number", description: "Optional camera distance (auto-fits if omitted)." },
      },
    },
  },
  {
    name: "select_instance",
    description:
      "Set the Studio Explorer / 3D selection to one or more instances. Pass `focus: true` to also zoom the camera to the first selected item. Useful to highlight what you're talking about so the user can verify visually.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description: "Single path or list of dotted paths.",
        },
        focus: { type: "boolean", description: "Also point the camera at the first selection." },
      },
      required: ["paths"],
    },
  },
  {
    name: "apply_tag",
    description:
      "Add (or remove with `remove: true`) a CollectionService tag on an Instance. Tagged groups are the modern way to wire gameplay — scripts can do `CollectionService:GetTagged(\"KillBrick\")` instead of hard-coding paths.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        tag:  { type: "string" },
        remove: { type: "boolean", default: false },
      },
      required: ["path", "tag"],
    },
  },
  {
    name: "raycast",
    description:
      "Shoot a ray and return what it hits (Instance path, position, normal, distance, material). Either pass `to: [x,y,z]` (ray ends there) or `direction: [dx,dy,dz]` + `distance`. Optional `filter: [paths]` with `filter_mode: \"exclude\"|\"include\"`. Returns `{ hit, path, position, normal, distance, material }`. Use for: snap-to-ground (raycast down from Y=999 to find surface), line-of-sight, NPC vision, click-to-place.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "array", items: { type: "number" }, description: "[x,y,z] origin" },
        to: { type: "array", items: { type: "number" }, description: "[x,y,z] ray endpoint" },
        direction: { type: "array", items: { type: "number" }, description: "[dx,dy,dz] direction (auto-normalized)" },
        distance: { type: "number", description: "Used with `direction`. Default 100." },
        filter: { type: "array", items: { type: "string" }, description: "List of instance paths to filter" },
        filter_mode: { type: "string", enum: ["exclude", "include"], default: "exclude" },
        ignore_water: { type: "boolean", default: false },
      },
      required: ["from"],
    },
  },
  {
    name: "get_parts_in_region",
    description:
      "Spatial query — list all BaseParts inside a box or sphere region. Use `center` + `radius` for sphere OR `min` + `max` for box. Optional `filter`/`filter_mode`/`max_parts` (default 200). Returns parts with their paths, positions, sizes. Use for: 'what's near the player?', 'count coins in this room', 'detect things in trigger zone'.",
    inputSchema: {
      type: "object",
      properties: {
        center: { type: "array", items: { type: "number" } },
        radius: { type: "number" },
        min: { type: "array", items: { type: "number" } },
        max: { type: "array", items: { type: "number" } },
        filter: { type: "array", items: { type: "string" } },
        filter_mode: { type: "string", enum: ["exclude", "include"], default: "exclude" },
        max_parts: { type: "number", default: 200 },
      },
    },
  },
  {
    name: "find_path",
    description:
      "PathfindingService — compute a walkable path from `start` to `goal` for a humanoid-sized agent. Returns `{ status, success, count, waypoints }` where waypoints are `{ position, action: \"Walk\"|\"Jump\"|\"Custom\" }`. Use for: (Builder) verify an obby/parkour build is actually walkable BEFORE shipping it, (Tester) drive an NPC along the path instead of mashing W+Space, (Scripter) mob/enemy AI movement.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "array", items: { type: "number" } },
        goal: { type: "array", items: { type: "number" } },
        agent: {
          type: "object",
          description: "Agent params: { radius, height, can_jump, jump_height, max_slope, waypoint_spacing }",
        },
      },
      required: ["start", "goal"],
    },
  },
  {
    name: "npc_walk_path",
    description:
      "**Smart tester.** Spawn an R6 dummy at `start`, compute a path via PathfindingService, drive it with `Humanoid:MoveTo` waypoint-by-waypoint until it reaches `goal` (or `timeout`). Returns `{ reached, waypoints_total, waypoints_reached, final_position, duration }`. **REQUIRES Play/Run mode** — wrap in `run_script_in_play_mode` if you want it auto-managed, or call directly while Play is active. Solves obby autoplay: AI tester can verify a course is clearable WITHOUT keyboard simulation.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "array", items: { type: "number" } },
        goal: { type: "array", items: { type: "number" } },
        timeout: { type: "number", default: 30 },
        radius: { type: "number" },
        height: { type: "number" },
      },
      required: ["start", "goal"],
    },
  },
  {
    name: "drop_to_ground",
    description:
      "Snap a part down to whatever's directly below it (raycast). Eliminates floating parts. `path` is the BasePart; `max_drop` is the search range (default 500). Returns `{ ok, dropped, landed_on }`.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_drop: { type: "number", default: 500 },
      },
      required: ["path"],
    },
  },
  {
    name: "align_to",
    description:
      "Snap `source` part edge-flush against `target` (Part/Model/Folder) on a chosen `side` (`+x`/`-x`/`+y`/`-y`/`+z`/`-z`) with optional `gap`. Uses real bounding boxes — no manual coord math. Use for: 'place wall flush to building', 'stack box on top of pedestal', 'add next platform 4 studs after this one' (side=\"+z\", gap=4).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "BasePart to move" },
        target: { type: "string", description: "Part/Model/Folder to align against" },
        side: { type: "string", enum: ["+x", "-x", "+y", "-y", "+z", "-z"] },
        gap: { type: "number", default: 0 },
      },
      required: ["source", "target", "side"],
    },
  },
  {
    name: "humanoid_move",
    description:
      "Drive a Humanoid via `Humanoid:Move(direction, false)` directly — no keyboard simulation. Targets a player (`player` name), a specific NPC (`path`), or the first player by default. `direction: [x,y,z]` world-space, `duration` in seconds, `jump: true` to also trigger Humanoid.Jump. `wait_for_character` (default 10s) — polls until Character + Humanoid + HRP exist with Health > 0. Requires Play mode. Much more reliable than `simulate_input` for movement.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "array", items: { type: "number" } },
        duration: { type: "number", default: 1 },
        jump: { type: "boolean" },
        player: { type: "string" },
        path: { type: "string" },
        wait_for_character: { type: "number", default: 10, description: "Max seconds to wait for character to spawn" },
      },
      required: ["direction"],
    },
  },
  {
    name: "play_sound_preview",
    description: "Play a Roblox Sound asset by ID for N seconds (auto-cleanup). Global (not 3D). Works in Edit and Play mode. For 3D positional audio use `play_sound_in_world`.",
    inputSchema: {
      type: "object",
      properties: {
        sound_id: { type: "number" },
        duration: { type: "number", default: 3 },
        volume: { type: "number", default: 0.5 },
      },
      required: ["sound_id"],
    },
  },
  {
    name: "play_sound_in_world",
    description:
      "Play a Sound at a 3D world position with rolloff (distance-attenuated). Spawns an invisible Part at `position`, parents a Sound to it, plays, then auto-cleans up after `duration`. Use for environmental SFX during testing (footsteps at a spot, explosion at coordinates, ambient buzz near an object).",
    inputSchema: {
      type: "object",
      properties: {
        sound_id: { type: "number" },
        position: { type: "array", items: { type: "number" }, description: "[x,y,z] world position." },
        duration: { type: "number", default: 5 },
        volume: { type: "number", default: 1 },
        roll_off_min: { type: "number", default: 10, description: "Distance at which volume starts to fall off." },
        roll_off_max: { type: "number", default: 100, description: "Distance at which volume is fully silent." },
      },
      required: ["sound_id", "position"],
    },
  },
  {
    name: "create_beam",
    description:
      "Create a visible Beam between two BaseParts (auto-creates the two Attachments). Common for lasers, links between objects, energy connections, lightning. Returns `{ beamPath, attachment0Path, attachment1Path }`. To remove cleanly, destroy the Beam (auto-created Attachments stay — tiny, harmless).",
    inputSchema: {
      type: "object",
      properties: {
        part_a: { type: "string" },
        part_b: { type: "string" },
        width: { type: "number", default: 1 },
        color: { type: "array", items: { type: "number" }, description: "[r,g,b] 0..1. Default white." },
        transparency: { type: "number", default: 0, description: "0..1 — uniform beam transparency." },
        name: { type: "string", default: "Beam" },
      },
      required: ["part_a", "part_b"],
    },
  },
  {
    name: "create_particle_burst",
    description:
      "Spawn a one-shot ParticleEmitter at a target (BasePart or Attachment), emit N particles, then auto-clean up. Use for explosions, sparks, magic hits, pickups. Pass `continuous: true` to leave the emitter running indefinitely (manually destroy later).",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Path to BasePart (auto-creates Attachment) or Attachment." },
        texture_asset_id: { type: "number", description: "Optional Texture AssetId. Default: built-in sparkle." },
        count: { type: "number", default: 30, description: "Number of particles to emit (one-shot mode)." },
        rate: { type: "number", default: 50, description: "Continuous-mode emission rate." },
        lifetime: { type: "number", default: 1 },
        speed: { type: "number", default: 5 },
        color: { type: "array", items: { type: "number" }, description: "[r,g,b] 0..1." },
        duration: { type: "number", default: 0.5, description: "How long to keep the emitter alive before cleanup." },
        continuous: { type: "boolean", default: false },
      },
      required: ["target"],
    },
  },
  {
    name: "tween_property",
    description:
      "Animate any property via TweenService. `easing_style`: Linear|Sine|Quad|Quart|Quint|Bounce|Elastic|Back. `easing_direction`: In|Out|InOut. Goal accepts lists for Vector3/Color3 (auto-coerced). Pass `wait: true` to block until completed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        property: { type: "string" },
        goal: {},
        duration: { type: "number", default: 1 },
        easing_style: { type: "string" },
        easing_direction: { type: "string" },
        repeat_count: { type: "number" },
        reverses: { type: "boolean" },
        delay: { type: "number" },
        wait: { type: "boolean" },
      },
      required: ["path", "property", "goal"],
    },
  },
  {
    name: "luau_typecheck",
    description: "Pre-flight **syntax** check on Luau source via `loadstring` — catches missing `end`, unbalanced parens, malformed strings, etc. Returns `{ syntax_valid, error, error_line }`. Note: this does NOT do strict-type analysis (no `--!strict` enforcement) — only parse-stage errors. Use BEFORE `create_script`/`update_script` to catch typos early.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
    },
  },
  {
    name: "diff_workspace",
    description:
      "Snapshot a subtree and compare what changed since the last snapshot. Two-phase usage: first call with `action:\"snapshot\"` to record state, do work, then call again (default action = compare) to get `{ added, removed, changed }` lists.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", default: "Workspace" },
        name: { type: "string", description: "Snapshot key (default = \"default\")" },
        action: { type: "string", enum: ["snapshot", "compare"], default: "compare" },
      },
    },
  },
  {
    name: "profile_play_mode",
    description: "Sample performance stats (FPS, memory) for N seconds during Play mode. Wrap in `run_script_in_play_mode` if calling from Edit. Returns avg FPS, frame count, memory_mb, samples.",
    inputSchema: {
      type: "object",
      properties: { duration: { type: "number", default: 3 } },
    },
  },
  {
    name: "screenshot_diff",
    description:
      "Take two screenshots `delay_seconds` apart and report what fraction of sampled pixels changed (above `threshold` RGB delta). Returns both images as base64 PLUS `percent_changed`. Great for verifying \"did anything visibly happen after I sent this input?\" without manual visual diff.\n\n`target`:\n  • `\"studio\"` (default) — only the Roblox Studio window (Win32 PrintWindow). Use this for verifying gameplay/UI changes — won't show taskbar/other apps. Works unfocused.\n  • `\"screen\"` — primary monitor in full (includes everything visible).",
    inputSchema: {
      type: "object",
      properties: {
        delay_seconds: { type: "number", default: 1 },
        threshold: { type: "number", default: 10, description: "RGB sum delta threshold (0..765)" },
        target: { type: "string", enum: ["studio", "screen"], default: "studio", description: "Studio window vs full primary screen." },
      },
    },
  },
  {
    name: "create_parts",
    description:
      "Batch-create many Parts in a single round-trip. Pass `parts: [{ parent?, name?, position, size, color?, material?, anchored?, transparency?, can_collide? }]`. Much faster than calling `create_part` N times.",
    inputSchema: {
      type: "object",
      properties: {
        parts: { type: "array", items: { type: "object" } },
      },
      required: ["parts"],
    },
  },
  {
    name: "fill_terrain",
    description:
      "TerrainService — fill a region with material. Box: `min` + `max`. Sphere: `center` + `radius` + `shape:\"ball\"`. Material name (e.g. `Grass`, `Rock`, `Sand`, `Water`, `Snow`). Use `material:\"Air\"` to dig.",
    inputSchema: {
      type: "object",
      properties: {
        material: { type: "string", default: "Grass" },
        shape: { type: "string", enum: ["block", "ball"] },
        center: { type: "array", items: { type: "number" } },
        radius: { type: "number" },
        min: { type: "array", items: { type: "number" } },
        max: { type: "array", items: { type: "number" } },
      },
    },
  },
  {
    name: "set_lighting",
    description:
      "Apply Lighting properties. `preset`: day | dawn | sunset | night | foggy | horror | bright. `properties: { TimeOfDay, Ambient: [r,g,b], Brightness, FogEnd, FogStart, FogColor: [r,g,b], ... }`. Both can be combined (preset first, then properties override).",
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["day", "dawn", "sunset", "night", "foggy", "horror", "bright"] },
        properties: { type: "object" },
      },
    },
  },
  {
    name: "workspace_overview",
    description:
      "High-level project summary: counts of Parts/Models/Scripts/etc per service, top-level Workspace children, all CollectionService tags + counts, current studio mode. Cheaper than `get_tree` for big projects.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_marker",
    description:
      "Drop a visible debug marker (neon ball + floating text label) into the world. Use `position: [x,y,z]` OR `attach_path` to anchor above a part. `label` is the text. `color: [r,g,b]` (0..1). Pass `clear: true` to remove all markers. Useful to point at things for the user.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        position: { type: "array", items: { type: "number" } },
        attach_path: { type: "string" },
        color: { type: "array", items: { type: "number" } },
        clear: { type: "boolean" },
      },
    },
  },
  {
    name: "snapshot_camera",
    description: "Save the current Camera CFrame under `name` (default \"default\") so you can restore it later with `restore_camera`.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "restore_camera",
    description: "Restore the Camera CFrame from a snapshot taken with `snapshot_camera`.",
    inputSchema: { type: "object", properties: { name: { type: "string" } } },
  },
  {
    name: "get_asset_info",
    description: "Query Roblox MarketplaceService for asset metadata: name, description, creator, price, IsForSale. `info_type: \"Asset\" | \"Bundle\"` (default Asset). Use BEFORE `insert_model` to know what you're about to insert.",
    inputSchema: {
      type: "object",
      properties: {
        asset_id: { type: "number" },
        info_type: { type: "string", enum: ["Asset", "Bundle"] },
      },
      required: ["asset_id"],
    },
  },
  {
    name: "create_humanoid_model",
    description: "Spawn a real Roblox avatar (by userId) as an NPC model. Combine with `npc_walk_path` for realistic playtest characters. `user_id` defaults to 1 (Roblox classic avatar).",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "number" },
        parent: { type: "string", default: "Workspace" },
        name: { type: "string" },
        position: { type: "array", items: { type: "number" } },
      },
    },
  },
  {
    name: "get_bounds",
    description:
      "Return the **true 3D bounding box** of any Instance — Part, Model, Folder, or container. Walks descendant BaseParts and computes min/max/center/size/radius PLUS named edge helpers (north_edge/south_edge/east_edge/west_edge/top_edge/bottom_edge). Use this whenever you need to reason about EDGES or GAPS between objects rather than just center positions — e.g. \"place a part right next to X\", \"is the gap between A and B jumpable?\", \"camera framing\". Returns `{ min, max, center, size, radius, north_edge, ... }` in world coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Dotted path to the Instance (e.g. 'Workspace.Map.Stage1')" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_tagged",
    description:
      "List all Instances carrying a given CollectionService tag. Optionally restrict to descendants of `root`. Use to inspect what gameplay-relevant objects exist (e.g. all `Coin`s, all `Checkpoint`s).",
    inputSchema: {
      type: "object",
      properties: {
        tag:  { type: "string" },
        root: { type: "string", description: "Optional ancestor to filter under." },
      },
      required: ["tag"],
    },
  },
  {
    name: "get_connection_status",
    description:
      "Check whether the Roblox Studio plugin is actively connected to the MCP server (i.e., polling for commands). Returns { pluginConnected, msSinceLastPoll, queued, inFlight, ready }. `ready: true` means the plugin is connected AND no commands are pending or in flight — safe to issue a new tool call without queueing. Call this BEFORE long sessions to verify connectivity, or after a timeout to diagnose.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_properties",
    description:
      "Read properties of an Instance. Returns its className, a curated set of common readable properties (Position, Size, Color, Text, etc.), and a short list of children. Pass `names` to query specific properties only. Use BEFORE set_property when you need to know the current value (e.g. nudge a part, toggle a flag).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Dotted path to the instance (e.g. 'game.Workspace.Map.Floor')" },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Optional: specific property names to read. Omit to use the default curated list.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "undo",
    description:
      "Undo the last N actions performed in Studio (via ChangeHistoryService). Use to roll back a mistake without manually deleting. Default count = 1.",
    inputSchema: {
      type: "object",
      properties: { count: { type: "number", default: 1 } },
    },
  },
  {
    name: "redo",
    description: "Redo previously undone actions. Default count = 1.",
    inputSchema: {
      type: "object",
      properties: { count: { type: "number", default: 1 } },
    },
  },
  {
    name: "take_screenshot",
    description:
      "Capture the WHOLE primary screen (or a region of it) and return as an image. Captures everything visible — Studio window, taskbar, other apps. Use `capture_studio_window` instead when you only need to see Studio. Supports an optional region for cropping.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["jpeg", "png"], default: "jpeg" },
        max_width: {
          type: "number",
          default: 1280,
          description: "Resize so width is at most this (0 = no resize).",
        },
        region: {
          type: "object",
          description: "Optional crop region in screen pixels. Omit for full screen.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
      },
    },
  },
  {
    name: "capture_studio_window",
    description:
      "Capture ONLY the Roblox Studio window — viewport + side panels + toolbars — and return as an image. Skips other apps, taskbar, and other monitors. Works without Studio being focused (uses Win32 PrintWindow). Returns window dimensions (`window.width`, `window.height`, `window.left`, `window.top`) so you can compute click coordinates relative to Studio. **Prefer this over `take_screenshot` for visual verification of builds, GUIs, and gameplay.**",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["jpeg", "png"], default: "jpeg" },
        max_width: {
          type: "number",
          default: 1280,
          description: "Resize so width is at most this (0 = no resize).",
        },
      },
    },
  },
  {
    name: "simulate_input",
    description: `Simulate keyboard and mouse input via OS-level Win32 SendInput.
  Use during Play mode for AUTOMATED PLAYTEST — move character (WASD), click UI buttons, jump (Space), rotate camera (right-mouse-drag), etc.
  Coordinates are absolute screen pixels. For Studio-relative coords, get window.left/top from capture_studio_window.

  Action types:
    { type: "key_press", key: "Space" }                    — press+release (default 60ms)
    { type: "key_hold",  key: "W", duration: 2 }            — hold then release after N seconds
    { type: "key_down",  key: "W" }                         — press AND HOLD (no release). Pair with key_up later.
    { type: "key_up",    key: "W" }                         — release a previously key_down key
    { type: "mouse_click", x:.., y:.., button: "left" }     — click at coords (button: left|right|middle)
    { type: "mouse_move",  x:.., y:.. }                     — move cursor
    { type: "mouse_drag",  from_x:.., from_y:.., to_x:.., to_y:.., button: "right" } — drag (button: left|right|middle). **Right-drag in Roblox = rotate camera.**
    { type: "wait", duration: 1 }                            — pause

  ## Concurrent keys (jump-while-running, strafe-walk, sprint+turn)
  Sequential key_press/key_hold cannot run two keys at once. Use key_down + key_up:
    [
      { type: "key_down",  key: "W" },                     // hold W down
      { type: "wait",      duration: 0.3 },                // walk 4-5 stud
      { type: "key_press", key: "Space" },                 // jump (W still held → running jump)
      { type: "wait",      duration: 0.5 },                // airborne, momentum carries
      { type: "key_up",    key: "W" }                       // release W on landing
    ]

  ## Camera rotation example (Roblox 3rd person)
  Right-mouse drag rotates the camera. Negative dx = look left, positive dx = look right.
    { type: "mouse_drag", from_x: 960, from_y: 540, to_x: 760, to_y: 540, button: "right" }   // rotate ~30° left
  `,
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "List of input actions to execute in order.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["key_press", "key_hold", "key_down", "key_up", "mouse_click", "mouse_move", "mouse_drag", "wait"],
              },
              key: { type: "string", description: "KeyCode name (e.g. 'W', 'Space', 'LeftShift')" },
              duration: { type: "number" },
              x: { type: "number" },
              y: { type: "number" },
              from_x: { type: "number" },
              from_y: { type: "number" },
              to_x: { type: "number" },
              to_y: { type: "number" },
              button: { type: "string", enum: ["left", "right", "middle"], description: "For mouse_click and mouse_drag. Default = left." },
            },
            required: ["type"],
          },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "roblox_upload_asset",
    description: "Upload a local mesh file (.glb/.fbx) to Roblox via Open Cloud and return its assetId. Requires ROBLOX_OPEN_CLOUD_API_KEY + ROBLOX_OPEN_CLOUD_CREATOR_ID env.",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string" },
        asset_type: { type: "string", default: "Model" },
        name: { type: "string" },
        description: { type: "string", default: "" },
      },
      required: ["local_path", "name"],
    },
  },
  {
    name: "roblox_insert_uploaded_model",
    description: "Insert an already-uploaded asset into Studio by assetId (InsertService:LoadAsset + reparent, with moderation retry).",
    inputSchema: { type: "object", properties: { assetId: { type: "number" }, parent_path: { type: "string", default: "Workspace" }, name: { type: "string" } }, required: ["assetId"] },
  },
  {
    name: "import_blender_model",
    description: "End-to-end: upload a local .glb via Open Cloud then insert into Studio. Falls back to EditableMesh (no cloud) when ROBLOX_OPEN_CLOUD_API_KEY is unset.",
    inputSchema: { type: "object", properties: { local_path: { type: "string" }, parent_path: { type: "string", default: "Workspace" }, name: { type: "string" } }, required: ["local_path"] },
  },
  {
    name: "script_grep",
    description:
      "Search a pattern across EVERY script's source in the game (Scripts, LocalScripts, ModuleScripts). pattern_mode:'plain' (default) = literal substring — safe for text like 'print('. pattern_mode:'pattern' = Luau string pattern. Returns path/line/snippet matches, capped at max_results. Far faster than get_tree+read_script scans for 'where is X defined?' questions in a big codebase.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text or Luau pattern to find. Interpreted per pattern_mode." },
        pattern_mode: { type: "string", enum: ["plain", "pattern"], default: "plain", description: "plain = literal substring (default, grep-like). pattern = Luau string pattern (metacharacters active)." },
        max_results: { type: "number", default: 50, description: "Cap on returned matches (1..200, default 50)." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "multi_edit",
    description:
      "Apply MULTIPLE script create/update operations in ONE command (one ChangeHistory undo step, one round-trip). Each op: {path, source} to UPDATE an existing script, or {parent, name, source, script_type?} to CREATE one. Prefer this over N create_script/update_script calls when editing several scripts at once.",
    inputSchema: {
      type: "object",
      properties: {
        scripts: {
          type: "array",
          description: "Up to 50 ops. Update ops need {path, source}; create ops need {parent, name, source, script_type?}.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Existing script path (dotted) → update its Source." },
              parent: { type: "string", description: "Create: parent dotted path (default Workspace)." },
              name: { type: "string", description: "Create: script name." },
              source: { type: "string", description: "Full new source." },
              script_type: { type: "string", enum: ["Script", "LocalScript", "ModuleScript"], default: "Script" },
            },
          },
        },
      },
      required: ["scripts"],
    },
  },
];

// ── Per-call studio_target injection (design §6.5, BINDING CORRECTION C1) ─
// Every plugin-routed ("data") tool may carry an optional `studio_target` to
// route the call to a specific Studio in a multi-studio session. The routing
// key is `studio_target` — NEVER `target`, which is already a REQUIRED DOMAIN
// parameter on play_animation, stop_animations, align_to, create_particle_burst.
// Those four tools correctly keep their own `target` AND additionally gain
// `studio_target`. The CONTROL_OR_OS_LOCAL set (imported from dispatch-routing.mjs,
// size 9) is the injection skip-set: control-plane + OS-local tools never get
// `studio_target` because they are answered in-process, never routed to a plugin.
// `studio_target` is always OPTIONAL — never appended to any tool's `required[]`.
const STUDIO_TARGET_PROP = {
  studio_target: {
    type: "string",
    description:
      "Optional studioId or studio label to route THIS call to a specific Studio. " +
      "Omit to use your attached/auto-paired studio.",
  },
};

function injectStudioTarget(tool) {
  if (CONTROL_OR_OS_LOCAL.has(tool.name)) return tool;
  const schema = tool.inputSchema ?? { type: "object", properties: {} };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: { ...(schema.properties ?? {}), ...STUDIO_TARGET_PROP },
    },
  };
}

// ── Control-plane tool definitions (design §6.4) ───────────────────────────
// Named CONTROL_TOOL_DEFS (not CONTROL_TOOLS — that name is already a Set
// exported by dispatch-routing.mjs; avoid the collision).
// Each is answered by server.mjs from broker endpoints, never sent to a plugin,
// so none of them gets a `studio_target` property (they are in CONTROL_OR_OS_LOCAL).
const CONTROL_TOOL_DEFS = [
  {
    name: "list_studios",
    description:
      "List every Studio, session, pair, and claim the broker knows about (multi-studio coordination). " +
      "Each studio reports its label, paired session (with `origin: \"auto\"|\"manual\"`), and `attachedSessions`. " +
      "Read-only; never blocked by a busy or claimed studio. Use this to discover routing targets before `attach_studio` or a per-call `studio_target`.",
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

export const TOOLS = [...RAW_TOOLS.map(injectStudioTarget), ...CONTROL_TOOL_DEFS];
