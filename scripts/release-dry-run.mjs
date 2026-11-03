#!/usr/bin/env node
// release-dry-run.mjs: what a dry run of release.yml does to the updater, and
// how it hands over what it built.
//
// A dry run builds the installers a release would build and publishes none of
// them. Two things could still turn such a build into a problem once somebody
// installs it: its updater would ask the public latest.json like any released
// copy, and it would trust the release key, so it would take the next real
// update, or sit in the statistics of the public channel. This script closes
// both before the build and proves afterwards that they stayed closed.
//
//   rewrite-updater <pubkey-file> <receipt-file>
//       Rewrites plugins.updater in src-tauri/tauri.conf.json: the endpoint
//       becomes DRY_RUN_ENDPOINT, the pubkey the public half of the throwaway
//       key the run made. What stood there before goes into the receipt, so
//       the later checks know what must not be found.
//
//   check-binaries <receipt-file> <file-or-directory>...
//       Reads the built programs as bytes. Fails when one of them still
//       carries a public endpoint or the release pubkey, and fails when none
//       carries the dry run endpoint: a search that cannot find what is known
//       to be there proves nothing about what it did not find.
//
//   collect <windows|linux> <bundle-dir> <out-dir> <receipt-file>
//       Copies the installers, the updater archives and their .sig files into
//       one folder, requires the kinds a release ships, writes
//       DRY-RUN-NOT-FOR-RELEASE.txt next to them and one sha256 line per file
//       into the job summary.
//
// No dependency: the release lane runs it before and after `npm ci` alike.
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync,
  readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `.invalid` is reserved (RFC 2606): no resolver answers for it and nobody
// can register it, so this address can never start serving a manifest.
export const DRY_RUN_ENDPOINT = 'https://dry-run.invalid/latest.json'
export const MARKER_FILE = 'DRY-RUN-NOT-FOR-RELEASE.txt'

// What a release ships per platform, and what a dry run therefore has to
// show. `rpm` comes along on Linux because bundle.targets is "all"; it is
// kept, not required, since no release step judges it either.
const REQUIRED = {
  windows: [
    ['the NSIS installer', /-setup\.exe$/],
    ['the MSI installer', /\.msi$/],
    ['an updater signature', /\.sig$/],
  ],
  linux: [
    ['the Debian package', /\.deb$/],
    ['the AppImage', /\.AppImage$/],
    ['an updater signature', /\.sig$/],
  ],
}
const KEPT = /\.(exe|msi|deb|rpm|AppImage|zip|tar\.gz|sig)$/

class DryRunError extends Error {}
const fail = (message) => { throw new DryRunError(message) }

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/**
 * The updater section with the dry run values, and what it replaced.
 * Pure, so the rule can be tested without a file.
 */
export function rewriteUpdater(conf, dryPubkey) {
  const updater = conf?.plugins?.updater
  if (!updater || typeof updater !== 'object') fail('tauri.conf.json has no plugins.updater section')
  const publicEndpoints = Array.isArray(updater.endpoints) ? updater.endpoints.filter((e) => typeof e === 'string') : []
  const releasePubkey = typeof updater.pubkey === 'string' ? updater.pubkey : ''
  if (publicEndpoints.length === 0) fail('tauri.conf.json names no updater endpoint; nothing to move away from')
  if (publicEndpoints.includes(DRY_RUN_ENDPOINT)) fail('tauri.conf.json already names the dry run endpoint; it was rewritten before, or the checked-in file is wrong')
  if (releasePubkey.length < 40) fail('tauri.conf.json carries no updater pubkey')
  const pubkey = String(dryPubkey ?? '').trim()
  // A minisign public key file, base64 on one line, as `tauri signer
  // generate` writes it.
  if (!/^[A-Za-z0-9+/=]{40,}$/.test(pubkey)) fail('the throwaway pubkey is empty or not one line of base64')
  if (pubkey === releasePubkey) fail('the throwaway pubkey is the release pubkey; a dry run must not trust the release key')
  const next = structuredClone(conf)
  next.plugins.updater.endpoints = [DRY_RUN_ENDPOINT]
  next.plugins.updater.pubkey = pubkey
  return { conf: next, receipt: { dryRunEndpoint: DRY_RUN_ENDPOINT, dryRunPubkey: pubkey, publicEndpoints, releasePubkey } }
}

const PHONE_OVERLAYS = new Set(['tauri.android.conf.json', 'tauri.ios.conf.json'])

function cmdRewriteUpdater(pubkeyFile, receiptFile) {
  if (!pubkeyFile || !receiptFile) fail('usage: rewrite-updater <pubkey-file> <receipt-file>')
  const confDir = join(ROOT, 'src-tauri')
  const confFile = join(confDir, 'tauri.conf.json')
  const { conf, receipt } = rewriteUpdater(readJson(confFile), readFileSync(pubkeyFile, 'utf8'))
  // `tauri build` merges the platform file and every --config overlay on top
  // of the base. One of them naming an updater of its own would put a public
  // address back after this rewrite.
  for (const name of readdirSync(confDir)) {
    if (!/^tauri\..+\.conf\.json$/.test(name)) continue
    const updater = readJson(join(confDir, name))?.plugins?.updater
    // The two phone files take the updater out of a phone build (`null`). No
    // desktop build reads them, and `null` names no address.
    if (updater === null && PHONE_OVERLAYS.has(name)) continue
    if (updater !== undefined) {
      fail(`src-tauri/${name} sets plugins.updater; it would override the dry run endpoint`)
    }
  }
  writeFileSync(confFile, `${JSON.stringify(conf, null, 2)}\n`)
  // Read back from disk: the file the build will read, not the object above.
  const written = readJson(confFile).plugins.updater
  if (written.endpoints.length !== 1 || written.endpoints[0] !== DRY_RUN_ENDPOINT || written.pubkey !== receipt.dryRunPubkey) {
    fail('src-tauri/tauri.conf.json does not carry the dry run updater after the rewrite')
  }
  const text = readFileSync(confFile, 'utf8')
  for (const endpoint of receipt.publicEndpoints) {
    if (text.includes(endpoint)) fail(`src-tauri/tauri.conf.json still names ${endpoint}`)
  }
  if (text.includes(receipt.releasePubkey)) fail('src-tauri/tauri.conf.json still carries the release pubkey')
  mkdirSync(dirname(resolve(receiptFile)), { recursive: true })
  writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`updater endpoint: ${receipt.publicEndpoints.join(', ')} -> ${DRY_RUN_ENDPOINT}`)
  console.log('updater pubkey:   the release key -> the throwaway key of this run')
}

/** Which of the needles occur in the file. Read in pieces: a binary can be large. */
export function findInFile(file, needles) {
  const wanted = needles.map((n) => Buffer.from(n, 'utf8'))
  const longest = Math.max(...wanted.map((n) => n.length))
  const found = new Set()
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  let carry = Buffer.alloc(0)
  const fd = openSync(file, 'r')
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      const window = Buffer.concat([carry, chunk.subarray(0, read)])
      wanted.forEach((needle, i) => { if (window.includes(needle)) found.add(needles[i]) })
      // Keep the tail, so a needle across two pieces is still seen.
      carry = Buffer.from(window.subarray(Math.max(0, window.length - (longest - 1))))
    }
  } finally {
    closeSync(fd)
  }
  return found
}

/** Programs and libraries directly in a directory; a file is taken as given. */
function programsOf(path) {
  if (!existsSync(path)) fail(`${path} does not exist`)
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .filter((name) => ['', '.exe', '.dll', '.so', '.dylib'].includes(extname(name)))
    .map((name) => join(path, name))
    .filter((file) => statSync(file).isFile())
}

function cmdCheckBinaries(receiptFile, paths) {
  if (!receiptFile || paths.length === 0) fail('usage: check-binaries <receipt-file> <file-or-directory>...')
  const receipt = readJson(receiptFile)
  const forbidden = [...receipt.publicEndpoints, receipt.releasePubkey]
  const files = paths.flatMap(programsOf)
  if (files.length === 0) fail(`no program found under ${paths.join(', ')}`)
  let carriesDryRun = 0
  const problems = []
  for (const file of files) {
    const found = findInFile(file, [...forbidden, receipt.dryRunEndpoint])
    if (found.has(receipt.dryRunEndpoint)) carriesDryRun += 1
    for (const endpoint of receipt.publicEndpoints) {
      if (found.has(endpoint)) problems.push(`${file} still carries the public updater endpoint ${endpoint}`)
    }
    if (found.has(receipt.releasePubkey)) problems.push(`${file} still carries the release updater pubkey`)
    console.log(`${file}: ${found.has(receipt.dryRunEndpoint) ? 'dry run endpoint' : 'no updater endpoint'}`)
  }
  if (problems.length > 0) fail(problems.join('\n'))
  if (carriesDryRun === 0) {
    fail(`none of the ${files.length} programs carries ${receipt.dryRunEndpoint}; the search cannot see the built configuration, so the missing public endpoint proves nothing`)
  }
  console.log(`OK: ${files.length} programs read, none carries a public updater endpoint or the release pubkey, ${carriesDryRun} carry ${receipt.dryRunEndpoint}`)
}

/** In pieces, like the search above: an installer can be large. */
function sha256(file) {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  const fd = openSync(file, 'r')
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** The text of the marker file. Pure, so its promises can be tested. */
export function markerText({ platform, commit, run, receipt, files }) {
  const system = platform === 'windows' ? 'Windows' : 'Linux'
  return [
    'DRY RUN, NOT FOR RELEASE',
    '',
    `These files come from a full dry run of the release workflow (${system}).`,
    `Commit: ${commit}`,
    `Run:    ${run}`,
    '',
    'Every .sig file here was made with a THROWAWAY updater key that existed',
    'for this run only. It does not verify against the public key built into',
    'a released LU, and no installed LU accepts these files as an update.',
    'Never attach any of these files to a release and never put them into',
    'latest.json.',
    '',
    ...(platform === 'windows'
      ? ['The installers carry no code signature: a dry run switches both Windows', 'signing lanes off, whatever the repository holds.', '']
      : []),
    'The app in these installers asks for updates at',
    `  ${receipt.dryRunEndpoint}`,
    'an address that never answers, and trusts the throwaway key alone. It',
    'never asks the public latest.json and accepts no real update, so it does',
    'not update itself: remove it after the test. It is a test build of an',
    'unreleased state, not a release.',
    '',
    'Public half of the throwaway key:',
    receipt.dryRunPubkey,
    '',
    'sha256 of every file:',
    ...files.map(({ name, hash }) => `${hash}  ${name}`),
    '',
  ].join('\n')
}

function cmdCollect(platform, bundleDir, outDir, receiptFile) {
  if (!REQUIRED[platform] || !bundleDir || !outDir || !receiptFile) {
    fail('usage: collect <windows|linux> <bundle-dir> <out-dir> <receipt-file>')
  }
  const receipt = readJson(receiptFile)
  if (!existsSync(bundleDir)) fail(`${bundleDir} does not exist; nothing was bundled`)
  if (existsSync(outDir) && readdirSync(outDir).length > 0) fail(`${outDir} is not empty`)
  mkdirSync(outDir, { recursive: true })
  // bundle/<kind>/<file>. The directories next to the files are the trees the
  // bundlers packed from, not something to hand over.
  const names = []
  for (const kind of readdirSync(bundleDir).sort()) {
    const kindDir = join(bundleDir, kind)
    if (!statSync(kindDir).isDirectory()) continue
    // msi-updater and nsis-updater: with the WebView2 bootstrapper embedded
    // (D10) tauri build packs a second pair of installers without it, only to
    // fill the updater archives in msi/ and nsis/. Same names, not a release
    // file, and `tauri build` does not list them among its bundles either.
    if (kind.endsWith('-updater')) continue
    for (const name of readdirSync(kindDir).sort()) {
      const file = join(kindDir, name)
      if (!statSync(file).isFile() || !KEPT.test(name)) continue
      if (names.includes(name)) fail(`two bundle directories hold a file named ${name}`)
      copyFileSync(file, join(outDir, name))
      names.push(name)
    }
  }
  for (const [what, pattern] of REQUIRED[platform]) {
    if (!names.some((name) => pattern.test(name))) fail(`the build left no file for ${what} under ${bundleDir}`)
  }
  // A signature without its file, or an updater archive without a signature,
  // is a build that went half way.
  for (const name of names) {
    if (name.endsWith('.sig') && !names.includes(name.slice(0, -4))) fail(`${name} has no file it signs`)
  }
  const files = names.map((name) => ({ name, hash: sha256(join(outDir, name)) }))
  writeFileSync(join(outDir, MARKER_FILE), markerText({
    platform,
    commit: process.env.GITHUB_SHA ?? 'unknown',
    run: process.env.GITHUB_RUN_ID ?? 'unknown',
    receipt,
    files,
  }))
  const system = platform === 'windows' ? 'Windows' : 'Linux'
  const summary = [
    `### ${system} dry run, not for release`,
    '',
    `Updater endpoint \`${receipt.dryRunEndpoint}\`, throwaway updater key, no code signature, nothing published.`,
    '',
    ...files.map(({ name, hash }) => `- \`${name}\` sha256 \`${hash}\``),
    '',
  ].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  console.log(summary)
}

function main(argv) {
  const [command, ...args] = argv
  switch (command) {
    case 'rewrite-updater': return cmdRewriteUpdater(args[0], args[1])
    case 'check-binaries': return cmdCheckBinaries(args[0], args.slice(1))
    case 'collect': return cmdCollect(args[0], args[1], args[2], args[3])
    default: fail('usage: release-dry-run.mjs rewrite-updater|check-binaries|collect ...')
  }
}

// Compared as real paths: a temp directory behind a symbolic link would
// otherwise make the script load, do nothing and exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof DryRunError)) throw error
    for (const line of error.message.split('\n')) console.error(`::error::${line}`)
    process.exit(1)
  }
}
