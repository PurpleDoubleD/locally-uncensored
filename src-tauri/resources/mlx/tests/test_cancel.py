"""Cancel in the image sidecar, without a model and without its packages.

Run with any Python 3: `python3 -m unittest discover -s src-tauri/resources/mlx/tests`.
fastapi, pydantic, uvicorn and torch are replaced by stand-ins, and the
pipeline is a loop that calls back after each step the way diffusers does.
"""

import importlib.util
import sys
import threading
import types
import unittest
from pathlib import Path


class _HTTPException(Exception):
    def __init__(self, status_code, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _App:
    def __init__(self, *args, **kwargs):
        self.routes = {}

    def _route(self, method, path):
        def keep(fn):
            self.routes[(method, path)] = fn
            return fn

        return keep

    def get(self, path):
        return self._route("GET", path)

    def post(self, path):
        return self._route("POST", path)


class _BaseModel:
    def __init__(self, **fields):
        for klass in reversed(type(self).__mro__):
            for name in getattr(klass, "__annotations__", {}):
                if hasattr(klass, name):
                    setattr(self, name, getattr(klass, name))
        for name, value in fields.items():
            setattr(self, name, value)


class _Image:
    def save(self, buf, format):
        buf.write(b"\x89PNG")


def _stand_ins():
    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = _App
    fastapi.HTTPException = _HTTPException
    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = _BaseModel
    uvicorn = types.ModuleType("uvicorn")
    torch = types.ModuleType("torch")

    class _Generator:
        def __init__(self, device=None):
            pass

        def manual_seed(self, seed):
            return self

    torch.Generator = _Generator
    return {"fastapi": fastapi, "pydantic": pydantic, "uvicorn": uvicorn, "torch": torch}


def _load_server():
    sys.modules.update(_stand_ins())
    path = Path(__file__).resolve().parents[1] / "server.py"
    spec = importlib.util.spec_from_file_location("lu_mlx_server_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Pipe:
    """A pipeline as diffusers runs one: a step, then the callback."""

    def __init__(self, on_step=None):
        self.steps_run = 0
        self.on_step = on_step

    def __call__(self, prompt, num_inference_steps, width, height, generator, guidance_scale=0.0, negative_prompt=None, callback_on_step_end=None):
        for step in range(num_inference_steps):
            self.steps_run += 1
            if self.on_step:
                self.on_step(step)
            if callback_on_step_end is not None:
                callback_on_step_end(self, step, 0, {})
        return types.SimpleNamespace(images=[_Image()])


class OldPipe(Pipe):
    """One without the hook: it cannot be left between two steps."""

    def __call__(self, prompt, num_inference_steps, width, height, generator, guidance_scale=0.0, negative_prompt=None):
        return super().__call__(prompt, num_inference_steps, width, height, generator)


class CancelTest(unittest.TestCase):
    def setUp(self):
        self.server = _load_server()

    def serve(self, pipe):
        self.server._ensure_pipe = lambda *args, **kwargs: pipe

    def test_an_image_that_is_not_cancelled_runs_all_its_steps(self):
        pipe = Pipe()
        self.serve(pipe)
        out = self.server.generate(self.server.GenerateRequest(prompt="a cat", steps=4))
        self.assertEqual(pipe.steps_run, 4)
        self.assertEqual(out["steps"], 4)
        self.assertTrue(out["image_base64"])

    def test_cancel_ends_the_image_at_the_end_of_the_step_it_is_in(self):
        server = self.server
        answers = []
        pipe = Pipe(on_step=lambda step: answers.append(server.cancel()) if step == 1 else None)
        self.serve(pipe)
        with self.assertRaises(_HTTPException) as raised:
            server.generate(server.GenerateRequest(prompt="a cat", steps=20))
        self.assertEqual((raised.exception.status_code, raised.exception.detail), (409, "cancelled"))
        self.assertEqual(pipe.steps_run, 2, "the image went on after the cancel")
        self.assertEqual(answers, [{"ok": True, "cancelled": True}])
        # The mark went with the image: the next one is not ended by it.
        self.assertFalse(server._cancel.is_set())
        again = Pipe()
        self.serve(again)
        server.generate(server.GenerateRequest(prompt="a cat", steps=3))
        self.assertEqual(again.steps_run, 3)

    def test_a_cancel_with_no_image_under_way_is_not_remembered(self):
        server = self.server
        self.assertEqual(server.cancel(), {"ok": True, "cancelled": False})
        pipe = Pipe()
        self.serve(pipe)
        server.generate(server.GenerateRequest(prompt="a cat", steps=3))
        self.assertEqual(pipe.steps_run, 3)

    def test_cancel_while_the_model_loads_runs_no_step(self):
        server = self.server
        pipe = Pipe()

        def load(*args, **kwargs):
            server.cancel()
            return pipe

        server._ensure_pipe = load
        with self.assertRaises(_HTTPException) as raised:
            server.generate(server.GenerateRequest(prompt="a cat", steps=5))
        self.assertEqual(raised.exception.detail, "cancelled")
        self.assertEqual(pipe.steps_run, 0)

    def test_a_pipeline_without_the_hook_is_not_handed_one(self):
        server = self.server
        pipe = OldPipe(on_step=lambda step: server.cancel())
        self.serve(pipe)
        out = server.generate(server.GenerateRequest(prompt="a cat", steps=3))
        self.assertEqual(pipe.steps_run, 3, "it runs to its end, and the app drops the result")
        self.assertEqual(out["steps"], 3)
        self.assertFalse(server._cancel.is_set())

    def test_cancel_is_heard_while_generate_holds_the_pipeline(self):
        # The real server answers /cancel on another thread than /generate.
        server = self.server
        at_step, go_on = threading.Event(), threading.Event()

        def step(n):
            at_step.set()
            go_on.wait(5)

        pipe = Pipe(on_step=step)
        self.serve(pipe)
        failed = []

        def run():
            try:
                server.generate(server.GenerateRequest(prompt="a cat", steps=10))
            except _HTTPException as exc:
                failed.append(exc.detail)

        worker = threading.Thread(target=run)
        worker.start()
        self.assertTrue(at_step.wait(5))
        self.assertEqual(server.cancel(), {"ok": True, "cancelled": True})
        go_on.set()
        worker.join(5)
        self.assertEqual(failed, ["cancelled"])
        self.assertEqual(pipe.steps_run, 1)


if __name__ == "__main__":
    unittest.main()


class ProgressTest(unittest.TestCase):
    """C71: the app ends a run when nothing moves, so the sidecar says how far it is."""

    def setUp(self):
        self.server = _load_server()

    def test_idle_before_and_after_an_image(self):
        server = self.server
        self.assertEqual(server.progress()["phase"], "idle")
        server._ensure_pipe = lambda *args, **kwargs: Pipe()
        server.generate(server.GenerateRequest(prompt="a cat", steps=3))
        snap = server.progress()
        self.assertEqual((snap["phase"], snap["step"], snap["steps"]), ("idle", 0, 0))

    def test_each_step_is_counted_while_the_image_runs(self):
        server = self.server
        seen = []

        def look(step):
            seen.append(server.progress())

        loads = []

        def load(*args, **kwargs):
            loads.append(server.progress()["phase"])
            return Pipe(on_step=look)

        server._ensure_pipe = load
        server.generate(server.GenerateRequest(prompt="a cat", steps=4))
        self.assertEqual(loads, ["loading"])
        # on_step runs before the callback of its step: step n sees n done.
        self.assertEqual([s["step"] for s in seen], [0, 1, 2, 3])
        self.assertTrue(all(s["phase"] == "steps" and s["steps"] == 4 and s["step_hook"] for s in seen))
        self.assertTrue(all(s["quiet_seconds"] >= 0 for s in seen))

    def test_a_pipeline_without_the_hook_says_it_counts_no_steps(self):
        server = self.server
        seen = []
        server._ensure_pipe = lambda *args, **kwargs: OldPipe(on_step=lambda step: seen.append(server.progress()))
        server.generate(server.GenerateRequest(prompt="a cat", steps=2))
        self.assertEqual([(s["phase"], s["step"], s["step_hook"]) for s in seen], [("steps", 0, False)] * 2)
