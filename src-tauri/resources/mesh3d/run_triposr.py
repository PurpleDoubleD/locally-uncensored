"""LU's own runner of TripoSR: one picture in, one GLB with vertex colours out.

The app starts this once per model (`src-tauri/src/commands/mesh3d.rs`) with
`python -I -u run_triposr.py --lu-mesh3d-job <job.json>` and reads what it says
on stdout: lines that begin with `LU-MESH3D `, each a JSON object with a
`phase` (load, shape, paint, save, done, error, note, beat) and, for shape, a
`fraction` from 0 to 1.

What it changes against `run.py` of TripoSR, and why (read at the pinned
commit, see mesh3d.rs):

1. `torchmcubes` comes as a `git+https` requirement and has to be compiled,
   which a customer's Mac cannot do. `tsr/models/isosurface.py` imports it at
   module level, so a stand-in module is put in its place that runs
   `skimage.measure.marching_cubes`. The surface itself is extracted below
   with scikit-image directly, so the progress can be told.
2. `rembg` is imported at module level by `tsr/utils.py` and downloads a model
   of its own on first use. LU cuts the object out with Apple's Vision before
   this runs, so a stand-in is put in its place that refuses to work.
3. The DINO image encoder reads its `config.json` from the hub at start
   (`tsr/models/tokenizers/image.py`). The app downloads that file at a fixed
   revision during the install; the hub call is pointed at that file here,
   and the whole run is offline (`HF_HUB_OFFLINE=1`).
4. No texture baking (`moderngl`, `xatlas`): colours per vertex, written as
   GLB by trimesh.

The weights are read with `torch.load(..., weights_only=True)`: a checkpoint
that holds anything but tensors is refused instead of run.

`--lu-mesh3d-selftest <out.glb>` runs the same surface, colour and GLB code on
a small sphere without the model, and imports TripoSR with the stand-ins. The
install uses it to prove the venv.
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

DINO_REPO = "facebook/dino-vitb16"

# The points of the grid that go to the device in one go. The renderer splits
# each of these again into pieces of `chunk` points.
POINTS_PER_STEP = 1 << 18


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


# ── Stand-ins for what a Mac cannot install ─────────────────────────────


def marching_cubes_numpy(volume, level=0.0):
    """Vertices in the index order of `volume` (axis 0, 1, 2) and triangles.

    `volume` is positive inside the object. The triangles face outwards: the
    signed volume of the mesh is made positive, whatever winding scikit-image
    chose, since the axis order of TripoSR flips handedness once.
    """
    import numpy as np
    from skimage import measure

    vol = np.ascontiguousarray(volume, dtype=np.float32)
    if not (vol.max() > level and vol.min() < level):
        return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.int64)
    verts, faces, _normals, _values = measure.marching_cubes(vol, level=level)
    verts = verts.astype(np.float32)
    faces = faces.astype(np.int64)
    if signed_volume(verts, faces) < 0:
        faces = faces[:, ::-1].copy()
    return verts, faces


def signed_volume(verts, faces):
    import numpy as np

    if len(faces) == 0:
        return 0.0
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def install_stand_ins():
    """Put `torchmcubes` and `rembg` into `sys.modules` before TripoSR loads."""

    def torchmcubes_marching_cubes(volume, threshold):
        # The order torchmcubes answers in: x along the last axis. TripoSR
        # turns it back with `v_pos[..., [2, 1, 0]]`.
        import torch

        verts, faces = marching_cubes_numpy(volume.detach().cpu().numpy(), threshold)
        return torch.from_numpy(verts[:, ::-1].copy()), torch.from_numpy(faces)

    mc = types.ModuleType("torchmcubes")
    mc.marching_cubes = torchmcubes_marching_cubes
    sys.modules["torchmcubes"] = mc

    def no_rembg(*_args, **_kwargs):
        raise RuntimeError("LU cuts the object out with Vision before the run; rembg is not used")

    rembg = types.ModuleType("rembg")
    rembg.remove = no_rembg
    rembg.new_session = no_rembg
    sys.modules["rembg"] = rembg


def import_tsr(source, dino_config):
    """TripoSR from the pinned source, with the encoder config read from disk."""
    if source not in sys.path:
        sys.path.insert(0, source)
    install_stand_ins()
    import tsr.models.tokenizers.image as tokenizer

    def local_config(repo_id, filename, **_kwargs):
        if repo_id == DINO_REPO and filename == "config.json":
            return dino_config
        raise RuntimeError(f"the run is offline and has no {repo_id}/{filename}")

    tokenizer.hf_hub_download = local_config
    from tsr.system import TSR
    from tsr.utils import resize_foreground, scale_tensor

    return TSR, resize_foreground, scale_tensor


# ── The picture ─────────────────────────────────────────────────────────


def prepare_image(path, foreground_ratio, resize_foreground):
    """The picture as TripoSR takes it: RGB, object centred on grey.

    A picture with transparent pixels (the cutout) is cropped to the object,
    padded to `foreground_ratio` and laid on 50 percent grey, as `run.py`
    does after rembg. A picture without transparency is taken as it is.
    """
    import numpy as np
    from PIL import Image, ImageOps

    image = ImageOps.exif_transpose(Image.open(path))
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        alpha = np.asarray(rgba)[..., 3]
        if not (alpha > 0).any():
            raise ValueError("no object")
        if (alpha < 255).any():
            rgba = resize_foreground(rgba, foreground_ratio)
            pixels = np.asarray(rgba).astype(np.float32) / 255.0
            rgb = pixels[:, :, :3] * pixels[:, :, 3:4] + (1 - pixels[:, :, 3:4]) * 0.5
            return Image.fromarray((rgb * 255.0).astype(np.uint8))
    return image.convert("RGB")


# ── The surface and the colours ─────────────────────────────────────────


def to_gltf_orientation(mesh):
    """Upright in glTF's Y-up frame, with the side the photo shows towards +Z,
    where a glTF viewer's camera stands. TripoSR's own demo turns it upright
    the same way (`to_gradio_3d_orientation` in `tsr/utils.py`) but leaves
    the photographed side at -Z; seen on the first real run (13.11.2026), so
    the turn about Y here is the other way round."""
    import numpy as np
    import trimesh

    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [0, 1, 0]))
    return mesh


def write_glb(verts, faces, colors, work, output):
    """Write the mesh as GLB in the job folder, then move it into place."""
    import numpy as np
    import trimesh

    rgba = np.concatenate(
        [np.clip(colors, 0.0, 1.0) * 255.0, np.full((len(colors), 1), 255.0)], axis=1
    ).astype(np.uint8)
    mesh = trimesh.Trimesh(vertices=verts, faces=faces, vertex_colors=rgba, process=False)
    mesh = to_gltf_orientation(mesh)
    part = os.path.join(work, "model.glb")
    mesh.export(part, file_type="glb")
    os.makedirs(os.path.dirname(output), exist_ok=True)
    shutil.move(part, output)
    return len(mesh.faces), len(mesh.vertices)


def pick_device(asked):
    import torch

    if asked == "cpu":
        return "cpu"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def run(job):
    import numpy as np
    import torch
    from omegaconf import OmegaConf

    started = time.time()
    say(phase="load")
    TSR, resize_foreground, scale_tensor = import_tsr(job["source"], job["dino_config"])
    cfg = OmegaConf.load(job["config"])
    OmegaConf.resolve(cfg)
    model = TSR(cfg)
    state = torch.load(job["weights"], map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    del state
    model.renderer.set_chunk_size(int(job["chunk"]))
    device = pick_device(job.get("device", "auto"))
    model.to(device)
    model.eval()
    say(phase="note", note=f"device {device}", device=device)

    try:
        image = prepare_image(job["image"], float(job["foreground_ratio"]), resize_foreground)
    except ValueError:
        say(phase="error", error="no object", code="no_object")
        sys.exit(6)

    say(phase="shape", fraction=0.0)
    with torch.no_grad():
        try:
            scene_codes = model([image], device=device)
        except RuntimeError as e:
            if device == "cpu":
                raise
            # An operation MPS cannot run even with the fallback: once more on
            # the CPU, which is slower and always there.
            say(phase="note", note="the graphics chip could not run the model, using the CPU: " + str(e)[:200], device="cpu")
            device = "cpu"
            model.to(device)
            scene_codes = model([image], device=device)
        scene_code = scene_codes[0]
        say(phase="shape", fraction=0.1)

        resolution = int(job["resolution"])
        radius = float(model.renderer.cfg.radius)
        axis = torch.linspace(0.0, 1.0, resolution)
        grid = torch.stack(torch.meshgrid(axis, axis, axis, indexing="ij"), dim=-1).reshape(-1, 3)
        points = scale_tensor(grid, (0.0, 1.0), (-radius, radius))
        del grid
        density = torch.empty(points.shape[0], dtype=torch.float32)
        total = points.shape[0]
        told = 0.1
        for start in range(0, total, POINTS_PER_STEP):
            end = min(total, start + POINTS_PER_STEP)
            out = model.renderer.query_triplane(model.decoder, points[start:end].to(device), scene_code)
            density[start:end] = out["density_act"].reshape(-1).float().cpu()
            fraction = 0.1 + 0.8 * end / total
            if fraction - told >= 0.02 or end == total:
                told = fraction
                say(phase="shape", fraction=round(fraction, 3))
        del points

        level = (density - float(job["threshold"])).reshape(resolution, resolution, resolution).numpy()
        del density
        verts, faces = marching_cubes_numpy(level, 0.0)
        del level
        if len(faces) == 0:
            say(phase="error", error="no object", code="no_object")
            sys.exit(6)
        verts = verts / (resolution - 1.0) * (2.0 * radius) - radius
        say(phase="shape", fraction=1.0)

        say(phase="paint")
        colors = []
        positions = torch.from_numpy(verts.astype(np.float32))
        for start in range(0, positions.shape[0], POINTS_PER_STEP):
            out = model.renderer.query_triplane(model.decoder, positions[start:start + POINTS_PER_STEP].to(device), scene_code)
            colors.append(out["color"].float().cpu().numpy())
        colors = np.concatenate(colors, axis=0)

    say(phase="save")
    triangles, vertices = write_glb(verts, faces, colors, job["work"], job["output"])
    say(
        phase="done",
        output=job["output"],
        triangles=int(triangles),
        vertices=int(vertices),
        device=device,
        seconds=round(time.time() - started, 1),
    )


def selftest(out):
    """The surface, colour and GLB path on a sphere, without the model."""
    import numpy as np

    n = 32
    axis = np.linspace(-1.0, 1.0, n, dtype=np.float32)
    x, y, z = np.meshgrid(axis, axis, axis, indexing="ij")
    level = 0.6 - np.sqrt(x * x + y * y + z * z)
    verts, faces = marching_cubes_numpy(level, 0.0)
    assert len(faces) > 100, "the sphere has no surface"
    assert signed_volume(verts, faces) > 0, "the triangles face inwards"
    verts = verts / (n - 1.0) * 2.0 - 1.0
    colors = (verts + 1.0) / 2.0
    work = os.path.dirname(os.path.abspath(out))
    triangles, vertices = write_glb(verts, faces, colors, work, out)
    with open(out, "rb") as f:
        assert f.read(4) == b"glTF", "not a GLB"
    say(phase="selftest", triangles=int(triangles), vertices=int(vertices))


def main(argv):
    if SELFTEST_FLAG in argv:
        out = argv[argv.index(SELFTEST_FLAG) + 1]
        selftest(out)
        if "--source" in argv:
            import_tsr(argv[argv.index("--source") + 1], "unused")
            say(phase="selftest", imported="tsr.system")
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
