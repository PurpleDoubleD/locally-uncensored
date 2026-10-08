#!/usr/bin/env node
// windows-signpath.mjs: the file handling of the SignPath signing lane.
//
// SignPath signs artifacts that were uploaded to GitHub, after the build.
// Tauri expects to sign during the build. This script is everything between
// the two that is plain file work, so it can be tested without Windows and
// without a SignPath account (src/lib/__tests__/windows-signpath.test.ts).
// The steps that call it are in .github/actions/windows-signpath/action.yml.
//
// Why the app binary is staged twice. The bundler writes the installer type
// into the main binary before it packs it (tauri-bundler 2.8.1, bundle.rs,
// patch_binary): the marker __TAURI_BUNDLE_TYPE_VAR_UNK becomes ..._NSS for
// the NSIS installer and ..._MSI for the MSI. The updater reads it to pick
// "windows-x86_64-nsis" or "windows-x86_64-msi" from latest.json. Changing a
// byte of a signed file breaks its signature, so the marker has to be written
// BEFORE SignPath signs. `stage-app` therefore produces one copy per
// installer type, both get signed, and `place-app` puts the right one where
// `tauri bundle` looks. The bundler then finds no ..._UNK marker, logs a
// warning, and packs the file as it is.
//
// Commands (paths are relative to the repository root unless absolute):
//   stage-app <out-dir>                 patched copies under nsis/ and msi/
//   place-app <nsis|msi> <signed-dir>   signed copy into src-tauri/target/release
//   check-app <nsis|msi> <signed-dir>   the bundler left that copy untouched
//   stage-installers <out-dir>          the one NSIS and the one MSI installer
//   updater-artifacts <signed-dir> <dist-dir>
//                                       release file names plus the v1 zips
//   merge-latest-json <dist-dir> <latest.json> <download-base-url>
//                                       write the Windows entries into the file
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'

export const BUNDLE_MARKER = '__TAURI_BUNDLE_TYPE_VAR_'
const UNPATCHED = `${BUNDLE_MARKER}UNK`
/** The marker value the bundler writes per installer type. */
export const VARIANTS = { nsis: `${BUNDLE_MARKER}NSS`, msi: `${BUNDLE_MARKER}MSI` }

function fail(message) {
  throw new Error(message)
}

/** Every offset at which `needle` starts in `haystack`. */
function offsetsOf(haystack, needle) {
  const found = []
  const bytes = Buffer.from(needle, 'latin1')
  for (let at = haystack.indexOf(bytes); at >= 0; at = haystack.indexOf(bytes, at + 1)) found.push(at)
  return found
}

/**
 * A copy of the app binary with the installer type written into it, the same
 * way the bundler does it: the first ..._UNK marker is overwritten in place.
 */
export function patchBundleType(binary, variant) {
  const value = VARIANTS[variant] ?? fail(`unknown installer type "${variant}", expected nsis or msi`)
  const at = offsetsOf(binary, UNPATCHED)
  if (at.length === 0) {
    fail(`the app binary has no ${UNPATCHED} marker. It was either bundled already or built with a tauri crate that does not carry the marker; the updater could not tell NSIS from MSI.`)
  }
  const patched = Buffer.from(binary)
  patched.write(value, at[0], 'latin1')
  return patched
}

/**
 * Which installer type a binary is marked for: "nsis", "msi", or null.
 *
 * A real build carries every ..._NSS and ..._MSI value once already, as the
 * literals the app compares its marker against. Marking overwrites the one
 * ..._UNK with a second copy of a value, so the marked type is the value that
 * occurs more often than the other, with no ..._UNK left.
 */
export function bundleTypeOf(binary) {
  if (offsetsOf(binary, UNPATCHED).length > 0) return null
  const counts = Object.entries(VARIANTS).map(([variant, value]) => [variant, offsetsOf(binary, value).length])
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > counts[1][1] ? counts[0][0] : null
}

/**
 * Size of the certificate table of a PE file, 0 when it carries no
 * Authenticode signature. This says "a signature is attached", not "the
 * signature is valid"; validity is checked on Windows by
 * scripts/windows-signing-verify.ps1.
 */
export function peCertificateTableSize(binary) {
  if (binary.length < 0x40 || binary.toString('latin1', 0, 2) !== 'MZ') fail('not a PE file: no MZ header')
  const pe = binary.readUInt32LE(0x3c)
  if (pe + 24 > binary.length || binary.toString('latin1', pe, pe + 4) !== 'PE\0\0') fail('not a PE file: no PE header')
  const optional = pe + 24
  const magic = binary.readUInt16LE(optional)
  const directories = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : fail(`unknown PE optional header magic 0x${magic.toString(16)}`)
  const security = directories + 4 * 8
  if (security + 8 > binary.length) fail('not a PE file: the data directories are cut off')
  return binary.readUInt32LE(security + 4)
}

/** A ZIP archive holding one file, stored, as tauri-bundler writes its v1 updater archives. */
export function zipOfOneFile(name, data) {
  if (data.length >= 0xffffffff) fail(`${name} is too large for a plain ZIP archive`)
  const fileName = Buffer.from(name, 'utf8')
  const checksum = crc32(data)
  // 0x0800: the file name is UTF-8.
  const flags = 0x0800
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt16LE(0, 10)
  local.writeUInt16LE(0x21, 12)
  local.writeUInt32LE(checksum, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  local.writeUInt16LE(0, 28)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(flags, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt16LE(0, 12)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(checksum, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  central.writeUInt32LE(0, 42)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + fileName.length, 12)
  end.writeUInt32LE(local.length + fileName.length + data.length, 16)
  return Buffer.concat([local, fileName, data, central, fileName, end])
}

/** GitHub replaces spaces in asset names with dots; do it before the upload so the names are known. */
export function releaseAssetName(fileName) {
  return fileName.replace(/ /g, '.')
}

/**
 * The Windows entries of latest.json, in the shape tauri-action writes them
 * for createUpdaterArtifacts "v1Compatible" (read from the v3.0.5 release):
 * the plain key points at the zipped MSI for updaters older than the
 * installer-type lookup, the two suffixed keys at the installers themselves.
 */
export function windowsPlatforms(files, signatureOf, downloadBaseUrl) {
  const one = (pattern, what) => {
    const hits = files.filter((f) => pattern.test(f))
    if (hits.length !== 1) fail(`expected exactly one ${what}, found ${hits.length}: ${hits.join(', ')}`)
    return hits[0]
  }
  const entry = (file) => ({
    signature: signatureOf(file),
    url: `${downloadBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(file)}`,
  })
  return {
    'windows-x86_64': entry(one(/\.msi\.zip$/, 'zipped MSI')),
    'windows-x86_64-msi': entry(one(/\.msi$/, 'MSI installer')),
    'windows-x86_64-nsis': entry(one(/-setup\.exe$/, 'NSIS installer')),
  }
}

/** latest.json with the Windows entries replaced, everything else kept. */
export function mergeLatestJson(existing, platforms, fallback) {
  const merged = existing ? structuredClone(existing) : { version: fallback.version, notes: fallback.notes, pub_date: fallback.pubDate }
  if (existing && existing.version !== fallback.version) {
    fail(`latest.json on the release says version ${existing.version}, this build is ${fallback.version}`)
  }
  merged.platforms = { ...(merged.platforms ?? {}), ...platforms }
  return merged
}

// ── Command line ───────────────────────────────────────────────────────────

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function appBinaryName() {
  const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8')
  const name = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(cargo)?.[1] ?? fail('no package name in src-tauri/Cargo.toml')
  return `${name}.exe`
}

function appVersion() {
  return JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version
}

const builtApp = () => join(root, 'src-tauri/target/release', appBinaryName())
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  console.log(`${name}=${value}`)
}

function freshDir(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

function signedCopy(variant, signedDir) {
  const file = join(resolve(signedDir), variant, appBinaryName())
  if (!existsSync(file)) fail(`SignPath returned no ${variant}/${appBinaryName()} in ${signedDir}`)
  return file
}

function onlyFile(dir, pattern, what) {
  const hits = existsSync(dir) ? readdirSync(dir).filter((f) => pattern.test(f)) : []
  if (hits.length !== 1) fail(`expected exactly one ${what} in ${dir}, found ${hits.length}: ${hits.join(', ')}`)
  return join(dir, hits[0])
}

const commands = {
  'stage-app'([outDir]) {
    const out = resolve(outDir ?? fail('usage: stage-app <out-dir>'))
    const binary = readFileSync(builtApp())
    if (peCertificateTableSize(binary) !== 0) fail(`${builtApp()} is already signed; SignPath must receive the unsigned build`)
    freshDir(out)
    for (const variant of Object.keys(VARIANTS)) {
      mkdirSync(join(out, variant))
      writeFileSync(join(out, variant, appBinaryName()), patchBundleType(binary, variant))
    }
    output('dir', out)
    output('version', appVersion())
    output('binary', appBinaryName())
  },

  'place-app'([variant, signedDir]) {
    const signed = signedCopy(variant, signedDir ?? fail('usage: place-app <nsis|msi> <signed-dir>'))
    const binary = readFileSync(signed)
    if (peCertificateTableSize(binary) === 0) fail(`${signed} came back from SignPath without a signature`)
    if (bundleTypeOf(binary) !== variant) fail(`${signed} is not marked for the ${variant} installer`)
    copyFileSync(signed, builtApp())
    console.log(`placed the signed ${variant} build of ${appBinaryName()} (sha256 ${sha256(signed)})`)
  },

  'check-app'([variant, signedDir]) {
    const signed = signedCopy(variant, signedDir ?? fail('usage: check-app <nsis|msi> <signed-dir>'))
    if (sha256(signed) !== sha256(builtApp())) {
      fail(`the bundler changed ${appBinaryName()} while packing the ${variant} installer; its signature no longer covers the file`)
    }
    console.log(`the bundler packed the signed ${variant} build of ${appBinaryName()} unchanged`)
  },

  'stage-installers'([outDir]) {
    const out = resolve(outDir ?? fail('usage: stage-installers <out-dir>'))
    const bundle = join(root, 'src-tauri/target/release/bundle')
    const nsis = onlyFile(join(bundle, 'nsis'), /-setup\.exe$/, 'NSIS installer')
    const msi = onlyFile(join(bundle, 'msi'), /\.msi$/, 'MSI installer')
    freshDir(out)
    for (const file of [nsis, msi]) copyFileSync(file, join(out, basename(file)))
    output('dir', out)
  },

  'updater-artifacts'([signedDir, distDir]) {
    if (!signedDir || !distDir) fail('usage: updater-artifacts <signed-dir> <dist-dir>')
    const signed = resolve(signedDir)
    const dist = resolve(distDir)
    const nsis = onlyFile(signed, /-setup\.exe$/, 'signed NSIS installer')
    const msi = onlyFile(signed, /\.msi$/, 'signed MSI installer')
    if (peCertificateTableSize(readFileSync(nsis)) === 0) fail(`${nsis} came back from SignPath without a signature`)
    freshDir(dist)
    // tauri-bundler names the archive after the installer with the bundle
    // type in place of the extension: -setup.exe -> -setup.nsis.zip, and
    // .msi -> .msi.zip. The file inside keeps its original name.
    for (const [file, zipName] of [
      [nsis, basename(nsis).replace(/\.exe$/, '.nsis.zip')],
      [msi, `${basename(msi)}.zip`],
    ]) {
      const data = readFileSync(file)
      writeFileSync(join(dist, releaseAssetName(basename(file))), data)
      writeFileSync(join(dist, releaseAssetName(zipName)), zipOfOneFile(basename(file), data))
    }
    output('dir', dist)
  },

  'merge-latest-json'([distDir, latestJson, downloadBaseUrl]) {
    if (!distDir || !latestJson || !downloadBaseUrl) fail('usage: merge-latest-json <dist-dir> <latest.json> <download-base-url>')
    const dist = resolve(distDir)
    const files = readdirSync(dist).filter((f) => statSync(join(dist, f)).isFile())
    const signatureOf = (file) => {
      const sig = join(dist, `${file}.sig`)
      if (!existsSync(sig)) fail(`${file} has no updater signature (${file}.sig)`)
      return readFileSync(sig, 'utf8').trim()
    }
    const platforms = windowsPlatforms(files.filter((f) => !f.endsWith('.sig')), signatureOf, downloadBaseUrl)
    const target = resolve(latestJson)
    const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null
    const merged = mergeLatestJson(existing, platforms, {
      version: appVersion(),
      notes: process.env.RELEASE_NOTES ?? '',
      pubDate: new Date().toISOString(),
    })
    writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`)
    console.log(`latest.json: ${Object.keys(platforms).join(', ')} now point at the signed installers`)
  },
}

// Run as a program, not imported. Both sides resolved, because a temporary
// directory is often reached through a symbolic link.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...args] = process.argv.slice(2)
  const run = commands[command]
  if (!run) {
    console.error(`usage: windows-signpath.mjs <${Object.keys(commands).join('|')}> ...`)
    process.exit(2)
  }
  try {
    run(args)
  } catch (error) {
    console.error(`::error::${error.message}`)
    process.exit(1)
  }
}
