---
name: roblox-problem-solver
description: >
  คู่มือแก้ปัญหาเกม Roblox แบบครอบคลุม ตั้งแต่การออกแบบ การสร้าง การเขียนโค้ด การ debug
  การทดสอบ และการพัฒนาต่อยอด ใช้ทักษะนี้ทุกครั้งที่ผู้ใช้พูดว่า "เกม bug", "ทำไม X ไม่ทำงาน",
  "ระบบ Y ผิดพลาด", "อยากเพิ่ม feature ใหม่", "เกมช้า/lag", "ผู้เล่นร้องเรียนว่า...",
  "อยากอัปเดตเกม", "จะ optimize ยังไง", "จะ test เกมยังไง", หรือมีปัญหาใดๆ เกี่ยวกับเกม Roblox
  ไม่ว่าจะเป็นปัญหาด้านโค้ด, design, performance, หรือ player experience — ใช้ทักษะนี้ทันที
---

# Roblox Problem Solver Skill

เป้าหมาย: วินิจฉัยและแก้ปัญหาเกม Roblox ได้อย่างเป็นระบบ ตลอด game lifecycle ทั้งหมด

---

## 1. Problem Diagnosis Framework (กรอบวินิจฉัยปัญหา)

เมื่อผู้ใช้รายงานปัญหา ให้ถามหรือระบุก่อนว่าปัญหาอยู่ในหมวดไหน:

```
LAYER 1 — Design Problem    : เกมน่าเบื่อ, loop ไม่สนุก, ผู้เล่นเลิกเล่นเร็ว
LAYER 2 — Build Problem     : Map มีปัญหา, collision ผิด, performance ต่ำ
LAYER 3 — Code Problem      : Script error, logic ผิด, race condition
LAYER 4 — Network Problem   : Exploit, desync, RemoteEvent ไม่ทำงาน
LAYER 5 — Player Problem    : UX ไม่ดี, tutorial ไม่ชัด, balance ไม่โอเค
LAYER 6 — Live Problem      : เกมที่ปล่อยแล้วมีปัญหา, ต้องการ hotfix
```

---

## 2. Code Debugging (แก้ Bug ในโค้ด)

### ขั้นตอนการ Debug
```
1. อ่าน error message ใน Output window ให้ครบ
2. ระบุ script และบรรทัดที่มีปัญหา
3. เพิ่ม print() เพื่อ trace ค่าตัวแปร
4. ตรวจสอบ Server vs Client context
5. ตรวจสอบ nil checks
6. แก้และทดสอบ
```

### Error Patterns ที่พบบ่อย

**"attempt to index nil value"**
```lua
-- ❌ ปัญหา: object ยังไม่มีหรือหาไม่เจอ
local part = workspace.SomePart.Value  -- SomePart อาจไม่มี

-- ✅ แก้: ตรวจสอบก่อนใช้
local part = workspace:FindFirstChild("SomePart")
if part then
    local value = part.Value
end
```

**"Script timeout" หรือ infinite loop**
```lua
-- ❌ ปัญหา: loop ไม่มีที่สิ้นสุด
while someCondition do
    doSomething()  -- ลืม task.wait()
end

-- ✅ แก้: เพิ่ม yield เสมอ
while someCondition do
    doSomething()
    task.wait()  -- หรือ task.wait(0.1)
end
```

**RemoteEvent ไม่ทำงาน**
```lua
-- เช็คลิสต์:
-- [ ] Remote อยู่ใน ReplicatedStorage (ไม่ใช่ ServerScriptService)
-- [ ] Server ใช้ OnServerEvent, Client ใช้ OnClientEvent
-- [ ] FireServer() เรียกจาก LocalScript เท่านั้น
-- [ ] FireClient() เรียกจาก Script (Server) เท่านั้น

-- Debug: เพิ่ม print ทั้งสองฝั่ง
-- Client:
Remote:FireServer("test")
print("Client fired remote")

-- Server:
Remote.OnServerEvent:Connect(function(player, data)
    print("Server received:", player.Name, data)
end)
```

**DataStore ไม่บันทึก**
```lua
-- เช็คลิสต์:
-- [ ] เปิด "Enable Studio Access to API Services" ใน Game Settings
-- [ ] ใช้ pcall ครอบทุก DataStore call
-- [ ] ตรวจสอบ key ยาวไม่เกิน 50 ตัวอักษร
-- [ ] ข้อมูลต้องเป็น JSON-serializable (ไม่มี Instances)

local success, err = pcall(function()
    dataStore:SetAsync(key, data)
end)
if not success then
    warn("DataStore error:", err)
end
```

### Debug Utilities ที่มีประโยชน์
```lua
-- Pretty-print table
local function debugPrint(t: any, indent: number?)
    indent = indent or 0
    local prefix = string.rep("  ", indent)
    if type(t) == "table" then
        print(prefix .. "{")
        for k, v in t do
            io.write(prefix .. "  " .. tostring(k) .. " = ")
            debugPrint(v, indent + 1)
        end
        print(prefix .. "}")
    else
        print(tostring(t))
    end
end

-- ตรวจสอบ memory leak
game:GetService("RunService").Heartbeat:Connect(function()
    if tick() % 30 < 0.1 then  -- ทุก 30 วินาที
        print("Active connections:", #script:GetConnections())
    end
end)
```

---

## 3. Performance Problems (ปัญหาความเร็ว / Lag)

### วิธีหา bottleneck ด้วย Roblox MicroProfiler
```
1. กด Ctrl+F6 ใน Studio/Game เพื่อเปิด MicroProfiler
2. กด Ctrl+P เพื่อ pause และดู frame
3. หา bar ที่ใหญ่ที่สุด — นั่นคือ bottleneck
4. คลิกเพื่อดู detail
```

### Performance Fixes ที่พบบ่อย

**Script ทำงานช้า:**
```lua
-- ❌ ช้า: หา object ซ้ำๆ ทุก frame
RunService.Heartbeat:Connect(function()
    local part = workspace:FindFirstChild("Target")  -- ช้า
    part.Position = ...
end)

-- ✅ เร็ว: cache ไว้นอก loop
local part = workspace:FindFirstChild("Target")  -- cache ครั้งเดียว
RunService.Heartbeat:Connect(function()
    part.Position = ...
end)
```

**Part จำนวนมากทำให้ lag:**
```lua
-- ✅ Union parts ที่อยู่นิ่งเพื่อลด draw calls
-- ✅ ตั้ง Anchored = true ทุก static part
-- ✅ ใช้ LOD: ซ่อน/แสดง objects ตามระยะห่างจากผู้เล่น

local function setupLOD(object: Model, distance: number)
    local camera = workspace.CurrentCamera
    RunService.Heartbeat:Connect(function()
        local dist = (camera.CFrame.Position - object:GetPivot().Position).Magnitude
        object.Parent = dist < distance and workspace or nil
    end)
end
```

**Memory leak จาก Connections:**
```lua
-- ❌ ปัญหา: ไม่ disconnect เมื่อไม่ใช้แล้ว
Players.PlayerAdded:Connect(function(player)
    -- connection นี้อยู่ตลอดไป แม้ player ออกแล้ว
    RunService.Heartbeat:Connect(function()
        updatePlayerUI(player)
    end)
end)

-- ✅ แก้: เก็บ connection แล้ว disconnect เมื่อ player ออก
local connections: {[Player]: RBXScriptConnection} = {}

Players.PlayerAdded:Connect(function(player)
    connections[player] = RunService.Heartbeat:Connect(function()
        updatePlayerUI(player)
    end)
end)

Players.PlayerRemoving:Connect(function(player)
    if connections[player] then
        connections[player]:Disconnect()
        connections[player] = nil
    end
end)
```

---

## 4. Design Problems (ปัญหาด้านการออกแบบ)

### ผู้เล่นเลิกเล่นเร็ว (High Churn)
```
วินิจฉัย → ตรวจสอบว่าผู้เล่นออกตอนไหน:
  - ออกใน 1 นาทีแรก → Tutorial ไม่ดี / เกมโหลดช้า
  - ออกใน 10 นาที   → Core loop ไม่น่าสนุก / ยากเกินไป
  - ออกหลัง 1 ชั่วโมง → Content หมด / ไม่มีเป้าหมายใหม่

แก้ตามสาเหตุ:
  → Tutorial: สร้าง onboarding ชัดเจน อธิบายสิ่งที่ต้องทำ
  → Core loop: ทดสอบกับ beta tester ที่ไม่รู้จักเกม
  → Content: เพิ่ม daily quests / event / update schedule
```

### เกมไม่สมดุล (Balance Issues)
```
อาวุธ/คลาสบางตัวแรงเกินไป:
  1. เก็บ data: อัตรา win/loss ของแต่ละ class
  2. Nerf: ลด damage 10-15% ครั้งละน้อยๆ
  3. Buff: เพิ่มให้ตัวที่อ่อน แทนการ nerf ตัวที่แรง
  4. แจ้งผู้เล่นในบันทึก update ทุกครั้ง
```

---

## 5. Testing Framework (การทดสอบเกม)

### Testing Checklist ก่อน Publish
```
FUNCTIONAL TESTS:
  [ ] Core loop ทำงานครบทุกขั้นตอน
  [ ] DataStore บันทึก-โหลดถูกต้อง
  [ ] RemoteEvents ทำงานทั้ง server และ client
  [ ] ผู้เล่นเข้า-ออก-กลับมาใหม่ได้ไม่มีปัญหา
  [ ] ไม่มี script error ใน Output

PERFORMANCE TESTS:
  [ ] FPS ไม่ต่ำกว่า 30 เมื่อมีผู้เล่นเต็ม server
  [ ] ไม่มี memory leak หลังเล่น 30 นาที
  [ ] LoadTime ไม่เกิน 10 วินาที

EXPLOIT TESTS:
  [ ] ทดสอบส่ง RemoteEvent ด้วยค่าผิดปกติ
  [ ] ตรวจสอบ server-side validation ทุก action
  [ ] Teleport hack: ตรวจสอบ position ก่อนทุก action

PLAYER EXPERIENCE:
  [ ] ทดสอบกับคนที่ไม่รู้จักเกม (fresh eyes)
  [ ] Tutorial ชัดเจน ไม่ต้องอ่านคู่มือ
  [ ] Error messages เข้าใจได้
```

### Exploit Prevention
```lua
-- ตัวอย่าง: ป้องกัน speed hack
local MAX_SPEED = 100  -- studs per second (ความเร็วปกติ ~16)
local lastPositions: {[Player]: {pos: Vector3, time: number}} = {}

RunService.Heartbeat:Connect(function()
    for _, player in Players:GetPlayers() do
        if not player.Character then continue end
        local rootPart = player.Character:FindFirstChild("HumanoidRootPart")
        if not rootPart then continue end

        local now = os.clock()
        local last = lastPositions[player]

        if last then
            local dt = now - last.time
            local dist = (rootPart.Position - last.pos).Magnitude
            local speed = dist / dt

            if speed > MAX_SPEED then
                -- ส่งผู้เล่นกลับตำแหน่งก่อนหน้า
                rootPart.CFrame = CFrame.new(last.pos)
                warn(`Speed hack detected: {player.Name} ({speed:.1f} studs/s)`)
            end
        end

        lastPositions[player] = { pos = rootPart.Position, time = now }
    end
end)
```

---

## 6. Update & Live Ops (การอัปเดตเกมที่ปล่อยแล้ว)

### Safe Update Process
```
1. BACKUP: บันทึก version ปัจจุบันไว้ก่อน
2. STAGE: ทดสอบใน place ที่แยกต่างหาก
3. DEPLOY: อัปเดตช่วง traffic ต่ำ (กลางคืน)
4. MONITOR: เฝ้าดู error rate ใน Developer Console
5. ROLLBACK: เตรียมแผน rollback ถ้ามีปัญหา
```

### DataStore Migration (เปลี่ยน data structure)
```lua
-- เมื่อเพิ่ม field ใหม่ใน data structure
local function migrateData(data: table): table
    -- v1 → v2: เพิ่ม field "achievements"
    if not data.achievements then
        data.achievements = {}
        data.dataVersion = 2
    end

    -- v2 → v3: เพิ่ม field "settings"
    if not data.settings then
        data.settings = { music = true, sfx = true }
        data.dataVersion = 3
    end

    return data
end

-- เรียกทุกครั้งที่โหลดข้อมูล
local rawData = dataStore:GetAsync(key)
if rawData then
    rawData = migrateData(rawData)
end
```

### Feature Flag Pattern (เปิด/ปิด feature ได้ทันที)
```lua
-- ReplicatedStorage/Shared/FeatureFlags.lua
-- เปลี่ยนค่าได้โดยไม่ต้อง publish ใหม่ (ผ่าน RemoteConfig หรือ DataStore)
local FeatureFlags = {
    NEW_COMBAT_SYSTEM = false,   -- ยังไม่พร้อม
    DOUBLE_COINS_EVENT = true,   -- เปิด event
    BETA_MAP = false,            -- ทดสอบอยู่
}

return FeatureFlags
```

---

## 7. วิธีตอบสนองต่อปัญหา

เมื่อผู้ใช้รายงานปัญหา ให้ทำตามนี้:

1. **ระบุ layer** ของปัญหา (Design / Build / Code / Network / Player / Live)
2. **ขอข้อมูลเพิ่มเติม** ถ้าจำเป็น: error message, โค้ดที่เกี่ยวข้อง, อาการที่เห็น
3. **วินิจฉัยสาเหตุ** ก่อนเสนอวิธีแก้
4. **ให้โค้ด/solution พร้อมใช้** พร้อม comment ภาษาไทย
5. **อธิบาย root cause** เพื่อป้องกันปัญหาเดิมในอนาคต
6. **เสนอการป้องกัน** เพื่อไม่ให้เกิดซ้ำ

---

## Reference Files
- `references/common-errors.md` — รายการ error ที่พบบ่อยและวิธีแก้
- `references/testing-scripts.md` — Script ช่วย test และ monitor เกม
