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
