/**
 * Finding, loading and checking ComfyUI workflows for the chat (C60-S5).
 *
 * Sources, and nothing else (David, 09.11.2026):
 *  1. local: LU's own installed workflows, ComfyUI's bundled templates and the
 *     example workflows of node packs ComfyUI already has;
 *  2. CivitAI, model type "Workflows";
 *  3. GitHub, only repositories the Comfy Registry lists (their
 *     `example_workflows` folder), only raw.githubusercontent.com;
 *  4. a link the user wrote into their own message (OpenArt and the like).
 * Rust enforces the hosts again (`workflow_fetch`).
 *
 * Everything that arrives is data. A search hit keeps title, author, numbers
 * and a link, nothing of its description. The file itself is read with limits
 * (4 MB fetched, 2 MB of JSON, 500 nodes), checked by lib/workflow-inspect.ts
 * and never run before the user said yes on the card.
 */
import JSZip from 'jszip'
import { backendCall, comfyuiUrl, isTauri, localFetch } from './backend'
import { loadNodeDefs } from './workflow-import'
import { packsForMissingTypes } from './custom-node-packs'
import {
  CUSTOM_NODE_REGISTRY, getAudioBundles, getImageBundles, getLipsyncBundles, getLoraAddonBundles,
  getMotionBundles, getUpscaleBundles, getVideoBundles, type ModelBundle,
} from './model-bundles'
import { readPngTextChunks } from '../lib/character-card'
import {
  WORKFLOW_MAX_BYTES, cleanName, collectWorkflow, inspectWorkflow, typesToAsk,
  type CatalogFile, type CollectResult, type InspectReport, type InstalledNode, type LuPackHit,
  type RegistryHit, type WorkflowSourceInfo,
} from '../lib/workflow-inspect'
import { useWorkflowStore } from '../stores/workflowStore'

// ── Fetching through Rust ───────────────────────────────────────────────────

async function invokeFetch(url: string, opts: { userLink?: boolean; auth?: string | null } = {}): Promise<Uint8Array> {
  if (!isTauri()) throw new Error('Finding workflows online works in the desktop app only.')
  const bytes = await backendCall<number[]>('workflow_fetch', { url, userLink: opts.userLink === true, authToken: opts.auth ?? null })
  return new Uint8Array(bytes)
}

async function fetchJson(url: string, auth?: string | null): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await invokeFetch(url, { auth })))
}

// ── Candidates ──────────────────────────────────────────────────────────────

export type CandidateSource = WorkflowSourceInfo['kind']

export interface Candidate {
  id: string
  source: CandidateSource
  title: string
  author?: string
  date?: string
  downloads?: number
  baseModel?: string
  /** Where the file is read from. */
  fileUrl?: string
  /** For a local LU workflow: its id; for a ComfyUI template: its path. */
  localRef?: string
  sha256?: string
  sizeKB?: number
  license?: string
  host?: string
  page?: string
  /** A link the user sent, fetched with `userLink`. */
  userLink?: boolean
}

const candidates = new Map<string, Candidate>()
let seq = 0
function remember(c: Omit<Candidate, 'id'>, prefix: string): Candidate {
  seq += 1
  const id = `${prefix}${seq}`
  const full = { ...c, id, title: cleanName(c.title, 80), ...(c.author ? { author: cleanName(c.author, 40) } : {}) }
  candidates.set(id, full)
  if (candidates.size > 200) candidates.delete(candidates.keys().next().value as string)
  return full
}

export function candidateById(id: string): Candidate | undefined {
  return candidates.get(id.trim())
}

/** Test seam. */
export function __resetCandidatesForTests(): void {
  candidates.clear()
  checked.clear()
  seq = 0
}

function words(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9äöüß.]+/).filter((w) => w.length >= 2 && !STOP.has(w))
}
const STOP = new Set(['workflow', 'workflows', 'comfyui', 'comfy', 'for', 'and', 'the', 'mit', 'und', 'für', 'der', 'die', 'das', 'ein', 'eine', 'einen'])

function matches(text: string, ws: string[]): number {
  const t = text.toLowerCase()
  return ws.filter((w) => t.includes(w)).length
}

// ── Source 1: local ─────────────────────────────────────────────────────────

export async function searchLocal(query: string): Promise<Candidate[]> {
  const ws = words(query)
  const out: Candidate[] = []
  for (const wf of useWorkflowStore.getState().installedWorkflows) {
    if (ws.length && matches(`${wf.name} ${wf.modelTypes.join(' ')} ${wf.mode}`, ws) === 0) continue
    out.push(remember({ source: 'lu', title: wf.name, localRef: wf.id }, 'lu'))
  }
  // ComfyUI's bundled templates (index.json of the workflow templates package).
  try {
    const res = await localFetch(comfyuiUrl('/templates/index.json'), { timeoutMs: 8000 })
    if (res.ok) {
      const index: unknown = await res.json()
      const hits: { name: string; title: string; score: number }[] = []
      for (const cat of Array.isArray(index) ? index : []) {
        const list = cat && typeof cat === 'object' ? (cat as Record<string, unknown>).templates : null
        for (const t of Array.isArray(list) ? list : []) {
          if (!t || typeof t !== 'object') continue
          const rec = t as Record<string, unknown>
          if (typeof rec.name !== 'string' || !/^[\w.-]+$/.test(rec.name)) continue
          const title = typeof rec.title === 'string' ? rec.title : rec.name
          const tags = Array.isArray(rec.tags) ? rec.tags.join(' ') : ''
          const models = Array.isArray(rec.models) ? rec.models.join(' ') : ''
          const score = matches(`${rec.name} ${title} ${tags} ${models}`, ws)
          if (ws.length && score === 0) continue
          hits.push({ name: rec.name, title, score })
        }
      }
      hits.sort((a, b) => b.score - a.score)
      for (const h of hits.slice(0, 8)) {
        out.push(remember({ source: 'comfy-template', title: h.title, localRef: `/templates/${h.name}.json` }, 'ct'))
      }
    }
  } catch { /* ComfyUI not running: no templates */ }
  // Example workflows of the packs ComfyUI already loads.
  try {
    const res = await localFetch(comfyuiUrl('/api/workflow_templates'), { timeoutMs: 8000 })
    if (res.ok) {
      const map: unknown = await res.json()
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        for (const [pack, files] of Object.entries(map as Record<string, unknown>)) {
          if (!/^[\w.-]+$/.test(pack) || !Array.isArray(files)) continue
          for (const f of files) {
            if (typeof f !== 'string' || !/^[\w. -]+$/.test(f)) continue
            if (ws.length && matches(`${pack} ${f}`, ws) === 0) continue
            out.push(remember({ source: 'comfy-template', title: `${pack}: ${f}`, localRef: `/api/workflow_templates/${encodeURIComponent(pack)}/${encodeURIComponent(f)}.json` }, 'ct'))
          }
        }
      }
    }
  } catch { /* none */ }
  return out.slice(0, 12)
}

// ── Source 2: CivitAI ───────────────────────────────────────────────────────

function asRec(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} }
function asArr(v: unknown): Record<string, unknown>[] { return Array.isArray(v) ? v.map(asRec) : [] }
function str(v: unknown): string | undefined { return typeof v === 'string' ? v : undefined }
function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined }

/** CivitAI's commercial-use flags in words. */
export function civitaiLicense(item: Record<string, unknown>): string {
  const commercial = item.allowCommercialUse
  const list = Array.isArray(commercial) ? commercial.filter((x): x is string => typeof x === 'string') : typeof commercial === 'string' ? [commercial] : []
  const parts: string[] = []
  parts.push(list.length === 0 || list.includes('None') ? 'no commercial use' : `commercial use: ${list.join(', ')}`)
  if (item.allowDerivatives === false) parts.push('no derivatives')
  if (item.allowNoCredit === false) parts.push('credit the author')
  return `CivitAI terms, ${parts.join(', ')}`
}

export async function searchCivitai(query: string): Promise<Candidate[]> {
  const { civitaiHost, civitaiApiKey } = useWorkflowStore.getState()
  const host = civitaiHost === 'civitai.red' ? 'civitai.red' : 'civitai.com'
  const params = new URLSearchParams({ types: 'Workflows', query: query.slice(0, 80), limit: '10', sort: 'Most Downloaded', nsfw: 'true' })
  const data = await fetchJson(`https://${host}/api/v1/models?${params}`, civitaiApiKey || null)
  const out: Candidate[] = []
  for (const item of asArr(asRec(data).items)) {
    const version = asArr(item.modelVersions)[0]
    if (!version) continue
    const file = asArr(version.files).find((f) => /\.(zip|json|png)$/i.test(str(f.name) ?? ''))
    const fileUrl = str(file?.downloadUrl)
    const sizeKB = num(file?.sizeKB)
    if (!file || !fileUrl || (sizeKB !== undefined && sizeKB > 4096)) continue
    const sha = str(asRec(file.hashes).SHA256)
    out.push(remember({
      source: 'civitai',
      title: str(item.name) ?? 'CivitAI workflow',
      author: str(asRec(item.creator).username),
      date: str(version.publishedAt)?.slice(0, 10),
      downloads: num(asRec(item.stats).downloadCount),
      baseModel: str(version.baseModel),
      fileUrl,
      sha256: sha && /^[a-f0-9]{64}$/i.test(sha) ? sha.toLowerCase() : undefined,
      sizeKB: sizeKB !== undefined ? Math.round(sizeKB) : undefined,
      license: civitaiLicense(item),
      host,
      page: typeof item.id === 'number' ? `https://${host}/models/${item.id}` : undefined,
    }, 'civ'))
  }
  return out
}

// ── Source 3: GitHub repos of the Comfy Registry ────────────────────────────

const GH_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

export async function searchGithub(query: string): Promise<Candidate[]> {
  const params = new URLSearchParams({ search: query.slice(0, 80), limit: '8' })
  const data = await fetchJson(`https://api.comfy.org/nodes/search?${params}`)
  const out: Candidate[] = []
  const ws = words(query)
  for (const node of asArr(asRec(data).nodes).slice(0, 5)) {
    const status = `${str(node.status) ?? ''} ${str(asRec(node.latest_version).status) ?? ''}`
    if (/Banned|Deleted|Flagged/i.test(status)) continue
    const repo = GH_REPO.exec(str(node.repository) ?? '')
    if (!repo) continue
    const [, owner, name] = repo
    for (const folder of ['example_workflows', 'workflows', 'examples']) {
      let listing: unknown
      try {
        listing = await fetchJson(`https://api.github.com/repos/${owner}/${name}/contents/${folder}`)
      } catch { continue }
      for (const f of asArr(listing)) {
        const fname = str(f.name) ?? ''
        const raw = str(f.download_url) ?? ''
        const size = num(f.size) ?? 0
        if (!/\.json$/i.test(fname) || !raw.startsWith('https://raw.githubusercontent.com/') || size > WORKFLOW_MAX_BYTES) continue
        out.push(remember({
          source: 'github',
          title: `${name}: ${fname.replace(/\.json$/i, '')}`,
          author: owner,
          downloads: num(node.downloads),
          fileUrl: raw,
          sizeKB: Math.round(size / 1024),
          license: (() => { const l = str(node.license); try { const p = l ? JSON.parse(l) : null; return typeof p?.text === 'string' ? p.text : l } catch { return l } })(),
          host: 'raw.githubusercontent.com',
          page: `https://github.com/${owner}/${name}/tree/HEAD/${folder}`,
        }, 'gh'))
      }
      break
    }
  }
  // The registry ranks packs, not files: put the files whose name fits first.
  return out.sort((a, b) => matches(b.title, ws) - matches(a.title, ws)).slice(0, 10)
}

// ── Source 4: a link of the user ────────────────────────────────────────────

/** A github.com/…/blob/… link becomes its raw file. */
export function rawLink(url: string): string {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/(.+)$/.exec(url.trim())
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : url.trim()
}

/** True when the user wrote this address into their own message. The model
 *  cannot widen the sources by naming a link it read somewhere. */
export function linkIsFromUser(url: string, userText: string): boolean {
  const u = url.trim()
  if (!/^https:\/\//i.test(u) || u.length > 600) return false
  return userText.includes(u)
}

export function userLinkCandidate(url: string): Candidate {
  const host = (() => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } })()
  return remember({ source: 'user-link', title: url.split('/').pop() || host, fileUrl: rawLink(url), host, userLink: true, page: url }, 'url')
}

// ── Loading the file ────────────────────────────────────────────────────────

export interface LoadedWorkflow {
  json: unknown
  text: string
  bytes: number
  /** SHA-256 of the JSON text, kept with the installed workflow. */
  sha256: string
  /** The source's published checksum matched the fetched bytes. */
  publishedShaOk?: boolean
  /** More than one workflow in an archive: the first one is used. */
  others: number
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
const isPngBytes = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

interface ZipStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): ZipStream
  on(event: 'error', cb: (e: unknown) => void): ZipStream
  on(event: 'end', cb: () => void): ZipStream
  pause(): ZipStream
  resume(): ZipStream
}

/** One archive member, inflated with a hard cap so a zip bomb stops early. */
async function readMember(file: JSZip.JSZipObject, cap: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const parts: Uint8Array[] = []
    let total = 0
    let done = false
    // `internalStream` is JSZip's own streaming reader (3.x); its typings
    // leave it out. It inflates piece by piece, so the cap stops a bomb.
    const stream = (file as unknown as { internalStream: (t: 'uint8array') => ZipStream }).internalStream('uint8array')
    stream.on('data', (chunk: Uint8Array) => {
      if (done) return
      total += chunk.length
      if (total > cap) { done = true; stream.pause(); resolve(null); return }
      parts.push(chunk)
    })
    stream.on('error', () => { if (!done) { done = true; resolve(null) } })
    stream.on('end', () => {
      if (done) return
      done = true
      const out = new Uint8Array(total)
      let at = 0
      for (const p of parts) { out.set(p, at); at += p.length }
      resolve(out)
    })
    stream.resume()
  })
}

async function workflowTextsFromPng(bytes: Uint8Array): Promise<string[]> {
  try {
    const chunks = await readPngTextChunks(bytes)
    // The UI format first, it carries the models list; the API format second.
    return ['workflow', 'prompt'].map((k) => chunks.find((c) => c.keyword === k)?.text).filter((t): t is string => !!t)
  } catch {
    return []
  }
}

/** The workflow texts inside fetched bytes: plain JSON, a PNG with the
 *  workflow in its metadata, or a zip of those. */
export async function workflowTexts(bytes: Uint8Array): Promise<string[]> {
  if (isPngBytes(bytes)) return workflowTextsFromPng(bytes)
  if (isZip(bytes)) {
    const zip = await JSZip.loadAsync(bytes)
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && !/(^|\/)(__MACOSX|\.)/.test(n))
    if (names.length > 50) throw new Error('The archive holds more than 50 files.')
    const texts: string[] = []
    for (const n of names.filter((x) => /\.json$/i.test(x)).sort()) {
      const data = await readMember(zip.files[n], WORKFLOW_MAX_BYTES)
      if (data) texts.push(new TextDecoder().decode(data))
    }
    for (const n of names.filter((x) => /\.png$/i.test(x)).sort()) {
      if (texts.length) break
      const data = await readMember(zip.files[n], 16 * 1024 * 1024)
      if (data) texts.push(...await workflowTextsFromPng(data))
    }
    return texts
  }
  return [new TextDecoder().decode(bytes)]
}

export async function loadCandidate(c: Candidate): Promise<LoadedWorkflow> {
  let raw: Uint8Array
  let publishedShaOk: boolean | undefined
  if (c.source === 'lu') {
    const wf = useWorkflowStore.getState().installedWorkflows.find((w) => w.id === c.localRef)
    if (!wf) throw new Error('That workflow is no longer installed.')
    raw = new TextEncoder().encode(JSON.stringify(wf.workflow))
  } else if (c.source === 'comfy-template') {
    const res = await localFetch(comfyuiUrl(c.localRef ?? ''), { timeoutMs: 15_000 })
    if (!res.ok) throw new Error(`ComfyUI answered HTTP ${res.status} for that template.`)
    raw = new Uint8Array(await res.arrayBuffer())
  } else {
    if (!c.fileUrl) throw new Error('This hit has no file to read.')
    const auth = c.source === 'civitai' ? useWorkflowStore.getState().civitaiApiKey || null : null
    raw = await invokeFetch(c.fileUrl, { userLink: c.userLink, auth })
    if (c.sha256) publishedShaOk = (await sha256Hex(raw)) === c.sha256
  }
  if (raw.length > 4 * 1024 * 1024) throw new Error('The file is larger than 4 MB.')
  const texts = (await workflowTexts(raw)).filter((t) => t.length <= WORKFLOW_MAX_BYTES)
  const parsed: { text: string; json: unknown }[] = []
  for (const text of texts) {
    try {
      const json: unknown = JSON.parse(text)
      if (collectWorkflow(json).ok) parsed.push({ text, json })
    } catch { /* not JSON */ }
  }
  if (parsed.length === 0) {
    throw new Error(c.source === 'user-link'
      ? 'That link is not a workflow file. Ask the user to download the workflow (.json or .png) and attach it, or to send the direct file link.'
      : 'No ComfyUI workflow found in that file.')
  }
  const first = parsed[0]
  const enc = new TextEncoder().encode(first.text)
  return { json: first.json, text: first.text, bytes: enc.length, sha256: await sha256Hex(enc), publishedShaOk, others: parsed.length - 1 }
}

// ── What ComfyUI, LU and the registry know ──────────────────────────────────

/** The choices of every list input of a node definition, old and new shape. */
export function comboOptions(def: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const input = asRec(asRec(def).input)
  for (const group of [asRec(input.required), asRec(input.optional)]) {
    for (const [name, spec] of Object.entries(group)) {
      if (!Array.isArray(spec)) continue
      const [first, extra] = spec
      if (Array.isArray(first)) out[name] = first.filter((x): x is string => typeof x === 'string')
      else if (first === 'COMBO' && Array.isArray(asRec(extra).options)) out[name] = (asRec(extra).options as unknown[]).filter((x): x is string => typeof x === 'string')
    }
  }
  return out
}

async function installedNodes(types: string[]): Promise<Record<string, InstalledNode> | null> {
  const defs = await loadNodeDefs(types)
  if (!defs) return null
  const out: Record<string, InstalledNode> = {}
  for (const [type, def] of Object.entries(defs)) {
    out[type] = { module: str(asRec(def).python_module) ?? '', options: comboOptions(def) }
  }
  return out
}

async function registryLookup(types: string[]): Promise<Record<string, RegistryHit | null>> {
  const out: Record<string, RegistryHit | null> = {}
  for (const type of types.slice(0, 15)) {
    // A name like an identifier only: the registry is asked by path.
    if (!/^[\w .+\-|()]{1,100}$/.test(type)) { out[type] = null; continue }
    try {
      const node = asRec(await fetchJson(`https://api.comfy.org/comfy-nodes/${encodeURIComponent(type)}/node`))
      const pack = str(node.id) ?? str(node.name)
      if (!pack) { out[type] = null; continue }
      const license = (() => { const l = str(node.license); try { const p = l ? JSON.parse(l) : null; return typeof p?.text === 'string' ? p.text : typeof p?.file === 'string' ? `see ${p.file} in the repository` : l } catch { return l } })()
      out[type] = {
        pack,
        repository: str(node.repository),
        publisher: str(asRec(node.publisher).name),
        downloads: num(node.downloads),
        status: str(node.status),
        versionStatus: str(asRec(node.latest_version).status),
        license,
      }
    } catch {
      out[type] = null
    }
  }
  return out
}

let catalogIndex: Map<string, CatalogFile> | null = null
/** Every file of LU's model catalog by its file name. */
export function catalogFile(filename: string): CatalogFile | null {
  if (!catalogIndex) {
    catalogIndex = new Map()
    const all: ModelBundle[] = [
      ...getImageBundles(), ...getVideoBundles(), ...getLoraAddonBundles(), ...getAudioBundles(),
      ...getLipsyncBundles(), ...getMotionBundles(), ...getUpscaleBundles(),
    ]
    for (const b of all) {
      for (const f of b.files) {
        if (!f.filename || !f.downloadUrl || !f.subfolder || catalogIndex.has(f.filename)) continue
        catalogIndex.set(f.filename, {
          filename: f.filename, subfolder: f.subfolder, url: f.downloadUrl,
          sizeGB: f.sizeGB, sizeBytes: f.sizeBytes, sha256: f.sha256, bundle: b.name,
        })
      }
    }
  }
  return catalogIndex.get(filename) ?? null
}

// ── Checking ────────────────────────────────────────────────────────────────

export interface Checked {
  candidate: Candidate
  loaded: LoadedWorkflow
  collected: Extract<CollectResult, { ok: true }>
  report: InspectReport
  at: number
}

const checked = new Map<string, Checked>()

export function checkedById(id: string): Checked | undefined {
  return checked.get(id.trim())
}

function luPackHits(types: string[]): LuPackHit[] {
  return packsForMissingTypes(types).installable.map((p) => ({
    ...p, ...(CUSTOM_NODE_REGISTRY[p.key]?.commit ? { commit: CUSTOM_NODE_REGISTRY[p.key].commit } : {}),
  }))
}

/** Load a candidate and run the traffic light check on it. */
export async function checkCandidate(c: Candidate): Promise<Checked> {
  const loaded = await loadCandidate(c)
  const collected = collectWorkflow(loaded.json)
  if (!collected.ok) throw new Error(collected.reason)
  const types = typesToAsk(collected.nodes)
  const installed = await installedNodes(types)
  const missing = installed ? types.filter((t) => !installed[t]) : []
  const luPacks = luPackHits(missing)
  const luTypes = new Set(luPacks.flatMap((p) => p.types))
  const registry = installed && isTauri() ? await registryLookup(missing.filter((t) => !luTypes.has(t))) : {}
  const report = inspectWorkflow({
    bytes: loaded.bytes,
    format: collected.format,
    nodes: collected.nodes,
    models: collected.models,
    installed,
    luPacks,
    registry,
    catalog: catalogFile,
    source: {
      kind: c.source,
      ...(c.host ? { host: c.host } : {}),
      ...(c.page ?? c.fileUrl ? { url: c.page ?? c.fileUrl } : {}),
      ...(c.author ? { author: c.author } : {}),
      ...(c.license ? { license: c.license } : {}),
      ...(c.sha256 ? { publishedSha256: c.sha256, publishedShaOk: loaded.publishedShaOk } : {}),
    },
  })
  const result: Checked = { candidate: c, loaded, collected, report, at: Date.now() }
  checked.set(c.id, result)
  return result
}
