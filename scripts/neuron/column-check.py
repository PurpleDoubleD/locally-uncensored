"""Checks LU's single-neuron column read (src-tauri/src/commands/neuron/weights.rs)
against llama.cpp's own gguf-py on a real model.

Run with python3 -I and the llama.cpp checkout's gguf-py on the path:
  python3 -I scripts/neuron/column-check.py <llama.cpp>/gguf-py model.gguf LAYER NEURON lu-column.txt
The last file is what `LU_COLUMN_CHECK=model|layer|neuron|file cargo test a_real_column -- --ignored` wrote.
"""
import sys

import types

sys.path.insert(0, sys.argv[1])
# gguf-py's metadata module imports yaml for model cards; nothing here reads one.
sys.modules.setdefault("yaml", types.ModuleType("yaml"))
import numpy as np  # noqa: E402
from gguf import GGUFReader  # noqa: E402
from gguf.quants import dequantize  # noqa: E402

model, layer, neuron, lu_file = sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
name = f"blk.{layer}.ffn_down.weight" if layer.isdigit() else layer
r = GGUFReader(model)
t = next(t for t in r.tensors if t.name == name)
w = dequantize(t.data, t.tensor_type)  # shape [n_embd, n_ff]
ref = w[:, neuron].astype(np.float64)
lines = open(lu_file).read().split()
n_ff, lu = int(lines[0]), np.array([float(x) for x in lines[1:]])
assert n_ff == w.shape[1], (n_ff, w.shape)
assert lu.shape == ref.shape, (lu.shape, ref.shape)
err = np.max(np.abs(lu - ref)) / max(np.max(np.abs(ref)), 1e-30)
print(f"{t.tensor_type.name:6s} n_embd={w.shape[0]} n_ff={n_ff} max rel. error {err:.2e} -> {'OK' if err < 1e-5 else 'MISMATCH'}")
sys.exit(0 if err < 1e-5 else 1)
