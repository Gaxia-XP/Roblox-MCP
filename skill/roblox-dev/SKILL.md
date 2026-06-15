---
name: roblox-dev
description: >
  Expert guide for building Roblox games with Luau. Use this skill whenever a user asks about
  Roblox game development, Luau scripting, Roblox Studio, game systems (combat, inventory, UI,
  levels), client-server architecture, DataStore, RemoteEvents, OOP patterns, project structure,
  or performance optimization in Roblox. Trigger even for casual mentions like "help me make a
  Roblox game", "how do I script X in Roblox", or "Roblox Studio tips". Produces ready-to-use
  Luau code snippets, architecture plans, folder structures, and best-practice explanations.
---

# Roblox Game Development Skill

เป้าหมาย: ช่วยให้ผู้ใช้สร้างเกม Roblox คุณภาพสูง ครอบคลุม Luau scripting, architecture, game systems, และ best practices ระดับ advanced

---

## 1. Project Structure (โครงสร้างโปรเจกต์มาตรฐาน)

```
ServerScriptService/
├── Services/           -- server-side game logic (Singletons)
│   ├── CombatService.lua
│   ├── DataService.lua
│   └── MatchService.lua
├── Modules/            -- shared server modules
└── init.server.lua     -- bootstrapper

ReplicatedStorage/
├── Shared/
│   ├── Types.lua       -- type definitions ใช้ร่วมกัน
│   ├── Constants.lua
│   └── Remotes/        -- RemoteEvent & RemoteFunction instances
│       ├── Combat/
│       └── Data/
└── Components/         -- React/Fusion UI components (ถ้ามี)

StarterPlayerScripts/
├── Controllers/        -- client-side controllers
│   ├── InputController.lua
│   └── UIController.lua
└── init.client.lua

StarterCharacterScripts/
└── CharacterController.lua

Workspace/
└── Map/               -- static map geometry
```

> **กฎ:** อย่าใส่ logic ใน Workspace โดยตรง ใช้ ServerScriptService / StarterPlayerScripts เสมอ

---

## 2. Client-Server Architecture (สิ่งสำคัญที่สุด)

Roblox แยก **Server** (เชื่อถือได้) และ **Client** (ไม่เชื่อถือ) ออกจากกันเสมอ

```
Client  ──RemoteEvent/RemoteFunction──▶  Server
                                          │
                                     validate + execute
                                          │
                                    ◀── response (ถ้าจำเป็น)
```

**กฎ Never Trust the Client:**
- ไม่ให้ client คำนวณ damage, เงิน, หรือสถานะสำคัญ
- ทุก Remote ที่รับจาก client ต้อง **validate** ก่อนเสมอ
- ใช้ `RemoteEvent` สำหรับ fire-and-forget, `RemoteFunction` สำหรับ request-response

```lua
-- ❌ อย่าทำแบบนี้ (client กำหนด damage เอง)
DamageRemote:FireServer(9999)

-- ✅ ทำแบบนี้ (server คำนวณเอง)
AttackRemote:FireServer(targetId)
-- server รับแล้ว lookup damage จาก config ที่ server ถือไว้
```

---

## 3. Luau Best Practices

### 3.1 Services — ดึงไว้บนสุดเสมอ
```lua
-- ✅ ถูก: ดึง services ด้วย GetService เรียงตามตัวอักษร
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

-- ❌ ผิด: อย่าใช้ชื่อ global หรือ game.ServiceName
-- local players = game.Players  ← deprecated & error-prone
```

### 3.2 Naming Conventions (Roblox Official Style Guide)
```lua
local MY_CONSTANT = 100            -- LOUD_SNAKE_CASE สำหรับ constants
local playerHealth = 100           -- camelCase สำหรับ local variables
local function takeDamage() end    -- camelCase สำหรับ functions
local MyClass = {}                 -- PascalCase สำหรับ classes / modules
local _privateValue = 0            -- _prefix สำหรับ private members
```

### 3.3 Type Annotations (Luau types)
```lua
type PlayerData = {
    userId: number,
    coins: number,
    level: number,
    inventory: {string},
}

local function giveCoins(player: Player, amount: number): boolean
    -- implementation
    return true
end
```

### 3.4 OOP Pattern (Metatables)
```lua
-- Module: WeaponClass.lua
local WeaponClass = {}
WeaponClass.__index = WeaponClass

export type WeaponClass = typeof(setmetatable({} :: {
    name: string,
    damage: number,
    owner: Player,
}, WeaponClass))

function WeaponClass.new(name: string, damage: number, owner: Player): WeaponClass
    local self = setmetatable({}, WeaponClass)
    self.name = name
    self.damage = damage
    self.owner = owner
    return self
end

function WeaponClass:attack(target: Model)
    -- validate target บน server เสมอ
    local humanoid = target:FindFirstChildOfClass("Humanoid")
    if humanoid then
        humanoid:TakeDamage(self.damage)
    end
end

function WeaponClass:destroy()
    setmetatable(self, nil)
end

return WeaponClass
```

---

## 4. Common Game Systems

### 4.1 DataStore (บันทึกข้อมูลผู้เล่น)
```lua
-- Services/DataService.lua
local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")

local PlayerDataStore = DataStoreService:GetDataStore("PlayerData_v1")

local DEFAULT_DATA: PlayerData = {
    coins = 0,
    level = 1,
    inventory = {},
}

local DataService = {}
local cache: {[number]: PlayerData} = {}

function DataService.load(player: Player): PlayerData
    local userId = player.UserId
    local success, data = pcall(function()
        return PlayerDataStore:GetAsync(tostring(userId))
    end)

    if success and data then
        -- merge กับ DEFAULT_DATA เพื่อ handle fields ใหม่
        for key, value in DEFAULT_DATA do
            if data[key] == nil then
                data[key] = value
            end
        end
        cache[userId] = data
    else
        cache[userId] = table.clone(DEFAULT_DATA)
    end

    return cache[userId]
end

function DataService.save(player: Player)
    local userId = player.UserId
    local data = cache[userId]
    if not data then return end

    local success, err = pcall(function()
        PlayerDataStore:SetAsync(tostring(userId), data)
    end)

    if not success then
        warn(`DataService: Failed to save {player.Name}: {err}`)
    end
end

function DataService.get(player: Player): PlayerData?
    return cache[player.UserId]
end

-- Auto-save ทุก 60 วินาที
task.spawn(function()
    while true do
        task.wait(60)
        for _, player in Players:GetPlayers() do
            DataService.save(player)
        end
    end
end)

Players.PlayerRemoving:Connect(function(player)
    DataService.save(player)
    cache[player.UserId] = nil
end)

return DataService
```

### 4.2 RemoteEvents Setup (จัดการ Remotes อย่างเป็นระบบ)
```lua
-- ReplicatedStorage/Shared/Remotes/init.lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Remotes = {}

-- ตัวอย่าง remote registry
local REMOTE_DEFINITIONS = {
    -- Combat
    ["Combat.Attack"] = "RemoteEvent",
    ["Combat.Died"] = "RemoteEvent",
    -- Data
    ["Data.GetPlayerData"] = "RemoteFunction",
    -- UI
    ["UI.ShowNotification"] = "RemoteEvent",
}

-- สร้าง remotes ถ้ายังไม่มี (server-side init เท่านั้น)
function Remotes.init()
    local folder = ReplicatedStorage:FindFirstChild("Remotes")
        or Instance.new("Folder", ReplicatedStorage)
    folder.Name = "Remotes"

    for name, remoteType in REMOTE_DEFINITIONS do
        if not folder:FindFirstChild(name) then
            local remote = Instance.new(remoteType)
            remote.Name = name
            remote.Parent = folder
        end
    end
end

function Remotes.get(name: string): RemoteEvent | RemoteFunction
    return ReplicatedStorage.Remotes[name]
end

return Remotes
```

### 4.3 Combat System Template
```lua
-- Services/CombatService.lua
local Players = game:GetService("Players")
local Remotes = require(script.Parent.Parent.Shared.Remotes)

local ATTACK_COOLDOWN = 0.5  -- วินาที
local BASE_DAMAGE = 25

local CombatService = {}
local cooldowns: {[Player]: number} = {}

function CombatService.handleAttack(attacker: Player, targetId: number)
    -- 1. Cooldown check
    local now = os.clock()
    if (cooldowns[attacker] or 0) + ATTACK_COOLDOWN > now then
        return  -- ยังไม่หาย cooldown
    end
    cooldowns[attacker] = now

    -- 2. Validate target
    local target = Players:GetPlayerByUserId(targetId)
    if not target or not target.Character then return end

    -- 3. Distance check (anti-cheat)
    local attackerChar = attacker.Character
    if not attackerChar then return end
    local dist = (attackerChar.HumanoidRootPart.Position
        - target.Character.HumanoidRootPart.Position).Magnitude
    if dist > 15 then return end  -- range check

    -- 4. Deal damage
    local humanoid = target.Character:FindFirstChildOfClass("Humanoid")
    if humanoid then
        humanoid:TakeDamage(BASE_DAMAGE)
    end
end

-- รับ event จาก client
Remotes.get("Combat.Attack").OnServerEvent:Connect(function(player, targetId: number)
    if typeof(targetId) ~= "number" then return end  -- type guard
    CombatService.handleAttack(player, targetId)
end)

return CombatService
```

### 4.4 Leaderstats & UI
```lua
-- ใน PlayerAdded event
Players.PlayerAdded:Connect(function(player)
    local data = DataService.load(player)

    -- Leaderstats (แสดงบน leaderboard)
    local leaderstats = Instance.new("Folder")
    leaderstats.Name = "leaderstats"
    leaderstats.Parent = player

    local coins = Instance.new("IntValue")
    coins.Name = "Coins"
    coins.Value = data.coins
    coins.Parent = leaderstats

    local level = Instance.new("IntValue")
    level.Name = "Level"
    level.Value = data.level
    level.Parent = leaderstats
end)
```

---

## 5. Performance Tips

- ใช้ `task.spawn` / `task.defer` แทน `spawn` / `coroutine.wrap` (รวดเร็วกว่า)
- หลีกเลี่ยง `wait()` → ใช้ `task.wait()` แทน
- Cache ผลลัพธ์ `FindFirstChild` แทนการเรียกซ้ำ
- ใช้ `RunService.Heartbeat` สำหรับ per-frame logic ฝั่ง server
- ใช้ `RunService.RenderStepped` สำหรับ client-side visual updates
- หลีกเลี่ยง table ขนาดใหญ่ใน RemoteEvent payloads
- ใช้ `BufferService` หรือ compression สำหรับ DataStore ที่มีข้อมูลมาก

---

## 6. การตอบสนองต่อ User Requests

เมื่อผู้ใช้ขอความช่วยเหลือเกี่ยวกับ Roblox ให้ทำตามขั้นตอนนี้:

1. **ระบุประเภทคำถาม**: Script ใหม่? Debug? Architecture? System design?
2. **ระบุ context**: Server-side หรือ Client-side? ระบบอะไร?
3. **ให้ code ที่ใช้งานได้ทันที** พร้อม comment ภาษาไทย (ถ้า user ไทย)
4. **อธิบาย pattern** ที่ใช้และเหตุผล
5. **เตือน anti-patterns** ที่ควรหลีกเลี่ยง

### ตัวอย่าง trigger phrases:
- "ช่วยสร้าง X สำหรับเกม Roblox"
- "วิธีทำ [feature] ใน Roblox Studio"
- "โค้ด Luau สำหรับ..."
- "ระบบ [combat/inventory/shop/level] Roblox"
- "เกม Roblox ของฉัน bug ตรงที่..."

---

## 7. Knit Framework (สำหรับโปรเจกต์ขนาดกลาง-ใหญ่)

Knit คือ framework ที่จัดการ Services/Controllers และ Remotes ให้อัตโนมัติ

```lua
-- ติดตั้ง: wally add sleitnick/knit@1.5.1

-- ServerScriptService/Services/CoinService.lua
local Knit = require(ReplicatedStorage.Packages.Knit)

local CoinService = Knit.CreateService {
    Name = "CoinService",
    Client = {
        -- ประกาศ Remote signals ที่นี่ (Knit สร้างให้อัตโนมัติ)
        CoinsUpdated = Knit.CreateSignal(),  -- server → client
    },
}

-- เก็บเหรียญของแต่ละ player
local coinData: {[Player]: number} = {}

function CoinService:AddCoins(player: Player, amount: number)
    -- เพิ่มเหรียญ
    coinData[player] = (coinData[player] or 0) + amount
    -- แจ้ง client ให้อัปเดต UI
    self.Client.CoinsUpdated:Fire(player, coinData[player])
end

-- Method ที่ client เรียกได้ (Knit จัดการ RemoteFunction อัตโนมัติ)
function CoinService.Client:GetCoins(player: Player): number
    return coinData[player] or 0
end

function CoinService:KnitStart()
    -- เรียกเมื่อ service พร้อม
    game:GetService("Players").PlayerAdded:Connect(function(player)
        coinData[player] = 0
    end)
end

return CoinService
```

```lua
-- StarterPlayerScripts/Controllers/CoinController.lua
local Knit = require(ReplicatedStorage.Packages.Knit)

local CoinController = Knit.CreateController { Name = "CoinController" }

function CoinController:KnitStart()
    local CoinService = Knit.GetService("CoinService")

    -- ฟังการเปลี่ยนเหรียญจาก server
    CoinService.CoinsUpdated:Connect(function(newAmount: number)
        -- อัปเดต UI
        updateCoinDisplay(newAmount)
    end)

    -- ดึงข้อมูลเริ่มต้น
    local currentCoins = CoinService:GetCoins()
    updateCoinDisplay(currentCoins)
end

return CoinController
```

---

## 8. ECS Pattern (Entity-Component-System)

เหมาะกับเกมที่มี entities จำนวนมาก (เช่น tower defense, RPG)

```lua
-- ตัวอย่าง lightweight ECS แบบ manual
-- ReplicatedStorage/Shared/ECS.lua

type Entity = number
type Component = {[string]: any}

local ECS = {}
local nextId = 0
local components: {[Entity]: {[string]: Component}} = {}

-- สร้าง entity ใหม่
function ECS.createEntity(): Entity
    nextId += 1
    components[nextId] = {}
    return nextId
end

-- เพิ่ม component ให้ entity
function ECS.addComponent(entity: Entity, name: string, data: Component)
    components[entity][name] = data
end

-- ดึง component
function ECS.getComponent(entity: Entity, name: string): Component?
    return components[entity] and components[entity][name]
end

-- Query: หา entities ที่มี components ครบตามที่ต้องการ
function ECS.query(...: string): {Entity}
    local required = {...}
    local result = {}

    for entity, comps in components do
        local hasAll = true
        for _, name in required do
            if not comps[name] then
                hasAll = false
                break
            end
        end
        if hasAll then
            table.insert(result, entity)
        end
    end

    return result
end

-- ลบ entity
function ECS.destroyEntity(entity: Entity)
    components[entity] = nil
end

return ECS
```

```lua
-- ตัวอย่างการใช้ ECS กับ NPC
local ECS = require(ReplicatedStorage.Shared.ECS)

-- สร้าง NPC entity
local npc = ECS.createEntity()
ECS.addComponent(npc, "Transform", { position = Vector3.new(0,0,0) })
ECS.addComponent(npc, "Health",    { current = 100, max = 100 })
ECS.addComponent(npc, "Movement",  { speed = 16, target = nil })
ECS.addComponent(npc, "Combat",    { damage = 20, range = 10 })

-- Movement system: อัปเดตทุก frame
local function movementSystem(dt: number)
    -- หา entities ที่มีทั้ง Transform และ Movement
    for _, entity in ECS.query("Transform", "Movement") do
        local transform = ECS.getComponent(entity, "Transform")
        local movement  = ECS.getComponent(entity, "Movement")

        if movement.target then
            local dir = (movement.target - transform.position).Unit
            transform.position += dir * movement.speed * dt
        end
    end
end

-- Health system
local function healthSystem()
    for _, entity in ECS.query("Health") do
        local health = ECS.getComponent(entity, "Health")
        if health.current <= 0 then
            ECS.destroyEntity(entity)
        end
    end
end

-- รัน systems ใน Heartbeat
game:GetService("RunService").Heartbeat:Connect(function(dt)
    movementSystem(dt)
    healthSystem()
end)
```

---

## 9. การใช้ภาษาไทยใน Comments

เมื่อผู้ใช้เป็นคนไทยหรือเขียนภาษาไทย ให้ใช้ comment ภาษาไทยในโค้ดเสมอ:

```lua
-- ✅ ตัวอย่างโค้ดพร้อม comment ภาษาไทย

local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")

-- ที่เก็บข้อมูลผู้เล่น (เปลี่ยน version เมื่อ reset ข้อมูล)
local playerStore = DataStoreService:GetDataStore("PlayerData_v1")

-- ค่าเริ่มต้นสำหรับผู้เล่นใหม่
local DEFAULT_DATA = {
    เหรียญ = 0,      -- หรือใช้ coins = 0 ก็ได้
    เลเวล = 1,
    ไอเทม = {},
}

-- ฟังก์ชันโหลดข้อมูลผู้เล่น
local function โหลดข้อมูล(player: Player)
    -- pcall ป้องกัน error จาก DataStore
    local สำเร็จ, ข้อมูล = pcall(function()
        return playerStore:GetAsync(tostring(player.UserId))
    end)

    if สำเร็จ and ข้อมูล then
        return ข้อมูล
    else
        -- ถ้าโหลดไม่ได้ ใช้ค่าเริ่มต้น
        return table.clone(DEFAULT_DATA)
    end
end
```

> **หมายเหตุ:** Luau รองรับ Unicode ใน identifiers แต่ในทีมงานจริงมักใช้ English identifier พร้อม Thai comment เพื่อความชัดเจน

---

## 10. Reference Files

อ่านเพิ่มเติมตามหัวข้อ:
- `references/ui-systems.md` — React-Lua / Fusion UI patterns พร้อมตัวอย่างโค้ด
- `references/map-design.md` — Zone system, Procedural generation, Lighting
- `references/monetization.md` — Game Pass, Developer Products, ProcessReceipt pattern
