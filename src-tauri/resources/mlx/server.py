"""MLX-Stable-Diffusion FastAPI sidecar.

Run by `commands::mlx::mlx_start` once the install slot has filled the
venv. Hosts a single POST /generate endpoint that the bridge proxies for
the web UI.

Model-agnostic: every request carries the full load config (repo, dtype,
fp16 variant, cfg kwarg name) resolved by the bridge from its image
catalog (commands/mlx.rs IMAGE_CATALOG). The sidecar keeps exactly one
pipeline in memory and swaps it out when a request names a different
repo — unified memory can't hold two big pipelines at once.
"""

import base64
import gc
import inspect
import io
import os
import socket
import sys
import threading
import time
from typing import Optional



def _fatal(message: str, code: int):
    """Say in one line why the server cannot run, then leave.

    The app reads this line from the log when the process ends and shows it,
    instead of waiting a minute on a port nobody listens on. Without it the
    reason was a traceback only the log file ever saw.
    """
    print(f"LU_MLX_FATAL: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


try:
    import uvicorn
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel
except ImportError as exc:
    # A venv whose pip run never finished. Exit code 4 and the words
    # "missing package" are what the app keys on to offer the setup again.
    _fatal(f"missing package: {exc.name or exc}", 4)


# Lazy: importing torch + diffusers takes ~3 s on a cold start. We defer
# it until the first request so /health stays sub-millisecond, which the
# bridge uses for the "is the MLX server up?" probe in mlx_status.
_pipe = None
_pipe_repo = None
# One lock guards every pipeline mutation (load / release / generate) so the
# idle-unload thread can't free the model out from under an in-flight request,
# and two concurrent requests can't both trigger a load.
_pipe_lock = threading.RLock()
_last_activity = time.monotonic()

# Cancel. A request cannot be taken back, so the app asks over /cancel and
# the generation looks at this mark after every step. It is set only while
# an image is under way and cleared when the last one has left, so a cancel
# that arrives late never ends the image after it.
_cancel = threading.Event()
_active = 0
_active_lock = threading.Lock()


class _Cancelled(Exception):
    """Raised from the step callback to leave the pipeline between two steps."""


def _stop_if_cancelled(pipe, step, timestep, callback_kwargs):
    # diffusers calls this at the end of each denoising step and takes back
    # the tensors it handed over. Raising is the one way out that every
    # pipeline with this hook shares: `pipe._interrupt` exists on some only,
    # and those still decode what they have.
    if _cancel.is_set():
        raise _Cancelled()
    return callback_kwargs


# How far the image is (C71). The app used to give a whole request 900 s,
# model load included, and Chroma1-HD at 40 steps and 1024 on an M1 Max needs
# longer than that: the render was cut off and reported as "mlx unreachable".
# The app now asks here and ends a run only when nothing has moved for its
# limit. `changed` is when the phase or the step last moved.
_progress_lock = threading.Lock()
_progress = {"phase": "idle", "step": 0, "steps": 0, "step_hook": False, "changed": time.monotonic()}


def _note_progress(phase=None, step=None, steps=None, step_hook=None):
    with _progress_lock:
        if phase is not None:
            _progress["phase"] = phase
        if step is not None:
            _progress["step"] = step
        if steps is not None:
            _progress["steps"] = steps
        if step_hook is not None:
            _progress["step_hook"] = step_hook
        _progress["changed"] = time.monotonic()


def _on_step_end(pipe, step, timestep, callback_kwargs):
    # `step` counts from 0 and the call comes at the end of that step.
    _note_progress(step=step + 1)
    return _stop_if_cancelled(pipe, step, timestep, callback_kwargs)


def _takes_step_callback(pipe) -> bool:
    """Whether this pipeline calls back after a step. One that does not runs
    to its end, and the app drops what it returns."""
    try:
        return "callback_on_step_end" in inspect.signature(pipe.__call__).parameters
    except (TypeError, ValueError):
        return False


# A resident image pipeline pins multiple GB of unified memory. On a local
# machine that must not linger forever after the user walks away, so a
# background thread releases it once idle. 0 disables (set via env for tests).
IDLE_UNLOAD_SECONDS = int(os.environ.get("LU_MLX_IDLE_UNLOAD_SECONDS", "600"))


def _release_pipe():
    global _pipe, _pipe_repo
    with _pipe_lock:
        if _pipe is None:
            return
        import torch

        _pipe = None
        _pipe_repo = None
        gc.collect()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()


def _idle_unload_loop():
    """Free the resident pipeline after IDLE_UNLOAD_SECONDS of no requests.
    Keeps the server itself up (fast to reload), just drops the weights."""
    while True:
        time.sleep(30)
        if IDLE_UNLOAD_SECONDS <= 0 or _pipe is None:
            continue
        if time.monotonic() - _last_activity >= IDLE_UNLOAD_SECONDS:
            _release_pipe()


def _ensure_pipe(
    repo: str,
    dtype: str,
    variant: Optional[str],
    disable_safety_checker: bool,
    local_files_only: bool = False,
):
    global _pipe, _pipe_repo
    # Caller already holds _pipe_lock.
    if _pipe is not None and _pipe_repo == repo:
        return _pipe
    _release_pipe()

    import torch
    from diffusers import AutoPipelineForText2Image

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    torch_dtype = torch.float32
    if device == "mps":
        torch_dtype = torch.bfloat16 if dtype == "bfloat16" else torch.float16

    kwargs = {"torch_dtype": torch_dtype}
    # A model the app already installed must load from disk alone. Without
    # this, diffusers re-validates all ~18 files against the hub on every
    # load: measured at 26 s per already-present file when the hub throttles
    # anonymous traffic, and an outright failure with no network. "Local"
    # image generation silently depended on being online.
    if local_files_only:
        kwargs["local_files_only"] = True
    if variant:
        kwargs["variant"] = variant
    if disable_safety_checker:
        # SD1.5 repos bundle a safety_checker component; skipping it here
        # also means the install never had to download its weights.
        kwargs["safety_checker"] = None
        kwargs["requires_safety_checker"] = False

    # No attention/VAE slicing here: on torch 2.12 + MPS it corrupts the
    # forward pass into all-NaN latents (verified live — plain runs are
    # clean, sliced runs decode to black frames).
    _pipe = AutoPipelineForText2Image.from_pretrained(repo, **kwargs).to(device)
    _pipe_repo = repo
    return _pipe


app = FastAPI(title="LU MLX server")


class GenerateRequest(BaseModel):
    prompt: str
    steps: int = 4
    seed: Optional[int] = None
    width: int = 512
    height: int = 512
    negative_prompt: Optional[str] = None
    # Model config resolved by the bridge catalog. Defaults keep the
    # historical sd-turbo behaviour for old callers.
    model_repo: str = "stabilityai/sd-turbo"
    dtype: str = "float16"
    variant: Optional[str] = "fp16"
    guidance: float = 0.0
    cfg_param: str = "guidance_scale"
    disable_safety_checker: bool = False
    # Set by the bridge when it has verified the model is fully on disk.
    local_files_only: bool = False


@app.get("/health")
def health():
    idle = None if _pipe is None else round(time.monotonic() - _last_activity, 1)
    return {
        "ok": True,
        "model_loaded": _pipe is not None,
        "model_repo": _pipe_repo,
        "idle_seconds": idle,
        "idle_unload_seconds": IDLE_UNLOAD_SECONDS,
    }


@app.get("/progress")
def progress():
    """Where the image under way is: `phase` is idle, waiting, loading, steps
    or saving; `step` of `steps` once the steps run (only a pipeline with the
    step hook counts them, `step_hook`); `quiet_seconds` since anything moved."""
    with _progress_lock:
        snap = dict(_progress)
    snap["quiet_seconds"] = round(time.monotonic() - snap.pop("changed"), 1)
    return snap


@app.post("/unload")
def unload():
    """Free the resident model now, keeping the server up. Idempotent — the
    bridge's `mlx_unload` calls this so the UI can reclaim memory on demand."""
    was_loaded = _pipe is not None
    _release_pipe()
    return {"ok": True, "was_loaded": was_loaded}


@app.post("/cancel")
def cancel():
    """End the image that is being generated, at the end of the step it is
    in. `cancelled` is false when there is none: nothing is remembered then."""
    with _active_lock:
        running = _active > 0
        if running:
            _cancel.set()
    return {"ok": True, "cancelled": running}


def _cancelled_answer():
    # 409 and this word are what the app reads as "ended because it was asked to".
    return HTTPException(status_code=409, detail="cancelled")


@app.post("/generate")
def generate(req: GenerateRequest):
    global _active
    with _active_lock:
        _active += 1
    _note_progress(phase="waiting", step=0, steps=req.steps, step_hook=False)
    try:
        return _generate(req)
    finally:
        with _active_lock:
            _active -= 1
            if _active == 0:
                _cancel.clear()
                _note_progress(phase="idle", step=0, steps=0, step_hook=False)


def _generate(req: GenerateRequest):
    global _last_activity
    import torch

    with _pipe_lock:
        # Cancelled while it waited for the image before it.
        if _cancel.is_set():
            raise _cancelled_answer()
        _note_progress(phase="loading")
        try:
            pipe = _ensure_pipe(
                req.model_repo,
                req.dtype,
                req.variant,
                req.disable_safety_checker,
                req.local_files_only,
            )
        except Exception as exc:
            # A half-loaded pipeline must not shadow the previous model.
            _release_pipe()
            raise HTTPException(status_code=500, detail=f"pipeline init: {exc}") from exc

        # MPS generators are unstable; seeds work better via a CPU generator.
        generator = None
        if req.seed is not None:
            generator = torch.Generator(device="cpu").manual_seed(req.seed)

        gen_kwargs = {
            "prompt": req.prompt,
            "num_inference_steps": req.steps,
            "width": req.width,
            "height": req.height,
            "generator": generator,
            # Turbo/distilled models want 0.0 here; regular models their CFG.
            # Qwen-Image reads "true_cfg_scale" instead of "guidance_scale".
            req.cfg_param: req.guidance,
        }
        if req.negative_prompt:
            gen_kwargs["negative_prompt"] = req.negative_prompt
        hook = _takes_step_callback(pipe)
        if hook:
            gen_kwargs["callback_on_step_end"] = _on_step_end
        _note_progress(phase="steps", step=0, steps=req.steps, step_hook=hook)

        # Cancelled while the model loaded: no step is run for it.
        if _cancel.is_set():
            raise _cancelled_answer()
        try:
            result = pipe(**gen_kwargs)
        except _Cancelled:
            raise _cancelled_answer() from None
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"generate: {exc}") from exc
        finally:
            # Reset the idle clock AFTER the work, so a slow generation can't be
            # unloaded mid-run and the countdown starts from completion.
            _last_activity = time.monotonic()

    _note_progress(phase="saving")
    img = result.images[0]
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {
        "image_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": req.width,
        "height": req.height,
        "steps": req.steps,
        "model_repo": req.model_repo,
    }


if __name__ == "__main__":
    port = int(os.environ.get("LU_MLX_PORT", "47712"))
    # uvicorn answers an occupied port with a log line and its own
    # sys.exit(1), which no except clause here would see. Asking first turns
    # that into a sentence.
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
    except OSError:
        _fatal(f"port {port} is already in use", 3)
    finally:
        probe.close()
    threading.Thread(target=_idle_unload_loop, daemon=True).start()
    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as exc:  # noqa: BLE001 - the last word before the process ends
        _fatal(f"server stopped: {exc}", 1)
