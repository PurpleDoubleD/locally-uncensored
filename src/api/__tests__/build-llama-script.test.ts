import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { existsSync, statSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { asNumber, prop } from '../../types/json-guards'
import { bashInterpreter } from './bash-interpreter'

// P0: unit-test the pure functions of scripts/build-llama.sh by sourcing it
// (main() is guarded so sourcing does not build anything) and invoking helpers.
const SCRIPT = resolve(__dirname, '../../../scripts/build-llama.sh')
const REPO_ROOT = resolve(__dirname, '../../..')
// Not the bare name 'bash': on Windows that resolves to the WSL alias stub in
// WindowsApps and never reaches a shell. See bash-interpreter.ts.
const BASH = bashInterpreter()
// The repo's own llama.cpp patches only apply to the real pinned source; the
// fake upstreams below get none unless a test hands some in.
const NO_PATCHES = mkdtempSync(join(tmpdir(), 'lu-no-patches-'))

/** Run a snippet with the script sourced. Returns stdout+stderr, both wanted:
 *  the pin guards report through die(), which writes to stderr. */
function runScript(
  snippet: string,
  env: NodeJS.ProcessEnv = {},
): { code: number; out: string } {
  try {
    const out = execFileSync(BASH, ['-c', `source '${SCRIPT}'; ${snippet}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LLAMA_LU_PATCH_DIR: NO_PATCHES, ...env },
    })
    return { code: 0, out: out.trim() }
  } catch (err) {
    const e = err as { status?: number; stdout?: unknown; stderr?: unknown }
    return { code: e.status ?? 1, out: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}`.trim() }
  }
}

function callFn(fn: string, ...args: string[]): { code: number; out: string } {
  const argv = args.map((a) => `'${a}'`).join(' ')
  try {
    const out = execFileSync(
      BASH,
      ['-c', `source '${SCRIPT}'; ${fn} ${argv}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { code: 0, out: out.trim() }
  } catch (e) {
    // execFileSync throws an Error carrying `status` and `stdout`; both are
    // read through the boundary guards rather than off an `any`, so a throw
    // that is NOT that error reads as exit 1 with no output instead of
    // silently producing `undefined ?? 1`.
    return { code: asNumber(prop(e, 'status')) ?? 1, out: String(prop(e, 'stdout') ?? '').trim() }
  }
}

describe('build-llama.sh', () => {
  it('exists and is executable', (ctx) => {
    expect(existsSync(SCRIPT)).toBe(true)
    // owner-executable bit set - checked via the git index on Windows, where
    // NTFS has no unix mode bits (node only synthesizes X for .exe/.bat/.cmd)
    if (process.platform === 'win32') {
      // An unpacked source archive has no index either, so on Windows the bit
      // is recorded nowhere and there is nothing to read.
      if (!existsSync(join(REPO_ROOT, '.git'))) return ctx.skip()
      const mode = execFileSync('git', ['ls-files', '-s', 'scripts/build-llama.sh'], {
        cwd: resolve(__dirname, '../../..'),
        encoding: 'utf8',
      }).split(' ')[0]
      expect(mode).toBe('100755')
    } else {
      expect(statSync(SCRIPT).mode & 0o100).toBeTruthy()
    }
  })

  it('emits Metal + embedded-library flags for both mac triples', () => {
    for (const triple of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
      const { code, out } = callFn('cmake_flags_for', triple)
      expect(code).toBe(0)
      expect(out).toContain('-DGGML_METAL=ON')
      expect(out).toContain('-DGGML_METAL_EMBED_LIBRARY=ON')
      expect(out).toContain('-DBUILD_SHARED_LIBS=OFF')
    }
    expect(callFn('cmake_flags_for', 'aarch64-apple-darwin').out).toContain('arm64')
    expect(callFn('cmake_flags_for', 'x86_64-apple-darwin').out).toContain('x86_64')
  })

  it('emits Vulkan + dynamic-ISA flags for win/linux triples (K1, 3.0.1)', () => {
    // K1: a fixed x86-64-v3 binary (SSE4.2+AVX+AVX2+BMI2+FMA+F16C baked in by
    // GGML_NATIVE=OFF's INS_ENB=ON, ggml/CMakeLists.txt:141-166) crashed with
    // 0xC000001D on Windows / SIGILL on Linux on any pre-Haswell/pre-Excavator
    // CPU. GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS load the right CPU kernel
    // at runtime instead, and that combination FATAL_ERRORs in the pinned
    // llama.cpp unless BUILD_SHARED_LIBS=ON too
    // (ggml/src/CMakeLists.txt:188-190, :371-376).
    for (const triple of ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
      const { out } = callFn('cmake_flags_for', triple)
      expect(out, triple).toContain('-DGGML_VULKAN=ON')
      expect(out, triple).toContain('-DBUILD_SHARED_LIBS=ON')
      expect(out, triple).toContain('-DGGML_BACKEND_DL=ON')
      expect(out, triple).toContain('-DGGML_CPU_ALL_VARIANTS=ON')
      // Unchanged: still no -march=native, still no runner-CPU lottery.
      expect(out, triple).toContain('-DGGML_NATIVE=OFF')
    }
  })

  it('keeps mac static: no dynamic-ISA flags on either Metal triple', () => {
    for (const triple of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) {
      const { out } = callFn('cmake_flags_for', triple)
      expect(out, triple).not.toContain('GGML_BACKEND_DL')
      expect(out, triple).not.toContain('GGML_CPU_ALL_VARIANTS')
    }
  })

  it('is_dynamic_isa_triple: true only for the two win/linux triples', () => {
    expect(callFn('is_dynamic_isa_triple', 'x86_64-pc-windows-msvc').code).toBe(0)
    expect(callFn('is_dynamic_isa_triple', 'x86_64-unknown-linux-gnu').code).toBe(0)
    expect(callFn('is_dynamic_isa_triple', 'aarch64-apple-darwin').code).not.toBe(0)
    expect(callFn('is_dynamic_isa_triple', 'x86_64-apple-darwin').code).not.toBe(0)
  })

  it('resource_llama_dir_for: one directory per triple under src-tauri/resources/llama', () => {
    const { out } = callFn('resource_llama_dir_for', 'x86_64-pc-windows-msvc')
    // Git for Windows' bash prints a drive as /c/..., node as C:\...
    const printed = out.replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, (_, drive: string) => `${drive.toUpperCase()}:/`)
    expect(printed).toBe(
      `${REPO_ROOT.replace(/\\/g, '/')}/src-tauri/resources/llama/x86_64-pc-windows-msvc`,
    )
  })

  it('rejects an unsupported triple', () => {
    const { code } = callFn('cmake_flags_for', 'mips-unknown-none')
    expect(code).not.toBe(0)
  })

  it('appends .exe only for windows targets, and carries the lu- prefix', () => {
    // GitHub #120: the output name gained the app prefix because Tauri's deb
    // bundler drops every externalBin into /usr/bin, where Debian's own
    // llama.cpp-tools package already owns llama-server and dpkg refuses the
    // install. The name lives in four places (this script, tauri.conf.json,
    // engine.rs and the NSIS hooks) and they have to agree, so the expected
    // strings below are the fourth guard against one of them drifting back.
    expect(callFn('out_name_for', 'x86_64-pc-windows-msvc').out).toBe(
      'lu-llama-server-x86_64-pc-windows-msvc.exe',
    )
    expect(callFn('out_name_for', 'aarch64-apple-darwin').out).toBe(
      'lu-llama-server-aarch64-apple-darwin',
    )
  })

  it('resolves a non-empty host triple', () => {
    const { code, out } = callFn('host_triple')
    expect(code).toBe(0)
    expect(out).toMatch(/-/)
  })
})

/**
 * K1 (3.0.1): staging the ggml-cpu-* and ggml-vulkan companion libraries a
 * dynamic-ISA build produces next to llama-server. `stage_dynamic_isa_
 * companions` is unit-tested against a directory of fake .dll/.so files
 * rather than a real cmake build, the same way `ensure_src` above is tested
 * against a fake git upstream instead of the real llama.cpp, the point is
 * the shell logic, not the multi-minute compile.
 */
describe('build-llama.sh: staging the dynamic-ISA companion libraries', () => {
  const temps: string[] = []
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    temps.push(dir)
    return dir.replace(/\\/g, '/')
  }
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  })

  /** Runs `stage_dynamic_isa_companions` with REPO_ROOT redirected into a
   *  throwaway directory, so a test run never writes into the real
   *  src-tauri/resources/llama/ tree. */
  function stage(triple: string, binOutDir: string, exeOut: string) {
    const repoRoot = tmp('llama-repo-root-')
    const { code, out } = runScript(
      `stage_dynamic_isa_companions '${triple}' '${binOutDir}' '${exeOut}'`,
      { BUILD_LLAMA_REPO_ROOT: repoRoot },
    )
    return { code, out, repoRoot }
  }

  it('copies every matching .dll next to the resource dir on Windows, skipping the exe itself', () => {
    const binOutDir = tmp('llama-bin-win-')
    for (const name of ['llama-server.exe', 'ggml-cpu-x64.dll', 'ggml-cpu-haswell.dll', 'ggml-vulkan.dll', 'ggml-base.dll']) {
      writeFileSync(join(binOutDir, name), name)
    }
    const { code, repoRoot } = stage('x86_64-pc-windows-msvc', binOutDir, join(binOutDir, 'llama-server.exe'))
    expect(code).toBe(0)
    const dir = join(repoRoot, 'src-tauri', 'resources', 'llama', 'x86_64-pc-windows-msvc')
    for (const name of ['ggml-cpu-x64.dll', 'ggml-cpu-haswell.dll', 'ggml-vulkan.dll', 'ggml-base.dll']) {
      expect(existsSync(join(dir, name)), name).toBe(true)
    }
    expect(existsSync(join(dir, 'llama-server.exe'))).toBe(false)
  })

  it('copies .so files on Linux, dereferencing symlinks (SONAME needs the real versioned name)', () => {
    const binOutDir = tmp('llama-bin-linux-')
    writeFileSync(join(binOutDir, 'llama-server'), 'exe')
    writeFileSync(join(binOutDir, 'libggml-base.so.1.2.3'), 'real-bytes')
    // Through bash: Windows has no `ln` of its own. Git for Windows' `ln -s`
    // writes a copy where it may not create a link, so there the staged file
    // is checked all the same and only the dereferencing has nothing to do.
    execFileSync(BASH, ['-c', 'ln -s libggml-base.so.1.2.3 libggml-base.so.1 && ln -s libggml-base.so.1 libggml-base.so'], {
      cwd: binOutDir,
    })
    writeFileSync(join(binOutDir, 'libggml-cpu-haswell.so'), 'cpu-kernel')
    const { code, repoRoot } = stage('x86_64-unknown-linux-gnu', binOutDir, join(binOutDir, 'llama-server'))
    expect(code).toBe(0)
    const dir = join(repoRoot, 'src-tauri', 'resources', 'llama', 'x86_64-unknown-linux-gnu')
    // The exact SONAME the dynamic linker resolves DT_NEEDED against.
    expect(readFileSync(join(dir, 'libggml-base.so.1'), 'utf8')).toBe('real-bytes')
    // Dereferenced, not a dangling symlink: statSync follows by default, so
    // this also proves it is a real file (a broken symlink throws ENOENT).
    expect(statSync(join(dir, 'libggml-base.so.1')).isFile()).toBe(true)
    expect(readFileSync(join(dir, 'libggml-cpu-haswell.so'), 'utf8')).toBe('cpu-kernel')
  })

  it('is a no-op for mac triples: no directory, no error, nothing staged', () => {
    const binOutDir = tmp('llama-bin-mac-')
    writeFileSync(join(binOutDir, 'llama-server'), 'exe')
    const { code, out, repoRoot } = stage('aarch64-apple-darwin', binOutDir, join(binOutDir, 'llama-server'))
    expect(code).toBe(0)
    expect(out).toBe('')
    expect(existsSync(join(repoRoot, 'src-tauri', 'resources', 'llama'))).toBe(false)
  })

  it('refuses a dynamic-ISA build with no companion libraries next to the exe', () => {
    // Negative control for the fix itself: a plain llama-server with none of
    // its ggml-cpu-*/ggml-vulkan libraries next to it is exactly the shape a
    // broken cmake invocation (e.g. BUILD_SHARED_LIBS left OFF) would
    // produce, and it must not ship silently as a single-ISA binary again.
    const binOutDir = tmp('llama-bin-empty-')
    writeFileSync(join(binOutDir, 'llama-server.exe'), 'exe')
    const { code, out } = stage('x86_64-pc-windows-msvc', binOutDir, join(binOutDir, 'llama-server.exe'))
    expect(code).not.toBe(0)
    expect(out).toContain('produced no *.dll')
  })
})

/**
 * The sidecar pin.
 *
 * `llama-server` is compiled from upstream source, dropped into the installer
 * and code-signed with the app. Until this pin existed the build followed a
 * git TAG — a mutable pointer that upstream (or anyone who takes that repo
 * over) can move to different code without any local change, so the binary
 * users installed was in practice unpinned. The commit SHA is the pin now; the
 * tag stays as the readable name and is cross-checked against it.
 */
// These cases run real git clones, which need more than the default 5 s when the whole suite runs in parallel.
describe('build-llama.sh — the llama.cpp revision is pinned to a commit', { timeout: 30_000 }, () => {
  const temps: string[] = []
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    temps.push(dir)
    return dir.replace(/\\/g, '/')
  }
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  })

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim()

  /** A throwaway upstream with one commit and a tag on it. */
  function fakeUpstream(): { path: string; sha: string; tag: string } {
    const path = tmp('llama-upstream-')
    git(path, 'init', '-q', '-b', 'main', '.')
    writeFileSync(join(path, 'CMakeLists.txt'), 'project(fake)\n')
    git(path, 'add', '-A')
    git(path, 'commit', '-qm', 'init')
    git(path, 'tag', 'btest')
    // Local file:// transport refuses a fetch-by-SHA unless asked; the real
    // origin (GitHub) allows it, so allow it here too and exercise that path.
    git(path, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    return { path, sha: git(path, 'rev-parse', 'HEAD'), tag: 'btest' }
  }

  it('ships a full 40-hex commit SHA next to the readable tag', () => {
    const { out } = runScript('printf "%s %s" "$LLAMA_TAG" "$LLAMA_COMMIT"')
    const [tag, commit] = out.split(' ')
    expect(tag).toBeTruthy()
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses anything that is not a full commit SHA', () => {
    // Each of these would quietly hand the choice back to origin. An empty
    // LLAMA_COMMIT is assigned inside the shell, not through the environment,
    // because `${LLAMA_COMMIT:-<default>}` reads an empty env var as "no
    // override" — which is the intended reading of it.
    for (const bad of ['b9949', '049326a', '049326A00025D00B08CC188ED716B681E984A3F8', 'HEAD']) {
      const { code, out } = runScript('assert_pinned_commit', { LLAMA_COMMIT: bad })
      expect(code, `accepted LLAMA_COMMIT='${bad}'`).not.toBe(0)
      expect(out).toContain('40-char')
    }
    const empty = runScript('LLAMA_COMMIT=""; assert_pinned_commit')
    expect(empty.code).not.toBe(0)
    expect(empty.out).toContain('40-char')
  })

  it('checks out exactly the pinned commit', () => {
    const up = fakeUpstream()
    const cache = tmp('llama-cache-')
    const { code, out } = runScript('ensure_src; git -C "$SRC_DIR" rev-parse HEAD', {
      LLAMA_BUILD_CACHE: cache,
      LLAMA_REPO: up.path,
      LLAMA_TAG: up.tag,
      LLAMA_COMMIT: up.sha,
    })
    expect(code).toBe(0)
    expect(out).toContain(up.sha)
  })

  it('stops the build when the tag no longer names the pinned commit', () => {
    // The attack the pin exists for: upstream retags b9949 onto other code.
    // The fetch then brings back the wrong object and the build must refuse it
    // instead of compiling and signing it.
    const up = fakeUpstream()
    const cache = tmp('llama-cache-moved-')
    const { code, out } = runScript('ensure_src', {
      LLAMA_BUILD_CACHE: cache,
      LLAMA_REPO: up.path,
      LLAMA_TAG: up.tag,
      LLAMA_COMMIT: '0123456789012345678901234567890123456789',
    })
    expect(code).not.toBe(0)
    expect(out).toContain('expected 0123456789012345678901234567890123456789')
  })

  it('re-verifies a checkout it did not create, so a stale cache cannot slip through', () => {
    // CI restores .llama-build from a cache. A restored directory is an
    // artifact of an earlier run, not evidence about its contents.
    const up = fakeUpstream()
    const cache = tmp('llama-cache-stale-')
    const first = runScript('ensure_src', {
      LLAMA_BUILD_CACHE: cache,
      LLAMA_REPO: up.path,
      LLAMA_TAG: up.tag,
      LLAMA_COMMIT: up.sha,
    })
    expect(first.code).toBe(0)
    // Same on-disk checkout, different pin — the second run must not accept it.
    const second = runScript('ensure_src', {
      LLAMA_BUILD_CACHE: cache,
      LLAMA_REPO: up.path,
      LLAMA_TAG: up.tag,
      LLAMA_COMMIT: 'ffffffffffffffffffffffffffffffffffffffff',
    })
    expect(second.code).not.toBe(0)
    expect(second.out).toContain(`checkout is at ${up.sha}`)
  })

  it('refuses a checkout whose FILES changed under the pinned SHA', () => {
    // The gap the SHA check alone leaves: `git rev-parse HEAD` proves where
    // HEAD POINTS. cmake does not compile HEAD, it compiles the working tree —
    // and a restored CI cache is an archive produced by an earlier run, in
    // which the sources can say anything while .git/HEAD still names the pin.
    const up = fakeUpstream()
    const cache = tmp('llama-cache-tampered-')
    const env = {
      LLAMA_BUILD_CACHE: cache,
      LLAMA_REPO: up.path,
      LLAMA_TAG: up.tag,
      LLAMA_COMMIT: up.sha,
    }
    expect(runScript('ensure_src', env).code).toBe(0)

    writeFileSync(
      join(cache, 'llama.cpp', 'CMakeLists.txt'),
      'project(fake)\nadd_definitions(-DBACKDOOR)\n',
    )
    const tampered = runScript('ensure_src', env)
    expect(tampered.code, 'a modified source tree was accepted').not.toBe(0)
    expect(tampered.out).toContain('does not match')
    // HEAD is still exactly the pin, so the SHA check cannot be what caught it.
    expect(git(join(cache, 'llama.cpp'), 'rev-parse', 'HEAD')).toBe(up.sha)
  })

  it('refuses an extra file smuggled into the checkout', () => {
    // A tampered cache does not have to EDIT anything: llama.cpp pulls in
    // whatever its CMake glob finds, so dropping a new file in is enough.
    const up = fakeUpstream()
    const cache = tmp('llama-cache-extra-')
    const env = {
      LLAMA_BUILD_CACHE: cache,
      LLAMA_REPO: up.path,
      LLAMA_TAG: up.tag,
      LLAMA_COMMIT: up.sha,
    }
    expect(runScript('ensure_src', env).code).toBe(0)

    writeFileSync(join(cache, 'llama.cpp', 'extra.cmake'), '# not in the pinned commit\n')
    const extra = runScript('ensure_src', env)
    expect(extra.code, 'an untracked file in the source tree was accepted').not.toBe(0)
    expect(extra.out).toContain('extra.cmake')
  })

  // P11 FEHLER 10 (David's test build, 31.10.2026): the vector tool aborted
  // on Qwen3.5. The fix is LU's own patch to the generator, so the build
  // applies reviewed patches and still compiles nothing but the pinned
  // commit plus exactly those patches.
  it('applies LU\'s patches to a clean checkout and accepts exactly that tree again', () => {
    const up = fakeUpstream()
    const cache = tmp('llama-cache-patched-')
    const patches = tmp('llama-patches-')
    writeFileSync(join(patches, '0001-lu.patch'), '--- a/CMakeLists.txt\n+++ b/CMakeLists.txt\n@@ -1 +1,2 @@\n project(fake)\n+# LU\n')
    const env = { LLAMA_BUILD_CACHE: cache, LLAMA_REPO: up.path, LLAMA_TAG: up.tag, LLAMA_COMMIT: up.sha, LLAMA_LU_PATCH_DIR: patches }
    const first = runScript('ensure_src', env)
    expect(first.code, first.out).toBe(0)
    expect(readFileSync(join(cache, 'llama.cpp', 'CMakeLists.txt'), 'utf8')).toBe('project(fake)\n# LU\n')
    // The cached, already patched tree is checked, not patched twice.
    const again = runScript('ensure_src', env)
    expect(again.code, again.out).toBe(0)
    expect(readFileSync(join(cache, 'llama.cpp', 'CMakeLists.txt'), 'utf8')).toBe('project(fake)\n# LU\n')
    // A change on top of the patch in the patched file is refused.
    writeFileSync(join(cache, 'llama.cpp', 'CMakeLists.txt'), 'project(fake)\n# LU\nadd_definitions(-DBACKDOOR)\n')
    const tampered = runScript('ensure_src', env)
    expect(tampered.code).not.toBe(0)
    expect(tampered.out).toContain('CMakeLists.txt differs')
  })

  it('refuses a patched tree that carries a change in a file no patch touches', () => {
    const up = fakeUpstream()
    const cache = tmp('llama-cache-patched-extra-')
    const patches = tmp('llama-patches-extra-')
    writeFileSync(join(patches, '0001-lu.patch'), '--- a/CMakeLists.txt\n+++ b/CMakeLists.txt\n@@ -1 +1,2 @@\n project(fake)\n+# LU\n')
    const env = { LLAMA_BUILD_CACHE: cache, LLAMA_REPO: up.path, LLAMA_TAG: up.tag, LLAMA_COMMIT: up.sha, LLAMA_LU_PATCH_DIR: patches }
    expect(runScript('ensure_src', env).code).toBe(0)
    writeFileSync(join(cache, 'llama.cpp', 'extra.cmake'), '# not in the pinned commit\n')
    const smuggled = runScript('ensure_src', env)
    expect(smuggled.code).not.toBe(0)
    expect(smuggled.out).toContain('does not match')
  })

  it('stops when a patch does not apply to the pinned source', () => {
    const up = fakeUpstream()
    const patches = tmp('llama-patches-bad-')
    writeFileSync(join(patches, '0001-lu.patch'), '--- a/CMakeLists.txt\n+++ b/CMakeLists.txt\n@@ -1 +1,2 @@\n project(other)\n+# LU\n')
    const env = { LLAMA_BUILD_CACHE: tmp('llama-cache-bad-'), LLAMA_REPO: up.path, LLAMA_TAG: up.tag, LLAMA_COMMIT: up.sha, LLAMA_LU_PATCH_DIR: patches }
    const r = runScript('ensure_src', env)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('0001-lu.patch does not apply')
  })

  it('the repo\'s generator patch keeps the vector on the real blocks and exits cleanly on a model it cannot read', () => {
    const dir = join(REPO_ROOT, 'scripts', 'llama-patches')
    const patch = readFileSync(join(dir, '0001-cvector-generator-real-blocks.patch'), 'utf8')
    // It touches the generator only, so the server stays the pinned source.
    expect([...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1])).toEqual(['tools/cvector-generator/cvector-generator.cpp'])
    // Only the blocks before the last one, picked by their layer index.
    expect(patch).toContain('+    if (il < 0 || il >= cb_data->n_layers - 1) {')
    // A mismatch is a line and exit 1, not GGML_ASSERT's abort.
    expect(patch).toContain('+            fprintf(stderr, "LU: unsupported model:')
    expect(patch).toContain('+            return 1;')
    // And it is what the build applies.
    expect(runScript('printf "%s" "$LU_PATCH_DIR"', { LLAMA_LU_PATCH_DIR: '' }).out).toBe(`${REPO_ROOT}/scripts/llama-patches`.replace(/\\/g, '/'))
  })

  it('hashes a digest of the binary it installed', () => {
    const probe = join(tmp('llama-digest-'), 'artifact')
    writeFileSync(probe, 'llama-server')
    const { code, out } = runScript(`sha256_of '${probe}'`)
    expect(code).toBe(0)
    expect(out).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is inside the CI cache key, so bumping the pin cannot reuse the old source', () => {
    // Both lanes key the .llama-build cache on hashFiles() of this script, and
    // LLAMA_TAG/LLAMA_COMMIT live in it — so the pin is in the key by
    // construction. If a lane ever keys on something narrower, the pin can be
    // bumped while CI keeps building the cached old tree.
    for (const workflow of ['.github/workflows/release.yml', '.github/workflows/sidecar-windows.yml']) {
      const text = readFileSync(resolve(REPO_ROOT, workflow), 'utf8')
      const keys = text.match(/^\s*key:\s*.*llama.*$/gm) ?? []
      expect(keys.length, `${workflow} has no llama cache key`).toBeGreaterThan(0)
      for (const key of keys) {
        expect(key, workflow).toContain("hashFiles('scripts/build-llama.sh')")
      }
    }
  })
})

/**
 * FEHLER-P11 #8: the pinned llama.cpp defines the cvector-generator target
 * only without GGML_BACKEND_DL, which the Windows/Linux server build needs.
 * build_triple therefore configures the vector tool apart from the server.
 * Run with a stand-in `cmake` that records its calls and writes the files a
 * real build would, in a throwaway checkout: the order and the directories
 * are the point, not the compile.
 */
describe('build-llama.sh: the vector tool gets a cmake run of its own on Windows and Linux', () => {
  const temps: string[] = []
  const tmp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    temps.push(dir)
    return dir.replace(/\\/g, '/')
  }
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
  })

  const STAND_IN = `
cmake() {
  if [ "$1" = "-S" ]; then echo "configure $4 \${*:5}" >> "$CALLS"; return 0; fi
  local dir="$2" target=""
  while [ $# -gt 0 ]; do [ "$1" = "--target" ] && target="$2"; shift; done
  echo "build $dir $target" >> "$CALLS"
  mkdir -p "$dir/bin"
  case "$target" in
    llama-server) touch "$dir/bin/llama-server" "$dir/bin/llama-server.exe" "$dir/bin/libggml-base.so" "$dir/bin/ggml-base.dll" ;;
    *) touch "$dir/bin/$target" "$dir/bin/$target.exe" ;;
  esac
}
`

  function build(triple: string) {
    const repoRoot = tmp('llama-p11-root-')
    const cache = tmp('llama-p11-cache-')
    const calls = join(cache, 'calls.txt')
    const { code, out } = runScript(`${STAND_IN} build_triple '${triple}'`, {
      BUILD_LLAMA_REPO_ROOT: repoRoot,
      LLAMA_BUILD_CACHE: cache,
      CALLS: calls,
    })
    return { code, out, repoRoot, cache, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }

  for (const triple of ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc']) {
    it(`${triple}: server as before, the tool from its own static baseline build`, () => {
      const r = build(triple)
      expect(r.code, r.out).toBe(0)
      const server = `${r.cache}/build-${triple}`
      const tool = `${r.cache}/build-${triple}-cvector`
      const configures = r.calls.filter((c) => c.startsWith('configure '))
      expect(configures).toHaveLength(2)
      expect(configures[0]).toContain(`configure ${server} `)
      expect(configures[0]).toContain('-DGGML_BACKEND_DL=ON')
      expect(configures[1]).toContain(`configure ${tool} `)
      expect(configures[1]).toContain('-DGGML_BACKEND_DL=OFF')
      expect(configures[1]).toContain('-DBUILD_SHARED_LIBS=OFF')
      expect(configures[1]).toContain('-DGGML_AVX2=OFF')
      expect(r.calls).toContain(`build ${server} llama-server`)
      expect(r.calls).toContain(`build ${tool} llama-cvector-generator`)
      expect(r.calls).not.toContain(`build ${server} llama-cvector-generator`)
      const exe = triple.includes('windows') ? '.exe' : ''
      expect(existsSync(join(r.repoRoot, 'src-tauri', 'bin', `lu-llama-cvector-generator-${triple}${exe}`))).toBe(true)
      expect(existsSync(join(r.repoRoot, 'src-tauri', 'bin', `lu-llama-server-${triple}${exe}`))).toBe(true)
    })
  }

  it('aarch64-apple-darwin: one static build makes both, as before', () => {
    const r = build('aarch64-apple-darwin')
    expect(r.code, r.out).toBe(0)
    const server = `${r.cache}/build-aarch64-apple-darwin`
    expect(r.calls.filter((c) => c.startsWith('configure '))).toHaveLength(1)
    expect(r.calls).toContain(`build ${server} llama-cvector-generator`)
    expect(existsSync(join(r.repoRoot, 'src-tauri', 'bin', 'lu-llama-cvector-generator-aarch64-apple-darwin'))).toBe(true)
  })
})
