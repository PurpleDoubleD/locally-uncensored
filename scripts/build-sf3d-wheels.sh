#!/bin/bash
# build-sf3d-wheels.sh: build the two C++ extensions of Stable Fast 3D
# (texture_baker, uv_unwrapper) into the wheels the app ships in
# src-tauri/resources/mesh3d/wheels/ (see src-tauri/src/commands/mesh3d_sf3d.rs).
#
# A customer's Mac has no compiler, so LU builds these once and the install
# hands them to pip as files. This script is how they were built, so a new
# torch or Python pin can build them again.
#
# Usage:
#   scripts/build-sf3d-wheels.sh <python> <out-dir>
#
#   <python>   a Python 3.12 with exactly torch==2.10.0, numpy and
#              setuptools==71.1.0 (the pins of mesh3d_sf3d.rs), on Apple Silicon
#   <out-dir>  an empty folder; the wheels land there
#
# Needs the Xcode command line tools. The source archive is fetched at the
# pinned commit into a fresh folder, throttled, and checked by sha256 before
# anything is built. Nothing from it is run except its two setup.py files.
#
# What is set, and why:
#   USE_METAL=1         texture_baker gets its Metal kernel for MPS
#   USE_CUDA=0          no CUDA on a Mac
#   USE_NATIVE_ARCH=0   no -march=native: the wheels run on every Apple Silicon
#   CFLAGS=-O3          uv_unwrapper's own flags lose -O3 on a Mac
#   MACOSX_DEPLOYMENT_TARGET=14.0   LU's oldest macOS
#   LDFLAGS             find torch's libraries next to the package
#                       (@loader_path/../torch/lib) and drop what is not used,
#                       so uv_unwrapper does not link a Homebrew libomp
#
# The build is not byte for byte the same twice (time stamps in the zip),
# so the wheels in the tree are the pinned ones and a rebuild gets new sums.
#
# Afterwards: put the wheels into src-tauri/resources/mesh3d/wheels/, write
# their sha256 into WHEELS of mesh3d_sf3d.rs, and run
#   cargo test --lib mesh3d_sf3d
set -euo pipefail

PY="${1:?the Python to build with}"
OUT="${2:?an empty folder for the wheels}"
COMMIT="ff21fc491b4dc5314bf6734c7c0dabd86b5f5bb2"
SHA256="3674ecf09167764be5471a803cf716b390feccbedc389d8c37aa710b754e2808"
URL="https://github.com/Stability-AI/stable-fast-3d/archive/${COMMIT}.zip"

mkdir -p "$OUT"
if [ -n "$(ls -A "$OUT")" ]; then
  echo "$OUT is not empty" >&2
  exit 1
fi
OUT="$(cd "$OUT" && pwd)"

"$PY" -I -c 'import torch, setuptools, sys; assert torch.__version__.startswith("2.10.0"), torch.__version__; assert sys.version_info[:2] == (3, 12), sys.version' \
  || { echo "the Python does not have the pinned torch and Python line" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -sSL --limit-rate 20M -o "$WORK/src.zip" "$URL"
GOT="$(shasum -a 256 "$WORK/src.zip" | cut -d' ' -f1)"
if [ "$GOT" != "$SHA256" ]; then
  echo "the archive has sha256 $GOT, not $SHA256" >&2
  exit 1
fi
(cd "$WORK" && unzip -q src.zip)
SRC="$WORK/stable-fast-3d-$COMMIT"

export USE_CUDA=0 USE_NATIVE_ARCH=0 MACOSX_DEPLOYMENT_TARGET=14.0 CFLAGS="-O3"
export LDFLAGS="-Wl,-rpath,@loader_path/../torch/lib -Wl,-dead_strip_dylibs"
(cd "$SRC/texture_baker" && USE_METAL=1 "$PY" -I -m pip wheel --no-index --no-build-isolation --no-deps -w "$OUT" .)
(cd "$SRC/uv_unwrapper" && "$PY" -I -m pip wheel --no-index --no-build-isolation --no-deps -w "$OUT" .)

# Only torch's libraries and the system's may be linked.
CHECK="$WORK/check"
mkdir -p "$CHECK"
for wheel in "$OUT"/*.whl; do (cd "$CHECK" && unzip -qo "$wheel"); done
BAD="$(otool -L "$CHECK"/*/_C*.so | grep -v ':$' | grep -v '@rpath/lib\(c10\|torch\|torch_cpu\|torch_python\)\.dylib' | grep -v '/usr/lib/' || true)"
if [ -n "$BAD" ]; then
  echo "a wheel links something a customer's Mac does not have:" >&2
  echo "$BAD" >&2
  exit 1
fi
shasum -a 256 "$OUT"/*.whl
