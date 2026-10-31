#!/usr/bin/env bash
#
# build-llama.sh — build the bundled llama.cpp `llama-server` sidecar for
# Locally Uncensored's built-in inference engine (P0 of the built-in-engine plan).
#
# mac: the produced binary is statically linked with Metal embedded, so a
# single self-contained file drops into `src-tauri/bin/llama-server-<triple>`
# and Tauri picks it up as an `externalBin` sidecar (target triple appended,
# code-signed with the app on macOS).
#
# Windows and Linux (K1, 3.0.1): the binary is dynamic and loads its CPU
# kernels and the Vulkan backend at runtime (GGML_BACKEND_DL +
# GGML_CPU_ALL_VARIANTS, see cmake_flags_for below): a fixed x86-64-v3
# binary made every pre-Haswell/pre-Excavator CPU crash with 0xC000001D
# (Windows) or SIGILL (Linux) before llama-server could log anything. The
# companion ggml-cpu-*/ggml-vulkan libraries this produces land in
# `src-tauri/resources/llama/<triple>/`, bundled as Tauri `resources`
# (tauri.windows.conf.json / tauri.linux.conf.json) alongside the exe
# sidecar, not as more externalBin entries.
#
# Idempotent: clones/pins llama.cpp once into a build cache, reuses it on reruns.
# Binaries and companion libraries are NOT committed, see
# src-tauri/bin/.gitignore and src-tauri/resources/llama/.gitignore.
#
# Usage:
#   scripts/build-llama.sh                 # build for the host target triple
#   scripts/build-llama.sh <triple> ...    # build for one or more explicit triples
#   scripts/build-llama.sh --check         # verify already-built host binary boots
#
# Supported triples:
#   aarch64-apple-darwin      (Metal, embedded shaders)   — mac-first
#   x86_64-apple-darwin       (Metal, embedded shaders)   — mac-first
#   x86_64-pc-windows-msvc    (Vulkan)                    — P6, after launch
#   x86_64-unknown-linux-gnu  (Vulkan)                    — P6, after launch
#
set -euo pipefail

# --- Pinned, reproducible llama.cpp revision -------------------------------
# LLAMA_COMMIT is the pin. A git tag is a mutable pointer: upstream can delete
# and recreate it, and whoever owns that repo (or anyone who takes it over) can
# point b9949 at different code tomorrow. This script builds the binary that
# ships inside the installer and is code-signed with the app, so "whatever the
# tag names on the day CI runs" is not a supply chain we can stand behind.
# LLAMA_TAG stays as the readable name and as the cross-check: on every run,
# cache hit included, ensure_src asserts BOTH that HEAD is LLAMA_COMMIT and
# that the working tree carries no change against it, and the build stops if
# either fails.
#
# To bump, resolve the tag yourself and paste BOTH — llama.cpp tags are build
# numbers and upstream SKIPS numbers whose CI failed, so the tag must exist:
#   git ls-remote --tags https://github.com/ggml-org/llama.cpp.git 'refs/tags/<tag>'
# CI reuses a cached checkout keyed on hashFiles('scripts/build-llama.sh')
# (release.yml, sidecar-windows.yml), so both values below are inside the cache
# key by construction — bumping one cannot silently reuse the old source tree.
LLAMA_TAG="${LLAMA_TAG:-b11960}"
LLAMA_COMMIT="${LLAMA_COMMIT:-8642541b255bfb5dc39cd351a178be09013a55d6}"
LLAMA_REPO="${LLAMA_REPO:-https://github.com/ggml-org/llama.cpp.git}"

# --- Paths -----------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Overridable only for tests (build-llama-script.test.ts), the same pattern as
# LLAMA_BUILD_CACHE below: a real build always derives it from the script's
# own location, so BIN_DIR/resources always land in the real checkout.
REPO_ROOT="${BUILD_LLAMA_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CACHE_DIR="${LLAMA_BUILD_CACHE:-$REPO_ROOT/.llama-build}"
SRC_DIR="$CACHE_DIR/llama.cpp"
BIN_DIR="$REPO_ROOT/src-tauri/bin"

log()  { printf '\033[1;35m[build-llama]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[build-llama] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

host_triple() {
  if command -v rustc >/dev/null 2>&1; then
    rustc --print host-tuple 2>/dev/null && return
    rustc -vV 2>/dev/null | awk '/^host:/{print $2}'
  else
    # Fallback for macOS without rustc on PATH.
    case "$(uname -sm)" in
      "Darwin arm64")  echo "aarch64-apple-darwin" ;;
      "Darwin x86_64") echo "x86_64-apple-darwin" ;;
      *) die "cannot infer host triple; pass one explicitly" ;;
    esac
  fi
}

# Map a Rust target triple → cmake flags for the llama-server build.
# LLAMA_OPENSSL=OFF: no HTTPS/downloader deps — the app manages model files.
# LLAMA_BUILD_UI/USE_PREBUILT_UI=OFF: headless sidecar — no npm build and no
# HF asset fetch at compile time.
#
# K1 (3.0.1): mac stays a single STATIC binary with Metal embedded. Apple
# Silicon has one relevant CPU family, so there is nothing to select at
# runtime and GGML_CPU_ALL_VARIANTS does not even claim ARM/Apple support for
# it (ggml/src/CMakeLists.txt only wires ALL_VARIANTS for x86, ARM/Android/
# PowerPC/s390x/riscv64, never "Apple x86_64" as a variant target; darwin
# stays out of that switch entirely).
#
# Windows and Linux (x86_64) switch to a DYNAMIC, multi-ISA build instead of
# one fixed x86-64-v3 binary. With GGML_NATIVE=OFF (unchanged, always was)
# and INS_ENB therefore ON, ggml/CMakeLists.txt:141-166 forces SSE4.2 + AVX +
# AVX2 + BMI2 + FMA + F16C into the ONE binary this script used to produce,
# any CPU older than Haswell/Excavator (2013+) gets 0xC000001D on Windows or
# SIGILL on Linux before llama-server can even log a line. Verified against
# the pinned llama.cpp checkout, not guessed:
#   GGML_BACKEND_DL=ON + GGML_CPU_ALL_VARIANTS=ON is the exact pair
#   ggml/src/CMakeLists.txt:371-376 requires (GGML_CPU_ALL_VARIANTS without
#   GGML_BACKEND_DL is a FATAL_ERROR there), and GGML_CPU_ALL_VARIANTS in turn
#   requires BUILD_SHARED_LIBS=ON (ggml/src/CMakeLists.txt:188-190, also a
#   FATAL_ERROR otherwise). Under MSVC this produces nine ggml-cpu-*.dll
#   variants (x64, sse42, sandybridge, haswell, skylakex, cannonlake,
#   cascadelake, icelake, alderlake (ggml/src/CMakeLists.txt:378-402); GCC on
#   Linux additionally gets ivybridge, piledriver, cooperlake, zen4 and
#   sapphirerapids (same block, the four "if (NOT MSVC)" branches). At
#   startup llama-server calls ggml_backend_load_all() (src/llama.cpp,
#   common/arg.cpp), which (per ggml/src/ggml-backend-reg.cpp:479-486)
#   scores every ggml-cpu-*.{dll,so} beside the executable and in the current
#   working directory and dlopen()s the best-scoring one for the CPU it is
#   actually running on. GGML_VULKAN stays on for both; it becomes a sibling
#   loadable backend (ggml-vulkan.dll/.so) the same way, discovered through
#   the identical search, so the GPU path is unaffected by this switch.
cmake_flags_for() {
  local triple="$1"
  local common="-DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release"
  case "$triple" in
    aarch64-apple-darwin)
      echo "$common -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-14.0}" ;;
    x86_64-apple-darwin)
      echo "$common -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_ARCHITECTURES=x86_64 -DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-14.0}" ;;
    x86_64-pc-windows-msvc)
      # -MAP, not /MAP (review-waechter-windows.md BL1): verify-sidecar-isa.sh's
      # Windows ISA guard needs a linker map to turn a VEX/EVEX hit's address
      # into an owning function and Lib:Object (the CRT/STL allowlist and the
      # own-code dominance check both key off that). MSYS/Git-Bash rewrites an
      # ARGV entry that looks like a Unix absolute path ("/MAP") into a native
      # Windows path before the (unquoted) cmake invocation in build_triple
      # below ever sees it, on the command line just as much as in an
      # environment variable: measured on the box, `cmd //c echo
      # -DCMAKE_SHARED_LINKER_FLAGS=/MAP` comes back as
      # `-DCMAKE_SHARED_LINKER_FLAGS=C:/Program Files/Git/MAP`, so the linker
      # never received /MAP at all and produced no .map file (an earlier
      # version of this comment claimed the cmake command line was exempt
      # from that rewriting; it measured that only against a Windows CI
      # workflow log that had been produced with a manual override, and the
      # claim was wrong). link.exe accepts the single-dash spelling exactly
      # the same way (`cmd //c echo -DCMAKE_SHARED_LINKER_FLAGS=-MAP` passes
      # through unchanged, since "-MAP" does not look like a Unix path to
      # MSYS's argv rewriter), so use that instead of the LDFLAGS/
      # MSYS2_ENV_CONV_EXCL environment-variable workaround the box bauer used
      # to prove this out (e2e/k1-avx, 04-BOX-SIDECAR-AVX-BEFUND.md Schritt 1).
      #
      # A REAL sidecar rebuild on the box with only the two flags above
      # (round 2's first attempt) surfaced a second, genuine gap: cmake has
      # THREE linker-flags cache variables, not two.
      # ggml/src/CMakeLists.txt:267 adds every GGML_BACKEND_DL backend
      # (`add_library(${backend} MODULE ${ARGN})`, both the nine
      # ggml-cpu-*.dll variants and ggml-vulkan.dll) as a CMake MODULE
      # library, not SHARED, and MSVC/CMake links a MODULE target with
      # CMAKE_MODULE_LINKER_FLAGS, a cache variable CMAKE_SHARED_LINKER_FLAGS
      # never reaches. Measured: a build with only
      # CMAKE_SHARED_LINKER_FLAGS/CMAKE_EXE_LINKER_FLAGS set to -MAP produced
      # ggml.map, ggml-base.map, llama.map, llama-common.map,
      # llama-server-impl.map, mtmd.map and llama-server.map (the exe) but
      # NOT ONE .map for any ggml-cpu-*.dll or ggml-vulkan.dll, exactly the
      # files verify-sidecar-isa.sh's Windows guard most needs a map for,
      # since they are where an unconditional-AVX regression would actually
      # ship. All three linker-flags variables now carry -MAP.
      echo "$common -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_VULKAN=ON -DCMAKE_SHARED_LINKER_FLAGS=-MAP -DCMAKE_EXE_LINKER_FLAGS=-MAP -DCMAKE_MODULE_LINKER_FLAGS=-MAP" ;;
    x86_64-unknown-linux-gnu)
      # CMAKE_BUILD_RPATH_USE_ORIGIN=ON (BLOCKER B3): without it,
      # CMAKE_BUILD_WITH_INSTALL_RPATH's OFF default still makes CMake write
      # an RPATH into every linked .so/exe, and that RPATH is an ABSOLUTE
      # path into the CI runner's own build directory (a path that will not
      # exist once shipped) unless told to compute an $ORIGIN-relative one
      # instead. This is not visible by grepping CMakeLists.txt for the word
      # RPATH, since no CMakeLists.txt line requests it either way, it is
      # CMake's own default: only readelf on the actual output proves what
      # landed (see check_no_absolute_build_rpath in verify-sidecar-isa.sh).
      echo "$common -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_VULKAN=ON -DCMAKE_BUILD_RPATH_USE_ORIGIN=ON" ;;
    *)
      die "unsupported target triple: $triple" ;;
  esac
}

# True for a triple this script builds as a dynamic, multi-ISA sidecar (a
# main executable plus loadable ggml-cpu-*/ggml-vulkan companion libraries).
# False for mac, which stays the old single static binary. Both the copy step
# and the resource layout branch on this, so it is one function instead of
# two case statements that could drift apart.
is_dynamic_isa_triple() {
  case "$1" in
    x86_64-pc-windows-msvc | x86_64-unknown-linux-gnu) return 0 ;;
    *) return 1 ;;
  esac
}

# Directory the companion ggml/llama shared libraries for a dynamic-ISA
# triple are staged into, so Tauri can bundle them as `resources` (see
# tauri.windows.conf.json / tauri.linux.conf.json) and so the same path is a
# stable, known location in dev (no bundling involved, engine.rs reads it
# straight off disk, see resolve_engine_backend_dir).
resource_llama_dir_for() {
  echo "$REPO_ROOT/src-tauri/resources/llama/$1"
}

# The bundled file carries the app prefix (GitHub #120): Tauri's deb bundler
# copies external binaries into /usr/bin, and Debian's own llama.cpp-tools
# package already owns /usr/bin/llama-server, so a plain name made dpkg refuse
# the whole install. Only the OUTPUT name changes; the binary llama.cpp itself
# builds is still called llama-server and is found under that name above.
out_name_for() {
  case "$1" in
    *-windows-*) echo "lu-llama-server-$1.exe" ;;
    *)           echo "lu-llama-server-$1" ;;
  esac
}

# llama-quantize ships on macOS only (static binary, nothing beside it).
quantize_ships_for() {
  case "$1" in
    *-apple-darwin) return 0 ;;
    *)              return 1 ;;
  esac
}

quantize_out_name_for() {
  echo "lu-llama-quantize-$1"
}

# llama-cvector-generator (3.0.9, P11 Neuron tweaker) ships on all three
# desktop platforms: it turns two short lists of example prompts into a
# control vector for the model the user has, which llama-server then applies
# with --control-vector. Same pinned source tree. On the Mac it comes out of
# the server's own static build; on Windows and Linux out of a static build
# of its own (cvector_cmake_flags_for below, FEHLER-P11 #8), one file that
# needs no library beside it. FEHLER-P11 #7: everything a feature needs must
# come with the install.
cvector_ships_for() {
  case "$1" in
    *-apple-darwin | x86_64-pc-windows-msvc | x86_64-unknown-linux-gnu) return 0 ;;
    *)                                                                 return 1 ;;
  esac
}

# FEHLER-P11 #8: the pinned llama.cpp only defines the cvector-generator
# target when GGML_BACKEND_DL is OFF (tools/CMakeLists.txt:35-39, "these
# tools use backends directly ... and depend on CPU backend symbols"). The
# server build on Windows and Linux needs BACKEND_DL ON (K1, the dynamic
# CPU variants), so there the generator gets a cmake run of its own, in its
# own build directory, and the server build is left exactly as it was.
#
# What that run builds, and why:
#   - static (BUILD_SHARED_LIBS=OFF): one self-contained file, no companion
#     library to stage, find or keep in step with the server's;
#   - CPU only (no GGML_VULKAN): no hard link to vulkan-1.dll/libvulkan.so,
#     so the tool starts on a machine without a GPU driver as well. It reads
#     some 40 short example pairs once per slider; the strength check after
#     it runs on the engine (GPU), not here;
#   - the K1 baseline: GGML_NATIVE=OFF alone switches SSE4.2/AVX/AVX2/FMA/
#     F16C/BMI2 ON (ggml/CMakeLists.txt:141-166, INS_ENB), the exact K1
#     crash on older CPUs, and a static build has no CPU variants to fall
#     back on. So every ISA option is set OFF by name, and
#     verify-sidecar-isa.sh checks the built file like the server exe
#     (baseline: no AVX instruction);
#   - no OpenMP: ggml's own thread pool, so no vcomp140.dll/libgomp.so is
#     needed beside it;
#   - Windows keeps -MAP, the ISA guard reads the linker map;
#   - Windows puts switch jump tables in .rdata (-jumptablerdata, MSVC 17.7+,
#     x64 only). By default MSVC places them in .text beside the code
#     (learn.microsoft.com, /jumptablerdata), and their entries are image
#     RVAs, so in this exe they decode as instructions that are not there:
#     FEHLER-P11 #9, an "unprotected" EVEX vfmadd132ss xmm21 at a $LN label
#     of speculative.obj, while the same object in the server's
#     llama-common.dll (other RVAs) reads clean. Nothing in this build may
#     emit EVEX (no /arch, every ISA option off), so moving the tables out
#     of .text is the fix and the proof at once: if the guard still finds
#     the hit, it is real code. Set through CMAKE_<LANG>_FLAGS_INIT, which
#     CMake's Windows-MSVC module appends its defaults (/EHsc and the rest)
#     to; CMAKE_<LANG>_FLAGS itself would replace them. Dash spelling for
#     the same MSYS reason as -MAP.
cvector_separate_build_for() {
  is_dynamic_isa_triple "$1"
}

cvector_cmake_flags_for() {
  local triple="$1"
  local common="-DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DCMAKE_BUILD_TYPE=Release"
  local cpu="-DBUILD_SHARED_LIBS=OFF -DGGML_BACKEND_DL=OFF -DGGML_CPU_ALL_VARIANTS=OFF -DGGML_VULKAN=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF -DGGML_SSE42=OFF -DGGML_AVX=OFF -DGGML_AVX_VNNI=OFF -DGGML_AVX2=OFF -DGGML_BMI2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF -DGGML_AVX512_BF16=OFF -DGGML_AMX_TILE=OFF -DGGML_AMX_INT8=OFF -DGGML_AMX_BF16=OFF"
  case "$triple" in
    x86_64-pc-windows-msvc)   echo "$common $cpu -DCMAKE_EXE_LINKER_FLAGS=-MAP -DCMAKE_C_FLAGS_INIT=-jumptablerdata -DCMAKE_CXX_FLAGS_INIT=-jumptablerdata" ;;
    x86_64-unknown-linux-gnu) echo "$common $cpu" ;;
    *) die "no separate vector-tool build for $triple" ;;
  esac
}

cvector_build_dir_for() {
  echo "$CACHE_DIR/build-$1-cvector"
}

cvector_out_name_for() {
  case "$1" in
    *-windows-*) echo "lu-llama-cvector-generator-$1.exe" ;;
    *)           echo "lu-llama-cvector-generator-$1" ;;
  esac
}

# A 40-hex commit SHA and nothing else. A short SHA, a tag name or an empty
# override would all silently reduce the pin back to "whatever origin says".
assert_pinned_commit() {
  case "$LLAMA_COMMIT" in
    *[!0-9a-f]* | "") die "LLAMA_COMMIT must be a full 40-char lowercase commit SHA, got '$LLAMA_COMMIT'" ;;
  esac
  [ "${#LLAMA_COMMIT}" -eq 40 ] \
    || die "LLAMA_COMMIT must be a full 40-char lowercase commit SHA, got '$LLAMA_COMMIT'"
}

ensure_src() {
  command -v git >/dev/null 2>&1 || die "git not found"
  assert_pinned_commit
  mkdir -p "$CACHE_DIR"
  if [ ! -d "$SRC_DIR/.git" ]; then
    log "initialising llama.cpp checkout for $LLAMA_TAG ($LLAMA_COMMIT)"
    git init -q "$SRC_DIR"
    git -C "$SRC_DIR" remote add origin "$LLAMA_REPO"
  fi
  local have
  have="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ "$have" != "$LLAMA_COMMIT" ]; then
    log "fetching llama.cpp $LLAMA_TAG ($LLAMA_COMMIT)"
    # Fetch the object by SHA — GitHub serves any commit reachable from a ref,
    # and a request for a SHA cannot be answered with different code. The tag
    # is only the fallback for a mirror that refuses SHA fetches; the check
    # below is what decides whether we got the right object either way.
    git -C "$SRC_DIR" fetch --depth 1 origin "$LLAMA_COMMIT" 2>/dev/null \
      || git -C "$SRC_DIR" fetch --depth 1 origin "refs/tags/$LLAMA_TAG"
    git -C "$SRC_DIR" checkout -f --detach FETCH_HEAD
  fi
  # Re-asserted on every run, cache hit included: a restored build cache is an
  # artifact from an earlier run, not evidence about what is in it now.
  have="$(git -C "$SRC_DIR" rev-parse HEAD)"
  [ "$have" = "$LLAMA_COMMIT" ] \
    || die "llama.cpp checkout is at $have, expected $LLAMA_COMMIT ($LLAMA_TAG) — upstream tag moved, or the build cache is stale"
  assert_clean_tree
}

# rev-parse only proves where HEAD POINTS. cmake does not compile HEAD, it
# compiles the WORKING TREE under $SRC_DIR — and a restored cache is a tarball
# somebody else produced, in which the files can say anything while .git/HEAD
# still names the pinned SHA. Verifying the pointer and calling that a verified
# source tree was the whole gap.
#
# `git status` closes it: the index is force-refreshed so nothing rides on a
# stale stat cache, and then any tracked file whose CONTENT differs from the
# pinned commit, and any untracked file that is not covered by llama.cpp's own
# .gitignore, makes the build stop. Together with the SHA check above that is
# the statement the comment always claimed: what gets compiled is the tree the
# pinned commit names.
#
# Ignored paths are deliberately not in scope — the cmake build directory lives
# outside $SRC_DIR, so nothing in the ignore set reaches the compiler.
assert_clean_tree() {
  git -C "$SRC_DIR" update-index -q --really-refresh >/dev/null 2>&1 || true
  local dirty
  dirty="$(git -C "$SRC_DIR" status --porcelain --untracked-files=all 2>/dev/null || true)"
  [ -z "$dirty" ] || die "llama.cpp source tree does not match $LLAMA_COMMIT ($LLAMA_TAG) — the checkout carries local changes, so the build would not be the pinned source:
$dirty"
}

# sha256 of a file, or "" where no hasher is on PATH. macOS ships `shasum`,
# Linux and Git-Bash ship `sha256sum`; neither is guaranteed on the other.
sha256_of() {
  local line hash
  if command -v shasum >/dev/null 2>&1; then
    line="$(shasum -a 256 "$1")"
  elif command -v sha256sum >/dev/null 2>&1; then
    line="$(sha256sum "$1")"
  else
    return 0
  fi
  # The leading backslash is not noise and not a fluke: GNU coreutils prefixes
  # the WHOLE line with `\` whenever it had to escape the file name (`\` → `\\`,
  # newline → `\n`), which under Git Bash on Windows is every single call,
  # because the paths there contain backslashes. Taking $1 verbatim then yields
  # `\5ec30eef…` — and this digest is the record of the binary that ships
  # signed with the app, so one foreign character makes it compare unequal
  # forever. Strip that one marker byte, then cut at the separator: whatever
  # escaping GNU applied lives in the NAME, behind the separator, and is never
  # part of the hash — so only the hash field needs looking at.
  hash="${line#\\}"
  hash="${hash%% *}"
  # Anything that is not exactly 64 lowercase hex is not a digest. Report
  # nothing rather than something wrong — the caller prints "unavailable".
  case "$hash" in
    *[!0-9a-f]* | "") return 0 ;;
  esac
  [ "${#hash}" -eq 64 ] || return 0
  printf '%s\n' "$hash"
}

# cmake is checked HERE, at the compiler, and deliberately NOT in ensure_src.
# ensure_src does git work only — clone, check out the pinned commit, verify
# that HEAD and the working tree really are that commit — and it never invokes
# a compiler. Guarding it with a cmake check made the supply-chain
# VERIFICATION unrunnable on every machine without cmake (a stock Windows box,
# a reviewer who only wants to re-check the pin), for a tool it does not use.
# Every path that reaches `cmake` below goes through this function, so the
# build still stops with the same message and nothing gets built without it.
require_cmake() {
  command -v cmake >/dev/null 2>&1 \
    || die "cmake not found — install it (macOS: brew install cmake, Windows: winget install Kitware.CMake)"
}

# K1 (3.0.1): for a dynamic-ISA triple, `llama-server` no longer stands
# alone: GGML_BACKEND_DL/GGML_CPU_ALL_VARIANTS build it next to a
# ggml-cpu-<variant>.{dll,so} per CPU tier plus ggml-vulkan and the base
# ggml/llama runtime libraries, ALL written into the executable's own build
# output directory (ggml/src/CMakeLists.txt:269 pins every backend MODULE's
# LIBRARY_OUTPUT_DIRECTORY to the same CMAKE_RUNTIME_OUTPUT_DIRECTORY the
# exe uses). None of that is guessed or hardcoded here: whatever cmake
# actually built next to the exe is what gets staged, so a variant list
# upstream adds or drops later is picked up automatically.
#
# A copy, not a symlink: Linux SONAME resolution needs the exact versioned
# filename the loader was linked against (e.g. libggml-base.so.1), which is
# commonly a symlink to the real file. Plain `cp` (no -P/-d) dereferences, so
# every matched name becomes its own real file, a little larger on disk, but
# nothing a resource bundler or an installer can leave dangling.
#
# A standalone function (not inlined in build_triple) so it can be unit
# tested against a directory of fake .dll/.so files, without paying for a
# real cmake build to check the staging logic itself. Prints one
# "path: digest" line per file it staged, plus the exe's own; empty stdin/no
# output means "not a dynamic-ISA triple, nothing to stage" and is not an
# error.
stage_dynamic_isa_companions() {
  local triple="$1" bin_out_dir="$2" exe_out="$3"
  is_dynamic_isa_triple "$triple" || return 0
  local companions_dir; companions_dir="$(resource_llama_dir_for "$triple")"
  rm -rf "$companions_dir"
  mkdir -p "$companions_dir"
  local lib_glob
  case "$triple" in
    *-windows-*) lib_glob='*.dll' ;;
    *)           lib_glob='*.so*' ;;
  esac
  local found_any=""
  local lib
  while IFS= read -r lib; do
    [ -n "$lib" ] || continue
    found_any=1
    local lib_out="$companions_dir/$(basename "$lib")"
    cp "$lib" "$lib_out"
    local lib_digest; lib_digest="$(sha256_of "$lib_out")"
    printf '%s: %s\n' "$lib_out" "${lib_digest:-unavailable}"
  # -L: follow symlinks so `-type f` also matches them. Without it, both BSD
  # find (macOS, where this runs in dev/tests) and GNU find (the Linux
  # runner) skip a symlink even when it points at a regular file, and Linux's
  # own SONAME symlinks (libggml-base.so -> libggml-base.so.1 ->
  # libggml-base.so.1.2.3) are exactly that: only the fully-versioned real
  # file would be found, and the literal SONAME the dynamic linker actually
  # looks for would be silently missing from what gets staged. Measured, not
  # assumed: caught by the Linux companion-staging test below, red without
  # this flag.
  done < <(find -L "$bin_out_dir" -maxdepth 1 -type f -iname "$lib_glob")
  [ -n "$found_any" ] \
    || die "GGML_BACKEND_DL build for $triple produced no $lib_glob next to $exe_out: the dynamic CPU-variant libraries are missing, the sidecar would only run on the build host's own CPU"

  # Belt and suspenders for BLOCKER B3, Linux only: CMAKE_BUILD_RPATH_USE_ORIGIN
  # (see cmake_flags_for) should already have made every .so carry an
  # $ORIGIN-relative RPATH, but that flag depends on the cmake/linker version
  # on the build host honouring it. Force the point with patchelf when it is
  # on PATH, so the staged, shippable copy is right even if the build-time
  # flag was silently ignored upstream. Best-effort: patchelf is not
  # installed on every dev machine, only on the Linux CI runner (release.yml
  # already apt-gets it), and this repo does not want a build TOOL to be a
  # hard requirement for staging files that were already produced.
  case "$triple" in
    *-linux-*)
      if command -v patchelf >/dev/null 2>&1; then
        while IFS= read -r staged_so; do
          patchelf --set-rpath '$ORIGIN' "$staged_so" 2>/dev/null || true
        done < <(find "$companions_dir" -maxdepth 1 -type f -iname '*.so*')
      fi
      ;;
  esac
}

build_triple() {
  require_cmake
  local triple="$1"
  local build_dir="$CACHE_DIR/build-$triple"
  local flags; flags="$(cmake_flags_for "$triple")"
  log "configuring $triple  ($flags)"
  # shellcheck disable=SC2086
  cmake -S "$SRC_DIR" -B "$build_dir" $flags
  log "building llama-server for $triple"
  # Bare `-j` (no count) lets Make fork a compile per ready target and OOM-kills
  # CI runners mid llama.cpp.o (SIGTERM 143). Cap to a finite, memory-safe count;
  # CI lowers it further via BUILD_JOBS=2.
  cmake --build "$build_dir" --config Release --target llama-server -j "${BUILD_JOBS:-4}"
  # macOS also ships llama-quantize (lu-llama-quantize, tauri.macos.conf.json):
  # the refusal-removal tool (A14) writes its copy in the original's quant
  # type with it. Same static Metal build, same source tree. Windows and
  # Linux do not ship it yet; the tool writes Q8_0 there instead.
  if quantize_ships_for "$triple"; then
    cmake --build "$build_dir" --config Release --target llama-quantize -j "${BUILD_JOBS:-4}"
  fi
  local cv_build_dir="$build_dir"
  if cvector_ships_for "$triple"; then
    if cvector_separate_build_for "$triple"; then
      cv_build_dir="$(cvector_build_dir_for "$triple")"
      local cv_flags; cv_flags="$(cvector_cmake_flags_for "$triple")"
      log "configuring the vector tool for $triple apart from the server  ($cv_flags)"
      # shellcheck disable=SC2086
      cmake -S "$SRC_DIR" -B "$cv_build_dir" $cv_flags
    fi
    cmake --build "$cv_build_dir" --config Release --target llama-cvector-generator -j "${BUILD_JOBS:-4}"
  fi
  # Locate the produced binary (path differs by generator/platform).
  local built
  built="$(find "$build_dir" -type f \( -name 'llama-server' -o -name 'llama-server.exe' \) -print -quit)"
  [ -n "$built" ] || die "llama-server binary not found under $build_dir"
  mkdir -p "$BIN_DIR"
  local out="$BIN_DIR/$(out_name_for "$triple")"
  cp "$built" "$out"
  chmod +x "$out"
  if quantize_ships_for "$triple"; then
    local built_q
    built_q="$(find "$build_dir" -type f -name 'llama-quantize' -print -quit)"
    [ -n "$built_q" ] || die "llama-quantize binary not found under $build_dir"
    cp "$built_q" "$BIN_DIR/$(quantize_out_name_for "$triple")"
    chmod +x "$BIN_DIR/$(quantize_out_name_for "$triple")"
  fi
  if cvector_ships_for "$triple"; then
    local built_cv
    built_cv="$(find "$cv_build_dir" -type f \( -name 'llama-cvector-generator' -o -name 'llama-cvector-generator.exe' \) -print -quit)"
    [ -n "$built_cv" ] || die "llama-cvector-generator binary not found under $cv_build_dir"
    cp "$built_cv" "$BIN_DIR/$(cvector_out_name_for "$triple")"
    chmod +x "$BIN_DIR/$(cvector_out_name_for "$triple")"
  fi

  local out_digest; out_digest="$(sha256_of "$out")"
  local digest_lines="$out: ${out_digest:-unavailable}"
  local companion_lines
  companion_lines="$(stage_dynamic_isa_companions "$triple" "$(dirname "$built")" "$out")"
  [ -z "$companion_lines" ] || digest_lines="$digest_lines
$companion_lines"

  # Record what actually got produced. A from-source build is not bit-for-bit
  # reproducible across machines, so none of these can be pinned to a
  # constant, but the digest of every file that ships, next to the source
  # revision they came from, is what an "which binaries were those?" question
  # after the fact needs. A list now, not a single line: the pin check in
  # ensure_src/assert_clean_tree verifies the SOURCE TREE once per run and
  # already covers every file this step produces (nothing here compiles from
  # anything outside $SRC_DIR), but the digest log is per-OUTPUT-FILE by
  # nature, so a multi-file build means a multi-line log, not a new pin
  # mechanism.
  log "installed (llama.cpp $LLAMA_TAG @ ${LLAMA_COMMIT:0:12}):"
  while IFS= read -r line; do log "  $line"; done <<<"$digest_lines"
}

# Boot the host binary and probe /health on an ephemeral port. Without a
# model llama-server starts in router mode (no weights loaded), so /health
# answers 200 on any machine.
#
# K1 (3.0.1): for a dynamic-ISA triple this MUST run the same way engine.rs
# spawns it in the app: cwd set to the resource directory holding the
# ggml-cpu-*/ggml-vulkan companion libraries, nothing copied next to the exe
# because ggml_backend_load_best only scans the executable's own directory
# and the process's current directory (ggml-backend-reg.cpp:479-486). A check
# that ran the bare exe from $BIN_DIR would pass on a build host that also
# happens to have those libraries lying around and prove nothing about the
# layout a real install actually has.
check_binary() {
  local triple; triple="$(host_triple)"
  local bin="$BIN_DIR/$(out_name_for "$triple")"
  [ -x "$bin" ] || die "no built binary at $bin — build first"
  local run_dir="$BIN_DIR"
  if is_dynamic_isa_triple "$triple"; then
    run_dir="$(resource_llama_dir_for "$triple")"
    [ -d "$run_dir" ] || die "no companion libraries at $run_dir, build first"
  fi
  # N1: the exe itself (in $BIN_DIR) and its companion libraries (in
  # $run_dir) live in DIFFERENT directories once bundled (deb/AppImage), the
  # same split engine.rs's apply_engine_backend_dir sets LD_LIBRARY_PATH for
  # at the real spawn site. cwd alone (what this check used before) only
  # covers the dlopen'd ggml-cpu-*/ggml-vulkan companions, which ggml itself
  # searches for beside the exe and in cwd (ggml-backend-reg.cpp:479-486);
  # it does not cover the exe's own DT_NEEDED libs (libggml-base.so etc, on
  # a triple where $ORIGIN does not reach across directories), which the
  # loader needs before main() ever runs. Mirror the real environment here
  # too, or this check can pass for a reason the shipped app does not share.
  if [ "${triple}" = "x86_64-unknown-linux-gnu" ]; then
    local ld_path="$run_dir"
    [ -z "${LD_LIBRARY_PATH:-}" ] || ld_path="$run_dir:$LD_LIBRARY_PATH"
    export LD_LIBRARY_PATH="$ld_path"
  fi
  ( cd "$run_dir" && "$bin" --version >/dev/null 2>&1 ) || die "$bin --version failed (run from $run_dir, LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-unset})"
  # BUILD_LLAMA_CHECK_PORT only for build-llama-script.test.ts, which takes a
  # free port so a server already on 8129 cannot answer for the one under test.
  local port="${BUILD_LLAMA_CHECK_PORT:-8129}"
  log "boot check: $bin on 127.0.0.1:$port, cwd=$run_dir (no model, router mode, /health only)"
  # exec: $! has to be the server itself. Without it $! was the subshell, the
  # kill below ended only that, and a check that failed (E1: the 9 s Metal
  # first start) left a llama-server holding port 8129 behind.
  ( cd "$run_dir" && exec "$bin" --host 127.0.0.1 --port "$port" >/dev/null 2>&1 ) &
  local pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  local ok=""
  # E1 (b11960): the first start of a freshly built Metal binary compiles its
  # embedded shader libraries (measured 9.3 s on an M5 Pro, "loaded 36
  # libraries ... in 9.314 sec"; later starts come out of the system's shader
  # cache in 0.3 s). The 9 s this loop used to allow is exactly that first
  # start, so it waits up to 60 s now.
  # BUILD_LLAMA_CHECK_TRIES only for build-llama-script.test.ts.
  for _ in $(seq 1 "${BUILD_LLAMA_CHECK_TRIES:-200}"); do
    if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.3
  done
  kill "$pid" 2>/dev/null || true
  trap - EXIT
  [ -n "$ok" ] || die "health endpoint never came up"
  log "OK — llama-server boots and answers /health"
}

main() {
  if [ "${1:-}" = "--check" ]; then check_binary; exit 0; fi
  local targets=("$@")
  if [ "${#targets[@]}" -eq 0 ]; then targets=("$(host_triple)"); fi
  # Fail fast, exactly as before: a build without cmake aborts here, before the
  # clone/fetch, instead of after it. build_triple re-checks for any other
  # caller — this line is about the ordering, not about the guarantee.
  require_cmake
  ensure_src
  for t in "${targets[@]}"; do build_triple "$t"; done
  log "done: ${targets[*]}"
}

# Only run when executed directly, so tests can source the pure functions.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
