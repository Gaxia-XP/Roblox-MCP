# Blender MCP Bridge — Design Spec

**Date:** 2026-06-22
**Status:** Draft, awaiting user review
**Author:** Claude (with user direction)
**Supersedes:** none (new subsystem)

---

## 1. Problem Statement

The user wants Claude Code to be able to **build/sculpt 3D models in Blender and import them into Roblox Studio end-to-end**, with no manual click-through. The existing Roblox-MCP-v6 bridge handles in-Studio building (parts, scripts, UI) but the only way to bring in custom mesh geometry today is via `insert_model`, which requires a Roblox `AssetId` the human has already uploaded by hand. There is no path for "AI designs a chair in Blender → chair appears in Workspace" without a human in the loop.

## 2. Goals & Non-Goals

### Goals (v1)

- A second MCP server (`blender/server.mjs`) that exposes Blender modeling primitives as tools.
- A Blender addon (`blender/addon/MultiAI_Blender.py`) that runs inside the user's open Blender, polls the bridge, and executes commands on the bpy main thread.
- An end-to-end pipeline: Blender geometry → `.glb` on disk → uploaded to Roblox via Open Cloud → `InsertService:LoadAsset` reparents the resulting Model into Workspace.
- A graceful **EditableMesh fallback** when no Open Cloud API key is configured (caps at 20k tris, no PBR).
- Mirror the existing Roblox bridge's hardening (loopback Host check, optional shared-secret, body cap, timeout, EADDRINUSE handling, late-result logging).
- A new orchestrator-callable agent profile (`blender-builder`) so the existing Designer→Builder→Tester loop extends naturally into Blender-side work.

### Non-Goals (v1)

- Sculpting (`bpy.ops.sculpt.*`), dyntopo, multires. The bpy sculpt API is GUI-context-only and the output blows past Roblox's 20k-tri per-MeshPart ceiling. Refused at tool-registration.
- Generative-mesh integrations (Hyper3D Rodin, Hunyuan3D-2, Sketchfab download). Separate API surfaces; not needed for "AI builds it".
- Arbitrary Python execution (`exec`). ahujasid/blender-mcp exposes this; we deliberately do not — it bypasses every guard.
- Skeletal animation / rigging. Static meshes only in v1.
- Cross-platform packaging. Windows-first, matching the rest of the project.
- A managed Blender install. Assumes the user already has Blender ≥ 4.0 installed.

## 3. Architecture

### 3.1 Topology — Twin-Bridge

```
                            stdio (MCP)
Claude Code ──────────────► server/server.mjs ───── HTTP :8765 ─────► plugin/MultiAIPlugin.lua  (Roblox Studio)
            ──────────────► blender/server.mjs ──── HTTP :8766 ─────► blender/addon/MultiAI_Blender.py  (Blender 4.x)
                                  │
                                  └── HTTPS ────► apis.roblox.com/assets/v1/  (Open Cloud upload, when API key set)
```

Two independent Node processes, two independent ports, two independent addons. A crash in one cannot take down the other. Each registers itself in `.mcp.json` under a separate key (`roblox`, `blender`).

### 3.2 Why this shape

- **Twin-bridge over single-process dual-server:** failure isolation. A bug in the Blender side mid-Studio session must not kill the live Roblox bridge.
- **Persistent addon over headless `blender --background`:** the agent's iterate loop ("ลอง → screenshot → แก้") needs sub-second turnaround. Headless cold-start is 2–5 s per call on Windows and re-loads the `.blend` each time, killing the loop.
- **HTTP long-poll over raw TCP sockets** (ahujasid pattern): keeps mental model identical to the Roblox plugin — same wire shape, same hardening primitives, same observability.
- **Shared HTTP-bridge primitives** extracted to a library before the second bridge is built: otherwise a hardening fix on one drifts away from the other.

### 3.3 Failure domains & lifecycles

- `server/server.mjs` (Roblox bridge): unchanged behavior; gains two new MCP tools (`roblox_upload_asset`, `roblox_insert_uploaded_model`, plus composite `import_blender_model`).
- `blender/server.mjs` (Blender bridge): independent stdio MCP. Restartable without touching Roblox state.
- `blender/addon/MultiAI_Blender.py`: lives inside Blender. Auto-enables on Blender startup (the addon is installed once via the existing `sync-plugin.ps1`-style helper). Reconnects on bridge restart.
- Open Cloud: external service; rate-limited (HTTP 429 handled with exponential backoff). Cap 20 MB per upload.

## 4. Component Design

### 4.1 `blender/server.mjs` (new)

Mirrors `server/server.mjs` shape:

- HTTP loopback on `127.0.0.1:8766` (override via `BLENDER_MCP_PORT`).
- Host-header check restricted to `127.0.0.1:8766` and `localhost:8766`.
- Optional shared secret `BLENDER_MCP_TOKEN` enforced on `/poll`, `/submit`, `/result/*` when set on both server and addon.
- 8 MB body cap, 30 s body timeout (lifted from the shared lib).
- `EADDRINUSE` → exit 1 with FATAL log; do not silent-fail.
- Late `/result/<id>` after caller-side timeout → log `late result for <id>, op may have completed Blender-side` (matches the Roblox-bridge pattern from commit `b2b4794`).
- Stdio MCP server exposes Blender tools (§ 5.1).

### 4.2 `blender/addon/MultiAI_Blender.py` (new)

`bl_info` declares Blender 4.0+. Auto-registers a panel under the "Multi-AI" sidebar tab. Lifecycle:

1. On addon enable: spin up `http.server.ThreadingHTTPServer` on a daemon thread (HTTP **client** to the bridge — long-polls `GET http://127.0.0.1:8766/poll`).
2. Daemon thread receives a command (JSON) → appends `(request_id, command_dict)` to `queue.Queue`.
3. `bpy.app.timers.register(drain, first_interval=0.02, persistent=True)` runs `drain()` on the **main thread**. It pops one command, dispatches to the bmesh-backed handler, captures the result, and POSTs to `http://127.0.0.1:8766/result/<id>`.
4. Long ops (heavy Boolean apply, large subsurf) are implemented as **Python generators**; the drain advances one step per tick and returns a small `float` to yield, so the UI never freezes for >50 ms.
5. `bpy.app.timers.register(poll_for_work, first_interval=0.5, persistent=True)` keeps the bridge connected; matches the 0.5 s cadence of `MultiAIPlugin.lua`.

**Hard rules:**
- All bpy access happens on the main thread (bpy is not thread-safe — confirmed by Blender devtalk).
- HTTP daemon thread is a **dumb queue feeder** — never touches `bpy.*`.
- Each command runs inside `bpy.ops.ed.undo_push(message=f"MCP {type}")` so the user can `Ctrl+Z` any AI mutation.

### 4.3 `server/lib/http-bridge.mjs` (new — extracted from `server/server.mjs`)

Refactor first, build second. Extract from current `server/server.mjs` (preserving behavior):

- `readBody(req, res, onComplete, { maxBytes, timeoutMs })`
- `createHostCheck(allowedHosts)` → middleware predicate
- `createAuthCheck(token, guardedPaths)` → middleware predicate
- `attachLifecycleHandlers(httpServer, { port })` → wires `clientError`, `error` (EADDRINUSE FATAL), `listen` log
- `createCommandQueue({ defaultTimeoutMs, onLateResult })` → returns `{ submit, handlePoll, handleResult, getStatus }`

`server/server.mjs` becomes a 100-line composition over this lib. `blender/server.mjs` is a near-identical 100-line composition with different tool routing. Hardening lands in one place.

### 4.4 Roblox-side additions (in existing `server/tools.mjs` + `plugin/MultiAIPlugin.lua`)

Three new handlers (Lua) + three new MCP tools (Node):

- **`roblox_upload_asset`** (Node only — no Lua handler needed): reads local file, POST `https://apis.roblox.com/assets/v1/assets` with `x-api-key`, polls `operations/{id}` until done, returns `{ assetId, kind }`.
- **`roblox_insert_uploaded_model`** (Node + Lua): Node forwards to plugin; plugin runs `InsertService:LoadAsset(assetId)` inside `ChangeHistoryService:TryBeginRecording`, walks the returned Model (since Open Cloud always returns a Model wrapper), reparents the inner MeshPart(s), returns full paths + names.
- **`import_blender_model`** (Node composite): calls `roblox_upload_asset` then `roblox_insert_uploaded_model` in sequence. If `ROBLOX_OPEN_CLOUD_API_KEY` is unset OR upload fails on a transient class, falls through to **EditableMesh path** (§ 4.5).

### 4.5 EditableMesh fallback (in `plugin/MultiAIPlugin.lua` + a small Node-side glb parser)

- Node parses the `.glb` (binary glTF — one self-contained file, well-specified parser, ~150 LOC or a small dep like `@gltf-transform/core`) into `{ vertices: Vector3[], triangles: [v1,v2,v3][], uvs?: Vector2[], normals?: Vector3[] }`.
- Streams arrays in batches over the existing 8765 bridge as a new `editable_mesh_build` command. **Batch size:** ≤ 4,000 vertices and ≤ 4,000 triangles per HTTP request to stay under the 8 MB body cap with headroom (typical: ~150 bytes per vertex JSON-encoded). Plugin re-assembles in a single EditableMesh under one `ChangeHistoryService` recording.
- Plugin calls `AssetService:CreateEditableMesh()`, drains the batches via `AddVertex` / `AddTriangle`, then `AssetService:CreateMeshPartAsync(Content.fromObject(em))` to materialize a MeshPart with **no cloud round-trip**.
- Hard refuses if `triangles > 20_000` or `vertices > 60_000` (Roblox EditableMesh limits) — agent then knows to re-export with stricter decimation.

## 5. Tool Surface

### 5.1 Blender MCP server (port 8766)

All geometry tools are bmesh-backed (avoids the `bpy.ops` context/poll trap; works in `--background` too if we ever want a CI mode).

| Tool | Purpose |
|---|---|
| `blender_create_primitive` | `kind: cube\|sphere\|cylinder\|cone\|plane\|torus`, `name`, `location`, `rotation`, `scale`, `segments?`. Writes to `bpy.data.meshes` + `bpy.data.objects`. |
| `blender_set_transform` | Direct `obj.matrix_world` assignment. No operator. |
| `blender_boolean` | `target`, `other`, `op: UNION\|DIFFERENCE\|INTERSECT`, `apply: bool`. Adds `BooleanModifier (solver=EXACT)`, optionally applies under `bpy.context.temp_override`. |
| `blender_array` | `target`, `count`, `offset_xyz`, `apply`. ArrayModifier. |
| `blender_mirror` | `target`, `axis: X\|Y\|Z`, `apply`. MirrorModifier. |
| `blender_subdivide` | `target`, `levels`, `kind: catmull\|simple`, `apply`. Subsurf or `bmesh.ops.subdivide_edges`. |
| `blender_bevel` | `target`, `edges_selector: all\|sharp_angle>=N`, `width`, `segments`. `bmesh.ops.bevel`. |
| `blender_set_material` | `target`, `base_color`, `roughness`, `metallic`, `texture_path?`. Maps to Roblox SurfaceAppearance on export. |
| `blender_get_tree` | Returns scene graph (collections, objects, mesh stats). Mirror of `mcp__roblox__get_tree`. |
| `blender_get_bounds` | `name` → world-space AABB + named edges. Mirror of `mcp__roblox__get_bounds`. |
| `blender_screenshot` | `bpy.ops.render.opengl(write_still=True)` viewport capture. Returns base64 PNG. Requires GUI mode (no-op error in `--background`). |
| `blender_get_connection_status` | `{ addonConnected, msSinceLastPoll, queued, inFlight, ready }` — same shape as `mcp__roblox__get_connection_status`. |
| `blender_export_to_roblox` | `target_or_collection`, `path`, `format: glb\|fbx\|obj` (default `glb`), `max_triangles: 10000`. When `format=fbx`, auto-sets the exporter's `global_scale=0.01` to compensate for Blender↔Roblox-stud mismatch; `glb` and `obj` pass through at unit scale. Pre-counts triangles after triangulation; refuses if over budget. |
| `blender_undo` | `bpy.ops.ed.undo()`. |
| `blender_save_as` | `path`. Only allowlisted `bpy.ops.wm.*`. |

### 5.2 Roblox MCP server additions (port 8765, existing)

| Tool | Purpose |
|---|---|
| `roblox_upload_asset` | `local_path`, `asset_type: Model\|Decal`, `name`. Open Cloud upload + poll. Returns `{ assetId, kind, operationId }`. |
| `roblox_insert_uploaded_model` | `assetId`, `parent_path`, `name?`. `InsertService:LoadAsset` + reparent inside `ChangeHistoryService`. Returns inserted paths. |
| `import_blender_model` | `local_path`, `parent_path`, `name?`. Composite: upload-then-insert. Falls back to EditableMesh path when API key absent. |

### 5.3 Refuse list (block at tool-registration, not runtime)

`bpy.ops.sculpt.*` · `bpy.ops.wm.*` except `save_as` · `bpy.ops.script.reload` · `bpy.ops.preferences.*` · generic `bpy.ops.object.mode_set` · any `exec(arbitrary_python)`.

Rationale: each of these is either GUI-context-only, self-modifying, or a remote-code-execution footgun for an autonomous agent.

## 6. End-to-End Flow

User: *"ทำเก้าอี้ไม้แล้ววางใน Workspace"*

1. Orchestrator → `roblox-designer` → plan: seat (0.5×0.5×0.05 cube), 4 legs (0.05r × 0.5h cylinders), backrest, wood material.
2. Orchestrator dispatches `blender-builder` (new agent, see § 8):
   ```
   blender_create_primitive(cube, name=Seat, scale=[0.5,0.5,0.05], location=[0,0,0.5])
   blender_create_primitive(cylinder, name=Leg, scale=[0.05,0.05,0.5], location=[0.2,0.2,0.25])
   blender_array(target=Leg, count=4, offset_xyz=[-0.4,0,0])   # → Leg, Leg.001, Leg.002, Leg.003
   blender_set_transform(Leg.001, location=[0.2,-0.2,0.25])
   …
   blender_boolean(Seat, Leg, UNION, apply=true) × 4
   blender_create_primitive(cube, name=Backrest, scale=[0.5,0.05,0.5], location=[0,-0.225,0.8])
   blender_boolean(Seat, Backrest, UNION, apply=true)
   blender_set_material(Seat, base_color=[0.45,0.27,0.07], roughness=0.7)
   blender_screenshot()                                        # agent verifies
   blender_export_to_roblox(Seat, path="%LOCALAPPDATA%/Roblox-MCP/blender/exports/Chair.glb")
   → { path: "...Chair.glb", triangles: 842 }
   ```
3. Orchestrator: `import_blender_model(local_path="...Chair.glb", parent_path="Workspace/Map/Decorations", name="Chair")`
   - Node POSTs to Open Cloud → polls operation → assetId
   - Enqueues bridge command on 8765 → plugin `InsertService:LoadAsset(assetId)` → reparent into `Workspace/Map/Decorations/Chair`
4. Orchestrator → `roblox-tester` → `capture_studio_window` to verify visually.

## 7. Hardening (lifted from Roblox bridge, codified in shared lib)

- **Host header allowlist:** only `127.0.0.1:<port>` and `localhost:<port>`. Defeats DNS-rebinding from a malicious local browser page.
- **Optional shared secret:** `BLENDER_MCP_TOKEN` on the server, mirrored in the addon's `AUTH_TOKEN`. Enforced on `/poll`, `/submit`, `/result/*` when set.
- **Body cap:** 8 MB. **Body timeout:** 30 s. Slow-loris guard.
- **EADDRINUSE:** FATAL exit. No silent-fail.
- **Late `/result/<id>` logging:** observability for "caller timed out but the mutation may still have happened addon-side".
- **`clientError` handler:** raw-socket malformed HTTP gets a 400, server stays up.
- **Generic 400 on `/submit`** parse failure: no parser internals echoed back.
- **Open Cloud API key redaction:** extend the existing token-redaction so `x-api-key` headers never reach logs.

## 8. Agent Wiring

New subagent definition in `.claude/agents/blender-builder.md`:

- Model: Opus (matches `roblox-builder`).
- Tools: all `mcp__blender__*` + `import_blender_model` (composite) from Roblox side.
- System prompt: "Build the Blender side of the 3D world — bmesh primitives + modifiers. Iterates with `blender_screenshot`. Hands off to the Roblox plugin only via `import_blender_model`. Does NOT script gameplay or build GUIs."
- The existing `roblox-designer` is updated to know about the new option: if a request needs custom mesh geometry (organic shapes, props, non-cuboid decorations), it dispatches `blender-builder` instead of (or in addition to) `roblox-builder`.

CLAUDE.md gets a new row in the team table and a new line in the routing rules.

## 9. File Layout

```
<repo>/
├── server/                     # existing Roblox bridge
│   ├── server.mjs              # ↓ thin composition over the new lib
│   ├── tools.mjs               # + roblox_upload_asset, roblox_insert_uploaded_model, import_blender_model
│   ├── lib/
│   │   └── http-bridge.mjs     # NEW — extracted shared primitives
│   ├── os-tools.mjs
│   └── package.json
├── blender/                    # NEW
│   ├── server.mjs              # thin composition over server/lib/http-bridge.mjs
│   ├── tools.mjs               # MCP tool schemas (blender_*)
│   ├── package.json
│   └── addon/
│       ├── MultiAI_Blender.py  # the Blender addon
│       └── README.md           # one-time install instructions
├── plugin/MultiAIPlugin.lua    # + insert_uploaded_model handler + editable_mesh_build handler
├── sync-blender-addon.ps1      # NEW — mirrors sync-plugin.ps1
├── .mcp.json                   # + "blender" entry
└── CLAUDE.md                   # + blender-builder row + routing rule
```

**Runtime paths (default, override via env):**
- `.blend` source files: `%LOCALAPPDATA%/Roblox-MCP/blender/` (override: `BLENDER_WORKSPACE_DIR`)
- Exports: `%LOCALAPPDATA%/Roblox-MCP/blender/exports/`
- Rationale: G:\ is Google Drive File Stream — Blender file locks fight Drive sync; per `deployment-vs-repo.md` memory, C:\ paths are safer for runtime state.

## 10. Environment

| Variable | Purpose | Default |
|---|---|---|
| `BLENDER_MCP_PORT` | Blender bridge HTTP port | `8766` |
| `BLENDER_MCP_TOKEN` | Optional shared secret for the Blender bridge | unset (no auth) |
| `BLENDER_WORKSPACE_DIR` | Where `.blend` and exports live | `%LOCALAPPDATA%/Roblox-MCP/blender/` |
| `BLENDER_EXE` | Path to the Blender executable (used only by the optional headless tester) | auto-detect via registry |
| `ROBLOX_OPEN_CLOUD_API_KEY` | Open Cloud Assets API key (scope: `asset:read` + `asset:write`) | unset → EditableMesh fallback |
| `ROBLOX_OPEN_CLOUD_CREATOR_ID` | User id or group id that owns uploads | required when key is set |
| `ROBLOX_OPEN_CLOUD_CREATOR_TYPE` | `User` or `Group` | `User` |

## 11. Risks & Fallbacks

| Risk | Mitigation / Fallback |
|---|---|
| User has no Open Cloud API key | EditableMesh path (no cloud, ≤20k tris, no PBR). Auto-selected when env is unset. |
| Mesh > 20k tris | `blender_export_to_roblox` pre-counts after triangulation; refuses with `{ ok: false, reason: "triangle_budget_exceeded", count, limit }`. Agent re-runs with stricter decimation or splits the mesh. |
| `bpy.ops.*` poll failure in headless / wrong context | Tools route through `bmesh` + `bpy.data` first; unavoidable operators wrapped in `bpy.context.temp_override`. |
| Blender thread-unsafety crash | Hard separation: HTTP daemon thread only feeds a `queue.Queue`; all bpy on main thread via `bpy.app.timers.register`. |
| Open Cloud 429 rate-limit | Sequential uploads, exponential backoff, honor `Retry-After`, surface to agent. |
| Open Cloud 20 MB body cap | Pre-check file size; refuse with remediation ("reduce texture size, decimate mesh, or split"). |
| Long Blender op freezes UI | Generator-based commands; drain advances one step per tick; reports `{ status: "in_progress", progress: 0.4 }` until done. |
| Addon socket port 8766 in use | EADDRINUSE-fatal; document `BLENDER_MCP_PORT` override. |
| Open Cloud `LoadAsset` returns Model wrapper not bare MeshPart | `roblox_insert_uploaded_model` walks the Model and exposes both the wrapper and inner MeshPart in the response so agent can address either. |
| Textures need separate Decal uploads | `import_blender_model` composite uploads each map, builds a `SurfaceAppearance` instance under the MeshPart with `ColorMap` / `NormalMap` / `RoughnessMap` / `MetalnessMap` pointing at the Decal ids. |
| G:\ Drive file-lock fights | Default workspace on `%LOCALAPPDATA%`; `.blend` never lives on Google Drive. |
| User runs Blender 3.x (not 4.x) | `bl_info` declares `(4, 0, 0)`; addon enable fails with a clear message naming the version requirement. |
| Addon-install friction (one-time, but easy to forget) | `sync-blender-addon.ps1` copies `MultiAI_Blender.py` into `%APPDATA%/Blender Foundation/Blender/<ver>/scripts/addons/`. Addon README walks through the one click in Edit → Preferences → Add-ons → enable. `blender_get_connection_status` is the smoke check; CLAUDE.md's "Connection check" section grows a Blender-side equivalent. |

## 12. Out of Scope / Deferred

- Generative-mesh integrations (Hyper3D Rodin / Hunyuan3D-2 / Sketchfab).
- Skeletal animation, rigging, blend shapes.
- Geometry Nodes wrapper (the surface is huge; add later when needed).
- Headless `blender --background` worker pool. May be revisited for CI.
- Multi-Blender-instance routing (single Blender per session, matches single-Studio constraint).
- Cross-platform support (macOS / Linux). Windows-only v1.

## 13. Open Decisions (defer to user before implementation)

None. All architectural decisions are made in this spec:

- **Studio handoff**: Open Cloud primary, EditableMesh auto-fallback.
- **Blender lifecycle**: user keeps Blender open with addon auto-enabled.
- **`.blend` storage**: `%LOCALAPPDATA%/Roblox-MCP/blender/`.
- **Process model**: twin-bridge (two MCP servers).
- **Port**: `8766` (`BLENDER_MCP_PORT` configurable).
- **Auth**: separate `BLENDER_MCP_TOKEN` env var.
- **Transport**: HTTP long-poll (not raw TCP).

## 14. Acceptance Criteria

The work is "done" when:

1. `node blender/server.mjs` starts cleanly on a free port (or `EADDRINUSE`-fatals on a taken port) — same shape as the Roblox bridge.
2. With Blender open and the addon enabled, `blender_get_connection_status` returns `{ addonConnected: true, ready: true }`.
3. The Happy Path (§ 6) runs end-to-end on the user's machine and a chair MeshPart appears under `Workspace/Map/Decorations/Chair`.
4. With `ROBLOX_OPEN_CLOUD_API_KEY` unset, the EditableMesh fallback runs end-to-end (no cloud), producing a MeshPart up to 20k tris.
5. The shared `server/lib/http-bridge.mjs` is the single source of truth for `readBody`, host check, EADDRINUSE handling, auth check, and late-result logging — and `server/server.mjs` behavior is bit-identical to its pre-refactor `b2b4794` form for every existing endpoint.
6. CLAUDE.md and `.mcp.json` are updated; `sync-blender-addon.ps1` ships and matches the style of `sync-plugin.ps1`.

---
