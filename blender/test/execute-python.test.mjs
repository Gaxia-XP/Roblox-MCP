import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../../server/lib/http-bridge.mjs";
import { BLENDER_TOOLS } from "../tools.mjs";

test("BLENDER_TOOLS includes blender_execute_python", () => {
  const tool = BLENDER_TOOLS.find(t => t.name === "blender_execute_python");
  assert.ok(tool, "blender_execute_python tool must exist");
  assert.equal(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties.code, "must have code property");
  assert.ok(tool.inputSchema.required.includes("code"), "code must be required");
});

test("execute_python: simple print", async (t) => {
  // This test requires a live Blender connection.
  // Skip if BLENDER_MCP_PORT not set or Blender not running.
  const port = parseInt(process.env.BLENDER_MCP_PORT || "8766");
  const bridge = createBridge({ port: 0, brandPrefix: "[test]" });

  try {
    // Check if Blender is connected
    const status = bridge.getStatus();
    if (!status.pluginConnected) {
      t.skip("Blender not connected");
      return;
    }

    // Execute simple print
    const result = await bridge.call("blender_execute_python", {
      code: 'print("hello from test")'
    });

    assert.equal(result.ok, true);
    assert.ok(result.output.includes("hello from test"), `expected "hello from test" in output, got: ${result.output}`);
  } finally {
    bridge.httpServer?.close();
  }
});

test("execute_python: math operations", async (t) => {
  const port = parseInt(process.env.BLENDER_MCP_PORT || "8766");
  const bridge = createBridge({ port: 0, brandPrefix: "[test]" });

  try {
    const status = bridge.getStatus();
    if (!status.pluginConnected) {
      t.skip("Blender not connected");
      return;
    }

    const result = await bridge.call("blender_execute_python", {
      code: 'import math\nprint(math.pi * 2)'
    });

    assert.equal(result.ok, true);
    assert.ok(result.output.includes("6.28"), `expected pi*2 in output, got: ${result.output}`);
  } finally {
    bridge.httpServer?.close();
  }
});

test("execute_python: syntax error", async (t) => {
  const port = parseInt(process.env.BLENDER_MCP_PORT || "8766");
  const bridge = createBridge({ port: 0, brandPrefix: "[test]" });

  try {
    const status = bridge.getStatus();
    if (!status.pluginConnected) {
      t.skip("Blender not connected");
      return;
    }

    const result = await bridge.call("blender_execute_python", {
      code: 'print("unclosed string'
    });

    assert.equal(result.ok, false);
    assert.ok(result.error, "should return error for syntax error");
    assert.ok(result.error.includes("SyntaxError") || result.error.includes("EOL"),
      `expected SyntaxError, got: ${result.error}`);
  } finally {
    bridge.httpServer?.close();
  }
});

test("execute_python: security - blocks os import", async (t) => {
  const port = parseInt(process.env.BLENDER_MCP_PORT || "8766");
  const bridge = createBridge({ port: 0, brandPrefix: "[test]" });

  try {
    const status = bridge.getStatus();
    if (!status.pluginConnected) {
      t.skip("Blender not connected");
      return;
    }

    const result = await bridge.call("blender_execute_python", {
      code: 'import os\nprint(os.getcwd())'
    });

    assert.equal(result.ok, false);
    assert.ok(result.error.includes("Blocked") || result.error.includes("os"),
      `expected security block, got: ${result.error}`);
  } finally {
    bridge.httpServer?.close();
  }
});

test("execute_python: bpy access works", async (t) => {
  const port = parseInt(process.env.BLENDER_MCP_PORT || "8766");
  const bridge = createBridge({ port: 0, brandPrefix: "[test]" });

  try {
    const status = bridge.getStatus();
    if (!status.pluginConnected) {
      t.skip("Blender not connected");
      return;
    }

    const result = await bridge.call("blender_execute_python", {
      code: 'print(len(bpy.data.objects))'
    });

    assert.equal(result.ok, true);
    assert.ok(result.output.match(/\d+/), `expected number in output, got: ${result.output}`);
  } finally {
    bridge.httpServer?.close();
  }
});
