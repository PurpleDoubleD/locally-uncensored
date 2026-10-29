#!/usr/bin/env bash
#
# verify-sidecar-isa.sh: the guard for K1 (3.0.1). Fails the build RED when
# the dynamic-ISA sidecar (scripts/build-llama.sh, Windows/Linux) is not what
# it claims to be.
#
# Two things this checks, both measured on the actual built files, not on the
# cmake command line that produced them (a wrong flag upstream, a stale
# build cache, or a future llama.cpp release changing its own defaults could
# all make the command line lie):
#
#   1. The BASELINE modules (the "x64" and "sse42" CPU variants, every named
#      base module -- ggml, ggml-base, ggml-vulkan, llama, llama-common,
#      llama-server-impl, mtmd -- and the llama-server exe itself) must
#      contain NO AVX-or-above instruction. These are the files every CPU
#      loads no matter how old, so an AVX instruction inside one of them is
#      exactly the K1 bug: a "dynamic" build that is secretly still a fixed
#      x86-64-v3 (or higher) binary. Checked by disassembling and searching
#      for ymm/zmm registers and VEX/EVEX-coded mnemonics (they are the ones
#      objdump prints with a leading "v", e.g. vmovaps, vzeroupper,
#      vfmadd231ps; no plain SSE mnemonic is spelled that way).
#   2. Every CPU-tier VARIANT module must stay at or below the ISA ceiling
#      its own tier is supposed to have (sandybridge/ivybridge/piledriver:
#      AVX at most, no AVX2, no AVX-512; haswell/alderlake: AVX2 at most, no
#      AVX-512; skylakex and above: AVX-512 is the top tier, nothing to
#      cap). The rules and the tier table live in
#      scripts/lib/isa-guard-linux-rules.sh (shared with
#      scripts/verify-sidecar-isa.selftest.sh, which proves this logic
#      against checked-in fixtures with no ELF file or objdump needed,
#      runnable on any platform). SKEPTIKER-LINUX-WEB-K1.md found the
#      earlier version of this script checked 4 of the staged modules
#      (x64, sse42, ggml-base, exe) and skipped every other base module and
#      every variant's own ceiling outright.
#   3. Every file actually staged in the companions directory must be a
#      recognised module (a known base module, a known CPU-tier variant, or
#      a SONAME-versioned sibling of one of those) -- an unrecognised module
#      turns this guard RED rather than being silently skipped (fail
#      closed).
#   4. The HASWELL variant (the first AVX2 tier) MUST contain at least one
#      AVX-or-above instruction. Without this positive control, a
#      disassembler that silently failed, or a grep pattern that never
#      matches anything, would make check 1 pass on every input, including
#      a build that produced no real code at all.
#
# Also fails RED when an expected CPU variant is simply missing from the
# companions directory (a partial build, or a future cmake refactor that
# drops a name this project still assumes).
#
# TOOLSET PIN (review-waechter-windows.md N7): the Windows branch below
# trusts a specific, hand-disassembled CRT/STL allowlist
# (msvcprt:vector_algorithms.obj and the wmemcmp/memcmp fast path, see
# win-isa-guard.mjs isAllowlisted) rather than re-deriving it from source on
# every run. That trust is pinned to a Major.Minor MSVC LINKER version
# (WINDOWS_REVIEWED_LINKER_VERSIONS below, currently "14.44 14.51":
# 14.44 is MSVC 19.44.35222.0 / VS 2022 17.14, lu-301/bau/review-k1-avx.md
# section 3; 14.51 is MSVC 19.51.36256 / VS 2026, reviewed 21.09.2026 on the
# GitHub-runner dumps in lu-301/bau/isa-review-14.51/, written up in
# lu-301/bau/isa-review-1451.md) and
# check_toolset_version turns the guard red the moment a build used a
# different one, rather than silently keep trusting an allowlist nobody
# re-checked. To clear a red toolset-pin failure: re-run the Opus-style
# manual disassembly review (dumpbin /disasm against the new toolset's
# msvcprt:vector_algorithms.obj and wmemcmp/common.obj, unicode.obj,
# ggml-backend-reg.obj, server-context.obj, the exact objects
# win-isa-guard.mjs's isAllowlisted trusts, see WMEMCMP_MEMCMP_HOST_OBJECTS
# there) to confirm the new toolset's CRT/STL fast paths are still
# self-guarded by __isa_enabled/_Avx2WmemEnabled the same way, then add the
# new linker Major.Minor to WINDOWS_REVIEWED_LINKER_VERSIONS. Realistically
# this is not a rare event: windows-latest pulls a new MSVC patch release on
# roughly a one-to-two-month cadence, so expect this pin to need bumping on
# that cadence, most visibly in a release run; it is a planned, periodic
# cost of trusting a hand-reviewed allowlist rather than a rare emergency,
# and the sidecar build cache (keyed on hashFiles('scripts/build-llama.sh'))
# only defers it, it does not remove it.
#
# DURCHSICHTSSTAND 14.51 (21.09.2026, lu-301/bau/isa-review-1451.md, dumps in
# lu-301/bau/isa-review-14.51/): the CRT/STL allowlist holds on MSVC
# 19.51.36256 / VS 2026. All 924 allowlisted VEX/EVEX hits across the nine
# base modules sit in msvcprt:vector_algorithms.obj, in 18 functions, and
# every one of them reaches its first AVX instruction only through a read of
# __isa_enabled plus a conditional jump over the block, either in its own
# body or, for the four helper families _Find_end_cmpeq, _Search_cmpeq,
# _Impl_first_avx and _Impl_last_avx, in the dispatching caller. This
# toolset produced no wmemcmp/memcmp hit at all, so the
# WMEMCMP_MEMCMP_HOST_OBJECTS half of the allowlist was not exercised by
# 14.51 and stays trusted on the 14.44 review alone. The one new finding,
# two vpmullq in llama.dll's llama-kv-cache.obj, was a false red of known
# form (i) and was closed in win-isa-guard.mjs's checkDominance, not
# allowlisted away.
#
# Usage: scripts/verify-sidecar-isa.sh <triple>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/build-llama.sh"

vlog()  { printf '\033[1;36m[verify-sidecar-isa]\033[0m %s\n' "$*"; }
vdie()  { printf '\033[1;31m[verify-sidecar-isa] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

TRIPLE="${1:?usage: verify-sidecar-isa.sh <triple>}"

if ! is_dynamic_isa_triple "$TRIPLE"; then
  vlog "$TRIPLE is a static build (Metal), nothing to verify here"
  exit 0
fi

# The CPU-variant names this project's PINNED llama.cpp checkout is known to
# produce with GGML_CPU_ALL_VARIANTS=ON, per compiler family. Not a guess:
# read straight off a live `cmake -S/-B` configure against LLAMA_COMMIT
# (see build-llama.sh) and off ggml/src/CMakeLists.txt's own
# `ggml_add_cpu_backend_variant` calls (the "if (NOT MSVC)" branches are
# exactly the four names MSVC lacks). A future pin bump that changes this
# list is expected to update this array in the same commit, the same way
# LLAMA_TAG/LLAMA_COMMIT themselves are a deliberate, reviewed pin rather
# than "whatever upstream has today".
case "$TRIPLE" in
  *-windows-*)
    EXPECTED_VARIANTS=(x64 sse42 sandybridge haswell skylakex cannonlake cascadelake icelake alderlake)
    LIB_EXT="dll"
    LIB_PREFIX=""
    ;;
  *)
    EXPECTED_VARIANTS=(x64 sse42 sandybridge ivybridge piledriver haswell skylakex cannonlake cascadelake icelake cooperlake zen4 alderlake sapphirerapids)
    LIB_EXT="so"
    LIB_PREFIX="lib"
    ;;
esac

COMPANIONS_DIR="$(resource_llama_dir_for "$TRIPLE")"
[ -d "$COMPANIONS_DIR" ] || vdie "no companion directory at $COMPANIONS_DIR, build first (scripts/build-llama.sh $TRIPLE)"

# BLOCKER B5 (review-sidecar.md, Runde 2): this must match EXACTLY the
# filename ggml itself opens, not merely a file that contains the right
# substring. Read at the pin (ggml-backend-reg.cpp:472-520,
# ggml_backend_load_best):
#   - CPU variants are found by a SCAN: every regular file in the search
#     directory is a candidate if `filename.find(file_prefix) == 0` (the
#     name starts with "[lib]ggml-cpu-") AND `entry.path().extension() ==
#     file_extension` (the extension is EXACTLY ".so"/".dll", not ".so.0").
#     A versioned SONAME copy like "libggml-cpu-x64.so.0" has extension
#     ".0", so ggml never even considers it: the loader would see NO CPU
#     backend at all and the app would die on the first model load, while a
#     guard that matches "*ggml-cpu-x64.so*" (Runde 2's version) stays
#     green.
#   - "vulkan" (and any other backend without per-CPU variants) is NOT
#     found by that scan at all: "libggml-vulkan.so" does not start with
#     "libggml-vulkan-" (the scan prefix always has a trailing hyphen
#     because it is built for "<name>-<variant>" files). It is only found
#     through the FALLBACK branch a few lines down, which requires the
#     single EXACT filename "[lib]ggml-vulkan.<ext>" to exist verbatim in
#     one of the two search paths.
# So the guard's own filename check must be exact-match, not substring: the
# only wildcard-worthy part is the "lib" prefix, and that is not even a
# wildcard, it is a fixed, platform-determined string
# (ggml/CMakeLists.txt:79-83 strips it only "if (WIN32)", so it is "lib" on
# every other platform, never optional or ambiguous).
#
# Both helpers below end in an explicit `return 0`, not just the bare `[ -f
# ... ] && printf ...` their body used to be: under `set -e` (this whole
# script runs with it) a simple command whose last action is a failed `[ -f
# ]` test aborts the ENTIRE SCRIPT right there, silently, the moment
# `f="$(find_variant_file "$variant")"` captures its output, because a
# failing command substitution assigned to a variable is not exempt from
# `set -e`. "no file found" here is an expected, ordinary outcome (the
# caller collects it into `missing[]` and reports it properly), not an
# error the shell should treat as fatal. Found the hard way: the very
# first real end-to-end run of this rewrite (a missing variant) exited
# with status 1 and NO message at all, instead of the intended "expected
# CPU variant(s) missing: ..." from vdie.
find_variant_file() {
  local variant="$1"
  local exact="$COMPANIONS_DIR/${LIB_PREFIX}ggml-cpu-${variant}.${LIB_EXT}"
  if [ -f "$exact" ]; then
    printf '%s\n' "$exact"
  fi
  return 0
}

# Same exact-match rule for every other named companion module
# (ggml-base, ggml-vulkan, ...), so every lookup in this script goes
# through one of these two helpers rather than re-typing the pattern.
find_named_module() {
  local name="$1"
  local exact="$COMPANIONS_DIR/${LIB_PREFIX}${name}.${LIB_EXT}"
  if [ -f "$exact" ]; then
    printf '%s\n' "$exact"
  fi
  return 0
}

missing=()
for variant in "${EXPECTED_VARIANTS[@]}"; do
  f="$(find_variant_file "$variant")"
  if [ -z "$f" ]; then
    missing+=("$variant")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  vdie "expected CPU variant(s) missing from $COMPANIONS_DIR: ${missing[*]}"
fi
vlog "all ${#EXPECTED_VARIANTS[@]} expected CPU variants present for $TRIPLE"

f="$(find_named_module ggml-vulkan)"
[ -n "$f" ] || vdie "ggml-vulkan.$LIB_EXT missing from $COMPANIONS_DIR, the GPU backend did not build as a loadable module"
vlog "ggml-vulkan.$LIB_EXT present"

GGML_BASE_FILE="$(find_named_module ggml-base)"
[ -n "$GGML_BASE_FILE" ] || vdie "ggml-base.$LIB_EXT missing from $COMPANIONS_DIR, the shared runtime every backend links against did not build"
vlog "ggml-base.$LIB_EXT present at $GGML_BASE_FILE"

# --- RPATH/RUNPATH: no leftover build-tree path (BLOCKER B3, widened B4) --
#
# CMake writes a build-tree RPATH into linked ELF files by default, even
# with no explicit RPATH line anywhere in CMakeLists.txt
# (CMAKE_BUILD_WITH_INSTALL_RPATH defaults to OFF). That build-tree RPATH is
# very often an ABSOLUTE path into the CI runner's own build directory, a
# path that will not exist once the sidecar ships. Grepping CMakeLists.txt
# source for the literal word "RPATH" (what Runde 1 did) cannot see this:
# it is CMake's own default, not a line anyone wrote. The only way to know
# is to read what actually landed in the binary.
#
# BLOCKER B4 (review-sidecar.md, Runde 2): Runde 2 only ran this check on
# ggml-base and the exe, the two files that structurally NEVER need a
# sibling RPATH (ggml-base only needs system libraries; the exe's own
# cross-directory need is covered by LD_LIBRARY_PATH, not RPATH). The
# fourteen ggml-cpu-* variants and ggml-vulkan are exactly the files that DO
# need $ORIGIN to find libggml-base.so.N beside them, and Runde 2 never
# looked at any of them: a broken CMAKE_BUILD_RPATH_USE_ORIGIN combined
# with a missing patchelf would silently leave them all with an absolute
# build-tree RUNPATH, and this guard would stay green regardless (it would
# still report "no RPATH/RUNPATH entry" on the two files it DOES check).
# Now every staged companion is checked (see the call site below), and a
# file that is missing an RPATH/RUNPATH entry is only accepted if it also
# has no sibling dependency to resolve locally: a file that NEEDS a
# sibling .so but carries no RPATH/RUNPATH at all is exactly the silent
# failure mode this guard exists to catch.
check_no_absolute_build_rpath() {
  local file="$1"
  local dir; dir="$(dirname "$file")"
  command -v readelf >/dev/null 2>&1 \
    || vdie "readelf not found, cannot verify RPATH/RUNPATH for $file (a guard that silently skips its own check when its tool is missing is worse than no guard, N4)"
  local dyn
  dyn="$(readelf -d "$file" 2>/dev/null)" || vdie "readelf -d failed to read the dynamic section of $file"
  local tag_lines
  tag_lines="$(grep -E '\(RPATH\)|\(RUNPATH\)' <<<"$dyn" || true)"

  # A NEEDED entry whose SONAME also exists as a FILE right next to this one
  # is a same-package sibling dependency (a ggml-cpu-* module needing
  # libggml-base.so.N, say). The dynamic linker can only resolve that via
  # RPATH/RUNPATH or LD_LIBRARY_PATH, never via a plain system search path,
  # so a file with a sibling NEEDED entry MUST carry an RPATH/RUNPATH.
  # Checking "does a file with this exact SONAME exist beside me" instead
  # of hardcoding a list of library-name prefixes means this keeps working
  # if the pin ever renames, adds, or removes a shared library.
  local sibling_needed=""
  while IFS= read -r soname; do
    [ -n "$soname" ] || continue
    [ -e "$dir/$soname" ] && sibling_needed="$sibling_needed $soname"
  done < <(sed -nE 's/.*\(NEEDED\)[^]]*Shared library: \[([^]]*)\].*/\1/p' <<<"$dyn")

  if [ -z "$tag_lines" ]; then
    if [ -n "$sibling_needed" ]; then
      vdie "$file needs sibling librar$([ "$(wc -w <<<"$sibling_needed")" -eq 1 ] && echo y || echo ies) ($sibling_needed) but carries NO RPATH/RUNPATH entry at all: it cannot resolve them on its own, only via the caller's LD_LIBRARY_PATH, which the dlopen'd ggml-cpu-*/ggml-vulkan modules cannot rely on"
    fi
    vlog "$file: no RPATH/RUNPATH entry (no sibling dependency to resolve, nothing missing)"
    return 0
  fi
  # readelf prints the entry as e.g.
  # "0x000000000000001d (RUNPATH) Library runpath: [/home/runner/work/.../build/bin]"
  # An entry that starts with "/" inside the brackets is an absolute path;
  # "$ORIGIN" is the only form this project's build is supposed to emit.
  if grep -qE 'Library r(un)?path: \[/' <<<"$tag_lines"; then
    vdie "$file carries an absolute build-tree path in RPATH/RUNPATH: $tag_lines"
  fi
  vlog "$file: RPATH/RUNPATH present and not an absolute build-tree path: $tag_lines"
}

if [[ "$TRIPLE" == *-linux-* ]]; then
  for variant in "${EXPECTED_VARIANTS[@]}"; do
    variant_file="$(find_variant_file "$variant")"
    [ -n "$variant_file" ] && check_no_absolute_build_rpath "$variant_file"
  done
  vulkan_file="$(find_named_module ggml-vulkan)"
  [ -n "$vulkan_file" ] && check_no_absolute_build_rpath "$vulkan_file"
  check_no_absolute_build_rpath "$GGML_BASE_FILE"
  exe_check_path="$BIN_DIR/$(out_name_for "$TRIPLE")"
  [ -f "$exe_check_path" ] && check_no_absolute_build_rpath "$exe_check_path"
fi

# --- Windows: opcode-byte VEX/EVEX guard (review-k1-avx.md, Opus final review) --
#
# The mnemonic-based rule below ("no mnemonic starting with v") is unusable
# under MSVC: the MSVC-STL and CRT ship their own runtime-switched AVX2 fast
# paths (msvcprt:vector_algorithms.obj, wmemcmp's _Avx2WmemEnabled path)
# inside EVERY module they are statically linked into, and a plain mnemonic
# grep also flags verr/verw/vmread instructions dumpbin/objdump disassembles
# out of plain data bytes (review-k1-avx.md section "Zusatzbefund", the
# vom Orchestrator vermutete Regelfehler). Neither is the K1 bug. The
# Windows-only replacement (R1-R6 in review-k1-avx.md) lives in
# scripts/win-isa-guard.mjs: it detects VEX/EVEX by opcode byte (exact, not
# heuristic, in 64-bit code), resolves each hit's owning function from the
# linker .map (hence /MAP in cmake_flags_for, R2), and only allows a hit
# either through a named CRT/STL allowlist or through a same-function
# isa-check-then-guarding-jump dominance check (R3). The Linux path below
# this block is UNCHANGED: nm's symbol table plus objdump's mnemonic text is
# sufficient there because Linux never links this project's own gcc-built
# ggml/llama.cpp code against a runtime-dispatched CRT algorithm library the
# way MSVC does.
if [[ "$TRIPLE" == *-windows-* ]]; then

  # R5: MSYS2_ARG_CONV_EXCL fixed in the disassembler function, not left to
  # whatever the caller's environment happens to have. Without it MSYS bash
  # rewrites "/disasm" etc. into a bogus Windows path before dumpbin ever
  # sees it (review-k1-avx.md footnote; 04-BOX-SIDECAR-AVX-BEFUND.md hit the
  # sibling case with an env VALUE, this is the same class of bug for an
  # argv entry).
  DUMPBIN_ARG_EXCL='/disasm;/nologo;/headers;/imports;/exports;/MAP'

  # dumpbin is not on PATH on a plain shell (neither this repo's CI runner
  # nor an un-elevated box shell): it lives under a versioned VC\Tools\MSVC
  # directory that only a Developer Command Prompt (vcvars) or an explicit
  # path adds. Locate it directly with vswhere (shipped with every VS
  # Installer, including on GitHub's windows-latest image) rather than
  # requiring every caller to have already run vcvars.
  find_dumpbin() {
    if command -v dumpbin >/dev/null 2>&1; then
      command -v dumpbin
      return 0
    fi
    local vswhere=""
    if [ -x "/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe" ]; then
      vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
    elif command -v vswhere.exe >/dev/null 2>&1; then
      vswhere="$(command -v vswhere.exe)"
    fi
    [ -n "$vswhere" ] || return 1
    local vsroot
    vsroot="$("$vswhere" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>/dev/null | tr -d '\r')"
    [ -n "$vsroot" ] || return 1
    # vswhere prints a native Windows path (backslashes, "C:\..."); bash's
    # own path operations (find, globs) need the MSYS form.
    local vsroot_unix
    vsroot_unix="$(printf '%s' "$vsroot" | sed -E 's#\\#/#g; s#^([A-Za-z]):#/\L\1#')"
    # Real depth below .../VC/Tools/MSVC is 5 (<version>/bin/Hostx64/x64/
    # dumpbin.exe), measured on the box, not guessed; -maxdepth 4 silently
    # found nothing there and made this whole helper return empty.
    find "$vsroot_unix/VC/Tools/MSVC" -maxdepth 6 -type f -iname 'dumpbin.exe' -path '*Hostx64*x64*' 2>/dev/null | sort -V | tail -1
  }

  DUMPBIN="$(find_dumpbin || true)"
  [ -n "$DUMPBIN" ] && [ -x "$DUMPBIN" ] \
    || vdie "dumpbin.exe not found (checked PATH and vswhere's VC.Tools.x86.x64 workload); the Windows ISA guard needs the exact MSVC toolset dumpbin from review-k1-avx.md, install the VS Build Tools C++ workload, or run this from a Developer Command Prompt"
  vlog "using dumpbin at $DUMPBIN"

  dumpbin_run() {
    MSYS2_ARG_CONV_EXCL="$DUMPBIN_ARG_EXCL" "$DUMPBIN" "$@"
  }

  # R5 continued: no `2>/dev/null` here, a dumpbin invocation that fails
  # must turn the guard red with the real error, not silently hand the rest
  # of the script an empty string that then vacuously "passes".
  disassemble_windows() {
    local file="$1"
    dumpbin_run /nologo /disasm "$file"
  }

  # Toolset/linker version pin (R3, "Bewertung der Regel, ehrlich"): the
  # CRT/STL allowlist trusts specific, hand-verified object files
  # (msvcprt:vector_algorithms.obj, wmemcmp). A future MSVC toolset could in
  # principle ship an unguarded fast path in the same object and this guard
  # would not notice, so pin the toolset that was actually reviewed and go
  # red, with a concrete next step, the moment the build uses a different one.
  WINDOWS_REVIEWED_LINKER_VERSIONS="14.44 14.51"
  check_toolset_version() {
    local file="$1" hdr ver
    hdr="$(dumpbin_run /nologo /headers "$file")" || vdie "dumpbin /headers failed on $file"
    ver="$(grep -m1 -i 'linker version' <<<"$hdr" | grep -oE '[0-9]+\.[0-9]+' | head -1)"
    [ -n "$ver" ] || vdie "could not read a linker version out of dumpbin /headers on $file"
    case " $WINDOWS_REVIEWED_LINKER_VERSIONS " in
      *" $ver "*)
        vlog "$file: linker version $ver matches one of the reviewed MSVC toolsets (14.44 = 19.44.35222.0, VS 2022 17.14, lu-301/bau/review-k1-avx.md; 14.51 = 19.51.36256, VS 2026, lu-301/bau/isa-review-1451.md)" ;;
      *)
        vdie "$file: linker version is $ver, not one of the reviewed toolsets ($WINDOWS_REVIEWED_LINKER_VERSIONS; 14.44 = MSVC 19.44.35222.0 / VS 2022 17.14, lu-301/bau/review-k1-avx.md section 3, 14.51 = MSVC 19.51.36256 / VS 2026, lu-301/bau/isa-review-1451.md). A new toolset can change whether vector_algorithms.obj/wmemcmp still self-guard the way the CRT/STL allowlist assumes: re-run the Opus-style disassembly review against the new toolset before trusting it, then add its linker version to WINDOWS_REVIEWED_LINKER_VERSIONS here" ;;
    esac
  }

  # R6: every module every CPU tier loads, not just the four the old rule
  # checked. The higher CPU-tier variants (haswell and above) are explicitly
  # EXEMPT here: they are allowed, by design, to contain unconditional AVX,
  # that is the whole point of shipping more than one ggml-cpu-*.dll.
  #
  # N5 (review-waechter-windows.md): the exclusion list used to be a SECOND,
  # independently hand-written copy of the high-tier variant names, free to
  # drift away from EXPECTED_VARIANTS above (a future MSVC/llama.cpp adding
  # e.g. a "zen4" or "sapphirerapids" MSVC variant would fall into neither
  # list and get treated, wrongly, as a must-be-protected baseline module).
  # Derived from EXPECTED_VARIANTS instead, so there is exactly one place
  # that names the CPU-tier ladder.
  windows_high_tier_variants() {
    local v
    for v in "${EXPECTED_VARIANTS[@]}"; do
      case "$v" in
        x64 | sse42) continue ;;
        *) printf '%s\n' "$v" ;;
      esac
    done
  }

  # N4 (review-waechter-windows.md): every non-CPU-tier-variant module this
  # pinned llama.cpp checkout is known to produce for
  # x86_64-pc-windows-msvc, read off the real box build
  # (lu-301/bau/waechter-windows.md's beweis run). This is deliberately NOT
  # "whatever the glob happens to find today": the module-count check below
  # fails RED, with a message asking a human to classify it, both when a
  # module in this list goes missing and when the companions directory
  # contains a Windows .dll that is neither in this list nor one of the
  # excluded high-CPU-tier variants: an unclassified module could just as
  # easily be a brand-new unconditional-AVX CPU tier (which MUST be
  # excluded) as an ordinary new base module (which MUST be
  # dominance-checked), and guessing either way defeats the point of this
  # guard.
  EXPECTED_BASE_WINDOWS_MODULES=(
    ggml.dll ggml-base.dll ggml-cpu-sse42.dll ggml-cpu-x64.dll ggml-vulkan.dll
    llama.dll llama-common.dll llama-server-impl.dll mtmd.dll
  )

  list_windows_modules_to_check() {
    local f base excluded v
    for f in "$COMPANIONS_DIR"/*.dll; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"
      excluded=""
      while IFS= read -r v; do
        [ -n "$v" ] || continue
        if [ "$base" = "ggml-cpu-${v}.dll" ]; then
          excluded=1
          break
        fi
      done < <(windows_high_tier_variants)
      [ -n "$excluded" ] && continue
      printf '%s\n' "$f"
    done
  }

  # R2: the .map CMAKE_*_LINKER_FLAGS=/MAP wrote lands in the build tree next
  # to the DLL/exe cmake actually produced, not in the staged
  # resources/companions directory (that directory only gets the files
  # build-llama.sh's staging step copies out). The map's own basename always
  # matches the module's basename without its extension; the exe is the one
  # exception, its cmake TARGET is "llama-server" (build_triple's
  # `--target llama-server`), not the renamed lu-llama-server-<triple> this
  # script ships.
  # Overridable only so this guard can be run against maps that were already
  # copied out somewhere else (a proof run against a build this script did
  # not itself produce, verifying a companions dir it only has read access
  # to) without needing a real $CACHE_DIR/build-<triple> tree alongside it.
  # A real invocation always uses the derived default.
  WIN_BUILD_DIR="${WIN_MAP_DIR_OVERRIDE:-$CACHE_DIR/build-$TRIPLE}"
  # N3 (review-waechter-windows.md): this used to fall back to
  # llama-server.map for ANY stem whose own exact map was missing, not just
  # for the exe. That is not a harmless convenience: a module checked
  # against the WRONG map either resolves every hit to garbage
  # `fn=$R000000 obj=*` names (still red, but for an unrelated, confusing
  # reason) or, worse, a module with genuinely NO VEX/EVEX hits of its own
  # can pass vacuously against a map that was never its own. There is no
  # legitimate case left for a fallback: the exe's own call site below
  # already asks for stem "llama-server" directly, which this exact-match
  # lookup already serves without any special-casing. A missing map for any
  # module, exe included, must be a hard failure naming that exact module,
  # not a silent substitution.
  find_map_for() {
    local stem="$1"
    find "$WIN_BUILD_DIR" -type f -iname "${stem}.map" -print -quit 2>/dev/null
  }

  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || vdie "node not found; scripts/win-isa-guard.mjs (the Windows VEX/EVEX-by-opcode-byte + .map ownership check, review-k1-avx.md R1-R3) needs it, and both this project's CI runners and the box already have it"

  WIN_GUARD="$SCRIPT_DIR/win-isa-guard.mjs"
  [ -f "$WIN_GUARD" ] || vdie "$WIN_GUARD missing"

  # N4: gather the set of base modules this run is ABOUT to check before
  # running a single dumpbin invocation, so a drift between what is on disk
  # and EXPECTED_BASE_WINDOWS_MODULES is reported as one clear message
  # instead of an empty pass or a confusing per-file failure.
  checked_base_modules=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    checked_base_modules+=("$(basename "$f")")
  done < <(list_windows_modules_to_check)

  for base in "${checked_base_modules[@]}"; do
    known=""
    for expected in "${EXPECTED_BASE_WINDOWS_MODULES[@]}"; do
      if [ "$base" = "$expected" ]; then known=1; break; fi
    done
    [ -n "$known" ] || vdie "unexpected Windows module '$base' found in $COMPANIONS_DIR: it is neither a known base module (EXPECTED_BASE_WINDOWS_MODULES in verify-sidecar-isa.sh) nor one of the excluded high-CPU-tier variants (EXPECTED_VARIANTS minus x64/sse42, see windows_high_tier_variants). Classify it before this guard can trust it: add it to EXPECTED_BASE_WINDOWS_MODULES if it is a new base module that must be dominance-checked like the rest of own code, or to EXPECTED_VARIANTS if it is a new higher CPU tier that is allowed unconditional AVX by design"
  done
  for expected in "${EXPECTED_BASE_WINDOWS_MODULES[@]}"; do
    found=""
    for base in "${checked_base_modules[@]}"; do
      if [ "$base" = "$expected" ]; then found=1; break; fi
    done
    [ -n "$found" ] || vdie "expected base Windows module '$expected' (EXPECTED_BASE_WINDOWS_MODULES) not found in $COMPANIONS_DIR, or it was wrongly excluded as a high-CPU-tier variant; build first, or fix windows_high_tier_variants/EXPECTED_VARIANTS if it now overlaps"
  done
  [ "${#checked_base_modules[@]}" -eq "${#EXPECTED_BASE_WINDOWS_MODULES[@]}" ] \
    || vdie "checked ${#checked_base_modules[@]} Windows module(s) but expected exactly ${#EXPECTED_BASE_WINDOWS_MODULES[@]} (${EXPECTED_BASE_WINDOWS_MODULES[*]}); list_windows_modules_to_check's glob may have run empty or duplicated a name, which would otherwise pass this guard vacuously green"
  vlog "module coverage: ${#checked_base_modules[@]} base module(s) match EXPECTED_BASE_WINDOWS_MODULES exactly"

  win_fail_count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base="$(basename "$f")"
    stem="${base%.dll}"
    map_file="$(find_map_for "$stem")"
    if [ -z "$map_file" ]; then
      vdie "no .map file found for $f under $WIN_BUILD_DIR (stem '$stem'), -MAP did not produce one, or the build cache is stale; rebuild with scripts/build-llama.sh $TRIPLE first"
    fi
    disasm_tmp="$(mktemp)"
    disassemble_windows "$f" > "$disasm_tmp"
    if ! "$NODE_BIN" "$WIN_GUARD" check --module "$base" --disasm "$disasm_tmp" --map "$map_file"; then
      win_fail_count=$((win_fail_count + 1))
    fi
    rm -f "$disasm_tmp"
  done < <(list_windows_modules_to_check)

  # exe itself, same treatment (out_name_for's stem never matches a .map
  # basename, hence the explicit stem "llama-server" below; N3 removed the
  # fallback this comment used to point at, find_map_for is exact-match only
  # now).
  exe_name="$(out_name_for "$TRIPLE")"
  exe_path="$BIN_DIR/$exe_name"
  if [ -f "$exe_path" ]; then
    map_file="$(find_map_for "llama-server")"
    if [ -z "$map_file" ]; then
      vdie "no llama-server.map found under $WIN_BUILD_DIR for $exe_path"
    fi
    disasm_tmp="$(mktemp)"
    disassemble_windows "$exe_path" > "$disasm_tmp"
    if ! "$NODE_BIN" "$WIN_GUARD" check --module "$exe_name" --disasm "$disasm_tmp" --map "$map_file"; then
      win_fail_count=$((win_fail_count + 1))
    fi
    rm -f "$disasm_tmp"
  else
    vlog "no exe found at $exe_path, skipping the exe-itself check (build first for the full check)"
  fi

  # FEHLER-P11 #8: the Neuron tweaker's vector tool is a static exe of its
  # own (build-llama.sh cvector_cmake_flags_for), so every ggml-cpu line it
  # carries is the baseline one and must hold the same rule as the server
  # exe. Its map lies in its own build directory.
  cv_path="$BIN_DIR/$(cvector_out_name_for "$TRIPLE")"
  if [ -f "$cv_path" ]; then
    cv_map="$(find "${WIN_CVEC_MAP_DIR_OVERRIDE:-$(cvector_build_dir_for "$TRIPLE")}" -type f -iname 'llama-cvector-generator.map' -print -quit 2>/dev/null)"
    [ -n "$cv_map" ] || vdie "no llama-cvector-generator.map found for $cv_path, rebuild with scripts/build-llama.sh $TRIPLE first"
    disasm_tmp="$(mktemp)"
    disassemble_windows "$cv_path" > "$disasm_tmp"
    if ! "$NODE_BIN" "$WIN_GUARD" check --module "$(basename "$cv_path")" --disasm "$disasm_tmp" --map "$cv_map"; then
      win_fail_count=$((win_fail_count + 1))
    fi
    rm -f "$disasm_tmp"
  else
    vlog "no vector tool at $cv_path, skipping its check (build first for the full check)"
  fi

  # R4, control 1/3 (positive control): independent of win-isa-guard.mjs, a
  # raw opcode-byte grep straight on dumpbin's own output. haswell is the
  # first AVX2 tier, so SOME VEX/EVEX byte pattern must show up, if it does
  # not, dumpbin itself is not disassembling this file (wrong architecture,
  # truncated output, a silently swallowed error), and every "no unprotected
  # hit" result above is unproven, not passing.
  #
  # This control already satisfies B2's "exact code, not just any nonzero"
  # principle by construction: `grep -qE` only ever exits 0 (a real match)
  # or nonzero (no match, or a grep error), there is no third "crashed for
  # an unrelated reason but still looks like the expected failure" case the
  # way a node subprocess has, so a plain `if ! grep ...; then vdie; fi` is
  # already as strict as B2 asks the negative and red-probe controls below
  # to become explicitly.
  haswell_file="$(find_variant_file haswell)"
  [ -n "$haswell_file" ] || vdie "ggml-cpu-haswell.dll not found for the positive control"
  haswell_disasm="$(disassemble_windows "$haswell_file")"
  if ! grep -qE '^[[:space:]]*[0-9A-Fa-f]{6,16}:[[:space:]]+(C4|C5|62)[[:space:]]' <<<"$haswell_disasm"; then
    vdie "$haswell_file (the haswell variant, which IS supposed to use AVX2) shows no VEX/EVEX opcode byte at all: dumpbin is not disassembling real code here, every result above is unproven"
  fi
  vlog "positive control: haswell ($haswell_file) shows VEX/EVEX opcode bytes, dumpbin is disassembling real code"

  # R4, control 2/3 (negative control): haswell's OWN ggml compute kernels
  # are unconditionally AVX2 by construction (that is the entire reason a
  # haswell-tier DLL exists), win-isa-guard.mjs's full decision logic MUST
  # therefore find at least one UNPROTECTED own-code hit in it. If it does
  # not, the allowlist or the dominance check has been loosened into "allow
  # everything", which a guard whose whole job is catching that must never
  # do quietly.
  #
  # B2 (review-waechter-windows.md): "any nonzero exit means the rule caught
  # something" and "exit 0 means correctly caught" both silently accept
  # OTHER failure modes for the wrong reason: a crash from a missing/renamed
  # fixture, a bad CLI argument, or a future win-isa-guard.mjs change can
  # exit 1 too (an uncaught readFileSync throw is exit code 1, same as a
  # deliberate "FAIL (negative control)"), and would be reported here as
  # "the rule went soft" while never having run the decision logic at all.
  # Require the EXACT expected exit code (0 for this control: found at least
  # one UNPROTECTED hit) AND the exact expected message in stdout, the same
  # principle the red-probe check below already needs.
  haswell_map="$(find_map_for ggml-cpu-haswell)"
  [ -n "$haswell_map" ] || vdie "no ggml-cpu-haswell.map found under $WIN_BUILD_DIR for the negative control"
  haswell_disasm_tmp="$(mktemp)"
  disassemble_windows "$haswell_file" > "$haswell_disasm_tmp"
  neg_out_tmp="$(mktemp)"
  neg_err_tmp="$(mktemp)"
  neg_status=0
  "$NODE_BIN" "$WIN_GUARD" check --module ggml-cpu-haswell.dll --disasm "$haswell_disasm_tmp" --map "$haswell_map" --expect-unprotected \
    >"$neg_out_tmp" 2>"$neg_err_tmp" || neg_status=$?
  rm -f "$haswell_disasm_tmp"
  if [ "$neg_status" -eq 0 ] && grep -q 'OK (negative control):' "$neg_out_tmp"; then
    vlog "negative control: ggml-cpu-haswell.dll correctly shows at least one UNPROTECTED own-code hit (the rule still catches something)"
  else
    vdie "negative control did NOT pass cleanly (exit=$neg_status, expected exit=0 with 'OK (negative control):' in stdout); this is either the allowlist/dominance rule having gone soft (review-k1-avx.md R4) or the check crashing for an unrelated reason (missing map, bad args, a win-isa-guard.mjs regression), both must be treated as red rather than guessed apart. stdout:
$(cat "$neg_out_tmp")
stderr:
$(cat "$neg_err_tmp")"
  fi
  rm -f "$neg_out_tmp" "$neg_err_tmp"

  # R4, control 3/3 (the artificial red probe): a checked-in fixture pair
  # (scripts/__fixtures__/win-isa/unprotected-own-code.*) that is an
  # own-code VEX hit with NO preceding isa-availability check anywhere in
  # its function, the shape the K1 bug actually was. This runs the
  # decision LOGIC itself, not a real file, so it catches a future change to
  # win-isa-guard.mjs that makes the rule pass vacuously even when no real
  # DLL is available to test against (a Mac dev box has none of the above
  # Windows files at all).
  #
  # BLOCKER B2 (review-waechter-windows.md): the old check accepted ANY
  # nonzero exit code as "correctly came out RED", including exit 2 (bad
  # CLI usage) or a crash from a missing/moved fixture file (an uncaught
  # readFileSync throw exits 1, same code as a deliberate FAIL), exactly
  # the class of bug that let the entry-point regression this project
  # already hit once (lu-301/bau/waechter-windows.md) go unnoticed. Require
  # the EXACT expected exit code (1) AND grep stdout for the exact expected
  # verdict text, the same way win-isa-guard.test.mjs's own spawnSync
  # regression test already does.
  RED_PROBE_DIR="$SCRIPT_DIR/__fixtures__/win-isa"
  red_out_tmp="$(mktemp)"
  red_err_tmp="$(mktemp)"
  red_status=0
  # --min-lines 0: this fixture is deliberately a handful of lines (it tests
  # the decision LOGIC, not a real disassembly), so N2's parse-count guard
  # (which exists to catch a real module silently failing to disassemble at
  # all) must not fire on it for an unrelated reason.
  "$NODE_BIN" "$WIN_GUARD" check --module "red-probe" --min-lines 0 \
      --disasm "$RED_PROBE_DIR/unprotected-own-code.disasm.txt" \
      --map "$RED_PROBE_DIR/unprotected-own-code.map.txt" \
      >"$red_out_tmp" 2>"$red_err_tmp" || red_status=$?
  if [ "$red_status" -eq 1 ] && grep -q 'UNPROTECTED' "$red_out_tmp"; then
    vlog "red probe: unprotected-own-code fixture correctly came out RED"
  else
    vdie "red probe FAILED TO GO RED as expected (exit=$red_status, expected exit=1 with 'UNPROTECTED' in stdout): scripts/__fixtures__/win-isa/unprotected-own-code.* (an own-code VEX hit with no preceding isa check at all) either was accepted by the decision logic, or the check crashed for an unrelated reason (missing fixture, bad args) instead of actually running it, both are red. stdout:
$(cat "$red_out_tmp")
stderr:
$(cat "$red_err_tmp")"
  fi
  rm -f "$red_out_tmp" "$red_err_tmp"

  # Toolset pin, checked once against the exe (present after a real build).
  if [ -f "$exe_path" ]; then
    check_toolset_version "$exe_path"
  fi

  [ "$win_fail_count" -eq 0 ] || vdie "$win_fail_count Windows module(s) failed the VEX/EVEX ownership check"

  vlog "OK: $TRIPLE sidecar, Windows opcode-byte VEX/EVEX guard passed on every loaded module, positive/negative/red-probe controls all correct"
  exit 0
fi

# --- The disassembler (Linux only from here on) -----------------------------

# AUFLAGE e (review-isalinux.md Runde 2): objdump's `-D` disassembles EVERY
# section, including .rodata/.data, and will happily print an instruction
# mnemonic for whatever data bytes happen to live there -- a false alarm
# that has nothing to do with the code this guard actually cares about.
# `-d` (used below, both for objdump and llvm-objdump) is the deliberate
# choice against that: it only disassembles sections objdump's own ELF
# section-flag reading considers executable (SHF_EXECINSTR: .text, .plt,
# .init, .fini, ...), so a constant table or string literal placed in
# .rodata is never fed to the classifier at all. That is a real, structural
# narrowing, not a guess.
#
# It does not fully retire the risk, and this guard does not pretend it
# does: a linear disassembler walking an EXECUTABLE section can still
# print a "false" instruction out of padding bytes, alignment NOPs, or an
# inlined jump/lookup table placed inside .text next to real code -- the
# exact class of finding review-k1-avx.md's "Zusatzbefund" hit on the
# Windows side (dumpbin decoded verr/verw/vmread/vmwrite/vmcall/vmfunc out
# of data bytes; win-isa-guard.mjs's fix was ownership resolution via the
# linker .map, ordinary Linux objdump output has no equivalent). This
# script's own header already explains why Linux does not need that
# specific allowlist machinery (no statically-linked, runtime-dispatched
# CRT/STL the way MSVC ships): the modules this guard checks are gcc-built
# ggml/llama.cpp code with no comparable runtime-dispatch fast path, so an
# UNCONDITIONAL AVX mnemonic anywhere in a baseline/sub-ceiling module's
# executable section is already the K1 shape, not a legitimate self-guarded
# fast path that needs dominance-checking to clear.
#
# How to tell a genuine hit from a data-byte misread if this guard ever
# does go red on a real Linux build: the FAIL diagnostic below prints the
# first 5 matching lines with their addresses. For each address, run
# `objdump -d --no-show-raw-insn "$file" | grep -B5 -A2 '^  <addr>:'` (or
# `nm -D "$file"` / `objdump -t "$file"` to find which symbol's range that
# address falls in) and read the surrounding lines: real code disassembles
# into a coherent instruction stream (a function prologue nearby, sane
# operands, a `ret`/jump that makes sense as control flow); a data-byte
# misread typically appears right after a function's actual `ret` -- inside
# padding, an alignment NOP run, or a jump table -- and the "instructions"
# immediately before/after it will themselves look like nonsense (odd
# byte-length encodings, operands that reference nothing). If in doubt,
# cross-check against the same file's .rodata contents (`objdump -s -j
# .rodata "$file"`) for the same byte pattern -- data that legitimately
# belongs in .rodata occasionally gets placed in a read-only .text-adjacent
# section by the linker, and finding the exact bytes there settles it.
#
# Every call site captures this function's stdout via `$(disassemble ...)`
# to get the disassembly text, so a diagnostic printed with plain vlog (which
# writes to stdout) would be silently swallowed INTO that captured text
# instead of ever reaching the terminal, defeating the point of logging it
# at all (found the hard way: the tool-name line never appeared, even though
# the code "ran"). log_disassembler_choice writes to stderr (>&2)
# specifically so it survives being called from inside a command
# substitution.
log_disassembler_choice() { printf '\033[1;36m[verify-sidecar-isa]\033[0m %s\n' "$*" >&2; }

# BLOCKER B1 (review-isalinux.md Runde 2): this used to run every
# disassembler with `2>/dev/null`, so a failing invocation (wrong flag,
# unreadable file, a disassembler that does not understand this ELF at all)
# printed NOTHING on stdout, the caller read that as "no AVX-or-above
# instruction found", and the whole module passed vacuously green -- the
# doctrine this very script states two lines above the old code ("a guard
# that silently skips its own check when its tool is missing is worse than
# no guard") violated by the one disassembler call that actually runs the
# check. Fixed the same way R5 already fixed the Windows half of this
# script (dumpbin, no `2>/dev/null`, see verify-sidecar-isa.sh:342-348): a
# nonzero exit is captured explicitly (never left to `set -e` abort the
# whole script silently mid-command-substitution, the same
# find_variant_file trap documented above) and turns into a vdie carrying
# the disassembler's own stderr, not a quiet pass.
DISASSEMBLER_LOGGED=""
disassemble() {
  local file="$1"
  local err_tmp; err_tmp="$(mktemp)"
  local out="" status=0 tool=""
  if command -v objdump >/dev/null 2>&1; then
    tool="objdump ($(command -v objdump))"
    [ -n "$DISASSEMBLER_LOGGED" ] || { log_disassembler_choice "disassembler: $tool"; DISASSEMBLER_LOGGED=1; }
    out="$(objdump -d "$file" 2>"$err_tmp")" || status=$?
  elif command -v llvm-objdump >/dev/null 2>&1; then
    tool="llvm-objdump ($(command -v llvm-objdump))"
    [ -n "$DISASSEMBLER_LOGGED" ] || { log_disassembler_choice "disassembler: $tool"; DISASSEMBLER_LOGGED=1; }
    out="$(llvm-objdump -d "$file" 2>"$err_tmp")" || status=$?
  elif command -v dumpbin >/dev/null 2>&1; then
    tool="dumpbin ($(command -v dumpbin))"
    [ -n "$DISASSEMBLER_LOGGED" ] || { log_disassembler_choice "disassembler: $tool"; DISASSEMBLER_LOGGED=1; }
    out="$(dumpbin /disasm "$file" 2>"$err_tmp")" || status=$?
  else
    rm -f "$err_tmp"
    vdie "no disassembler found (need objdump, llvm-objdump or dumpbin), cannot prove the ISA claims on this runner"
  fi
  if [ "$status" -ne 0 ]; then
    local err_text; err_text="$(cat "$err_tmp")"
    rm -f "$err_tmp"
    vdie "$tool failed to disassemble $file (exit $status): ${err_text:-<no stderr output>}. A failed disassembler run is not the same as 'no AVX found' and must not be read as a pass (BLOCKER B1, review-isalinux.md Runde 2)"
  fi
  rm -f "$err_tmp"
  printf '%s' "$out"
}

# has_avx_or_above and the tier-ceiling rules live in one shared file
# (scripts/lib/isa-guard-linux-rules.sh) so scripts/verify-sidecar-isa.selftest.sh
# can prove the same decision logic against checked-in fixtures on any
# platform, with no ELF file or objdump needed. See that file's own header
# for the SCOPE of what a mnemonic/register-text classifier can and cannot
# tell apart (exact for "any VEX/EVEX at all" and for AVX-512 specifically,
# a documented heuristic for AVX-only-vs-AVX2).
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/isa-guard-linux-rules.sh"

# Belt and suspenders (review-waechter-windows.md N5's lesson, applied to
# this list too): the 14-name Linux CPU-variant pin exists in exactly two
# places by necessity (EXPECTED_VARIANTS above decides what MUST exist on
# disk; LINUX_CPU_VARIANTS in the sourced lib decides each name's ISA
# ceiling) and the two must never silently drift apart -- a name added to
# one and not the other would leave that variant either unchecked for its
# ceiling or wrongly rejected as unrecognised. Compared as sets, not order.
linux_pin_a="$(printf '%s\n' "${EXPECTED_VARIANTS[@]}" | sort)"
linux_pin_b="$(printf '%s\n' "${LINUX_CPU_VARIANTS[@]}" | sort)"
[ "$linux_pin_a" = "$linux_pin_b" ] \
  || vdie "EXPECTED_VARIANTS (verify-sidecar-isa.sh) and LINUX_CPU_VARIANTS (scripts/lib/isa-guard-linux-rules.sh) have drifted apart. EXPECTED_VARIANTS: ${EXPECTED_VARIANTS[*]}. LINUX_CPU_VARIANTS: ${LINUX_CPU_VARIANTS[*]}. Update both together when the llama.cpp pin changes its variant list"

# --- SKEPTIKER-LINUX-WEB-K1.md: every staged module checked, not 4 of them --
#
# Every file actually staged in COMPANIONS_DIR must be accounted for: a
# known base module (EXPECTED_BASE_LINUX_MODULES), a known CPU-tier variant
# (LINUX_CPU_VARIANTS, with its own tier's ceiling), or a SONAME-versioned
# sibling of one of those (cp without -P/-d in stage_dynamic_isa_companions
# turns every hop of a libFoo.so -> libFoo.so.N -> libFoo.so.N.n.n symlink
# chain into its own real file with identical bytes, see the "extension .0"
# comment above find_variant_file). Anything else is an unclassified module
# and turns this guard RED instead of being silently skipped -- the exact
# gap the skeptic found (4 of 16 modules checked, and the 12 unchecked ones
# carried 24-98 VEX hits on the Windows side of this same regression).
staged_files=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  staged_files+=("$(basename "$f")")
done < <(find "$COMPANIONS_DIR" -maxdepth 1 -type f -iname '*.so*' | sort)

declare -A module_role=()   # full path -> baseline|avx-only|avx2|avx512
declare -A module_label=()  # full path -> human label for messages
unclassified=()
found_base_names=()
for base in "${staged_files[@]}"; do
  cls="$(classify_linux_module "$base" "$LIB_PREFIX" "$LIB_EXT" || true)"
  case "$cls" in
    base:*)
      name="${cls#base:}"
      module_role["$COMPANIONS_DIR/$base"]="baseline"
      module_label["$COMPANIONS_DIR/$base"]="$name"
      found_base_names+=("$name")
      ;;
    variant:*)
      rest="${cls#variant:}"
      name="${rest%%:*}"
      tier="${rest#*:}"
      module_role["$COMPANIONS_DIR/$base"]="$tier"
      module_label["$COMPANIONS_DIR/$base"]="ggml-cpu-$name"
      ;;
    sibling:*)
      # BLOCKER B2, second half (review-isalinux.md Runde 2): a filename
      # that LOOKS like a SONAME sibling is not proof it IS one. Measure
      # it: the sibling must be byte-identical (cmp -s) to the canonical
      # file this guard is about to disassemble under its own name. A
      # sibling whose canonical file never got staged, or whose bytes
      # differ, is exactly the case this guard exists to catch (a crafted
      # or corrupted "sibling" that ggml's loader would happily dlopen)
      # and must be treated the same as any other unrecognised module, not
      # silently trusted on filename alone.
      canonical="${cls#sibling:}"
      canonical_path="$COMPANIONS_DIR/$canonical"
      sibling_path="$COMPANIONS_DIR/$base"
      if [ ! -e "$canonical_path" ]; then
        unclassified+=("$base (claims to be a SONAME sibling of $canonical, but $canonical is not staged in $COMPANIONS_DIR, cannot verify identical bytes)")
      elif verify_sibling_identical_bytes "$sibling_path" "$canonical_path"; then
        vlog "$base: SONAME sibling of $canonical, bytes verified identical (cmp -s), not disassembled again"
      else
        unclassified+=("$base (claims to be a SONAME sibling of $canonical but its bytes DIFFER, cmp -s failed; refusing to trust an unverified sibling)")
      fi
      ;;
    *)
      unclassified+=("$base")
      ;;
  esac
done
if [ "${#unclassified[@]}" -gt 0 ]; then
  vdie "unrecognised module(s) staged in $COMPANIONS_DIR: ${unclassified[*]}. Neither a known base module (EXPECTED_BASE_LINUX_MODULES in scripts/lib/isa-guard-linux-rules.sh) nor a known CPU-tier variant (EXPECTED_VARIANTS) nor a byte-verified SONAME sibling of one. Classify it before this guard can trust it: add it to EXPECTED_BASE_LINUX_MODULES if it is a new base module that must stay ISA-neutral like the rest of own code, or to the appropriate tier array if it is a new CPU-tier variant"
fi

# BLOCKER A2 (review-isalinux.md Runde 2): the classification loop above
# only proves every STAGED file is recognised; it says nothing about a
# module that is simply ABSENT (an absent file classifies nothing, so it
# never reaches the loop at all). check_base_module_coverage closes that,
# the Linux equivalent of the Windows branch's checked_base_modules
# presence-and-count check above.
found_base_csv="$(printf '%s\n' "${found_base_names[@]}")"
if verdict="$(check_base_module_coverage "$found_base_csv")"; then
  vlog "$verdict"
else
  vdie "$verdict"
fi

fail_count=0
for path in "${!module_role[@]}"; do
  role="${module_role[$path]}"
  label="${module_label[$path]} ($path)"
  asm="$(disassemble "$path")"
  # BLOCKER B1 (review-isalinux.md Runde 2): an empty or near-empty
  # disassembly must fail its OWN check before it ever reaches
  # evaluate_module_asm, not read as "no AVX found, so it passes". See
  # check_min_disasm_lines's own header, and N1 (Nachreview Runde 2), for
  # why 200 and not a tighter or looser bound.
  if lines_verdict="$(check_min_disasm_lines "$asm" "$label")"; then
    vlog "$lines_verdict"
  else
    printf '\033[1;31m[verify-sidecar-isa] FAIL:\033[0m %s\n' "$lines_verdict" >&2
    fail_count=$((fail_count + 1))
    continue
  fi
  if verdict="$(evaluate_module_asm "$role" "$asm" "$label")"; then
    vlog "$verdict"
  else
    printf '\033[1;31m[verify-sidecar-isa] FAIL:\033[0m %s\n' "$verdict" >&2
    grep -E '%[xyz]mm[0-9]+|%k[0-7]\b|[[:space:]]v[a-z0-9]{2,}([[:space:]]|$)|[[:space:]]k[a-z]{2,}([[:space:]]|$)' <<<"$asm" | head -5 >&2 || true
    fail_count=$((fail_count + 1))
  fi
done

exe_name="$(out_name_for "$TRIPLE")"
exe_path="$BIN_DIR/$exe_name"
if [ -f "$exe_path" ]; then
  asm="$(disassemble "$exe_path")"
  exe_label="$exe_name ($exe_path)"
  if lines_verdict="$(check_min_disasm_lines "$asm" "$exe_label")"; then
    vlog "$lines_verdict"
    if verdict="$(evaluate_module_asm baseline "$asm" "$exe_label")"; then
      vlog "$verdict"
    else
      printf '\033[1;31m[verify-sidecar-isa] FAIL:\033[0m %s\n' "$verdict" >&2
      grep -E '%[xyz]mm[0-9]+|%k[0-7]\b|[[:space:]]v[a-z0-9]{2,}([[:space:]]|$)|[[:space:]]k[a-z]{2,}([[:space:]]|$)' <<<"$asm" | head -5 >&2 || true
      fail_count=$((fail_count + 1))
    fi
  else
    printf '\033[1;31m[verify-sidecar-isa] FAIL:\033[0m %s\n' "$lines_verdict" >&2
    fail_count=$((fail_count + 1))
  fi
else
  vlog "no exe found at $exe_path, skipping the exe-itself check (build first for the full check)"
fi

# FEHLER-P11 #8: the vector tool, a static baseline exe of its own (see the
# Windows branch above), holds the server exe's rule.
cv_path="$BIN_DIR/$(cvector_out_name_for "$TRIPLE")"
if [ -f "$cv_path" ]; then
  asm="$(disassemble "$cv_path")"
  cv_label="$(basename "$cv_path") ($cv_path)"
  if lines_verdict="$(check_min_disasm_lines "$asm" "$cv_label")" && verdict="$(evaluate_module_asm baseline "$asm" "$cv_label")"; then
    vlog "$verdict"
  else
    printf '\033[1;31m[verify-sidecar-isa] FAIL:\033[0m %s\n' "${verdict:-$lines_verdict}" >&2
    grep -E '%[xyz]mm[0-9]+|%k[0-7]\b|[[:space:]]v[a-z0-9]{2,}([[:space:]]|$)|[[:space:]]k[a-z]{2,}([[:space:]]|$)' <<<"$asm" | head -5 >&2 || true
    fail_count=$((fail_count + 1))
  fi
else
  vlog "no vector tool at $cv_path, skipping its check (build first for the full check)"
fi

# Positive control: without this, a broken disassembler invocation (a typo'd
# flag, a tool that silently prints nothing) would make every check above
# pass vacuously. haswell is the first tier with AVX2, so it MUST show up.
f="$(find_variant_file haswell)"
asm="$(disassemble "$f")"
if ! has_avx_or_above "$asm"; then
  vdie "$f (the haswell variant, which IS supposed to use AVX2) shows no AVX instruction at all, the disassembler step itself is not working, every 'no AVX found'/'ceiling respected' result above is unproven"
fi
vlog "haswell ($f): AVX-or-above instruction found, confirming the disassembler actually sees the ISA it is looking for"

[ "$fail_count" -eq 0 ] || vdie "$fail_count module(s) failed their ISA ceiling check"

vlog "OK: $TRIPLE sidecar, dynamic ISA layout intact, baseline files carry no AVX, disassembler proven working"
