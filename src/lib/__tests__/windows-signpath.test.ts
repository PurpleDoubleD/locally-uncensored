/**
 * The file handling of the SignPath signing lane, executed.
 *
 * SignPath signs after the build, Tauri expects to sign during it. Everything
 * in between that is plain file work lives in scripts/windows-signpath.mjs so
 * that it can run here, on any system, without Windows and without a SignPath
 * account. Signing itself is stood in for by `fakeSign`, which does to a PE
 * file what a signature does as far as this script can tell: it fills the
 * certificate table entry and appends bytes.
 *
 * VERIFICATION LIMIT, stated on purpose: no real signature is made or checked
 * here. That SignPath accepts the two artifact configurations, that the
 * bundler on Windows leaves a signed binary alone, and that the result
 * verifies, is first proven by a run of .github/workflows/signpath-probe.yml.
 *
 * Run: npx vitest run src/lib/__tests__/windows-signpath.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import {
  VARIANTS, bundleTypeOf, mergeLatestJson, patchBundleType, peCertificateTableSize, releaseAssetName,
  windowsPlatforms, zipOfOneFile,
} from '../../../scripts/windows-signpath.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const SCRIPT = resolve(root, 'scripts/windows-signpath.mjs')

const CERT_ENTRY = 0x40 + 24 + 112 + 4 * 8

/** The smallest thing peCertificateTableSize accepts: a PE32+ header, then a body. */
function fakeExe(body: string): Buffer {
  const header = Buffer.alloc(0x40 + 24 + 112 + 16 * 8)
  header.write('MZ', 0, 'latin1')
  header.writeUInt32LE(0x40, 0x3c)
  header.write('PE\0\0', 0x40, 'latin1')
  header.writeUInt16LE(0x20b, 0x40 + 24)
  return Buffer.concat([header, Buffer.from(body, 'latin1')])
}

function fakeSign(binary: Buffer): Buffer {
  const signed = Buffer.concat([binary, Buffer.from('FAKE-AUTHENTICODE-SIGNATURE')])
  signed.writeUInt32LE(binary.length, CERT_ENTRY)
  signed.writeUInt32LE(27, CERT_ENTRY + 4)
  return signed
}

const UNPATCHED = fakeExe('code before __TAURI_BUNDLE_TYPE_VAR_UNK code after')

describe('the installer type marker', () => {
  it('is written the way the bundler writes it: same length, same place, nothing else changes', () => {
    for (const [variant, value] of Object.entries(VARIANTS)) {
      const patched = patchBundleType(UNPATCHED, variant)
      expect(patched.length).toBe(UNPATCHED.length)
      expect(patched.toString('latin1')).toBe(UNPATCHED.toString('latin1').replace('__TAURI_BUNDLE_TYPE_VAR_UNK', value))
      expect(bundleTypeOf(patched)).toBe(variant)
    }
    expect(bundleTypeOf(UNPATCHED)).toBeNull()
  })

  it('reads the mark of a real build, which carries every value once as a literal', () => {
    // The app compares its marker against the NSS and MSI values, so both are
    // in every build. The first probe run on GitHub read each copy as "nsis".
    const real = fakeExe('__TAURI_BUNDLE_TYPE_VAR_NSS __TAURI_BUNDLE_TYPE_VAR_MSI code __TAURI_BUNDLE_TYPE_VAR_UNK end')
    expect(bundleTypeOf(real)).toBeNull()
    expect(bundleTypeOf(patchBundleType(real, 'nsis'))).toBe('nsis')
    expect(bundleTypeOf(patchBundleType(real, 'msi'))).toBe('msi')
  })

  it('does not modify the buffer it was given', () => {
    const before = Buffer.from(UNPATCHED)
    patchBundleType(UNPATCHED, 'nsis')
    expect(UNPATCHED.equals(before)).toBe(true)
  })

  it('refuses a binary that has no marker left, and an installer type it does not know', () => {
    expect(() => patchBundleType(patchBundleType(UNPATCHED, 'msi'), 'nsis')).toThrow(/no __TAURI_BUNDLE_TYPE_VAR_UNK marker/)
    expect(() => patchBundleType(UNPATCHED, 'appimage')).toThrow(/unknown installer type/)
  })
})

describe('the certificate table of a PE file', () => {
  it('is empty on an unsigned file and filled on a signed one', () => {
    expect(peCertificateTableSize(UNPATCHED)).toBe(0)
    expect(peCertificateTableSize(fakeSign(UNPATCHED))).toBe(27)
  })

  it('is not read from something that is no PE file', () => {
    expect(() => peCertificateTableSize(Buffer.from('#!/bin/sh\n'.padEnd(200)))).toThrow(/not a PE file/)
  })
})

describe('the v1 updater archive', () => {
  it('is a ZIP with the one file in it, stored, under its own name', () => {
    const data = Buffer.from('installer bytes '.repeat(100))
    const zip = zipOfOneFile('Locally Uncensored_3.0.5_x64-setup.exe', data)
    // Local header, then the name, then the data unchanged.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.readUInt16LE(8)).toBe(0)
    expect(zip.readUInt32LE(14)).toBe(crc32(data))
    const nameLength = zip.readUInt16LE(26)
    expect(zip.toString('utf8', 30, 30 + nameLength)).toBe('Locally Uncensored_3.0.5_x64-setup.exe')
    expect(zip.subarray(30 + nameLength, 30 + nameLength + data.length).equals(data)).toBe(true)
    // End record: one entry, and the central directory sits where it says.
    const end = zip.length - 22
    expect(zip.readUInt32LE(end)).toBe(0x06054b50)
    expect(zip.readUInt16LE(end + 10)).toBe(1)
    expect(zip.readUInt32LE(zip.readUInt32LE(end + 16))).toBe(0x02014b50)
  })
})

describe('latest.json', () => {
  const files = [
    'Locally.Uncensored_3.0.5_x64-setup.exe', 'Locally.Uncensored_3.0.5_x64-setup.nsis.zip',
    'Locally.Uncensored_3.0.5_x64_en-US.msi', 'Locally.Uncensored_3.0.5_x64_en-US.msi.zip',
  ]
  const base = 'https://github.com/PurpleDoubleD/locally-uncensored/releases/download/v3.0.5'
  const platforms = windowsPlatforms(files, (f) => `sig-of-${f}`, `${base}/`)

  it('gets the three Windows entries tauri-action wrote for v3.0.5', () => {
    expect(platforms).toEqual({
      'windows-x86_64': { signature: `sig-of-${files[3]}`, url: `${base}/${files[3]}` },
      'windows-x86_64-msi': { signature: `sig-of-${files[2]}`, url: `${base}/${files[2]}` },
      'windows-x86_64-nsis': { signature: `sig-of-${files[0]}`, url: `${base}/${files[0]}` },
    })
  })

  it('keeps every other platform and field of the file on the release', () => {
    const existing = {
      version: '3.0.5', notes: 'notes', pub_date: '2026-10-05T18:55:23.782Z',
      platforms: {
        'linux-x86_64': { signature: 'linux', url: 'https://example.invalid/app.AppImage.tar.gz' },
        'windows-x86_64-nsis': { signature: 'unsigned-build', url: 'https://example.invalid/old.exe' },
      },
    }
    const merged = mergeLatestJson(existing, platforms, { version: '3.0.5', notes: 'ignored', pubDate: 'ignored' })
    expect(merged.version).toBe('3.0.5')
    expect(merged.notes).toBe('notes')
    expect(merged.pub_date).toBe('2026-10-05T18:55:23.782Z')
    expect(merged.platforms?.['linux-x86_64']).toEqual(existing.platforms['linux-x86_64'])
    expect(merged.platforms?.['windows-x86_64-nsis'].signature).toBe(`sig-of-${files[0]}`)
    expect(existing.platforms['windows-x86_64-nsis'].signature).toBe('unsigned-build')
  })

  it('starts a file when the release has none yet', () => {
    const merged = mergeLatestJson(null, platforms, { version: '3.0.5', notes: 'body', pubDate: '2026-10-09T00:00:00.000Z' })
    expect(merged).toMatchObject({ version: '3.0.5', notes: 'body', pub_date: '2026-10-09T00:00:00.000Z' })
    expect(Object.keys(merged.platforms ?? {})).toHaveLength(3)
  })

  it('refuses to write into the file of another version', () => {
    expect(() => mergeLatestJson({ version: '3.0.4' }, platforms, { version: '3.0.5', notes: '', pubDate: '' })).toThrow(/3\.0\.4/)
  })

  it('refuses a set of files in which an installer is missing or doubled', () => {
    expect(() => windowsPlatforms(files.slice(0, 2), () => '', base)).toThrow(/zipped MSI/)
    expect(() => windowsPlatforms([...files, 'Other_3.0.5_x64-setup.exe'], () => '', base)).toThrow(/NSIS installer/)
  })

  it('asset names are the ones GitHub would make of them', () => {
    expect(releaseAssetName('Locally Uncensored_3.0.5_x64-setup.exe')).toBe('Locally.Uncensored_3.0.5_x64-setup.exe')
  })
})

// The commands, run as the action runs them, in a copy of the script that
// sits in a made-up repository: the script finds its tree relative to itself.
describe('the commands, executed in order', () => {
  let repo = ''
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [join(repo, 'scripts/windows-signpath.mjs'), ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
  const built = () => join(repo, 'src-tauri/target/release/probe-app.exe')

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'windows-signpath-'))
    mkdirSync(join(repo, 'scripts'))
    cpSync(SCRIPT, join(repo, 'scripts/windows-signpath.mjs'))
    mkdirSync(join(repo, 'src-tauri/target/release'), { recursive: true })
    writeFileSync(join(repo, 'src-tauri/Cargo.toml'), '[package]\nname = "probe-app"\nversion = "1.2.3"\n\n[dependencies]\nname = "decoy"\n')
    writeFileSync(join(repo, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(built(), UNPATCHED)
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  /** What SignPath hands back for the first request: the same tree, signed. */
  function signApp(unsigned: string, signed: string) {
    for (const variant of ['nsis', 'msi']) {
      mkdirSync(join(signed, variant), { recursive: true })
      writeFileSync(join(signed, variant, 'probe-app.exe'), fakeSign(readFileSync(join(unsigned, variant, 'probe-app.exe'))))
    }
  }

  it('stage-app writes one marked copy per installer type and reports the version', () => {
    const out = join(repo, 'staged')
    const log = run('stage-app', out)
    expect(log).toContain('version=1.2.3')
    expect(log).toContain('binary=probe-app.exe')
    expect(readdirSync(out).sort()).toEqual(['msi', 'nsis'])
    expect(bundleTypeOf(readFileSync(join(out, 'nsis/probe-app.exe')))).toBe('nsis')
    expect(bundleTypeOf(readFileSync(join(out, 'msi/probe-app.exe')))).toBe('msi')
    // The build itself stays as cargo left it.
    expect(readFileSync(built()).equals(UNPATCHED)).toBe(true)
  })

  it('stage-app refuses a build that is signed already', () => {
    writeFileSync(built(), fakeSign(UNPATCHED))
    expect(() => run('stage-app', join(repo, 'staged'))).toThrow(/already signed/)
  })

  it('place-app puts the signed copy where the bundler looks, check-app notices a changed file', () => {
    const unsigned = join(repo, 'staged')
    const signed = join(repo, 'signed')
    run('stage-app', unsigned)
    signApp(unsigned, signed)
    run('place-app', 'nsis', signed)
    expect(readFileSync(built()).equals(readFileSync(join(signed, 'nsis/probe-app.exe')))).toBe(true)
    run('check-app', 'nsis', signed)
    // A bundler that wrote into the binary would leave a different file.
    writeFileSync(built(), Buffer.concat([readFileSync(built()), Buffer.from('x')]))
    expect(() => run('check-app', 'nsis', signed)).toThrow(/signature no longer covers/)
  })

  it('place-app refuses what came back unsigned, and a copy marked for the other installer', () => {
    const unsigned = join(repo, 'staged')
    run('stage-app', unsigned)
    expect(() => run('place-app', 'nsis', unsigned)).toThrow(/without a signature/)
    const swapped = join(repo, 'swapped')
    mkdirSync(join(swapped, 'nsis'), { recursive: true })
    writeFileSync(join(swapped, 'nsis/probe-app.exe'), fakeSign(readFileSync(join(unsigned, 'msi/probe-app.exe'))))
    expect(() => run('place-app', 'nsis', swapped)).toThrow(/not marked for the nsis installer/)
  })

  it('stage-installers takes exactly the two installers, updater-artifacts names them for the release', () => {
    const bundle = join(repo, 'src-tauri/target/release/bundle')
    mkdirSync(join(bundle, 'nsis'), { recursive: true })
    mkdirSync(join(bundle, 'msi'), { recursive: true })
    writeFileSync(join(bundle, 'nsis/Probe App_1.2.3_x64-setup.exe'), fakeExe('nsis installer'))
    writeFileSync(join(bundle, 'msi/Probe App_1.2.3_x64_en-US.msi'), 'msi installer')
    const staged = join(repo, 'installers')
    run('stage-installers', staged)
    expect(readdirSync(staged).sort()).toEqual(['Probe App_1.2.3_x64-setup.exe', 'Probe App_1.2.3_x64_en-US.msi'])

    // Unsigned installers must not become updater files.
    const dist = join(repo, 'dist')
    expect(() => run('updater-artifacts', staged, dist)).toThrow(/without a signature/)

    const setup = join(staged, 'Probe App_1.2.3_x64-setup.exe')
    writeFileSync(setup, fakeSign(readFileSync(setup)))
    run('updater-artifacts', staged, dist)
    expect(readdirSync(dist).sort()).toEqual([
      'Probe.App_1.2.3_x64-setup.exe', 'Probe.App_1.2.3_x64-setup.nsis.zip',
      'Probe.App_1.2.3_x64_en-US.msi', 'Probe.App_1.2.3_x64_en-US.msi.zip',
    ])
    expect(readFileSync(join(dist, 'Probe.App_1.2.3_x64-setup.exe')).equals(readFileSync(setup))).toBe(true)

    // merge-latest-json wants a signature next to every file it names.
    const latest = join(repo, 'latest.json')
    expect(() => run('merge-latest-json', dist, latest, 'https://example.invalid/dl')).toThrow(/no updater signature/)
    for (const file of readdirSync(dist)) writeFileSync(join(dist, `${file}.sig`), `sig-of-${file}\n`)
    writeFileSync(latest, JSON.stringify({ version: '1.2.3', platforms: { 'linux-x86_64': { signature: 'l', url: 'u' } } }))
    run('merge-latest-json', dist, latest, 'https://example.invalid/dl')
    const written = JSON.parse(readFileSync(latest, 'utf8'))
    expect(Object.keys(written.platforms).sort()).toEqual(['linux-x86_64', 'windows-x86_64', 'windows-x86_64-msi', 'windows-x86_64-nsis'])
    expect(written.platforms['windows-x86_64-nsis']).toEqual({
      signature: 'sig-of-Probe.App_1.2.3_x64-setup.exe',
      url: 'https://example.invalid/dl/Probe.App_1.2.3_x64-setup.exe',
    })
  })

  it('stage-installers refuses a bundle directory with a second installer in it', () => {
    const bundle = join(repo, 'src-tauri/target/release/bundle')
    mkdirSync(join(bundle, 'nsis'), { recursive: true })
    mkdirSync(join(bundle, 'msi'), { recursive: true })
    writeFileSync(join(bundle, 'nsis/A_1.2.3_x64-setup.exe'), 'a')
    writeFileSync(join(bundle, 'nsis/B_1.2.2_x64-setup.exe'), 'b')
    writeFileSync(join(bundle, 'msi/A_1.2.3_x64_en-US.msi'), 'm')
    expect(() => run('stage-installers', join(repo, 'installers'))).toThrow(/exactly one NSIS installer/)
    expect(existsSync(join(repo, 'installers'))).toBe(false)
  })
})
