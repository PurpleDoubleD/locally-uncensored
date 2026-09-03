#!/usr/bin/env bash
#
# build-llama.sh — build the bundled llama.cpp `llama-server` sidecar for
# Locally Uncensored's built-in inference engine (P0 of the built-in-engine plan).
#
# The produced binary is statically linked with the GPU backend embedded, so a
# single self-contained file drops into `src-tauri/bin/llama-server-<triple>`
# and Tauri picks it up as an `externalBin` sidecar (target triple appended,
# code-signed with the app on macOS).
#
# Idempotent: clones/pins llama.cpp once into a build cache, reuses it on reruns.
# Binaries are NOT committed — see src-tauri/bin/.gitignore.
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
LLAMA_TAG="${LLAMA_TAG:-b9949}"
LLAMA_COMMIT="${LLAMA_COMMIT:-049326a00025d00b08cc188ed716b681e984a3f8}"
LLAMA_REPO="${LLAMA_REPO:-https://github.com/ggml-org/llama.cpp.git}"

# --- Paths -----------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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

# Map a Rust target triple → cmake flags for a static, GPU-embedded llama-server.
# LLAMA_OPENSSL=OFF: no HTTPS/downloader deps — the app manages model files.
# LLAMA_BUILD_UI/USE_PREBUILT_UI=OFF: headless sidecar — no npm build and no
# HF asset fetch at compile time.
cmake_flags_for() {
  local triple="$1"
  local common="-DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release"
  case "$triple" in
    aarch64-apple-darwin)
      echo "$common -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_ARCHITECTURES=arm64" ;;
    x86_64-apple-darwin)
      echo "$common -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_ARCHITECTURES=x86_64" ;;
    x86_64-pc-windows-msvc)
      echo "$common -DGGML_VULKAN=ON" ;;
    x86_64-unknown-linux-gnu)
      echo "$common -DGGML_VULKAN=ON" ;;
    *)
      die "unsupported target triple: $triple" ;;
  esac
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
  # Locate the produced binary (path differs by generator/platform).
  local built
  built="$(find "$build_dir" -type f \( -name 'llama-server' -o -name 'llama-server.exe' \) -print -quit)"
  [ -n "$built" ] || die "llama-server binary not found under $build_dir"
  mkdir -p "$BIN_DIR"
  local out="$BIN_DIR/$(out_name_for "$triple")"
  cp "$built" "$out"
  chmod +x "$out"
  # Record what actually got produced. A from-source build is not bit-for-bit
  # reproducible across machines, so this cannot be pinned to a constant — but
  # it puts the digest of the binary that ships, next to the source revision it
  # came from, in the release log, which is what an "which binary was that?"
  # question after the fact needs.
  local digest; digest="$(sha256_of "$out")"
  log "installed → $out  (llama.cpp $LLAMA_TAG @ ${LLAMA_COMMIT:0:12}, sha256 ${digest:-unavailable})"
}

# Boot the host binary and probe /health on an ephemeral port. Without a
# model llama-server starts in router mode (no weights loaded), so /health
# answers 200 on any machine.
check_binary() {
  local triple; triple="$(host_triple)"
  local bin="$BIN_DIR/$(out_name_for "$triple")"
  [ -x "$bin" ] || die "no built binary at $bin — build first"
  "$bin" --version >/dev/null 2>&1 || die "$bin --version failed"
  local port=8129
  log "boot check: $bin on 127.0.0.1:$port (no model — router mode, /health only)"
  "$bin" --host 127.0.0.1 --port "$port" >/dev/null 2>&1 &
  local pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  local ok=""
  for _ in $(seq 1 30); do
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
