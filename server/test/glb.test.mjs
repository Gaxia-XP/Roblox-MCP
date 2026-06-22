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
