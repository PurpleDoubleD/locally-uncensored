import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// CA test builds (14.11.2026) keep the cloud session out of the keychain with
// the `insecure-test-keychain` feature, so a rebuild keeps the login. That
// feature turns on a plaintext fallback (LU_NO_KEYCHAIN / ~/.lu-no-keychain)
// and must never reach a shipped build: not a default, and no release path
// may pass it.
const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('insecure-test-keychain stays out of every shipped build', () => {
  it('is not a default feature, and nothing enables it through another feature', () => {
    const cargo = read('src-tauri/Cargo.toml')
    const features = cargo.split('[features]')[1]?.split(/\n\[/)[0] ?? ''
    const lines = features.split('\n').filter((l) => /=/.test(l) && !l.trim().startsWith('#'))
    for (const l of lines) {
      if (l.trim().startsWith('insecure-test-keychain')) {
        expect(l.replace(/\s/g, '')).toBe('insecure-test-keychain=[]')
        continue
      }
      expect(l, `feature line enables it: ${l}`).not.toMatch(/insecure-test-keychain/)
    }
  })

  it('no release workflow, build script or npm script passes it', () => {
    const files = [
      'package.json',
      ...readdirSync(join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      ...readdirSync(join(root, 'scripts')).filter((f) => /\.(sh|mjs|js|ps1)$/.test(f)).map((f) => `scripts/${f}`),
      ...['src-tauri/tauri.conf.json', 'src-tauri/tauri.release.conf.json', 'src-tauri/tauri.macos.conf.json', 'src-tauri/tauri.windows.conf.json', 'src-tauri/tauri.linux.conf.json'],
    ].filter((f) => existsSync(join(root, f)))
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) expect(read(f), f).not.toMatch(/insecure-test-keychain/)
  })

  it('the bypass is compiled out without the feature', () => {
    const secret = read('src-tauri/src/commands/secret.rs')
    const fn = secret.slice(secret.indexOf('fn keychain_disabled'), secret.indexOf('fn keychain_disabled') + 900)
    expect(fn).toMatch(/#\[cfg\(not\(feature = "insecure-test-keychain"\)\)\]\s*\{\s*false\s*\}/)
    // The only reads of the switch sit behind the feature gate.
    const gated = fn.slice(fn.indexOf('#[cfg(feature = "insecure-test-keychain")]'))
    expect(gated).toMatch(/LU_NO_KEYCHAIN/)
    // And nowhere else in the file reads it.
    expect((secret.match(/var_os\("LU_NO_KEYCHAIN"\)/g) ?? []).length).toBe(1)
    expect((secret.match(/\.lu-no-keychain"\)/g) ?? []).length).toBe(1)
    expect(gated).toMatch(/var_os\("LU_NO_KEYCHAIN"\)/)
  })
})
