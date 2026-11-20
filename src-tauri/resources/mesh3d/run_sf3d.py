"""LU's own runner of Stable Fast 3D: one picture in, one textured GLB out.

The app starts this once per model (`src-tauri/src/commands/mesh3d_sf3d.rs`)
with `python -I -u run_sf3d.py --lu-mesh3d-job <job.json>` and reads what it
says on stdout: lines that begin with `LU-MESH3D `, each a JSON object with a
`phase` (load, shape, paint, save, done, error, note, beat), the same words the
TripoSR runner uses, so the app reads both the same way.

What it changes against `run.py` of SF3D, and why (read at the pinned commit,
see mesh3d_sf3d.rs):

1. `rembg` is imported at module level by `sf3d/utils.py` and downloads a
   model of its own on first use. LU cuts the object out with Apple's Vision
   before this runs, so a stand-in is put in its place that refuses to work.
2. `gpytoolbox` and `pynanoinstantmeshes` are imported at module level by
   `sf3d/models/mesh.py` and only used for the optional remesh, which LU does
   not offer. Stand-ins that refuse to work take their place.
3. The image encoder (`Dinov2Model.from_pretrained("facebook/dinov2-large")`)
   and the CLIP estimator (`open_clip.create_model_and_transforms(...,
   pretrained="laion2b_s34b_b79k")`) would download weights from the hub
   when the model is built. SF3D loads `model.safetensors` with
   `safetensors.torch.load_model`, which is strict: every weight of both
   encoders is in that file. So both are built empty here, the DINOv2 one from
   its `config.json` that the app downloads at a fixed revision, the CLIP one
   from open_clip's own config, and the file fills them. The run is offline
   (`HF_HUB_OFFLINE=1`).
4. The two C++ extensions (`texture_baker`, `uv_unwrapper`) come as wheels LU
   built itself; the app installs them from its own bundle, never compiles.

The weights are read with safetensors: a file that holds anything but tensors
cannot run code.

`--lu-mesh3d-selftest <out.glb>` runs the native parts without the model: a
small sphere is unwrapped by `uv_unwrapper`, rasterised by `texture_baker` on
the CPU (and on MPS when the Mac has it), and written as a textured GLB. With
`--source <dir>` it also imports SF3D with the stand-ins. The install uses it
to prove the venv and the wheels.
"""

import json
import os
import shutil
import sys
import threading
import time
import traceback
import types

PREFIX = "LU-MESH3D "
JOB_FLAG = "--lu-mesh3d-job"
SELFTEST_FLAG = "--lu-mesh3d-selftest"

DINO_REPO = "facebook/dinov2-large"

# The texture side per step of Detail. The app sends one of these.
TEXTURES = (512, 1024, 2048)


# The step the run is in and since when, for the heartbeat.
STEP = {"name": "start", "since": time.monotonic()}
WORK_STEPS = ("load", "shape", "paint", "save")
# Seconds between two heartbeat lines. The app ends a run that says nothing
# for five minutes; a step of SF3D or TripoSR can work longer than that
# without a line of its own (A50, GitHub #261).
BEAT_SECONDS = 30.0
_SAYING = threading.Lock()


def say(**fields):
    if fields.get("phase") in WORK_STEPS and fields["phase"] != STEP["name"]:
        STEP["name"] = fields["phase"]
        STEP["since"] = time.monotonic()
    line = PREFIX + json.dumps(fields) + "\n"
    # One write per line under a lock: the heartbeat speaks from its own thread.
    with _SAYING:
        sys.stdout.write(line)
        sys.stdout.flush()


def where(frame):
    """The innermost place the main thread is at, past torch's own module
    plumbing: file name, function and line."""
    first = None
    while frame is not None:
        name = frame.f_code.co_filename
        place = "%s:%s:%d" % (os.path.basename(name), frame.f_code.co_name, frame.f_lineno)
        first = first or place
        if os.sep + "torch" + os.sep not in name:
            return place
        frame = frame.f_back
    return first or "unknown"


def start_heartbeat(every=BEAT_SECONDS):
    """Say a `beat` line every `every` seconds while the run works: the step,
    how long it has been in it, and where the main thread is. A step that works
    long without a line of its own then is not taken for a hung one, and the
    log shows whether the place moves (it works) or stays (it waits on one
    call). Returns the event that ends it."""
    main_thread = threading.main_thread()
    done = threading.Event()

    def beat():
        while not done.wait(every):
            frame = sys._current_frames().get(main_thread.ident)
            at = where(frame)
            del frame
            say(phase="beat", step=STEP["name"], seconds=round(time.monotonic() - STEP["since"]), at=at)

    threading.Thread(target=beat, name="lu-mesh3d-heartbeat", daemon=True).start()
    return done


# ── Stand-ins for what LU does not use ──────────────────────────────────


def refusing_module(name, *functions):
    def refuse(*_args, **_kwargs):
        raise RuntimeError(f"{name} is not part of LU's 3D engine")

    module = types.ModuleType(name)
    for function in functions:
        setattr(module, function, refuse)
    return module


def install_stand_ins():
    """Put `rembg`, `gpytoolbox` and `pynanoinstantmeshes` into `sys.modules`
    before SF3D loads."""
    for name, functions in (
        ("rembg", ("remove", "new_session")),
        ("gpytoolbox", ("subdivide", "decimate", "remesh_botsch")),
        ("pynanoinstantmeshes", ("remesh",)),
    ):
        sys.modules[name] = refusing_module(name, *functions)


def import_sf3d(source, dino_config):
    """SF3D from the pinned source, with both encoders built without a download."""
    if source not in sys.path:
        sys.path.insert(0, source)
    install_stand_ins()

    import open_clip
    import sf3d.models.tokenizers.dinov2 as dinov2
    from transformers import Dinov2Config

    def local_dinov2(cls, name, *_args, **_kwargs):
        if name != DINO_REPO:
            raise RuntimeError(f"the run is offline and has no config for {name}")
        return cls(Dinov2Config.from_json_file(dino_config))

    dinov2.Dinov2Model.from_pretrained = classmethod(local_dinov2)

    create = open_clip.create_model_and_transforms

    def clip_without_download(model_name, *args, **kwargs):
        kwargs["pretrained"] = None
        return create(model_name, *args, **kwargs)

    open_clip.create_model_and_transforms = clip_without_download
    unwrap_on_the_cpu()

    from sf3d.system import SF3D
    from sf3d.utils import resize_foreground

    return SF3D, resize_foreground


def unwrap_on_the_cpu():
    """Run the UV unwrapper on the CPU whatever device the mesh is on.

    Its C++ part has no MPS kernel, and on MPS one of its steps (a QR
    decomposition that falls back to the CPU) ended the whole process with a
    Metal assertion on an M5 Pro (13.11.2026), which no `except` can catch.
    On the CPU the same mesh unwraps in about half a second."""
    from uv_unwrapper import Unwrapper

    forward = Unwrapper.forward
    if getattr(forward, "lu_cpu", False):
        return

    def cpu_forward(self, vertex_positions, vertex_normals, triangle_idxs, island_padding):
        device = vertex_positions.device
        uv, indices = forward(self, vertex_positions.cpu(), vertex_normals.cpu(), triangle_idxs.cpu(), island_padding)
        return uv.to(device), indices.to(device)

    cpu_forward.lu_cpu = True
    Unwrapper.forward = cpu_forward


# ── The picture ─────────────────────────────────────────────────────────


def prepare_image(path, foreground_ratio, resize_foreground):
    """The picture as SF3D takes it: RGBA with the object cropped and padded.

    A picture with transparent pixels (the cutout) is cropped to the object
    and padded to `foreground_ratio`, as `run.py` does after rembg. A picture
    without transparency is taken whole, as an object that fills the frame.
    """
    import numpy as np
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    alpha = np.asarray(image)[..., 3]
    if not (alpha > 127).any():
        raise ValueError("no object")
    if (alpha < 255).any():
        image = resize_foreground(image, foreground_ratio)
    return image


# ── The run ─────────────────────────────────────────────────────────────


def pick_device(asked):
    import torch

    if asked == "cpu":
        return "cpu"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def texture_for(asked):
    t = int(asked)
    return t if t in TEXTURES else 1024


def watch_phases(model):
    """Tell the app when the shape is through and the painting begins."""
    shape = model.triplane_to_meshes

    def triplane_to_meshes(*args, **kwargs):
        say(phase="shape", fraction=0.3)
        meshes = shape(*args, **kwargs)
        say(phase="shape", fraction=1.0)
        say(phase="paint")
        return meshes

    model.triplane_to_meshes = triplane_to_meshes


def make(model, image, texture):
    import torch

    with torch.no_grad():
        mesh, _glob = model.run_image(image, bake_resolution=texture, remesh="none", vertex_count=-1)
    return mesh


def run(job):
    started = time.time()
    say(phase="load")
    SF3D, resize_foreground = import_sf3d(job["source"], job["dino_config"])
    model = SF3D.from_pretrained(job["weights_dir"], config_name="config.yaml", weight_name="model.safetensors")
    device = pick_device(job.get("device", "auto"))
    if device == "cpu":
        # SF3D asks for the device itself in a few places (`get_device`).
        os.environ["SF3D_USE_CPU"] = "1"
    model.to(device)
    model.eval()
    watch_phases(model)
    say(phase="note", note=f"device {device}", device=device)

    try:
        image = prepare_image(job["image"], float(job["foreground_ratio"]), resize_foreground)
    except (ValueError, AssertionError):
        say(phase="error", error="no object", code="no_object")
        sys.exit(6)

    texture = texture_for(job["texture"])
    say(phase="shape", fraction=0.0)
    try:
        mesh = make(model, image, texture)
    except RuntimeError as e:
        if device == "cpu":
            raise
        # An operation MPS cannot run even with the fallback: once more on the
        # CPU, which is slower and always there.
        say(phase="note", note="the graphics chip could not run the model, using the CPU: " + str(e)[:200], device="cpu")
        device = "cpu"
        os.environ["SF3D_USE_CPU"] = "1"
        model.to(device)
        mesh = make(model, image, texture)

    if len(getattr(mesh, "faces", [])) == 0:
        say(phase="error", error="no object", code="no_object")
        sys.exit(6)

    say(phase="save")
    part = os.path.join(job["work"], "model.glb")
    mesh.export(part, file_type="glb", include_normals=True)
    os.makedirs(os.path.dirname(job["output"]), exist_ok=True)
    shutil.move(part, job["output"])
    say(
        phase="done",
        output=job["output"],
        triangles=int(len(mesh.faces)),
        vertices=int(len(mesh.vertices)),
        device=device,
        texture=texture,
        seconds=round(time.time() - started, 1),
    )


# ── The self test ───────────────────────────────────────────────────────


def bake_sphere(device):
    """Unwrap and rasterise a small sphere on `device`. Returns the share of
    texels the bake covered, the number of triangles and the mesh."""
    import torch
    import trimesh
    from texture_baker import TextureBaker
    from uv_unwrapper import Unwrapper

    sphere = trimesh.creation.icosphere(subdivisions=3, radius=0.5)
    v = torch.tensor(sphere.vertices, dtype=torch.float32)
    f = torch.tensor(sphere.faces, dtype=torch.int64)
    n = torch.tensor(sphere.vertex_normals, dtype=torch.float32)
    uv, indices = Unwrapper()(v, n, f, 0.02)
    uv_flat = uv[indices].reshape(-1, 2)
    faces = torch.arange(uv_flat.shape[0], dtype=torch.int64).reshape(-1, 3)
    assert float(uv_flat.min()) >= -1e-4 and float(uv_flat.max()) <= 1 + 1e-4, "UVs outside the atlas"
    baker = TextureBaker()
    rast = baker.rasterize(uv_flat.to(device), faces.to(device), 128)
    covered = float(baker.get_mask(rast).float().mean().cpu())
    assert covered > 0.2, f"the bake covered {covered:.2f} of the texture"
    return covered, int(faces.shape[0]), v[f].reshape(-1, 3), faces, uv_flat


def selftest(out):
    import numpy as np
    import torch
    import trimesh
    from PIL import Image

    devices = ["cpu"] + (["mps"] if torch.backends.mps.is_available() else [])
    told = {}
    for device in devices:
        covered, triangles, verts, faces, uvs = bake_sphere(device)
        told[device] = round(covered, 3)
    texture = Image.fromarray((np.indices((64, 64)).sum(axis=0) % 2 * 255).astype(np.uint8)).convert("RGB")
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=texture, roughnessFactor=0.8, metallicFactor=0.0)
    mesh = trimesh.Trimesh(
        vertices=verts.numpy(),
        faces=faces.numpy(),
        visual=trimesh.visual.texture.TextureVisuals(uv=uvs.numpy(), material=material),
        process=False,
    )
    work = os.path.dirname(os.path.abspath(out))
    part = os.path.join(work, "selftest-part.glb")
    mesh.export(part, file_type="glb")
    shutil.move(part, out)
    with open(out, "rb") as f:
        assert f.read(4) == b"glTF", "not a GLB"
    say(phase="selftest", triangles=triangles, covered=told)


def main(argv):
    if SELFTEST_FLAG in argv:
        out = argv[argv.index(SELFTEST_FLAG) + 1]
        selftest(out)
        if "--source" in argv:
            import_sf3d(argv[argv.index("--source") + 1], "unused")
            say(phase="selftest", imported="sf3d.system")
        return
    with open(argv[argv.index(JOB_FLAG) + 1], encoding="utf-8") as f:
        job = json.load(f)
    start_heartbeat(float(job.get("heartbeat_seconds", BEAT_SECONDS)))
    try:
        run(job)
    except SystemExit:
        raise
    except BaseException as e:
        traceback.print_exc()
        say(phase="error", error=(type(e).__name__ + ": " + str(e))[-600:])
        sys.exit(5)


if __name__ == "__main__":
    main(sys.argv[1:])
