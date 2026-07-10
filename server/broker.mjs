#!/usr/bin/env node
/**
 * server/broker.mjs
 * Long-lived Roblox MCP broker. Owns 127.0.0.1:<port>, hosts the registry +
 * per-studio command/control queues + sweep/idle. Spawned detached by a losing
 * FE, or bound in-proc by the election winner. Zero MCP SDK; node builtins +
 * lib helpers only. EADDRINUSE (race loser) => exit 0; other errors => exit 1.
 */
import { createRegistry } from "./lib/registry.mjs";
import { createBrokerCore } from "./lib/broker-core.mjs";
import { loadOrMintMachineToken } from "./lib/broker-client.mjs";

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

// ── machine token (§2.7, C4) ──
// Single source of truth: delegate to broker-client's loadOrMintMachineToken so
// the detached child (this process) and the in-proc election leader (ensureBroker)
// read/mint THE SAME token at THE SAME path. Order: explicit ROBLOX_MCP_TOKEN >
// persisted broker-token file > tokenless opt-out > mint (default ON).
const authToken = loadOrMintMachineToken();
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
