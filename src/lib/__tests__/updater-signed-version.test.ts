/**
 * The updater binds a signature to the version latest.json announces.
 *
 * latest.json is not signed. Its `version` alone does not say which release
 * the `url` and `signature` belong to, so a tampered response could pair a new
 * version number with an older, genuinely signed release. Since tauri-cli
 * 2.11.5 the trusted comment of every updater signature carries
 * `version:x.y.z`, minisign's global signature covers that comment, and
 * tauri-plugin-updater 2.12.0 compares it with the announced version.
 * `requireSignedVersion` in tauri.conf.json also refuses a signature that names
 * no version at all, which is the only way to stop someone from replaying a
 * signature made before 2.11.5.
 *
 * Turned on, it is all or nothing: one lane that signs without the version
 * ships updater files that no install from 3.0.9 on will accept. This test
 * holds the pieces together:
 *   - the CLI that writes the version (`tauri build` fills it in),
 *   - the plugin that reads it (crate and npm package on the same minor),
 *   - every hand-made signature in CI (`tauri signer sign`) naming it.
 *
 * Run: npx vitest run src/lib/__tests__/updater-signed-version.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join, relative } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const cargoLock = readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')

function npmVersion(name: string): string {
  const v = lock.packages?.[`node_modules/${name}`]?.version
  if (!v) throw new Error(`${name} is not a top-level entry in package-lock.json`)
  return v
}

function crateVersion(name: string): string {
  const m = cargoLock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`))
  if (!m) throw new Error(`crate ${name} not found in src-tauri/Cargo.lock`)
  return m[1]
}

const atLeast = (v: string, min: string) => {
  const a = v.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

/** Every workflow and composite action, with the lines that sign by hand. */
function handSignedLines(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.ya?ml$/.test(name)) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          // The command itself, not an error message that names it.
          if (/(?:^|[\s;&|(])(?:npx\s+|npm run tauri --\s+)?tauri signer sign\s+(?!failed)/.test(line) && !line.trim().startsWith('#')) out.push({ file: relative(root, path), line: line.trim() })
        }
      }
    }
  }
  walk(join(root, '.github'))
  return out
}

describe('updater signatures name the version they were made for', () => {
  it('the app requires it', () => {
    expect(conf.plugins.updater.requireSignedVersion).toBe(true)
  })

  it('the CLI writes it (2.11.5 and up)', () => {
    expect(atLeast(npmVersion('@tauri-apps/cli'), '2.11.5'), npmVersion('@tauri-apps/cli')).toBe(true)
  })

  it('the plugin reads it (2.12.0 and up), crate and npm package on the same minor', () => {
    const crate = crateVersion('tauri-plugin-updater')
    const npm = npmVersion('@tauri-apps/plugin-updater')
    expect(atLeast(crate, '2.12.0'), crate).toBe(true)
    expect(npm.split('.').slice(0, 2)).toEqual(crate.split('.').slice(0, 2))
  })

  it('the plugin uses the one @tauri-apps/api the app has', () => {
    // plugin-updater 2.12.0 asks for api ^2.11; the app's api must stay on the
    // tauri crate's minor (tauri-versions-agree). package.json overrides it to
    // the top-level copy: the plugin only imports invoke, Resource and Channel.
    expect(lock.packages['node_modules/@tauri-apps/plugin-updater/node_modules/@tauri-apps/api']).toBeUndefined()
  })

  it('every hand-made signature in CI names the version', () => {
    const lines = handSignedLines()
    // The SignPath lane signs the Windows updater files after SignPath signed
    // the installers; if that ever moves, this test should be moved with it.
    expect(lines.length).toBeGreaterThan(0)
    for (const { file, line } of lines) expect(line, file).toMatch(/--app-version\s+\S+/)
  })
})
