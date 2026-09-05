--!strict
-- MultiAIPlugin.lua
-- Roblox Studio plugin that bridges Studio with the local MCP server.
-- Install path (Windows): %LOCALAPPDATA%\Roblox\Plugins\MultiAIPlugin.lua
--
-- Requires: HTTP requests must be enabled in Studio
--   File > Studio Settings > Security > Allow HTTP Requests = ON
--
-- This plugin polls http://127.0.0.1:8765/poll for commands and executes them
-- against the running Studio instance.

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local StudioTestService = game:GetService("StudioTestService")
local RunService = game:GetService("RunService")

local SERVER_URL = "http://127.0.0.1:8765"
local POLL_INTERVAL = 0.5
local MCP_STOP_SIGNAL_KEY = "MultiAI_StopPlaySignal"
local STUDIO_ID_KEY = "MultiAI_StudioId"
local CONTROL_POLL_INTERVAL = 1.0

-- ---------------------------------------------------------------------------
-- Studio identity: a stable per-Studio-window id the broker uses for routing.
-- Minted via HttpService:GenerateGUID (32 hex, no braces), persisted with
-- plugin:SetSetting (the same cross-session persistence class proven by
-- MultiAI_StopPlaySignal). NOT PlaceId (0 for unsaved / identical across
-- windows) nor JobId ("" in Edit). All persistence is pcall-guarded: if
-- SetSetting/GetSetting fail, the id is still minted per-load (a non-persistent
-- fallback — strictly no worse than today, which carries no identity at all).
-- `studioId` is a mutable upvalue: the __assign_studio_id handler reassigns it
-- in place so the next poll's requestHeaders() carries the new id.
-- ---------------------------------------------------------------------------
-- Per-window identity: mint a FRESH id on every plugin load and never reuse a
-- persisted one for routing. plugin:SetSetting is per-plugin USER-GLOBAL (shared
-- by every Studio window on the machine), so persisting+reusing the id made all
-- windows send the same x-studio-id → the broker saw them as ONE contested studio
-- and could not address them separately. Minting fresh per load gives each window
-- a unique id from its first poll. `studioId` stays a mutable upvalue so the
-- (now dormant) __assign_studio_id handler can still reassign it in place.
local studioId: string = HttpService:GenerateGUID(false)

-- Advisory display label (never a routing key): game name + short id suffix.
local studioLabel: string = (function(): string
    local name = "Studio"
    local okName, gameName = pcall(function() return game.Name end)
    if okName and typeof(gameName) == "string" and gameName ~= "" then
        name = gameName
    end
    return `{name} #{string.sub(studioId, 1, 4)}`
end)()

-- Tracks whether the current studioLabel has already been sent, so steady-state
-- polls omit x-studio-label and only re-send it when it changes.
local labelSent = false

-- Optional shared secret. Leave "" for the default (no auth). To require auth,
-- set this to the same value as the server's ROBLOX_MCP_TOKEN env var, then
-- re-sync the plugin (sync-plugin.ps1). When set, it is sent as the
-- `x-mcp-token` header on every /poll and /result request.
local AUTH_TOKEN = ""

-- Header table for every broker request. ALWAYS carries x-studio-id (re-reading
-- the LIVE studioId upvalue on each call — never a load-time capture, so an
-- __assign_studio_id reassignment is reflected on the very next poll). Adds
-- x-mcp-token only when AUTH_TOKEN is configured, and x-studio-label only on the
-- first send or after the label changes (steady-state polls send id-only).
local function requestHeaders(includeLabel: boolean?): { [string]: string }
    local headers: { [string]: string } = { ["x-studio-id"] = studioId }
    if AUTH_TOKEN ~= "" then
        headers["x-mcp-token"] = AUTH_TOKEN
    end
    if includeLabel and not labelSent then
        headers["x-studio-label"] = studioLabel
        labelSent = true
    end
    return headers
end

-- Back-compat alias: any historical authHeaders() call now delegates to
-- requestHeaders() so it keeps sending x-studio-id too.
local function authHeaders(): { [string]: string }
    return requestHeaders(false)
end

-- ---------------------------------------------------------------------------
-- Play-mode server context: monitor for stop signals sent from edit mode.
-- When ExecutePlayModeAsync is running, only plugin code in the Server context
-- can call EndTest to terminate it. We poll a plugin setting as a cross-context
-- signal (plugin:SetSetting persists across edit ↔ play boundaries).
-- ---------------------------------------------------------------------------
if RunService:IsRunning() and RunService:IsServer() then
    task.spawn(function()
        while task.wait(0.5) do
            local ok, val = pcall(function() return plugin:GetSetting(MCP_STOP_SIGNAL_KEY) end)
            if ok and val then
                pcall(function() plugin:SetSetting(MCP_STOP_SIGNAL_KEY, false) end)
                pcall(function() StudioTestService:EndTest({}) end)
            end
        end
    end)
end

-- ---------------------------------------------------------------------------
-- Path resolution: "game.Workspace.Foo" -> Instance
-- ---------------------------------------------------------------------------

local function resolvePath(path: string): Instance?
    if not path or path == "" then return game end
    local node: Instance = game
    local first = true
    for part in string.gmatch(path, "[^%.]+") do
        if first and (part == "game" or part == "Game") then
            first = false
            continue
        end
        first = false
        -- Try service first if node is game
        local nextNode
        if node == game then
            local ok, svc = pcall(function() return game:GetService(part) end)
            if ok and svc then
                nextNode = svc
            end
        end
        if not nextNode then
            nextNode = node:FindFirstChild(part)
        end
        if not nextNode then
            return nil
        end
        node = nextNode
    end
    return node
end

-- ---------------------------------------------------------------------------
-- Value coercion: list -> Vector3 / Color3 etc.
-- ---------------------------------------------------------------------------

local VECTOR3_PROPS = {
    Position = true, Size = true, Orientation = true, Rotation = true,
    Velocity = true, RotVelocity = true,
}
local COLOR3_PROPS = { Color = true }
local BRICKCOLOR_PROPS = { BrickColor = true }

local function coerceValue(propName: string, value: any): any
    if typeof(value) == "table" then
        if VECTOR3_PROPS[propName] and #value == 3 then
            return Vector3.new(value[1], value[2], value[3])
        end
        if COLOR3_PROPS[propName] and #value == 3 then
            return Color3.new(value[1], value[2], value[3])
        end
        -- The BrickColor property needs a BrickColor value, NOT a Color3 —
        -- assigning a Color3 to it errors. Build the nearest BrickColor.
        if BRICKCOLOR_PROPS[propName] and #value == 3 then
            return BrickColor.new(Color3.new(value[1], value[2], value[3]))
        end
    end
    if BRICKCOLOR_PROPS[propName] and typeof(value) == "string" then
        local ok, bc = pcall(function() return BrickColor.new(value) end)
        if ok then return bc end
    end
    if propName == "Material" and typeof(value) == "string" then
        local ok, mat = pcall(function() return Enum.Material[value] end)
        if ok then return mat end
    end
    return value
end

-- ---------------------------------------------------------------------------
-- Undo recording helper
-- TryBeginRecording / FinishRecording is the modern API. All writes made
-- between Begin and Finish become ONE undo step. SetWaypoint alone does NOT
-- reliably register changes on the undo stack (especially for run_luau).
-- ---------------------------------------------------------------------------

local function withRecording(name, fn)
    local recordingId
    pcall(function()
        recordingId = ChangeHistoryService:TryBeginRecording(name, name)
    end)

    local success, result = pcall(fn)

    if recordingId then
        pcall(function()
            local op
            if success then
                op = Enum.FinishRecordingOperation.Commit
            else
                op = Enum.FinishRecordingOperation.Cancel
            end
            ChangeHistoryService:FinishRecording(recordingId, op)
        end)
    end

    if not success then
        error(result, 2)
    end
    return result
end

-- ---------------------------------------------------------------------------
-- Command handlers
-- ---------------------------------------------------------------------------

local handlers: { [string]: (any) -> any } = {}

-- Format an arbitrary value for run_luau's return_value field: Instances read
-- as full paths, everything else falls back to tostring().
local function describeValue(v: any): string
    if typeof(v) == "Instance" then
        local ok, full = pcall(function() return v:GetFullName() end)
        if ok and full ~= "" then return full end
        return `{v.ClassName} ({v.Name})`
    end
    return tostring(v)
end

-- ── Broker control commands (delivered on the control loop; never user tools) ──

-- Reassign this Studio's id when the broker detects two windows sharing the same
-- persisted MultiAI_StudioId (the "contested" case). The broker hands the second
-- window a fresh GUID; we validate, persist, and mutate the live studioId upvalue
-- so the very next poll's requestHeaders() carries the new id.
handlers.__assign_studio_id = function(payload)
    local newId = payload.studio_id
    if typeof(newId) ~= "string" or not string.match(newId, "^[0-9a-fA-F%-]+$") then
        return { ok = false, error = "invalid studio_id" }
    end
    local len = string.len(newId)
    if len < 8 or len > 64 then
        return { ok = false, error = "studio_id length out of range" }
    end
    pcall(function() plugin:SetSetting(STUDIO_ID_KEY, newId) end)
    studioId = newId
    studioLabel = `Studio #{string.sub(studioId, 1, 4)}`
    labelSent = false
    return { ok = true, studio_id = studioId }
end

-- Arm the existing Server-context StopPlaySignal watcher (the RunService:IsServer
-- block near the top of this file, UNTOUCHED) so a second session can stop a play
-- test even while THIS plugin's command loop is yielded inside
-- ExecutePlayModeAsync. Only SetSetting — returns immediately, never blocks the
-- control loop.
handlers.__stop_play = function(_payload)
    pcall(function() plugin:SetSetting(MCP_STOP_SIGNAL_KEY, true) end)
    return { ok = true }
end

handlers.run_luau = function(payload)
    local code = payload.code
    -- Capture print output by overriding the global print for the call
    local outputs = {}
    local env = setmetatable({
        print = function(...)
            local parts = {}
            for i = 1, select("#", ...) do
                parts[i] = tostring(select(i, ...))
            end
            table.insert(outputs, table.concat(parts, "\t"))
        end,
        warn = warn,
        game = game,
        workspace = workspace,
        Instance = Instance,
        -- Vector / spatial primitives
        Vector3 = Vector3,
        Vector2 = Vector2,
        CFrame = CFrame,
        Ray = Ray,
        Region3 = Region3,
        RaycastParams = RaycastParams,
        OverlapParams = OverlapParams,
        -- Colors
        Color3 = Color3,
        BrickColor = BrickColor,
        ColorSequence = ColorSequence,
        ColorSequenceKeypoint = ColorSequenceKeypoint,
        -- Number sequences / ranges
        NumberRange = NumberRange,
        NumberSequence = NumberSequence,
        NumberSequenceKeypoint = NumberSequenceKeypoint,
        -- UI / layout types
        UDim = UDim,
        UDim2 = UDim2,
        Rect = Rect,
        Font = Font,
        -- Animation / tween
        TweenInfo = TweenInfo,
        -- Physics
        PhysicalProperties = PhysicalProperties,
        -- Misc
        Random = Random,
        Enum = Enum,
        -- Libraries
        task = task,
        math = math,
        string = string,
        table = table,
        os = os,
        buffer = buffer,
        utf8 = utf8,
        bit32 = bit32,
        coroutine = coroutine,
        -- Basic functions
        pairs = pairs,
        ipairs = ipairs,
        next = next,
        unpack = unpack,
        tostring = tostring,
        tonumber = tonumber,
        type = type,
        typeof = typeof,
        select = select,
        pcall = pcall,
        xpcall = xpcall,
        error = error,
        assert = assert,
        setmetatable = setmetatable,
        getmetatable = getmetatable,
        rawget = rawget,
        rawset = rawset,
        rawequal = rawequal,
        rawlen = rawlen,
        require = require,
        tick = tick,
    }, { __index = _G })

    -- Expression capture: if the whole snippet compiles as ONE expression, wrap
    -- it in `return (...)` so the evaluated value is reported (REPL-style).
    -- Multi-statement snippets fail to compile as an expression → run as-is.
    local fn, err = loadstring(`return ({code})`, "MCPCommand")
    local isExpr = fn ~= nil
    if not fn then
        fn, err = loadstring(code, "MCPCommand")
    end
    if not fn then return { error = "compile error: " .. tostring(err) } end
    setfenv(fn, env)

    local retValue = nil
    local ok, runErr = pcall(function()
        return withRecording("MCP run_luau", function()
            -- xpcall captures a Lua traceback with the error message — a bare
            -- pcall only surfaces the message and mid-script errors used to
            -- truncate `output` with no error text at all.
            local results = table.pack(xpcall(fn, function(ex)
                return debug.traceback(tostring(ex), 2)
            end))
            if not results[1] then
                error(results[2], 0) -- re-raise: message + traceback string
            end
            if results.n >= 2 then
                retValue = results[2]
            end
        end)
    end)
    if not ok then
        return { error = tostring(runErr), output = table.concat(outputs, "\n") }
    end
    local result: any = { ok = true, output = table.concat(outputs, "\n") }
    -- Report a value when the snippet IS a bare expression (REPL semantics —
    -- even a nil result is reported) OR when a plain multi-statement snippet
    -- explicitly returned one (scrutinize 2026-09-05 MINOR 3: `return 5` used
    -- to be captured but dropped because of the isExpr-only gate).
    if isExpr or retValue ~= nil then
        result.returned = true
        result.return_value = describeValue(retValue)
    end
    return result
end

handlers.get_tree = function(payload)
    local node = resolvePath(payload.path or "game.Workspace")
    if not node then return { error = "path not found: " .. tostring(payload.path) } end
    local depth = payload.depth or 3

    local lines = {}
    local function walk(inst: Instance, indent: number, remaining: number)
        table.insert(lines, string.rep("  ", indent) .. inst.Name .. " [" .. inst.ClassName .. "]")
        if remaining <= 0 then return end
        for _, child in ipairs(inst:GetChildren()) do
            walk(child, indent + 1, remaining - 1)
        end
    end
    walk(node, 0, depth)
    return { tree = table.concat(lines, "\n") }
end

handlers.create_part = function(payload)
    local parent = resolvePath(payload.parent or "Workspace")
    if not parent then return { error = "parent not found: " .. tostring(payload.parent) } end
    return withRecording("MCP create_part", function()
        local part = Instance.new("Part")
        for k, v in pairs(payload.properties or {}) do
            local ok, err = pcall(function() part[k] = coerceValue(k, v) end)
            if not ok then warn("[MultiAI] cannot set " .. k .. ": " .. tostring(err)) end
        end
        part.Parent = parent
        return { ok = true, name = part.Name, fullName = part:GetFullName() }
    end)
end

handlers.create_script = function(payload)
    local parent = resolvePath(payload.parent)
    if not parent then return { error = "parent not found: " .. tostring(payload.parent) } end
    local className = payload.type or "Script"
    if className ~= "Script" and className ~= "LocalScript" and className ~= "ModuleScript" then
        return { error = "invalid script type: " .. className }
    end
    return withRecording("MCP create_script", function()
        local s = Instance.new(className)
        s.Name = payload.name or "MCPScript"
        s.Source = payload.source or ""
        s.Parent = parent
        return { ok = true, fullName = s:GetFullName() }
    end)
end

handlers.set_property = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    return withRecording("MCP set_property", function()
        local ok, err = pcall(function()
            inst[payload.property] = coerceValue(payload.property, payload.value)
        end)
        if not ok then return { error = tostring(err) } end
        return { ok = true }
    end)
end

handlers.delete_instance = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    return withRecording("MCP delete_instance", function()
        inst:Destroy()
        return { ok = true }
    end)
end

-- ---------------------------------------------------------------------------
-- get_properties: read all (or selected) properties of an Instance.
-- Roblox doesn't expose a generic "list all properties" API, so we probe a
-- curated list of common property names per ClassName plus everything provided
-- in payload.names. Unreadable / non-existent properties are silently skipped.
-- ---------------------------------------------------------------------------

local COMMON_PROPS = {
    "Name", "ClassName", "Parent", "Archivable",
    -- BasePart
    "Position", "Size", "Orientation", "Rotation", "CFrame", "Anchored",
    "CanCollide", "CanTouch", "CanQuery", "Massless", "Material", "Color",
    "BrickColor", "Transparency", "Reflectance", "CastShadow", "CollisionGroup",
    "Shape", "TopSurface", "BottomSurface", "Velocity", "AssemblyMass",
    -- Model
    "PrimaryPart", "WorldPivot", "ModelStreamingMode", "LevelOfDetail",
    -- LuaSourceContainer
    "Source", "Enabled", "RunContext",
    -- GuiObject
    "Visible", "Active", "AnchorPoint", "BackgroundColor3", "BackgroundTransparency",
    "BorderColor3", "BorderSizePixel", "LayoutOrder", "ZIndex", "Rotation",
    "Position", "Size", "AutomaticSize", "ClipsDescendants",
    -- TextLabel / TextButton
    "Text", "TextColor3", "TextSize", "TextScaled", "TextWrapped",
    "TextXAlignment", "TextYAlignment", "Font", "FontFace", "RichText",
    -- ImageLabel / ImageButton
    "Image", "ImageColor3", "ImageTransparency", "ScaleType",
    -- ScreenGui
    "ResetOnSpawn", "IgnoreGuiInset", "DisplayOrder", "ZIndexBehavior",
    -- Light/Effects
    "Brightness", "Range", "Angle", "Face", "Shadows",
    -- SpawnLocation
    "Neutral", "TeamColor", "AllowTeamChangeOnTouch",
    -- Camera
    "CameraType", "CameraSubject", "FieldOfView", "Focus",
    -- ParticleEmitter
    "Rate", "Lifetime", "Speed", "EmissionDirection", "Texture",
    -- Sound
    "SoundId", "Volume", "Playing", "Looped", "PlaybackSpeed", "TimePosition",
    -- Tool / HumanoidRootPart / Humanoid
    "WalkSpeed", "JumpPower", "JumpHeight", "Health", "MaxHealth", "Sit",
    "RequiresHandle", "CanBeDropped", "Grip", "GripPos",
    -- RemoteEvent / RemoteFunction etc.
    "Value",
    -- Attachment / Weld
    "Part0", "Part1", "C0", "C1",
}

local function serializeValue(v: any): any
    local t = typeof(v)
    if t == "Vector3" then return { v.X, v.Y, v.Z }
    elseif t == "Vector2" then return { v.X, v.Y }
    elseif t == "Color3" then return { v.R, v.G, v.B }
    elseif t == "BrickColor" then return v.Name
    elseif t == "UDim2" then return { v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset }
    elseif t == "UDim" then return { v.Scale, v.Offset }
    elseif t == "CFrame" then
        local x,y,z,r00,r01,r02,r10,r11,r12,r20,r21,r22 = v:GetComponents()
        return { x,y,z,r00,r01,r02,r10,r11,r12,r20,r21,r22 }
    elseif t == "EnumItem" then return v.Name
    elseif t == "Instance" then return v:GetFullName()
    elseif t == "number" or t == "string" or t == "boolean" or v == nil then return v
    else return tostring(v) end
end

handlers.get_properties = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end

    local namesToTry: { string }
    if payload.names and #payload.names > 0 then
        namesToTry = payload.names
    else
        namesToTry = COMMON_PROPS
    end

    local seen: { [string]: boolean } = {}
    local props: { [string]: any } = {}
    for _, name in ipairs(namesToTry) do
        if not seen[name] then
            seen[name] = true
            local ok, val = pcall(function() return (inst :: any)[name] end)
            if ok and val ~= nil then
                props[name] = serializeValue(val)
            end
        end
    end

    -- Also list children for context
    local children = {}
    for _, c in ipairs(inst:GetChildren()) do
        table.insert(children, { name = c.Name, className = c.ClassName })
        if #children >= 50 then break end
    end

    -- Always include real spatial bounds (edges, not just center) for any
    -- instance that has BaseParts somewhere under it. Lets the AI reason
    -- about gaps and adjacency directly from get_properties.
    local boundsInfo
    pcall(function()
        local ok, b = pcall(handlers.get_bounds, { path = payload.path })
        if ok and b and not b.error then
            boundsInfo = b
        end
    end)

    return {
        path = inst:GetFullName(),
        className = inst.ClassName,
        properties = props,
        children = children,
        childCount = #inst:GetChildren(),
        bounds = boundsInfo,
    }
end

-- ---------------------------------------------------------------------------
-- Undo / Redo via ChangeHistoryService
-- ---------------------------------------------------------------------------

handlers.undo = function(payload)
    local count = math.max(1, math.floor(tonumber(payload.count) or 1))
    local done = 0
    for _ = 1, count do
        local ok = pcall(function() ChangeHistoryService:Undo() end)
        if not ok then break end
        done += 1
    end
    return { ok = true, undone = done }
end

handlers.redo = function(payload)
    local count = math.max(1, math.floor(tonumber(payload.count) or 1))
    local done = 0
    for _ = 1, count do
        local ok = pcall(function() ChangeHistoryService:Redo() end)
        if not ok then break end
        done += 1
    end
    return { ok = true, redone = done }
end

handlers.read_script = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    if not inst:IsA("LuaSourceContainer") then
        return { error = inst.ClassName .. " is not a Script/LocalScript/ModuleScript" }
    end
    local source = inst.Source
    local totalLines = 0
    for _ in (source .. "\n"):gmatch("([^\n]*)\n") do totalLines += 1 end

    -- Optional line-range read (offset is 1-indexed; limit = max rows). Keeps
    -- big-script reads bounded instead of dumping 2k+ lines in one payload.
    local offset = tonumber(payload.offset)
    local limit = tonumber(payload.limit)
    local text = source
    if offset or limit then
        local startIdx = math.max(1, math.floor(offset or 1))
        local endIdx = startIdx + math.max(1, math.floor(limit or (totalLines - startIdx + 1))) - 1
        local out, lineNo = {}, 0
        for line in (source .. "\n"):gmatch("([^\n]*)\n") do
            lineNo += 1
            if lineNo >= startIdx and lineNo <= endIdx then
                table.insert(out, line)
                if lineNo >= endIdx then break end
            end
        end
        text = table.concat(out, "\n")
    end
    return {
        source = text,
        name = inst.Name,
        className = inst.ClassName,
        path = inst:GetFullName(),
        total_lines = totalLines,
        offset = offset and startIdx or nil,
        limit = limit and math.min(math.floor(limit), totalLines) or nil,
    }
end

-- script_grep: Luau-pattern search across EVERY script's Source. Answers
-- "where is X defined?" in one round-trip instead of get_tree + N×read_script.
handlers.script_grep = function(payload)
    local pattern = payload.pattern
    if typeof(pattern) ~= "string" or pattern == "" then
        return { error = "pattern is required" }
    end
    -- Match mode: "plain" (default) = literal substring — grep-like, safe for
    -- text such as "print(" that would be a MALFORMED Luau pattern. "pattern" =
    -- Luau string pattern (metacharacters active). Validate the pattern ONCE so
    -- a malformed pattern fails with a clear error instead of crashing the
    -- whole scan mid-walk (scrutinize 2026-09-05 MAJOR 1).
    local mode = tostring(payload.pattern_mode or "plain")
    if mode ~= "plain" and mode ~= "pattern" then
        return { error = "pattern_mode must be 'plain' or 'pattern'" }
    end
    if mode == "pattern" then
        local ok = pcall(string.find, "", pattern)
        if not ok then
            return { error = "invalid Luau pattern: " .. tostring(pattern) }
        end
    end
    local plainText = mode == "plain"
    local maxResults = math.clamp(math.floor(tonumber(payload.max_results) or 50), 1, 200)
    local matches: { any } = {}
    local truncated = false

    local function searchContainer(container: Instance)
        for _, inst in ipairs(container:GetDescendants()) do
            if truncated then break end
            if inst:IsA("LuaSourceContainer") then
                local lineNo = 0
                for line in (inst.Source .. "\n"):gmatch("([^\n]*)\n") do
                    lineNo += 1
                    if string.find(line, pattern, 1, plainText) then
                        table.insert(matches, {
                            path = inst:GetFullName(),
                            name = inst.Name,
                            className = inst.ClassName,
                            line = lineNo,
                            text = string.sub(line, 1, 300),
                        })
                        if #matches >= maxResults then
                            truncated = true
                            break
                        end
                    end
                end
            end
        end
    end

    for _, svcName in ipairs({ "Workspace", "ReplicatedStorage", "ServerScriptService", "ServerStorage",
        "StarterGui", "StarterPack", "StarterPlayer", "Lighting", "SoundService", "ReplicatedFirst" }) do
        local ok, svc = pcall(function() return game:GetService(svcName) end)
        if ok and svc then searchContainer(svc) end
        if truncated then break end
    end

    return { matches = matches, count = #matches, truncated = truncated, pattern = pattern }
end

-- multi_edit: apply several script create/update ops in ONE command — one
-- ChangeHistory undo step, one round-trip. Per-op failures are reported, not
-- fatal: good ops commit, bad ops carry { error }.
handlers.multi_edit = function(payload)
    local ops = payload.scripts
    if typeof(ops) ~= "table" then return { error = "scripts array is required" } end
    if #ops == 0 then return { error = "scripts array is empty" } end
    if #ops > 50 then return { error = "too many ops (max 50)" } end
    return withRecording("MCP multi_edit", function()
        local results: { any } = {}
        local created, updated, failed = 0, 0, 0
        for i, op in ipairs(ops) do
            local entry: any = { index = i }
            local ok, err = pcall(function()
                if typeof(op.path) == "string" and op.path ~= "" then
                    local inst = resolvePath(op.path)
                    if not inst or not inst:IsA("LuaSourceContainer") then
                        error("path not found or not a script: " .. tostring(op.path))
                    end
                    inst.Source = op.source or ""
                    updated += 1
                    entry.updated = true
                    entry.path = inst:GetFullName()
                else
                    local parent = resolvePath(op.parent or "Workspace")
                    if not parent then
                        error("parent not found: " .. tostring(op.parent))
                    end
                    local className = op.script_type == "LocalScript" and "LocalScript"
                        or op.script_type == "ModuleScript" and "ModuleScript"
                        or "Script"
                    local inst = Instance.new(className)
                    inst.Name = op.name or className
                    inst.Source = op.source or ""
                    inst.Parent = parent
                    created += 1
                    entry.created = true
                    entry.path = inst:GetFullName()
                end
            end)
            if not ok then
                failed += 1
                entry.error = tostring(err)
            end
            table.insert(results, entry)
        end
        return { ok = failed == 0, created = created, updated = updated, failed = failed, results = results }
    end)
end

handlers.update_script = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    if not inst:IsA("LuaSourceContainer") then
        return { error = inst.ClassName .. " is not a Script/LocalScript/ModuleScript" }
    end
    return withRecording("MCP update_script", function()
        inst.Source = payload.source or ""
        local _, lineCount = (payload.source or ""):gsub("\n", "\n")
        return { ok = true, lines = lineCount + 1 }
    end)
end

handlers.get_console_output = function(payload)
    local LogService = game:GetService("LogService")
    local history = LogService:GetLogHistory()

    local lines = tonumber(payload.lines) or 50
    local filter = payload.filter -- legacy: single channel string
    local channels = payload.channels -- new: list of channel names
    local sinceSeconds = tonumber(payload.since_seconds) -- only messages newer than N s
    local pattern = payload.pattern -- substring (case-insensitive) filter on message text
    local cutoff = sinceSeconds and (os.time() - sinceSeconds) or nil

    -- Build a set of allowed channel names (case-insensitive). Empty = accept all.
    local allowed: { [string]: boolean } = {}
    if filter then allowed[tostring(filter):lower()] = true end
    if type(channels) == "table" then
        for _, c in ipairs(channels) do allowed[tostring(c):lower()] = true end
    end
    local hasFilter = next(allowed) ~= nil

    local results = {}
    local counts = { Output = 0, Warning = 0, Error = 0, Info = 0 }
    -- Walk newest→oldest so we can stop once we've collected `lines` items.
    for i = #history, 1, -1 do
        local entry = history[i]
        local typeName = entry.messageType.Name
        local short = typeName:gsub("^Message", "")

        if cutoff and entry.timestamp < cutoff then break end -- timestamps are monotonic
        if hasFilter and not allowed[short:lower()] then continue end
        if pattern and not entry.message:lower():find(tostring(pattern):lower(), 1, true) then continue end

        table.insert(results, 1, { -- prepend to keep chronological order in output
            type = short,
            message = entry.message,
            timestamp = entry.timestamp,
        })
        counts[short] = (counts[short] or 0) + 1
        if #results >= lines then break end
    end

    return {
        messages = results,
        count = #results,
        totalLogged = #history,
        counts = counts,
    }
end

handlers.get_selection = function(payload)
    local Selection = game:GetService("Selection")
    local items = Selection:Get()
    local result = {}
    for _, item in ipairs(items) do
        table.insert(result, {
            name = item.Name,
            className = item.ClassName,
            path = item:GetFullName(),
        })
    end
    return { selection = result, count = #result }
end

handlers.create_instance = function(payload)
    local parent = resolvePath(payload.parent or "Workspace")
    if not parent then return { error = "parent not found: " .. tostring(payload.parent) } end
    return withRecording("MCP create_instance", function()
        local ok, inst = pcall(function() return Instance.new(payload.className) end)
        if not ok or not inst then
            return { error = "cannot create class '" .. tostring(payload.className) .. "': " .. tostring(inst) }
        end
        if payload.name then
            pcall(function() inst.Name = payload.name end)
        end
        for k, v in pairs(payload.properties or {}) do
            pcall(function() inst[k] = coerceValue(k, v) end)
        end
        inst.Parent = parent
        return { ok = true, fullName = inst:GetFullName(), className = inst.ClassName }
    end)
end

handlers.find_instances = function(payload)
    local root = resolvePath(payload.root or "game")
    if not root then return { error = "root not found: " .. tostring(payload.root) } end
    local maxResults = payload.maxResults or 50
    local nameRaw = payload.name
    local classFilter = payload.className
    local matchMode = payload.matchMode or "substring"

    -- Precompute the matcher so we don't re-branch per node
    local nameMatcher: ((string) -> boolean)?
    if nameRaw then
        if matchMode == "exact" then
            nameMatcher = function(s) return s == nameRaw end
        elseif matchMode == "pattern" then
            -- Lua string patterns; wrap in pcall so a bad pattern doesn't kill the search
            nameMatcher = function(s)
                local ok, found = pcall(string.find, s, nameRaw)
                return ok and found ~= nil
            end
        else -- "substring" (default) — case-insensitive contains
            local lower = nameRaw:lower()
            nameMatcher = function(s) return s:lower():find(lower, 1, true) ~= nil end
        end
    end

    local results = {}
    local function search(inst)
        if #results >= maxResults then return end
        local nameMatch = (not nameMatcher) or nameMatcher(inst.Name)
        local classMatch = (not classFilter) or inst:IsA(classFilter)
        if nameMatch and classMatch and inst ~= root then
            table.insert(results, { path = inst:GetFullName(), className = inst.ClassName, name = inst.Name })
        end
        for _, child in ipairs(inst:GetChildren()) do
            if #results >= maxResults then return end
            search(child)
        end
    end
    search(root)
    return { results = results, count = #results, capped = #results >= maxResults, matchMode = matchMode }
end

handlers.validate_path = function(payload)
    local node = resolvePath(payload.path)
    if not node then return { exists = false } end
    return {
        exists = true,
        className = node.ClassName,
        name = node.Name,
        fullPath = node:GetFullName(),
    }
end

handlers.clear_console_output = function(payload)
    local LogService = game:GetService("LogService")
    local ok, err = pcall(function() LogService:ClearOutput() end)
    if not ok then return { error = "ClearOutput failed: " .. tostring(err) } end
    return { ok = true }
end

-- ---------------------------------------------------------------------------
-- Attribute tools
-- ---------------------------------------------------------------------------

local function coerceAttributeValue(value: any, typeName: string?): any
    if typeName == "Vector3" and type(value) == "table" then
        return Vector3.new(value[1] or 0, value[2] or 0, value[3] or 0)
    elseif typeName == "Vector2" and type(value) == "table" then
        return Vector2.new(value[1] or 0, value[2] or 0)
    elseif typeName == "Color3" and type(value) == "table" then
        return Color3.new(value[1] or 0, value[2] or 0, value[3] or 0)
    elseif typeName == "UDim" and type(value) == "table" then
        return UDim.new(value[1] or 0, value[2] or 0)
    elseif typeName == "UDim2" and type(value) == "table" then
        return UDim2.new(value[1] or 0, value[2] or 0, value[3] or 0, value[4] or 0)
    elseif typeName == "BrickColor" and type(value) == "string" then
        return BrickColor.new(value)
    elseif typeName == "CFrame" and type(value) == "table" then
        if #value == 12 then return CFrame.new(table.unpack(value)) end
        if #value == 3 then return CFrame.new(value[1], value[2], value[3]) end
        return nil
    elseif typeName == "number" then
        return tonumber(value)
    elseif typeName == "string" then
        return tostring(value)
    elseif typeName == "boolean" then
        return not not value
    end
    return value
end

-- Compare a serialized attribute value (always primitive or array) against
-- a user-supplied filter (also primitive or array from JSON). Returns true
-- iff they match component-wise.
local function attrValueEquals(serialized: any, filter: any): boolean
    if type(serialized) ~= type(filter) then return false end
    if type(serialized) == "table" then
        if #serialized ~= #filter then return false end
        for i = 1, #serialized do
            if serialized[i] ~= filter[i] then return false end
        end
        return true
    end
    return serialized == filter
end

handlers.get_attributes = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end

    local raw = inst:GetAttributes()
    local out: { [string]: { value: any, type: string } } = {}
    local count = 0
    for k, v in pairs(raw) do
        out[k] = { value = serializeValue(v), type = typeof(v) }
        count += 1
    end
    return { path = inst:GetFullName(), attributes = out, count = count }
end

handlers.set_attribute = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    if not payload.name or payload.name == "" then return { error = "name is required" } end

    return withRecording("MCP set_attribute", function()
        if payload.remove then
            local ok, err = pcall(function() inst:SetAttribute(payload.name, nil) end)
            if not ok then return { error = "remove failed: " .. tostring(err) } end
            return { ok = true, removed = true, path = inst:GetFullName(), name = payload.name }
        end

        local coerced = coerceAttributeValue(payload.value, payload.valueType)
        if coerced == nil and payload.value ~= nil then
            return { error = `could not coerce value to type {payload.valueType or "auto"}` }
        end
        local ok, err = pcall(function() inst:SetAttribute(payload.name, coerced) end)
        if not ok then return { error = "SetAttribute failed: " .. tostring(err) } end
        return {
            ok = true,
            path = inst:GetFullName(),
            name = payload.name,
            value = serializeValue(coerced),
            type = typeof(coerced),
        }
    end)
end

handlers.find_by_attribute = function(payload)
    local root = resolvePath(payload.root or "game")
    if not root then return { error = "root not found: " .. tostring(payload.root) } end
    local maxResults = payload.maxResults or 50
    local attrName = payload.name
    if not attrName or attrName == "" then return { error = "name is required" } end
    local filterValue = payload.value
    local hasFilter = filterValue ~= nil

    local results = {}
    local function search(inst: Instance)
        if #results >= maxResults then return end
        local v = inst:GetAttribute(attrName)
        if v ~= nil then
            local serialized = serializeValue(v)
            if (not hasFilter) or attrValueEquals(serialized, filterValue) then
                table.insert(results, {
                    path = inst:GetFullName(),
                    className = inst.ClassName,
                    name = inst.Name,
                    value = serialized,
                    valueType = typeof(v),
                })
            end
        end
        for _, child in ipairs(inst:GetChildren()) do
            if #results >= maxResults then return end
            search(child)
        end
    end
    search(root)
    return { results = results, count = #results, capped = #results >= maxResults }
end

-- ---------------------------------------------------------------------------
-- Animation tools
-- ---------------------------------------------------------------------------

-- Resolve target → Animator. Accepts Humanoid, AnimationController, or a
-- Model containing one. Auto-creates an Animator child if needed.
local function getOrCreateAnimator(target: Instance): (Animator?, string?)
    local host: Instance? = nil
    if target:IsA("Humanoid") or target:IsA("AnimationController") then
        host = target
    elseif target:IsA("Model") then
        host = target:FindFirstChildOfClass("Humanoid") or target:FindFirstChildOfClass("AnimationController")
    end
    if not host then
        return nil, "target must be a Humanoid/AnimationController or a Model containing one"
    end
    local animator = host:FindFirstChildOfClass("Animator")
    if not animator then
        animator = Instance.new("Animator")
        animator.Parent = host
    end
    return animator, nil
end

handlers.play_animation = function(payload)
    local target = resolvePath(payload.target)
    if not target then return { error = "target not found: " .. tostring(payload.target) } end
    if not payload.assetId then return { error = "asset_id is required" } end

    local animator, err = getOrCreateAnimator(target)
    if not animator then return { error = err } end

    local anim = Instance.new("Animation")
    anim.AnimationId = `rbxassetid://{payload.assetId}`

    local ok, trackOrErr = pcall(function() return animator:LoadAnimation(anim) end)
    if not ok then
        anim:Destroy()
        return { error = "LoadAnimation failed: " .. tostring(trackOrErr) }
    end
    local track: AnimationTrack = trackOrErr

    if payload.looped ~= nil then track.Looped = payload.looped end
    local fade = tonumber(payload.fadeTime) or 0.1
    local weight = tonumber(payload.weight) or 1
    local speed = tonumber(payload.speed) or 1
    local ok2, err2 = pcall(function() track:Play(fade, weight, speed) end)
    if not ok2 then return { error = "Play failed: " .. tostring(err2) } end

    return {
        ok = true,
        animatorPath = animator:GetFullName(),
        trackName = track.Name,
        looped = track.Looped,
        length = track.Length,
    }
end

handlers.stop_animations = function(payload)
    local target = resolvePath(payload.target)
    if not target then return { error = "target not found: " .. tostring(payload.target) } end

    local animator, err = getOrCreateAnimator(target)
    if not animator then return { error = err } end

    local fade = tonumber(payload.fadeTime) or 0.1
    local stopped = 0
    for _, track in ipairs(animator:GetPlayingAnimationTracks()) do
        pcall(function() track:Stop(fade) end)
        stopped += 1
    end
    return { ok = true, stopped = stopped, animatorPath = animator:GetFullName() }
end

-- ---------------------------------------------------------------------------
-- Batch & array operations
-- ---------------------------------------------------------------------------

handlers.batch_set_property = function(payload)
    local updates = payload.updates or {}
    return withRecording("MCP batch_set_property", function()
        local results = {}
        local succeeded = 0
        for i, upd in ipairs(updates) do
            local inst = resolvePath(upd.path)
            if not inst then
                results[i] = { ok = false, error = "path not found: " .. tostring(upd.path) }
            elseif not upd.property or upd.property == "" then
                results[i] = { ok = false, error = "property name required" }
            else
                local ok, err = pcall(function()
                    (inst :: any)[upd.property] = coerceValue(upd.property, upd.value)
                end)
                if ok then
                    results[i] = { ok = true }
                    succeeded += 1
                else
                    results[i] = { ok = false, error = tostring(err) }
                end
            end
        end
        return { ok = true, total = #results, succeeded = succeeded, results = results }
    end)
end

handlers.array_clone = function(payload)
    local source = resolvePath(payload.source)
    if not source then return { error = "source not found: " .. tostring(payload.source) } end
    if not (source:IsA("Model") or source:IsA("BasePart")) then
        return { error = "source must be a Model or BasePart, got " .. source.ClassName }
    end
    local mode = payload.mode
    if mode ~= "linear" and mode ~= "grid" and mode ~= "radial" then
        return { error = "mode must be 'linear', 'grid', or 'radial'" }
    end

    local parent = payload.parent and resolvePath(payload.parent) or source.Parent
    if not parent then return { error = "parent not found: " .. tostring(payload.parent) } end

    local namePattern: string? = payload.namePattern
    local sourcePivot: CFrame = source:GetPivot()
    local sourcePos: Vector3 = sourcePivot.Position

    return withRecording("MCP array_clone", function()
        local paths = {}

        local function placeClone(i: number, targetCFrame: CFrame)
            local c = source:Clone()
            if namePattern then
                local renamed = (namePattern:gsub("{i}", tostring(i)))
                c.Name = renamed
            end
            c.Parent = parent
            c:PivotTo(targetCFrame)
            table.insert(paths, c:GetFullName())
        end

        if mode == "linear" then
            local count = tonumber(payload.count) or 5
            local off = payload.offset
            if type(off) ~= "table" then return { error = "linear mode needs `offset:[dx,dy,dz]`" } end
            local offVec = Vector3.new(off[1] or 0, off[2] or 0, off[3] or 0)
            for i = 1, count do
                placeClone(i, sourcePivot + offVec * i)
            end
        elseif mode == "grid" then
            local cx = tonumber(payload.countX) or 3
            local cz = tonumber(payload.countZ) or 3
            local sx = tonumber(payload.spacingX) or 5
            local sz = tonumber(payload.spacingZ) or 5
            local originRaw = payload.origin
            local origin: Vector3 = originRaw
                and Vector3.new(originRaw[1] or 0, originRaw[2] or 0, originRaw[3] or 0)
                or sourcePos
            local i = 1
            for ix = 0, cx - 1 do
                for iz = 0, cz - 1 do
                    local pos = origin + Vector3.new(ix * sx, 0, iz * sz)
                    placeClone(i, sourcePivot + (pos - sourcePos))
                    i += 1
                end
            end
        elseif mode == "radial" then
            local count = tonumber(payload.count) or 6
            local radius = tonumber(payload.radius) or 10
            local centerRaw = payload.center
            local center: Vector3 = centerRaw
                and Vector3.new(centerRaw[1] or 0, centerRaw[2] or 0, centerRaw[3] or 0)
                or sourcePos
            local rotateToFace = payload.rotateToFace == true
            for i = 1, count do
                local angle = (i - 1) / count * math.pi * 2
                local pos = center + Vector3.new(math.cos(angle) * radius, 0, math.sin(angle) * radius)
                local cf: CFrame
                if rotateToFace then
                    cf = CFrame.lookAt(pos, center)
                else
                    cf = sourcePivot + (pos - sourcePos)
                end
                placeClone(i, cf)
            end
        end

        return { ok = true, count = #paths, mode = mode, paths = paths }
    end)
end

handlers.insert_model = function(payload)
    local InsertService = game:GetService("InsertService")
    local parent = resolvePath(payload.parent or "Workspace")
    if not parent then return { error = "parent not found: " .. tostring(payload.parent) } end
    -- LoadAsset is a network call; do it OUTSIDE the recording so it isn't
    -- captured in undo (and so undo only reverses the parenting, instantly).
    local ok, modelOrErr = pcall(function() return InsertService:LoadAsset(payload.assetId) end)
    if not ok or not modelOrErr then
        return { error = "LoadAsset failed (asset may be private or invalid): " .. tostring(modelOrErr) }
    end

    return withRecording("MCP insert_model", function()
        local inserted = {}
        for _, child in ipairs(modelOrErr:GetChildren()) do
            child.Parent = parent
            table.insert(inserted, { path = child:GetFullName(), className = child.ClassName, name = child.Name })
        end
        modelOrErr:Destroy()
        return { ok = true, inserted = inserted, count = #inserted }
    end)
end

handlers.insert_uploaded_model = function(payload)
	local InsertService = game:GetService("InsertService")
	local parent = resolvePath(payload.parent or "Workspace")
	if not parent then return { error = "parent not found: " .. tostring(payload.parent) } end
	local assetId = tonumber(payload.assetId)
	if not assetId then return { error = "assetId must be numeric: " .. tostring(payload.assetId) } end

	-- Freshly-uploaded assets can be briefly unavailable (moderation/propagation).
	-- Retry LoadAsset a few times before giving up. LoadAsset is a network call,
	-- so it runs OUTSIDE the recording (undo only reverses the parenting).
	local model
	for attempt = 1, 5 do
		local ok, res = pcall(function() return InsertService:LoadAsset(assetId) end)
		if ok and res then model = res; break end
		task.wait(1.5)
	end
	if not model then
		return { error = "LoadAsset failed after retries (asset may still be moderating or is private): " .. tostring(assetId) }
	end

	return withRecording("MCP insert_uploaded_model", function()
		local inserted = {}
		for _, child in ipairs(model:GetChildren()) do
			if payload.name and child:IsA("BasePart") then child.Name = payload.name end
			child.Parent = parent
			table.insert(inserted, { path = child:GetFullName(), className = child.ClassName, name = child.Name })
		end
		local modelPath = model:GetFullName()
		model:Destroy()
		return { ok = true, inserted = inserted, count = #inserted, modelPath = modelPath }
	end)
end

handlers.get_studio_mode = function(payload)
    local RunService = game:GetService("RunService")
    return {
        isRunning = RunService:IsRunning(),
        isEdit = RunService:IsEdit(),
        isStudio = RunService:IsStudio(),
        isClient = RunService:IsClient(),
        isServer = RunService:IsServer(),
    }
end

handlers.rename_instance = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    return withRecording("MCP rename_instance", function()
        inst.Name = payload.newName
        return { ok = true, newPath = inst:GetFullName() }
    end)
end

handlers.move_instance = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    local newParent = resolvePath(payload.newParent)
    if not newParent then return { error = "new parent not found: " .. tostring(payload.newParent) } end
    return withRecording("MCP move_instance", function()
        inst.Parent = newParent
        return { ok = true, newPath = inst:GetFullName() }
    end)
end

-- ---------------------------------------------------------------------------
-- duplicate_instance: clone an Instance (incl. all descendants), optionally
-- reparent + rename + offset position. Great for laying out repeated parts.
-- ---------------------------------------------------------------------------

handlers.duplicate_instance = function(payload)
    local src = resolvePath(payload.path)
    if not src then return { error = "path not found: " .. tostring(payload.path) } end
    if not src.Archivable then
        return { error = `cannot clone {src:GetFullName()}: Archivable is false` }
    end

    local parent
    if payload.parent then
        parent = resolvePath(payload.parent)
        if not parent then return { error = "parent not found: " .. tostring(payload.parent) } end
    else
        parent = src.Parent
    end

    return withRecording("MCP duplicate_instance", function()
        local copy = src:Clone()
        if payload.name then copy.Name = payload.name end

        -- Optional position offset (Vector3 list [dx,dy,dz]) on the clone's pivot.
        if typeof(payload.offset) == "table" and #payload.offset == 3 then
            local dx, dy, dz = payload.offset[1], payload.offset[2], payload.offset[3]
            local offsetCFrame = CFrame.new(dx, dy, dz)
            if copy:IsA("BasePart") then
                copy.CFrame = copy.CFrame * offsetCFrame
            elseif copy:IsA("Model") then
                local ok = pcall(function() copy:PivotTo(copy:GetPivot() * offsetCFrame) end)
                if not ok then
                    -- Fallback: move PrimaryPart if it exists
                    local pp = copy.PrimaryPart
                    if pp then pp.CFrame = pp.CFrame * offsetCFrame end
                end
            end
        end

        copy.Parent = parent
        return { ok = true, fullName = copy:GetFullName(), className = copy.ClassName }
    end)
end

-- ---------------------------------------------------------------------------
-- set_camera: move the Edit-mode camera. Three ways to specify:
--   • position + look_at  (explicit Vector3 lists)
--   • preset + target_path + distance  (e.g. "top" view of a Model)
--   • preset alone (rotates around current focus or origin)
-- ---------------------------------------------------------------------------

local CAMERA_DIRS = {
    top       = Vector3.new(0,  1,  0),
    bottom    = Vector3.new(0, -1,  0),
    front     = Vector3.new(0,  0,  1),
    back      = Vector3.new(0,  0, -1),
    left      = Vector3.new(-1, 0,  0),
    right     = Vector3.new(1,  0,  0),
    isometric = Vector3.new(1,  1,  1).Unit,
}

local function vec3FromList(t: any): Vector3?
    if typeof(t) == "table" and #t == 3 then
        return Vector3.new(tonumber(t[1]) or 0, tonumber(t[2]) or 0, tonumber(t[3]) or 0)
    end
    return nil
end

local function modelBoundingRadius(inst: Instance): number
    if inst:IsA("BasePart") then
        return inst.Size.Magnitude * 0.5
    elseif inst:IsA("Model") then
        local ok, _, size = pcall(function() return inst:GetBoundingBox() end)
        if ok and typeof(size) == "Vector3" then return size.Magnitude * 0.5 end
    end
    return 10
end

-- Compute (center, radius) for ANY container by walking descendant BaseParts.
-- Used when target_path resolves to a Folder/Configuration (no Pivot).
local function descendantBounds(root: Instance): (Vector3?, number)
    local minX, minY, minZ =  math.huge,  math.huge,  math.huge
    local maxX, maxY, maxZ = -math.huge, -math.huge, -math.huge
    local found = false
    for _, d in ipairs(root:GetDescendants()) do
        if d:IsA("BasePart") then
            found = true
            local p = d.Position
            local s = d.Size * 0.5
            if (p.X - s.X) < minX then minX = p.X - s.X end
            if (p.Y - s.Y) < minY then minY = p.Y - s.Y end
            if (p.Z - s.Z) < minZ then minZ = p.Z - s.Z end
            if (p.X + s.X) > maxX then maxX = p.X + s.X end
            if (p.Y + s.Y) > maxY then maxY = p.Y + s.Y end
            if (p.Z + s.Z) > maxZ then maxZ = p.Z + s.Z end
        end
    end
    if not found then return nil, 0 end
    local center = Vector3.new((minX+maxX)*0.5, (minY+maxY)*0.5, (minZ+maxZ)*0.5)
    local size   = Vector3.new(maxX-minX, maxY-minY, maxZ-minZ)
    return center, size.Magnitude * 0.5
end

handlers.set_camera = function(payload)
    local cam = workspace.CurrentCamera
    if not cam then return { error = "no CurrentCamera in workspace" } end

    -- Explicit position + look_at takes priority.
    local pos = vec3FromList(payload.position)
    local look = vec3FromList(payload.look_at)

    -- Preset path: compute pos/look from preset + target.
    if payload.preset and CAMERA_DIRS[payload.preset] then
        local dir = CAMERA_DIRS[payload.preset]
        local target: Vector3? = look
        local radius = tonumber(payload.distance)

        if payload.target_path then
            local t = resolvePath(payload.target_path)
            if t then
                if t:IsA("BasePart") then
                    target = t.Position
                    radius = radius or t.Size.Magnitude * 1.6
                elseif t:IsA("Model") then
                    target = t:GetPivot().Position
                    radius = radius or modelBoundingRadius(t) * 2.5
                else
                    -- Folder / Configuration / anything else: walk descendants
                    local c, r = descendantBounds(t)
                    if c then
                        target = c
                        radius = radius or (r * 2.0 + 10)
                    end
                end
            end
        end

        target = target or Vector3.new(0, 0, 0)
        radius = radius or 50
        pos = target + dir * radius
        look = target
    end

    if not pos or not look then
        return { error = "set_camera needs either {position, look_at} or {preset, target_path}" }
    end

    cam.CFrame = CFrame.new(pos, look)
    return {
        ok = true,
        position = { pos.X, pos.Y, pos.Z },
        look_at = { look.X, look.Y, look.Z },
    }
end

-- ---------------------------------------------------------------------------
-- select_instance: highlight in Studio Explorer/3D selection
-- Accepts a single path or a list. Optional `focus = true` zooms camera.
-- ---------------------------------------------------------------------------

handlers.select_instance = function(payload)
    local Selection = game:GetService("Selection")
    local pathsArg = payload.paths
    if type(pathsArg) == "string" then pathsArg = { pathsArg } end
    if type(pathsArg) ~= "table" then
        return { error = "select_instance needs `paths` (string or list of strings)" }
    end

    local found, missing = {}, {}
    for _, p in ipairs(pathsArg) do
        local inst = resolvePath(p)
        if inst then table.insert(found, inst) else table.insert(missing, p) end
    end

    Selection:Set(found)

    -- Optional focus: ask the Camera to look at the first selection.
    if payload.focus and #found > 0 and workspace.CurrentCamera then
        local target = found[1]
        local pivot
        if target:IsA("BasePart") then pivot = target.Position
        elseif target:IsA("Model") then pivot = target:GetPivot().Position
        end
        if pivot then
            local radius = modelBoundingRadius(target) * 2.2 + 10
            local dir = Vector3.new(1, 0.8, 1).Unit
            workspace.CurrentCamera.CFrame = CFrame.new(pivot + dir * radius, pivot)
        end
    end

    return { selected = #found, missing = missing }
end

-- ---------------------------------------------------------------------------
-- CollectionService tagging
-- ---------------------------------------------------------------------------

handlers.apply_tag = function(payload)
    local CollectionService = game:GetService("CollectionService")
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    local tag = tostring(payload.tag or "")
    if tag == "" then return { error = "missing `tag`" } end

    return withRecording("MCP apply_tag", function()
        if payload.remove then
            CollectionService:RemoveTag(inst, tag)
            return { ok = true, removed = tag, path = inst:GetFullName() }
        end
        CollectionService:AddTag(inst, tag)
        return { ok = true, added = tag, path = inst:GetFullName() }
    end)
end

-- ---------------------------------------------------------------------------
-- get_bounds: real spatial extent of ANY instance (Part / Model / Folder / etc)
-- Returns min/max/center/size/radius — so the AI can reason about edges and
-- gaps, not just center positions.
-- ---------------------------------------------------------------------------

handlers.get_bounds = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end

    local min: Vector3?, max: Vector3?
    local partCount = 0

    if inst:IsA("BasePart") then
        local p, s = inst.Position, inst.Size * 0.5
        min = p - s
        max = p + s
        partCount = 1
    elseif inst:IsA("Model") then
        local ok, cf, size = pcall(function() return inst:GetBoundingBox() end)
        if ok and typeof(size) == "Vector3" then
            min = cf.Position - size * 0.5
            max = cf.Position + size * 0.5
        end
        for _, d in ipairs(inst:GetDescendants()) do
            if d:IsA("BasePart") then partCount += 1 end
        end
    else
        -- Folder / Configuration / etc: walk descendants
        local minX, minY, minZ =  math.huge,  math.huge,  math.huge
        local maxX, maxY, maxZ = -math.huge, -math.huge, -math.huge
        for _, d in ipairs(inst:GetDescendants()) do
            if d:IsA("BasePart") then
                partCount += 1
                local p, s = d.Position, d.Size * 0.5
                if (p.X - s.X) < minX then minX = p.X - s.X end
                if (p.Y - s.Y) < minY then minY = p.Y - s.Y end
                if (p.Z - s.Z) < minZ then minZ = p.Z - s.Z end
                if (p.X + s.X) > maxX then maxX = p.X + s.X end
                if (p.Y + s.Y) > maxY then maxY = p.Y + s.Y end
                if (p.Z + s.Z) > maxZ then maxZ = p.Z + s.Z end
            end
        end
        if partCount > 0 then
            min = Vector3.new(minX, minY, minZ)
            max = Vector3.new(maxX, maxY, maxZ)
        end
    end

    if not min or not max then
        return { error = `no BaseParts found under {inst:GetFullName()}` }
    end

    local size   = max - min
    local center = min + size * 0.5
    local radius = size.Magnitude * 0.5
    return {
        path        = inst:GetFullName(),
        className   = inst.ClassName,
        partCount   = partCount,
        min         = { min.X, min.Y, min.Z },
        max         = { max.X, max.Y, max.Z },
        center      = { center.X, center.Y, center.Z },
        size        = { size.X, size.Y, size.Z },
        radius      = radius,
        -- Convenient edge helpers (z+ = "north" / forward):
        north_edge  = max.Z,  -- highest z
        south_edge  = min.Z,
        east_edge   = max.X,
        west_edge   = min.X,
        top_edge    = max.Y,  -- highest y
        bottom_edge = min.Y,
    }
end

-- ---------------------------------------------------------------------------
-- Helpers for spatial tools
-- ---------------------------------------------------------------------------

local function vec3FromList3(t: any, default: Vector3?): Vector3?
    if typeof(t) == "table" and #t == 3 then
        return Vector3.new(tonumber(t[1]) or 0, tonumber(t[2]) or 0, tonumber(t[3]) or 0)
    end
    return default
end

local function pathFromList(list: any): { Instance }
    local out = {}
    if typeof(list) == "table" then
        for _, p in ipairs(list) do
            local inst = resolvePath(tostring(p))
            if inst then table.insert(out, inst) end
        end
    end
    return out
end

local function serializeVec(v: Vector3): { number }
    return { v.X, v.Y, v.Z }
end

-- ---------------------------------------------------------------------------
-- raycast: shoot a ray, return what it hit
-- ---------------------------------------------------------------------------

handlers.raycast = function(payload)
    local from = vec3FromList3(payload.from)
    local to   = vec3FromList3(payload.to)
    if not from then return { error = "missing `from` [x,y,z]" } end

    local direction: Vector3
    if to then
        direction = to - from
    else
        local dir = vec3FromList3(payload.direction)
        local distance = tonumber(payload.distance) or 100
        if not dir then return { error = "need either `to` or `direction` [+ distance]" } end
        direction = dir.Unit * distance
    end

    local params = RaycastParams.new()
    local mode = tostring(payload.filter_mode or "exclude"):lower()
    if mode == "include" then
        params.FilterType = Enum.RaycastFilterType.Include
    else
        params.FilterType = Enum.RaycastFilterType.Exclude
    end
    params.FilterDescendantsInstances = pathFromList(payload.filter)
    params.IgnoreWater = payload.ignore_water == true

    local result = workspace:Raycast(from, direction, params)
    if not result then
        return { hit = false, from = serializeVec(from), direction = serializeVec(direction) }
    end
    return {
        hit       = true,
        path      = result.Instance and result.Instance:GetFullName() or nil,
        className = result.Instance and result.Instance.ClassName or nil,
        position  = serializeVec(result.Position),
        normal    = serializeVec(result.Normal),
        distance  = result.Distance,
        material  = result.Material and result.Material.Name or nil,
    }
end

-- ---------------------------------------------------------------------------
-- get_parts_in_region: spatial query (box or sphere)
-- ---------------------------------------------------------------------------

handlers.get_parts_in_region = function(payload)
    local params = OverlapParams.new()
    local mode = tostring(payload.filter_mode or "exclude"):lower()
    params.FilterType = (mode == "include") and Enum.RaycastFilterType.Include or Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = pathFromList(payload.filter)
    params.MaxParts = tonumber(payload.max_parts) or 200

    local parts: { BasePart }
    if payload.center and payload.radius then
        local c = vec3FromList3(payload.center)
        local r = tonumber(payload.radius)
        if not c or not r then return { error = "bad center/radius" } end
        parts = workspace:GetPartBoundsInRadius(c, r, params)
    elseif payload.min and payload.max then
        local mn = vec3FromList3(payload.min)
        local mx = vec3FromList3(payload.max)
        if not mn or not mx then return { error = "bad min/max" } end
        local center = (mn + mx) * 0.5
        local size = mx - mn
        parts = workspace:GetPartBoundsInBox(CFrame.new(center), size, params)
    else
        return { error = "need either {center, radius} or {min, max}" }
    end

    local results = {}
    for _, p in ipairs(parts) do
        table.insert(results, {
            path = p:GetFullName(),
            className = p.ClassName,
            name = p.Name,
            position = serializeVec(p.Position),
            size = serializeVec(p.Size),
        })
    end
    return { count = #results, results = results }
end

-- ---------------------------------------------------------------------------
-- find_path: PathfindingService → list of waypoints + status
-- ---------------------------------------------------------------------------

handlers.find_path = function(payload)
    local PathfindingService = game:GetService("PathfindingService")
    local start = vec3FromList3(payload.start)
    local goal  = vec3FromList3(payload.goal)
    if not start or not goal then return { error = "need `start` and `goal` as [x,y,z]" } end

    local agent = payload.agent or {}
    local path = PathfindingService:CreatePath({
        AgentRadius     = tonumber(agent.radius)     or 2,
        AgentHeight     = tonumber(agent.height)     or 5,
        AgentCanJump    = agent.can_jump ~= false,
        AgentJumpHeight = tonumber(agent.jump_height) or 7.2,
        AgentMaxSlope   = tonumber(agent.max_slope)  or 45,
        WaypointSpacing = tonumber(agent.waypoint_spacing) or math.huge,
    })

    local ok, err = pcall(function() path:ComputeAsync(start, goal) end)
    if not ok then return { error = "ComputeAsync failed: " .. tostring(err) } end

    local statusName = path.Status.Name
    local waypoints = path:GetWaypoints()
    local serial = {}
    for _, wp in ipairs(waypoints) do
        table.insert(serial, {
            position = serializeVec(wp.Position),
            action   = wp.Action.Name, -- "Walk" | "Jump" | "Custom"
        })
    end
    return {
        status = statusName, -- "Success" | "NoPath" | "ClosestNoPath" | "ClosestOutOfRange"
        success = (statusName == "Success"),
        count = #serial,
        waypoints = serial,
    }
end

-- ---------------------------------------------------------------------------
-- npc_walk_path: REQUIRES play mode. Spawn an R15 dummy, drive it via
-- Humanoid:MoveTo along PathfindingService waypoints, return outcome.
-- Use inside run_script_in_play_mode or call directly during Play.
-- ---------------------------------------------------------------------------

handlers.npc_walk_path = function(payload)
    if not RunService:IsRunning() then
        return { error = "npc_walk_path requires Play/Run mode. Wrap in run_script_in_play_mode." }
    end

    local PathfindingService = game:GetService("PathfindingService")
    local start = vec3FromList3(payload.start)
    local goal  = vec3FromList3(payload.goal)
    if not start or not goal then return { error = "need `start` and `goal`" } end

    -- Build a simple R6-ish dummy (works without rig assets)
    local hrp = Instance.new("Part")
    hrp.Name = "HumanoidRootPart"; hrp.Size = Vector3.new(2,2,1); hrp.Transparency = 1
    hrp.TopSurface = Enum.SurfaceType.Smooth; hrp.BottomSurface = Enum.SurfaceType.Smooth
    hrp.Position = start + Vector3.new(0, 3, 0)
    local torso = Instance.new("Part")
    torso.Name = "Torso"; torso.Size = Vector3.new(2,2,1); torso.Color = Color3.fromRGB(0,140,255)
    torso.Position = hrp.Position
    local weld = Instance.new("Weld"); weld.Part0 = hrp; weld.Part1 = torso; weld.Parent = hrp
    local head = Instance.new("Part")
    head.Name = "Head"; head.Size = Vector3.new(2,1,1); head.Shape = Enum.PartType.Ball
    head.Position = hrp.Position + Vector3.new(0,1.5,0); head.Color = Color3.fromRGB(255,200,100)
    local weld2 = Instance.new("Weld"); weld2.Part0 = hrp; weld2.Part1 = head
    weld2.C1 = CFrame.new(0, -1.5, 0); weld2.Parent = hrp
    local hum = Instance.new("Humanoid"); hum.RigType = Enum.HumanoidRigType.R6

    local dummy = Instance.new("Model"); dummy.Name = "MCP_NPC"
    hrp.Parent = dummy; torso.Parent = dummy; head.Parent = dummy; hum.Parent = dummy
    dummy.PrimaryPart = hrp
    dummy.Parent = workspace

    local path = PathfindingService:CreatePath({
        AgentRadius  = tonumber(payload.radius)  or 2,
        AgentHeight  = tonumber(payload.height)  or 5,
        AgentCanJump = true,
        AgentJumpHeight = 7.2,
    })

    local computeOk = pcall(function() path:ComputeAsync(start + Vector3.new(0,3,0), goal) end)
    if not computeOk or path.Status ~= Enum.PathStatus.Success then
        local status = path.Status.Name
        dummy:Destroy()
        return { error = `path compute failed: {status}` }
    end

    local waypoints = path:GetWaypoints()
    local totalTimeout = tonumber(payload.timeout) or 30
    local startedAt = os.clock()
    local reached = false
    local lastWp = nil

    for i, wp in ipairs(waypoints) do
        if (os.clock() - startedAt) > totalTimeout then break end
        if wp.Action == Enum.PathWaypointAction.Jump then
            hum.Jump = true
        end
        hum:MoveTo(wp.Position)
        local done = hum.MoveToFinished:Wait()
        lastWp = i
        if not done then break end
    end

    if hum and (hum.RootPart.Position - goal).Magnitude < 6 then
        reached = true
    end
    local finalPos = hrp.Position
    dummy:Destroy()

    return {
        reached = reached,
        waypoints_total = #waypoints,
        waypoints_reached = lastWp or 0,
        final_position = serializeVec(finalPos),
        duration = os.clock() - startedAt,
    }
end

-- ---------------------------------------------------------------------------
-- drop_to_ground: raycast down from a part's center → snap to whatever's below
-- ---------------------------------------------------------------------------

handlers.drop_to_ground = function(payload)
    local inst = resolvePath(payload.path)
    if not inst or not inst:IsA("BasePart") then
        return { error = "path must point to a BasePart: " .. tostring(payload.path) }
    end
    local maxDrop = tonumber(payload.max_drop) or 500
    local params = RaycastParams.new()
    params.FilterType = Enum.RaycastFilterType.Exclude
    params.FilterDescendantsInstances = { inst }

    local origin = inst.Position
    local result = workspace:Raycast(origin, Vector3.new(0, -maxDrop, 0), params)
    if not result then return { error = "no ground under part within " .. maxDrop .. " studs" } end

    return withRecording("MCP drop_to_ground", function()
        local landY = result.Position.Y + inst.Size.Y * 0.5
        inst.Position = Vector3.new(origin.X, landY, origin.Z)
        return {
            ok = true,
            dropped = origin.Y - landY,
            landed_on = result.Instance and result.Instance:GetFullName() or nil,
        }
    end)
end

-- ---------------------------------------------------------------------------
-- align_to: snap one part's edge flush with another's edge on a given axis
-- side: "+x" | "-x" | "+y" | "-y" | "+z" | "-z" — which side of target to attach to
-- ---------------------------------------------------------------------------

local function partBounds(inst: Instance): (Vector3, Vector3, Vector3)
    if inst:IsA("BasePart") then
        return inst.Position - inst.Size * 0.5, inst.Position + inst.Size * 0.5, inst.Size
    end
    -- Model / Folder: use descendantBounds
    local c, _ = descendantBounds(inst)
    local minX, minY, minZ =  math.huge,  math.huge,  math.huge
    local maxX, maxY, maxZ = -math.huge, -math.huge, -math.huge
    for _, d in ipairs(inst:GetDescendants()) do
        if d:IsA("BasePart") then
            local p, s = d.Position, d.Size * 0.5
            if (p.X - s.X) < minX then minX = p.X - s.X end
            if (p.Y - s.Y) < minY then minY = p.Y - s.Y end
            if (p.Z - s.Z) < minZ then minZ = p.Z - s.Z end
            if (p.X + s.X) > maxX then maxX = p.X + s.X end
            if (p.Y + s.Y) > maxY then maxY = p.Y + s.Y end
            if (p.Z + s.Z) > maxZ then maxZ = p.Z + s.Z end
        end
    end
    local mn = Vector3.new(minX, minY, minZ)
    local mx = Vector3.new(maxX, maxY, maxZ)
    return mn, mx, mx - mn
end

handlers.align_to = function(payload)
    local src = resolvePath(payload.source)
    local tgt = resolvePath(payload.target)
    if not src or not src:IsA("BasePart") then
        return { error = "source must be a BasePart: " .. tostring(payload.source) }
    end
    if not tgt then return { error = "target not found: " .. tostring(payload.target) } end

    local side = tostring(payload.side or "+z"):lower()
    local gap = tonumber(payload.gap) or 0

    local tMin, tMax, _ = partBounds(tgt)
    local sSize = src.Size

    return withRecording("MCP align_to", function()
        local newPos = src.Position
        local cx = (tMin.X + tMax.X) * 0.5
        local cy = (tMin.Y + tMax.Y) * 0.5
        local cz = (tMin.Z + tMax.Z) * 0.5
        if side == "+x" then
            newPos = Vector3.new(tMax.X + gap + sSize.X * 0.5, cy, cz)
        elseif side == "-x" then
            newPos = Vector3.new(tMin.X - gap - sSize.X * 0.5, cy, cz)
        elseif side == "+y" then
            newPos = Vector3.new(cx, tMax.Y + gap + sSize.Y * 0.5, cz)
        elseif side == "-y" then
            newPos = Vector3.new(cx, tMin.Y - gap - sSize.Y * 0.5, cz)
        elseif side == "+z" then
            newPos = Vector3.new(cx, cy, tMax.Z + gap + sSize.Z * 0.5)
        elseif side == "-z" then
            newPos = Vector3.new(cx, cy, tMin.Z - gap - sSize.Z * 0.5)
        else
            error(`invalid side: {side}. Use +x/-x/+y/-y/+z/-z`)
        end
        src.Position = newPos
        return { ok = true, new_position = serializeVec(newPos) }
    end)
end

-- ---------------------------------------------------------------------------
-- create_parts: batch create many parts in one round-trip
-- ---------------------------------------------------------------------------

handlers.create_parts = function(payload)
    local list = payload.parts
    if typeof(list) ~= "table" then return { error = "`parts` must be a list" } end

    return withRecording("MCP create_parts", function()
        local created = {}
        for i, def in ipairs(list) do
            local parent = resolvePath(def.parent or "Workspace")
            if not parent then
                table.insert(created, { error = `[#{i}] parent not found: {def.parent}` })
            else
                local p = Instance.new("Part")
                p.Anchored = def.anchored ~= false
                p.Name = def.name or `Part_{i}`
                if def.position then
                    p.Position = Vector3.new(def.position[1], def.position[2], def.position[3])
                end
                if def.size then
                    p.Size = Vector3.new(def.size[1], def.size[2], def.size[3])
                end
                if def.color then
                    p.Color = Color3.new(def.color[1], def.color[2], def.color[3])
                end
                if def.material then
                    local ok, mat = pcall(function() return Enum.Material[def.material] end)
                    if ok then p.Material = mat end
                end
                if def.transparency then p.Transparency = def.transparency end
                if def.can_collide ~= nil then p.CanCollide = def.can_collide end
                p.Parent = parent
                table.insert(created, { fullName = p:GetFullName(), name = p.Name })
            end
        end
        return { ok = true, count = #created, created = created }
    end)
end

-- ---------------------------------------------------------------------------
-- fill_terrain: TerrainService — fill a box/sphere with any material
-- Use material="Air" to dig.
-- ---------------------------------------------------------------------------

handlers.fill_terrain = function(payload)
    local Terrain = workspace.Terrain
    local matName = tostring(payload.material or "Grass")
    local ok, mat = pcall(function() return Enum.Material[matName] end)
    if not ok then return { error = "unknown material: " .. matName } end

    return withRecording("MCP fill_terrain", function()
        if payload.shape == "ball" or (payload.center and payload.radius) then
            local c = vec3FromList3(payload.center)
            local r = tonumber(payload.radius)
            if not c or not r then return { error = "ball needs {center, radius}" } end
            Terrain:FillBall(c, r, mat)
            return { ok = true, shape = "ball", center = serializeVec(c), radius = r, material = matName }
        elseif payload.min and payload.max then
            local mn = vec3FromList3(payload.min)
            local mx = vec3FromList3(payload.max)
            if not mn or not mx then return { error = "bad min/max" } end
            local center = (mn + mx) * 0.5
            local size = mx - mn
            Terrain:FillBlock(CFrame.new(center), size, mat)
            return { ok = true, shape = "block", center = serializeVec(center), size = serializeVec(size), material = matName }
        else
            return { error = "need {min,max} or {center,radius}" }
        end
    end)
end

-- ---------------------------------------------------------------------------
-- set_lighting: apply Lighting properties (presets or raw props)
-- ---------------------------------------------------------------------------

local LIGHT_PRESETS = {
    day      = { TimeOfDay = "12:00:00", Ambient = Color3.fromRGB(60,60,60),  FogEnd = 100000 },
    dawn     = { TimeOfDay = "06:00:00", Ambient = Color3.fromRGB(80,60,80) },
    sunset   = { TimeOfDay = "18:00:00", Ambient = Color3.fromRGB(120,80,60) },
    night    = { TimeOfDay = "00:00:00", Ambient = Color3.fromRGB(20,20,40), Brightness = 1 },
    foggy    = { FogEnd = 200, FogStart = 10, FogColor = Color3.fromRGB(180,180,180) },
    horror   = { TimeOfDay = "01:00:00", Ambient = Color3.fromRGB(10,10,10), FogEnd = 80, FogColor = Color3.fromRGB(0,0,0) },
    bright   = { Brightness = 3, Ambient = Color3.fromRGB(180,180,180) },
}

handlers.set_lighting = function(payload)
    local Lighting = game:GetService("Lighting")
    return withRecording("MCP set_lighting", function()
        local applied = {}
        if payload.preset and LIGHT_PRESETS[payload.preset] then
            for k, v in pairs(LIGHT_PRESETS[payload.preset]) do
                pcall(function() Lighting[k] = v; applied[k] = tostring(v) end)
            end
        end
        if typeof(payload.properties) == "table" then
            for k, v in pairs(payload.properties) do
                pcall(function()
                    if typeof(v) == "table" and #v == 3 then
                        Lighting[k] = Color3.new(v[1], v[2], v[3])
                    else
                        Lighting[k] = v
                    end
                    applied[k] = tostring(Lighting[k])
                end)
            end
        end
        return { ok = true, applied = applied }
    end)
end

-- ---------------------------------------------------------------------------
-- workspace_overview: high-level summary of the project
-- ---------------------------------------------------------------------------

handlers.workspace_overview = function(payload)
    local function countBy(parent: Instance): { [string]: number }
        local counts = { Parts = 0, Models = 0, Scripts = 0, LocalScripts = 0, ModuleScripts = 0, ScreenGuis = 0, Folders = 0 }
        for _, d in ipairs(parent:GetDescendants()) do
            if d:IsA("BasePart") then counts.Parts += 1
            elseif d:IsA("Model") then counts.Models += 1
            elseif d:IsA("Script") then counts.Scripts += 1
            elseif d:IsA("LocalScript") then counts.LocalScripts += 1
            elseif d:IsA("ModuleScript") then counts.ModuleScripts += 1
            elseif d:IsA("ScreenGui") then counts.ScreenGuis += 1
            elseif d:IsA("Folder") then counts.Folders += 1 end
        end
        return counts
    end

    local function topLevel(parent: Instance): { { name: string, className: string, childCount: number } }
        local out = {}
        for _, c in ipairs(parent:GetChildren()) do
            table.insert(out, { name = c.Name, className = c.ClassName, childCount = #c:GetChildren() })
        end
        return out
    end

    local CollectionService = game:GetService("CollectionService")
    local tagCounts = {}
    for _, tag in ipairs(CollectionService:GetAllTags()) do
        tagCounts[tag] = #CollectionService:GetTagged(tag)
    end

    local function bundle(svc: Instance): { counts: any, children: any }
        return { counts = countBy(svc), children = topLevel(svc) }
    end

    return {
        workspace = {
            counts = countBy(workspace),
            children = topLevel(workspace),
        },
        serverScriptService  = bundle(game:GetService("ServerScriptService")),
        serverStorage        = bundle(game:GetService("ServerStorage")),
        starterGui           = bundle(game:GetService("StarterGui")),
        replicatedStorage    = bundle(game:GetService("ReplicatedStorage")),
        starterPlayer        = bundle(game:GetService("StarterPlayer")),
        starterPack          = bundle(game:GetService("StarterPack")),
        tags = tagCounts,
        studio_mode = {
            isRunning = RunService:IsRunning(),
            isEdit = RunService:IsEdit(),
        },
    }
end

-- ---------------------------------------------------------------------------
-- add_marker: visual debug marker (Highlight + BillboardGui label)
-- ---------------------------------------------------------------------------

handlers.add_marker = function(payload)
    return withRecording("MCP add_marker", function()
        local MARKER_FOLDER_NAME = "__MCP_Markers"
        local folder = workspace:FindFirstChild(MARKER_FOLDER_NAME)
        if not folder then
            folder = Instance.new("Folder")
            folder.Name = MARKER_FOLDER_NAME
            folder.Parent = workspace
        end

        if payload.clear then
            folder:ClearAllChildren()
            return { ok = true, cleared = true }
        end

        local label = tostring(payload.label or "Marker")
        local color = payload.color and Color3.new(payload.color[1], payload.color[2], payload.color[3])
                                     or Color3.fromRGB(255, 100, 0)

        local anchor = Instance.new("Part")
        anchor.Name = "Marker_" .. label
        anchor.Anchored = true
        anchor.CanCollide = false
        anchor.CanQuery = false
        anchor.Transparency = 0.5
        anchor.Color = color
        anchor.Material = Enum.Material.Neon
        anchor.Size = Vector3.new(1.5, 1.5, 1.5)
        anchor.Shape = Enum.PartType.Ball
        if payload.position then
            anchor.Position = Vector3.new(payload.position[1], payload.position[2], payload.position[3])
        elseif payload.attach_path then
            local t = resolvePath(payload.attach_path)
            if t and t:IsA("BasePart") then
                anchor.Position = t.Position + Vector3.new(0, t.Size.Y * 0.5 + 3, 0)
            end
        end
        anchor.Parent = folder

        local bb = Instance.new("BillboardGui")
        bb.Size = UDim2.fromScale(8, 2)
        bb.AlwaysOnTop = true
        bb.StudsOffset = Vector3.new(0, 2, 0)
        bb.Parent = anchor
        local tl = Instance.new("TextLabel")
        tl.Size = UDim2.fromScale(1, 1)
        tl.BackgroundTransparency = 0.3
        tl.BackgroundColor3 = Color3.new(0, 0, 0)
        tl.Text = label
        tl.TextColor3 = Color3.new(1, 1, 1)
        tl.TextScaled = true
        tl.Font = Enum.Font.GothamBold
        tl.Parent = bb

        return { ok = true, fullName = anchor:GetFullName(), label = label }
    end)
end

-- ---------------------------------------------------------------------------
-- snapshot_camera / restore_camera: save and recall Camera CFrame
-- ---------------------------------------------------------------------------

local cameraSnapshots: { [string]: CFrame } = {}

-- Module-level EditableMesh batch sessions (Task 7).
local emSessions: { [string]: { em: any, vertMap: { [number]: number } } } = {}

handlers.snapshot_camera = function(payload)
    local cam = workspace.CurrentCamera
    if not cam then return { error = "no CurrentCamera" } end
    local name = tostring(payload.name or "default")
    cameraSnapshots[name] = cam.CFrame
    return { ok = true, name = name, position = serializeVec(cam.CFrame.Position) }
end

handlers.restore_camera = function(payload)
    local cam = workspace.CurrentCamera
    if not cam then return { error = "no CurrentCamera" } end
    local name = tostring(payload.name or "default")
    local cf = cameraSnapshots[name]
    if not cf then return { error = `no snapshot named "{name}"` } end
    cam.CFrame = cf
    return { ok = true, restored = name }
end

-- ---------------------------------------------------------------------------
-- get_asset_info: query MarketplaceService for asset metadata
-- ---------------------------------------------------------------------------

handlers.get_asset_info = function(payload)
    local id = tonumber(payload.asset_id)
    if not id then return { error = "asset_id must be a number" } end
    local MarketplaceService = game:GetService("MarketplaceService")
    local ok, info = pcall(function()
        return MarketplaceService:GetProductInfo(id, payload.info_type == "Bundle" and Enum.InfoType.Bundle or Enum.InfoType.Asset)
    end)
    if not ok then return { error = "GetProductInfo failed: " .. tostring(info) } end
    return {
        ok = true,
        id = id,
        name = info.Name,
        description = info.Description,
        creator = info.Creator and info.Creator.Name or nil,
        asset_type_id = info.AssetTypeId,
        icon_url = info.IconImageAssetId and `rbxassetid://{info.IconImageAssetId}` or nil,
        price = info.PriceInRobux,
        is_for_sale = info.IsForSale,
    }
end

-- ---------------------------------------------------------------------------
-- create_humanoid_model: spawn an avatar by userId as an NPC
-- ---------------------------------------------------------------------------

handlers.create_humanoid_model = function(payload)
    local Players = game:GetService("Players")
    local userId = tonumber(payload.user_id) or 1
    local parent = resolvePath(payload.parent or "Workspace")
    if not parent then return { error = "parent not found" } end

    return withRecording("MCP create_humanoid_model", function()
        local ok, model = pcall(function() return Players:CreateHumanoidModelFromUserId(userId) end)
        if not ok or not model then return { error = "CreateHumanoidModelFromUserId failed: " .. tostring(model) } end
        if payload.name then model.Name = payload.name end
        if payload.position then
            local p = Vector3.new(payload.position[1], payload.position[2], payload.position[3])
            local hrp = model:FindFirstChild("HumanoidRootPart")
            if hrp then hrp.Position = p end
        end
        model.Parent = parent
        return { ok = true, fullName = model:GetFullName(), userId = userId }
    end)
end

-- ---------------------------------------------------------------------------
-- humanoid_move: drive a Humanoid via :Move directly (no keyboard sim)
-- Works on player character (by name or first player) or any NPC by path.
-- Requires Play/Run mode.
-- ---------------------------------------------------------------------------

handlers.humanoid_move = function(payload)
    if not RunService:IsRunning() then
        return { error = "humanoid_move requires Play/Run mode" }
    end
    local Players = game:GetService("Players")
    local waitFor = tonumber(payload.wait_for_character) or 10

    -- Resolve a Player object (or nil for direct NPC path)
    local playerObj: Player?
    local target: Instance?
    if payload.path then
        target = resolvePath(payload.path)
    elseif payload.player then
        playerObj = Players:FindFirstChild(payload.player) :: Player?
    else
        playerObj = Players:GetPlayers()[1]
        -- If no player yet, wait up to waitFor seconds for one to join
        local deadline = os.clock() + waitFor
        while not playerObj and os.clock() < deadline do
            task.wait(0.2)
            playerObj = Players:GetPlayers()[1]
        end
    end

    -- If we have a Player, wait for their Character + Humanoid + HRP to exist
    if playerObj then
        local deadline = os.clock() + waitFor
        target = playerObj.Character
        while os.clock() < deadline do
            target = playerObj.Character
            if target then
                local h = target:FindFirstChildOfClass("Humanoid")
                local r = target:FindFirstChild("HumanoidRootPart")
                if h and r and h.Health > 0 then break end
            end
            task.wait(0.15)
        end
    end

    if not target then return { error = `no character after waiting {waitFor}s` } end
    local hum = target:FindFirstChildOfClass("Humanoid")
    if not hum then return { error = "no Humanoid under target" } end

    local dir = vec3FromList3(payload.direction)
    if not dir then return { error = "missing direction [x,y,z]" } end
    local duration = tonumber(payload.duration) or 1
    local jump = payload.jump == true

    -- Drive Move in world space (relativeToCamera = false)
    hum:Move(dir, false)
    if jump then hum.Jump = true end
    task.wait(duration)
    hum:Move(Vector3.zero, false)

    local hrp = target:FindFirstChild("HumanoidRootPart")
    return {
        ok = true,
        duration = duration,
        final_position = hrp and serializeVec(hrp.Position) or nil,
    }
end

-- ---------------------------------------------------------------------------
-- play_sound_preview: spin up a Sound and play it for N seconds (Edit/Play)
-- ---------------------------------------------------------------------------

handlers.play_sound_preview = function(payload)
    local id = tonumber(payload.sound_id)
    if not id then return { error = "sound_id required" } end
    local sound = Instance.new("Sound")
    sound.SoundId = `rbxassetid://{id}`
    sound.Volume = tonumber(payload.volume) or 0.5
    sound.Looped = false
    sound.Parent = workspace
    sound:Play()
    local duration = tonumber(payload.duration) or 3
    task.delay(duration, function() sound:Destroy() end)
    return { ok = true, sound_id = id, duration = duration }
end

-- ---------------------------------------------------------------------------
-- tween_property: animate any property via TweenService
-- ---------------------------------------------------------------------------

-- Smart coercion that inspects the property's CURRENT type and converts
-- the goal accordingly. Handles primitive types (number/bool) as well as
-- composite Roblox types (Vector3/Color3/UDim2/CFrame).
local function coerceToType(currentValue: any, raw: any): any
    local ct = typeof(currentValue)
    if ct == "number" then
        return tonumber(raw) or raw
    elseif ct == "boolean" then
        if typeof(raw) == "boolean" then return raw end
        if raw == "true" or raw == 1 then return true end
        if raw == "false" or raw == 0 then return false end
        return raw
    elseif ct == "Vector3" and typeof(raw) == "table" and #raw == 3 then
        return Vector3.new(raw[1], raw[2], raw[3])
    elseif ct == "Vector2" and typeof(raw) == "table" and #raw == 2 then
        return Vector2.new(raw[1], raw[2])
    elseif ct == "Color3" and typeof(raw) == "table" and #raw == 3 then
        return Color3.new(raw[1], raw[2], raw[3])
    elseif ct == "UDim2" and typeof(raw) == "table" and #raw == 4 then
        return UDim2.new(raw[1], raw[2], raw[3], raw[4])
    elseif ct == "UDim" and typeof(raw) == "table" and #raw == 2 then
        return UDim.new(raw[1], raw[2])
    elseif ct == "CFrame" and typeof(raw) == "table" and #raw >= 3 then
        if #raw == 3 then return CFrame.new(raw[1], raw[2], raw[3]) end
        if #raw == 12 then return CFrame.new(table.unpack(raw)) end
    elseif ct == "EnumItem" and typeof(raw) == "string" then
        -- Try to find matching enum value
        local enumType = currentValue.EnumType
        local ok, val = pcall(function() return enumType[raw] end)
        if ok and val then return val end
    elseif ct == "string" then
        return tostring(raw)
    end
    return raw
end

handlers.tween_property = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    local prop = payload.property
    if not prop then return { error = "property required" } end
    if payload.goal == nil then return { error = "goal required" } end

    -- Read current value to discover target type
    local okRead, current = pcall(function() return (inst :: any)[prop] end)
    if not okRead then return { error = `property "{prop}" does not exist on {inst.ClassName}` } end

    local TweenService = game:GetService("TweenService")
    local easingStyle = Enum.EasingStyle[payload.easing_style or "Quad"]
    local easingDir   = Enum.EasingDirection[payload.easing_direction or "Out"]
    local info = TweenInfo.new(
        tonumber(payload.duration) or 1,
        easingStyle, easingDir,
        tonumber(payload.repeat_count) or 0,
        payload.reverses == true,
        tonumber(payload.delay) or 0
    )

    local goal = coerceToType(current, payload.goal)

    local ok, err = pcall(function()
        local tw = TweenService:Create(inst, info, { [prop] = goal })
        tw:Play()
        if payload.wait then tw.Completed:Wait() end
    end)
    if not ok then
        return { error = tostring(err), current_type = typeof(current), goal_type = typeof(goal) }
    end
    return {
        ok = true, path = inst:GetFullName(), property = prop,
        from = tostring(current), to = tostring(goal),
    }
end

-- ---------------------------------------------------------------------------
-- tween_multi: tween N properties simultaneously on the same instance
-- ---------------------------------------------------------------------------

handlers.tween_multi = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    if typeof(payload.properties) ~= "table" then return { error = "properties dict required" } end

    local TweenService = game:GetService("TweenService")
    local easingStyle = Enum.EasingStyle[payload.easing_style or "Quad"]
    local easingDir   = Enum.EasingDirection[payload.easing_direction or "Out"]
    local info = TweenInfo.new(
        tonumber(payload.duration) or 1,
        easingStyle, easingDir,
        tonumber(payload.repeat_count) or 0,
        payload.reverses == true,
        tonumber(payload.delay) or 0
    )

    local goals: { [string]: any } = {}
    local coerced: { [string]: string } = {}
    local skipped: { [string]: string } = {}
    for prop, raw in pairs(payload.properties) do
        local okRead, current = pcall(function() return (inst :: any)[prop] end)
        if not okRead then
            skipped[prop] = `property does not exist on {inst.ClassName}`
        else
            local g = coerceToType(current, raw)
            goals[prop] = g
            coerced[prop] = typeof(g)
        end
    end

    if next(goals) == nil then
        return { error = "no valid properties to tween", skipped = skipped }
    end

    local ok, err = pcall(function()
        local tw = TweenService:Create(inst, info, goals)
        tw:Play()
        if payload.wait then tw.Completed:Wait() end
    end)
    if not ok then return { error = tostring(err), skipped = skipped } end
    return {
        ok = true, path = inst:GetFullName(),
        tweened = coerced, skipped = skipped,
    }
end

-- ---------------------------------------------------------------------------
-- add_highlight: outline a Part/Model with a Highlight that follows it
-- ---------------------------------------------------------------------------

local HIGHLIGHT_FOLDER_NAME = "__MCP_Highlights"

handlers.add_highlight = function(payload)
    return withRecording("MCP add_highlight", function()
        local folder = workspace:FindFirstChild(HIGHLIGHT_FOLDER_NAME)

        if payload.clear then
            if folder then folder:Destroy() end
            return { ok = true, cleared = true }
        end

        if not folder then
            folder = Instance.new("Folder")
            folder.Name = HIGHLIGHT_FOLDER_NAME
            folder.Parent = workspace
        end

        local target = resolvePath(payload.path)
        if not target then return { error = "path not found: " .. tostring(payload.path) } end

        local hl = Instance.new("Highlight")
        hl.Name = payload.name or "MCPHighlight"
        hl.Adornee = target
        hl.FillColor = (payload.fillColor and Color3.new(payload.fillColor[1] or 0, payload.fillColor[2] or 1, payload.fillColor[3] or 1)) or Color3.fromRGB(120, 220, 255)
        hl.OutlineColor = (payload.outlineColor and Color3.new(payload.outlineColor[1] or 0, payload.outlineColor[2] or 1, payload.outlineColor[3] or 1)) or Color3.fromRGB(0, 200, 255)
        hl.FillTransparency = tonumber(payload.fillTransparency) or 0.5
        hl.OutlineTransparency = tonumber(payload.outlineTransparency) or 0
        hl.Parent = folder

        return {
            ok = true,
            highlightPath = hl:GetFullName(),
            adorneePath = target:GetFullName(),
        }
    end)
end

-- ---------------------------------------------------------------------------
-- weld_parts: create WeldConstraint or Motor6D between two BaseParts
-- ---------------------------------------------------------------------------

handlers.weld_parts = function(payload)
    local a = resolvePath(payload.partA)
    if not a then return { error = "part_a not found: " .. tostring(payload.partA) } end
    if not a:IsA("BasePart") then return { error = "part_a must be a BasePart, got " .. a.ClassName } end
    local b = resolvePath(payload.partB)
    if not b then return { error = "part_b not found: " .. tostring(payload.partB) } end
    if not b:IsA("BasePart") then return { error = "part_b must be a BasePart, got " .. b.ClassName } end

    local constraintType = payload.type or "WeldConstraint"
    if constraintType ~= "WeldConstraint" and constraintType ~= "Motor6D" then
        return { error = "type must be 'WeldConstraint' or 'Motor6D'" }
    end

    return withRecording("MCP weld_parts", function()
        local c = Instance.new(constraintType)
        c.Name = payload.name or constraintType
        ;(c :: any).Part0 = a
        ;(c :: any).Part1 = b
        c.Parent = a
        return {
            ok = true,
            constraintPath = c:GetFullName(),
            type = constraintType,
            part0 = a:GetFullName(),
            part1 = b:GetFullName(),
        }
    end)
end

-- ---------------------------------------------------------------------------
-- Collision groups
-- ---------------------------------------------------------------------------

local function ensureCollisionGroup(name: string): boolean
    local PhysicsService = game:GetService("PhysicsService")
    -- IsCollisionGroupRegistered exists on modern API
    local ok, registered = pcall(function() return PhysicsService:IsCollisionGroupRegistered(name) end)
    if ok and registered then return true end
    local okReg = pcall(function() PhysicsService:RegisterCollisionGroup(name) end)
    return okReg
end

handlers.set_collision_group = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end
    if not payload.group or payload.group == "" then return { error = "group is required" } end

    if not ensureCollisionGroup(payload.group) then
        return { error = "could not register/find collision group: " .. tostring(payload.group) }
    end

    return withRecording("MCP set_collision_group", function()
        local applied = 0
        if inst:IsA("BasePart") then
            inst.CollisionGroup = payload.group
            applied = 1
        else
            for _, d in ipairs(inst:GetDescendants()) do
                if d:IsA("BasePart") then
                    d.CollisionGroup = payload.group
                    applied += 1
                end
            end
        end
        return { ok = true, group = payload.group, applied = applied, path = inst:GetFullName() }
    end)
end

handlers.set_collision_groups_collidable = function(payload)
    local PhysicsService = game:GetService("PhysicsService")
    local a, b = payload.groupA, payload.groupB
    if not a or not b then return { error = "group_a and group_b required" } end
    if payload.collidable == nil then return { error = "collidable bool required" } end

    if not ensureCollisionGroup(a) then return { error = "could not register group: " .. a } end
    if not ensureCollisionGroup(b) then return { error = "could not register group: " .. b } end

    local ok, err = pcall(function()
        PhysicsService:CollisionGroupSetCollidable(a, b, payload.collidable)
    end)
    if not ok then return { error = "CollisionGroupSetCollidable failed: " .. tostring(err) } end
    return { ok = true, groupA = a, groupB = b, collidable = payload.collidable }
end

-- ---------------------------------------------------------------------------
-- give_tool: clone a Tool into a player's Backpack or Character
-- ---------------------------------------------------------------------------

local function findPlayer(name: string?): Player?
    local Players = game:GetService("Players")
    local list = Players:GetPlayers()
    if #list == 0 then return nil end
    if not name or name == "" then return list[1] end
    -- exact match first
    for _, p in ipairs(list) do if p.Name == name then return p end end
    -- case-insensitive
    local lower = name:lower()
    for _, p in ipairs(list) do if p.Name:lower() == lower then return p end end
    return nil
end

handlers.give_tool = function(payload)
    local source = resolvePath(payload.toolPath)
    if not source then return { error = "tool_path not found: " .. tostring(payload.toolPath) } end
    if not source:IsA("Tool") then return { error = "tool_path must point to a Tool, got " .. source.ClassName } end

    local player = findPlayer(payload.playerName)
    if not player then
        return { error = `no player {payload.playerName and "named '" .. payload.playerName .. "'" or ""} — is Play mode running with at least one player?` }
    end

    local dest = payload.destination or "Backpack"
    return withRecording("MCP give_tool", function()
        local clone = source:Clone()
        if dest == "Character" then
            if not player.Character then return { error = "player has no character yet" } end
            clone.Parent = player.Character
        else
            local backpack = player:FindFirstChildOfClass("Backpack")
            if not backpack then return { error = "player has no Backpack" } end
            clone.Parent = backpack
        end
        return {
            ok = true,
            toolPath = clone:GetFullName(),
            player = player.Name,
            destination = dest,
        }
    end)
end

-- ---------------------------------------------------------------------------
-- fire_remote: invoke RemoteEvent / BindableEvent from plugin (server) context
-- ---------------------------------------------------------------------------

handlers.fire_remote = function(payload)
    local inst = resolvePath(payload.path)
    if not inst then return { error = "path not found: " .. tostring(payload.path) } end

    local args = payload.args or {}
    if typeof(args) ~= "table" then return { error = "args must be an array" } end

    if inst:IsA("RemoteEvent") then
        if payload.playerName and payload.playerName ~= "" then
            local player = findPlayer(payload.playerName)
            if not player then return { error = "player not found: " .. payload.playerName } end
            local ok, err = pcall(function() inst:FireClient(player, table.unpack(args)) end)
            if not ok then return { error = "FireClient failed: " .. tostring(err) } end
            return { ok = true, fired = "FireClient", target = player.Name, path = inst:GetFullName() }
        else
            local ok, err = pcall(function() inst:FireAllClients(table.unpack(args)) end)
            if not ok then return { error = "FireAllClients failed: " .. tostring(err) } end
            return { ok = true, fired = "FireAllClients", path = inst:GetFullName() }
        end
    elseif inst:IsA("BindableEvent") then
        local ok, err = pcall(function() inst:Fire(table.unpack(args)) end)
        if not ok then return { error = "Fire failed: " .. tostring(err) } end
        return { ok = true, fired = "Fire", path = inst:GetFullName() }
    else
        return { error = "path must be a RemoteEvent or BindableEvent, got " .. inst.ClassName }
    end
end

-- ---------------------------------------------------------------------------
-- Visual & sound polish
-- ---------------------------------------------------------------------------

handlers.play_sound_in_world = function(payload)
    local assetId = tonumber(payload.soundId)
    if not assetId then return { error = "sound_id required" } end
    local pos = payload.position
    if type(pos) ~= "table" or #pos < 3 then return { error = "position [x,y,z] required" } end

    local part = Instance.new("Part")
    part.Anchored = true
    part.CanCollide = false
    part.Transparency = 1
    part.Size = Vector3.new(0.1, 0.1, 0.1)
    part.Position = Vector3.new(pos[1], pos[2], pos[3])
    part.Name = "__MCP_SoundEmitter"

    local sound = Instance.new("Sound")
    sound.SoundId = `rbxassetid://{assetId}`
    sound.Volume = tonumber(payload.volume) or 1
    sound.RollOffMode = Enum.RollOffMode.Inverse
    sound.RollOffMinDistance = tonumber(payload.rollOffMin) or 10
    sound.RollOffMaxDistance = tonumber(payload.rollOffMax) or 100
    sound.Parent = part
    part.Parent = workspace

    local ok, err = pcall(function() sound:Play() end)
    if not ok then
        part:Destroy()
        return { error = "Sound:Play failed: " .. tostring(err) }
    end

    local duration = tonumber(payload.duration) or 5
    task.delay(duration, function()
        if part then pcall(function() part:Destroy() end) end
    end)

    return {
        ok = true,
        soundPath = sound:GetFullName(),
        position = { pos[1], pos[2], pos[3] },
        willCleanupAfterSeconds = duration,
    }
end

handlers.create_beam = function(payload)
    local a = resolvePath(payload.partA)
    if not a then return { error = "part_a not found: " .. tostring(payload.partA) } end
    if not a:IsA("BasePart") then return { error = "part_a must be a BasePart, got " .. a.ClassName } end
    local b = resolvePath(payload.partB)
    if not b then return { error = "part_b not found: " .. tostring(payload.partB) } end
    if not b:IsA("BasePart") then return { error = "part_b must be a BasePart, got " .. b.ClassName } end

    return withRecording("MCP create_beam", function()
        local att0 = Instance.new("Attachment")
        att0.Name = "BeamAtt0"
        att0.Parent = a
        local att1 = Instance.new("Attachment")
        att1.Name = "BeamAtt1"
        att1.Parent = b

        local beam = Instance.new("Beam")
        beam.Name = payload.name or "Beam"
        beam.Attachment0 = att0
        beam.Attachment1 = att1
        local w = tonumber(payload.width) or 1
        beam.Width0 = w
        beam.Width1 = w
        if type(payload.color) == "table" and #payload.color >= 3 then
            beam.Color = ColorSequence.new(Color3.new(payload.color[1], payload.color[2], payload.color[3]))
        end
        beam.Transparency = NumberSequence.new(tonumber(payload.transparency) or 0)
        beam.Parent = a

        return {
            ok = true,
            beamPath = beam:GetFullName(),
            attachment0Path = att0:GetFullName(),
            attachment1Path = att1:GetFullName(),
        }
    end)
end

handlers.create_particle_burst = function(payload)
    local target = resolvePath(payload.target)
    if not target then return { error = "target not found: " .. tostring(payload.target) } end

    local host: Instance
    local hostWasCreated = false
    if target:IsA("Attachment") then
        host = target
    elseif target:IsA("BasePart") then
        local att = Instance.new("Attachment")
        att.Name = "__MCP_ParticleAtt"
        att.Parent = target
        host = att
        hostWasCreated = true
    else
        return { error = "target must be a BasePart or Attachment, got " .. target.ClassName }
    end

    return withRecording("MCP create_particle_burst", function()
        local pe = Instance.new("ParticleEmitter")
        pe.Name = "MCPParticle"
        if payload.textureAssetId then
            pe.Texture = `rbxassetid://{payload.textureAssetId}`
        else
            pe.Texture = "rbxasset://textures/particles/sparkles_main.dds"
        end
        pe.Rate = tonumber(payload.rate) or 50
        pe.Lifetime = NumberRange.new(tonumber(payload.lifetime) or 1)
        pe.Speed = NumberRange.new(tonumber(payload.speed) or 5)
        if type(payload.color) == "table" and #payload.color >= 3 then
            pe.Color = ColorSequence.new(Color3.new(payload.color[1], payload.color[2], payload.color[3]))
        end
        pe.Parent = host

        local count = tonumber(payload.count) or 30
        local duration = tonumber(payload.duration) or 0.5
        local lifetime = tonumber(payload.lifetime) or 1
        local continuous = payload.continuous == true

        if continuous then
            -- Leave running until caller destroys it. No auto-cleanup.
            return {
                ok = true,
                emitterPath = pe:GetFullName(),
                hostPath = host:GetFullName(),
                mode = "continuous",
            }
        else
            -- One-shot: emit N particles, then destroy emitter after they're gone
            pcall(function() pe:Emit(count) end)
            task.delay(duration + lifetime, function()
                pcall(function() pe:Destroy() end)
                if hostWasCreated then pcall(function() host:Destroy() end) end
            end)
            return {
                ok = true,
                emitterPath = pe:GetFullName(),
                hostPath = host:GetFullName(),
                emitted = count,
                mode = "burst",
            }
        end
    end)
end

-- ---------------------------------------------------------------------------
-- Player state utilities (require Play mode)
-- ---------------------------------------------------------------------------

local function playerCharBundle(player: Player): { [string]: any }?
    local char = player.Character
    if not char then return nil end
    local humanoid = char:FindFirstChildOfClass("Humanoid")
    local hrp = char:FindFirstChild("HumanoidRootPart")
    local out: { [string]: any } = {
        characterPath = char:GetFullName(),
    }
    if humanoid then
        out.humanoid = {
            health = humanoid.Health,
            maxHealth = humanoid.MaxHealth,
            walkSpeed = humanoid.WalkSpeed,
            jumpPower = humanoid.JumpPower,
            state = humanoid:GetState().Name,
            isDead = humanoid.Health <= 0,
        }
    end
    if hrp and hrp:IsA("BasePart") then
        out.hrp = {
            position = serializeValue(hrp.Position),
            velocity = serializeValue(hrp.AssemblyLinearVelocity),
            cframe = serializeValue(hrp.CFrame),
        }
    end
    -- Leaderstats (if any)
    local stats = player:FindFirstChild("leaderstats")
    if stats then
        local ls: { [string]: any } = {}
        for _, v in ipairs(stats:GetChildren()) do
            local ok, val = pcall(function() return (v :: any).Value end)
            if ok then ls[v.Name] = val end
        end
        out.leaderstats = ls
    end
    return out
end

handlers.get_player_info = function(payload)
    local player = findPlayer(payload.playerName)
    if not player then
        return { exists = false, hint = "no player matched — is Play mode running with at least one player?" }
    end
    return {
        exists = true,
        name = player.Name,
        userId = player.UserId,
        team = player.Team and player.Team.Name or nil,
        character = playerCharBundle(player),
    }
end

handlers.set_humanoid = function(payload)
    local player = findPlayer(payload.playerName)
    if not player then return { error = "no player matched" } end
    local char = player.Character
    if not char then return { error = "player has no character (still spawning?)" } end
    local humanoid = char:FindFirstChildOfClass("Humanoid")
    if not humanoid then return { error = "character has no Humanoid" } end

    return withRecording("MCP set_humanoid", function()
        local applied: { [string]: string } = {}
        local skipped: { [string]: string } = {}
        for k, v in pairs(payload.props or {}) do
            local ok, err = pcall(function()
                local current = (humanoid :: any)[k]
                ;(humanoid :: any)[k] = coerceToType(current, v)
                applied[k] = tostring((humanoid :: any)[k])
            end)
            if not ok then skipped[k] = tostring(err) end
        end
        return { ok = true, player = player.Name, applied = applied, skipped = skipped }
    end)
end

handlers.teleport_player = function(payload)
    local player = findPlayer(payload.playerName)
    if not player then return { error = "no player matched" } end
    local char = player.Character
    if not char then return { error = "player has no character" } end
    local hrp = char:FindFirstChild("HumanoidRootPart")
    if not hrp or not hrp:IsA("BasePart") then return { error = "no HumanoidRootPart on character" } end

    local pos = payload.position
    if type(pos) ~= "table" or #pos < 3 then return { error = "position [x,y,z] required" } end
    local target = Vector3.new(pos[1], pos[2], pos[3])
    local cf: CFrame
    if type(payload.lookAt) == "table" and #payload.lookAt >= 3 then
        local look = Vector3.new(payload.lookAt[1], payload.lookAt[2], payload.lookAt[3])
        cf = CFrame.lookAt(target, look)
    else
        cf = CFrame.new(target) * (hrp.CFrame - hrp.Position)
    end

    return withRecording("MCP teleport_player", function()
        local ok, err = pcall(function() hrp.CFrame = cf end)
        if not ok then return { error = "teleport failed: " .. tostring(err) } end
        return {
            ok = true,
            player = player.Name,
            position = serializeValue(target),
        }
    end)
end

handlers.respawn_player = function(payload)
    local player = findPlayer(payload.playerName)
    if not player then return { error = "no player matched" } end
    local ok, err = pcall(function() player:LoadCharacter() end)
    if not ok then return { error = "LoadCharacter failed: " .. tostring(err) } end
    return { ok = true, player = player.Name }
end

-- ---------------------------------------------------------------------------
-- luau_typecheck: parse-check source code (catches syntax errors)
-- Real type-checking would need the full Luau analyzer; loadstring catches
-- syntax errors which is the most common failure mode.
-- ---------------------------------------------------------------------------

handlers.luau_typecheck = function(payload)
    local src = payload.source
    if type(src) ~= "string" then return { error = "source required" } end
    local fn, err = loadstring(src, "luau_typecheck")
    if fn then
        return { ok = true, syntax_valid = true }
    end
    -- Parse the error to extract line number
    local line = err and err:match(":(%d+):")
    return {
        ok = true,
        syntax_valid = false,
        error = tostring(err),
        error_line = line and tonumber(line) or nil,
    }
end

-- ---------------------------------------------------------------------------
-- diff_workspace: snapshot a subtree, then compare on next call
-- Snapshots stored in-memory keyed by name.
-- ---------------------------------------------------------------------------

local workspaceSnapshots: { [string]: { [string]: string } } = {}

local function snapshotTree(root: Instance): { [string]: string }
    local result: { [string]: string } = {}
    for _, d in ipairs(root:GetDescendants()) do
        result[d:GetFullName()] = d.ClassName
    end
    return result
end

handlers.diff_workspace = function(payload)
    local rootPath = payload.root or "Workspace"
    local root = resolvePath(rootPath)
    if not root then return { error = "root not found: " .. rootPath } end
    local name = tostring(payload.name or "default")

    if payload.action == "snapshot" then
        workspaceSnapshots[name] = snapshotTree(root)
        local count = 0
        for _ in pairs(workspaceSnapshots[name]) do count += 1 end
        return { ok = true, snapshot = name, count = count }
    end

    -- Default action: compare
    local before = workspaceSnapshots[name]
    if not before then return { error = `no snapshot "{name}" — call with action:"snapshot" first` } end

    local after = snapshotTree(root)
    local added, removed, changed = {}, {}, {}
    for path, className in pairs(after) do
        if not before[path] then
            table.insert(added, { path = path, className = className })
        elseif before[path] ~= className then
            table.insert(changed, { path = path, from = before[path], to = className })
        end
    end
    for path, className in pairs(before) do
        if not after[path] then
            table.insert(removed, { path = path, className = className })
        end
    end
    return {
        ok = true,
        snapshot = name,
        added = added, addedCount = #added,
        removed = removed, removedCount = #removed,
        changed = changed, changedCount = #changed,
    }
end

-- ---------------------------------------------------------------------------
-- profile_play_mode: enter play, sample Stats over N seconds, return summary
-- Uses run_script_in_play_mode internally via play_runner. Simpler: sample
-- Stats directly when called during running play, return snapshot.
-- ---------------------------------------------------------------------------

handlers.profile_play_mode = function(payload)
    if not RunService:IsRunning() then
        return { error = "profile_play_mode must be called during Play mode (wrap in run_script_in_play_mode)" }
    end
    local Stats = game:GetService("Stats")
    local duration = tonumber(payload.duration) or 3
    local samples = {}
    local sampleInterval = 0.25
    local count = math.max(1, math.floor(duration / sampleInterval))
    local frameStart = tick()
    local frameCount = 0
    local heartbeatConn
    heartbeatConn = RunService.Heartbeat:Connect(function() frameCount += 1 end)

    for _ = 1, count do
        task.wait(sampleInterval)
        table.insert(samples, {
            memMB    = Stats:GetTotalMemoryUsageMb(),
            heartbeatHz = frameCount / (tick() - frameStart),
        })
    end
    if heartbeatConn then heartbeatConn:Disconnect() end

    local elapsed = tick() - frameStart
    local avgFPS = frameCount / elapsed
    local memCurrent = Stats:GetTotalMemoryUsageMb()
    return {
        ok = true,
        duration = elapsed,
        avg_fps = avgFPS,
        frame_count = frameCount,
        memory_mb = memCurrent,
        samples = samples,
    }
end

handlers.get_tagged = function(payload)
    local CollectionService = game:GetService("CollectionService")
    local tag = tostring(payload.tag or "")
    if tag == "" then return { error = "missing `tag`" } end

    local all = CollectionService:GetTagged(tag)
    local root
    if payload.root then
        root = resolvePath(payload.root)
        if not root then return { error = "root not found: " .. tostring(payload.root) } end
    end

    local results = {}
    for _, inst in ipairs(all) do
        if not root or inst:IsDescendantOf(root) then
            table.insert(results, {
                path = inst:GetFullName(),
                className = inst.ClassName,
                name = inst.Name,
            })
        end
    end
    return { tag = tag, count = #results, results = results }
end

-- ---------------------------------------------------------------------------
-- editable_mesh_build: assemble an AssetService EditableMesh across batches,
-- then CreateMeshPartAsync it into the workspace. No-cloud path for import_blender_model.
-- ---------------------------------------------------------------------------

handlers.editable_mesh_build = function(payload)
	local AssetService = game:GetService("AssetService")
	local sessionId = tostring(payload.sessionId)
	local session = emSessions[sessionId]
	if not session then
		local ok, em = pcall(function() return AssetService:CreateEditableMesh() end)
		if not ok then return { error = "CreateEditableMesh failed: " .. tostring(em) } end
		session = { em = em, vertMap = {} }
		emSessions[sessionId] = session
	end
	local em = session.em

	-- Append this batch's vertices, remembering glb-index -> EditableMesh vertex id.
	-- Wrapped so a bad-data error clears the orphaned session instead of leaking it.
	local okAppend, appendErr = pcall(function()
		for i, v in ipairs(payload.vertices or {}) do
			local globalIndex = (payload.vertexBase or 0) + (i - 1)
			session.vertMap[globalIndex] = em:AddVertex(Vector3.new(v[1], v[2], v[3]))
		end
		for _, t in ipairs(payload.triangles or {}) do
			local a, b, c = session.vertMap[t[1]], session.vertMap[t[2]], session.vertMap[t[3]]
			if a and b and c then em:AddTriangle(a, b, c) end
		end
	end)
	if not okAppend then
		emSessions[sessionId] = nil  -- drop the orphaned EditableMesh so it can be GC'd
		return { error = "editable_mesh append failed: " .. tostring(appendErr) }
	end

	if not payload.finalize then
		return { ok = true, sessionId = sessionId, received = #(payload.vertices or {}) }
	end

	-- Finalize. Drop the session first so any early-return can't leak it.
	local parent = resolvePath(payload.parent or "Workspace")
	if not parent then emSessions[sessionId] = nil; return { error = "parent not found" } end

	-- CreateMeshPartAsync YIELDS and Content.fromObject is a Luau global that older
	-- Studio builds may lack. Build the MeshPart OUTSIDE the recording (matches
	-- insert_model's yield-outside-recording rule) and guard the call so an
	-- unsupported Studio returns a clear error instead of a hard crash.
	local okBuild, meshPartOrErr = pcall(function()
		return AssetService:CreateMeshPartAsync(Content.fromObject(em))
	end)
	emSessions[sessionId] = nil
	if not okBuild or typeof(meshPartOrErr) ~= "Instance" then
		return { error = "CreateMeshPartAsync/Content.fromObject failed (needs a Studio with EditableMesh + Content support): " .. tostring(meshPartOrErr) }
	end
	local meshPart = meshPartOrErr

	-- Only the synchronous naming + parenting goes inside the undo recording.
	return withRecording("MCP editable_mesh_build", function()
		meshPart.Name = payload.name or "BlenderMesh"
		meshPart.Parent = parent
		return { ok = true, meshPartPath = meshPart:GetFullName(), sessionId = sessionId }
	end)
end

-- ---------------------------------------------------------------------------
-- Helper: call fn() in background, return (result, timedOut) after `timeout` s
-- Mirrors Roblox's own callWithTimeout pattern for ExecutePlayModeAsync.
-- ---------------------------------------------------------------------------
local function callWithTimeout(fn, timeout, timeoutResult)
    local event = Instance.new("BindableEvent")
    local done = false
    local result = timeoutResult
    local timedOut = false

    task.spawn(function()
        local ok, r = pcall(fn)
        result = ok and r or tostring(r)
        if not done then done = true; event:Fire() end
    end)
    task.spawn(function()
        task.wait(timeout)
        if not done then done = true; timedOut = true; event:Fire() end
    end)
    if not done then event.Event:Wait() end
    event:Destroy()
    return result, timedOut
end

handlers.start_stop_play = function(payload)
    local mode = tostring(payload.mode or "")

    if mode == "start_play" then
        -- ExecutePlayModeAsync yields until play ends; we fire-and-check with a
        -- short timeout to distinguish "started" from "already in play mode".
        local result, timedOut = callWithTimeout(function()
            return StudioTestService:ExecutePlayModeAsync({})
        end, 0.15, "Started play mode")
        if not timedOut then
            return { result = "Already in play mode (or failed to start)" }
        end
        return { result = "Play mode started" }

    elseif mode == "run_server" then
        local result, timedOut = callWithTimeout(function()
            return StudioTestService:ExecuteRunModeAsync({})
        end, 0.15, "Started run server mode")
        if not timedOut then
            return { result = "Already in run server mode (or failed to start)" }
        end
        return { result = "Run server mode started" }

    elseif mode == "stop" then
        -- Signal the play-mode server context monitor (see top of file).
        pcall(function() plugin:SetSetting(MCP_STOP_SIGNAL_KEY, true) end)
        task.wait(1.5)
        return { result = "Stop signal sent" }
    end

    return { error = "Invalid mode '" .. mode .. "'. Use: start_play | run_server | stop" }
end

-- ---------------------------------------------------------------------------
-- run_script_in_play_mode
-- Wraps user code in a test runner that captures logs, honors a timeout,
-- and calls StudioTestService:EndTest({...}) to surface results back to us.
-- The return value of ExecutePlayModeAsync IS the table passed to EndTest.
-- ---------------------------------------------------------------------------
local function buildTestRunner(userCode: string, timeout: number): string
    local ts = tostring(timeout)
    return [[
local StudioTestService = game:GetService("StudioTestService")
local LogService       = game:GetService("LogService")
local RunService       = game:GetService("RunService")

if not RunService:IsRunning() then return end

local TYPE_MAP = {
    [Enum.MessageType.MessageOutput]  = "output",
    [Enum.MessageType.MessageInfo]    = "info",
    [Enum.MessageType.MessageWarning] = "warning",
    [Enum.MessageType.MessageError]   = "error",
}

local logs = {}
local conn = LogService.MessageOut:Connect(function(msg, msgType)
    if msg:sub(1, 5) == "[MCP]" then return end
    table.insert(logs, { level = TYPE_MAP[msgType] or "output", message = msg })
end)

local startTime = os.clock()
local isTimeout = false

local function finish(ok, val)
    task.wait(0.05)
    conn:Disconnect()
    local errors = {}
    for _, e in ipairs(logs) do
        if e.level == "error" or e.level == "warning" then
            table.insert(errors, e)
        end
    end
    StudioTestService:EndTest({
        success    = ok,
        value      = ok and tostring(val) or nil,
        error      = (not ok) and tostring(val) or nil,
        logs       = logs,
        errors     = errors,
        duration   = os.clock() - startTime,
        isTimeout  = isTimeout,
    })
end

task.spawn(function()
    task.wait(]] .. ts .. [[)
    isTimeout = true
    finish(false, "timeout after ]] .. ts .. [[ seconds")
end)

local ok, result = pcall(function()
]] .. userCode .. [[
end)
finish(ok, result)
]]
end

local TEST_SCRIPT_NAME = "MCPTestScript"

handlers.run_script_in_play_mode = function(payload)
    if type(payload.code) ~= "string" or payload.code == "" then
        return { error = "Missing 'code' argument" }
    end

    local timeout = (type(payload.timeout) == "number" and payload.timeout > 0)
        and payload.timeout or 30
    local runMode = tostring(payload.mode or "start_play")

    -- Remove any leftover test script from a previous run
    local sss = game:GetService("ServerScriptService")
    local old = sss:FindFirstChild(TEST_SCRIPT_NAME)
    if old then old:Destroy() end

    -- Inject test runner
    local testScript = Instance.new("Script")
    testScript.Name = TEST_SCRIPT_NAME
    testScript.Source = buildTestRunner(payload.code, timeout)
    testScript.Parent = sss

    -- Start play; this yields until EndTest (or natural stop)
    local success, result = pcall(function()
        if runMode == "run_server" then
            return StudioTestService:ExecuteRunModeAsync({})
        else
            return StudioTestService:ExecutePlayModeAsync({})
        end
    end)

    -- Cleanup
    local leftover = sss:FindFirstChild(TEST_SCRIPT_NAME)
    if leftover then leftover:Destroy() end

    if not success then
        return { error = "Play mode failed: " .. tostring(result) }
    end

    -- result is the table passed to EndTest by the test runner
    if type(result) == "table" then
        return result
    end
    return { result = tostring(result) }
end

-- ---------------------------------------------------------------------------
-- Plugin UI: toolbar button + auto-connect
-- The plugin auto-starts polling on load. The button's label (Name) updates
-- with an emoji to reflect live state — Studio re-renders toolbar button
-- labels when .Name changes. Click the button to start/stop polling.
--
-- States:
--   🟢 MCP — connected, server responding to /poll
--   🟡 MCP — polling but server unreachable (retrying)
--   ⏳ MCP — polling, waiting for first response after startup
--   ⏸  MCP — polling stopped (user toggled off)
-- ---------------------------------------------------------------------------

local toolbar = plugin:CreateToolbar("Multi-AI")

local statusButton = toolbar:CreateButton(
    "Multi-AI",
    "MCP server status (port 8765). Click to start/stop polling.",
    "rbxassetid://83497326633061"
)
statusButton.ClickableWhenViewportHidden = true

local running = false
local connected = false
local connectionThread: thread? = nil

-- Update the visual indicator. `state` is one of:
--   "stopped" | "connecting" | "connected" | "disconnected"
local ICON_CONNECTED    = "rbxassetid://98593193319832" -- green check
local ICON_DISCONNECTED = "rbxassetid://84462340885278" -- red X
local ICON_STOPPED      = "rbxassetid://83497326633061" -- pause

local STATE_ICONS = {
    stopped      = ICON_STOPPED,
    connecting   = ICON_DISCONNECTED,
    connected    = ICON_CONNECTED,
    disconnected = ICON_DISCONNECTED,
}

local function setStatusVisual(state: string)
    local icon = STATE_ICONS[state] or ICON_STOPPED
    pcall(function() statusButton.Icon = icon end)
    statusButton:SetActive(state == "connected")
end

-- ── Command watchdog (anti-wedge) ────────────────────────────────────────────
-- Handlers run in their own scheduler-managed thread while THIS thread polls a
-- done flag. If a handler never completes (e.g. run_luau require()ing a
-- DataStore/MemoryStore-bound module in Edit mode — the 2026-09-05 wedge), the
-- watchdog returns a TIMEOUT result: the result still gets posted, the poll
-- loop survives, and the broker/MCP client unblocks. The orphaned thread may
-- still finish later — its late finish() is ignored. Control handlers never
-- yield, so there the watchdog is a pure safety net.
-- NOTE: deliberately a done-flag + task.wait poll, NOT a BindableEvent wakeup —
-- task.spawn runs a fast handler to completion BEFORE this thread reaches its
-- wait, so an event fired before anyone waits is LOST (lost-wakeup wedge, seen
-- live 2026-09-05). Polling is race-free; fast handlers never even enter the
-- loop because task.spawn already set done=true synchronously.
local HANDLER_TIMEOUT_S = 600 -- fallback when a command carries no timeout_s
local WATCHDOG_POLL_S = 0.05

local function executeWithTimeout(handler, payload, timeoutS)
    local done = false
    local result = nil
    local function finish(r)
        if done then return end
        done = true
        result = r
    end
    task.spawn(function()
        local ok, r = pcall(handler, payload)
        if not ok then
            finish({ error = "handler crashed: " .. tostring(r) })
        elseif type(r) ~= "table" then
            finish({ ok = true })
        else
            finish(r)
        end
    end)
    if not done then
        local deadline = os.clock() + timeoutS
        while not done and os.clock() < deadline do
            task.wait(WATCHDOG_POLL_S)
        end
        if not done then
            finish({
                error = `command timed out after {timeoutS}s — handler still yielding (blocking API such as require/DataStore in Edit mode?). Executor recovered; the orphaned thread may still complete silently.`,
                code = "TIMEOUT",
                timed_out = true,
            })
        end
    end
    return result
end

local function executeCommand(cmd)
    local handler = handlers[cmd.type]
    if not handler then
        return { error = "unknown command: " .. tostring(cmd.type) }
    end
    local payload = cmd.payload or {}
    -- Per-command budget injected by the server (matches the tool's wall-clock
    -- deadline); clamped so a bogus value can neither stall (too long) nor cut
    -- legitimate work (too short).
    local timeoutS = math.clamp(tonumber(payload.timeout_s) or HANDLER_TIMEOUT_S, 10, 3600)
    return executeWithTimeout(handler, payload, timeoutS)
end

local function loop()
    print(`[MultiAI] Polling started — {SERVER_URL}`)
    while running do
        local ok, response = pcall(function()
            return HttpService:GetAsync(SERVER_URL .. "/poll", true, requestHeaders(true))
        end)
        if ok then
            -- Server responded → connection healthy
            if not connected then
                connected = true
                setStatusVisual("connected")
                print(`[MultiAI] ✓ Connected to {SERVER_URL}`)
            end
            if response and response ~= "" and response ~= "{}" then
                local decoded
                local decodeOk = pcall(function() decoded = HttpService:JSONDecode(response) end)
                if decodeOk and decoded and decoded.id then
                    print(`[MultiAI] -> {decoded.type}`)
                    local result = executeCommand(decoded)
                    local postOk, postErr = pcall(function()
                        HttpService:PostAsync(
                            SERVER_URL .. "/result/" .. decoded.id,
                            HttpService:JSONEncode(result),
                            Enum.HttpContentType.ApplicationJson,
                            false,
                            requestHeaders(false)
                        )
                    end)
                    if not postOk then warn(`[MultiAI] post failed: {tostring(postErr)}`) end
                end
            end
        else
            -- Server unreachable → mark disconnected and back off
            if connected then
                connected = false
                setStatusVisual("disconnected")
                warn(`[MultiAI] ✗ Disconnected — server unreachable. Retrying…`)
            end
            task.wait(2)
        end
        task.wait(POLL_INTERVAL)
    end
    connected = false
    setStatusVisual("stopped")
    print("[MultiAI] Polling stopped")
end

-- ── Control loop ──
-- A SECOND, independent poll loop on a short interval. Unlike the command loop
-- (which yields for the full duration of a long handler such as
-- ExecutePlayModeAsync), the control loop only ever dispatches __assign_studio_id
-- / __stop_play — handlers that just SetSetting/mutate an upvalue and return — so
-- it stays responsive during play mode. This is the channel that delivers
-- cross-session play-stop and same-id collision reassignment. It never touches
-- the command loop's `connected` visual. In inline mode the broker 404s
-- /studio/control-poll; the pcall swallows it and the loop idles harmlessly.
local controlThread: thread? = nil

local function controlLoop()
    while running do
        local ok, response = pcall(function()
            return HttpService:GetAsync(SERVER_URL .. "/studio/control-poll", true, requestHeaders(false))
        end)
        if ok and response and response ~= "" and response ~= "{}" then
            local decoded
            local decodeOk = pcall(function() decoded = HttpService:JSONDecode(response) end)
            if decodeOk and decoded and decoded.id then
                local result = executeCommand(decoded)
                pcall(function()
                    HttpService:PostAsync(
                        SERVER_URL .. "/studio/result/" .. decoded.id,
                        HttpService:JSONEncode(result),
                        Enum.HttpContentType.ApplicationJson,
                        false,
                        requestHeaders(false)
                    )
                end)
            end
        end
        task.wait(CONTROL_POLL_INTERVAL)
    end
end

-- ---------------------------------------------------------------------------
-- Session picker dock panel
-- A DockWidgetPluginGui listing the broker's live Claude sessions. Click a row to
-- pair THIS window to that session (POST /studio/pair); the active pairing is
-- highlighted; clicking the active row disconnects. Polls GET /studio/sessions on
-- its own ~1.5s timer (only while the panel is open), independent of the command
-- and control loops.
-- ---------------------------------------------------------------------------
local SESSIONS_POLL_INTERVAL = 1.5

local pickerWidget = plugin:CreateDockWidgetPluginGui(
    "MultiAISessionPicker",
    DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, true, 300, 420, 240, 320)
)
pickerWidget.Title = "Multi-AI — sessions"
pickerWidget.Name = "MultiAISessionPicker"

local pickerRoot = Instance.new("Frame")
pickerRoot.Size = UDim2.fromScale(1, 1)
pickerRoot.BackgroundColor3 = Color3.fromRGB(46, 46, 46)
pickerRoot.BorderSizePixel = 0
pickerRoot.Parent = pickerWidget

local headerLabel = Instance.new("TextLabel")
headerLabel.Size = UDim2.new(1, -16, 0, 40)
headerLabel.Position = UDim2.fromOffset(8, 4)
headerLabel.BackgroundTransparency = 1
headerLabel.TextXAlignment = Enum.TextXAlignment.Left
headerLabel.Font = Enum.Font.GothamMedium
headerLabel.TextSize = 13
headerLabel.TextColor3 = Color3.fromRGB(235, 235, 235)
headerLabel.TextWrapped = true
headerLabel.Text = "this window"
headerLabel.Parent = pickerRoot

local pickerList = Instance.new("ScrollingFrame")
pickerList.Size = UDim2.new(1, -8, 1, -52)
pickerList.Position = UDim2.fromOffset(4, 48)
pickerList.BackgroundTransparency = 1
pickerList.BorderSizePixel = 0
pickerList.ScrollBarThickness = 6
pickerList.CanvasSize = UDim2.new()
pickerList.AutomaticCanvasSize = Enum.AutomaticSize.Y
pickerList.Parent = pickerRoot

local pickerLayout = Instance.new("UIListLayout")
pickerLayout.Padding = UDim.new(0, 6)
pickerLayout.SortOrder = Enum.SortOrder.LayoutOrder
pickerLayout.Parent = pickerList

-- POST /studio/pair to bind this window to `sessionId` (or unpair when nil).
local function pairTo(sessionId: string?)
    task.spawn(function()
        -- nil = disconnect. In Luau `{ session_id = nil }` drops the key and encodes
        -- to "[]", which the broker reads as a MISSING field (not a disconnect). Send
        -- an explicit JSON null so POST /studio/pair routes to unpairStudio.
        local body
        if sessionId == nil then
            body = "{\"session_id\":null}"
        else
            body = HttpService:JSONEncode({ session_id = sessionId })
        end
        pcall(function()
            HttpService:PostAsync(
                SERVER_URL .. "/studio/pair", body,
                Enum.HttpContentType.ApplicationJson, false, requestHeaders(false)
            )
        end)
    end)
end

-- Rebuild the row list from a /studio/sessions response.
local function renderSessions(data)
    headerLabel.Text = `{studioLabel}  ·  #{string.sub(studioId, 1, 4)}`
    for _, child in pickerList:GetChildren() do
        if not child:IsA("UIListLayout") then child:Destroy() end
    end
    local you = data.you or {}
    local sessions = data.sessions or {}
    for i, session in sessions do
        local isActive = you.paired_session_id ~= nil and session.session_id == you.paired_session_id
        local row = Instance.new("TextButton")
        row.Size = UDim2.new(1, 0, 0, 40)
        row.LayoutOrder = i
        row.AutoButtonColor = true
        row.BackgroundColor3 = isActive and Color3.fromRGB(24, 96, 165) or Color3.fromRGB(58, 58, 58)
        row.BorderSizePixel = 0
        row.Text = ""
        local corner = Instance.new("UICorner")
        corner.CornerRadius = UDim.new(0, 6)
        corner.Parent = row

        local label = Instance.new("TextLabel")
        label.Size = UDim2.new(1, -82, 1, 0)
        label.Position = UDim2.fromOffset(10, 0)
        label.BackgroundTransparency = 1
        label.TextXAlignment = Enum.TextXAlignment.Left
        label.Font = Enum.Font.Gotham
        label.TextSize = 13
        label.TextTruncate = Enum.TextTruncate.AtEnd
        label.TextColor3 = Color3.fromRGB(240, 240, 240)
        label.Text = session.label or session.session_id
        label.Parent = row

        local state = Instance.new("TextLabel")
        state.Size = UDim2.new(0, 70, 1, 0)
        state.Position = UDim2.new(1, -76, 0, 0)
        state.BackgroundTransparency = 1
        state.TextXAlignment = Enum.TextXAlignment.Right
        state.Font = Enum.Font.Gotham
        state.TextSize = 12
        if isActive then
            state.Text = "● active"
            state.TextColor3 = Color3.fromRGB(180, 220, 255)
        elseif session.paired_studio_id then
            state.Text = "in use"
            state.TextColor3 = Color3.fromRGB(150, 150, 150)
        else
            state.Text = "connect"
            state.TextColor3 = Color3.fromRGB(120, 200, 140)
        end
        state.Parent = row

        row.Activated:Connect(function()
            if isActive then pairTo(nil) else pairTo(session.session_id) end
        end)
        row.Parent = pickerList
    end
    if #sessions == 0 then
        local empty = Instance.new("TextLabel")
        empty.Size = UDim2.new(1, 0, 0, 40)
        empty.BackgroundTransparency = 1
        empty.Font = Enum.Font.Gotham
        empty.TextSize = 12
        empty.TextColor3 = Color3.fromRGB(150, 150, 150)
        empty.Text = "no sessions connected"
        empty.Parent = pickerList
    end
end

-- Poll GET /studio/sessions only while the panel is open.
local function sessionsLoop()
    while running do
        if pickerWidget.Enabled then
            local ok, response = pcall(function()
                return HttpService:GetAsync(SERVER_URL .. "/studio/sessions", true, requestHeaders(false))
            end)
            if ok and response and response ~= "" then
                local decoded
                local decodeOk = pcall(function() decoded = HttpService:JSONDecode(response) end)
                if decodeOk and decoded and decoded.ok then
                    pcall(renderSessions, decoded)
                end
            end
        end
        task.wait(SESSIONS_POLL_INTERVAL)
    end
end

local sessionsButton = toolbar:CreateButton(
    "Sessions",
    "Show/hide the Multi-AI session picker",
    "rbxassetid://83497326633061"
)
sessionsButton.ClickableWhenViewportHidden = true
sessionsButton:SetActive(pickerWidget.Enabled)
sessionsButton.Click:Connect(function()
    pickerWidget.Enabled = not pickerWidget.Enabled
    sessionsButton:SetActive(pickerWidget.Enabled)
end)
pickerWidget:GetPropertyChangedSignal("Enabled"):Connect(function()
    sessionsButton:SetActive(pickerWidget.Enabled)
end)

local function startPolling()
    if running then return end
    running = true
    setStatusVisual("connecting")
    connectionThread = task.spawn(loop)
    controlThread = task.spawn(controlLoop)
    task.spawn(sessionsLoop)
end

local function stopPolling()
    if not running then return end
    running = false
    -- loop() will print "Polling stopped" and update the visual on its next tick
end

statusButton.Click:Connect(function()
    if running then
        stopPolling()
    else
        startPolling()
    end
end)

-- ── Auto-start polling when the plugin loads ──
startPolling()
