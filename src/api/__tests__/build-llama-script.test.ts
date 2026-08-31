import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { existsSync, statSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { bashInterpreter } from './bash-interpreter'

// P0: unit-test the pure functions of scripts/build-llama.sh by sourcing it
// (main() is guarded so sourcing does not build anything) and invoking helpers.
const SCRIPT = resolve(__dirname, '../../../scripts/build-llama.sh')
const REPO_ROOT = resolve(__dirname, '../../..')
// Not the bare name 'bash': on Windows that resolves to the WSL alias stub in
// WindowsApps and never reaches a shell. See bash-interpreter.ts.
const BASH = bashInterpreter()

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
      env: { ...process.env, ...env },
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
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '').trim() }
  }
}

describe('build-llama.sh', () => {
  it('exists and is executable', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    // owner-executable bit set - checked via the git index on Windows, where
    // NTFS has no unix mode bits (node only synthesizes X for .exe/.bat/.cmd)
    if (process.platform === 'win32') {
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

  it('emits Vulkan flags for win/linux triples', () => {
    for (const triple of ['x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']) {
      const { out } = callFn('cmake_flags_for', triple)
      expect(out).toContain('-DGGML_VULKAN=ON')
      expect(out).toContain('-DBUILD_SHARED_LIBS=OFF')
    }
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
 * The sidecar pin.
 *
 * `llama-server` is compiled from upstream source, dropped into the installer
 * and code-signed with the app. Until this pin existed the build followed a
 * git TAG — a mutable pointer that upstream (or anyone who takes that repo
 * over) can move to different code without any local change, so the binary
 * users installed was in practice unpinned. The commit SHA is the pin now; the
 * tag stays as the readable name and is cross-checked against it.
 */
describe('build-llama.sh — the llama.cpp revision is pinned to a commit', () => {
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
