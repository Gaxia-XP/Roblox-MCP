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
