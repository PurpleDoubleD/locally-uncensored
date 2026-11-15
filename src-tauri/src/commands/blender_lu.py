"""LU: bring one GLB made in Create, 3D into Blender.

Run by LU only (commands/blender.rs), never by hand:

    blender [-b --factory-startup] --python-exit-code 1 -P blender_lu.py -- MODE GLB NAME [OUT]

MODE   open   import into the Blender that just started with its window,
              select the model and frame the view on it
       blend  (background) import into an empty scene, save OUT as .blend
              with the textures packed into it
       fbx    (background) import into an empty scene, write OUT as .fbx
              with the textures embedded
GLB    the model as LU made it (glTF 2.0 binary)
NAME   what the model is called in Blender (the object and its collection)
OUT    the file to write (blend and fbx only)

Every argument is data. Nothing here builds or runs code from them.

glTF is Y up and counts in meters, the front of a model faces +Z. Blender's
own glTF importer turns that into Blender's Z up with the front facing -Y
(the Front view), so this script does not rotate or scale anything. It only
moves the model so it stands on the floor in the middle of the scene.

The last line on stdout is `LU_BLENDER {json}` with what was imported, or
with "ok": false and the reason.
"""

import json
import sys

import bpy

MODES = ("open", "blend", "fbx")
MAX_NAME = 60


def parse_args(argv):
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(rest) < 3 or rest[0] not in MODES:
        raise ValueError("usage: -- open|blend|fbx GLB NAME [OUT]")
    mode, src, name = rest[0], rest[1], rest[2]
    out = rest[3] if len(rest) > 3 else ""
    if mode != "open" and not out:
        raise ValueError("no output file")
    name = "".join(c for c in name if c.isprintable()).strip()[:MAX_NAME] or "LU model"
    return mode, src, name, out


def is_default_scene(scene):
    """The scene a fresh Blender opens with: a cube, a camera, a light."""
    objs = list(scene.objects)
    if sorted(o.type for o in objs) != ["CAMERA", "LIGHT", "MESH"]:
        return False
    cube = next(o for o in objs if o.type == "MESH")
    return cube.name == "Cube" and len(cube.data.vertices) == 8


def import_glb(src, name):
    scene = bpy.context.scene
    coll = bpy.data.collections.new(name)
    scene.collection.children.link(coll)
    layer = bpy.context.view_layer.layer_collection.children[coll.name]
    bpy.context.view_layer.active_layer_collection = layer

    before = set(bpy.data.objects)
    result = bpy.ops.import_scene.gltf(filepath=src)
    if "FINISHED" not in result:
        raise RuntimeError("Blender could not read the model.")
    new = [o for o in bpy.data.objects if o not in before]
    if not new:
        raise RuntimeError("The model file holds nothing to show.")

    roots = [o for o in new if o.parent is None]
    if len(roots) == 1:
        root = roots[0]
    else:
        root = bpy.data.objects.new(name, None)
        coll.objects.link(root)
        for o in roots:
            o.parent = root
        new.append(root)
    root.name = name
    meshes = [o for o in new if o.type == "MESH"]
    if len(meshes) == 1 and meshes[0] is not root:
        meshes[0].name = name + " mesh"
    for o in meshes:
        if o.data.users == 1:
            o.data.name = o.name

    stand_on_floor(root, meshes)
    return coll, root, new, meshes


def world_bounds(meshes):
    bpy.context.view_layer.update()
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for o in meshes:
        m = o.matrix_world
        for v in o.data.vertices:
            p = m @ v.co
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    if lo[0] == float("inf"):
        return [0.0] * 3, [0.0] * 3
    return lo, hi


def stand_on_floor(root, meshes):
    """Middle of the scene, bottom on Z = 0. A move of the root only."""
    lo, hi = world_bounds(meshes)
    root.location.x -= (lo[0] + hi[0]) / 2
    root.location.y -= (lo[1] + hi[1]) / 2
    root.location.z -= lo[2]


def facts(new, meshes):
    lo, hi = world_bounds(meshes)
    mats = set()
    images = set()
    tris = 0
    for o in meshes:
        for slot in o.material_slots:
            if slot.material:
                mats.add(slot.material)
        for p in o.data.polygons:
            tris += len(p.vertices) - 2
    for mat in mats:
        if mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    images.add(node.image)
    return {
        "objects": len(new),
        "meshes": len(meshes),
        "triangles": tris,
        "materials": len(mats),
        "images": len(images),
        "colorAttributes": sum(len(o.data.color_attributes) for o in meshes),
        "min": [round(v, 5) for v in lo],
        "max": [round(v, 5) for v in hi],
        "size": [round(hi[i] - lo[i], 5) for i in range(3)],
    }


def frame_when_ready(root, objects, tries=40):
    """The window is not drawn yet while --python runs: frame a moment later."""
    state = {"left": tries}

    def frame():
        done = False
        wm = bpy.context.window_manager
        for win in wm.windows:
            for area in win.screen.areas:
                if area.type != "VIEW_3D":
                    continue
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region is None:
                    continue
                space = area.spaces.active
                if getattr(space, "shading", None) is not None:
                    space.shading.type = "MATERIAL"
                with bpy.context.temp_override(window=win, area=area, region=region):
                    bpy.ops.view3d.view_selected()
                done = True
        state["left"] -= 1
        if done or state["left"] <= 0:
            return None
        return 0.25

    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objects:
        if o.name in bpy.context.view_layer.objects:
            o.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.app.timers.register(frame, first_interval=0.5)


def run(mode, src, name, out):
    if mode == "open":
        scene = bpy.context.scene
        if is_default_scene(scene):
            cube = scene.objects["Cube"]
            mesh = cube.data
            bpy.data.objects.remove(cube)
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)

    _coll, root, new, meshes = import_glb(src, name)
    report = facts(new, meshes)
    report["name"] = root.name

    if mode == "open":
        frame_when_ready(root, new)
    elif mode == "blend":
        bpy.ops.file.pack_all()
        bpy.ops.wm.save_as_mainfile(filepath=out, check_existing=False, compress=True)
    elif mode == "fbx":
        bpy.ops.export_scene.fbx(
            filepath=out,
            check_existing=False,
            use_selection=False,
            object_types={"EMPTY", "MESH"},
            path_mode="COPY",
            embed_textures=True,
            add_leaf_bones=False,
            bake_anim=False,
        )
    return report


def main():
    try:
        mode, src, name, out = parse_args(sys.argv)
        report = run(mode, src, name, out)
        report["ok"] = True
        report["mode"] = mode
        report["blender"] = bpy.app.version_string
        print("LU_BLENDER " + json.dumps(report), flush=True)
    except Exception as e:  # noqa: BLE001, the reason goes back to LU
        print("LU_BLENDER " + json.dumps({"ok": False, "error": str(e)}), flush=True)
        if bpy.app.background:
            sys.exit(1)


main()
