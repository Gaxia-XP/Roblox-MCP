#!/usr/bin/env node
/**
 * server/broker.mjs
 * Long-lived Roblox MCP broker. Owns 127.0.0.1:<port>, hosts the registry +
 * per-studio command/control queues + sweep/idle. Spawned detached by a losing
 * FE, or bound in-proc by the election winner. Zero MCP SDK; node builtins +
 * lib helpers only. EADDRINUSE (race loser) => exit 0; other errors => exit 1.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createRegistry } from "./lib/registry.mjs";
import { createBrokerCore } from "./lib/broker-core.mjs";

const REAP_TICK_MS = 5_000;

const PORT = (() => {
  const p = Number(process.env.MCP_BROKER_PORT || process.env.ROBLOX_MCP_PORT);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8765;
})();
const HOST = process.env.MCP_BROKER_HOST || "127.0.0.1";
const IDLE_REAP_MS = (() => {
  const v = Number(process.env.ROBLOX_MCP_BROKER_IDLE_MS);
  return Number.isInteger(v) && v >= 0 ? v : 90_000;
})();
// C6: the broker is the consumer that supplies requireExplicitPair from env.
const REQUIRE_EXPLICIT_PAIR = process.env.ROBLOX_MCP_REQUIRE_EXPLICIT_PAIR === "1";

// ── machine token (§2.7, C4): default ON when ROBLOX_MCP_TOKEN unset ──
function localAppData() {
  return process.env.LOCALAPPDATA || join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "Local");
}
function resolveAuthToken() {
  const explicit = (process.env.ROBLOX_MCP_TOKEN || "").trim();
  if (explicit) return explicit; // operator override wins
  if (process.env.ROBLOX_MCP_ALLOW_TOKENLESS === "1") return ""; // explicit opt-out
  // Default ON: load-or-mint a persisted machine token with a restrictive ACL.
  const dir = join(localAppData(), "Roblox-MCP");
  const file = join(dir, "broker-token");
  try {
    if (existsSync(file)) { const t = readFileSync(file, "utf8").trim(); if (t) return t; }
    mkdirSync(dir, { recursive: true });
    const tok = randomBytes(24).toString("hex");
    writeFileSync(file, tok, { mode: 0o600 });
    return tok;
  } catch {
    // Can't persist a machine token → fall back to tokenless (no worse than today).
    return "";
  }
}

const authToken = resolveAuthToken();
const registry = createRegistry({
  now: Date.now,
  thresholds: {},
  requireExplicitPair: REQUIRE_EXPLICIT_PAIR,
});
const core = createBrokerCore({
  registry, now: Date.now, authToken, brandPrefix: "[roblox-mcp:broker]", idleReapMs: IDLE_REAP_MS,
});

core.httpServer.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    // Race loser: another broker already owns the port → exit 0, the client connects to it.
    console.error(`[roblox-mcp:broker] ${HOST}:${PORT} already bound — yielding (exit 0).`);
    process.exit(0);
  }
  console.error(`[roblox-mcp:broker] FATAL: ${err.message}`);
  process.exit(1);
});

const reaper = setInterval(() => {
  const { shouldReap } = core.sweep(Date.now());
  if (shouldReap) {
    core.beginShutdown();
    const drainTimer = setInterval(() => {
      if (core.inFlight.size === 0 || core._internals.drainExpired(Date.now())) {
        clearInterval(drainTimer);
        clearInterval(reaper);
        core.httpServer.close(() => process.exit(0));
      }
    }, 250);
  }
}, REAP_TICK_MS);
reaper.unref?.();

core.httpServer.listen(PORT, HOST, () => {
  console.error(`[roblox-mcp:broker] listening ${HOST}:${PORT} ${authToken ? "(auth ON)" : "(no token)"}`);
});
