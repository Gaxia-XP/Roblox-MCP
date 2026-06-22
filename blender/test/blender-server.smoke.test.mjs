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
