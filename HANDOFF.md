# Project Handoff — Roblox Multi-AI

> เอกสารส่งต่อโปรเจก ครอบคลุมสถาปัตยกรรม, ฟีเจอร์, วิธี extend, และ known issues

## 1. สรุปสั้น

ระบบ AI หลายตัวสร้างเกม Roblox ผ่าน MCP server เป็นสะพานเชื่อม Claude Code (หรือ Codex/Gemini CLI) → Roblox Studio plugin → Studio API

**สถานะปัจจุบัน:** 76 MCP tools, multi-provider ready, plugin auto-connect, undo รองรับ, spatial intelligence ครบ, attribute + animation + batch/array ops + collision groups + welds + visual highlight

## 2. สถาปัตยกรรม

```
User → Orchestrator (Claude/Codex/Gemini)
        ├── invokes subagents (designer/builder/scripter/ui/tester)
        └── calls MCP tools
                ↓ stdio (MCP protocol)
        MCP Server (Node.js — server/server.mjs, port 8765)
                ├── OS-level tools: take_screenshot, simulate_input, capture_studio_window, screenshot_diff
                └── HTTP /poll bridge ↔ Roblox Studio Plugin (plugin/MultiAIPlugin.lua)
                        ↓
                Studio API (Workspace, Services, PathfindingService, ChangeHistoryService, ฯลฯ)
```

**Communication flow:**
1. Orchestrator → MCP `CallTool` → server.mjs
2. server.mjs ตัดสินใจ: ถ้าเป็น OS tool → handle เลย; ถ้าเป็น Studio tool → push เข้า queue, รอ plugin /poll
3. Plugin poll → execute handler → POST /result/{id} → server resolve → orchestrator ได้ผล

## 3. โครงสร้างไฟล์

```
roblox-multi-ai/
├── README.md                      ← overview + feature list
├── SETUP.md                       ← install/run guide
├── CLAUDE.md                      ← system prompt + tool catalog (Claude)
├── AGENTS.md                      ← same for Codex/Gemini
├── HANDOFF.md                     ← (this file)
├── .mcp.json                      ← MCP server registration (project-scope)
├── sync-plugin.ps1                ← sync plugin source → Studio install folder
├── server/
│   ├── server.mjs                 ← MCP server entrypoint + HTTP bridge + dispatch switch (~20 KB)
│   ├── tools.mjs                  ← TOOLS array — all 73 tool schemas (~50 KB)
│   ├── os-tools.mjs               ← Win32/PowerShell helpers: simulateInputOS, screenshotDiff, captureStudioWindow, captureScreenshot (~22 KB)
│   ├── package.json               ← @modelcontextprotocol/sdk dep
│   └── node_modules/
├── plugin/
│   └── MultiAIPlugin.lua          ← Studio plugin (auto-connect + polling + handlers)
└── .claude/agents/                ← subagent definitions (Claude Code)
    ├── roblox-designer.md         ← plan-only
    ├── roblox-builder.md          ← 3D world (most tools)
    ├── roblox-scripter.md         ← Luau scripts
    ├── roblox-ui.md               ← GUIs
    └── roblox-tester.md           ← QA — NO write tools, must use simulate_input/humanoid_move
.codex/, .gemini/                  ← parallel configs (may lag behind .claude/)
```

**สำคัญ:** `plugin/MultiAIPlugin.lua` คือ source-of-truth. Roblox Studio โหลดจาก `%LOCALAPPDATA%\Roblox\Plugins\MultiAIPlugin.lua`. ทุกครั้งที่แก้ source ต้องรัน `sync-plugin.ps1` แล้ว reload plugin ใน Studio.

## 4. 76 MCP Tools

ดูรายละเอียดใน [README.md](README.md) หรือ [CLAUDE.md](CLAUDE.md). หมวดหลัก:

| หมวด | จำนวน | ตัวอย่าง |
|---|---|---|
| Instance writes | 17 | create_part, create_parts, duplicate_instance, align_to, drop_to_ground, batch_set_property, array_clone, weld_parts, add_highlight |
| Reads / inspection | 10 | get_tree, get_bounds, workspace_overview, diff_workspace, find_instances, validate_path |
| Spatial intelligence | 3 | raycast, get_parts_in_region, find_path |
| Play mode | 8 | run_script_in_play_mode, simulate_input, humanoid_move, npc_walk_path |
| Camera / visuals | 4 | set_camera, snapshot/restore_camera, select_instance |
| Tagging | 2 | apply_tag, get_tagged |
| Attributes | 3 | get_attributes, set_attribute, find_by_attribute |
| Screenshots / logs | 5 | capture_studio_window, screenshot_diff, get_console_output, clear_console_output |
| Terrain/Audio/Animation/Lighting | 8 | fill_terrain, set_lighting, tween_property, tween_multi, play_sound_preview, play_sound_in_world, play_animation, stop_animations |
| Visual effects | 4 | add_marker, add_highlight, create_beam, create_particle_burst |
| Physics | 2 | set_collision_group, set_collision_groups_collidable |
| Player / event helpers | 6 | give_tool, fire_remote, get_player_info, set_humanoid, teleport_player, respawn_player |
| Asset / validation | 2 | get_asset_info, luau_typecheck |
| State / undo | 4 | get_studio_mode, get_connection_status, undo, redo |

ทุก write tool ห่อด้วย `ChangeHistoryService:TryBeginRecording` → `undo` ใช้ได้ (ยกเว้น script source — Studio limitation)

## 5. Quick start (ผู้ดูแลใหม่)

```powershell
# Clone/checkout repo
cd C:\Users\chaho\roblox-multi-ai

# Install Node deps (one-time)
cd server && npm install && cd ..

# Sync plugin → Studio install folder
.\sync-plugin.ps1

# In Studio: enable HTTP requests
# File → Studio Settings → Security → Allow HTTP Requests = ON

# Register MCP server with Claude Code (one-time, global)
claude mcp add --scope user roblox node "C:\Users\chaho\roblox-multi-ai\server\server.mjs"

# Use:
# 1. Open Roblox Studio (plugin auto-connects)
# 2. Open terminal: cd <project> && claude
# 3. Verify: type /mcp in Claude Code, should see roblox: connected
# 4. Issue commands in Thai or English
```

## 6. วิธีเพิ่ม Tool ใหม่

1. **Plugin side** (`plugin/MultiAIPlugin.lua`):
   ```lua
   handlers.my_new_tool = function(payload)
       -- ถ้าเป็น write op:
       return withRecording("MCP my_new_tool", function()
           -- ... your logic ...
           return { ok = true, result = ... }
       end)
       -- ถ้าเป็น read op: return ตรงๆ ไม่ต้อง withRecording
   end
   ```

2. **Server side**:
   - **Schema** → เพิ่ม tool definition ใน `server/tools.mjs` array `TOOLS`:
     ```js
     { name: "my_new_tool", description: "...", inputSchema: { ... } }
     ```
   - **Dispatch** → เพิ่ม case ใน `server/server.mjs` switch:
     ```js
     case "my_new_tool":
       payload = { ... extract from args ... };
       break;
     ```

3. **Test:**
   ```powershell
   node --check server/server.mjs
   .\sync-plugin.ps1
   ```
   แล้ว reload plugin ใน Studio + restart Claude Code session

4. **Agent visibility** (optional): เพิ่ม tool name ใน `.claude/agents/*.md` frontmatter `tools:` list ของ agent ที่ควรใช้ได้

## 7. Conventions ที่ต้องระวัง

- **Plugin = source of truth:** อย่าแก้ไฟล์ใน `%LOCALAPPDATA%\Roblox\Plugins\` ตรงๆ — แก้ที่ `plugin/` แล้ว sync
- **`run_luau` env:** มี `os`, `BrickColor`, `Color3`, `Vector3`, etc. — ดู whitelist ใน handler `run_luau`. ถ้าต้องใช้อย่างอื่นต้องเพิ่ม
- **Position vs Bounds:** ใช้ `get_bounds` ไม่ใช่แค่ `Position` เมื่อต้องการ edges (gap math, adjacency)
- **OS-level tools focus:** `simulate_input` + `capture_studio_window` ต้องการ Studio window อยู่บนสุด (auto-focus via SetForegroundWindow)
- **Tester restriction:** `roblox-tester` agent **ไม่มี** `set_property` / `run_luau` ใน tools list ของมัน — บังคับให้ใช้ input simulation จริง

## 8. Known Issues / Limitations

| Issue | Workaround |
|---|---|
| `undo` ไม่ rollback Script.Source changes | Studio limitation — เก็บ source ก่อนแก้แล้ว update_script กลับ |
| `find_path` คืน NoPath บน obby ของ user | Gaps ใหญ่เกิน default agent jump (~7.2 stud) — ลด gap หรือใช้ PathfindingModifier |
| `simulate_input` ต้อง focus Studio | ทำงานอัตโนมัติ — แต่ถ้าคลิกหน้าต่างอื่นระหว่าง test อาจ miss key |
| `humanoid_move` character ขยับเล็กน้อย | อาจติด physics setup — เพิ่ม wait หลัง start_play |
| Plugin button label ไม่อัปเดต emoji หลังสร้าง | Studio API limitation — toolbar button title fixed at creation |
| Plugin icon path บางตัว 404 ใน Studio version ใหม่ | Cosmetic — ใช้ play.png ที่ยืนยันแล้วว่ามี |
| `tween_property` primitive coerce | ✅ แก้แล้ว (smart type detection from current value) |
| Claude Code subagent (`roblox-tester` etc.) load fail ถ้าไม่ได้ launch จาก project root | ใช้ `claude mcp add --scope user` หรือ cd เข้า project ก่อน |

## 9. Debugging

```powershell
# ตรวจ MCP server + plugin liveness
curl http://127.0.0.1:8765/connection_status

# Test tool โดยตรงผ่าน HTTP (ข้าม Claude Code)
curl -X POST http://127.0.0.1:8765/submit -H "Content-Type: application/json" `
  -d '{"type":"get_studio_mode","payload":{}}'

# Plugin logs → Studio Output window — filter ด้วย [MultiAI]
# Server stdout → ดูจาก Claude Code MCP logs หรือรัน server แยก:
node server/server.mjs

# Check Claude Code MCP status
# พิมพ์ /mcp ใน Claude Code
```

## 10. Roadmap (ทำต่อได้)

**สิ่งที่ยังไม่มี (skip มาเพราะ ROI ต่ำ หรือซับซ้อน):**
- Real Luau type-check (ตอนนี้แค่ syntax) — ต้องใช้ Luau analyzer เต็มรูป
- Snapshot/restore เพื่อ undo across sessions (ปัจจุบัน in-memory)
- WebSocket แทน HTTP long-poll (latency ดีขึ้น)
- การจัดการ multi-Studio-window
- ฟังก์ชัน mass-edit แบบ undo group

**คำแนะนำ:**
- ก่อนเพิ่ม tool ใหม่ → ดูว่า Roblox มี API อยู่แล้วไหม (ทุก tool ใน Phase 4-8 ก็มาจาก native API)
- ตั้งใจให้ tool ทำเรื่องเดียวให้ดี ไม่ over-engineer
- Sync agent permissions (`tools:` list) เพื่อ enforce role boundaries

## 11. ไฟล์ที่ห้ามแตะ (โดยไม่เข้าใจ)

- `withRecording` helper ใน plugin — ทุก write ขึ้นกับมัน
- `executeCommand` + `loop` ใน plugin — polling pipeline
- HTTP routes `/poll`, `/result/{id}`, `/connection_status` ใน server.mjs — ถ้าเปลี่ยน plugin handshake ต้องอัปเดตทั้งสองฝั่ง

## 12. ติดต่อ / Reference

- Roblox Studio API docs: https://create.roblox.com/docs/reference/engine
- MCP spec: https://modelcontextprotocol.io
- Claude Code subagent guide: https://docs.claude.com/claude-code/subagents
