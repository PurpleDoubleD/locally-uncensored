// BL1 (review-waechter-windows.md): scripts/build-llama.sh's Windows MSVC
// linker-map flag must be spelled "-MAP", not "/MAP". Measured on the real
// box: MSYS/Git-Bash rewrites an argv entry that looks like a Unix absolute
// path ("/MAP") into a native Windows path before the (unquoted) cmake
// invocation ever sees it, so the old spelling never produced a .map file
// at all, and verify-sidecar-isa.sh's Windows guard died with "no .map file
// found" the very first time this script's committed form actually ran.
// This test cannot reproduce the MSYS argv rewriting itself (that only
// happens on a real Windows Git-Bash), so it checks the one thing runnable
// everywhere: the flag scripts/build-llama.sh actually emits. The real
// proof that the fix holds is a real Windows rebuild, see
// lu-301/bau/waechter-windows.md "Runde 2".
//
// Run with: node --test scripts/build-llama-flags.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'build-llama.sh');

function cmakeFlagsFor(triple) {
  // Source the script (never runs main(), see build-llama.sh's own
  // `[ "${BASH_SOURCE[0]}" = "${0}" ]` guard: under `bash -c "source ..."`,
  // BASH_SOURCE[0] is the sourced file but $0 stays "bash", so they never
  // match) purely to reach the pure `cmake_flags_for` function.
  return execFileSync('bash', ['-c', `source "${SCRIPT}"; cmake_flags_for "${triple}"`], {
    encoding: 'utf8',
  }).trim();
}

test('BL1: the Windows MSVC linker-map flags use -MAP, not /MAP', () => {
  const flags = cmakeFlagsFor('x86_64-pc-windows-msvc');
  assert.match(
    flags,
    /-DCMAKE_SHARED_LINKER_FLAGS=-MAP\b/,
    'a leading slash ("/MAP") is a Unix absolute path as far as MSYS/Git-Bash argv rewriting is concerned and is silently turned into a native filesystem path before cmake/link.exe ever sees it (measured on the box: "/MAP" becomes "C:/Program Files/Git/MAP"), so the linker never receives the flag and produces no .map file at all',
  );
  assert.match(flags, /-DCMAKE_EXE_LINKER_FLAGS=-MAP\b/);
});

test('BL1 (real box rebuild finding): CMAKE_MODULE_LINKER_FLAGS also carries -MAP, not just SHARED/EXE', () => {
  // ggml/src/CMakeLists.txt adds every GGML_BACKEND_DL backend
  // (ggml-cpu-*.dll, ggml-vulkan.dll, exactly the files this guard cares
  // about most) as a CMake MODULE library, which MSVC links with
  // CMAKE_MODULE_LINKER_FLAGS, not CMAKE_SHARED_LINKER_FLAGS. A real sidecar
  // rebuild on the box with only the SHARED/EXE flags set produced .map
  // files for ggml.dll/ggml-base.dll/llama*.dll/mtmd.dll/the exe but NOT ONE
  // for any ggml-cpu-*.dll or ggml-vulkan.dll.
  const flags = cmakeFlagsFor('x86_64-pc-windows-msvc');
  assert.match(flags, /-DCMAKE_MODULE_LINKER_FLAGS=-MAP\b/);
});

test('BL1: no leading-slash /MAP survives anywhere in the Windows linker flags', () => {
  const flags = cmakeFlagsFor('x86_64-pc-windows-msvc');
  assert.doesNotMatch(flags, /LINKER_FLAGS=\/MAP\b/, 'BL1 would recur if either linker-flags variable used the leading-slash spelling again');
});

test('mac and Linux cmake flags are untouched by the Windows -MAP fix', () => {
  assert.doesNotMatch(cmakeFlagsFor('aarch64-apple-darwin'), /MAP/);
  assert.doesNotMatch(cmakeFlagsFor('x86_64-apple-darwin'), /MAP/);
  assert.doesNotMatch(cmakeFlagsFor('x86_64-unknown-linux-gnu'), /MAP/);
});

// E1 (3.0.9): the vector tool comes out of the server build on every
// platform. Upstream defines its target only without GGML_BACKEND_DL; LU's
// patch 0002 lifts that, so on Windows/Linux it loads the same CPU variants
// and Vulkan as the server. The static CPU-only baseline build it had there
// before (FEHLER-P11 #8) made Neurons take hours on 9B models.
function sourced(call) {
  return execFileSync('bash', ['-c', `source "${SCRIPT}"; ${call}`], { encoding: 'utf8' }).trim();
}

for (const triple of ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu', 'aarch64-apple-darwin']) {
  test(`E1: ${triple} builds the vector tool in the server build`, () => {
    assert.equal(sourced(`cvector_ships_for ${triple} && echo yes || echo no`), 'yes');
    assert.equal(sourced(`cvector_build_dir_for ${triple}`), sourced(`echo "$CACHE_DIR/build-${triple}"`), 'the server build directory');
    assert.equal(sourced(`type cvector_cmake_flags_for >/dev/null 2>&1 && echo yes || echo no`), 'no', 'no separate baseline build');
  });
}

test('E1: the Windows/Linux server build the tool comes from is the K1 one', () => {
  for (const triple of ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
    assert.match(cmakeFlagsFor(triple), /-DGGML_BACKEND_DL=ON\b/);
    assert.match(cmakeFlagsFor(triple), /-DGGML_CPU_ALL_VARIANTS=ON\b/);
    assert.match(cmakeFlagsFor(triple), /-DGGML_VULKAN=ON\b/);
  }
});

test('E1: LU patch 0002 lets the vector tool build with GGML_BACKEND_DL', () => {
  const patch = readFileSync(new URL('./llama-patches/0002-cvector-generator-backend-dl.patch', import.meta.url), 'utf8');
  const touched = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(touched, ['tools/CMakeLists.txt', 'tools/cvector-generator/cvector-generator.cpp', 'tools/cvector-generator/mean.hpp', 'tools/cvector-generator/pca.hpp']);
  assert.match(patch, /^\+    if \(GGML_CPU\)$/m);
  assert.match(patch, /^\+        add_subdirectory\(cvector-generator\)$/m);
  // Every call into ggml-cpu goes; the registry replaces it.
  for (const gone of ['ggml_backend_cpu_init', 'ggml_backend_cpu_set_n_threads', 'ggml_get_f32_nd', 'ggml_set_f32_nd', 'ggml_get_f32_1d', 'ggml_set_f32_1d']) {
    assert.doesNotMatch(patch, new RegExp(`^\\+.*\\b${gone}\\(`, 'm'), `${gone} still called`);
  }
  assert.match(patch, /ggml_backend_init_by_type\(GGML_BACKEND_DEVICE_TYPE_CPU/);
  assert.match(patch, /ggml_backend_reg_get_proc_address\(reg, "ggml_backend_set_n_threads"\)/);
});

test('E1 #1: the Windows server build puts jump tables in .rdata too, without replacing the MSVC defaults', () => {
  const flags = cmakeFlagsFor('x86_64-pc-windows-msvc');
  assert.match(flags, /-DCMAKE_C_FLAGS_INIT=-jumptablerdata\b/);
  assert.match(flags, /-DCMAKE_CXX_FLAGS_INIT=-jumptablerdata\b/);
  assert.doesNotMatch(flags, /-DCMAKE_(C|CXX)_FLAGS=/, 'CMAKE_<LANG>_FLAGS would drop /EHsc and the other MSVC defaults');
  assert.doesNotMatch(flags, /\/jumptablerdata/, 'MSYS rewrites a leading slash into a path, as with /MAP');
  assert.match(flags, /-DCMAKE_MODULE_LINKER_FLAGS=-MAP\b/, 'the linker maps stay');
  assert.doesNotMatch(cmakeFlagsFor('x86_64-unknown-linux-gnu'), /jumptablerdata/, 'MSVC only');
  assert.doesNotMatch(cmakeFlagsFor('aarch64-apple-darwin'), /jumptablerdata/, 'MSVC only');
});
