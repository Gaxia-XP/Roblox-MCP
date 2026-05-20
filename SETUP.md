# คู่มือติดตั้ง Roblox Multi-AI

ระบบนี้ทำอะไร: พิมพ์คำสั่ง (ไทย/อังกฤษ) → AI หลายตัวแบ่งงาน → ผลลัพธ์โผล่ใน Roblox Studio ทันที

```
   คุณ → Orchestrator (Claude/Codex/Gemini) → ┌─ Designer (วางแผน)
                                              ├─ Builder  (สร้างแผนที่ 3D)
                                              ├─ Scripter (เขียนโค้ด)
                                              ├─ UI       (ทำเมนู/HUD)
                                              └─ Tester   (เล่นเกมจริงตรวจสอบ)
                                                       ↓
                                              Roblox Studio
```

---

## ติดตั้ง (ครั้งเดียว) — 5 ขั้น

### 1. ตรวจว่ามี Node.js
```powershell
node --version
```
ถ้าไม่เจอ → ดาวน์โหลด LTS จาก https://nodejs.org/

### 2. ติดตั้ง dependencies
```powershell
cd C:\Users\chaho\roblox-multi-ai\server
npm install
```

### 3. ติดตั้ง Plugin ลง Roblox Studio
ใช้สคริปต์ที่เตรียมไว้:
```powershell
cd C:\Users\chaho\roblox-multi-ai
.\sync-plugin.ps1
```
หรือคำสั่งสั้นๆ:
```powershell
Copy-Item C:\Users\chaho\roblox-multi-ai\plugin\MultiAIPlugin.lua "$env:LOCALAPPDATA\Roblox\Plugins\" -Force
```

### 4. เปิด HTTP ใน Roblox Studio
1. File → Studio Settings (Alt+S)
2. หมวด **Security** → **Allow HTTP Requests** = ON
3. ปิดหน้าต่าง

### 5. ลงทะเบียน MCP server กับ AI

**สำหรับ Claude Code** — มี 2 ทาง เลือกอันใดอันหนึ่ง:

**ทาง A (แนะนำ — global):**
```powershell
claude mcp add --scope user roblox node "C:\Users\chaho\roblox-multi-ai\server\server.mjs"
```
ลงครั้งเดียว ใช้ได้ทุก project — เปิด Claude Code จากที่ไหนก็เจอ

**ทาง B (project-scoped):**
ไฟล์ `.mcp.json` เตรียมไว้ในโปรเจกต์แล้ว → แค่ `cd` เข้า project ก่อนรัน `claude`

**สำหรับ Codex CLI:** ดู `.codex/config.toml`
**สำหรับ Gemini CLI:** ดู `.gemini/settings.json`

---

## ใช้งานทุกครั้ง — 2 ขั้น

### 1. เปิด Roblox Studio
Plugin **auto-connect เอง** เมื่อ Studio เปิด — ไม่ต้องคลิกอะไร

ตรวจที่ Output (View → Output):
```
[MultiAI] Polling started — http://127.0.0.1:8765
[MultiAI] ✓ Connected to http://127.0.0.1:8765
```

ถ้าอยากหยุด/รีเริ่มเอง คลิกปุ่ม **Multi-AI > MCP** ที่ toolbar (toggle on/off)

### 2. เปิด Terminal เข้า Orchestrator
```powershell
cd C:\Users\chaho\roblox-multi-ai
claude
```

ตรวจ MCP — พิมพ์ `/mcp` ใน Claude Code → ควรเห็น `roblox: connected`
หรือสั่งให้ AI เรียก `get_connection_status`:
```json
{ "pluginConnected": true, "ready": true, ... }
```

### 3. สั่งงาน

```
สร้างเกม obby ง่ายๆ มี 5 ด่าน
```
```
ทำเกม simulator เก็บเหรียญแล้วเลเวลขึ้น
```
```
เพิ่มเมนูหลักในเกมที่กำลังเปิดอยู่ มีปุ่ม Play, Settings, Shop
```
```
สร้างบ้านสีน้ำตาลขนาด 20x20 พร้อมประตูที่เปิดได้
```
```
ลองเดินใน Play mode แล้วบอกว่า walkspeed รู้สึกเร็ว/ช้าเกินไปไหม
```

Orchestrator จะ:
1. ส่งให้ **Designer** วางแผน
2. แสดงแผนให้คุณดู
3. ส่ง **Builder / Scripter / UI** ไปทำขนาน
4. ใช้ **Tester** ทดสอบ end-to-end ถ้าจำเป็น
5. รายงานผล

ผลลัพธ์โผล่ใน Studio ทันที — กด Play ทดสอบได้เลย

---

## ปัญหาที่อาจเจอ

| อาการ | ทางแก้ |
|---|---|
| Tool ใดๆ คืน `"timeout"` | สั่ง AI เรียก `get_connection_status` ก่อน — ถ้า `pluginConnected: false` → ตรวจว่า Studio เปิดอยู่ และ Output มี `[MultiAI] ✓ Connected` หรือไม่ |
| Output แจ้ง `Http requests are not enabled` | ลืมเปิด HTTP ในขั้น 4 |
| `/mcp` ไม่เห็น `roblox` | ใช้ทาง A (global) — `claude mcp add --scope user roblox ...` |
| Plugin โหลดเก่า (ฟีเจอร์ใหม่ไม่ขึ้น) | รัน `.\sync-plugin.ps1` แล้ว reload plugin ใน Studio (Plugins tab → คลิกขวา MultiAIPlugin → Reload) หรือปิด/เปิด Studio |
| ไม่เห็นกลุ่ม Multi-AI ใน Studio | ไฟล์ `.lua` ไม่ได้อยู่ใน plugins folder → รัน sync-plugin.ps1 |
| Plugin แสดง icon ไม่ได้ (Output มี warning) | ไม่กระทบการทำงาน — แค่ไอคอน |
| ภาพ screenshot จับ taskbar/แอปอื่นปน | ใช้ `capture_studio_window` แทน `take_screenshot` — มันจับเฉพาะ Studio |

---

## คำสั่งที่มีประโยชน์

### ใน Claude Code
- `/mcp` — สถานะ MCP server
- `/agents` — รายชื่อ subagent
- `Ctrl+C` สองครั้ง — ยกเลิกงานปัจจุบัน

### ใน Roblox Studio
- **Ctrl+Z** — Undo (AI ทุกครั้งห่อด้วย ChangeHistoryService:TryBeginRecording → Undo ใช้ได้)
- **Multi-AI > MCP** ปุ่ม toolbar — toggle polling on/off
- **F5** — Play test

### Sync plugin หลังแก้
```powershell
cd C:\Users\chaho\roblox-multi-ai
.\sync-plugin.ps1
```
แล้ว reload plugin ใน Studio

---

## โครงสร้างไฟล์

```
C:\Users\chaho\roblox-multi-ai\
├── README.md                      ← overview
├── SETUP.md                       ← ไฟล์นี้
├── CLAUDE.md                      ← system prompt ให้ Claude Code
├── AGENTS.md                      ← system prompt ให้ Codex/Gemini
├── .mcp.json                      ← MCP config (project scope)
├── sync-plugin.ps1                ← copy plugin → Studio install folder
├── server/
│   └── server.mjs                 ← MCP server (Node.js, 30 tools)
├── plugin/
│   └── MultiAIPlugin.lua          ← Plugin Studio (auto-connect + status)
├── .claude/agents/                ← Claude Code subagents
├── .codex/                        ← Codex CLI config + agents
└── .gemini/                       ← Gemini CLI config + agents
```

แก้ไฟล์ `.claude/agents/*.md` ได้เลยถ้าอยากปรับ "นิสัย" / "ทักษะ" ของ AI แต่ละตัว
