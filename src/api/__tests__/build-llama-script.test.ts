import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'

// P0: unit-test the pure functions of scripts/build-llama.sh by sourcing it
// (main() is guarded so sourcing does not build anything) and invoking helpers.
const SCRIPT = resolve(__dirname, '../../../scripts/build-llama.sh')

function callFn(fn: string, ...args: string[]): { code: number; out: string } {
  const argv = args.map((a) => `'${a}'`).join(' ')
  try {
    const out = execFileSync(
      'bash',
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
