"""Tests of LU's Stable Fast 3D runner without the model.

Run with the engine's venv (it has torch, trimesh, Pillow and LU's two wheels):

    <data_dir>/mesh3d-sf3d/venv/bin/python -I -m unittest discover -s src-tauri/resources/mesh3d -p 'test_run_sf3d.py'

`-I` keeps the folder of the test out of the import path, so the runner is
loaded by its file path below and nothing else from this folder is.
"""

import importlib.util
import json
import os
import struct
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("run_sf3d", os.path.join(HERE, "run_sf3d.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def read_glb_json(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, _version, length = struct.unpack_from("<4sII", data, 0)
    chunk_len, chunk_type = struct.unpack_from("<I4s", data, 12)
    assert magic == b"glTF" and length == len(data) and chunk_type == b"JSON"
    return json.loads(data[20:20 + chunk_len])


def crop_like_sf3d(image, ratio):
    """What `sf3d.utils.resize_foreground` is asked for: an RGBA picture in, an
    RGBA picture out. The test only checks that it is called."""
    image.lu_cropped = ratio
    return image


class ThePicture(unittest.TestCase):
    def picture(self, alpha):
        from PIL import Image

        image = Image.new("RGBA", (32, 32), (200, 10, 10, alpha))
        path = os.path.join(tempfile.mkdtemp(), "p.png")
        image.save(path)
        return path

    def test_a_cutout_is_cropped_to_its_object(self):
        from PIL import Image

        image = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        image.paste((200, 10, 10, 255), (8, 8, 24, 24))
        path = os.path.join(tempfile.mkdtemp(), "cut.png")
        image.save(path)
        out = runner.prepare_image(path, 0.85, crop_like_sf3d)
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(getattr(out, "lu_cropped", None), 0.85)

    def test_an_opaque_photo_is_taken_whole(self):
        out = runner.prepare_image(self.picture(255), 0.85, crop_like_sf3d)
        self.assertEqual(out.mode, "RGBA")
        self.assertFalse(hasattr(out, "lu_cropped"))

    def test_a_picture_with_nothing_in_it_has_no_object(self):
        with self.assertRaises(ValueError):
            runner.prepare_image(self.picture(0), 0.85, crop_like_sf3d)


class TheJob(unittest.TestCase):
    def test_only_the_three_texture_sides(self):
        self.assertEqual([runner.texture_for(t) for t in (512, 1024, 2048, 4096, 7)], [512, 1024, 2048, 1024, 1024])

    def test_the_stand_ins_refuse_and_say_why(self):
        runner.install_stand_ins()
        import gpytoolbox
        import pynanoinstantmeshes
        import rembg

        for call in (lambda: rembg.remove(None), lambda: gpytoolbox.remesh_botsch(), lambda: pynanoinstantmeshes.remesh()):
            with self.assertRaises(RuntimeError) as told:
                call()
            self.assertIn("not part of LU", str(told.exception))


class TheNativeParts(unittest.TestCase):
    def test_the_wheels_unwrap_and_bake_and_a_textured_glb_comes_out(self):
        out = os.path.join(tempfile.mkdtemp(), "self.glb")
        runner.selftest(out)
        gltf = read_glb_json(out)
        self.assertEqual(len(gltf["meshes"]), 1)
        self.assertTrue(gltf.get("images"), "the texture is in the file")
        self.assertIn("TEXCOORD_0", gltf["meshes"][0]["primitives"][0]["attributes"])

    def test_the_unwrapper_runs_on_the_cpu_for_a_mesh_on_mps(self):
        import torch

        runner.unwrap_on_the_cpu()
        runner.unwrap_on_the_cpu()  # twice changes nothing
        from uv_unwrapper import Unwrapper

        self.assertTrue(getattr(Unwrapper.forward, "lu_cpu", False))
        if not torch.backends.mps.is_available():
            self.skipTest("no MPS on this machine")
        import trimesh

        sphere = trimesh.creation.icosphere(subdivisions=2, radius=0.5)
        v = torch.tensor(sphere.vertices, dtype=torch.float32, device="mps")
        n = torch.tensor(sphere.vertex_normals, dtype=torch.float32, device="mps")
        f = torch.tensor(sphere.faces, dtype=torch.int64, device="mps")
        uv, indices = Unwrapper()(v, n, f, 0.02)
        self.assertEqual(uv.device.type, "mps")
        self.assertEqual(indices.shape[0], f.shape[0])


if __name__ == "__main__":
    unittest.main()
