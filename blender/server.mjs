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
