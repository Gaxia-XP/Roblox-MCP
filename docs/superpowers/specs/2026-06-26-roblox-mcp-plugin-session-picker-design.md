# Plugin-Authoritative Session Pairing (with per-window identity)

- **Date:** 2026-06-26
- **Branch:** `claude/broker-multisession`
- **Status:** Design — approved in brainstorm, pending spec review
- **Closes:** `docs/BUGREPORT-multistudio-concurrent-routing.md` (the per-window identity change here is the root-cause fix)
- **Builds on:** `docs/superpowers/specs/2026-06-24-roblox-mcp-multisession-broker-design.md`

---

## 1. Problem & context

Two intertwined parts:

**(a) Bug (root cause).** The plugin mints its `studio_id` once and persists it with `plugin:SetSetting`, which is **per-plugin user-global** — shared across *every* Studio window on the machine. Confirmed live: two windows running *different* games (`Test Http` farming, `Ancient Coin Hunters` baseplate) both registered as the same `studio_id ae03e226`. Every window therefore sends the same `x-studio-id`. The broker detects the collision as `contested` and holds both command polls (`broker-core.mjs:303-305`), but **no production path ever resolves the collision** — `__assign_studio_id` is enqueued only in unit tests. Net effect: multiple Studio windows on one machine cannot be addressed separately; commands bounce to whichever window wins the poll race.

**(b) Feature (the ask).** Each Studio window's plugin should have a **dock-panel UI** that lists the connected Claude sessions and lets the window **pick which session drives it**, **auto-connect** when unambiguous, and **switch the session at any time**.

The feature subsumes the fix: giving each window a unique identity (required for the UI to address windows individually) *is* the root-cause fix.

## 2. Goals / non-goals

**Goals**
- Each Studio window is a distinct, individually-addressable studio.
- A dock panel in each window shows: this window's identity, its current session, and a live list of sessions to connect / switch to.
- Auto-pair when unambiguous (exactly 1 live session × 1 live studio); otherwise the panel shows a picker.
- Switch the paired session at any time from the panel.

**Non-goals (v1)**
- Persisting the pick across plugin reload / Studio restart (blocked by global `SetSetting`; see §10).
- Custom / renamed session display names (use the existing cwd label).
- First-class N:1 *pairing* (multi-owner). N:1 collaboration uses explicit per-call `target`, which already works.
- Removing the now-dormant `contested` / `__assign_studio_id` machinery (kept as a harmless safety net / v2 on-ramp).

## 3. Decisions (locked in brainstorm)

- **Relationship:** 1:1 primary, slight N:1 interest.
- **Auto-connect:** auto-pair only when unambiguous; otherwise *always* show the picker. No reliance on (global) persisted memory.
- **UI:** `DockWidgetPluginGui` dock panel (per approved mockup).
- **Identity:** mint a fresh `studio_id` per plugin load; stop persisting it as the routing id.

## 4. Pairing model (refined against the registry)

The registry already models pairing as **1:1 symmetric**: `session.pairedStudioId ↔ studio.pairedSessionId`, bound by `bindPair(sessionId, studioId, …)` (`registry.mjs:121`), which atomically **detaches any prior pair on both the session side and the studio side**.

- The plugin's "pick session X" maps to a new **studio-initiated** primitive `pairStudioToSession(studioId, sessionId)` that calls `bindPair` directly — i.e. it **bypasses the session-side `STUDIO_BUSY` guard** in the existing `pair()` so switching is always allowed. Semantics: **switch + steal** — this window binds to X; if X was bound to another window, that window is detached (its panel falls back to the picker on its next poll). Picking never errors except for unknown session/studio.
- `maybeAutoPair` is unchanged (fires only at exactly 1 live session × 1 live studio).
- **N:1** (several sessions driving one window) is *not* pairing; it rides the existing explicit `target` path (`resolveTarget` routes to any studio regardless of pairing). No change needed.

> This refines the brainstorm's loose phrase "non-exclusive pairing" into the accurate "1:1 symmetric pairing with switch/steal; N:1 via `target`." Same capabilities, matches existing code.

## 5. Architecture

Three edited files, no new files.

### 5.1 Plugin identity — `plugin/MultiAIPlugin.lua`

Change the load-time id init from *"`GetSetting(STUDIO_ID_KEY)` else mint + `SetSetting`"* to **mint fresh** `HttpService:GenerateGUID(false)` each load, held in the existing mutable `studioId` upvalue and **never persisted for routing**. The `requestHeaders()` live-upvalue read is unchanged. The `__assign_studio_id` handler may remain (now never triggered) — leave as-is.

Consequence: ids never collide → `contested` never fires → the broker's hold path is never hit in normal use.

### 5.2 Broker studio-plane endpoints — `server/lib/broker-core.mjs`

Two new endpoints, both behind the same `brokerTokenGuarded` token gate as `/studio/poll`, with identity from `studioIdFrom(req)` (the `x-studio-id` header, validated by `ID_RE`):

- **`GET /studio/sessions`** →
  ```json
  { "ok": true,
    "you": { "studio_id": "…", "paired_session_id": "… | null" },
    "sessions": [ { "session_id": "…", "label": "…", "paired_studio_id": "… | null", "live": true } ] }
  ```
  Derived from `registry.snapshot(t)`: filter `sessions` to live; include each session's `pairedStudioId`; compute `you` from the calling studio's record.

- **`POST /studio/pair`** body `{ "session_id": "… | null" }` →
  - non-null → `registry.pairStudioToSession(studioIdFromHeader, session_id, t)` → `{ ok, pair, detached_from? }` or error (`UNKNOWN_SESSION` / `UNKNOWN_TARGET`).
  - `null` → unpair this studio (drop its current pairing) — used by an optional "disconnect" affordance.

### 5.3 Registry primitive — `server/lib/registry.mjs`

Add `pairStudioToSession(studioId, sessionId, t)`:
- validate both exist (else `UNKNOWN_TARGET` / `UNKNOWN_SESSION`),
- `touchSession(sessionId, t)`,
- `bindPair(sessionId, studioId, t, "studio")` — new origin tag `"studio"` surfaces in `list_studios` pairs alongside `"auto"` / `"manual"`,
- return `{ ok, pair, ...(detached_from ? { detached_from } : {}) }`.

For the `session_id: null` unpair, add a small studio-side unpair helper (drop the studio's current pairing via the existing `dissolvePair` on its paired session) — distinct from `detachStudio` (admin steal). Export the new function(s).

### 5.4 Plugin dock panel — `plugin/MultiAIPlugin.lua`

A `DockWidgetPluginGui` (toggled by the existing toolbar button) rendering the approved mockup:
- **Header:** "Multi-AI" + connection dot.
- **This-window block:** game name + short id.
- **Sessions list:** one row per live session — label (ellipsized), state (active / in use by other window / free), click to pair. Active row highlighted.
- **Footer:** "auto-connect on · 127.0.0.1:8765 · `<idle/queued/inflight>`".

Behavior:
- Poll `GET /studio/sessions` on its own ~1.5 s timer — a dedicated, non-blocking request separate from the command and control poll loops — and on a manual refresh button; rebuild the list and the active highlight from `you.paired_session_id`.
- Click a session → `POST /studio/pair { session_id }` → on ok, refresh. (Click the active session again, or a "disconnect" control → `{ session_id: null }`.)
- The panel only *reflects* pairing state; auto-pair is the broker's job — so a clean 1:1 shows "active" with zero clicks, and an ambiguous topology shows the picker with nothing highlighted.

## 6. Data flow

**Pair / switch:** panel click → `POST /studio/pair {session_id}` (`x-studio-id`, `x-mcp-token`) → broker `pairStudioToSession` → `bindPair` (detaches both sides) → ok → panel refreshes via `GET /studio/sessions`. The chosen session's next no-target command resolves (`resolveTarget` → via `"pair"`) to this window.

**List refresh:** panel timer → `GET /studio/sessions` → registry snapshot → panel rerender.

## 7. Error handling & edge cases

- Broker down / wrong token → `GET /studio/sessions` fails → panel shows "disconnected" (existing conn-dot logic), retries on timer.
- Pick a session that just dropped → `UNKNOWN_SESSION` → panel toasts + refreshes (it is gone from the list).
- Two windows pick the same session → second pick **steals** (`bindPair` detaches the first window; its panel shows it is no longer active on next poll). Documented, predictable.
- Reload a window → fresh id → unpaired → 1:1 auto-pairs instantly; ambiguous shows the picker.
- Plugin in inline mode (no broker) → `/studio/*` 404 as today → panel shows disconnected (no regression).

## 8. Testing

- **`broker-core.test.mjs`:** `/studio/sessions` returns live sessions + correct `you.paired_session_id`; `/studio/pair` binds; re-pair switches (`detached_from` set); pairing a session held by another studio steals it; `session_id:null` unpairs; 401 without token; unknown session errors.
- **`registry.test.mjs`:** `pairStudioToSession` binds + detaches both sides + origin `"studio"`; `maybeAutoPair` still 1:1-only (regression).
- **Plugin:** `luau_typecheck` / luau-lsp → 0 SyntaxErrors.
- **Live smoke (acceptance):** 2 windows → `list_studios` shows **2 distinct studios** → pick different sessions in each panel → drive both concurrently with no bounce → switch one → it re-routes. (Inverse of bugreport §8.)
- **Regression:** full existing suite green; single-window auto-pair unchanged.

## 9. Deployment

Broker + plugin change → `.\sync-plugin.ps1` → reload the plugin in each Studio window → **restart the Claude session hosting the broker** (currently PID 18072) so the new `broker-core.mjs` / `registry.mjs` load. The server is spawned by the Claude harness from the worktree's `server/server.mjs`.

## 10. Future (out of scope)

- Per-window persistence of the pick (needs a per-window nonce header since `SetSetting` is global) — revisit if reload-survival matters.
- Custom session display names.
- First-class N:1 multi-owner pairing.
- Retire the dormant `contested` / `__assign_studio_id` machinery once mint-fresh is proven in the field.
