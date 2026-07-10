# Bug Report — Multi-Studio Concurrent Routing ไม่ทำงาน (contested ตรวจเจอ แต่ไม่เคย resolve)

- **วันที่:** 2026-06-26
- **Component:** Roblox-MCP-v6 broker — `server/lib/broker-core.mjs` (+ `plugin/MultiAIPlugin.lua`)
- **Branch / worktree:** `claude/broker-multisession` · `practical-bartik-873c56`
- **Severity:** High — ทำลาย core feature ของ v6 (หลาย AI session / หลาย Studio window พร้อมกัน)
- **Status:** วินิจฉัยครบ ยังไม่แก้ (report-only ตามที่ร้องขอ)

---

## 1. TL;DR
broker **ตรวจจับการชน** ของสอง Studio window ที่ใช้ `studio_id` เดียวกันได้ (contested) และมี plumbing ครบสำหรับแจก id ใหม่ (`__assign_studio_id` + plugin handler + control-poll loop) **แต่ใน production ไม่มี code path ไหนยิง `__assign_studio_id` ออกไปเลย** — มันถูกเรียกแค่ใน unit test เท่านั้น ผลคือสองหน้าต่างค้างที่ id เดียวกันตลอด คำสั่ง MCP เลยวิ่งสุ่มไปหน้าต่างที่ poll ทันก่อน

---

## 2. อาการที่สังเกตเห็น (Observed)
ผู้ใช้เปิด Studio **2 หน้าต่าง** บนเครื่องเดียว/ผู้ใช้เดียว ทั้งคู่รัน `MultiAIPlugin` ที่ต่อ broker:
- ซ้าย = เกม **"Test Http"** (farming) · ขวา = **"Ancient Coin Hunters"** (baseplate)
- คำสั่ง MCP route **สุ่มสลับหน้าต่าง** ข้าม call:
  - `run_luau` (warn schema) → ออกที่ Output **หน้าต่างซ้าย** (`09:36`)
  - `run_luau` / `workspace_overview` ถัดมา → log `[MultiAI] -> ...` ที่ Output **หน้าต่างขวา** (`09:37`–`09:38`)
- `list_studios` เห็น studio **เดียว** (`ae03e226`, `contested:false`) ทั้งที่เปิด 2 หน้าต่าง → broker แยกสองหน้าต่างไม่ออก

---

## 3. Root Cause (ระบุชัด)

### 3.1 ทำไม 2 หน้าต่างถึงได้ `studio_id` เดียวกัน
`plugin/MultiAIPlugin.lua`:
- `:20` — `local STUDIO_ID_KEY = "MultiAI_StudioId"`
- `:34-40` — mint ด้วย `HttpService:GenerateGUID(false)` แล้ว **persist ด้วย `plugin:SetSetting(STUDIO_ID_KEY, ...)`** และตอนโหลดจะ `plugin:GetSetting` มาใช้ซ้ำถ้ามี

`plugin:SetSetting` เป็น setting **ระดับ user-global ของ plugin (แชร์ทุกหน้าต่าง)** → หน้าต่างที่ 2 อ่าน id เดิม → ทั้งคู่ส่ง header `x-studio-id` ค่าเดียวกัน

### 3.2 broker ตรวจ contested ได้ (ส่วนนี้ทำงาน)
`server/lib/broker-core.mjs`:
- `:34` — `const CONTESTED_WINDOW_MS = 3_000;`
- `:284` — `const connId = ++connSeq;` ← connId เป็น counter ฝั่ง server, **unique ทุก poll** (ไม่ผูกกับหน้าต่าง — ดีพอสำหรับนับ overlap)
- `:148-164` — `recomputeContested()` / `noteConn()` : ถ้ามี connId ที่ distinct ≥ 2 ตัว overlap ภายใน 3s → `contested = true` แล้ว set `st.contested`
- `:303` — `const contested = noteConn(studioId, connId);`
- `:305` — ถ้า contested → hold command poll (คืน `{}`)

### 3.3 ช่องที่หายไป (THE BUG)
การ resolve ที่ออกแบบไว้คือ broker ต้องยิง `__assign_studio_id` เข้า control queue ของ studio → plugin handler รับแล้วเปลี่ยน id:
- `plugin/MultiAIPlugin.lua:219-232` — `handlers.__assign_studio_id` : validate → `plugin:SetSetting` → mutate live `studioId` upvalue (พร้อมใช้งาน)

**แต่ `server/lib/broker-core.mjs` (production) ไม่เคยเรียก `enqueueControl(studioId, "__assign_studio_id", ...)` เลย:**
- ในไฟล์ broker-core.mjs คำว่า `__assign_studio_id` โผล่แค่ใน **คอมเมนต์** (`:293`)
- ที่ยิงจริงมีแค่ใน **unit test** → `server/test/broker-core.test.mjs:166`
  `core.enqueueControl("d00e0001", "__assign_studio_id", { studio_id: "fec50000ddaa0001" });` (เรียกเองมือในเทสต์)

→ contested ถูก **detect** แต่ไม่เคย **resolve** → 2 หน้าต่างค้าง id เดียวตลอด → คำสั่งวิ่งไปหน้าต่างที่ชนะ poll race

---

## 4. หลักฐาน (Evidence)
- `grep "__assign_studio_id"` ทั้ง `server/`: เจอเฉพาะ `broker-core.mjs:293` (comment) + `test/broker-core.test.mjs:166` (manual enqueue) — **ไม่มีใน production path**
- `server/test/broker-core.test.mjs:149-170` — เทสต์ชื่อ *"two distinct connIds within window mark contested; control-poll gets `__assign_studio_id`; commands held"* → **พิสูจน์ว่ากลไกทำงาน** เมื่อฉีด `__assign_studio_id` เข้าไปเอง = ที่ขาดคือตัวฉีดอัตโนมัติใน production
- Live: `list_studios` → 1 studio (`ae03e226`, `contested:false`), routing เด้งสองเกม

---

## 5. แนวทางแก้ — ขั้นต่ำ (broker-only, ไม่ต้องแตะ plugin)

ใน `handleStudioPoll` (`broker-core.mjs` ~`:303`) ตอน `noteConn` คืน `contested`:

```js
const contested = noteConn(studioId, connId);
if (contested) {
  maybeReassign(studioId);          // <-- เพิ่มใหม่ (ดู guard ด้านล่าง)
  releaseConn(studioId, connId);
  return sendJson(res, 200, {});    // §2.6 hold ตามเดิม
}
```

`maybeReassign(studioId)` ต้องมี guard:
1. **ยิงครั้งเดียวต่อ contention episode** — เก็บ per-studio flag/timestamp (เช่น `reassignAt`) อย่าให้ enqueue ทุก poll ตอนที่ยัง contested
2. **gen id ใหม่ที่ไม่ชน** — 32-hex (เช่น `randomUUID().replace(/-/g,'')`) ให้ผ่าน `ID_RE`
3. `enqueueControl(studioId, "__assign_studio_id", { studio_id: freshId })` — control-poll ของหน้าต่างใดหน้าต่างหนึ่งจะรับไป แล้ว re-register เป็น studio ใหม่ → auto-pair กับอีก session
4. **ไม่ต้องแก้ plugin** — handler + control loop พร้อมแล้ว (พิสูจน์โดยเทสต์ที่ผ่าน)

> หมายเหตุ: เพราะ control queue คีย์ด้วย `studioId` ที่ยังชนกัน หน้าต่างที่รับ `__assign_studio_id` จะเป็นตัวที่ control-poll คว้าก่อน — ยอมรับได้ (ขอแค่ "ตัวใดตัวหนึ่ง" เปลี่ยน id ก็พอให้แยกออก) แต่ควรเทสต์เคส 2 หน้าต่างจริงว่าไม่เกิด reassign สลับไปมา (flapping)

---

## 6. Smell ที่ลึกกว่า (เผื่ออยากแก้ให้ถูกราก)
`plugin:SetSetting("MultiAI_StudioId")` เป็น **per-user-global** → แชร์ทุกหน้าต่างโดยกำเนิด ขัดกับความ "unique ต่อหน้าต่าง" ที่ feature ต้องการ ต่อให้ broker แจก id ใหม่ หน้าต่างที่ถูก reassign จะ `SetSetting` ทับ key ที่แชร์ (`MultiAIPlugin.lua:228`) → **reload ทีหลังชนได้อีก** ทางที่สะอาดกว่า:
- **(A) ไม่ persist id แบบ global** — mint สดทุก plugin load + พึ่ง session re-pair (เสีย pairing-survival ข้าม reload แต่ได้ uniqueness ต่อหน้าต่าง)
- **(B) ใส่ per-window/per-process nonce** เป็น header แยกจาก `x-studio-id` ให้ broker แยกหน้าต่างได้ตรง ๆ + reassign แบบ deterministic โดยยัง persist id ไว้เพื่อ reconnect ของ single-window

---

## 7. Deployment / Verify
- เป็นการแก้ **broker-only** → ไม่ต้อง re-sync plugin · ไม่ต้อง rebuild (server รัน in-place)
- **แต่** `server.mjs` ถูก spawn โดย Claude harness จาก `~/.claude.json` → ต้อง **restart Claude Code** ให้โหลด `broker-core.mjs` ที่แก้แล้ว
- หลัง restart: เปิด Studio 2 หน้าต่าง → `list_studios` ควรเห็น **2 studios แยกกัน** (ตัวหนึ่งถูก auto-reassign id ใหม่) → ขับแต่ละหน้าต่างได้อิสระผ่าน auto-pair หรือ `studio_target`

---

## 8. Reproduction
1. เปิด Studio 2 หน้าต่างบนเครื่อง/ผู้ใช้เดียวกัน ทั้งคู่ลง `MultiAIPlugin` (baked + ต่อ broker แล้ว)
2. เรียก `list_studios` → เห็น **1** studio (ควรเป็น 2)
3. เรียก `workspace_overview` / `run_luau` ซ้ำ ๆ → ผลลัพธ์ **เด้งสลับ** สองเพลส

---

## 9. References (file:line)
- `server/lib/broker-core.mjs` — `:34` CONTESTED_WINDOW_MS · `:148-164` recomputeContested/noteConn · `:281-309` handleStudioPoll · `:284` connId · `:303-305` contested-hold · `:190-192` enqueueControl · `:293` comment-only `__assign_studio_id`
- `server/test/broker-core.test.mjs:149-170` — เทสต์กลไก (manual inject `:166`)
- `plugin/MultiAIPlugin.lua` — `:20` STUDIO_ID_KEY · `:34-40` mint+persist · `:219-232` `__assign_studio_id` handler
- `docs/superpowers/specs/2026-06-24-roblox-mcp-multisession-broker-design.md` — design เดิมของ broker
