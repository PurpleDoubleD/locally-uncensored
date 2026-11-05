/**
 * Discord report (3.0.7): a user with 3.0.6 installed saw "3.0.5" in the logs.
 *
 * The four files a release bumps (package.json, package-lock.json,
 * tauri.conf.json, Cargo.toml/.lock) agreed at the tag. The drift sat in the
 * code that reads them: the Rust side asked env!("CARGO_PKG_VERSION") in five
 * places and the Tauri config (package_info) in two, the interface imported
 * package.json in three files and asked Tauri in a fourth, and two places
 * carried a number typed in by hand ("2.5.0", "2.3.0") that no version bump
 * ever touches. Every one of them was a place where a bump could be missed,
 * and nothing checked.
 *
 * Now there is one source per side: crate::app_identity::APP_VERSION in Rust
 * and src/lib/app-version.ts in the interface, both fed by the files a bump
 * changes, and those files are held equal here. The log file additionally
 * stamps every line with the version that wrote it (lib.rs, VersionedTime),
 * because a daily log file holds the lines of the run before an update too,
 * and those are exactly the "3.0.5" lines the user read.
 *
 * Run: npx vitest run src/lib/__tests__/eine-versionsquelle.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { APP_VERSION } from '../app-version'

const ROOT = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue
      walk(p, keep, out)
    } else if (keep(p)) out.push(p)
  }
  return out
}

const shipping = JSON.parse(read('package.json')).version as string

/** The [package] version of Cargo.toml, not the first `version =` of a dependency. */
function cargoPackage(): { name: string; version: string } {
  const toml = read('src-tauri/Cargo.toml')
  const section = /^\[package\]\s*$([\s\S]*?)(?=^\[)/m.exec(toml)?.[1] ?? ''
  return {
    name: /^name\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? '',
    version: /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? '',
  }
}

describe('one version, one source', () => {
  it('every file a release bumps carries the same version', () => {
    const lock = JSON.parse(read('package-lock.json'))
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))
    const cargo = cargoPackage()
    const cargoLock = read('src-tauri/Cargo.lock')
    const locked = new RegExp(`\\[\\[package\\]\\]\\nname = "${cargo.name}"\\nversion = "([^"]+)"`).exec(cargoLock)?.[1]
    expect({
      'package-lock.json': lock.version,
      'package-lock.json self': lock.packages?.['']?.version,
      'tauri.conf.json': tauri.version,
      'Cargo.toml [package]': cargo.version,
      'Cargo.lock': locked,
      'src/lib/app-version.ts': APP_VERSION,
    }).toEqual({
      'package-lock.json': shipping,
      'package-lock.json self': shipping,
      'tauri.conf.json': shipping,
      'Cargo.toml [package]': shipping,
      'Cargo.lock': shipping,
      'src/lib/app-version.ts': shipping,
    })
  })

  it('no platform overlay of the Tauri config sets a version of its own', () => {
    // An overlay wins over the base on its platform: a stale "version" in
    // tauri.windows.conf.json would make only the Windows build report it.
    // The two phone overlays carry the version of the phone package on
    // purpose (scripts/mobile/release/version-setzen.sh, src-tauri/src/phone_version.rs).
    const PHONE = ['tauri.ios.conf.json', 'tauri.android.conf.json']
    for (const f of readdirSync(join(ROOT, 'src-tauri')).filter((n) => /^tauri\..+\.conf\.json$/.test(n) && !PHONE.includes(n))) {
      expect(JSON.parse(read(`src-tauri/${f}`)).version, f).toBeUndefined()
    }
  })

  it('the Rust side reads the version in exactly one place', () => {
    const files = walk(join(ROOT, 'src-tauri/src'), (p) => p.endsWith('.rs'))
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f)
      const text = readFileSync(f, 'utf8')
      // phone_version.rs is the build script's reader of the phone package's
      // version; a desktop build hands it the crate version as the fallback.
      const ownSource = rel === 'src-tauri/src/app_identity.rs' || rel === 'src-tauri/src/phone_version.rs'
      if (!ownSource && text.includes('CARGO_PKG_VERSION')) offenders.push(`${rel}: CARGO_PKG_VERSION`)
      if (/package_info\(\)\s*\.version/.test(text)) offenders.push(`${rel}: package_info().version`)
    }
    expect(offenders, 'use crate::app_identity::APP_VERSION').toEqual([])
  })

  it('the interface reads the version in exactly one place and never types one in', () => {
    const files = walk(join(ROOT, 'src'), (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))
    const offenders: string[] = []
    const major = Number(shipping.split('.')[0])
    const typedIn = /['"`]v?(\d+)\.\d+\.\d+['"`]/g
    for (const f of files) {
      const rel = relative(ROOT, f)
      const text = readFileSync(f, 'utf8')
      if (rel !== 'src/lib/app-version.ts' && /from\s+['"](\.\.\/)+package\.json['"]/.test(text)) offenders.push(`${rel}: imports package.json`)
      if (/@tauri-apps\/api\/app['"]/.test(text) && /\bgetVersion\b/.test(text)) offenders.push(`${rel}: getVersion()`)
      // The release notes are a list of past versions by design, the phone's as well.
      if (rel === 'src/lib/release-notes.ts' || rel === 'src/mobile/strings/release-notes.ts') continue
      // LM Studio's runtime number that LFM3 needs (N1), not a version of LU.
      if (rel === 'src/lib/lmstudio-runtime.ts') continue
      for (const m of text.matchAll(typedIn)) {
        const n = Number(m[1])
        if (n >= 2 && n <= major) offenders.push(`${rel}: ${m[0]}`)
      }
    }
    expect(offenders, 'use APP_VERSION from src/lib/app-version.ts').toEqual([])
  })

  it('the log file stamps every line with the version that wrote it', () => {
    // A daily log file keeps the lines of the run before an update. Only the
    // start line named a version, so every line after it read as "the app",
    // whichever app it was.
    // lib.rs since the phone line (main.rs only calls run()).
    const main = read('src-tauri/src/lib.rs')
    const init = main.slice(main.indexOf('fn init_tracing()'))
    const fileLayer = init.slice(0, init.indexOf('if json_mode'))
    expect(fileLayer).toContain('.with_timer(VersionedTime')
  })
})
