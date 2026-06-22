# Blender MCP Bridge + Blender→Roblox Import Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code build a 3D model in Blender and import it into Roblox Studio end-to-end (Blender geometry → `.glb` → Open Cloud upload → `InsertService:LoadAsset` into Workspace), with an EditableMesh fallback when no Open Cloud key is present.

**Architecture:** Twin-bridge. A second MCP server (`blender/server.mjs`, HTTP port 8766) drives a persistent Blender add-on that long-polls it — mirroring the existing Roblox bridge (`server/server.mjs`, port 8765) 1:1. Both bridges compose a newly-extracted shared library `server/lib/http-bridge.mjs` so hardening lives in one place. Three new Roblox-side MCP tools perform the Open Cloud upload + Studio insert.

**Tech Stack:** Node.js (ESM, `node:http`/`node:https`/`node:test`, global `fetch`+`FormData`+`Blob` — Node 18+), Luau (Roblox Studio plugin), Python 3.11/3.12 (Blender 4.5 + 5.0 add-on, `bpy`/`bmesh`/stdlib `http.server`+`queue`+`threading`). Zero new npm/pip dependencies.

## Global Constraints

Every task's requirements implicitly include this section. Values copied verbatim from the spec (`docs/superpowers/specs/2026-06-22-blender-mcp-bridge-design.md`) and the 2026-06-23 grounding research.

- **Refactor-first, behavior-identical:** `server/server.mjs` must behave bit-identically to its `b2b4794` form for every existing endpoint after the shared lib is extracted (spec §14.5).
- **Ports are sacred:** the live Roblox bridge owns `:8765`; the Blender bridge owns `:8766`. **Never bind 8765 or 8766 in tests** — all tests use ephemeral port `0` (OS-assigned) or a subprocess. Verify ownership with `Get-NetTCPConnection -LocalPort 8765 -State Listen`.
- **Secret redaction is a hard requirement:** `ROBLOX_OPEN_CLOUD_API_KEY` flows through the new upload code as an `x-api-key` header. It must NEVER reach any log. `server/server.mjs` currently has **no** redaction — this plan **creates** `redactHeaders()` (research correction: spec said "extend existing"; none exists).
- **Blender add-on must enable on BOTH 4.5 LTS and 5.0.** Verified: every bpy/bmesh API used (`bmesh.new/ops.subdivide_edges/ops.bevel/to_mesh/free`, Boolean modifier `solver='EXACT'`, Array/Mirror/Subsurf, `object.modifier_apply`, `context.temp_override`, `export_scene.gltf`, `render.opengl(write_still=True)`, `app.timers.register`, `ed.undo_push`) is **identical** across 4.5 and 5.0. Add-on is pure-Python (stdlib only) so the 4.5=Py3.11 / 5.0=Py3.12 split is irrelevant. Legacy single-file `bl_info` add-ons still load on both (deprecated, not removed).
- **glTF export takes NO scale param** (research correction to spec §5.1): `bpy.ops.export_scene.gltf` has no `global_scale` in either version. Export at scene scale; `export_apply=True` applies modifiers only. Any Blender↔stud rescale is done by transforming objects pre-export, never via an exporter kwarg.
- **Open Cloud accepts `.glb` directly** (research correction): `assetType="Model"`, fileContent content-type `model/gltf-binary`, ≤ 20 MB/call. No need to emit `.fbx`. Upload is `POST https://apis.roblox.com/assets/v1/assets` (multipart: `request` JSON part + `fileContent` file part, header `x-api-key`); poll `GET https://apis.roblox.com/assets/v1/operations/{operationId}` until `done:true`, read `response.assetId`.
- **Open Cloud env:** `ROBLOX_OPEN_CLOUD_API_KEY` (set), `ROBLOX_OPEN_CLOUD_CREATOR_ID=2973404790` (user `gaxia`), `ROBLOX_OPEN_CLOUD_CREATOR_TYPE=User`. These belong in the **live deployment** env (`G:\My Drive\roblox-multi-ai\server\`), not just the repo (see memory `deployment-vs-repo`). Required scopes: `asset:write` + `asset:read`. 403 commonly = creator/key mismatch or the key's **IP allowlist** not covering the host.
- **Refuse list — block at tool-registration, never expose:** all `bpy.ops.sculpt.*`, all `bpy.ops.wm.*` except an allowlisted `save_as`, `bpy.ops.script.reload`, `bpy.ops.preferences.*`, generic `bpy.ops.object.mode_set`, and **any arbitrary-Python `exec`**.
- **Code quality (CLAUDE.md):** Luau scripts `--!strict`, typed params/returns, `task.wait` not `wait()`, `:GetService()` not `game.X`. Node ESM. No placeholder names. Every mutation in Studio wrapped in `ChangeHistoryService` recording; every Blender mutation wrapped in `ed.undo_push`.
- **Cannot runtime-test from this shell:** Blender add-on `.py` and plugin `.lua` are verified by syntax check + inspection here; they take effect only after `sync-blender-addon.ps1`/`sync-plugin.ps1` + reload in the app. The live MCP server runs from the deployment dir, not this repo.

## Deferred from spec to v1.1 (explicit scope cuts)

These spec items are intentionally NOT implemented in v1 and are flagged here so the cut is explicit (the spec lists them in-scope, so silence would read as coverage):

- **Textures / SurfaceAppearance (spec §4.4 last bullet, §11 "Textures need separate Decal uploads").** v1 carries only `base_color`/`roughness`/`metallic` via the Blender Principled BSDF; it does NOT upload texture maps as Decals or build a `SurfaceAppearance` (ColorMap/NormalMap/RoughnessMap/MetalnessMap). The EditableMesh path is explicitly no-PBR. Consequently `blender_set_material` does NOT accept `texture_path` in v1 and the glb parser discards image data. Revisit in v1.1.
- **`torus` primitive.** `bmesh` has no `create_torus` op; rather than silently returning a sphere, `torus` is removed from the `blender_create_primitive` enum in v1.
- **Export formats.** `.glb` is the only format verified end-to-end (Open Cloud accepts it directly as `model/gltf-binary`). `fbx`/`obj` stay selectable in `blender_export_to_roblox` but are best-effort/unverified in v1.

---

## File Structure

```
<repo>/
├── server/
│   ├── server.mjs              # MODIFY: thin composition over lib (Task 1); + 3 new tool cases (Tasks 5,6,7)
│   ├── tools.mjs               # MODIFY: + roblox_upload_asset, roblox_insert_uploaded_model, import_blender_model schemas
│   ├── os-tools.mjs            # unchanged
│   ├── package.json            # unchanged (zero new deps)
│   ├── lib/
│   │   ├── http-bridge.mjs     # CREATE (Task 1): createBridge() factory + redactHeaders()
│   │   ├── open-cloud.mjs      # CREATE (Task 5): uploadAsset() + pollOperation() + multipart builder
│   │   └── glb.mjs             # CREATE (Task 7): parseGlb() binary-glTF → {vertices,triangles,normals,uvs}
│   └── test/
│       ├── http-bridge.test.mjs   # CREATE (Task 1)
│       ├── open-cloud.test.mjs     # CREATE (Task 5)
│       └── glb.test.mjs            # CREATE (Task 7)
├── blender/                    # CREATE
│   ├── server.mjs              # CREATE (Task 2): thin composition over server/lib/http-bridge.mjs
│   ├── tools.mjs               # CREATE (Task 2): BLENDER_TOOLS schema array
│   ├── package.json            # CREATE (Task 2)
│   ├── test/
│   │   └── blender-server.smoke.test.mjs   # CREATE (Task 2)
│   └── addon/
│       ├── MultiAI_Blender.py  # CREATE (Task 3): the Blender add-on (single-file legacy bl_info)
│       └── README.md           # CREATE (Task 3): one-time install + optional extension-manifest path
├── plugin/MultiAIPlugin.lua    # MODIFY: + insert_uploaded_model (Task 6) + editable_mesh_build (Task 7) handlers
├── sync-blender-addon.ps1      # CREATE (Task 4): mirrors sync-plugin.ps1, copies into 4.5 + 5.0 scripts/addons
├── .mcp.json                   # MODIFY (Task 8): + "blender" server entry
├── .claude/agents/blender-builder.md   # CREATE (Task 8)
└── CLAUDE.md                   # MODIFY (Task 8): + blender-builder row + routing rule + connection-check
```

---

## Interface Contract (shared signatures — every task must match these exactly)

**`server/lib/http-bridge.mjs`**
```
createBridge(options) -> { httpServer: http.Server, submit, getStatus }
  options: {
    port: number, host?="127.0.0.1", allowedHosts?: Set<string>, authToken?="",
    brandPrefix?="[mcp]", defaultTimeoutMs?=30000, maxBodyBytes?=8388608,
    bodyTimeoutMs?=30000, pollTimeoutMs?=10000, pluginStaleMs?=12000, onListen?: ()=>void
  }
  submit(type: string, payload: any, timeoutMs?=defaultTimeoutMs) -> Promise<result>
  getStatus() -> { pluginConnected, msSinceLastPoll, queued, inFlight, ready }
redactHeaders(headers: object) -> object   // sensitive header values replaced with "[REDACTED]"
```

**`server/lib/open-cloud.mjs`**
```
uploadAsset({ apiKey, creatorId, creatorType?="User", filePath, displayName, description?, baseUrl?="https://apis.roblox.com" }) -> Promise<{ operationId, path }>
pollOperation({ apiKey, operationId, baseUrl?="https://apis.roblox.com", maxAttempts?=20, initialDelayMs?=1000 }) -> Promise<{ assetId: string }>
```

**`server/lib/glb.mjs`**
```
parseGlb(buffer: Buffer|Uint8Array) -> { vertices: number[][], triangles: number[][], normals: number[][]|null, uvs: number[][]|null }
```

**New Roblox plugin command types (Lua handlers, `plugin/MultiAIPlugin.lua`)**
```
insert_uploaded_model  payload { assetId: number, parent: string, name?: string }
                       -> { ok, inserted: [{path,className,name}], count, modelPath }
editable_mesh_build    payload { name, parent, batchIndex, batchCount, vertices: [[x,y,z]...], triangles: [[a,b,c]...], finalize: bool, sessionId: string }
                       -> { ok, sessionId, received, meshPartPath? (only when finalize) }
```

**New Roblox MCP tools (`server/tools.mjs` schemas + `server/server.mjs` switch cases)**
```
roblox_upload_asset           { local_path, asset_type?="Model", name, description? } -> { ok, assetId, kind }
roblox_insert_uploaded_model  { assetId, parent_path, name? } -> forwards to plugin insert_uploaded_model
import_blender_model          { local_path, parent_path, name? } -> composite: upload→insert, else EditableMesh fallback
```

**Blender MCP tools (`blender/tools.mjs` schemas, forwarded by `blender/server.mjs` to the add-on)** — see Task 2 for the full list; command `type` == tool name minus the `blender_` prefix is NOT used — the full tool name IS the command type the add-on dispatches on.

---

## Task 1: Extract `server/lib/http-bridge.mjs` (prerequisite refactor)

Extract the 10 generic HTTP/queue primitives out of `server/server.mjs` into a reusable factory, leaving `server.mjs` behavior-identical. Add `redactHeaders()`. Establish `node --test` as the (zero-dep) test runner — the lib imports only Node builtins, so tests run in the worktree without `node_modules`.

**Files:**
- Create: `server/lib/http-bridge.mjs`
- Create: `server/test/http-bridge.test.mjs`
- Modify: `server/server.mjs` (replace lines 25–287 region with a `createBridge` call; keep the MCP/tool layer below line 288)

**Interfaces:**
- Produces: `createBridge`, `redactHeaders` (signatures above). `submit` returned by `createBridge` is what the MCP tool layer calls (replacing the current module-level `submit`).
- Consumes: nothing (foundation task).

- [ ] **Step 1: Write the failing test file**

Create `server/test/http-bridge.test.mjs`. Uses `node:test`, `node:http`, and binds on port `0` (ephemeral — never collides with 8765/8766).

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createBridge, redactHeaders } from "../lib/http-bridge.mjs";

// Start a bridge on an ephemeral port; return {port, bridge, close}.
function startBridge(opts = {}) {
  const bridge = createBridge({ port: 0, brandPrefix: "[test]", ...opts });
  return new Promise((resolve) => {
    bridge.httpServer.on("listening", () => {
      const { port } = bridge.httpServer.address();
      resolve({ port, bridge, close: () => bridge.httpServer.close() });
    });
  });
}

// Minimal HTTP request helper.
function req(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test("redactHeaders masks secret headers, keeps the rest", () => {
  const out = redactHeaders({
    "x-api-key": "SECRET", "x-mcp-token": "T", authorization: "Bearer z",
    "x-open-cloud-api-key": "K", "content-type": "application/json", host: "127.0.0.1:1",
  });
  assert.equal(out["x-api-key"], "[REDACTED]");
  assert.equal(out["x-mcp-token"], "[REDACTED]");
  assert.equal(out["authorization"], "[REDACTED]");
  assert.equal(out["x-open-cloud-api-key"], "[REDACTED]");
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["host"], "127.0.0.1:1");
});

test("bad Host header -> 403 forbidden host", async () => {
  const { port, close } = await startBridge();
  const res = await req(port, { path: "/health", headers: { Host: "evil.example.com" } });
  assert.equal(res.status, 403);
  assert.match(res.body, /forbidden host/);
  close();
});

test("body over cap -> 413 payload too large", async () => {
  const { port, close } = await startBridge({ maxBodyBytes: 16 });
  const res = await req(port, { method: "POST", path: "/submit", body: "x".repeat(64) });
  assert.equal(res.status, 413);
  assert.match(res.body, /payload too large/);
  close();
});

test("malformed JSON on /submit -> 400 bad request (no parser internals)", async () => {
  const { port, close } = await startBridge();
  const res = await req(port, { method: "POST", path: "/submit", body: "{not json" });
  assert.equal(res.status, 400);
  assert.equal(res.body, '{"error":"bad request"}');
  close();
});

test("auth: with token set, /poll without x-mcp-token -> 401", async () => {
  const { port, close } = await startBridge({ authToken: "s3cret" });
  const res = await req(port, { path: "/poll" });
  assert.equal(res.status, 401);
  assert.match(res.body, /unauthorized/);
  close();
});

test("late POST /result/<id> -> 200 ok and logs 'late result'", async () => {
  const { port, close } = await startBridge();
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    const res = await req(port, { method: "POST", path: "/result/nonexistent-id", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"ok":true}');
    assert.ok(errs.some((e) => e.includes("late result for nonexistent-id")));
  } finally {
    console.error = orig;
    close();
  }
});

test("EADDRINUSE -> child process exits 1 with FATAL log", async () => {
  // Bind a server, then spawn a child that tries the SAME port via createBridge.
  const holder = http.createServer(() => {});
  await new Promise((r) => holder.listen(0, "127.0.0.1", r)); // wait for the async bind before reading .address()
  const port = holder.address().port;
  // Absolute import so the child resolves the lib regardless of its cwd.
  const libUrl = new URL("../lib/http-bridge.mjs", import.meta.url).href;
  const script = `
    import { createBridge } from ${JSON.stringify(libUrl)};
    createBridge({ port: ${port}, brandPrefix: "[child]" });
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  holder.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FATAL/);
  assert.match(r.stderr, /already in use/);
});
```

- [ ] **Step 2: Run the test to verify it fails (module not found)**

Run: `node --test server/test/http-bridge.test.mjs`
Expected: FAIL — `Cannot find module '../lib/http-bridge.mjs'`.

- [ ] **Step 3: Create the library**

Create `server/lib/http-bridge.mjs`. The `submit`, `readBody`, and routing bodies are **moved verbatim** from `server/server.mjs:36-287` with three mechanical changes: (a) module-level constants become closure params, (b) the `[roblox-mcp]` literal becomes `brandPrefix`, (c) `submit` is returned instead of being a free function.

```js
/**
 * server/lib/http-bridge.mjs
 * Shared HTTP long-poll bridge primitives for the Roblox and Blender MCP servers.
 * Loopback-only HTTP with: host allowlist, optional shared-secret, body cap +
 * timeout, EADDRINUSE-fatal lifecycle, a UUID command queue with timeout +
 * late-result logging. Pure node builtins — no external deps (so `node --test`
 * runs without node_modules). Behavior must stay bit-identical to the inline
 * version that lived in server/server.mjs @ b2b4794.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

const SENSITIVE_HEADER_RE = /^(x-api-key|x-mcp-token|authorization|x-open-cloud-api-key|.*-key)$/i;

/** Return a shallow copy of `headers` with secret values replaced by "[REDACTED]". */
export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

export function createBridge({
  port,
  host = "127.0.0.1",
  allowedHosts,
  authToken = "",
  brandPrefix = "[mcp]",
  defaultTimeoutMs = 30_000,
  maxBodyBytes = 8 * 1024 * 1024,
  bodyTimeoutMs = 30_000,
  pollTimeoutMs = 10_000,
  pluginStaleMs = 12_000,
  onListen,
} = {}) {
  const pending = [];
  const inFlight = new Map();
  const waiters = [];
  let lastPollAt = 0;
  // For a concrete port the allowlist is fixed up front; for port 0 (ephemeral —
  // used by tests) it is rebuilt in the listen callback once the OS assigns one.
  let hosts = allowedHosts || new Set([`${host}:${port}`, `localhost:${port}`]);

  function submit(type, payload, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const cmd = { id, type, payload };
      const timeout = setTimeout(() => {
        inFlight.delete(id);
        const qi = pending.findIndex((c) => c.id === id);
        if (qi >= 0) pending.splice(qi, 1);
        resolve({ error: `timeout after ${timeoutMs}ms — is the ${brandPrefix} plugin/addon connected?` });
      }, timeoutMs);
      inFlight.set(id, { resolve, timeout });
      if (waiters.length > 0) waiters.shift()(cmd);
      else pending.push(cmd);
    });
  }

  function readBody(req, res, onComplete) {
    let body = "";
    let bytes = 0;
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      finish(() => {
        try { res.writeHead(408, { "Content-Type": "application/json" }); res.end('{"error":"request timeout"}'); } catch {}
        req.destroy();
      });
    }, bodyTimeoutMs);
    req.on("data", (c) => {
      if (done) return;
      bytes += c.length;
      if (bytes > maxBodyBytes) {
        finish(() => {
          try { res.writeHead(413, { "Content-Type": "application/json" }); res.end('{"error":"payload too large"}'); } catch {}
          req.destroy();
        });
        return;
      }
      body += c;
    });
    req.on("end", () => finish(() => onComplete(body)));
    req.on("error", () => finish(() => { try { req.destroy(); } catch {} }));
  }

  function getStatus() {
    const now = Date.now();
    const sinceLastPoll = lastPollAt === 0 ? null : now - lastPollAt;
    const pluginConnected = lastPollAt !== 0 && sinceLastPoll < pluginStaleMs;
    return {
      pluginConnected,
      msSinceLastPoll: sinceLastPoll,
      queued: pending.length,
      inFlight: inFlight.size,
      ready: pluginConnected && inFlight.size === 0 && pending.length === 0,
    };
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (!hosts.has(req.headers.host || "")) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"error":"forbidden host"}');
      return;
    }

    if (authToken) {
      const p = url.pathname;
      const guarded = p === "/poll" || p === "/submit" || p.startsWith("/result/");
      if (guarded && req.headers["x-mcp-token"] !== authToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/poll") {
      lastPollAt = Date.now();
      if (pending.length > 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pending.shift()));
        return;
      }
      let sent = false;
      const timer = setTimeout(() => {
        if (sent) return;
        sent = true;
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }, pollTimeoutMs);
      const waiter = (cmd) => {
        if (sent) return;
        sent = true;
        clearTimeout(timer);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cmd));
      };
      waiters.push(waiter);
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/result/")) {
      const id = url.pathname.slice("/result/".length);
      readBody(req, res, (body) => {
        const handler = inFlight.get(id);
        if (handler) {
          clearTimeout(handler.timeout);
          inFlight.delete(id);
          try { handler.resolve(JSON.parse(body || "{}")); }
          catch { handler.resolve({ error: "invalid JSON from plugin" }); }
        } else {
          console.error(`late result for ${id}, op may have completed plugin-side`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/submit") {
      readBody(req, res, async (body) => {
        try {
          const { type, payload } = JSON.parse(body);
          const result = await submit(type, payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"bad request"}');
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: pending.length, inFlight: inFlight.size }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/connection_status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatus()));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  httpServer.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`${brandPrefix} FATAL: ${host}:${port} is already in use — another server is bound to it. Close it and retry.`);
    } else {
      console.error(`${brandPrefix} FATAL: HTTP server error: ${err.message}`);
    }
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    if (!allowedHosts && port === 0) {
      const real = httpServer.address().port; // ephemeral: rebuild allowlist with the assigned port
      hosts = new Set([`${host}:${real}`, `localhost:${real}`]);
    }
    console.error(
      authToken
        ? `${brandPrefix} bridge on ${host}:${port} — Host-checked, shared-secret auth ENABLED.`
        : `${brandPrefix} bridge on ${host}:${port} — Host-checked. No token set: any local process can drive it.`
    );
    if (onListen) onListen();
  });

  return { httpServer, submit, getStatus };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/test/http-bridge.test.mjs`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Rewrite `server/server.mjs` to compose the lib**

Replace the entire block `server/server.mjs:25-287` (the comment header `// Shared command queue` through the `httpServer.listen(...)` call) with the import + factory call below. **Keep lines 1-24 (imports)** — but remove the now-unused `import http from "node:http"` and `import { randomUUID } from "node:crypto"` only if no longer referenced elsewhere in the file (grep first; `randomUUID`/`http` may be used by tool code — if so, leave them). Add the lib import near the top and replace the block:

```js
import { createBridge, redactHeaders } from "./lib/http-bridge.mjs";

const HTTP_PORT = (() => {
  const p = Number(process.env.ROBLOX_MCP_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8765;
})();

const { submit, getStatus } = createBridge({
  port: HTTP_PORT,
  authToken: (process.env.ROBLOX_MCP_TOKEN || "").trim(),
  brandPrefix: "[roblox-mcp]",
});
```

Then below, anywhere the old code referenced the module-level `submit(...)` it now uses this `submit` (same name — no call-site change). If the old `/connection_status` MCP tool or `get_connection_status` handler read `pending`/`inFlight`/`lastPollAt` directly, repoint it to `getStatus()`. Grep for `lastPollAt`, `pending`, `inFlight`, `PLUGIN_STALE_MS` in the remaining file and replace any reads with `getStatus()`.

- [ ] **Step 6: Verify `server.mjs` still parses and the lib tests still pass**

Run: `node --check server/server.mjs`
Expected: no output (syntax OK).
Run: `node --test server/test/http-bridge.test.mjs`
Expected: PASS (unchanged).

> Note: a full `node server/server.mjs` boot needs the MCP SDK from `node_modules`, which lives only in the deployment dir (memory `deployment-vs-repo`). The lib tests cover all HTTP behavior without the SDK; full-boot verification happens at deploy time.

- [ ] **Step 7: Commit**

```bash
git add server/lib/http-bridge.mjs server/test/http-bridge.test.mjs server/server.mjs
git commit -m "refactor(bridge): extract shared http-bridge lib + add header redaction

Extract the 10 generic HTTP/queue primitives (readBody, host-check,
optional auth, clientError/EADDRINUSE lifecycle, UUID command queue with
timeout + late-result logging, /poll+/result+/submit routing) from
server.mjs into server/lib/http-bridge.mjs as a createBridge() factory so
the upcoming Blender bridge composes the same hardening. server.mjs is now
a thin composition; behavior is bit-identical to b2b4794 for every endpoint.

Adds redactHeaders() (none existed before) so x-api-key never reaches logs
once Open Cloud upload lands. Establishes node --test as a zero-dep runner;
7 regression tests pin the 5 hardening cases + auth + redaction on an
ephemeral port (never binds 8765/8766). Closes spec §4.3, §14.5.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Blender MCP server (`blender/server.mjs` + `blender/tools.mjs` + `blender/package.json`)

A second stdio MCP server that composes the shared lib on port 8766 and exposes the `blender_*` tools, forwarding each to the add-on via `submit(toolName, args)`.

**Files:**
- Create: `blender/server.mjs`, `blender/tools.mjs`, `blender/package.json`
- Create: `blender/test/blender-server.smoke.test.mjs`

**Interfaces:**
- Consumes: `createBridge` from `../server/lib/http-bridge.mjs`.
- Produces: HTTP bridge on `BLENDER_MCP_PORT` (default 8766); MCP tools whose `name` is the command `type` the add-on dispatches on (Task 3).

- [ ] **Step 1: Create `blender/package.json`**

```json
{
  "name": "blender-multi-ai-server",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "main": "server.mjs",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4"
  }
}
```

- [ ] **Step 2: Create `blender/tools.mjs` (the full tool surface, spec §5.1)**

```js
/**
 * blender/tools.mjs
 * MCP tool schemas for the Blender bridge. Each tool `name` is the exact
 * command `type` the add-on (MultiAI_Blender.py) dispatches on. All geometry
 * tools are bmesh-backed in the add-on. Refused operators (sculpt.*, wm.* except
 * save_as, script.reload, preferences.*, generic mode_set, arbitrary exec) are
 * simply NOT declared here — there is no tool to call them.
 */
const xyz = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };

export const BLENDER_TOOLS = [
  {
    name: "blender_create_primitive",
    description: "Create a bmesh primitive. kind: cube|sphere|cylinder|cone|plane|torus. location/rotation/scale are [x,y,z].",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["cube", "sphere", "cylinder", "cone", "plane"] },
        name: { type: "string", default: "Object" },
        location: xyz, rotation: xyz, scale: xyz,
        segments: { type: "integer", default: 32 },
      },
      required: ["kind"],
    },
  },
  { name: "blender_set_transform",
    description: "Set an object's world transform directly (no operator). location/rotation/scale are [x,y,z].",
    inputSchema: { type: "object", properties: { name: { type: "string" }, location: xyz, rotation: xyz, scale: xyz }, required: ["name"] } },
  { name: "blender_boolean",
    description: "Boolean modifier (solver EXACT). op: UNION|DIFFERENCE|INTERSECT. apply=true bakes it.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, other: { type: "string" }, op: { type: "string", enum: ["UNION", "DIFFERENCE", "INTERSECT"] }, apply: { type: "boolean", default: true } }, required: ["target", "other", "op"] } },
  { name: "blender_array",
    description: "Array modifier. offset_xyz is [x,y,z] relative offset.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, count: { type: "integer" }, offset_xyz: xyz, apply: { type: "boolean", default: true } }, required: ["target", "count"] } },
  { name: "blender_mirror",
    description: "Mirror modifier across axis X|Y|Z.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, axis: { type: "string", enum: ["X", "Y", "Z"] }, apply: { type: "boolean", default: true } }, required: ["target", "axis"] } },
  { name: "blender_subdivide",
    description: "Subdivision. kind: catmull|simple. levels>=1.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, levels: { type: "integer", default: 1 }, kind: { type: "string", enum: ["catmull", "simple"], default: "catmull" }, apply: { type: "boolean", default: true } }, required: ["target"] } },
  { name: "blender_bevel",
    description: "Bevel edges. edges_selector: all|sharp_angle>=N (degrees).",
    inputSchema: { type: "object", properties: { target: { type: "string" }, edges_selector: { type: "string", default: "all" }, width: { type: "number", default: 0.1 }, segments: { type: "integer", default: 1 } }, required: ["target"] } },
  { name: "blender_set_material",
    description: "Assign a Principled BSDF material (base_color/roughness/metallic only; textures deferred to v1.1). base_color is [r,g,b] 0..1.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, base_color: { type: "array", items: { type: "number" } }, roughness: { type: "number", default: 0.5 }, metallic: { type: "number", default: 0 } }, required: ["target", "base_color"] } },
  { name: "blender_get_tree", description: "Scene graph: collections, objects, mesh stats.", inputSchema: { type: "object", properties: {} } },
  { name: "blender_get_bounds", description: "World-space AABB + named edges for an object.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "blender_screenshot", description: "Viewport OpenGL capture -> base64 PNG. Requires GUI mode.", inputSchema: { type: "object", properties: {} } },
  { name: "blender_get_connection_status", description: "{ addonConnected, msSinceLastPoll, queued, inFlight, ready }.", inputSchema: { type: "object", properties: {} } },
  { name: "blender_export_to_roblox",
    description: "Export object/collection to a file. format: glb|fbx|obj (default glb). Pre-counts triangles; refuses over max_triangles.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, path: { type: "string" }, format: { type: "string", enum: ["glb", "fbx", "obj"], default: "glb" }, max_triangles: { type: "integer", default: 10000 } }, required: ["target", "path"] } },
  { name: "blender_undo", description: "bpy.ops.ed.undo().", inputSchema: { type: "object", properties: {} } },
  { name: "blender_save_as", description: "Save the .blend to path (only allowlisted wm operator).", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];
```

- [ ] **Step 3: Write the failing smoke test**

Create `blender/test/blender-server.smoke.test.mjs`. It does NOT boot the SDK; it validates the tool schemas + that `blender_get_connection_status` is present, and that the bridge factory the server uses reports `addonConnected:false` before any poll.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../../server/lib/http-bridge.mjs";
import { BLENDER_TOOLS } from "../tools.mjs";

test("BLENDER_TOOLS: every tool has a name, description, object inputSchema; no refused ops", () => {
  assert.ok(BLENDER_TOOLS.length >= 15);
  const names = new Set();
  for (const t of BLENDER_TOOLS) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.equal(t.inputSchema.type, "object");
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
  }
  // Refused surface must be absent.
  for (const banned of ["blender_sculpt", "blender_exec", "blender_mode_set", "blender_preferences"]) {
    assert.ok(!names.has(banned), `${banned} must not be exposed`);
  }
  assert.ok(names.has("blender_get_connection_status"));
  assert.ok(names.has("blender_export_to_roblox"));
});

test("bridge getStatus reports disconnected before any /poll", async () => {
  const bridge = createBridge({ port: 0, brandPrefix: "[blender-test]" });
  await new Promise((r) => bridge.httpServer.on("listening", r));
  const s = bridge.getStatus();
  assert.equal(s.pluginConnected, false);
  assert.equal(s.queued, 0);
  bridge.httpServer.close();
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test blender/test/blender-server.smoke.test.mjs`
Expected: FAIL — `Cannot find module '../tools.mjs'` (if Step 2 not yet saved) or assertion errors. After Step 2 it should pass the schema test; the bridge test passes once the lib (Task 1) exists.

- [ ] **Step 5: Create `blender/server.mjs`**

```js
#!/usr/bin/env node
/**
 * blender/server.mjs
 * MCP server for Blender. Mirrors server/server.mjs: stdio MCP <-> Claude,
 * HTTP long-poll on 127.0.0.1:8766 <-> MultiAI_Blender.py add-on.
 * Composes the shared http-bridge lib so all hardening is identical to the
 * Roblox bridge. Each tool is forwarded to the add-on verbatim as { type: name,
 * payload: args }; blender_get_connection_status is answered locally.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createBridge } from "../server/lib/http-bridge.mjs";
import { BLENDER_TOOLS } from "./tools.mjs";

const HTTP_PORT = (() => {
  const p = Number(process.env.BLENDER_MCP_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8766;
})();

const { submit, getStatus } = createBridge({
  port: HTTP_PORT,
  authToken: (process.env.BLENDER_MCP_TOKEN || "").trim(),
  brandPrefix: "[blender-mcp]",
});

const server = new Server({ name: "blender", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BLENDER_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "blender_get_connection_status") {
    const s = getStatus();
    return { content: [{ type: "text", text: JSON.stringify({ addonConnected: s.pluginConnected, msSinceLastPoll: s.msSinceLastPoll, queued: s.queued, inFlight: s.inFlight, ready: s.ready }) }] };
  }

  if (!BLENDER_TOOLS.some((t) => t.name === name)) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }], isError: true };
  }

  // Long ops (boolean apply, big subsurf) can run past the default; give exports/booleans more time.
  const timeoutMs = /export|boolean|subdivide/.test(name) ? 120_000 : 30_000;
  const result = await submit(name, args, timeoutMs);
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: !!(result && result.error) };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 6: Verify syntax + tests pass**

Run: `node --check blender/server.mjs`
Expected: no output.
Run: `node --test blender/test/blender-server.smoke.test.mjs`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add blender/server.mjs blender/tools.mjs blender/package.json blender/test/blender-server.smoke.test.mjs
git commit -m "feat(blender): MCP server on :8766 composing the shared http-bridge

blender/server.mjs is a thin stdio-MCP composition over server/lib/http-bridge
(brand [blender-mcp], port BLENDER_MCP_PORT default 8766, optional
BLENDER_MCP_TOKEN). blender/tools.mjs declares the 16-tool bmesh surface;
refused operators (sculpt/wm-except-save_as/exec/mode_set/preferences) are
simply not declared. get_connection_status is answered locally; all other
tools forward to the add-on as { type: name, payload: args }. Smoke tests
validate the schema set + disconnected status on an ephemeral port.

Implements spec §4.1, §5.1.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Blender add-on (`blender/addon/MultiAI_Blender.py` + README)

The persistent add-on: a daemon thread long-polls the bridge and feeds a `queue.Queue`; a `bpy.app.timers` callback drains it on the main thread (bpy is not thread-safe), dispatches to bmesh-backed handlers, and POSTs results back. Single-file legacy `bl_info` — verified to enable on both 4.5 and 5.0.

**Files:**
- Create: `blender/addon/MultiAI_Blender.py`
- Create: `blender/addon/README.md`

**Interfaces:**
- Consumes: the bridge's `/poll` (GET) and `/result/<id>` (POST) on `http://127.0.0.1:8766`.
- Produces: handler results matching each `blender_*` tool's expected return.

> Cannot be runtime-tested from this shell (no Blender in the shell). Verification = `python -m py_compile` syntax gate (Step 3) + a manual checkpoint (Step 5).

- [ ] **Step 1: Write the add-on**

Create `blender/addon/MultiAI_Blender.py`. (Handlers below cover the full §5.1 surface; each mutation is wrapped in `ed.undo_push`.)

```python
# MultiAI_Blender.py — Blender add-on bridging to the Multi-AI Blender MCP server.
# Location: install into <Blender>/scripts/addons/ (legacy add-on; works on 4.5 + 5.0).
# Purpose: long-poll http://127.0.0.1:8766/poll on a daemon thread, drain commands
#          on the main thread via bpy.app.timers, run bmesh-backed handlers, POST
#          results to /result/<id>. bpy is touched ONLY on the main thread.
bl_info = {
    "name": "Multi-AI Blender Bridge",
    "author": "Multi-AI",
    "version": (0, 1, 0),
    "blender": (4, 5, 0),
    "location": "View3D > Sidebar > Multi-AI",
    "description": "Bridge Blender to the Multi-AI MCP server (port 8766).",
    "category": "Object",
}

import bpy, bmesh, json, queue, threading, time, base64, os, math
import urllib.request, urllib.error
from mathutils import Vector

# ── Config ──────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("BLENDER_MCP_PORT", "8766"))
SERVER_URL = f"http://127.0.0.1:{PORT}"
AUTH_TOKEN = os.environ.get("BLENDER_MCP_TOKEN", "").strip()
POLL_INTERVAL = 0.5

_work = queue.Queue()      # (request_id, command_dict) from the poll thread
_running = False
_thread = None
_last_poll_ok = 0.0

# ── HTTP helpers (daemon thread only — never touch bpy here) ─────────────────
def _headers():
    h = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        h["x-mcp-token"] = AUTH_TOKEN
    return h

def _poll_once():
    req = urllib.request.Request(SERVER_URL + "/poll", headers=_headers(), method="GET")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8")

def _post_result(rid, result):
    data = json.dumps(result).encode("utf-8")
    req = urllib.request.Request(SERVER_URL + "/result/" + rid, data=data, headers=_headers(), method="POST")
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        print(f"[MultiAI-Blender] post failed: {e}")

def _post_result_async(rid, result):
    # Never block the main thread on network I/O — fire the POST on a short-lived daemon.
    threading.Thread(target=_post_result, args=(rid, result), daemon=True).start()

def _poll_loop():
    global _last_poll_ok
    print(f"[MultiAI-Blender] polling {SERVER_URL}")
    while _running:
        try:
            body = _poll_once()
            _last_poll_ok = time.time()
            if body and body not in ("", "{}"):
                cmd = json.loads(body)
                if cmd.get("id"):
                    _work.put((cmd["id"], cmd))
        except urllib.error.URLError:
            time.sleep(2.0)  # bridge down — back off
        except Exception as e:
            print(f"[MultiAI-Blender] poll error: {e}")
            time.sleep(1.0)
        time.sleep(POLL_INTERVAL)
    print("[MultiAI-Blender] poll loop stopped")

# ── Geometry helpers (main thread) ───────────────────────────────────────────
def _obj(name):
    o = bpy.data.objects.get(name)
    if o is None:
        raise ValueError(f"object not found: {name}")
    return o

def _new_mesh_object(name, bm):
    mesh = bpy.data.meshes.new(name + "Mesh")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj

def _apply_modifier(obj, mod_name):
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=mod_name)

def _tri_count(obj):
    # Count on the EVALUATED mesh (modifiers applied) — matches what the glTF/FBX
    # exporters emit (export_apply / use_mesh_modifiers), so an unapplied modifier
    # can't slip past the triangle budget.
    dg = bpy.context.evaluated_depsgraph_get()
    eobj = obj.evaluated_get(dg)
    me = eobj.to_mesh()
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    eobj.to_mesh_clear()
    return n

# ── Handlers ─────────────────────────────────────────────────────────────────
def h_create_primitive(p):
    kind = p["kind"]; name = p.get("name", "Object")
    seg = int(p.get("segments", 32))
    bm = bmesh.new()
    if kind == "cube":
        bmesh.ops.create_cube(bm, size=2.0)
    elif kind == "sphere":
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(2, seg // 2), radius=1.0)
    elif kind == "cylinder":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=1.0, radius2=1.0, depth=2.0)
    elif kind == "cone":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=1.0, radius2=0.0, depth=2.0)
    elif kind == "plane":
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
    else:
        bm.free(); raise ValueError(f"unknown kind: {kind}")  # 'torus' deferred (bmesh has no create_torus op)
    obj = _new_mesh_object(name, bm)
    if p.get("location"): obj.location = Vector(p["location"])
    if p.get("rotation"): obj.rotation_euler = [math.radians(a) for a in p["rotation"]]
    if p.get("scale"): obj.scale = Vector(p["scale"])
    return {"ok": True, "name": obj.name}

def h_set_transform(p):
    o = _obj(p["name"])
    if p.get("location"): o.location = Vector(p["location"])
    if p.get("rotation"): o.rotation_euler = [math.radians(a) for a in p["rotation"]]
    if p.get("scale"): o.scale = Vector(p["scale"])
    return {"ok": True, "name": o.name}

def h_boolean(p):
    tgt = _obj(p["target"]); other = _obj(p["other"])
    mod = tgt.modifiers.new(name="MCP_Boolean", type="BOOLEAN")
    mod.operation = p["op"]; mod.solver = "EXACT"; mod.object = other
    if p.get("apply", True):
        _apply_modifier(tgt, mod.name)
        bpy.data.objects.remove(other, do_unlink=True)
    return {"ok": True, "target": tgt.name}

def h_array(p):
    tgt = _obj(p["target"])
    mod = tgt.modifiers.new(name="MCP_Array", type="ARRAY")
    mod.count = int(p["count"])
    if p.get("offset_xyz"):
        mod.use_relative_offset = False; mod.use_constant_offset = True
        mod.constant_offset_displace = Vector(p["offset_xyz"])
    if p.get("apply", True): _apply_modifier(tgt, mod.name)
    return {"ok": True, "target": tgt.name}

def h_mirror(p):
    tgt = _obj(p["target"])
    mod = tgt.modifiers.new(name="MCP_Mirror", type="MIRROR")
    axis = {"X": 0, "Y": 1, "Z": 2}[p["axis"]]
    mod.use_axis = [i == axis for i in range(3)]
    if p.get("apply", True): _apply_modifier(tgt, mod.name)
    return {"ok": True, "target": tgt.name}

def h_subdivide(p):
    tgt = _obj(p["target"])
    mod = tgt.modifiers.new(name="MCP_Subsurf", type="SUBSURF")
    mod.levels = int(p.get("levels", 1)); mod.render_levels = mod.levels
    mod.subdivision_type = "CATMULL_CLARK" if p.get("kind", "catmull") == "catmull" else "SIMPLE"
    if p.get("apply", True): _apply_modifier(tgt, mod.name)
    return {"ok": True, "target": tgt.name}

def h_bevel(p):
    tgt = _obj(p["target"])
    bm = bmesh.new(); bm.from_mesh(tgt.data)
    sel = p.get("edges_selector", "all")
    if sel == "all":
        edges = list(bm.edges)
    elif sel.startswith("sharp_angle>="):
        thresh = math.radians(float(sel.split(">=")[1]))
        edges = [e for e in bm.edges if e.calc_face_angle(0.0) >= thresh]
    else:
        edges = list(bm.edges)
    bmesh.ops.bevel(bm, geom=edges, offset=float(p.get("width", 0.1)),
                    segments=int(p.get("segments", 1)), affect="EDGES")
    bm.to_mesh(tgt.data); bm.free(); tgt.data.update()
    return {"ok": True, "target": tgt.name}

def h_set_material(p):
    tgt = _obj(p["target"])
    mat = bpy.data.materials.new(name=tgt.name + "_Mat")
    mat.use_nodes = True
    # Find the Principled BSDF by NODE TYPE (name-based get() can return None under
    # locale/version differences). Create one if the default tree somehow lacks it.
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    c = p["base_color"]
    bsdf.inputs["Base Color"].default_value = (c[0], c[1], c[2], 1.0)
    bsdf.inputs["Roughness"].default_value = float(p.get("roughness", 0.5))
    bsdf.inputs["Metallic"].default_value = float(p.get("metallic", 0.0))
    tgt.data.materials.clear(); tgt.data.materials.append(mat)
    return {"ok": True, "target": tgt.name}  # texture_path/PBR maps deferred to v1.1

def h_get_tree(_p):
    objs = []
    for o in bpy.data.objects:
        stats = {}
        if o.type == "MESH":
            stats = {"verts": len(o.data.vertices), "polys": len(o.data.polygons)}
        objs.append({"name": o.name, "type": o.type, **stats})
    return {"ok": True, "objects": objs}

def h_get_bounds(p):
    o = _obj(p["name"])
    corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
    xs = [c.x for c in corners]; ys = [c.y for c in corners]; zs = [c.z for c in corners]
    return {"ok": True, "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}

def _find_view3d():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region:
                    return win, area, region
    return None, None, None

def h_screenshot(_p):
    win, area, region = _find_view3d()
    if area is None:
        return {"ok": False, "reason": "no 3D viewport open to capture"}
    path = os.path.join(bpy.app.tempdir, "mcp_shot.png")
    scene = bpy.context.scene
    prev = scene.render.filepath  # restore the user's output path afterward
    try:
        scene.render.filepath = path
        # render.opengl(view_context=True) needs a VIEW_3D context — supply one explicitly
        # (a timer callback's default context has no guaranteed active 3D viewport).
        with bpy.context.temp_override(window=win, area=area, region=region):
            bpy.ops.render.opengl(write_still=True, view_context=True)
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
    finally:
        scene.render.filepath = prev
    return {"ok": True, "format": "png", "base64": b64}

def h_export_to_roblox(p):
    tgt = _obj(p["target"])
    fmt = p.get("format", "glb"); path = p["path"]
    # Relative paths resolve under BLENDER_WORKSPACE_DIR/exports (keeps files off the
    # Google-Drive G:\ tree per the deployment-vs-repo constraint); absolute paths pass through.
    if not os.path.isabs(path):
        base = os.environ.get("BLENDER_WORKSPACE_DIR") or os.path.join(os.environ.get("LOCALAPPDATA", bpy.app.tempdir), "Roblox-MCP", "blender")
        path = os.path.join(base, "exports", path)
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)  # guard: dirname of a bare filename is "" -> makedirs("") raises
    bpy.ops.object.select_all(action="DESELECT")
    tgt.select_set(True); bpy.context.view_layer.objects.active = tgt
    tris = _tri_count(tgt); limit = int(p.get("max_triangles", 10000))
    if tris > limit:
        return {"ok": False, "reason": "triangle_budget_exceeded", "count": tris, "limit": limit}
    if fmt == "glb":
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_yup=True)
    elif fmt == "fbx":
        bpy.ops.export_scene.fbx(filepath=path, use_selection=True, global_scale=0.01)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True)
    else:
        return {"ok": False, "reason": f"unknown format: {fmt}"}
    return {"ok": True, "path": path, "triangles": tris}

def h_undo(_p):
    bpy.ops.ed.undo()
    return {"ok": True}

def h_save_as(p):
    bpy.ops.wm.save_as_mainfile(filepath=p["path"])
    return {"ok": True, "path": p["path"]}

HANDLERS = {
    "blender_create_primitive": h_create_primitive,
    "blender_set_transform": h_set_transform,
    "blender_boolean": h_boolean,
    "blender_array": h_array,
    "blender_mirror": h_mirror,
    "blender_subdivide": h_subdivide,
    "blender_bevel": h_bevel,
    "blender_set_material": h_set_material,
    "blender_get_tree": h_get_tree,
    "blender_get_bounds": h_get_bounds,
    "blender_screenshot": h_screenshot,
    "blender_export_to_roblox": h_export_to_roblox,
    "blender_undo": h_undo,
    "blender_save_as": h_save_as,
}

# ── Main-thread drain (timer) ─────────────────────────────────────────────────
READ_ONLY = {"blender_get_tree", "blender_get_bounds", "blender_screenshot", "blender_get_connection_status"}

def _drain():
    try:
        rid, cmd = _work.get_nowait()
    except queue.Empty:
        return POLL_INTERVAL
    ctype = cmd.get("type"); payload = cmd.get("payload", {}) or {}
    handler = HANDLERS.get(ctype)
    if handler is None:
        _post_result_async(rid, {"error": f"unknown command: {ctype}"})
        return 0.02
    try:
        if ctype not in READ_ONLY:
            bpy.ops.ed.undo_push(message=f"MCP {ctype}")  # only mutating ops touch the undo stack
        result = handler(payload)
    except Exception as e:
        result = {"error": f"{type(e).__name__}: {e}"}
    _post_result_async(rid, result)  # POST off the main thread so the UI never blocks
    return 0.02  # check again quickly while busy

# ── Register ───────────────────────────────────────────────────────────────
class MULTIAI_PT_panel(bpy.types.Panel):
    bl_label = "Multi-AI"
    bl_idname = "MULTIAI_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Multi-AI"
    def draw(self, context):
        col = self.layout.column()
        connected = (time.time() - _last_poll_ok) < 12.0 if _last_poll_ok else False
        col.label(text=f"Bridge: {SERVER_URL}")
        col.label(text="Status: " + ("connected" if connected else "waiting…"))

def _start():
    global _running, _thread
    if _running:
        return
    _running = True
    _thread = threading.Thread(target=_poll_loop, daemon=True)
    _thread.start()
    if not bpy.app.timers.is_registered(_drain):
        bpy.app.timers.register(_drain, first_interval=0.5, persistent=True)

def _stop():
    global _running
    _running = False
    if bpy.app.timers.is_registered(_drain):
        bpy.app.timers.unregister(_drain)

def register():
    bpy.utils.register_class(MULTIAI_PT_panel)
    _start()

def unregister():
    _stop()
    bpy.utils.unregister_class(MULTIAI_PT_panel)

if __name__ == "__main__":
    register()
```

- [ ] **Step 2: Write the README**

Create `blender/addon/README.md`:

```markdown
# Multi-AI Blender Add-on

Bridges Blender to the Multi-AI Blender MCP server (`blender/server.mjs`, port 8766).

## Install (one time, per Blender version)
Run `..\..\sync-blender-addon.ps1` from the repo root — it copies `MultiAI_Blender.py`
into the `scripts/addons` folder of every detected Blender (4.5 and 5.0). Then in
each Blender: **Edit → Preferences → Add-ons → search "Multi-AI" → enable**.
The add-on auto-starts polling on enable and on every Blender launch thereafter.

## Verify
With `blender/server.mjs` running, call the `blender_get_connection_status` MCP tool —
it should return `{ "addonConnected": true, "ready": true }`.

## Versions
Tested on Blender 4.5 LTS and 5.0. Every bpy/bmesh API used is identical across both.
This is a legacy `bl_info` add-on (still supported on both, deprecated since 4.2).

## Optional: install as an Extension (future-proof)
Wrap this file in a folder with a `blender_manifest.toml`
(`schema_version="1.0.0"`, `id`, `version`, `name`, `tagline`, `maintainer`,
`type="add-on"`, `blender_version_min="4.5.0"`, `license=["SPDX:GPL-2.0-or-later"]`),
then **Preferences → Add-ons → Install from Disk** the zipped folder. Not required for v1.
```

- [ ] **Step 3: Syntax-check the add-on**

Run (system Python is fine — `bpy`/`bmesh` imports only resolve inside Blender, so use `py_compile` which checks syntax without importing):
`python -m py_compile blender/addon/MultiAI_Blender.py`
Expected: no output, exit 0. (If `python` is unavailable, `node`-side cannot check Python — fall back to careful inspection; the deployment machine has Blender's Python.)

- [ ] **Step 4: Commit**

```bash
git add blender/addon/MultiAI_Blender.py blender/addon/README.md
git commit -m "feat(blender): add-on long-polls :8766, drains on main thread

Single-file legacy bl_info add-on (loads on both 4.5 and 5.0). Daemon thread
long-polls /poll and feeds a queue.Queue; a bpy.app.timers callback drains it
on the main thread (bpy is not thread-safe) and dispatches to bmesh-backed
handlers covering the full §5.1 tool surface, each wrapped in ed.undo_push.
Boolean uses solver=EXACT; glTF export uses export_format=GLB with no scale
kwarg (none exists). Refused operators are never wired in. README documents
one-time enable + optional extension-manifest path.

Implements spec §4.2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: MANUAL CHECKPOINT (deployment machine, not this shell)**

After deploy + `sync-blender-addon.ps1` + enabling in Blender: start `blender/server.mjs`, call `blender_get_connection_status`, expect `addonConnected:true`. Then `blender_create_primitive(kind=cube)` + `blender_screenshot` to confirm the round-trip. Record the result; do not claim this task verified until this passes (per verification-before-completion).

---

## Task 4: `sync-blender-addon.ps1`

Mirror `sync-plugin.ps1`: copy the add-on into the `scripts/addons` of every installed Blender (4.5 + 5.0) so it auto-loads.

**Files:** Create `sync-blender-addon.ps1`.

- [ ] **Step 1: Write the script**

```powershell
# sync-blender-addon.ps1
# Copy the dev add-on into every detected Blender's scripts/addons folder.
# Run after editing blender/addon/MultiAI_Blender.py, then re-enable (or restart) Blender.

$src = Join-Path $PSScriptRoot "blender\addon\MultiAI_Blender.py"
if (-not (Test-Path $src)) {
    Write-Host "[ERROR] Source not found: $src" -ForegroundColor Red
    exit 1
}

$root = Join-Path $env:APPDATA "Blender Foundation\Blender"
if (-not (Test-Path $root)) {
    Write-Host "[ERROR] No Blender config dir at $root" -ForegroundColor Red
    exit 1
}

$versions = Get-ChildItem $root -Directory | Select-Object -ExpandProperty Name
$copied = 0
foreach ($v in $versions) {
    $addons = Join-Path $root "$v\scripts\addons"
    if (-not (Test-Path $addons)) { New-Item -ItemType Directory -Force -Path $addons | Out-Null }
    $dst = Join-Path $addons "MultiAI_Blender.py"
    Copy-Item -Path $src -Destination $dst -Force
    $size = (Get-Item $dst).Length
    Write-Host "[OK] Synced to Blender $v ($size bytes)" -ForegroundColor Green
    Write-Host "  -> $dst" -ForegroundColor DarkGray
    $copied++
}

if ($copied -eq 0) {
    Write-Host "[WARN] No Blender versions found under $root" -ForegroundColor Yellow
    exit 1
}
Write-Host ""
Write-Host "Next: In each Blender, Edit > Preferences > Add-ons > search 'Multi-AI' > enable (once)." -ForegroundColor Yellow
Write-Host "      Already enabled? Disable+enable to reload, or restart Blender." -ForegroundColor Yellow
```

- [ ] **Step 2: Verify it runs and lands the file**

Run: `powershell -File sync-blender-addon.ps1`
Expected: `[OK] Synced to Blender 4.5 ...` and `[OK] Synced to Blender 5.0 ...`, file present in both `%APPDATA%\Blender Foundation\Blender\{4.5,5.0}\scripts\addons\MultiAI_Blender.py`.

- [ ] **Step 3: Commit**

```bash
git add sync-blender-addon.ps1
git commit -m "feat(blender): sync-blender-addon.ps1 mirrors sync-plugin.ps1

Copies blender/addon/MultiAI_Blender.py into scripts/addons of every detected
Blender version (4.5 + 5.0) so it auto-loads. Prints the one-time enable hint.

Implements spec §9 sync helper.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `roblox_upload_asset` — Open Cloud upload (`server/lib/open-cloud.mjs` + tool)

Node-only multipart upload to Open Cloud + operation poll, using global `fetch`/`FormData`/`Blob` (Node 18+, zero deps). Uses `redactHeaders` so the key never logs.

**Files:**
- Create: `server/lib/open-cloud.mjs`, `server/test/open-cloud.test.mjs`
- Modify: `server/tools.mjs` (append `roblox_upload_asset` schema at the end of the TOOLS array, line ~1138)
- Modify: `server/server.mjs` (add a `case "roblox_upload_asset"` in the CallTool switch)

**Interfaces:**
- Produces: `uploadAsset`, `pollOperation` (signatures above). Tool returns `{ ok, assetId, kind }`.
- Consumes: `redactHeaders` from `./lib/http-bridge.mjs`.

- [ ] **Step 1: Write the failing test (mock Open Cloud with a local http server on port 0)**

Create `server/test/open-cloud.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadAsset, pollOperation } from "../lib/open-cloud.mjs";

// Mock apis.roblox.com: POST /assets/v1/assets -> operation; GET /assets/v1/operations/:id -> done.
function mockCloud() {
  let sawApiKey = null, sawMultipart = false;
  const srv = http.createServer((req, res) => {
    sawApiKey = req.headers["x-api-key"] || sawApiKey;
    if (req.method === "POST" && req.url === "/assets/v1/assets") {
      let n = 0; req.on("data", (c) => (n += c.length));
      req.on("end", () => {
        sawMultipart = (req.headers["content-type"] || "").startsWith("multipart/form-data") && n > 0;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: "operations/op123", operationId: "op123" }));
      });
    } else if (req.method === "GET" && req.url === "/assets/v1/operations/op123") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: "operations/op123", done: true, response: { assetId: "55501", path: "assets/55501" } }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, get sawApiKey() { return sawApiKey; }, get sawMultipart() { return sawMultipart; } })));
}

test("uploadAsset sends multipart + x-api-key and returns operationId", async () => {
  const m = await mockCloud();
  const f = join(tmpdir(), "mcp-test.glb");
  writeFileSync(f, Buffer.from([0x67, 0x6c, 0x54, 0x46])); // 'glTF' bytes
  try {
    const out = await uploadAsset({ apiKey: "KEY", creatorId: "2973404790", filePath: f, displayName: "T", baseUrl: `http://127.0.0.1:${m.port}` });
    assert.equal(out.operationId, "op123");
    assert.equal(m.sawApiKey, "KEY");
    assert.equal(m.sawMultipart, true);
  } finally {
    m.srv.close(); rmSync(f, { force: true });
  }
});

test("pollOperation returns assetId once done:true", async () => {
  const m = await mockCloud();
  try {
    const out = await pollOperation({ apiKey: "KEY", operationId: "op123", baseUrl: `http://127.0.0.1:${m.port}`, initialDelayMs: 1 });
    assert.equal(out.assetId, "55501");
  } finally {
    m.srv.close();
  }
});

test("pollOperation honors 429 Retry-After then succeeds", async () => {
  let polls = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/assets/v1/operations/op429") {
      polls++;
      if (polls === 1) { res.writeHead(429, { "retry-after": "1" }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ done: true, response: { assetId: "777" } }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const out = await pollOperation({ apiKey: "K", operationId: "op429", baseUrl: `http://127.0.0.1:${port}`, initialDelayMs: 1 });
    assert.equal(out.assetId, "777");
    assert.ok(polls >= 2);
  } finally { srv.close(); }
});

test("pollOperation throws when the operation finishes with an error", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ done: true, error: { code: 3, message: "bad asset" } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    await assert.rejects(
      pollOperation({ apiKey: "K", operationId: "opErr", baseUrl: `http://127.0.0.1:${port}`, initialDelayMs: 1 }),
      /operation failed/
    );
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/test/open-cloud.test.mjs`
Expected: FAIL — `Cannot find module '../lib/open-cloud.mjs'`.

- [ ] **Step 3: Write `server/lib/open-cloud.mjs`**

```js
/**
 * server/lib/open-cloud.mjs
 * Roblox Open Cloud Assets API client (zero deps; global fetch/FormData/Blob, Node 18+).
 * uploadAsset: multipart POST /assets/v1/assets (assetType Model, .glb accepted as
 * model/gltf-binary, creator.userId as string). pollOperation: GET the operation
 * until done:true, return response.assetId. The x-api-key never reaches a log.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { redactHeaders } from "./http-bridge.mjs";

const CONTENT_TYPE = { glb: "model/gltf-binary", gltf: "model/gltf+json", fbx: "model/fbx", obj: "model/obj" };

function logErr(scope, headers, msg) {
  // Headers are scrubbed before logging — x-api-key must never appear.
  console.error(`[open-cloud] ${scope}: ${msg} (headers: ${JSON.stringify(redactHeaders(headers))})`);
}

export async function uploadAsset({ apiKey, creatorId, creatorType = "User", filePath, displayName, description = "", baseUrl = "https://apis.roblox.com" }) {
  if (!apiKey) throw new Error("missing apiKey");
  if (!creatorId) throw new Error("missing creatorId");
  const ext = (filePath.split(".").pop() || "glb").toLowerCase();
  const bytes = await readFile(filePath);
  if (bytes.length > 20 * 1024 * 1024) throw new Error(`file ${bytes.length}B exceeds 20MB Open Cloud cap`);

  const creator = creatorType === "Group" ? { groupId: String(creatorId) } : { userId: String(creatorId) };
  const request = { assetType: "Model", displayName, description, creationContext: { creator } };

  const form = new FormData();
  form.append("request", JSON.stringify(request));
  form.append("fileContent", new Blob([bytes], { type: CONTENT_TYPE[ext] || "model/gltf-binary" }), basename(filePath));

  const headers = { "x-api-key": apiKey };
  const res = await fetch(`${baseUrl}/assets/v1/assets`, { method: "POST", headers, body: form });
  if (!res.ok) {
    logErr("upload", headers, `HTTP ${res.status}`);
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const operationId = json.operationId || (json.path || "").split("/").pop();
  if (!operationId) throw new Error(`no operationId in upload response: ${JSON.stringify(json)}`);
  return { operationId, path: json.path };
}

export async function pollOperation({ apiKey, operationId, baseUrl = "https://apis.roblox.com", maxAttempts = 20, initialDelayMs = 1000 }) {
  const headers = { "x-api-key": apiKey };
  let delay = initialDelayMs;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, delay));
    const res = await fetch(`${baseUrl}/assets/v1/operations/${operationId}`, { headers });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(delay * 2, 15000);
      continue;
    }
    if (!res.ok) {
      logErr("poll", headers, `HTTP ${res.status}`);
      throw new Error(`poll failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.done) {
      if (json.error) throw new Error(`operation failed: ${JSON.stringify(json.error)}`);
      const assetId = json.response && json.response.assetId;
      if (!assetId) throw new Error(`done but no assetId: ${JSON.stringify(json)}`);
      return { assetId: String(assetId) };
    }
    delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error(`operation ${operationId} not done after ${maxAttempts} polls`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/test/open-cloud.test.mjs`
Expected: PASS (both tests).

- [ ] **Step 5: Add the `roblox_upload_asset` tool schema**

Append to the `TOOLS` array in `server/tools.mjs` (before the closing `]`, ~line 1138):

```js
  {
    name: "roblox_upload_asset",
    description: "Upload a local mesh file (.glb/.fbx) to Roblox via Open Cloud and return its assetId. Requires ROBLOX_OPEN_CLOUD_API_KEY + ROBLOX_OPEN_CLOUD_CREATOR_ID env.",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string" },
        asset_type: { type: "string", default: "Model" },
        name: { type: "string" },
        description: { type: "string", default: "" },
      },
      required: ["local_path", "name"],
    },
  },
```

- [ ] **Step 6: Wire the tool into `server/server.mjs` (Node-only — as an `if` block ABOVE the switch)**

> ⚠️ Integration shape (verified against the real file by adversarial review): `server.mjs` has **no `jsonResult` helper**, and its big tool `switch` (server.mjs:452-850) is a **payload-builder** — each `case` sets `payload = {...}; break;` and falls through to ONE shared tail `const result = await submit(name, payload, toolTimeoutMs(name, args))` at **server.mjs:848**. A Node-only tool that does its own async work and returns directly must therefore live as an `if (name === "...")` block **above** the switch — exactly like the existing `get_connection_status` block at **server.mjs:354-450** — NOT as a switch `case` (a case would fall through and wrongly `submit` to the plugin).

Add near the top of the file: `import { uploadAsset, pollOperation } from "./lib/open-cloud.mjs";`

Define this helper once at the very top of the `CallToolRequestSchema` handler body (it reproduces the inline shape already used at server.mjs:449 and :849):

```js
  const jsonResult = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
```

Then add this block alongside the other `if (name === ...)` blocks (near server.mjs:438), **above** the payload-builder switch:

```js
  if (name === "roblox_upload_asset") {
    const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    const creatorId = process.env.ROBLOX_OPEN_CLOUD_CREATOR_ID;
    const creatorType = process.env.ROBLOX_OPEN_CLOUD_CREATOR_TYPE || "User";
    if (!apiKey || !creatorId) {
      return jsonResult({ ok: false, error: "ROBLOX_OPEN_CLOUD_API_KEY and ROBLOX_OPEN_CLOUD_CREATOR_ID must be set" });
    }
    try {
      const { operationId } = await uploadAsset({ apiKey, creatorId, creatorType, filePath: args.local_path, displayName: args.name, description: args.description });
      const { assetId } = await pollOperation({ apiKey, operationId });
      return jsonResult({ ok: true, assetId, kind: args.asset_type || "Model" });
    } catch (e) {
      return jsonResult({ ok: false, error: String(e.message || e) });
    }
  }
```

- [ ] **Step 7: Verify**

Run: `node --check server/server.mjs && node --test server/test/`
Expected: syntax OK; all tests (http-bridge + open-cloud) PASS.

- [ ] **Step 8: Commit**

```bash
git add server/lib/open-cloud.mjs server/test/open-cloud.test.mjs server/tools.mjs server/server.mjs
git commit -m "feat(roblox): roblox_upload_asset — Open Cloud .glb upload + poll

Zero-dep Open Cloud client (global fetch/FormData/Blob): multipart POST
/assets/v1/assets (assetType Model, .glb as model/gltf-binary, creator.userId
string, 20MB cap) then poll /assets/v1/operations/{id} until done:true ->
response.assetId, with 429/Retry-After backoff. All logging routes through
redactHeaders so x-api-key never leaks. Tests run against a local mock on an
ephemeral port. New roblox_upload_asset tool is Node-only (no plugin hop).

Implements spec §4.4 (upload half), §5.2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `roblox_insert_uploaded_model` (Lua + Node) + `import_blender_model` composite

The insert half + the composite. The Lua handler mirrors the existing `insert_model` (`plugin/MultiAIPlugin.lua:943-963`) — LoadAsset outside recording, reparent inside — plus a moderation-retry loop.

**Files:**
- Modify: `plugin/MultiAIPlugin.lua` (add `handlers.insert_uploaded_model` near the existing `insert_model` ~line 963)
- Modify: `server/tools.mjs` (append `roblox_insert_uploaded_model` + `import_blender_model` schemas)
- Modify: `server/server.mjs` (add switch cases; `import_blender_model` composes upload + insert, else EditableMesh fallback stub that Task 7 fills)

**Interfaces:**
- Consumes: `submit` (for the plugin hop), `uploadAsset`/`pollOperation` (Task 5).
- Produces: command type `insert_uploaded_model`; tools `roblox_insert_uploaded_model`, `import_blender_model`.

- [ ] **Step 1: Add the Lua handler** (`plugin/MultiAIPlugin.lua`, after `handlers.insert_model` ends ~line 963)

```lua
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
```

- [ ] **Step 2: Add the tool schemas** (`server/tools.mjs`, append to TOOLS)

```js
  {
    name: "roblox_insert_uploaded_model",
    description: "Insert an already-uploaded asset into Studio by assetId (InsertService:LoadAsset + reparent, with moderation retry).",
    inputSchema: { type: "object", properties: { assetId: { type: "number" }, parent_path: { type: "string", default: "Workspace" }, name: { type: "string" } }, required: ["assetId"] },
  },
  {
    name: "import_blender_model",
    description: "End-to-end: upload a local .glb via Open Cloud then insert into Studio. Falls back to EditableMesh (no cloud) when ROBLOX_OPEN_CLOUD_API_KEY is unset.",
    inputSchema: { type: "object", properties: { local_path: { type: "string" }, parent_path: { type: "string", default: "Workspace" }, name: { type: "string" } }, required: ["local_path"] },
  },
```

- [ ] **Step 3: Wire both tools into `server/server.mjs` (as `if` blocks above the switch)**

Both are Node-orchestrated and return directly, so — like Task 5 — they go **above** the payload-builder switch as `if (name === ...)` blocks reusing the Task-5 `jsonResult` helper. Neither can be a `break`-style `case`: `import_blender_model` has no matching plugin command, and `roblox_insert_uploaded_model` must submit the command type **`insert_uploaded_model`** (the plugin handler name, no `roblox_` prefix) — a `break` case would reuse `name` and wrongly submit `roblox_insert_uploaded_model`, which the plugin rejects as unknown.

```js
  if (name === "roblox_insert_uploaded_model") {
    // NOTE: command type is "insert_uploaded_model" (plugin handler), NOT the tool name.
    const result = await submit("insert_uploaded_model", {
      assetId: args.assetId, parent: args.parent_path || "Workspace", name: args.name,
    });
    return jsonResult(result);
  }

  if (name === "import_blender_model") {
    const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    const creatorId = process.env.ROBLOX_OPEN_CLOUD_CREATOR_ID;
    const creatorType = process.env.ROBLOX_OPEN_CLOUD_CREATOR_TYPE || "User";
    if (apiKey && creatorId) {
      try {
        const { operationId } = await uploadAsset({ apiKey, creatorId, creatorType, filePath: args.local_path, displayName: args.name || "BlenderModel" });
        const { assetId } = await pollOperation({ apiKey, operationId });
        const result = await submit("insert_uploaded_model", { assetId: Number(assetId), parent: args.parent_path || "Workspace", name: args.name });
        return jsonResult({ ok: true, via: "open_cloud", assetId, ...result });
      } catch (e) {
        return jsonResult({ ok: false, via: "open_cloud", error: String(e.message || e) });
      }
    }
    return await importViaEditableMesh(args); // EditableMesh fallback (Task 7) — builds its own content shape
  }
```

> Forward reference: `importViaEditableMesh` is defined in Task 7. To keep the Task-6 commit's working tree parsable, add this stub now (Task 7 replaces it). It returns the content shape directly (it is a top-level function, not inside the CallTool handler, so it has no access to the local `jsonResult`):
> ```js
> async function importViaEditableMesh(args) { return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "EditableMesh fallback not yet implemented" }, null, 2) }] }; }
> ```

- [ ] **Step 4: Verify Lua + Node syntax**

Run: `node --check server/server.mjs && node --test server/test/`
Expected: syntax OK; tests PASS.
Lua: inspect the new handler — confirm it uses `withRecording`, `tonumber`, `task.wait` (not `wait()`), and `resolvePath` like its neighbors. Cannot run Studio here.

- [ ] **Step 5: Commit**

```bash
git add plugin/MultiAIPlugin.lua server/tools.mjs server/server.mjs
git commit -m "feat(roblox): insert_uploaded_model + import_blender_model composite

Lua insert_uploaded_model mirrors insert_model (LoadAsset outside recording,
reparent inside) with a 5x moderation-retry since freshly-uploaded assets are
briefly unavailable. Node import_blender_model chains uploadAsset->pollOperation
->insert when Open Cloud env is set, else routes to the EditableMesh fallback
(Task 7). roblox_insert_uploaded_model exposes the insert step standalone.

Implements spec §4.4 (insert half), §5.2, §6.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: EditableMesh fallback — glb parser + batched `editable_mesh_build`

No-cloud path: parse the `.glb` in Node, stream vertices/triangles in ≤4,000-each batches over the 8765 bridge, plugin assembles one EditableMesh → MeshPart.

**Files:**
- Create: `server/lib/glb.mjs`, `server/test/glb.test.mjs`
- Modify: `server/server.mjs` (implement `importViaEditableMesh`, replacing the Task-6 stub)
- Modify: `plugin/MultiAIPlugin.lua` (add `handlers.editable_mesh_build`)

**Interfaces:**
- Produces: `parseGlb` (signature above); command type `editable_mesh_build`; function `importViaEditableMesh(args)`.

- [ ] **Step 1: Write the failing glb-parser test (self-contained — builds a 1-triangle glb in-memory)**

Create `server/test/glb.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGlb } from "../lib/glb.mjs";

// Build a minimal valid GLB: 3 vertices (float32 VEC3) + 3 indices (uint16 SCALAR).
function makeTriangleGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const posBytes = Buffer.from(positions.buffer);
  let idxBytes = Buffer.from(indices.buffer);
  // bin chunk must be 4-byte aligned
  const pad = (4 - ((posBytes.length + idxBytes.length) % 4)) % 4;
  const bin = Buffer.concat([posBytes, idxBytes, Buffer.alloc(pad)]);

  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },   // 5126 = FLOAT
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }, // 5123 = UNSIGNED_SHORT
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  };
  let json = Buffer.from(JSON.stringify(gltf), "utf8");
  const jpad = (4 - (json.length % 4)) % 4;
  json = Buffer.concat([json, Buffer.alloc(jpad, 0x20)]); // pad JSON with spaces

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  const total = 12 + 8 + json.length + 8 + bin.length;
  header.writeUInt32LE(total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  return Buffer.concat([header, jsonHeader, json, binHeader, bin]);
}

test("parseGlb extracts vertices and triangles from a 1-triangle glb", () => {
  const out = parseGlb(makeTriangleGlb());
  assert.equal(out.vertices.length, 3);
  assert.deepEqual(out.vertices[1], [1, 0, 0]);
  assert.equal(out.triangles.length, 1);
  assert.deepEqual(out.triangles[0], [0, 1, 2]);
});

test("parseGlb rejects a non-glTF buffer", () => {
  assert.throws(() => parseGlb(Buffer.from([1, 2, 3, 4])), /not a GLB/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/test/glb.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/lib/glb.mjs`**

```js
/**
 * server/lib/glb.mjs
 * Minimal binary-glTF (.glb) parser — zero deps. Extracts the first mesh's first
 * primitive: POSITION (VEC3 float32), indices (SCALAR uint16/uint32), optional
 * NORMAL (VEC3 float32) and TEXCOORD_0 (VEC2 float32). Enough for Roblox
 * EditableMesh assembly. Throws on anything it can't handle so the caller can
 * fall back / report cleanly.
 */
const FLOAT = 5126, USHORT = 5123, UINT = 5125, UBYTE = 5121;
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(accessors, views, bin, idx) {
  const acc = accessors[idx];
  const view = views[acc.bufferView];
  const comps = COMPS[acc.type];
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  if (acc.componentType === FLOAT) {
    for (let i = 0; i < acc.count; i++) {
      const row = [];
      for (let c = 0; c < comps; c++) row.push(bin.readFloatLE(base + (i * comps + c) * 4));
      out.push(comps === 1 ? row[0] : row);
    }
  } else if (acc.componentType === USHORT) {
    for (let i = 0; i < acc.count; i++) out.push(bin.readUInt16LE(base + i * 2));
  } else if (acc.componentType === UINT) {
    for (let i = 0; i < acc.count; i++) out.push(bin.readUInt32LE(base + i * 4));
  } else if (acc.componentType === UBYTE) {
    for (let i = 0; i < acc.count; i++) out.push(bin.readUInt8(base + i));
  } else {
    throw new Error(`unsupported componentType ${acc.componentType}`);
  }
  return out;
}

export function parseGlb(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 12 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB (bad magic)");

  let offset = 12, json = null, bin = null;
  while (offset < buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942) bin = data;
    offset += 8 + len;
  }
  if (!json) throw new Error("no JSON chunk");
  if (!bin) throw new Error("no BIN chunk (external buffers unsupported)");

  const mesh = (json.meshes || [])[0];
  if (!mesh) throw new Error("no mesh");
  const prim = mesh.primitives[0];
  const accessors = json.accessors, views = json.bufferViews;

  const posFlat = readAccessor(accessors, views, bin, prim.attributes.POSITION);
  const vertices = posFlat.map((v) => (Array.isArray(v) ? v : [v]));
  const idxFlat = prim.indices != null ? readAccessor(accessors, views, bin, prim.indices) : vertices.map((_, i) => i);
  const triangles = [];
  for (let i = 0; i + 2 < idxFlat.length; i += 3) triangles.push([idxFlat[i], idxFlat[i + 1], idxFlat[i + 2]]);

  const normals = prim.attributes.NORMAL != null ? readAccessor(accessors, views, bin, prim.attributes.NORMAL) : null;
  const uvs = prim.attributes.TEXCOORD_0 != null ? readAccessor(accessors, views, bin, prim.attributes.TEXCOORD_0) : null;
  return { vertices, triangles, normals, uvs };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/test/glb.test.mjs`
Expected: PASS (both tests).

- [ ] **Step 5: Add the Lua `editable_mesh_build` handler** (`plugin/MultiAIPlugin.lua`)

```lua
-- Module-level (near other state, after `handlers` is declared): batch sessions.
local emSessions: { [string]: { em: any, vertMap: { [number]: number } } } = {}

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
```

- [ ] **Step 6: Implement `importViaEditableMesh`** (`server/server.mjs`, replace the Task-6 stub)

```js
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseGlb } from "./lib/glb.mjs";

const EM_VERT_BATCH = 4000; // triangles ride the final vertex batch (see note); no separate tri batching in v1.
// importViaEditableMesh is a TOP-LEVEL function (not inside the CallTool handler),
// so it has no access to the local `jsonResult` — it builds the content shape itself.
const emResult = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

async function importViaEditableMesh(args) {
  let mesh;
  try {
    mesh = parseGlb(await readFile(args.local_path));
  } catch (e) {
    return emResult({ ok: false, via: "editable_mesh", error: `glb parse failed: ${e.message}` });
  }
  // Guard: a valid glb whose first primitive has no geometry would otherwise send
  // zero batches and report a false success (no MeshPart created). No silent truncation.
  if (mesh.vertices.length === 0 || mesh.triangles.length === 0) {
    return emResult({ ok: false, via: "editable_mesh", error: "parsed mesh has no geometry (0 verts/tris)" });
  }
  if (mesh.triangles.length > 20000 || mesh.vertices.length > 60000) {
    return emResult({ ok: false, via: "editable_mesh", error: "exceeds EditableMesh limits (20k tris / 60k verts) — decimate in Blender" });
  }
  const sessionId = randomUUID();
  // Stream vertices in batches; triangles ride along with the LAST batch so all
  // vertex ids exist before any triangle references them.
  let last;
  for (let v = 0; v < mesh.vertices.length; v += EM_VERT_BATCH) {
    const isLastVertBatch = v + EM_VERT_BATCH >= mesh.vertices.length;
    last = await submit("editable_mesh_build", {
      sessionId,
      name: args.name || "BlenderMesh",
      parent: args.parent_path || "Workspace",
      vertexBase: v,
      vertices: mesh.vertices.slice(v, v + EM_VERT_BATCH),
      triangles: isLastVertBatch ? mesh.triangles : [],
      finalize: isLastVertBatch,
    }, 120_000);
    if (last && last.error) return emResult({ ok: false, via: "editable_mesh", ...last });
  }
  if (!last) return emResult({ ok: false, via: "editable_mesh", error: "no batches sent (empty mesh)" });
  return emResult({ ok: true, via: "editable_mesh", ...last });
}
```

> Triangle-batching note: triangles are sent only with the final vertex batch so every referenced vertex id already exists plugin-side. For meshes whose triangle count alone would exceed the 8 MB body cap (~50k+ tris), this would need triangle-only follow-up batches — but the 20k-tri hard cap above keeps a single finalize batch comfortably under 8 MB (~20k tris × ~30 B ≈ 600 KB). No silent truncation: the cap rejects oversized meshes explicitly.

- [ ] **Step 7: Verify**

Run: `node --check server/server.mjs && node --test server/test/`
Expected: syntax OK; all tests (http-bridge, open-cloud, glb) PASS.
Lua: inspect `editable_mesh_build` — confirm `AssetService:CreateEditableMesh`, `Content.fromObject`, `withRecording`, session cleanup.

- [ ] **Step 8: Commit**

```bash
git add server/lib/glb.mjs server/test/glb.test.mjs server/server.mjs plugin/MultiAIPlugin.lua
git commit -m "feat(roblox): EditableMesh fallback — glb parser + batched build

Zero-dep binary-glTF parser (POSITION/indices/NORMAL/TEXCOORD_0) with a
self-contained 1-triangle test fixture. importViaEditableMesh streams vertices
in <=4000 batches over the 8765 bridge; triangles ride the final batch so all
vertex ids exist before reference. Plugin editable_mesh_build assembles one
AssetService EditableMesh across batches and CreateMeshPartAsync-es it under a
ChangeHistoryService recording. Hard-refuses >20k tris / >60k verts (no silent
truncation). This is the no-Open-Cloud-key path for import_blender_model.

Implements spec §4.5, §11 (mesh-limit rows).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 9: MANUAL CHECKPOINT — EditableMesh end-to-end (deployment machine; satisfies §14.4)**

`node --check`/`node --test` only cover the parser + Lua inspection; the no-cloud insert can only be proven in a running Studio. On the deployment machine, with **`ROBLOX_OPEN_CLOUD_API_KEY` unset**: export a real mesh from Blender (`blender_export_to_roblox`), then `import_blender_model(local_path=…, parent_path="Workspace/Map/Decorations")` and confirm a `MeshPart` appears under that parent (the result reports `via:"editable_mesh"`). Also run one mesh near the 20k-tri cap to exercise the boundary (just under → succeeds; just over → `triangle_budget_exceeded` from the exporter, or the EditableMesh limit error). Per verification-before-completion, do not mark §14.4 satisfied until this passes; route the visual confirmation through `roblox-tester` (`capture_studio_window`).

---

## Task 8: Wiring — `.mcp.json` + `blender-builder` agent + `CLAUDE.md`

**Files:**
- Modify: `.mcp.json`
- Create: `.claude/agents/blender-builder.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the blender server to `.mcp.json`**

```json
{
  "mcpServers": {
    "roblox": {
      "command": "node",
      "args": ["server/server.mjs"]
    },
    "blender": {
      "command": "node",
      "args": ["blender/server.mjs"]
    }
  }
}
```

- [ ] **Step 2: Verify `.mcp.json` is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Create `.claude/agents/blender-builder.md`**

```markdown
---
name: blender-builder
description: Builds the Blender side of the 3D world — bmesh primitives + modifiers — and hands finished meshes to Roblox via import_blender_model. Use when a request needs custom mesh geometry (organic shapes, props, non-cuboid decorations) that Roblox Parts can't express. Does NOT script gameplay or build GUIs.
model: opus
tools:
  - mcp__blender__blender_create_primitive
  - mcp__blender__blender_set_transform
  - mcp__blender__blender_boolean
  - mcp__blender__blender_array
  - mcp__blender__blender_mirror
  - mcp__blender__blender_subdivide
  - mcp__blender__blender_bevel
  - mcp__blender__blender_set_material
  - mcp__blender__blender_get_tree
  - mcp__blender__blender_get_bounds
  - mcp__blender__blender_screenshot
  - mcp__blender__blender_get_connection_status
  - mcp__blender__blender_export_to_roblox
  - mcp__blender__blender_undo
  - mcp__blender__blender_save_as
  - mcp__roblox__import_blender_model
---

You build custom 3D meshes in Blender via bmesh primitives + modifiers, iterate
visually with `blender_screenshot`, export to `.glb` under
`%LOCALAPPDATA%/Roblox-MCP/blender/exports/`, and hand off to Studio with
`import_blender_model`. Always confirm `blender_get_connection_status` returns
`addonConnected:true` before building. Keep meshes under the export
`max_triangles` budget. You do NOT write gameplay scripts or GUIs — that is the
scripter/ui agents' job.
```

- [ ] **Step 4: Update `CLAUDE.md`**

Add a row to the team table:
```
| `blender-builder` | Opus | Custom mesh geometry in Blender (organic/non-cuboid props) → import into Studio via Open Cloud / EditableMesh. |
```
Add to the routing rules: requests needing custom mesh geometry (organic shapes, props the part-builder can't express) → `blender-builder`. Add a "Blender connection check" paragraph mirroring the Roblox one: `blender_get_connection_status` → `{addonConnected, ready}`; if false, ensure Blender is open with the Multi-AI add-on enabled (run `.\sync-blender-addon.ps1` + enable in Preferences). Add the new env vars (`BLENDER_MCP_PORT`, `BLENDER_MCP_TOKEN`, `BLENDER_WORKSPACE_DIR`, `ROBLOX_OPEN_CLOUD_*`) to the env reference. Note mesh-import verification routes through `roblox-tester` (`capture_studio_window` after import), per the existing playtest rule.

- [ ] **Step 5: Verify CLAUDE.md + agent file**

Run: `node --check server/server.mjs` (sanity) and visually confirm the agent frontmatter is valid YAML + the CLAUDE.md table renders.

- [ ] **Step 6: Commit**

```bash
git add .mcp.json .claude/agents/blender-builder.md CLAUDE.md
git commit -m "feat: wire blender bridge — .mcp.json, blender-builder agent, CLAUDE.md

Registers the blender MCP server, adds the Opus blender-builder subagent
(bmesh tools + import_blender_model), and documents the team row, routing
rule (custom mesh geometry -> blender-builder), Blender connection check, and
new env vars. Mesh-import verification routes through roblox-tester.

Implements spec §8, §9, §10.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (run against the spec with fresh eyes) + adversarial-review outcome

This plan was grounded by a 5-agent research pass (code-mapping of the real `server.mjs`/`tools.mjs`/`MultiAIPlugin.lua` + Blender 4.5/5.0 and Open Cloud API verification) and hardened by a 4-critic adversarial review. The Node critic **executed the zero-dep modules+tests on Node v24** (glb parser fixture confirmed byte-perfect; Open Cloud multipart/429/backoff confirmed; the batching math confirmed). The fixes below were applied after that review.

**1. Spec coverage** — every spec section maps to a task:
- §3 topology / §4.1 blender server → Task 2 ✓ · §4.2 addon → Task 3 ✓ · §4.3 shared lib → Task 1 ✓ · §4.4 upload+insert → Tasks 5,6 ✓ (**texture/SurfaceAppearance sub-bullet DEFERRED to v1.1 — see "Deferred from spec"**) · §4.5 EditableMesh → Task 7 ✓ · §5.1 blender tools → Task 2 ✓ (`torus` removed, `texture_path` removed — deferred) · §5.2 roblox tools → Tasks 5,6 ✓ · §5.3 refuse list → Task 2 (tools not declared) + Global Constraints ✓ · §6 end-to-end → Tasks 5,6,7 + Task 3 Step 5 manual checkpoint ✓ · §7 hardening → Task 1 ✓ · §8 agent wiring → Task 8 ✓ · §9 file layout → File Structure + all tasks ✓ · §10 env → Global Constraints + Task 8 (`BLENDER_WORKSPACE_DIR` now read by `h_export_to_roblox`) ✓ · §11 risks → caps (Task 7), moderation retry (Task 6), redaction (Tasks 1/5); **texture/Decal row deferred** ✓ · §13 open decisions: none ✓ · §14 acceptance → §14.1-3 Tasks 1-2 + Task 3 Step 5; **§14.4 EditableMesh → Task 7 Step 9 manual checkpoint**; §14.5 bit-identical → Task 1 ✓.
- **Refinements over spec (intentional, research-driven, flagged to the user):** redaction is *created* not extended (Task 1); export defaults to `.glb`, no `global_scale` kwarg (Task 3); addon stays single-file legacy `bl_info` for 4.5+5.0 with the extension path documented (Task 3).

**2. Adversarial findings fixed (high/medium confidence):**
- **CRITICAL** `jsonResult` did not exist in `server.mjs` and its tool `switch` is a payload-builder, not a return-dispatcher. → Tasks 5/6 now define a `jsonResult` helper and place the three Node-orchestrated tools as `if (name===...)` blocks **above** the switch (mirroring `get_connection_status`), with `roblox_insert_uploaded_model` explicitly submitting command type `insert_uploaded_model`.
- **CRITICAL** Task 1's test could not pass (host-allowlist frozen at `port:0`; EADDRINUSE test read `.address()` before the async bind). → lib rebuilds the allowlist in the listen callback for ephemeral ports; the test awaits the bind and uses an absolute child import. (Node critic confirmed the corrected forms pass.)
- **MAJOR** `importViaEditableMesh` returned `{ok:true}` on an empty mesh. → guarded (0-vert/0-tri → explicit error); dead `EM_TRI_BATCH` removed; builds its own content shape.
- **MAJOR** addon: `render.opengl` had no VIEW_3D override (now found+temp_override'd, filepath restored); `_post_result` blocked the main thread (now offloaded via `_post_result_async`); triangle budget counted the raw mesh (now evaluated/depsgraph); `undo_push` fired for reads (now skipped for `READ_ONLY`).
- **MAJOR** Lua `editable_mesh_build` put the yielding `CreateMeshPartAsync` inside the recording → moved outside (matches `insert_model`), `Content.fromObject` guarded, session cleaned up on append error.
- **MAJOR** texture pipeline advertised but dead → `texture_path`/`torus` removed and explicitly deferred.
- Minor fixes: `os.makedirs("")` guard, Principled-BSDF lookup-by-type, 429+error poll tests added.

**3. Type consistency** — `submit(type,payload,timeoutMs)` matches across the lib and both servers; `getStatus()` shape matches the `blender_get_connection_status`/`get_connection_status` mappings; command types `insert_uploaded_model`/`editable_mesh_build` match between the Node `submit(...)` calls and the Lua handler names (tool names are deliberately NOT the command types — documented inline); `parseGlb` `{vertices,triangles,normals,uvs}` matches `importViaEditableMesh`; `uploadAsset`/`pollOperation` signatures match Tasks 5/6 call sites.

**Open verification debts (cannot close from this shell — manual checkpoints in the plan):** (a) full `node server/server.mjs`/`blender/server.mjs` boot needs the SDK from the deployment `node_modules` (memory `deployment-vs-repo`); (b) the Blender add-on + the two Lua handlers are inspection-only here — Task 3 Step 5, Task 6 Step 5, Task 7 Step 9, and the §6 happy-path are deployment-machine checkpoints, routed through `roblox-tester` for visual confirmation per CLAUDE.md.
