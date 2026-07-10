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

def h_execute_python(p):
    import sys
    from io import StringIO
    code = p["code"]
    # Security: block dangerous builtins
    BLOCKED = {"os", "subprocess", "sys", "eval", "compile", "__import__"}
    for banned in BLOCKED:
        if banned in code:
            return {"ok": False, "error": f"Blocked module/builtin: {banned}"}
    # Capture stdout
    old_stdout = sys.stdout
    sys.stdout = capture = StringIO()
    try:
        # Execute in a controlled namespace with safe modules
        namespace = {
            "bpy": bpy,
            "bmesh": bmesh,
            "mathutils": __import__("mathutils"),
            "math": math,
            "Vector": Vector,
        }
        exec(code, namespace)
        output = capture.getvalue()
        return {"ok": True, "output": output}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        sys.stdout = old_stdout

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
    "blender_execute_python": h_execute_python,
}

# ── Main-thread drain (timer) ─────────────────────────────────────────────────
READ_ONLY = {"blender_get_tree", "blender_get_bounds", "blender_screenshot", "blender_execute_python"}

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
