# Plugin-Authoritative Session Picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Roblox Studio window a per-window identity plus a dock-panel UI that lists the broker's live Claude sessions and lets the window pick / switch which session drives it — fixing the multi-studio concurrent-routing bug as its foundation.

**Architecture:** The plugin mints a fresh `studio_id` per load (so two windows on one machine are distinct studios), and a new `DockWidgetPluginGui` polls `GET /studio/sessions` and POSTs `POST /studio/pair` to a studio-initiated pairing primitive in the registry. Pairing stays 1:1 symmetric (`bindPair` detaches both sides → "switch/steal"); N:1 collaboration keeps riding the existing explicit `target` path.

**Tech Stack:** Node 18+ ESM (zero-dep, node builtins only) for `server/lib/*.mjs`; `node --test` for tests; Luau (`--!strict`) for `plugin/MultiAIPlugin.lua`.

**Spec:** `docs/superpowers/specs/2026-06-26-roblox-mcp-plugin-session-picker-design.md`

## Global Constraints

- `server/lib/*.mjs` and `server/*.mjs`: node builtins ONLY — no MCP SDK, no npm deps. Tests run under `node --test` with NO `node_modules`.
- Tests NEVER bind 8765 (live Studio broker) or 8766 (Blender). Always ephemeral port `0` via the existing `startCore` harness.
- Studio ids in tests must satisfy `ID_RE` (`/^[0-9a-fA-F:\-]{8,64}$/`) — use forms like `5701d001`, `a1a1aaaa`. Session ids are arbitrary strings (`sess-A`).
- Plugin Luau: `--!strict`; `:GetService`; `task.wait` (never `wait()`); string interpolation with backticks.
- Secrets never logged; the broker's `redactHeaders` already masks `x-mcp-token` / `x-api-key` — do not weaken it.
- New `/studio/*` endpoints are automatically covered by the broker's `brokerTokenGuarded` token gate (any `/studio/` path) — no gate change needed; tests must prove the 401.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Per-window identity (mint-fresh studio_id)

Root-cause fix: stop sharing one `studio_id` across windows. `plugin:SetSetting` is per-plugin user-global, so persisting+reusing the id made every window send the same `x-studio-id`. Mint a fresh id per load instead.

**Files:**
- Modify: `plugin/MultiAIPlugin.lua:34-42` (the `studioId` initializer)

**Interfaces:**
- Produces: `studioId` — still a `local` mutable upvalue (string), still read live by `requestHeaders()`. Only its *initial value* changes (fresh GUID, not the persisted one).

- [ ] **Step 1: Replace the persisted-id initializer with a fresh mint**

Replace `plugin/MultiAIPlugin.lua:34-42`:

```lua
local studioId: string = (function(): string
    local okGet, stored = pcall(function() return plugin:GetSetting(STUDIO_ID_KEY) end)
    if okGet and typeof(stored) == "string" and stored ~= "" then
        return stored
    end
    local minted = HttpService:GenerateGUID(false)
    pcall(function() plugin:SetSetting(STUDIO_ID_KEY, minted) end)
    return minted
end)()
```

with:

```lua
-- Per-window identity: mint a FRESH id on every plugin load and never reuse a
-- persisted one for routing. plugin:SetSetting is per-plugin USER-GLOBAL (shared
-- by every Studio window on the machine), so persisting+reusing the id made all
-- windows send the same x-studio-id → the broker saw them as ONE contested studio
-- and could not address them separately. Minting fresh per load gives each window
-- a unique id from its first poll. `studioId` stays a mutable upvalue so the
-- (now dormant) __assign_studio_id handler can still reassign it in place.
local studioId: string = HttpService:GenerateGUID(false)
```

Leave `STUDIO_ID_KEY` (line 20) and the `__assign_studio_id` handler (lines 219-232) untouched — the handler still mutates the live upvalue; its `SetSetting` write is now inert (nothing reads that key on load), which is harmless.

- [ ] **Step 2: Static syntax check**

Run the project's luau-lsp check the same way the broker work was gated (the toolchain that previously reported "0 SyntaxErrors"). If luau-lsp is not wired locally, the authoritative gate is the Studio reload in Task 5 (plugin loads with no parse error in Output). Expected: no new diagnostics from the 3-line change.

- [ ] **Step 3: Commit**

```bash
git add plugin/MultiAIPlugin.lua
git commit -m "fix(plugin): mint fresh per-window studio_id (no global SetSetting reuse)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Registry studio-initiated pairing (`pairStudioToSession` + `unpairStudio`)

**Files:**
- Modify: `server/lib/registry.mjs` (add two functions after `detachStudio` at :323; add both to the exports block at :437)
- Test: `server/test/registry.test.mjs` (append tests)

**Interfaces:**
- Consumes: `bindPair(sessionId, studioId, t, origin) → { pr, detached_from }` (`registry.mjs:121`, detaches prior pairs on both sides); `dissolvePair(sessionId) → studioId|null` (`:144`); `err(code, message, extra?)`; `touchSession`.
- Produces:
  - `pairStudioToSession(studioId, sessionId, t?) → { ok:true, pair, detached_from? } | err`
  - `unpairStudio(studioId, t?) → { ok:true, detached:boolean, former_session_id:string|null } | err`

- [ ] **Step 1: Write the failing tests**

Append to `server/test/registry.test.mjs`:

```js
test("pairStudioToSession binds studio→session (origin 'studio') and switches", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertSession({ sessionId: "sess-2", pid: 2 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", label: "Win1", connId: 1 }, clk.now());

  const r = reg.pairStudioToSession("stud-1", "sess-1", clk.now());
  assert.equal(r.ok, true);
  assert.equal(r.pair.origin, "studio");
  assert.equal(r.pair.sessionId, "sess-1");
  assert.equal(r.pair.studioId, "stud-1");
  assert.equal(reg.getStudio("stud-1").pairedSessionId, "sess-1");
  assert.equal(reg.getSession("sess-1").pairedStudioId, "stud-1");

  // Switch this window to sess-2 → sess-1 is detached on the studio side.
  const r2 = reg.pairStudioToSession("stud-1", "sess-2", clk.now());
  assert.equal(r2.ok, true);
  assert.equal(reg.getStudio("stud-1").pairedSessionId, "sess-2");
  assert.equal(reg.getSession("sess-2").pairedStudioId, "stud-1");
  assert.equal(reg.getSession("sess-1").pairedStudioId, null);
});

test("pairStudioToSession steals a session held by another studio; reports detached_from", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-2", connId: 2 }, clk.now());
  reg.pairStudioToSession("stud-1", "sess-1", clk.now());

  const r = reg.pairStudioToSession("stud-2", "sess-1", clk.now()); // steal
  assert.equal(r.ok, true);
  assert.equal(r.detached_from, "stud-1"); // session sess-1's prior studio
  assert.equal(reg.getStudio("stud-2").pairedSessionId, "sess-1");
  assert.equal(reg.getStudio("stud-1").pairedSessionId, null);
  assert.equal(reg.getSession("sess-1").pairedStudioId, "stud-2");
});

test("pairStudioToSession errors on unknown studio / session", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  assert.equal(reg.pairStudioToSession("ghost", "sess-1", clk.now()).code, "UNKNOWN_TARGET");
  assert.equal(reg.pairStudioToSession("stud-1", "ghost", clk.now()).code, "UNKNOWN_SESSION");
});

test("unpairStudio drops the studio's pairing on both sides", () => {
  const clk = makeClock();
  const reg = createRegistry({ now: clk.now });
  reg.upsertSession({ sessionId: "sess-1", pid: 1 }, clk.now());
  reg.upsertStudio({ studioId: "stud-1", connId: 1 }, clk.now());
  reg.pairStudioToSession("stud-1", "sess-1", clk.now());

  const u = reg.unpairStudio("stud-1", clk.now());
  assert.equal(u.detached, true);
  assert.equal(u.former_session_id, "sess-1");
  assert.equal(reg.getStudio("stud-1").pairedSessionId, null);
  assert.equal(reg.getSession("sess-1").pairedStudioId, null);

  const u2 = reg.unpairStudio("stud-1", clk.now()); // idempotent
  assert.equal(u2.detached, false);
  assert.equal(u2.former_session_id, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/registry.test.mjs`
Expected: FAIL — `reg.pairStudioToSession is not a function`.

- [ ] **Step 3: Implement the two primitives**

In `server/lib/registry.mjs`, insert after `detachStudio` (ends at `:323`), before `// ── resolveTarget` (`:325`):

```js
  // ── Studio-initiated pairing (plugin dock panel) ──
  // The plugin (a studio) chooses its session. Unlike pair() — session-initiated,
  // refuses a busy studio with STUDIO_BUSY — picking from the panel ALWAYS switches:
  // bindPair detaches any prior pair on BOTH sides, so "pick X" steals X from
  // whatever window held it (that window falls back to its picker). origin
  // "studio" surfaces in list_studios pairs alongside "auto"/"manual".
  function pairStudioToSession(studioId, sessionId, t = now()) {
    if (!studios.get(studioId)) return err("UNKNOWN_TARGET", `no studio ${studioId}`);
    if (!sessions.get(sessionId)) return err("UNKNOWN_SESSION", `no session ${sessionId}`);
    touchSession(sessionId, t);
    const { pr, detached_from } = bindPair(sessionId, studioId, t, "studio");
    return { ok: true, pair: pr, ...(detached_from ? { detached_from } : {}) };
  }

  // Drop this studio's current pairing (panel "disconnect"). Reuses dissolvePair
  // on the studio's paired session so both sides + the pairs cache clear.
  function unpairStudio(studioId, t = now()) {
    const st = studios.get(studioId);
    if (!st) return err("UNKNOWN_TARGET", `no studio ${studioId}`);
    const former = st.pairedSessionId;
    if (former) dissolvePair(former);
    return { ok: true, detached: former != null, former_session_id: former || null };
  }
```

Add both to the exports block (`server/lib/registry.mjs:437`), changing:

```js
    // pairing
    pair, unpair, attach, detach, detachStudio,
```

to:

```js
    // pairing
    pair, unpair, attach, detach, detachStudio, pairStudioToSession, unpairStudio,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/registry.test.mjs`
Expected: PASS (all registry tests, including the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add server/lib/registry.mjs server/test/registry.test.mjs
git commit -m "feat(registry): studio-initiated pairStudioToSession + unpairStudio (origin 'studio')

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Broker studio-plane endpoints (`GET /studio/sessions`, `POST /studio/pair`)

**Files:**
- Modify: `server/lib/broker-core.mjs` (add two routes inside `dispatch()` after the `/studio/register` block ending at `:500`, before `// session plane` at `:502`)
- Test: `server/test/broker-core.test.mjs` (append tests)

**Interfaces:**
- Consumes: `studioIdFrom(req) → string` (`broker-core.mjs:270`); `registry.snapshot(t)` (`{ studios, sessions, pairs }`, each session `{ sessionId, label, pid, kind, pairedStudioId, state, live }`); `registry.getStudio(id)`; `registry.pairStudioToSession` / `registry.unpairStudio` (Task 2); `readJson(req, res, cb)`; `sendJson(res, status, obj)`.
- Produces (HTTP, token-gated by `brokerTokenGuarded` for any `/studio/` path, identity via `x-studio-id`):
  - `GET /studio/sessions → { ok:true, you:{ studio_id, paired_session_id }, sessions:[{ session_id, label, paired_studio_id, live }] }`
  - `POST /studio/pair { session_id }` → non-null pairs (`pairStudioToSession`), `null` unpairs (`unpairStudio`).

- [ ] **Step 1: Write the failing tests**

Append to `server/test/broker-core.test.mjs`:

```js
// ── studio plane: session picker (GET /studio/sessions, POST /studio/pair) ──
test("GET /studio/sessions: live sessions + you.paired_session_id; 401 without token", async () => {
  const { port, registry, close } = await startCore({ authToken: "s3cret" });
  try {
    registry.upsertStudio({ studioId: "5701d001", label: "Win", connId: 1, legacy: false });
    registry.upsertSession({ sessionId: "sess-A", label: "repoA", pid: 1 });
    registry.upsertSession({ sessionId: "sess-B", label: "repoB", pid: 2 });

    const noTok = await req(port, { path: "/studio/sessions", headers: { "x-studio-id": "5701d001" } });
    assert.equal(noTok.status, 401);

    const r = await req(port, { path: "/studio/sessions", headers: { "x-studio-id": "5701d001", "x-mcp-token": "s3cret" } });
    assert.equal(r.status, 200);
    const b = j(r.body);
    assert.equal(b.ok, true);
    assert.equal(b.you.studio_id, "5701d001");
    assert.equal(b.you.paired_session_id, null);
    assert.equal(b.sessions.length, 2);
    const a = b.sessions.find((s) => s.session_id === "sess-A");
    assert.equal(a.label, "repoA");
    assert.equal(a.paired_studio_id, null);
    assert.equal(a.live, true);
  } finally { close(); }
});

test("POST /studio/pair binds, switches, unpairs (session_id:null), errors on unknown", async () => {
  const { port, registry, close } = await startCore({ authToken: "s3cret" });
  const H = { "x-studio-id": "5701d001", "x-mcp-token": "s3cret" };
  try {
    registry.upsertStudio({ studioId: "5701d001", label: "Win", connId: 1, legacy: false });
    registry.upsertSession({ sessionId: "sess-A", label: "A", pid: 1 });
    registry.upsertSession({ sessionId: "sess-B", label: "B", pid: 2 });

    const pair = await req(port, { method: "POST", path: "/studio/pair", headers: H, body: JSON.stringify({ session_id: "sess-A" }) });
    assert.equal(pair.status, 200);
    assert.equal(j(pair.body).ok, true);
    assert.equal(registry.getStudio("5701d001").pairedSessionId, "sess-A");

    const sw = await req(port, { method: "POST", path: "/studio/pair", headers: H, body: JSON.stringify({ session_id: "sess-B" }) });
    assert.equal(j(sw.body).ok, true);
    assert.equal(registry.getStudio("5701d001").pairedSessionId, "sess-B");
    assert.equal(registry.getSession("sess-A").pairedStudioId, null);

    const un = await req(port, { method: "POST", path: "/studio/pair", headers: H, body: JSON.stringify({ session_id: null }) });
    assert.equal(j(un.body).detached, true);
    assert.equal(registry.getStudio("5701d001").pairedSessionId, null);

    const bad = await req(port, { method: "POST", path: "/studio/pair", headers: H, body: JSON.stringify({ session_id: "ghost" }) });
    assert.equal(j(bad.body).code, "UNKNOWN_SESSION");
  } finally { close(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/test/broker-core.test.mjs`
Expected: FAIL — `/studio/sessions` and `/studio/pair` return 404 (`assert.equal(r.status, 200)` fails; pair asserts fail).

- [ ] **Step 3: Implement the two routes**

In `server/lib/broker-core.mjs`, inside `dispatch()`, insert after the `/studio/register` block (closes at `:500`) and before the `// session plane` comment (`:502`):

```js
    if (req.method === "GET" && p === "/studio/sessions") {
      const studioId = studioIdFrom(req);
      const snap = registry.snapshot(now());
      const you = registry.getStudio(studioId);
      sendJson(res, 200, {
        ok: true,
        you: { studio_id: studioId, paired_session_id: you?.pairedSessionId || null },
        sessions: snap.sessions
          .filter((s) => s.live)
          .map((s) => ({
            session_id: s.sessionId, label: s.label,
            paired_studio_id: s.pairedStudioId || null, live: s.live,
          })),
      });
      return;
    }
    if (req.method === "POST" && p === "/studio/pair") {
      return readJson(req, res, (b) => {
        const studioId = studioIdFrom(req);
        if (b.session_id === null) return sendJson(res, 200, registry.unpairStudio(studioId, now()));
        sendJson(res, 200, registry.pairStudioToSession(studioId, b.session_id, now()));
      });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/test/broker-core.test.mjs`
Expected: PASS (all broker-core tests, including the 2 new ones).

- [ ] **Step 5: Run the full server suite (regression)**

Run: `node --test server/test/*.test.mjs`
Expected: PASS, 0 fail / 0 cancelled (88 prior + new tests).

- [ ] **Step 6: Commit**

```bash
git add server/lib/broker-core.mjs server/test/broker-core.test.mjs
git commit -m "feat(broker): GET /studio/sessions + POST /studio/pair (plugin-driven pairing)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Plugin dock panel (session picker UI)

**Files:**
- Modify: `plugin/MultiAIPlugin.lua` — add a second toolbar button + a `DockWidgetPluginGui` block, inserted between the end of `controlLoop` (`:3241`) and `startPolling` (`:3243`); then add one line inside `startPolling`.

**Interfaces:**
- Consumes (all already defined above the insertion point): `plugin`, `toolbar` (`:3116`), `running` (`:3125`), `SERVER_URL` (`:17`), `studioId` / `studioLabel` upvalues (`:34`/`:44`), `requestHeaders(includeLabel)` (`:69`), `HttpService`. Endpoints from Task 3.
- Produces: a dockable "Multi-AI — sessions" panel; a `sessionsLoop()` thread spawned by `startPolling`.

- [ ] **Step 1: Insert the dock-panel block**

In `plugin/MultiAIPlugin.lua`, immediately AFTER the `controlLoop` function (which ends with its closing `end` at `:3241`) and BEFORE `local function startPolling()` (`:3243`), insert:

```lua
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
        local body = HttpService:JSONEncode({ session_id = sessionId })
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
```

- [ ] **Step 2: Spawn the picker loop from `startPolling`**

In `plugin/MultiAIPlugin.lua`, change `startPolling` (`:3243`) from:

```lua
local function startPolling()
    if running then return end
    running = true
    setStatusVisual("connecting")
    connectionThread = task.spawn(loop)
    controlThread = task.spawn(controlLoop)
end
```

to (add the final spawn line):

```lua
local function startPolling()
    if running then return end
    running = true
    setStatusVisual("connecting")
    connectionThread = task.spawn(loop)
    controlThread = task.spawn(controlLoop)
    task.spawn(sessionsLoop)
end
```

- [ ] **Step 3: Sync the plugin to Studio**

Run: `.\sync-plugin.ps1`
Expected: `[OK] Synced plugin (...)` and `[OK] Baked AUTH_TOKEN ...`.

- [ ] **Step 4: Reload + open the panel in ONE Studio window (focused gate)**

In a Studio window: Plugins → right-click `MultiAIPlugin` → Reload. Confirm the Output has no parse/load error. Click the new **Sessions** toolbar button → the dock panel opens, shows `this window · #<id>`, and lists the live session(s). With a single 1:1 topology the lone session row shows `● active`.

- [ ] **Step 5: Commit**

```bash
git add plugin/MultiAIPlugin.lua
git commit -m "feat(plugin): session picker dock panel (pick/switch which Claude session drives this window)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Live two-window smoke + docs

Verify the headline behavior end-to-end and update the docs/notes the change invalidates.

**Files:**
- Modify: `CLAUDE.md` (the broker "Known v1 limitations" note — the contested/`__assign_studio_id` gap is now moot under mint-fresh)
- Modify: memory `broker-multisession-design.md` + `MEMORY.md` (record the picker + identity fix)

- [ ] **Step 1: Deploy the server change**

The live broker runs the worktree's `server/server.mjs`, spawned by the Claude harness. After Tasks 2-3 are committed, restart the Claude session hosting the broker (currently PID 18072) so the new `registry.mjs` / `broker-core.mjs` load. Confirm: `GET http://127.0.0.1:8765/health` → `{ ok, role:"broker" }`.

- [ ] **Step 2: Two distinct studios appear**

Open 2 Studio windows (each with the Task-4 plugin synced + reloaded). Call `list_studios`.
Expected: `studios` has **2 entries with distinct `studioId`s**, both `contested:false` (no shared id).

- [ ] **Step 3: Drive each window independently**

In window A's panel pick session X; in window B's panel pick session Y (X ≠ Y). From session X run `workspace_overview`; from session Y run `workspace_overview`.
Expected: each result reflects its own place; no bouncing between windows (the inverse of bugreport §8).

- [ ] **Step 4: Switch**

In window B's panel click session X (steal). From session X, send a no-target command.
Expected: it now routes to window B; window A's panel shows it is no longer `active` within ~1.5s.

- [ ] **Step 5: Update CLAUDE.md**

In `CLAUDE.md`, update the broker "Known v1 limitations" paragraph: the multi-window contested case is now resolved by per-window mint-fresh identity (each window is a distinct studio from its first poll); the `__assign_studio_id` / contested machinery remains only as a dormant safety net.

- [ ] **Step 6: Update memory + commit docs**

Append to `…/memory/broker-multisession-design.md` (and the `MEMORY.md` hook) that the plugin session picker + mint-fresh identity shipped, closing `BUGREPORT-multistudio-concurrent-routing.md`.

```bash
git add CLAUDE.md
git commit -m "docs(broker): per-window identity resolves the multi-window contested limitation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- The `contested` detection and `__assign_studio_id` plumbing stay in place but go dormant (ids never collide under mint-fresh). Do not remove them in this plan — they are a harmless safety net / v2 on-ramp.
- N:1 (several sessions driving one window) needs no new code: any session can still target any studio via an explicit `target`, regardless of pairing.
- Reload-survival of the pick is intentionally out of scope (blocked by global `SetSetting`); after a plugin reload a window mints a new id and re-pairs (auto when 1:1, else via the panel).
