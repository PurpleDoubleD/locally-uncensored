/**
 * GitHub #185: tauri.linux.conf.json names the x86_64 library folder, so a
 * Linux ARM64 build stops at "resource path doesn't exist". The overlay
 * tauri.linux-aarch64.conf.json, given with `--config`, swaps that folder for
 * the aarch64 one. Tauri merges a --config file as a JSON Merge Patch
 * (RFC 7396), where null removes a key; that is applied here the same way.
 * The x86_64 config itself is not touched.
 *
 * Run: npx vitest run src/lib/__tests__/gh185-linux-arm64-overlay.test.ts
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, 'src-tauri', f), 'utf8'))

type J = Record<string, unknown>
function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch
  const out: J = typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...(target as J) } : {}
  for (const [k, v] of Object.entries(patch as J)) {
    if (v === null) delete out[k]
    else out[k] = mergePatch(out[k], v)
  }
  return out
}

function shell(fn: string, triple: string): string {
  return execFileSync('bash', ['-c', `source "${join(ROOT, 'scripts', 'build-llama.sh')}"; ${fn} "${triple}" && echo yes || echo no`], { encoding: 'utf8' }).trim()
}

describe('the Linux ARM64 build', () => {
  const linux = json('tauri.linux.conf.json')
  const arm = mergePatch(linux, json('tauri.linux-aarch64.conf.json')) as { bundle: { resources: J; externalBin: string[]; linux: { appimage: { files: J } } } }

  it('bundles the aarch64 library folder and not the x86_64 one', () => {
    expect(arm.bundle.resources['resources/llama/aarch64-unknown-linux-gnu/*']).toBe('llama/')
    expect(arm.bundle.resources).not.toHaveProperty('resources/llama/x86_64-unknown-linux-gnu/*')
    expect(JSON.stringify(arm)).not.toContain('x86_64')
  })

  it('keeps every other resource and the sidecars of the x86_64 config', () => {
    const rest = (r: J) => Object.keys(r).filter((k) => !k.startsWith('resources/llama/')).sort()
    expect(rest(arm.bundle.resources)).toEqual(rest(linux.bundle.resources))
    expect(arm.bundle.externalBin).toEqual(linux.bundle.externalBin)
  })

  it('leaves the x86_64 build as it was', () => {
    expect(linux.bundle.resources['resources/llama/x86_64-unknown-linux-gnu/*']).toBe('llama/')
    expect(linux.bundle.linux.appimage.files['/usr/lib/libayatana-appindicator3.so.1']).toContain('x86_64-linux-gnu')
  })

  it('build-llama.sh builds aarch64 Linux in the same dynamic layout, with the vector tool', () => {
    expect(shell('is_dynamic_isa_triple', 'aarch64-unknown-linux-gnu')).toBe('yes')
    expect(shell('cvector_ships_for', 'aarch64-unknown-linux-gnu')).toBe('yes')
    const flags = execFileSync('bash', ['-c', `source "${join(ROOT, 'scripts', 'build-llama.sh')}"; cmake_flags_for aarch64-unknown-linux-gnu`], { encoding: 'utf8' })
    expect(flags).toContain('-DGGML_BACKEND_DL=ON')
    expect(flags).toContain('-DGGML_VULKAN=OFF')
    expect(flags).toContain('-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON')
    // and x86_64 Linux is what it was
    expect(execFileSync('bash', ['-c', `source "${join(ROOT, 'scripts', 'build-llama.sh')}"; cmake_flags_for x86_64-unknown-linux-gnu`], { encoding: 'utf8' })).toContain('-DGGML_VULKAN=ON')
    expect(shell('quantize_ships_for', 'aarch64-unknown-linux-gnu')).toBe('no')
  })
  it('build-llama.sh stops early with GCC 13, which refuses the armv9.2 variants (cross build 19.11.)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lu-gcc-'))
    const fake = (v: string) => {
      const p = join(dir, `gcc${v}`)
      writeFileSync(p, `#!/bin/sh\n[ "$1" = -dumpversion ] && echo ${v}.2.0 || echo gcc\n`)
      chmodSync(p, 0o755)
      return p
    }
    const run = (cc: string) => execFileSync('bash', ['-c', `source "${join(ROOT, 'scripts', 'build-llama.sh')}"; (CC="${cc}" require_arm_variant_compiler) 2>&1 && echo ok || echo stopped`], { encoding: 'utf8' })
    expect(run(fake('13'))).toMatch(/needs GCC 14 or newer[\s\S]*stopped/)
    expect(run(fake('14')).trim()).toBe('ok')
  })
})
