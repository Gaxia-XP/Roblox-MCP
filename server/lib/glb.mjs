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
