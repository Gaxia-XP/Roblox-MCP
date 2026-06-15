# Map Design — Roblox

## หลักการออกแบบ Map

### โครงสร้าง Workspace ที่ดี
```
Workspace/
├── Map/
│   ├── Terrain          -- ภูมิประเทศ (ใช้ Terrain tool)
│   ├── Static/          -- สิ่งของที่ไม่ขยับ (ต้นไม้, อาคาร)
│   │   └── [Anchored = true, CanCollide = true]
│   ├── Dynamic/         -- สิ่งของที่ขยับได้ (ประตู,罐罐)
│   ├── SpawnPoints/     -- จุดเกิดผู้เล่น
│   │   └── SpawnLocation instances
│   └── Zones/           -- invisible trigger zones (CanCollide = false, Transparency = 1)
├── NPCs/                -- NPC models
└── Lighting/            -- ไฟและ atmosphere settings
```

---

## Zone System (พื้นที่พิเศษ)

```lua
-- ServerScriptService/Services/ZoneService.lua
-- ตรวจจับผู้เล่นเข้า/ออกโซน

local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

type Zone = {
    part: BasePart,
    onEnter: (player: Player) -> (),
    onExit: (player: Player) -> (),
}

local ZoneService = {}
local zones: {Zone} = {}
local playersInZone: {[Player]: {[BasePart]: boolean}} = {}

-- ลงทะเบียนโซน
function ZoneService.register(part: BasePart,
    onEnter: (Player) -> (),
    onExit: (Player) -> ()
)
    table.insert(zones, { part = part, onEnter = onEnter, onExit = onExit })
end

-- ตรวจสอบทุก Heartbeat
RunService.Heartbeat:Connect(function()
    for _, player in game:GetService("Players"):GetPlayers() do
        if not player.Character then continue end
        local rootPart = player.Character:FindFirstChild("HumanoidRootPart")
        if not rootPart then continue end

        if not playersInZone[player] then
            playersInZone[player] = {}
        end

        for _, zone in zones do
            -- ใช้ GetTouchingParts หรือตรวจสอบ region
            local isInside = isPointInPart(rootPart.Position, zone.part)
            local wasInside = playersInZone[player][zone.part] or false

            if isInside and not wasInside then
                playersInZone[player][zone.part] = true
                zone.onEnter(player)
            elseif not isInside and wasInside then
                playersInZone[player][zone.part] = false
                zone.onExit(player)
            end
        end
    end
end)

-- ตรวจว่า point อยู่ใน part หรือเปล่า
function isPointInPart(point: Vector3, part: BasePart): boolean
    local relativePos = part.CFrame:PointToObjectSpace(point)
    local halfSize = part.Size / 2
    return math.abs(relativePos.X) <= halfSize.X
        and math.abs(relativePos.Y) <= halfSize.Y
        and math.abs(relativePos.Z) <= halfSize.Z
end

return ZoneService
```

---

## Procedural Generation (สร้าง Map แบบสุ่ม)

```lua
-- สุ่มวาง obstacles ใน grid
local function generateMap(gridSize: number, obstacleChance: number)
    local mapFolder = Instance.new("Folder")
    mapFolder.Name = "ProceduralMap"
    mapFolder.Parent = Workspace

    local cellSize = 8  -- ขนาดช่องกริด (studs)

    for x = 0, gridSize - 1 do
        for z = 0, gridSize - 1 do
            -- สุ่มวาง obstacle
            if math.random() < obstacleChance then
                local part = Instance.new("Part")
                part.Size = Vector3.new(cellSize - 1, math.random(4, 12), cellSize - 1)
                part.CFrame = CFrame.new(x * cellSize, part.Size.Y / 2, z * cellSize)
                part.Anchored = true
                part.Material = Enum.Material.SmoothPlastic
                -- สุ่มสี
                part.Color = Color3.fromHSV(math.random(), 0.5, 0.8)
                part.Parent = mapFolder
            end
        end
    end

    return mapFolder
end
```

---

## Lighting & Atmosphere

```lua
-- ตั้งค่า Lighting สำหรับบรรยากาศ
local Lighting = game:GetService("Lighting")

-- กลางวัน
local function setDaytime()
    Lighting.TimeOfDay = "14:00:00"
    Lighting.Brightness = 2
    Lighting.Ambient = Color3.fromRGB(70, 70, 70)
    Lighting.OutdoorAmbient = Color3.fromRGB(128, 128, 128)
end

-- กลางคืน
local function setNighttime()
    Lighting.TimeOfDay = "22:00:00"
    Lighting.Brightness = 0.5
    Lighting.Ambient = Color3.fromRGB(20, 20, 40)
end

-- Day/Night cycle
local DAY_LENGTH = 240  -- วินาที (4 นาที = 1 วันใน-game)
task.spawn(function()
    while true do
        -- วนจาก 0 ถึง 24 ชั่วโมง
        local timeOfDay = (os.clock() % DAY_LENGTH) / DAY_LENGTH * 24
        Lighting.ClockTime = timeOfDay
        task.wait(1)
    end
end)
```

---

## Performance: Static vs Dynamic Parts

```lua
-- ✅ ดี: Anchor ทุก part ที่ไม่ขยับ
for _, part in mapFolder:GetDescendants() do
    if part:IsA("BasePart") then
        part.Anchored = true  -- ลด physics simulation
    end
end

-- ✅ ดี: รวม parts เล็กๆ เป็น Union หรือ MeshPart
-- ไปที่ Model → Union ใน Roblox Studio

-- ✅ ดี: ใช้ LOD (Level of Detail) สำหรับ objects ไกล
-- ตั้ง RenderFidelity = Disabled สำหรับ objects ที่อยู่ไกล
part.RenderFidelity = Enum.RenderFidelity.Disabled
```
