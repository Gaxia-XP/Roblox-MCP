# Monetization — Roblox

## ประเภทการสร้างรายได้

| ประเภท | อธิบาย | ใช้เมื่อ |
|--------|--------|---------|
| Game Pass | ซื้อครั้งเดียว, ใช้ได้ตลอด | VIP, ความสามารถพิเศษ |
| Developer Product | ซื้อซ้ำได้ | เหรียญ, ไอเทม consumable |
| Private Server | เช่า server ส่วนตัว | เกมหลายคน |
| Premium Payouts | รับจาก Roblox ตาม engagement | Passive income |

---

## Game Pass System

```lua
-- ServerScriptService/Services/GamePassService.lua
local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")

-- ID ของ Game Passes (ตั้งค่าใน Roblox Creator Hub)
local GAME_PASSES = {
    VIP = 000000001,          -- ใส่ ID จริง
    DOUBLE_COINS = 000000002,
    EXTRA_INVENTORY = 000000003,
}

local GamePassService = {}

-- ตรวจสอบว่า player มี game pass หรือเปล่า
function GamePassService.hasPass(player: Player, passName: string): boolean
    local passId = GAME_PASSES[passName]
    if not passId then return false end

    local success, hasPass = pcall(function()
        return MarketplaceService:UserOwnsGamePassAsync(player.UserId, passId)
    end)

    return success and hasPass
end

-- เปิด prompt ซื้อ game pass
function GamePassService.promptPurchase(player: Player, passName: string)
    local passId = GAME_PASSES[passName]
    if not passId then return end
    MarketplaceService:PromptGamePassPurchase(player, passId)
end

-- รับ event เมื่อซื้อสำเร็จ
MarketplaceService.PromptGamePassPurchaseFinished:Connect(
    function(player: Player, passId: number, wasPurchased: boolean)
        if not wasPurchased then return end

        if passId == GAME_PASSES.VIP then
            -- ให้รางวัล VIP
            applyVIPBenefits(player)
        elseif passId == GAME_PASSES.DOUBLE_COINS then
            -- เปิดใช้ double coins
            applyDoubleCoinsBuff(player)
        end
    end
)

return GamePassService
```

---

## Developer Products (ซื้อซ้ำได้)

```lua
-- ServerScriptService/Services/ProductService.lua
local MarketplaceService = game:GetService("MarketplaceService")

local PRODUCTS = {
    COINS_100 = 000000010,    -- ซื้อ 100 เหรียญ
    COINS_500 = 000000011,    -- ซื้อ 500 เหรียญ
    REVIVE = 000000012,       -- ฟื้นคืนชีพ
}

-- ต้องลงทะเบียน handler นี้ไว้ก่อน (สำคัญมาก!)
MarketplaceService.ProcessReceipt = function(receiptInfo)
    local player = game:GetService("Players"):GetPlayerByUserId(receiptInfo.PlayerId)
    if not player then
        -- Player ออกไปแล้ว → รอให้กลับมาแล้วค่อยให้รางวัล
        return Enum.ProductPurchaseDecision.NotProcessedYet
    end

    local productId = receiptInfo.ProductId

    -- ป้องกัน duplicate (บันทึก receiptId ลง DataStore)
    if hasProcessedReceipt(receiptInfo.PurchaseId) then
        return Enum.ProductPurchaseDecision.PurchaseGranted
    end

    -- ให้รางวัลตาม product
    if productId == PRODUCTS.COINS_100 then
        addCoins(player, 100)
    elseif productId == PRODUCTS.COINS_500 then
        addCoins(player, 500)
    elseif productId == PRODUCTS.REVIVE then
        revivePlayer(player)
    end

    -- บันทึกว่าได้ process แล้ว
    saveProcessedReceipt(receiptInfo.PurchaseId)

    -- สำคัญ: ต้อง return PurchaseGranted เสมอหลัง process สำเร็จ
    return Enum.ProductPurchaseDecision.PurchaseGranted
end
```
