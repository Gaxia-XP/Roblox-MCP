# Roblox MCP Multi-Session Broker — Design Spec (v1)

> **Provenance:** Authored 2026-06-24 via a 12-agent design + 4-lens adversarial-review workflow; every load-bearing claim was verified against the current code (`server/lib/http-bridge.mjs`, `server/server.mjs`, `plugin/MultiAIPlugin.lua`). All eight open decisions were resolved with the user and folded in (§13).
>
> **Verified facts that shaped the design:** `submit(type,payload,timeoutMs)` returns a Promise and `getStatus()` is sync (both returned from `createBridge`); all queue state + route handlers are closures inside one `createBridge` body (no seam to inject per-studio queues — so the broker builds its **own** server from extracted helpers); the token guard is `/poll | /submit | /result/`; `/health` returns `{ok,queued,inFlight}`; `EADDRINUSE → process.exit(1)`; the plugin is a single poll coroutine (`GetAsync(.."/poll", true, authHeaders())`, no query string) that goes **silent during long handlers** (the play-mode liveness problem the design must solve).

> **Status:** Implementation-ready design. This revision folds in every Critical and Important finding from the four adversarial reviews (concurrency/recovery, security, backward-compat, protocol-correctness). Each such finding is resolved *inside* the relevant section; a per-finding resolution map appears in §11. Minor findings are triaged in §12. Genuine open decisions are in §13; v1-vs-deferred scope in §14.
>
> **Two corrections that ripple through everything (verified against the real code):**
> 1. The broker does **not** "compose `createBridge()`". `createBridge` is a closed single-queue server with no injection seam (verified: `pending`/`inFlight`/`waiters` and all routes are closures inside one function body, `http-bridge.mjs:37–194`). The broker builds its **own** `http.createServer()` from **extracted helpers** and instantiates one `createCommandQueue()` **per studio**. [Protocol-Critical #2]
> 2. The public `submit(type, payload, timeoutMs)` signature stays **byte-identical** (verified `http-bridge.mjs:45`, called at `server.mjs:678` and `:132`). Target routing is carried by a separate internal `submitTo(studioId, …)`, never by reordering `submit`'s args. [Protocol-Critical #1]

---

## 1. Overview + component diagram

### 1.1 Problem
Each Claude Code session spawns its own `server/server.mjs`, which calls `createBridge({port:8765})` and binds `127.0.0.1:8765`; `EADDRINUSE` is fatal (`process.exit(1)`, verified `http-bridge.mjs:200–207`), so a 2nd concurrent session dies ("1 MCP = 1 session"). The plugin polls a hard-coded `http://127.0.0.1:8765` with no identity and grabs the front of one global queue ("plugin can't pick a session").

### 1.2 New shape (locked architecture A)
A single long-lived **Broker** owns `127.0.0.1:8765`, the identity registries, and the routing table. Each per-session `server.mjs` becomes a thin **Front-end (FE)** that holds NO public listener — it is an HTTP **client** of the broker and exposes the *exact* `submit()`/`getStatus()` surface its CallTool switch already calls. Studio plugins poll the broker as before, now carrying a stable identity. Lone session↔studio auto-pairs (zero-config preserved); otherwise N×N explicit pairs.

### 1.3 Components
```
┌─────────────────┐  stdio   ┌──────────────────────┐                       ┌────────────────────────────┐
│ Claude Code     │◄────────►│ Front-end (server.mjs)│  loopback HTTP        │ BROKER (broker.mjs)        │
│ session (MCP)   │          │  - session_id (file)  │◄─────────────────────►│  owns 127.0.0.1:8765       │
└─────────────────┘          │  - ensureBroker()     │  /fe/* + /session/*   │  - registry (sessions,     │
                             │  - submit/submitTo    │  (session_token-auth) │    studios, pairs, claims) │
                             │  - getStatus (async)  │                       │  - per-studio CommandQueue │
                             └──────────────────────┘                       │  - sweep / idle-reap       │
┌─────────────────┐ long-poll ┌──────────────────┐  loopback HTTP           │  - extracted hardening     │
│ Roblox Studio   │◄─────────►│ MultiAIPlugin.lua │◄────────────────────────►│    helpers (host/token/    │
│ window          │           │ - studio_id (Set- │  /studio/* (+ legacy     │    redact/body-cap)        │
└─────────────────┘           │   Setting), 2 polls│   /poll,/result alias)  └────────────────────────────┘
                              └──────────────────┘
```

- **Broker** (`server/broker.mjs` + `server/lib/broker-core.mjs`): zero-dep. Builds its own `http.createServer` from helpers extracted out of `http-bridge.mjs`; holds the registry + per-studio `CommandQueue`s + sweep/idle. EADDRINUSE in broker mode → **exit 0** (race loser).
- **Front-end** (`server/server.mjs`, thin) + `server/lib/broker-client.mjs`: mints/persists `session_id`, runs `ensureBroker()`, relays tool calls. SDK lives only here.
- **Registry** (`server/lib/registry.mjs`): pure, `now()`-injected state machine — pairs + claims. Most test-critical.
- **Command queue** (`server/lib/command-queue.mjs`): `createCommandQueue()` = `pending`/`waiters`/`inFlight`/timeout/late-result, **factored verbatim** out of `createBridge`, instantiated **per studio**, with the dropped-long-poll reaping fix (§4.4).
- **Plugin** (`plugin/MultiAIPlugin.lua`): mints+persists `studio_id`, runs a **control poll loop** in addition to the existing command loop (§2.6/§3.x), handles `__assign_studio_id`. Single-file install preserved.
- **Blender twin**: same factory on 8766 — **deferred to v2** (§14).

### 1.4 Zero-dep / test property [Protocol-Minor: split the claim]
`broker.mjs`, `broker-core.mjs`, `registry.mjs`, `command-queue.mjs`, `broker-client.mjs` import only `node:http`/`node:crypto`/`node:child_process`/`node:fs` + the extracted `http-bridge.mjs` helpers. The MCP SDK never enters `lib/`. Testability is explicitly **two tiers**:
- **(A) Pure unit tests, no sockets:** `registry.mjs` (pair/claim transitions, `resolveTarget`, sweep/idle math) and `createCommandQueue` (enqueue/timeout/late-result/dropped-waiter) — `now()`-injected, deterministic, fast.
- **(B) Integration tests, real sockets + children:** `ensureBroker` election, detached spawn, drain/reap — ephemeral ports + `spawnSync` children, following the `http-bridge.test.mjs:96` EADDRINUSE idiom. **Required:** a two-simultaneous-FE race test (spawn two children that both `ensureBroker()` the same ephemeral port; assert exactly one becomes leader, the other connects). Both tiers run under `node --test` with no `node_modules`.

---

## 2. Identity & security baseline

Canonical naming (resolves the cross-fragment `x-mcp-studio`/`x-studio-id`/`?sid=` divergence): **`x-studio-id`** (plugin), **`x-session-id`** (FE), per-session secret **`x-session-token`** (§2.7), command id stays `randomUUID()`.

### 2.1 studio_id
- **Value:** plugin-minted GUID via `HttpService:GenerateGUID(false)` (32 hex), persisted with `plugin:SetSetting("MultiAI_StudioId", …)` — the same persistence class proven by `MultiAI_StopPlaySignal`. NOT `PlaceId` (0 for unsaved / identical across windows) nor `JobId` ("" in Edit).
- **Generation** is `pcall`-guarded; if `SetSetting` fails the id is still minted per-load (non-persistent fallback) — strictly no worse than today, which has no identity at all. [Concurrency-Minor → edge #39]
- **Wire format — HEADER ONLY.** [Backward-compat-Important; Concurrency-Important] The query-string fallback is **removed**. Verified: the plugin already sends headers today (`GetAsync(url, true, authHeaders())`, `MultiAIPlugin.lua:3080`) and the poll URL carries **no** query string. A query param would (a) be a non-fix for a non-problem and (b) vary the `GetAsync` cache key. **Invariant:** the `/poll` URL string and the `nocache=true` 2nd arg of `GetAsync` stay byte-identical; only the headers table grows. So `studio_id` rides as `x-studio-id` on every `/studio/poll` and `/studio/result/<id>` — header, never query.
- **Label:** `studio_label = game.Name (fallback "Studio") .. " #" .. studio_id:sub(1,4)`. Sent as `x-studio-label` on the first poll and whenever it changes; steady-state polls send only `x-studio-id`. Advisory; never a routing key. `place_id` rides as advisory display data.

### 2.2 session_id
- **Value:** FE-minted `randomUUID()`, **persisted per-cwd** (a session is identified to the user by its working directory; reusing the id on MCP restart preserves an established pairing; different worktrees → different cwd → different sessions).
- **Path:** `%LOCALAPPDATA%/Roblox-MCP/sessions/session-<sha256(cwd).slice(0,16)>.json` → `{ session_id, created }` (stable per-user dir, NOT `os.tmpdir()`).
- **Wire:** `x-session-id` on `/fe/register`, `/fe/heartbeat`, `/session/*`. After register, also `x-session-token` (§2.7).
- **Label:** `basename(cwd)` + `(branch)` best-effort; `ROBLOX_MCP_SESSION_NAME` overrides verbatim. Advisory.

### 2.3 command id
`randomUUID()` per command, globally unique across all studios. `inFlight` is a **broker-global** `Map<id,{resolve,timeout,studioId}>`; the id alone routes a result. `studioId` is recorded for cleanup and the owner-check (§4.3), and is **rewritten atomically on any re-key/reassignment** (§2.5) so a migrated result is never falsely discarded. [Protocol-Minor #7]

### 2.4 Legacy (un-upgraded) plugins/sessions — single well-known id, NOT per-socket [Protocol-Important: connId instability]
The original per-keep-alive-socket `legacy:<connId>` scheme is **abandoned**: Roblox `GetAsync` does not guarantee one persistent socket across the 0.5 s poll cycle, so connId churn would mint a new synthetic studio per poll and **break auto-1:1** for an un-upgraded plugin — a regression worse than today. Instead:
- A truly header-less `/studio/poll` (or the legacy bare `/poll` alias) maps to the **single well-known synthetic studio `legacy:default`** (one global legacy studio, exactly mirroring today's single shared queue). Label `"Studio (legacy)"`.
- A header-less submit (no `x-session-id`, never registers) → `session:legacy` (label `"Session (legacy)"`).
- With auto-1:1 (§5.3), legacy-plugin + single-session is byte-identical to today.
- **Deploy-order guidance:** the plugin is deployed first (§3.8), so the steady state is a real `x-studio-id`; `legacy:default` is a compatibility floor, not the expected path.

### 2.5 Mid-run legacy→v2 upgrade migration
When a real `x-studio-id` first arrives from a plugin that had been mapped to `legacy:default`, the broker **re-keys** that registry entry to the real id, **atomically moving** `pending[]`, `waiters[]`, `lastPollAt`, and any pairing/claim, and **re-pointing every parked waiter closure** to the new record. It also rewrites `inFlight[id].studioId` for any in-flight command from that studio. No command loss, no re-pair, no waiter stranded on a dead key. [Concurrency-Important #6; Protocol-Minor #7]

### 2.6 Same-id-two-windows collision (`__assign_studio_id`) — corrected for the real plugin
Two windows of the same place share the persisted `MultiAI_StudioId`. **Concurrency detection by overlapping poll timing, not socket identity** [Protocol-Important]: the broker stamps a monotonic `connId` per request and tracks the set of recently-active connIds per `studio_id`; if **two distinct connIds** poll the same `studio_id` within a short window, that `studio_id` is marked **`contested`**.

While `contested`:
- The broker **refuses to dequeue ANY normal command** for that `studio_id` (commands stay queued) — no first-poll-wins command theft. [Concurrency-Important]
- It delivers `__assign_studio_id` (a fresh GUID) to the **second** connId, **injected ahead of `pending[]`** so it takes priority over any queued command. [Protocol-Critical]

The plugin handles it as a **real entry in the `handlers` table** (the loop dispatches `handlers[cmd.type]`; verified there is no special path) whose handler:
1. validates `payload.studio_id` against `/^[0-9a-fA-F\-]{8,64}$/` (rejecting the `legacy:`/`session:` colon forms) [Security-Minor #6],
2. `pcall(plugin.SetSetting, plugin, "MultiAI_StudioId", payload.studio_id)`,
3. **mutates the module-level `studioId` upvalue** so the next poll's `requestHeaders()` (which MUST re-read the live upvalue, never a load-time capture) carries the new id, [Protocol-Critical / Backward-compat-Important]
4. returns `{ok:true, studio_id}` (posted to `/studio/result/<id>`),
5. continues the loop; the next `GetAsync` (≤ `POLL_INTERVAL` later) carries the new id.

Because delivery requires the contesting connId to **poll**, and a plugin blocked in play mode does not poll its command loop, the assign is delivered on the **dedicated control poll** (§2.6.1) which keeps running during play mode. The `contested` flag stays set and commands stay queued until exactly one connId remains or the reassignment round-trips — the broker **never silently falls back to first-poll-wins**. If the originally-bound connId is already stale (window closed), no reassignment fires; the reopened window keeps its id and pairing. This makes edge #8 ("windows diverge permanently") actually true. `__assign_studio_id` is broker-internal, never a user tool, and never accepted as a `/session/submit` `type`.

### 2.6.1 Two plugin poll loops [Concurrency-Critical #2 & #3 root fix]
The plugin runs **two** independent `task.spawn` loops against the broker:
- **Command loop** (today's loop): `GET /studio/poll` → `executeCommand` → `POST /studio/result/<id>`. May block for the full duration of a long handler (e.g. `ExecutePlayModeAsync`).
- **Control loop** (NEW): `GET /studio/control-poll` on a short interval, dispatching ONLY a small reserved allowlist: `__assign_studio_id` and `__stop_play`. This loop **never blocks** (its handlers only `SetSetting`/mutate upvalues and return immediately), so it stays responsive while the command loop is yielded inside a play test. This is the channel that makes cross-session stop (§5.9) and collision reassignment (§2.6) deliverable during play mode.

The existing Server-context `StopPlaySignal` watcher (`MultiAIPlugin.lua:41–51`, separate `task.spawn`) is **untouched** — verified — and is now *armed* via the control loop's `__stop_play` handler instead of the (blocked) command loop.

### 2.7 Per-session authorization — session_token [Security-Critical #1]
The shared `x-mcp-token` is a process-wide outer gate; it does **not** bind identity. A self-asserted `session_id` would let any local process ride another session's pairing or target any studio (incl. `run_luau` = arbitrary Luau). Fix:
- On `POST /fe/register` the broker **mints a random `session_token`** (returned once to that FE) and binds it to the `(session_id, pid)`.
- Every subsequent `/session/submit`, `/session/pair`, `/session/unpair`, `/session/attach`, `/session/detach-studio`, `/fe/heartbeat`, `/fe/deregister`, and `GET /session/<id>/status` **requires** the matching `x-session-token`; mismatch → `401` **before** `resolveTarget` (so target resolution and routing are gated). [Security-Critical #1, #3]
- `target` is authorization-bearing: an explicit per-call `target` is the intentional mode-2 escape hatch and bypasses *sticky-pair ownership* by design, but it still passes through the §2.7 token gate (only an authenticated session can target at all) **and** the §6 claim gate (§5.6 reconciles this with edge #22). [Protocol-Important #6; Security-Critical #1]
- **Machine-token is the UNCONDITIONAL default (RESOLVED — §13 Q1, locked 2026-06-24).** Because a shared, long-lived, N-studio broker is far more dangerous unauthenticated than today's single-session server, the broker **always auto-generates a machine token** into `%LOCALAPPDATA%/Roblox-MCP/broker-token` (0600-equivalent ACL) on first spawn whenever `ROBLOX_MCP_TOKEN` is unset, and hands it to spawned FEs + the plugin sync step. `sync-plugin.ps1` writes that machine token into the plugin's `AUTH_TOKEN` automatically, so **even the single-user zero-config case runs authenticated** (the outer `x-mcp-token` gate is never empty) — closing the rogue-local-process register hole (edge #44/Sec-3) for everyone, not just operators who opt in. An operator who sets `ROBLOX_MCP_TOKEN` explicitly overrides the machine token. The escape hatch `ROBLOX_MCP_ALLOW_TOKENLESS=1` restores the old empty-outer-gate behavior for anyone who deliberately wants it. The per-session `session_token` layer is always in force on top of whichever outer token is used.

### 2.8 Validation & non-secrecy
Ids validated `/^[0-9a-fA-F:\-]{8,64}$/` (the `:` admits `legacy:`/`session:`); non-matching → treated as synthetic, never trusted. Labels truncated to 80 chars + control-chars stripped (registry) **and again before any log/`broker.log` write** [Security-Minor #5]; `x-studio-label` capped 160 bytes pre-parse. `redactHeaders()` (verified `http-bridge.mjs:13–22`) is applied to the FULL header set on **every** new endpoint's log line — added as a test that `x-mcp-token`/`x-api-key` to `/studio/poll` and `/session/submit` log as `[REDACTED]`. studio/session ids+labels are intentionally NOT redacted (debuggability) and **never** placed in the unauthenticated `/health` body (§4.1).

---

## 3. Lifecycle & election

### 3.1 In-process leader; no auto-promotion in v1
Hybrid: the bind winner hosts the broker **in-process** (single-session case = one process, zero-hop `submit`); the detached form is the recovery path. v1 ships `PROMOTE_ON_SECOND_FE = false` (in-proc→detached handoff-replay deferred to v2; re-election already covers leader exit).

### 3.2 Bind-election — bind the REAL server, no throwaway probe [Concurrency-Important #4; Protocol-Important: close→rebind race]
The earlier "bind a probe, `close()`, then `listen()` the real server" had a TOCTOU gap (port unbound between close and re-listen → a loser could win a second bind while the original winner's `listen()` hits a now-fatal EADDRINUSE → the winner kills its own session). **Fix: bind the real broker server directly as the election** — there is never an unbound gap.

```
async ensureBroker({ port, host="127.0.0.1", authToken, brandPrefix, sessionId }) {
  // STEP A — try to BECOME the broker by directly binding the real server.
  const { server, won, errno } = await tryListenBroker({ port, host, authToken, brandPrefix });
  if (won) return connectLocal({ server, core, sessionId });   // in-proc; submit() short-circuits, no loopback
  if (errno && errno !== "EADDRINUSE") throw fatal(errno);      // unexpected → fatal
  // STEP B — lost the bind (EADDRINUSE): someone owns (or is mid-binding) the port.
  for (let i = 0; i < CONNECT_RETRIES; i++) {                   // 20×50ms ≈ 1s covers winner's listen-attach gap
    const client = await connect({ port, host, authToken, sessionId });  // validates GET /health (§3.3)
    if (client) return client;
    await delay(CONNECT_BACKOFF_MS);
  }
  // STEP C — port held by a half-bound/dying broker that never answered.
  spawnDetachedBroker({ port, host, authToken, brandPrefix });
  return connectOrThrow({ port, host, authToken, sessionId, retries: 40, backoffMs: 50 }); // 2s
}
```

Critically, the **in-process leader's own `listen()` EADDRINUSE must NOT be `process.exit(1)`.** The broker/in-proc path uses a `createCommandQueue`-based server whose listen-error is surfaced to `ensureBroker` as "lost the race → fall through to STEP B", not the fatal exit hard-coded in today's `createBridge` (`http-bridge.mjs:206`). The fatal-exit behavior is retained **only** for `ROBLOX_MCP_MODE=inline`. [Concurrency-Important #4; Protocol-Important]

Because STEP A binds directly, the close→rebind gap is gone and STEP B's race window shrinks to "winner bound but hasn't attached its request handler yet" — sub-millisecond and in-process.

### 3.3 Non-broker / older-broker port holder — tolerant detection [Backward-compat-Minor]
`connect()` validates `GET /health`:
- `{ ok:true, role:"broker", proto:1, … }` → broker; connect.
- `{ ok:true }` **without** `role`/`proto` → a same-family **older** server (an old inline `createBridge` answers `{ ok, queued, inFlight }`). Do NOT classify as a stranger and do NOT spawn a competitor; surface a clear error: `"[roblox-mcp] an older/incompatible MCP server holds 8765 — restart it to upgrade"`. (Inline mode also gains `role:"inline"` in its `/health` so the client can distinguish it from a true stranger.)
- 404 / unrelated shape → after the retry window, FATAL exit 1: `"127.0.0.1:8765 is held by a non-broker process"`. Never spawn on a different port (would break the plugin's hard-coded URL).

### 3.4 Detached spawn — explicit cwd, allowlisted env, first-spawn logging [Security-Critical #2; Backward-compat-Critical]
```
child_process.spawn(process.execPath,
  [ fileURLToPath(new URL("./broker.mjs", import.meta.url)) ],
  {
    detached: true,
    cwd: dirname(fileURLToPath(import.meta.url)),   // broker.mjs's dir, NOT inherited (Drive-junction-safe)
    stdio: ["ignore","ignore", firstSpawnLogFd],    // capture stderr to broker-spawn.log for the startup window
    windowsHide: true,
    env: {                                          // ALLOWLIST — never {...process.env}
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,           // minimal OS vars Node needs on Windows
      MCP_BROKER_PORT: String(port),
      MCP_BROKER_HOST: host,
      MCP_BROKER_ROLE: "spawned",
      ROBLOX_MCP_TOKEN: authToken || "",
      ROBLOX_MCP_BROKER_IDLE_MS: process.env.ROBLOX_MCP_BROKER_IDLE_MS ?? "",
    },   // explicitly NOT ROBLOX_OPEN_CLOUD_API_KEY / ROBLOX_OPEN_CLOUD_CREATOR_* / any other *_KEY
  }).unref();
```
- **Env allowlist** (not `{...process.env}`): the Open Cloud key is read only in `server.mjs` (verified used by `open-cloud.mjs`) and never enters the broker; copying it into a detached, idle-surviving process is a regression. Test asserts no `roblox_*`/`*_KEY`/`*_TOKEN` (other than the broker token) appears in the spawned child's env. [Security-Critical #2]
- **Explicit cwd = broker.mjs's directory**, not the inherited (possibly Google-Drive-junction) cwd, which on Windows can make a detached `node` fail to start. [Backward-compat-Critical]
- **First-spawn stderr captured** to a `redactHeaders`-clean `%LOCALAPPDATA%/Roblox-MCP/broker-spawn.log` for the startup window, so a failed spawn is diagnosable instead of a silent 2s-then-FATAL. (Steady-state broker logging is open question Q6.) [Backward-compat-Critical; Security-Minor #5]
- **The lone single-session user never reaches STEP C** — STEP A's direct bind wins → in-proc leader → no spawn at all. Verified to be the short-circuit. A test mirrors the EADDRINUSE idiom: spawn `broker.mjs` detached from a synthetic odd cwd and assert it still binds. [Backward-compat-Critical]

`broker.mjs` in broker mode treats its own EADDRINUSE as **exit 0** (a race loser), distinct from inline's fatal exit 1.

### 3.5 brokerId
`brokerId = randomUUID()` per (re)start; on `/health`, `/fe/register`, `/fe/heartbeat`. If it changes under a live FE (respawn), the FE re-runs `register` (re-establish row + adopt new `session_token`) without a full re-election.

### 3.6 Liveness, sweep, idle self-reap — in-flight is a hard keepalive [Concurrency-Critical #1, Concurrency-Important #5]

The earlier model drove liveness off poll cadence alone. But the **real plugin's command loop goes silent on `/studio/poll` for the entire duration of a blocking handler** (`ExecutePlayModeAsync` yields the coroutine up to the 45 s server budget). So `lastPollAt`-only liveness would flip a busy studio "stale" ~12 s in and could DROP it (and dissolve its pair / lose the genuinely-completing result) mid-command, and could let idle-reap kill an in-flight command. Fixes:

1. **`inFlight` is an absolute keepalive.** A studio with any `inFlight` entry whose `studioId === this studio` is **never** marked stale or dropped, regardless of `lastPollAt`, and `pluginConnected` for that studio is **forced `true`** while a command is in flight (so `get_connection_status` mid-play-test does not report the plugin offline — preserving today's coherent picture). The control loop's `/studio/control-poll` (§2.6.1) **also** updates `lastPollAt`, giving a second, never-blocked heartbeat.
2. **`STUDIO_DROP_MS` > max single-command budget + margin.** The max tool budget is ~45 s (`toolTimeoutMs` + slack) and some movement budgets are larger, so 60 000 was too close. Raised to **120 000**.
3. **Idle is gated on `inFlight.size === 0`.** The broker never enters `DRAINING`, and never starts the idle-since clock, while any command is in flight. [Concurrency-Important #5 Race 1]
4. **Drain stops dequeuing NEW commands.** Once `DRAINING`, `/studio/poll` returns `{}` (no fresh command starts that can't finish); in-flight commands still post results and drain. The broker **refuses to exit while `inFlight.size > 0`**, capped by a hard ceiling well above 45 s. The old 5 s deadline is removed as the primary gate. [Concurrency-Important #5 Races 2 & 3]

| Constant | Value | Meaning |
|---|---|---|
| `PLUGIN_STALE_MS` | 12 000 | studio `pluginConnected=false` past this (today's value; byte-compatible status) — **overridden to connected while in-flight** |
| `STUDIO_DROP_MS` | **120 000** | studio record + pair deleted past this (now > max command budget) |
| `FE_HEARTBEAT_MS` | 10 000 | FE heartbeat cadence (independent timer — §3.6.1) |
| `SESSION_STALE_MS` | 90 000 | session marked stale past this |
| `SESSION_DROP_MS` | 300 000 | session record + pair deleted past this |
| `REAP_TICK_MS` | 5 000 | sweep cadence |
| `IDLE_REAP_MS` | 90 000 | broker self-exits after this long with zero live FEs AND zero live studios AND `inFlight===0` |
| `DRAIN_CEILING_MS` | 60 000 | hard ceiling on draining if a result never arrives (well above 45 s) |
| `CONTROL_POLL_MS` | 1 000 | control-loop cadence (plugin) |

`sweep(now)` every `REAP_TICK_MS`: (1) mark/drop studios by `PLUGIN_STALE_MS`/`STUDIO_DROP_MS` **unless they hold in-flight**, unpair on drop; (2) mark/drop sessions; (3) `idle = liveFEs===0 && liveStudios===0 && inFlight.size===0`; track `idleSince`; if idle ≥ `IDLE_REAP_MS` → `beginShutdown()`.

> **Note — DROP needs `tick`, reads don't:** live/stale is computed on the fly from `now-lastSeenAt` (plus the in-flight override) in `snapshot`/`resolveTarget`, so missing a sweep never mis-routes (stale sides are excluded from auto-pair). The broker also `tick`s on each `/studio/poll`.

`beginShutdown()`: `draining=true` → new `/session/submit` + `/fe/register` → `503 {"error":"broker draining"}` (caller re-elects); `/studio/poll` returns `{}` (no new dequeues); wait `inFlight.size===0` or `DRAIN_CEILING_MS`; `httpServer.close()` → exit 0.

### 3.6.1 FE heartbeat is a free-running timer [Concurrency-Minor #8]
`POST /fe/heartbeat` is driven by a `setInterval` **independent of the MCP request/await cycle**, so it fires even while a 45 s `submit()` is pending (the FE is single-threaded over stdio, so a request-loop-only heartbeat would starve during a long call). Belt-and-suspenders: the broker also treats an in-flight `/session/submit` as a session keepalive (`touchSession` on submit resets `SESSION_STALE`). Stated as a **requirement**, not just a cadence.

### 3.7 Crash recovery & FE state machine
- **FE:** any `ECONNREFUSED`/`ECONNRESET` on heartbeat/submit → `RECONNECT` → re-run `ensureBroker()`. An in-flight submit that died with the broker resolves `{error:"broker connection lost — retried; rerun the tool", code:"NO_BROKER"}`. **No at-most-once guarantee across a crash** (documented); Roblox writes are undo-wrapped so re-issue is safe. Realistic reconnect latency is **~2–2.5 s** (the plugin's `GetAsync` must fail once and back off `task.wait(2)` before re-polling the new broker — verified `MultiAIPlugin.lua:3114`); commands submitted in that window sit in `pending` and run when the plugin re-polls; `get_connection_status` reads `pluginConnected:false` transiently. [Concurrency-Important #6]
- **Plugin:** existing `pcall(GetAsync)` failure path (verified) sets `connected=false`, `task.wait(2)`, retries. Only change: sends `x-studio-id` + runs the control loop.

```
FE:  BOOT → ELECTING → {LEADER_INPROC | CLIENT} → CONNECTED → RECONNECT → ELECTING …
     ELECTING --direct bind win-->          LEADER_INPROC --listening--> CONNECTED
     ELECTING --EADDRINUSE, connect ok-->   CLIENT --/health broker-->   CONNECTED
     ELECTING --EADDRINUSE, no answer+spawn-->CLIENT (after child /health)→ CONNECTED
     ELECTING --older same-family on 8765--> FATAL("restart older server")
     ELECTING --unrelated holds 8765-->      FATAL(exit 1)
     CONNECTED --ECONNREFUSED-->             RECONNECT → ELECTING
     CONNECTED --brokerId changed-->         re-register (new session_token; stay CONNECTED)
     CONNECTED --stdio closed-->             SHUTDOWN (best-effort /fe/deregister; in-proc broker idle-reaps)
     RECONNECT --5 failed elections (~5s)--> FATAL(exit 1, "cannot reach or start broker")

Broker: STARTING --listen ok--> SERVING --idle(incl inFlight==0)≥IDLE_REAP_MS--> DRAINING --inFlight==0||ceiling--> STOPPED(exit0)
        DRAINING --new register/submit--> 503;  --/studio/poll--> {} (no new dequeue)
```

### 3.8 Migration / fallback flag
`ROBLOX_MCP_MODE` = `broker` (default) | `inline`. `inline` restores pre-broker behavior bit-for-bit (today's `createBridge`, binds 8765, EADDRINUSE fatal). The new plugin's additive `x-studio-id` header is ignored by inline `createBridge` (verified — it only token-guards `/poll`,`/submit`,`/result/`), and the new control-loop hits `/studio/control-poll` which inline returns 404 for (harmless; the plugin treats 404 like an idle no-op). So plugin and server **cut over independently** — deploy the new plugin first, flip the flag later, roll back with one env var. **Documented unsupported mix:** `inline` mode is single-session only; running a new broker-mode FE against an `inline` server on the same port is not supported (the tolerant `/health` check in §3.3 surfaces it cleanly rather than spawning a competitor). [Backward-compat-Minor]

---

## 4. Wire protocol

Path-prefix scheme: `/studio/*` (plugin plane) + `/session/*`,`/fe/*` (session plane), with discrete control paths (no `op=` multiplexer). One `http.createServer` on `127.0.0.1:8765`, built from the **extracted** `http-bridge.mjs` helpers.

Every endpoint inherits, in order, before any branch (lifted verbatim from `http-bridge.mjs`): **(1)** host allowlist (`{127.0.0.1:8765, localhost:8765}` else `403 {"error":"forbidden host"}`); **(2)** outer token guard — `guarded` iff path starts with `/studio/`|`/session/`|`/fe/` (i.e. everything except `/health`); `x-mcp-token !== authToken` → `401`; **(2b)** per-session guard — `/session/*` (except none) and `/fe/heartbeat`/`/fe/deregister` additionally require a valid `x-session-token` for the asserted `session_id` → else `401` (§2.7); **(3)** `redactHeaders()` on every log line; **(4)** `readBody` cap (8 MB) / body timeout / `clientError`.

### 4.1 Diagnostic — minimal unauthenticated /health [Security-Important #4; Backward-compat-Minor]
| Method · Path | Response |
|---|---|
| `GET /health` | `200 { ok:true, role:"broker", proto:1, brokerId }` — liveness + role/proto discrimination ONLY. **No `sessions`/`studios`/`draining` counts** in the unauthenticated body (machine-topology reconnaissance removed). `draining` is still observable to a token-holder via `/session/list`. `brokerId` is kept (FEs need change-detection) but is a non-identifying random UUID. Inline mode answers `role:"inline"`. Unguarded. |

### 4.2 Plugin plane (`/studio/*`)
| Method · Path | Request | Response |
|---|---|---|
| `GET /studio/poll` | headers `x-studio-id`, `x-studio-label?`, `x-mcp-token?` (URL **unchanged**, no query, `nocache=true`) | Upsert studio, `lastPollAt=now`, `tick`, `maybeAutoPair`. If `contested` (§2.6) → hold (return `{}`). Else if studio `pending.length>0` → `200 {id,type,payload}`. Else park a **per-studio** waiter ≤10 s → command or `200 {}`. Missing `x-studio-id` → `legacy:default`. |
| `GET /studio/control-poll` | headers as above | NEW. Short long-poll for control commands only (`__assign_studio_id`, `__stop_play`). Returns `{id,type,payload}` from a **separate per-studio control queue** or `{}`. Never blocked by command-loop handlers. Also bumps `lastPollAt`. |
| `POST /studio/result/<id>` | header `x-studio-id`, body = result JSON | `inFlight.get(id)`; **owner-check rejects only when the id maps to a DIFFERENT still-live studio's command** (a re-keyed/reassigned id whose `studioId` was atomically updated matches fine — §2.5/§2.3). On match: `clearTimeout`, delete, `resolve(JSON.parse(body||"{}"))`. Unknown id → `console.error("late result for <id>…")` + `200 {ok:true}` (**C1 late-result log preserved verbatim**, verified `http-bridge.mjs:157`). |
| `POST /studio/register` *(optional)* | `{ studio_id, studio_label? }` | `200 { ok:true, paired_session:string|null }`. Plugin MAY skip and rely on first poll. |

> **Legacy compat shim:** bare `GET /poll` and `POST /result/<id>` (no `/studio` prefix) are aliased to the `/studio/*` handlers with `studio_id="legacy:default"`. The aliases are in the **guarded** set and accept the same `x-mcp-token`, so a token-using user who upgrades the server but not the plugin keeps working with byte-identical auth (no surprise 401s). [Backward-compat-Minor #6]

### 4.3 Front-end plane (`/session/*`, `/fe/*`)
| Method · Path | Request | Response |
|---|---|---|
| `POST /fe/register` | `{ session_id, kind, label, pid, cwd, target? }` (+`x-session-id`) | `200 { ok:true, brokerId, session_token, paired_studio_id, origin }` (mints/returns `session_token`) · `409 {ok:false, error:"session_id_in_use", suggested:<uuid>}` (live under a different pid → FE adopts `suggested`, rewrites file, re-registers) · `503 {error:"broker draining"}`. Idempotent on same id+pid (returns the same token). |
| `POST /fe/heartbeat` | `{ session_id }` (+`x-session-token`) | `200 { ok:true, brokerId, paired_studio_id, origin }`. Free-running every `FE_HEARTBEAT_MS` (§3.6.1); resets `idleSince` + `SESSION_STALE`; `brokerId` change ⇒ FE re-registers. |
| `POST /session/submit` | `{ session_id, type, payload, target?, timeout_ms? }` (+`x-session-token`) | `r = resolveTarget(session_id, target)`. Error → `200 JSON(r)` (delivered to the MCP tool as a normal `{error,code}` object — **mirrors today's `{error:"timeout…"}` contract; never an HTTP error**). Else `200 JSON(await enqueueToStudio(...))`. `target:"all"` fans out (§6.5). Malformed/missing `type` → `400 {error:"bad request",code:"BAD_REQUEST"}`. |
| `GET /session/<sid>/status` | (+`x-session-token`) | Backs `get_connection_status`. Returns the **studio-scoped** five legacy fields (§4.3.1) plus additive pairing fields. |
| `GET /session/list` | (+`x-session-token`) | `200 { studios:[…], sessions:[…], pairs:[…], you:{session_id, paired_studio_id} }`. Labels display-de-duped with `(2)`,`(3)`. `origin:"auto"|"manual"` surfaced per pair (so a human can spot an unexpected auto-pair). [Security-Important #3] |
| `POST /session/pair` | `{ session_id, target }` | `200 { ok:true, pair:{…}, detached_from? }` or error envelope (§5.5). |
| `POST /session/unpair` | `{ session_id, target? }` | `200 { ok:true, detached, released_claim, studio_id|null }`. Idempotent; does NOT auto-re-pair. |
| `POST /session/attach` | `{ session_id, target, claim?:{mode,label,ttl_ms} }` | Pair + optional claim. `200 { ok:true, studio_id, label, claim?, warning? }` or error. |
| `POST /session/detach-studio` | `{ session_id, studio_id }` | Admin steal: forcibly free a studio paired/claimed by **another** session (explicit). `200 { ok:true, freed:{studio_id, former_session_id} }`. |
| `POST /fe/deregister` | `{ session_id }` (+`x-session-token`) | Best-effort on stdio close (200 ms). Frees pair + claim; enables idle-reap. |

**Command wire shape UNCHANGED:** `{ id, type, payload }`. The plugin's `executeCommand` path needs zero change for normal commands. `enqueueToStudio` is today's `submit` body with `pending[]`/`waiters[]` taken from the resolved studio's `CommandQueue`:

```
function enqueueToStudio(studio, type, payload, timeoutMs) {
  return new Promise((resolve) => {
    const id = randomUUID(), cmd = { id, type, payload };
    const timeout = setTimeout(() => {
      inFlight.delete(id);
      studio.queue.removePending(id);
      resolve({ error:`timeout after ${timeoutMs}ms — [roblox-mcp] studio ${studio.id} busy (queued:${studio.queue.pending.length}, inFlight:${countInFlight(studio.id)}) — is the plugin connected?`, code:"TIMEOUT" });
    }, timeoutMs);
    inFlight.set(id, { resolve, timeout, studioId: studio.id });
    studio.queue.deliverOrQueue(cmd);   // hands to a live parked waiter, else pushes to pending
  });
}
```

#### 4.3.1 `get_connection_status` keeps STUDIO-scoped semantics [Protocol-Minor #9; Backward-compat-Important #3]
The five legacy fields describe the **studio's total state**, not "my slice", so `ready` keeps meaning "this studio can take my command now" (what callers actually gate on, and honest under mode-3 fan-in where another session may be running a command):
- `queued = studio.queue.pending.length` (total), `inFlight = total in-flight for that studio across all sessions`, `pluginConnected = (now-lastPollAt < PLUGIN_STALE_MS) || hasInFlight(studio)`, `msSinceLastPoll`, `ready = pluginConnected && queued===0 && inFlight===0`.
- Additive: `studio_id?`, `studio_label?`, `paired`, `origin`, `mode:"auto"|"manual"|"unpaired"|"ambiguous"`, `session_id`, `session_label`, and optional `myQueued`/`myInFlight` slice. Unresolvable → `{pluginConnected:false, msSinceLastPoll:null, queued:0, inFlight:0, ready:false, paired:false, error, code}`.
- **`getStatus()` always returns a Promise** (even in the in-proc `connectLocal` path, to keep one contract), and `server.mjs`'s sole call site (verified `server.mjs:237`, `const status = getStatus()`) becomes `const status = await getStatus()`. A test asserts the output is a plain object with the five legacy keys and is NOT a thenable. This is a **required two-line change** (handler + signature), not "one await added." [Backward-compat-Important #3]

### 4.4 Dropped long-poll reaping in `createCommandQueue` [Protocol-Important #5]
Generalizing one `waiters[]` to N per-studio queues multiplies a latent bug: a parked waiter holding a dead `res` (Studio closed / network blip — common in the very multi-studio churn this introduces) would be handed a command via `waiters.shift()(cmd)` that goes nowhere, and the command is lost (not in `pending`, not redelivered) until its `inFlight` timeout. Fix, implemented once in the shared factory (so inline + broker both benefit):
- On parking a waiter: `req.on("close", …)` removes it from `waiters` and clears its timer.
- On delivering: wrap `res.end` in try/catch; on failure **re-queue the command at the FRONT of `pending[]`** (next live poll gets it) instead of dropping it.

---

## 5. Pairing state machine + resolution

Pure `server/lib/registry.mjs` (`createRegistry({ now, …thresholds })`); `now()` injected; `tick(now)` runs sweeps. Single source of truth for `sessions`, `studios`, `pairs`, `claims`.

### 5.1 Records
```js
SessionRecord = { sessionId, sessionToken, label, cwd, pid, kind, firstSeenAt, lastSeenAt, pairedStudioId|null, state }
StudioRecord  = { studioId, label, placeId, connIds:Set, lastPollAt, pairedSessionId|null,
                  legacy:bool, contested:bool, claim|null, state, queue /*CommandQueue*/ }
PairRecord    = { sessionId, studioId, boundAt, origin:"auto"|"manual" }
```
Invariant (enforced synchronously on every mutation): each `sessionId` and each `studioId` appears in AT MOST one `PairRecord` (strict 1:1). `pairedStudioId`/`pairedSessionId` are O(1) caches kept in lockstep.

### 5.2 State per side (driven by `tick`)
```
live  --(now-lastSeenAt ≥ STALE_MS, AND no in-flight)--> stale
stale --(any contact OR gains in-flight)-->              live (lastSeenAt=now; PairRecord untouched)
stale --(now-lastSeenAt ≥ DROP_MS, AND no in-flight)-->  DROPPED (record + PairRecord deleted; partner unpaired)
```
In-flight overrides stale/drop (§3.6). Pairing survives the stale↔live bounce; only DROP dissolves it. A stale side is excluded from *auto-pair eligibility* but its existing pair routes the instant it bounces live.

### 5.3 Auto-1:1
```
maybeAutoPair(now):
  S = sessions{state==="live" && pairedStudioId===null}
  T = studios{state==="live" && pairedSessionId===null && !contested}
  if (S.length===1 && T.length===1) bindPair(S[0], T[0], now, "auto")
```
Fires iff exactly one live-unpaired session AND one live-unpaired non-contested studio. The instant a 2nd of either appears it stops; established pairs are sacrosanct (only explicit detach/`detach-studio` or a DROP dissolves them). `origin:"auto"` is surfaced in `list_studios`/`session_status` so an unexpected auto-pair is visible. [Security-Important #3]

### 5.4 `resolveTarget(session_id, explicitTarget?, now)` — explicit > bound > auto > error
```
touchSession(session_id, now)
1. if explicitTarget != null:                     // mode-2 per-call override; bypasses sticky-pair ownership BY DESIGN
     r = resolveStudioRef(explicitTarget)          // id-exact > exact-label > ci-substring (§5.6)
     if r.error: return r
     // still subject to the §6 exclusive-claim gate at enqueue; soft-claim/owned → warning
     return { ok:true, studioId:r.studioId, via:"explicit", warnIfOwnedByOther:true }
2. sess = sessions.get(session_id)
   if sess?.pairedStudioId:
     st = studios.get(sess.pairedStudioId)
     return st ? { ok:true, studioId:st.studioId, via:"pair", studioState:st.state }
               : { error:"PAIR_TARGET_GONE", code:"PAIR_TARGET_GONE", ... }
3. auto = maybeAutoPair(now)
   if auto?.sessionId === session_id: return { ok:true, studioId:auto.studioId, via:"auto" }
4. return buildNoTargetError(session_id, now)       // NO_TARGET + candidate list
```
`via:"pair"` with `studioState:"stale"` is still routed (queued; runs if it bounces within the submit timeout, else TIMEOUT) — preserving today's "queue while briefly disconnected" forgiveness. The §2.7 token gate runs **before** `resolveTarget`.

### 5.5 Error envelope (returned verbatim as the MCP tool result)
```json
{ "error":"<CODE>", "message":"<human sentence>", "candidates":[...], "hint":"<what to do>" }
```
Codes: `NO_TARGET`, `AMBIGUOUS_TARGET`, `UNKNOWN_TARGET`, `STUDIO_BUSY` (attach onto another's studio; `occupiedBy:{sessionId,label}`, no steal), `PAIR_TARGET_GONE`, `STUDIO_LOCKED` (exclusive claim held by another — §6), `STUDIO_OFFLINE`, `NO_BROKER`, `TIMEOUT`, `BAD_RESULT`, `BAD_REQUEST`, `TARGET_ALL_NOT_ALLOWED`.

### 5.6 Target resolution rules (shared by `pair`/`attach`/explicit `target`)
1. exact `studioId` → that studio (id-precedence, tried first).
2. else exact label (case-sensitive) → unique? that : `AMBIGUOUS_TARGET`.
3. else case-insensitive substring on label → exactly one? that : `AMBIGUOUS_TARGET`.
4. literal `"auto"` → `maybeAutoPair` else `AMBIGUOUS_TARGET`.
5. literal `"all"` → valid only as a per-call data-tool `target` (fan-out); `attach` → `TARGET_ALL_NOT_ALLOWED`.
6. no match → `UNKNOWN_TARGET` (candidates = all live studios).

**Ownership reconciliation [Protocol-Important #6]:** `attach_studio` (sticky) onto a studio paired to another session → `STUDIO_BUSY`, no steal (edge #22). A **per-call explicit `target`** (transient, mode-2) deliberately **bypasses** sticky-pair ownership — that is its purpose — but it is still gated by the §6 exclusive claim and, when it lands on a studio owned/soft-claimed by another session, the result carries `warning:"TARGETING_OWNED_STUDIO"` (mirrors the soft-claim warning). So #22's protection is specifically about `attach`, not about the transient escape hatch; both are now stated explicitly.

### 5.7 Reconnect & restart semantics
- Plugin drops < `STUDIO_DROP_MS` (now 120 s), same id: stale→live next poll, **same pair resumes**, no prompt; an in-flight command keeps the studio live regardless.
- Plugin gone > `STUDIO_DROP_MS` (and no in-flight): dropped, pair dissolved; session's call → `PAIR_TARGET_GONE`; on return it's a fresh unpaired studio.
- Plugin returns with a different `studio_id` (settings wiped): new studio; old ages out.
- FE MCP restart (same cwd): `session_id` re-read → same id → pairing survives; `/fe/register` idempotent (same `session_token`).
- **Broker restart:** in-memory state lost; FEs + plugins re-register lazily (≤2.5 s / ≤0.5 s); auto-1:1 re-fires for the single-pair topology (zero-config recovery). Multi-way `pairs.json` restart recovery is **deferred to v2** (auto-1:1 covers the dominant single-pair restart with zero config).

### 5.8 In-flight commands when a pairing changes
Routing is decided **once** at submit time and never re-evaluated. A command in studio A's queue completes against A; new commands go to B (matches today's send-where-submitted). On studio DROP with commands queued, the existing TIMEOUT path fails them; the `tick` `dropped` event lets the bridge short-circuit those waiters immediately.

### 5.9 Play-mode stop — cross-session abort via the control loop [Concurrency-Critical #3]
`start_stop_play{mode:"stop"}` is special-cased at the dispatch chokepoint: it is enqueued onto the target studio's **control queue** (delivered via `/studio/control-poll`, which keeps running while the command loop is blocked in `ExecutePlayModeAsync`), where the plugin's `__stop_play` handler sets `plugin:SetSetting("MultiAI_StopPlaySignal", true)`. The existing Server-context watcher then `EndTest`s — **unchanged**. This makes a *second* session's stop actually take effect during the first session's play test (previously undeliverable, because the command loop was yielded).
- The broker holds NO stop state (the per-Studio cross-context mechanism stays entirely intra-Studio).
- The exclusive claim (§6) additionally **blocks a second session from starting a competing play command**, which is the real N3 hazard; stop-during-play now works regardless of claims.
- Best-effort caveat documented: if the control loop is itself momentarily disconnected, stop takes effect on its next control poll (≤ `CONTROL_POLL_MS`), not instantly.

---

## 6. Concurrency + control-plane

### 6.1 What single-queue execution already guarantees (mode-3 foundation)
One plugin command-loop coroutine runs `GetAsync→executeCommand→PostAsync` sequentially. Per studio: **G1** command atomicity (each mutating handler is one `withRecording` ⇒ one undo step regardless of attached sessions); **G2** FIFO-per-arrival (the per-studio `pending[]` serializes; results never cross-deliver because id→resolver lives in broker-global `inFlight`). Uncovered hazards (the real mode-3 risk): **N1** semantic clobber, **N2** read-modify-write races, **N3** one session flips play under another. v1 makes these visible and, opt-in, preventable.

### 6.2 The claim (soft lease)
`Claim = { studioId, sessionId, label, mode:"soft"|"exclusive", ttlMs, expiresAt, acquiredAt }`; at most ONE active claim per studio (reader/writer locks deferred to v2). TTL default 60 000, clamp [5 000, 600 000]. **Lazy expiry:** every read of `studio.claim` first checks `Date.now()>expiresAt` and deletes if so (a crashed holder never wedges a studio; no background timer; preserves zero-dep). Renew by re-`attach` (idempotent); `detach` releases.
- **soft (default):** advisory; does NOT block; a 2nd soft claimant gets `warning:"CLAIM_HELD"`. Surfaces N1/N2 so an orchestrator can serialize voluntarily.
- **exclusive:** ENFORCED at the enqueue gate — a data command from `sessionId !== claim.sessionId` (incl. via per-call `target`) is rejected **before enqueue** with `{error:"studio_locked", code:"STUDIO_LOCKED", heldBy, expiresAt}`. Control-plane calls (list/status/detach/attach) are NEVER blocked. Check-and-set is atomic (single-threaded, no `await` between check and set).

Fan-in recommendation: the play-driving session SHOULD take an exclusive claim for the play duration (opt-in/recommended, never auto — claims should not surprise multi-session users; RESOLVED §13 #6).

### 6.3 Where the FIFO serializer lives
The per-studio FIFO queue (ordering, the only mechanism needed for *correctness*) lives in the **transport/queue layer** (`CommandQueue` per `Studio`). The registry only guarantees `resolveTarget` returns the right `studioId`. The claim layer is opt-in *isolation* on top. No round-robin/quota scheduling in v1 (FIFO arrival is the contract); deferred to v2.

### 6.4 Control-plane MCP tools (flat snake_case, matches the 76-tool convention)
| Tool | Args | Routes to | Purpose |
|---|---|---|---|
| `list_studios` | `{}` | `GET /session/list` | Enumerate studios+sessions+pairs+claims (+`origin`); never blocked. `attachedSessions:[{sessionId,label,isSelf,claim?}]` per studio (pull-based who-is-attached; transport is poll-only). |
| `attach_studio` | `{ target!, claim?:{mode?,label?,ttl_ms?} }` | `POST /session/attach` | Sticky pairing + optional claim (the manual-override half of auto-1:1). |
| `detach_studio` | `{ target? }` | `POST /session/unpair` (self) or `/session/detach-studio` (admin/steal) | Drop sticky pairing + release own claim. Admin form frees another session's studio (only way to break another's pair; explicit). |
| `session_status` (alias `whoami`) | `{}` | `GET /session/<sid>/status` | What am I paired to, what do I hold, who else is here. Read-only. |

Handled as new top-level cases in the `server.mjs` CallTool switch, talking to broker control endpoints (never a plugin) — analogous to how `get_connection_status` is answered from server state today. Four discrete tools (not one `op`-multiplexer): clearer schemas, invisible in the single-session flow; 76→80 tools accepted.

### 6.5 Per-call `target` injected without editing 76 definitions; submit() byte-identical [Protocol-Critical #1]
**Schema side** (`tools.mjs`): one module-load transform wraps every tool except `CONTROL_OR_OS_LOCAL`:
```js
const TARGET_PROP = { target: { type:"string",
  description:"Optional studioId or studio label to route this call to (multi-studio). Omit to use your attached/auto-paired studio." } };
export const TOOLS = RAW_TOOLS.map(t => CONTROL_OR_OS_LOCAL.has(t.name) ? t
  : { ...t, inputSchema:{ ...t.inputSchema, properties:{ ...t.inputSchema.properties, ...TARGET_PROP } } });
```
`CONTROL_OR_OS_LOCAL` = the 4 control tools + `get_connection_status` + OS-local tools that never touch a plugin (`take_screenshot`, `capture_studio_window`, `screenshot_diff`, `simulate_input`).

**Dispatch side** (`server.mjs`): ONE chokepoint at the existing `submit(name, payload, …)` tail. The public **`submit(type, payload, timeoutMs)` stays byte-identical** (verified called at `server.mjs:678` and at `:132` by `importViaEditableMesh` with no target). A new internal **`submitTo(studioId, type, payload, timeoutMs)`** carries the resolved studio:
```js
const sel = await resolveTarget(sessionId, args.target);   // typed error for NO_TARGET/AMBIGUOUS/STUDIO_LOCKED
if (sel.error) return sel;                                  // delivered as a normal tool result object
if (sel.fanout) return fanoutSubmit(sel.studioIds, name, payload, toolTimeoutMs(name, args));
return await submitTo(sel.studioId, name, payload, toolTimeoutMs(name, args));
```
- `submit(type,payload,timeout)` is retained as `submitTo(resolveDefault(sessionId), …)` so **`importViaEditableMesh` and every existing call compile untouched.** `args.target` is read but **never** written into `payload` — every plugin handler is untouched.
- **Multi-batch pinning:** `importViaEditableMesh` issues several `submit('editable_mesh_build', …)` calls; all must hit ONE studio. The chokepoint resolves the studio **once** at the start of the composite and passes that fixed `studioId` to every batch's `submitTo`, so a mid-sequence re-pair cannot split a mesh across two studios. [Protocol-Critical #1]
- `target:"all"` → `fanoutSubmit` (`Promise.all` per studio, never throws) → `{ fanout:true, results:[{studioId,label,result}], ok, failed }`; when `fanout` is absent (common case) the result shape is exactly today's. OS-local tools get no `target` (multi-studio screenshot routing deferred; the tester foregrounds the intended Studio first).

---

## 7. Backward-compat & files

### 7.1 Single-session zero-config proof (hard constraint 1) — honest latency claim [Backward-compat-Minor #7]
1. One FE starts → **direct bind win** → `LEADER_INPROC` → `CONNECTED`. **One process**, no detached child, no spawn (STEP A short-circuits before STEP C), `connectLocal` short-circuits `submit()` to the in-memory core. **Process count + latency identical to today** for this case.
2. One plugin polls (real `studio_id` or `legacy:default`). `maybeAutoPair` fires 1×1 — silent.
3. `submit` flows FE→(in-proc core)→studio queue→`/studio/poll`→`/studio/result`. Wire shape and `/result` posting unchanged; handlers byte-identical.
4. `get_connection_status` answered from broker state (never reaches the plugin), returning the five legacy studio-scoped fields (§4.3.1) plus additive pairing fields; `getStatus()` is awaited (§4.3.1).
5. Session exits → in-proc broker idle-reaps / dies on stdio close.
6. `ROBLOX_MCP_MODE=inline` is the one-env-var rollback.

**Honest scope:** "identical latency/process count" holds for the **single-session in-proc-leader** case only. Additional sessions pay a one-time election/spawn cost (<2 s worst case, typically <100 ms) and a sub-ms loopback hop per call thereafter — well within `DEFAULT_TIMEOUT_MS` (30 s). §8 reflects this.

### 7.2 New files (zero-dep, `node --test`-able)
| File | Role |
|---|---|
| `server/broker.mjs` | Broker entrypoint. `node:*` + extracted helpers + `broker-core.mjs`. NO SDK. EADDRINUSE → exit 0. |
| `server/lib/broker-core.mjs` | Builds its OWN `http.createServer` for the §4 endpoints around the registry + per-studio `CommandQueue`s + sweep/idle/election helpers. Uses extracted hardening helpers. |
| `server/lib/registry.mjs` | Pure `createRegistry` — §5 pairs + §6 claims, `now()`-injected, no I/O. Most test-critical. |
| `server/lib/command-queue.mjs` | `createCommandQueue()` — `pending`/`waiters`/`inFlight`/timeout/late-result **factored verbatim** out of `createBridge`, **plus the dropped-waiter reaping fix (§4.4)**, per studio. |
| `server/lib/broker-client.mjs` | `ensureBroker()`/`createBrokerClient()` — election + the FE's `{ submit, submitTo, getStatus(async), heartbeat, register, deregister, … }` (drop-in superset of what `createBridge` returns). |

### 7.3 Edited files
- **`server/server.mjs`:** replace `const { submit, getStatus } = createBridge({...})` (~lines 39–43) with the mode switch → `ensureBroker({port, authToken, brandPrefix, sessionId})` (broker) or `createBridge(...)` (inline). `submit(type,payload,timeout)` byte-identical; **`getStatus` becomes `await getStatus()` at the sole call site `:237` (required, not optional)**; add `submitTo` + the `resolveTarget` chokepoint (§6.5); special-case `start_stop_play{stop}` → control queue (§5.9); add the 4 control-tool cases. 600+ lines of tool dispatch otherwise untouched.
- **`server/lib/http-bridge.mjs`:** **PURE EXTRACTION ONLY.** Factor `readBody`, `redactHeaders`/`SENSITIVE_HEADER_RE`, host-allowlist check, token guard, `clientError`, EADDRINUSE handler, and a `createCommandQueue()` factory into **additive exported helpers**. `createBridge` MUST keep returning `{ httpServer, submit, getStatus }` with identical signatures and identical endpoint behavior (header mandates bit-identical to b2b4794). The Blender server's `createBridge` call site (verified `blender/server.mjs:13`) is **unchanged**. Regression gate: run the existing `http-bridge.test.mjs` AND the Blender smoke test before/after. [Backward-compat-Minor #8]
- **`tools.mjs`:** append 4 control tools; one module-load `target`-injection transform (§6.5).
- **`plugin/MultiAIPlugin.lua`:** re-scoped to **~40–50 lines** [Backward-compat-Important #4], spelled out: (a) mint+persist `studio_id` (§2.1, `pcall`-guarded); (b) `requestHeaders()` that **re-reads the live `studioId` upvalue every call** and always sends `x-studio-id` (+ token when set), attached to BOTH `/studio/poll` and `/studio/result` — **URL string + `nocache=true` unchanged**; (c) add `__assign_studio_id` and `__stop_play` to the `handlers` table (real dispatched commands) with the upvalue-mutating behavior of §2.6; (d) a second `task.spawn` **control loop** hitting `/studio/control-poll` at `CONTROL_POLL_MS` (§2.6.1). The Server-context `StopPlaySignal` watcher (`:41–51`, separate `task.spawn`) is **verified untouched**. Single-file install preserved (`sync-plugin.ps1` copies the same one file).

### 7.4 Env vars
| Var | Default | Meaning |
|---|---|---|
| `ROBLOX_MCP_PORT` | 8765 | Broker port (single source; FE + broker derive identically). |
| `ROBLOX_MCP_TOKEN` | — | Outer `x-mcp-token`; FE sends on `/session/*`+`/fe/*`, plugin on `/studio/*`. Unset → no outer token (= today), but the per-session `session_token` layer (§2.7) is always in force broker-side. Broker inherits via the allowlisted spawn env. |
| `ROBLOX_MCP_MODE` | `broker` | `broker` | `inline` (rollback, §3.8). |
| `ROBLOX_MCP_SESSION_NAME` | — | Overrides `session_label` verbatim. |
| `ROBLOX_MCP_BROKER_IDLE_MS` | 90000 | `IDLE_REAP_MS` override. |
| `ROBLOX_MCP_TARGET` | — | Pin one studio for ALL of a session's calls (mode-2 convenience). |

> **Token-mismatch handling:** a 2nd FE with a different `ROBLOX_MCP_TOKEN` than the running broker gets `401` on `/fe/register`; `broker-client` throws `"broker token mismatch; restart broker or align ROBLOX_MCP_TOKEN"` and does NOT spawn a second broker.

### 7.5 Blender twin — deferred to v2 (§14)
Same `createBroker`/`createBrokerClient`/`createRegistry`/`createCommandQueue` on 8766, `brandPrefix:"[blender-mcp]"`, env `BLENDER_MCP_*`, header `x-blender-addon` (persisted addon-side, mirroring §2.1), separate process + registry. The only Blender-specific work is the header name + env prefix. Ship Roblox first.

---

## 8. Consolidated edge-case table

| # | Scenario | Handling |
|---|---|---|
| 1 | Single session + single studio, zero config | In-proc leader (direct bind); `maybeAutoPair` 1×1 silently; `via:"pair"` thereafter. One process. **Byte-identical + identical latency to today.** |
| 2 | Two sessions start same ms | Kernel: exactly one `listening`/one `EADDRINUSE` on a **direct** bind. Winner→in-proc; loser→STEP B connect (1 s retry covers the listen-attach gap). |
| 3 | Loser connects in the bind gap → ECONNREFUSED | STEP B retries 20×50 ms; else STEP C spawns detached + 2 s connect; only then fatal. |
| 4 | Port held by an **unrelated** process | `/health` role/proto mismatch → FATAL exit 1. Never spawns on a different port. |
| 4b | Port held by an **older same-family** server | `/health` `{ok:true}` w/o role/proto → clear "restart older server" error; no competitor spawned. |
| 5 | In-proc leader's host session exits with other FEs attached (v1, no promotion) | Attached FEs hit ECONNREFUSED → re-election; a survivor re-elects. ~2–2.5 s blip. |
| 6 | Broker crashes with commands in flight | Each submit's `setTimeout` resolves TIMEOUT; FE maps ECONNREFUSED → `{error:"broker connection lost — rerun the tool"}`. No at-most-once; writes undo-wrapped. |
| 7 | Idle broker about to reap, late poll/register | `draining=true` → new submit/register get 503; `/studio/poll` returns `{}`; broker won't exit while `inFlight>0` (cap `DRAIN_CEILING_MS`). |
| 8 | Two windows of same place share persisted `studio_id` | Overlapping-poll detection marks `contested`; commands held; `__assign_studio_id` (fresh GUID) delivered to the 2nd connId via control loop; plugin persists + mutates upvalue + re-polls. Windows diverge permanently. |
| 8b | Contested studio while one window blocked in play | `__assign_studio_id` delivered on the never-blocked **control loop**; no command theft (all held). |
| 9 | Studio restart / window reopened (same id, new socket) | No second live connId → not contested → keeps id + pairing. |
| 10 | Play↔Edit transition | `SetSetting` persists `studio_id`; same id both contexts; no re-pair. |
| 11 | FE MCP restarts (same cwd) | `session_id` re-read → same id → pairing survives; `/fe/register` idempotent (same `session_token`). |
| 12 | Two FEs share one `session_id` | `409 session_id_in_use` + `suggested`; 2nd FE adopts, rewrites file, re-registers. Self-heals. |
| 13 | Legacy plugin (no `x-studio-id`) + legacy session | **Single** `legacy:default` studio + `session:legacy`; auto-1:1 pairs them; byte-identical to today's single global queue (NOT per-connId — no churn). |
| 14 | Plugin upgraded legacy→v2 mid-run | Real id on the loop that was `legacy:default` → broker re-keys atomically (moves `pending`/`waiters`/pair, rewrites `inFlight[id].studioId`, re-points parked waiters). |
| 15 | ≥2 sessions AND ≥2 studios, none paired | `maybeAutoPair` never fires; targetless submit → `NO_TARGET` w/ candidates; agent calls `attach_studio` or passes `target`. |
| 16 | 2nd studio connects while a pair exists | 0 live-unpaired sessions → no fire; existing pair untouched; new studio unpaired. |
| 17 | 2nd session connects while the one studio is paired | 0 live-unpaired studios → no fire; new session's targetless submit → `NO_TARGET` (fan-in must be explicit). |
| 18 | Plugin drops <120 s, returns same id | stale but pair preserved; next poll → live; queued commands run within timeout; in-flight keeps it live regardless. |
| 18b | **Long play command (45 s) makes command loop silent** | In-flight override keeps the studio live + `pluginConnected:true`; sweep never drops it; idle-reap blocked (`inFlight>0`). [Concurrency-Critical #1] |
| 19 | Plugin gone >120 s (no in-flight) | Dropped, pair dissolved; session's call → `PAIR_TARGET_GONE`; on return a fresh unpaired studio. |
| 20 | `attach_studio` target = an id AND another's label | id-exact wins (precedence). |
| 21 | `attach_studio` by a label shared by 2 studios | `AMBIGUOUS_TARGET` w/ candidate ids. |
| 22 | `attach_studio` onto a studio paired to another session | `STUDIO_BUSY` (`occupiedBy`), no steal; must `detach_studio` (admin) first. |
| 22b | Per-call `target` at a studio owned by another | Allowed (mode-2 escape hatch), **subject to exclusive-claim gate**; `warning:"TARGETING_OWNED_STUDIO"`. Distinct from #22 (attach=sticky). [Protocol-Important #6] |
| 23 | Paired session re-`attach`es elsewhere | Old pair removed, new formed, `detached_from` noted. |
| 24 | `detach` then targetless submit | No auto-re-pair; `resolveTarget` step 3 fires `maybeAutoPair` only if now 1×1. |
| 25 | Explicit `target` on a paired session | Branch 1 for that one call; sticky pair intact for later untargeted calls. |
| 26 | Command in A's queue when session re-points to B | Routing decided once at submit; queued command completes against A. |
| 27 | Late `/studio/result/<id>` after timeout | No `inFlight` entry → `console.error("late result…")` + `200 {ok:true}` (C1 preserved). |
| 28 | Result posted with a re-keyed/reassigned `x-studio-id` | Owner-check rejects only if the id maps to a DIFFERENT still-live studio; a migrated id (whose `studioId` was atomically rewritten) matches and resolves. [Protocol-Minor #7] |
| 29 | Session A holds exclusive claim; B targets A's studio (incl. per-call `target`) | Rejected at enqueue `STUDIO_LOCKED`; never queued. B can still list/status. |
| 30 | Exclusive holder crashes (zombie lock) | Lazy TTL expiry on every claim read frees it; `detach` frees immediately. No timer. |
| 31 | Two sessions race exclusive claim | Single-threaded check-and-set: first ok, second `STUDIO_LOCKED`. |
| 32 | Two sessions want a soft claim | One claim record; 2nd gets `ok:true, warning:"CLAIM_HELD"`; both shown attached. |
| 33 | `target:"all"` fan-out, one studio offline | `Promise.all` per-studio; offline → `{error:"studio_offline"}`, timeout → TIMEOUT string. Aggregate resolves. |
| 34 | **Cross-session stop during play** | S2's `start_stop_play{stop}` → control queue → `/studio/control-poll` (unblocked) → `__stop_play` arms `SetSetting` → Server-context watcher `EndTest`s. [Concurrency-Critical #3] |
| 34b | Second session tries to start a competing play | Recommended exclusive claim blocks it (`STUDIO_LOCKED`) — the real N3 guard. |
| 35 | OS-local tools under multi-studio | In `CONTROL_OR_OS_LOCAL`, no `target`; operate on the frontmost window. Multi-studio screenshot routing deferred. |
| 36 | `get_connection_status` when paired studio is stale | Returns the paired studio (`paired:true`) `pluginConnected:false, ready:false, msSinceLastPoll:<actual>` — "my studio is offline", studio-scoped semantics (not "my slice"). [Protocol-Minor #9] |
| 37 | `ROBLOX_MCP_MODE=inline` with the new plugin | Inline binds 8765, ignores `x-studio-id`, 404s `/studio/control-poll` (harmless); fatal EADDRINUSE; full pre-broker behavior. |
| 38 | Token mismatch (2nd FE differs from broker) | `/fe/register` 401 → FE throws "broker token mismatch…"; no 2nd broker. |
| 39 | `GenerateGUID`/`SetSetting` fails in plugin | `pcall`; id minted per-load (non-persistent fallback); polling works, only loses pairing stability across reloads — no worse than today. |
| 40 | `tick()` never scheduled | live/stale computed on the fly (+ in-flight override) in reads → never mis-routes; only DROP delayed. Broker also ticks on each poll. |
| 41 | Malicious/oversized id or label | Validated `/^[0-9a-fA-F:\-]{8,64}$/`; labels truncated 80 + control-stripped (registry AND before any log), `x-studio-label` capped 160 B. Host allowlist + token + redaction unchanged. |
| 42 | Non-loopback Host header | `403 {"error":"forbidden host"}` on every new endpoint. |
| 43 | Rogue local process impersonates a `session_id` | Rejected: `/session/*` requires the minted `x-session-token` bound to `(session_id,pid)`; can't ride another session's pairing or target. [Security-Critical #1] |
| 44 | Rogue process registers as "the" session to grab the lone studio | Registration requires the outer token (when set) and yields its own `session_token`; auto-pair is surfaced with `origin:"auto"` + peer label so a human/agent notices; `ROBLOX_MCP_REQUIRE_EXPLICIT_PAIR` can disable silent auto-pair. [Security-Important #3] |
| 45 | Detached broker env capture | Allowlisted spawn env; Open Cloud key + `*_KEY` never copied; test asserts absence. [Security-Critical #2] |
| 46 | Detached spawn fails on a Drive-junction cwd | Explicit `cwd = broker.mjs dir`; first-spawn stderr → redacted `broker-spawn.log` (no silent 2 s-then-FATAL). [Backward-compat-Critical #1] |
| 47 | Dropped long-poll socket while a waiter is parked | `req.on("close")` reaps the waiter; delivery wraps `res.end` in try/catch and re-queues at the FRONT of `pending`. [Protocol-Important #5] |
| 48 | Unauthenticated `/health` reconnaissance | `/health` returns only `{ok,role,proto,brokerId}` — no session/studio counts; topology is behind the token-guarded `/session/list`. [Security-Important #4] |

---

## 9. Implementation order (suggested)
1. **Extract** `http-bridge.mjs` helpers + `createCommandQueue` (pure refactor; regression-gate with existing tests + Blender smoke). Add the dropped-waiter fix inside `createCommandQueue`.
2. `registry.mjs` (pure; unit-test pairs/claims/`resolveTarget`/sweep with injected `now`).
3. `broker-core.mjs` + `broker.mjs` (own server, §4 endpoints, contested/control queues, drain/idle).
4. `broker-client.mjs` (`ensureBroker` direct-bind election; integration-test the two-FE race + detached spawn).
5. `server.mjs` wiring (mode switch, `submitTo`, chokepoint, `await getStatus`, control tools, `start_stop_play{stop}`→control).
6. `tools.mjs` (`target` injection + 4 control tools).
7. `MultiAIPlugin.lua` (studio_id, `requestHeaders` live-upvalue, control loop, `__assign_studio_id`/`__stop_play` handlers).
8. Security tests (session_token gate, spawn-env allowlist, redaction on new endpoints, minimal `/health`).

---

## 10. Hard-constraint check
1. **Single session zero-config = today:** §7.1 (in-proc leader, direct bind, auto-1:1, studio-scoped status, identical latency).
2. **Existing security preserved:** host allowlist + token guard + `redactHeaders` + body caps lifted verbatim into the extracted helpers and applied on every new endpoint; **strengthened** with `session_token`, minimal `/health`, allowlisted spawn env.
3. **Zero-dep / `node --test`:** §1.4 (two tiers; pure registry/queue + integration election).
4. **Reuse createBridge primitives:** satisfied at the correct granularity — shared **helpers + `createCommandQueue`**, not the closed server (§7.3, §1.3).
5. **Single-file plugin install:** preserved (`sync-plugin.ps1`, one `.lua`).

---

## 11. Critical/Important findings → resolution map

| # | Lens / Finding | Severity | Where resolved |
|---|---|---|---|
| C-1 | Long command makes a live studio look stale → DROP mid-command | Critical | §3.6 (in-flight is an absolute keepalive; `STUDIO_DROP_MS`→120 000; `pluginConnected` forced true; control loop heartbeat), edge #18b |
| C-2 | `__assign_studio_id` undeliverable while blocked in play; command theft window | Important→Critical-adjacent | §2.6 (contested-by-poll-timing, commands held, inject-ahead) + §2.6.1 (control loop), edge #8/#8b |
| C-3 | Cross-session play-mode stop undeliverable | Critical | §2.6.1 + §5.9 (`__stop_play` on control loop arms `SetSetting`; exclusive claim blocks competing start), edge #34/#34b |
| C-4 | Bind-election TOCTOU double-bind (probe close→rebind; winner self-exits) | Important | §3.2 (bind the REAL server directly; in-proc EADDRINUSE non-fatal, falls to STEP B) |
| C-5 | Idle-reap drains a slow in-flight command / loses results | Important | §3.6 (idle gated on `inFlight===0`; drain stops new dequeues; won't exit while `inFlight>0`; ceiling 60 s), edge #7 |
| C-6 | Per-studio waiter mis-deliver/strand on re-key; reconnect latency understated | Important | §2.5 (atomic re-key moves waiters), §4.4 (drop reaping), §3.7 (~2–2.5 s honest), edge #14/#47 |
| Sec-1 | No per-session authz → cross-session command injection (run_luau) | Critical | §2.7 (minted `session_token`, gate before resolveTarget; default token-required broker), edge #43 |
| Sec-2 | Detached broker inherits full env → leaks Open Cloud key | Critical | §3.4 (allowlisted spawn env; test asserts absence), edge #45 |
| Sec-3 | Auto-1:1 authenticates nothing → silent studio hijack | Important | §2.7 + §5.3 (registration gated; `origin:"auto"` surfaced; `ROBLOX_MCP_REQUIRE_EXPLICIT_PAIR`), edge #44 |
| Sec-4 | Unauthenticated `/health` leaks topology | Important | §4.1 (minimal `{ok,role,proto,brokerId}`; counts behind token), edge #48 |
| BC-1 | Detached spawn path/cwd breaks on Drive-junction; silent fail | Critical | §3.4 (explicit cwd, first-spawn log; STEP A short-circuits so lone user never spawns), edge #46 |
| BC-2 | `?studio_id=` query breaks GetAsync cache; non-fix | Important | §2.1 (header-only; URL + `nocache` invariant) |
| BC-3 | `getStatus()` async contradicts byte-identical claim; Promise leak | Important | §4.3.1 (always-Promise; `await` at `:237`; required two-line change; not-thenable test) |
| BC-4 | Plugin "~15 lines" undercount; `__assign_studio_id` not a handler; upvalue caching | Important | §2.6 + §7.3 (~40–50 lines; handler-table entry; `requestHeaders` re-reads live upvalue) |
| P-1 | `submit()` signature self-contradiction; multi-batch mesh split | Critical | §6.5 (public `submit` byte-identical; new `submitTo`; composite pins one studio) |
| P-2 | `createBridge` cannot host per-studio queues | Critical | §1.3/§7.3 (broker builds own server from extracted helpers + per-studio `createCommandQueue`) |
| P-3 | `__assign_studio_id` round-trip unimplementable vs real loop | Critical | §2.6 (handler-table entry, live upvalue, inject-ahead, ≤0.5 s latency accepted) |
| P-4 | Legacy `connId` keying unstable → breaks auto-1:1 | Important | §2.4 (single `legacy:default`, not per-socket) |
| P-5 | Per-studio waiter leak on dropped long-poll | Important | §4.4 (close-reap + re-queue-at-front in `createCommandQueue`) |
| P-6 | `resolveTarget` explicit-target vs ownership/claim under-specified | Important | §5.6 + §5.4 (explicit bypasses sticky ownership by design; still claim-gated; warning), edge #22b |
| P-7 | Bind close→rebind race (in-proc winner self-exits) | Important | §3.2 (same fix as C-4) |

---

## 12. Minor findings — triage list
- **Concurrency-Minor (#7) migrated-result owner-check:** folded into §2.3/§4.3 (rewrite `inFlight[id].studioId` on re-key; owner-check rejects only a different still-live studio). *Done, not deferred.*
- **Concurrency-Minor (#8) FE heartbeat must be a free-running timer:** stated as a requirement in §3.6.1. *Done.*
- **Backward-compat-Minor (#5) `/health` shape coexistence:** tolerant detection (§3.3), inline emits `role:"inline"`. *Done.*
- **Backward-compat-Minor (#6) legacy alias auth:** aliases in guarded set, same token (§4.2). *Done.*
- **Backward-compat-Minor (#7) latency overstatement:** §7.1 narrowed to in-proc-leader only. *Done.*
- **Backward-compat-Minor (#8) shared-`createBridge` refactor risk to Blender:** §7.3 pure-extraction constraint + Blender smoke as regression gate. *Done.*
- **Security-Minor (#5) label log-injection / unredacted labels:** strip+cap before any log/`broker.log`; never in `/health`; redaction test on new endpoints (§2.8). *Done.*
- **Security-Minor (#6) `__assign_studio_id` weaponization:** plugin-side id validation + rate-limit; ultimately contained by the §2.7 auth layer; never a user tool (§2.6). *Done.*
- **Protocol-Minor (#9) `get_connection_status` "ready" semantics:** studio-scoped totals kept; `myQueued`/`myInFlight` additive (§4.3.1). *Done.*
- **Protocol-Minor testability conflation:** split into pure-unit vs integration tiers (§1.4). *Done.*

(All "Minor" items were folded in rather than left open, since each was a small, localized change.)

---

## 13. Resolved decisions (locked 2026-06-24)
All eight open questions were decided with the user this session. These are now binding requirements, not options:
1. **Machine-token = UNCONDITIONAL default.** ✅ The broker always auto-generates a machine token when `ROBLOX_MCP_TOKEN` is unset; `sync-plugin.ps1` installs it into the plugin's `AUTH_TOKEN`, so even the single-user zero-config case runs authenticated (outer gate never empty). Escape hatch `ROBLOX_MCP_ALLOW_TOKENLESS=1`. Folded into §2.7.
2. **`PROMOTE_ON_SECOND_FE` = OFF (v1).** ✅ In-proc leader dies on host-session exit; survivors re-elect (~2–2.5 s blip accepted). Auto-promotion / handoff-replay deferred to v2.
3. **Idle/keepalive tuning CONFIRMED:** `IDLE_REAP_MS=90 000`, `FE_HEARTBEAT_MS=10 000`, `STUDIO_DROP_MS=120 000`, `CONTROL_POLL_MS=1 000` (table in §3.6 is authoritative).
4. **`pairs.json` multi-way restart recovery = DEFERRED to v2.** ✅ Auto-1:1 covers the single-pair restart with zero config; surviving a broker restart for a *multi-way* topology without re-`attach` is not a day-1 requirement.
5. **Claim granularity = WHOLE-STUDIO (v1).** ✅ Whole-studio soft+exclusive claims + voluntary serialization is sufficient for the ~5-agent target; per-subtree / reader-writer claims deferred to v2.
6. **Tester auto-claim on play = OFF (opt-in/recommended).** ✅ `start_stop_play{start}` does NOT implicitly claim; a session that wants N3 protection takes an exclusive claim explicitly (claims never surprise multi-session users). Folded into §6.2.
7. **Steady-state rolling `broker.log` = ON.** ✅ The detached broker keeps a rolling `%LOCALAPPDATA%/Roblox-MCP/broker.log` (with `redactHeaders` + label-strip) beyond the first-spawn stderr capture.
8. **Studio label = `game.Name + #suffix`.** ✅ `PlaceId` rides only as advisory display data (already in §2.1); no separate config toggle in v1.

## 14. v1 scope vs deferred
- **v1:** single-broker on 8765; direct-bind election + in-proc leader (no auto-promotion); per-cwd `session_id` + `session_token`; header-only `studio_id`; auto-1:1 + manual `attach`/`detach`; per-studio FIFO `CommandQueue` with dropped-waiter reaping; in-flight-keepalive liveness + idle-reap; two plugin poll loops (command + control); `__assign_studio_id` + cross-session `__stop_play`; the 4 control tools + per-call `target` (incl. `target:"all"` fan-out); **soft + exclusive claims (advisory concurrency)**; full security hardening (session_token, allowlisted spawn env, minimal `/health`, redaction on new endpoints).
- **Deferred to v2:** **Blender twin generalization** (8766); **in-proc→detached auto-promotion** (handoff-replay); **`pairs.json` multi-way restart recovery**; **reader/writer (multi-holder) claims and per-subtree/`Workspace.Map` claim granularity**; **round-robin/quota scheduling** (v1 is FIFO-arrival only); **multi-studio OS-local screenshot routing** (v1 tester foregrounds the target Studio).

---

**Files this spec touches (absolute paths):**
- New: `G:\My Drive\Backup\Roblox-MCP-v6\.claude\worktrees\musing-moore-431c1d\server\broker.mjs`, `…\server\lib\broker-core.mjs`, `…\server\lib\registry.mjs`, `…\server\lib\command-queue.mjs`, `…\server\lib\broker-client.mjs`
- Edited: `…\server\server.mjs`, `…\server\lib\http-bridge.mjs`, `…\server\tools.mjs`, `…\plugin\MultiAIPlugin.lua`