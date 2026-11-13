"""Tests of LU's TripoSR runner on a small grid, without the model.

Run with the engine's venv (it has numpy, scikit-image, trimesh, Pillow):

    <data_dir>/mesh3d/venv/bin/python -I -m unittest discover -s src-tauri/resources/mesh3d -p 'test_*.py'

`-I` keeps the folder of the test out of the import path, so the runner is
loaded by its file path below and nothing else from this folder is.
"""

import importlib.util
import json
import os
import struct
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("run_triposr", os.path.join(HERE, "run_triposr.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def read_glb_json(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, _version, length = struct.unpack_from("<4sII", data, 0)
    chunk_len, chunk_type = struct.unpack_from("<I4s", data, 12)
    assert magic == b"glTF" and length == len(data) and chunk_type == b"JSON"
    return json.loads(data[20:20 + chunk_len])


class MiniGrid(unittest.TestCase):
    def sphere(self, n=24, r=0.5):
        import numpy as np

        axis = np.linspace(-1.0, 1.0, n, dtype=np.float32)
        x, y, z = np.meshgrid(axis, axis, axis, indexing="ij")
        return r - np.sqrt(x * x + y * y + z * z)

    def test_a_sphere_has_a_closed_surface_that_faces_outwards(self):
        verts, faces = runner.marching_cubes_numpy(self.sphere(), 0.0)
        self.assertGreater(len(faces), 100)
        self.assertGreater(runner.signed_volume(verts, faces), 0)
        # Every vertex is near the radius, in grid units.
        import numpy as np

        centre = (24 - 1) / 2.0
        radius = np.linalg.norm(verts - centre, axis=1) / centre
        self.assertLess(abs(float(radius.mean()) - 0.5), 0.05)

    def test_an_inverted_field_is_still_turned_outwards(self):
        verts, faces = runner.marching_cubes_numpy(-self.sphere(), 0.0)
        # Inside out: the "object" is everything but the ball, its surface
        # still has a winding the runner makes consistent.
        self.assertNotEqual(runner.signed_volume(verts, faces), 0)

    def test_an_empty_field_has_no_surface(self):
        import numpy as np

        verts, faces = runner.marching_cubes_numpy(np.full((8, 8, 8), -1.0), 0.0)
        self.assertEqual((len(verts), len(faces)), (0, 0))

    def test_the_torchmcubes_stand_in_answers_in_its_axis_order(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch is not in this Python")
        runner.install_stand_ins()
        import sys

        mc = sys.modules["torchmcubes"]
        field = self.sphere()
        field[:, :, :4] = -1.0  # break the symmetry along the last axis
        verts, faces = mc.marching_cubes(torch.from_numpy(field), 0.0)
        ours, _ = runner.marching_cubes_numpy(field, 0.0)
        self.assertTrue(torch.allclose(verts[:, [2, 1, 0]], torch.from_numpy(ours)))
        self.assertEqual(faces.dtype, torch.int64)

    def test_rembg_is_never_used(self):
        runner.install_stand_ins()
        import sys

        with self.assertRaises(RuntimeError):
            sys.modules["rembg"].remove(None)

    def test_the_selftest_writes_a_glb_with_vertex_colours(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "sphere.glb")
            runner.selftest(out)
            gltf = read_glb_json(out)
            primitive = gltf["meshes"][0]["primitives"][0]
            self.assertIn("COLOR_0", primitive["attributes"])
            self.assertIn("POSITION", primitive["attributes"])

    def test_a_cutout_is_centred_on_grey_and_a_plain_photo_is_left_alone(self):
        from PIL import Image

        def resize_foreground(image, ratio):
            # The real one comes from TripoSR; this keeps the size.
            return image

        with tempfile.TemporaryDirectory() as tmp:
            cut = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
            for x in range(4, 12):
                for y in range(4, 12):
                    cut.putpixel((x, y), (200, 10, 10, 255))
            path = os.path.join(tmp, "cut.png")
            cut.save(path)
            rgb = runner.prepare_image(path, 0.85, resize_foreground)
            self.assertEqual(rgb.mode, "RGB")
            self.assertEqual(rgb.getpixel((0, 0)), (127, 127, 127))
            self.assertEqual(rgb.getpixel((8, 8)), (200, 10, 10))

            empty = os.path.join(tmp, "empty.png")
            Image.new("RGBA", (8, 8), (0, 0, 0, 0)).save(empty)
            with self.assertRaises(ValueError):
                runner.prepare_image(empty, 0.85, resize_foreground)

            photo = os.path.join(tmp, "photo.png")
            Image.new("RGB", (8, 8), (1, 2, 3)).save(photo)
            self.assertEqual(runner.prepare_image(photo, 0.85, resize_foreground).getpixel((0, 0)), (1, 2, 3))


if __name__ == "__main__":
    unittest.main()
