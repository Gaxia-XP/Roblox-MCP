# UI Systems — Roblox

## ตัวเลือก UI Framework

| Framework | เหมาะกับ | ข้อดี |
|-----------|---------|-------|
| Vanilla ScreenGui | โปรเจกต์เล็ก | ไม่ต้องติดตั้งเพิ่ม |
| React-lua | โปรเจกต์ใหญ่, state ซับซ้อน | Component-based, reactive |
| Fusion | ระดับ intermediate | Roblox-native, ง่ายกว่า React |

---

## React-lua Pattern (แนะนำสำหรับ advanced)

```lua
-- StarterPlayerScripts/Controllers/UIController.lua
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local React = require(ReplicatedStorage.Packages.React)
local ReactRoblox = require(ReplicatedStorage.Packages.ReactRoblox)

local e = React.createElement

-- Component: HUD แสดงเลือด + เหรียญ
local function HUD(props: { health: number, coins: number })
    return e("ScreenGui", {
        ResetOnSpawn = false,
        ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
    }, {
        -- แถบ HP
        HealthBar = e("Frame", {
            Size = UDim2.new(0.3, 0, 0.04, 0),
            Position = UDim2.new(0.35, 0, 0.9, 0),
            BackgroundColor3 = Color3.fromRGB(30, 30, 30),
        }, {
            Fill = e("Frame", {
                -- ขนาดเปลี่ยนตาม health
                Size = UDim2.new(props.health / 100, 0, 1, 0),
                BackgroundColor3 = Color3.fromRGB(220, 50, 50),
            }),
        }),

        -- แสดงเหรียญ
        CoinsLabel = e("TextLabel", {
            Text = `🪙 {props.coins}`,
            Size = UDim2.new(0.15, 0, 0.05, 0),
            Position = UDim2.new(0.02, 0, 0.02, 0),
            BackgroundTransparency = 1,
            TextColor3 = Color3.new(1, 1, 1),
            TextScaled = true,
        }),
    })
end

-- Mount ลงหน้าจอ
local player = Players.LocalPlayer
local root = ReactRoblox.createRoot(Instance.new("Folder"))

-- State management แบบง่าย
local function App()
    local health, setHealth = React.useState(100)
    local coins, setCoins = React.useState(0)

    React.useEffect(function()
        -- ฟัง remote event เพื่ออัปเดต UI
        local conn = ReplicatedStorage.Remotes.UI.UpdateHUD.OnClientEvent:Connect(
            function(newHealth: number, newCoins: number)
                setHealth(newHealth)
                setCoins(newCoins)
            end
        )
        return function() conn:Disconnect() end
    end, {})

    return e(HUD, { health = health, coins = coins })
end

root:render(e(App))
```

---

## Fusion Pattern (ทางเลือกที่ง่ายกว่า)

```lua
local Fusion = require(ReplicatedStorage.Packages.Fusion)
local New = Fusion.New
local Value = Fusion.Value
local Computed = Fusion.Computed

-- Reactive value
local playerHealth = Value(100)

-- UI ที่อัปเดตอัตโนมัติ
local healthBar = New "Frame" {
    Parent = playerGui.ScreenGui,
    Size = Computed(function()
        -- คำนวณขนาดจาก health อัตโนมัติ
        return UDim2.new(playerHealth:get() / 100, 0, 0.04, 0)
    end),
    BackgroundColor3 = Color3.fromRGB(220, 50, 50),
}

-- อัปเดตค่า → UI เปลี่ยนเอง
playerHealth:set(75)
```

---

## Vanilla GUI Tips

```lua
-- ใช้ TweenService สำหรับ animation ที่นุ่มนวล
local TweenService = game:GetService("TweenService")

local function animateHealthBar(bar: Frame, targetPercent: number)
    local tween = TweenService:Create(bar,
        TweenInfo.new(0.3, Enum.EasingStyle.Quad, Enum.EasingDirection.Out),
        { Size = UDim2.new(targetPercent, 0, 1, 0) }
    )
    tween:Play()
end

-- ใช้ UIAspectRatioConstraint เพื่อ responsive UI
local constraint = Instance.new("UIAspectRatioConstraint")
constraint.AspectRatio = 16 / 9
constraint.Parent = screenGui

-- AutomaticSize สำหรับ dynamic content
textLabel.AutomaticSize = Enum.AutomaticSize.XY
```
