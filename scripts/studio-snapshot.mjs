// The catalogue snapshot of the Create tab, taken over from the web.
//
// The desktop carries the cloud media catalogue of the web as generated files
// under src/lib/render. Nobody edits them by hand: this script writes them from
// one web commit, and web-catalog-source.json next to them records which
// commit that was and the sha256 of every file it wrote. A test without the
// web (web-catalog-source.test.ts) fails as soon as a file no longer has the
// hash the script gave it.
//
// Three of the files hold the catalogue proper: the studio models, the field
// schema of every model, and which schema a classic model reads per variant.
// The web keeps them in the words of the service that renders: each model
// carries the path it runs on there, and the schemas are filed under those
// paths. The app sends none of that anywhere. It needs a key to find the
// schema of a model, and the fields under it. So this script takes the three
// files over with three changes, line by line, and leaves every other byte
// alone:
//
//   1. A path whose first segment names the service itself gets HOUSE as its
//      first segment instead. "Names the service" is what the vendor rule of
//      scripts/check-silent.mjs matches, so this file spells no name. The rest
//      of the path stays, which keeps the keys stable and the step reversible:
//      whoever knows that segment puts it back in front. Applied to the three
//      places a path stands in: the `endpoint` of a model, a key of the schema
//      file, a variant of a classic model.
//   2. A hint (`description`, `x-hint`) loses a web address in brackets and
//      the name of a file store. The web makes the same two cuts for its own
//      pages. Fields, types, limits, choices and defaults are not touched.
//   3. A `label` carries the app's word for the open models where the web
//      carries its own name word (src/lib/unfiltered-mark.ts on both sides).
//
// Three more files come over as they are: the lengths a clip can be booked
// at, the models taken out of the pickers, and the role lists of the studio
// models (that one with the single import line the desktop needs).
//
// What the service is paid per run stays in the files as it is.
//
//   LU_WEB_REPO=<web repo> node scripts/studio-snapshot.mjs --ref <commit>          write
//   LU_WEB_REPO=<web repo> node scripts/studio-snapshot.mjs --ref <commit> --check  compare
//
// With --ref the files are read from that commit with `git show`, so the web
// checkout stays on whatever branch it is on. Without --ref the working tree
// of LU_WEB_REPO is read, and the source records whether it had changes in
// these files. Pass the commit that is live (or the one the release ships
// with), never a branch somebody is still working on.
//
// src/lib/render/__tests__/studio-contract.test.ts runs the same transform
// against LU_WEB_REPO and fails when a file on disk is not what this script
// writes.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULES, findHits } from './check-silent.mjs'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP_DIR = 'src/lib/render'
const WEB_DIR = 'apps/web/lib/render'
const MARK_FILE = 'lib/unfiltered-mark.ts'

/** The files that carry paths of the service and get rewritten line by line. */
export const SNAPSHOT_FILES = ['studio-models.json', 'provider-schemas.json', 'provider-endpoints.json']

/** The files that come over as the web has them, up to the import line in
 *  COPY_LINES. */
export const COPIED_FILES = ['video-durations.json', 'retired-models.ts', 'studio-roles.ts']

/** Every file this script writes, in the order the source lists them. */
export const GENERATED_FILES = [...SNAPSHOT_FILES, ...COPIED_FILES]

/** Where the source of the generated files is recorded. */
export const SOURCE_FILE = 'web-catalog-source.json'

/** The one line a copied file changes: the web reads the studio rules from its
 *  browser catalogue, the desktop from its own contract file. */
const COPY_LINES = {
  'studio-roles.ts': ["from './studio-catalog'", "from './studio-contract'"],
}

/** What stands in front of a path instead of the name of the service. */
export const HOUSE = 'base'

const SERVICE = RULES.find((rule) => rule.id === 'vendor').re

/** The lines of each file a path stands in. The first group is everything in
 *  front of the path, the second its first segment, the third the rest. */
const PATH_LINES = {
  'studio-models.json': /^(\s+"endpoint": ")([^"/]+)(\/[^"]+",?)$/,
  'provider-schemas.json': /^( {2}")([^"/]+)(\/[^"]+": \{)$/,
  'provider-endpoints.json': /^( {4}"\w+": ")([^"/]+)(\/[^"]+",?)$/,
}

const HINT_LINE = /^\s+"(description|x-hint)": "/
const HINT_CUTS = [
  [/\s*\(https?:\/\/[^)\s]*\)/g, ''],
  [/ after re-uploading to [A-Za-z]+ CDN/g, ''],
]

/** One file of the snapshot without the name of the service.
 *  @param {string} name @param {string} text @returns {string} */
export function neutralText(name, text) {
  const pathLine = PATH_LINES[name]
  if (!pathLine) throw new Error(`studio-snapshot: ${name} is not a file of the snapshot`)
  return text.split('\n').map((line) => {
    const path = pathLine.exec(line)
    if (path) return SERVICE.test(`${path[2]}/`) ? `${path[1]}${HOUSE}${path[3]}` : line
    if (name === 'provider-schemas.json' && HINT_LINE.test(line)) {
      return HINT_CUTS.reduce((cut, [from, to]) => cut.replace(from, to), line)
    }
    return line
  }).join('\n')
}

/** The model file with the app's word in its names. Only `label` lines.
 *  @param {string} text @param {string} webWord @param {string} desktopWord @returns {string} */
export function desktopLabels(text, webWord, desktopWord) {
  return text.split('\n').map((line) => (/^\s*"label": /.test(line) ? line.split(webWord).join(desktopWord) : line)).join('\n')
}

/** A copied file as the desktop carries it.
 *  @param {string} name @param {string} text @returns {string} */
export function copiedText(name, text) {
  const swap = COPY_LINES[name]
  if (!swap) return text
  if (text.split(swap[0]).length !== 2) throw new Error(`studio-snapshot: ${name} of the web does not import ${swap[0]} exactly once`)
  return text.replace(swap[0], swap[1])
}

/** Throws unless the texts are a snapshot the app can read: every model and
 *  every variant finds its schema, no two paths fell onto one key, and no
 *  line names the service. The last one fails when a new hint does; then
 *  HINT_CUTS has to learn it.
 *  @param {Record<string, string>} texts @param {number} [sourceKeys] */
export function checkSnapshot(texts, sourceKeys) {
  const models = JSON.parse(texts['studio-models.json'])
  const schemas = JSON.parse(texts['provider-schemas.json'])
  const endpoints = JSON.parse(texts['provider-endpoints.json'])
  if (sourceKeys !== undefined && Object.keys(schemas).length !== sourceKeys) {
    throw new Error(`studio-snapshot: ${sourceKeys} schemas went in, ${Object.keys(schemas).length} came out. Two paths fell onto one key.`)
  }
  for (const [id, model] of Object.entries(models)) {
    if (!schemas[model.endpoint]) throw new Error(`studio-snapshot: no schema for ${id}`)
  }
  for (const [id, variants] of Object.entries(endpoints)) {
    for (const [variant, path] of Object.entries(variants)) {
      if (!schemas[path]) throw new Error(`studio-snapshot: no schema for ${id} ${variant}`)
    }
  }
  const named = Object.keys(texts).flatMap((name) => findHits(texts[name], `${DESKTOP_DIR}/${name}`).filter((hit) => hit.rule === 'vendor'))
  if (named.length > 0) {
    throw new Error(`studio-snapshot: the snapshot would still name the service: ${named.slice(0, 5).map((hit) => `${hit.file}:${hit.line}`).join(', ')}`)
  }
}

/** The word a side builds its open model names with. The web has a name word
 *  of its own since 12.10.2026 (`STATEMENT_NAME_WORD`), next to the word of
 *  its mark; the desktop names and marks with the one word.
 *  @param {string} source @param {string} where @returns {string} */
export function markWord(source, where) {
  for (const name of ['STATEMENT_NAME_WORD', 'STATEMENT_MARK_LABEL']) {
    const found = new RegExp(`export const ${name} =\\s*\\n?\\s*(['"])(.*)\\1`).exec(source)
    if (found && found[2]) return found[2]
  }
  throw new Error(`studio-snapshot: no word for the open models in ${where}`)
}

/** Reads files of the web, from a commit or from the working tree.
 *  @param {string} webRepo @param {string} [ref] */
export function webReader(webRepo, ref) {
  const git = (...args) => execFileSync('git', ['-C', webRepo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (ref) {
    const commit = git('rev-parse', '--verify', `${ref}^{commit}`).trim()
    return {
      read: (path) => git('show', `${commit}:${path}`),
      origin: () => ({ commit, committed: git('show', '-s', '--format=%cI', commit).trim(), dirty: false }),
    }
  }
  return {
    read: (path) => readFileSync(resolve(webRepo, path), 'utf8'),
    origin: (paths) => {
      if (!existsSync(resolve(webRepo, '.git'))) return { commit: null, committed: null, dirty: true }
      const commit = git('rev-parse', 'HEAD').trim()
      return {
        commit,
        committed: git('show', '-s', '--format=%cI', commit).trim(),
        dirty: git('status', '--porcelain', '--', ...paths).trim() !== '',
      }
    },
  }
}

/** Every file as the app carries it, built from the web.
 *  @param {string} webRepo @param {string} [desktopRoot] @param {string} [ref]
 *  @returns {Record<string, string>} */
export function snapshotFromWeb(webRepo, desktopRoot = DESKTOP_ROOT, ref) {
  const web = webReader(webRepo, ref)
  const webWord = markWord(web.read(`apps/web/${MARK_FILE}`), 'the web')
  const desktopWord = markWord(readFileSync(resolve(desktopRoot, 'src', MARK_FILE), 'utf8'), 'the desktop')
  /** @type {Record<string, string>} */
  const texts = {}
  let sourceKeys
  for (const name of SNAPSHOT_FILES) {
    const text = web.read(`${WEB_DIR}/${name}`)
    if (text.split('\n').some((line) => PATH_LINES[name].exec(line)?.[2] === HOUSE)) {
      throw new Error(`studio-snapshot: ${name} of the web already has a path under "${HOUSE}/", the step would not be reversible`)
    }
    if (name === 'provider-schemas.json') sourceKeys = Object.keys(JSON.parse(text)).length
    const neutral = neutralText(name, text)
    texts[name] = name === 'studio-models.json' ? desktopLabels(neutral, webWord, desktopWord) : neutral
  }
  for (const name of COPIED_FILES) texts[name] = copiedText(name, web.read(`${WEB_DIR}/${name}`))
  checkSnapshot(texts, sourceKeys)
  return texts
}

/** sha256 of a generated file, hex. @param {string} text */
export const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** The gate pop-up's offline lists (src/lib/cloud-gate-seed.json). They are
 *  not files of the web: the web builds them from the pricing page in
 *  /api/public/cloud-catalog. So the seed is written from that answer as the
 *  app reads it (header x-lu-client: desktop), with the app's own names and
 *  only the fields the app keeps, and its source and hash are recorded next
 *  to the catalogue's. Run it against the live server of the release.
 *  `--gate <url or saved answer>` */
export const GATE_SEED_FILE = 'src/lib/cloud-gate-seed.json'
export const GATE_URL = 'https://lu-labs.ai/api/public/cloud-catalog'

/** The seed text from one answer of the public catalogue.
 *  @param {any} answer @returns {string} */
export function gateSeedText(answer) {
  if (!answer || answer.version !== 1 || !answer.categories) throw new Error('studio-snapshot: not a public catalogue answer (version 1)')
  const pick = (list, create) => (Array.isArray(list) ? list : []).flatMap((m) => {
    if (!m || typeof m.id !== 'string') return []
    const label = [m.native_label, m.label].find((v) => typeof v === 'string' && v.trim() !== '')?.trim() ?? m.id
    const out = { id: m.id, label }
    if (create) out.kind = m.kind
    if (m.adult === true) out.adult = true
    return [out]
  })
  const c = answer.categories
  const seed = { chat: pick(c.chat, false), code: pick(c.code, false), create: pick(c.create, true) }
  if (!seed.chat.length || !seed.create.length) throw new Error('studio-snapshot: the public catalogue answer has no chat or create models')
  return `${JSON.stringify(seed, null, 1)}\n`
}

/** Reads the answer: a URL (GET with the app's header, read only) or a file.
 *  @param {string} from */
export async function readGateAnswer(from) {
  if (/^https:\/\//.test(from)) {
    const res = await fetch(from, { headers: { 'x-lu-client': 'desktop', 'user-agent': 'LU-catalog-snapshot' } })
    if (!res.ok) throw new Error(`studio-snapshot: ${from} answered ${res.status}`)
    return res.json()
  }
  return JSON.parse(readFileSync(from, 'utf8'))
}

/** The record of where the generated files came from.
 *  @param {Record<string, string>} texts @param {{ commit: string | null, committed: string | null, dirty: boolean }} origin
 *  @param {string | undefined} ref @returns {string} */
export function sourceText(texts, origin, ref, gate) {
  const record = {
    generator: 'scripts/studio-snapshot.mjs',
    note: 'Generated files. Do not edit them by hand: run the generator against the web commit this release ships with.',
    web: { ref: ref ?? null, ...origin },
    files: Object.fromEntries(GENERATED_FILES.map((name) => [name, hashText(texts[name])])),
    ...(gate ? { gate } : {}),
  }
  return `${JSON.stringify(record, null, 2)}\n`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const refAt = args.indexOf('--ref')
  const ref = refAt >= 0 ? args[refAt + 1] : undefined
  if (refAt >= 0 && !ref) {
    process.stderr.write('studio-snapshot: --ref needs a commit.\n')
    process.exit(2)
  }
  const webRepo = process.env.LU_WEB_REPO?.trim() || args.find((arg, i) => !arg.startsWith('--') && i !== refAt + 1 && args[i - 1] !== '--gate')
  if (!webRepo) {
    process.stderr.write('studio-snapshot: set LU_WEB_REPO to the web repository, or pass its path.\n')
    process.exit(2)
  }
  const check = args.includes('--check')
  const repo = resolve(webRepo)
  const texts = snapshotFromWeb(repo, DESKTOP_ROOT, ref)
  const origin = webReader(repo, ref).origin([...GENERATED_FILES.map((name) => `${WEB_DIR}/${name}`), `apps/web/${MARK_FILE}`])
  // The gate seed: written from --gate, else kept as the last run recorded it.
  const gateAt = args.indexOf('--gate')
  const sourcePath = resolve(DESKTOP_ROOT, DESKTOP_DIR, SOURCE_FILE)
  let gate = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, 'utf8')).gate : undefined
  if (gateAt >= 0) {
    const from = args[gateAt + 1] === 'live' ? GATE_URL : args[gateAt + 1]
    if (!from) {
      process.stderr.write('studio-snapshot: --gate needs a URL, a saved answer or `live`.\n')
      process.exit(2)
    }
    texts[GATE_SEED_FILE] = gateSeedText(await readGateAnswer(from))
    gate = { from: /^https:/.test(from) ? from : 'file', file: GATE_SEED_FILE, sha256: hashText(texts[GATE_SEED_FILE]) }
  }
  texts[SOURCE_FILE] = sourceText(texts, origin, ref, gate)
  let differ = 0
  for (const name of [...GENERATED_FILES, SOURCE_FILE, ...(gateAt >= 0 ? [GATE_SEED_FILE] : [])]) {
    const file = name === GATE_SEED_FILE ? resolve(DESKTOP_ROOT, name) : resolve(DESKTOP_ROOT, DESKTOP_DIR, name)
    const same = existsSync(file) && readFileSync(file, 'utf8') === texts[name]
    if (!same) differ++
    if (!same && !check) writeFileSync(file, texts[name])
    process.stdout.write(`studio-snapshot: ${name} ${same ? 'is up to date' : check ? 'DIFFERS' : 'written'}\n`)
  }
  process.stdout.write(`studio-snapshot: web ${origin.commit ?? '(no commit)'}${origin.dirty ? ' with local changes' : ''}\n`)
  process.exit(check && differ ? 1 : 0)
}
