# Roblox Multi-AI (v6.1)

ระบบ AI หลายตัวทำงานร่วมกันสร้างเกม Roblox ผ่าน Roblox Studio
ใช้ Claude Code เป็น Orchestrator และ MCP Server เป็นสะพานเชื่อมไปยัง Studio

```
You → Orchestrator (Claude Code) → [Designer / Builder / Scripter / UI / Tester]
                                                         ↓
                                              MCP Server (Node.js)
                                                         ↓ HTTP :8765
                                              Roblox Studio Plugin
                                                         ↓
                                                  Roblox Studio
```

## ทีม Subagents

| Agent | Role | จุดเด่น |
|---|---|---|
| `roblox-designer` | วางแผนเกม (design doc) | ทำก่อนใครเมื่อเริ่ม feature ใหม่ |
| `roblox-builder` | สร้างโลก 3D (Parts, Models, terrain) | Iterate ด้วย screenshot + multi-angle camera |
| `roblox-scripter` | Server scripts / LocalScripts / Modules | --!strict, typed, tagged via CollectionService |
| `roblox-ui` | ScreenGuis, menus, HUDs | Layout / sizing / responsive |
| `roblox-tester` | Playtest (start play, simulate input, screenshot) | ไม่มี shortcut tools — บังคับให้ทดสอบจริง |

## ความสามารถหลัก

### 85 MCP Tools

**สร้าง / แก้ไข instance**
`create_part` · `create_parts` (batch) · `create_instance` · `create_script` · `duplicate_instance` · `delete_instance` · `set_property` · `batch_set_property` (multi-prop in one round-trip) · `rename_instance` · `move_instance` · `insert_model` · `align_to` (edge-snap) · `drop_to_ground` (raycast snap) · `array_clone` (linear/grid/radial duplication)

**อ่าน / สำรวจ**
`get_tree` · `get_properties` (รวม bounds อัตโนมัติ) · `get_bounds` (true 3D bounding box + edges) · `find_instances` (substring/exact/pattern modes) · `validate_path` (cheap existence check) · `read_script` · `update_script` · `get_selection` · `workspace_overview` · `diff_workspace` (snapshot+compare)

**Spatial intelligence (Roblox native)**
`raycast` · `get_parts_in_region` (box/sphere query) · `find_path` (PathfindingService)

**Play mode / scripting**
`start_stop_play` · `run_script_in_play_mode` · `run_luau` · `simulate_input` (OS-level SendInput + scancode + key_down/up + mouse button drag) · `humanoid_move` (drive Humanoid:Move ตรงๆ) · `npc_walk_path` (NPC + Pathfinding + MoveTo — solves obby autoplay) · `create_humanoid_model` · `profile_play_mode` (FPS/memory)

**กล้อง / Selection / Visual**
`set_camera` (preset + target + auto-fit, รองรับ Folder) · `select_instance` (with `focus`) · `snapshot_camera` / `restore_camera` · `add_marker` (debug Beam + label)

**Tagging (CollectionService)**
`apply_tag` · `get_tagged`

**Attributes (per-instance metadata)**
`get_attributes` · `set_attribute` (supports remove) · `find_by_attribute` (by name + optional value, component-wise compare for Vector3/Color3)

**Screenshot / Observability**
`capture_studio_window` (Win32 PrintWindow — Studio เท่านั้น) · `take_screenshot` (full screen + region crop) · `screenshot_diff` (pixel delta %) · `get_console_output` (channels, since, pattern filter) · `clear_console_output` (reset baseline)

**Terrain / Audio / Animation / Lighting**
`fill_terrain` (TerrainService — fill/dig) · `set_lighting` (presets: day/night/sunset/foggy/horror/...) · `play_sound_preview` (global) · `play_sound_in_world` (3D positional, auto-cleanup) · `tween_property` (TweenService, auto type-coerce) · `tween_multi` (multi-property single TweenInfo) · `play_animation` (auto-Animator on Humanoid/AnimationController/Model) · `stop_animations`

**Physics**
`weld_parts` (WeldConstraint/Motor6D) · `set_collision_group` (auto-register) · `set_collision_groups_collidable`

**Player / Event helpers (Play mode)**
`give_tool` (clone Tool → Backpack/Character) · `fire_remote` (FireClient/FireAllClients/BindableEvent) · `get_player_info` (Humanoid+HRP+leaderstats live state) · `set_humanoid` (bulk Humanoid props) · `teleport_player` (HRP CFrame, optional look_at) · `respawn_player` (LoadCharacter)

**Visual feedback**
`add_marker` (debug ball + label) · `add_highlight` (real Highlight outline that follows the instance) · `create_beam` (auto-Attachments + Beam between two BaseParts) · `create_particle_burst` (one-shot or continuous ParticleEmitter, auto-cleanup)

**Asset / Validation**
`get_asset_info` (MarketplaceService) · `luau_typecheck` (pre-flight syntax check)

**State / connection**
`get_studio_mode` · `get_connection_status` · `undo` · `redo`

### Plugin features
- **Auto-connect** เมื่อเปิด Studio (ไม่ต้องคลิก Connect)
- **Toggle button** ที่ Toolbar → start/stop polling
- **Undo รองรับ** — ทุก write ห่อด้วย `ChangeHistoryService:TryBeginRecording`
- **Spatial intelligence** — ทุก tool ที่เกี่ยวกับตำแหน่ง คำนวณจาก bounding box จริง (edges) ไม่ใช่แค่ center position
- **Smart type coercion** — `tween_property` / `set_property` อ่าน type ปัจจุบันแล้ว coerce goal ให้ตรงอัตโนมัติ (number/Vector3/Color3/UDim2/CFrame/EnumItem)
- **Reliable movement testing** — `npc_walk_path` ใช้ PathfindingService + Humanoid:MoveTo แทนการกด keyboard → 100% reliable สำหรับ playtest

## โครงสร้างโปรเจกต์

```
roblox-multi-ai/
├── README.md                  ← ไฟล์นี้
├── SETUP.md                   ← ติดตั้งทีละขั้น
├── CLAUDE.md                  ← คำสั่ง Orchestrator (Claude)
├── AGENTS.md                  ← คำสั่งชุดเดียวกัน (สำหรับ agent tool อื่นๆ)
├── .mcp.json                  ← project-scoped MCP config
├── sync-plugin.ps1            ← copy plugin → Studio install folder
├── server/
│   ├── server.mjs             ← MCP server + HTTP bridge
│   ├── tools.mjs              ← นิยาม MCP tools
│   ├── os-tools.mjs           ← OS-level input/screenshot helpers
│   └── package.json
├── plugin/
│   └── MultiAIPlugin.lua      ← Roblox Studio plugin (auto-connect)
└── .claude/
    └── agents/
        ├── roblox-designer.md
        ├── roblox-builder.md
        ├── roblox-scripter.md
        ├── roblox-ui.md
        └── roblox-tester.md
```

## เริ่มต้น

ดู [SETUP.md](SETUP.md) — ครั้งเดียวจบ

หลังติดตั้งเสร็จ เปิด Studio (plugin auto-connect), เปิด terminal:

```powershell
cd <REPO>
claude
```

ตรวจการเชื่อมต่อ:
```
/mcp                          # ใน Claude Code — ควรเห็น roblox: connected
```
หรือสั่ง AI ให้เรียก `get_connection_status` ก็ได้

### ตัวอย่างคำสั่ง

- `สร้างเกม obby ง่ายๆ มี 5 ด่าน`
- `ทำเกม simulator เก็บเหรียญแล้วเลเวลขึ้น`
- `เพิ่มเมนูหลักในเกมที่กำลังเปิดอยู่`
- `สร้างบ้านสีน้ำตาลขนาด 20x20 พร้อมประตูที่เปิดได้`
- `ลองเดินไปข้างหน้าใน Play mode แล้วบอกว่า walkspeed ถูกต้องไหม`

Orchestrator จะแบ่งงานให้ subagent แต่ละตัว — ผลโผล่ใน Studio ทันที
