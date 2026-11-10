// "Restore from the output folder" (3.1.0, C27, Discord D2: a user lost
// the gallery while the files were still in ComfyUI's output folder).
//
// The scan (Rust, commands/gallery_files.rs scan_comfy_output) lists the
// media files and hands over the PNG text chunks. This turns them into gallery
// entries: the prompt and the settings out of the graph ComfyUI stored in the
// picture ("prompt", the API graph it ran) or out of A1111-style "parameters".
// Where a file says nothing, the entry carries its file name and an empty
// prompt; the picture itself is what matters.
//
// The store adds only files it does not list yet (restoreGalleryItems), so
// running this twice adds nothing the second time.

import { backendCall } from '../api/backend'
import { classifyModel } from '../api/comfyui'
import { useCreateStore, type GalleryItem } from '../stores/createStore'

/** One file of the scan, as the Rust command sends it. */
export interface ScannedFile {
  filename: string
  subfolder: string
  kind: 'image' | 'video' | 'audio'
  modifiedMs: number
  bytes: number
  width?: number | null
  height?: number | null
  prompt?: string | null
  parameters?: string | null
}

export interface OutputScan {
  reachable: boolean
  folder: string
  files: ScannedFile[]
  truncated: boolean
}

/** What a picture's own text says about how it was made. */
export interface MadeWith {
  prompt: string
  negativePrompt: string
  model: string
  seed: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  width: number
  height: number
  loras?: { name: string; strength: number }[]
}

type Graph = Record<string, { class_type?: unknown; inputs?: Record<string, unknown> }>

const isLink = (v: unknown): v is [string | number, number] =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number'

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function node(graph: Graph, link: unknown) {
  return isLink(link) ? graph[String(link[0])] : undefined
}

/** The inputs that carry conditioning on, in the order they are followed. */
const CONDITIONING_INPUTS = ['conditioning', 'conditioning_1', 'conditioning_to', 'positive', 'clip_conditioning']
/** The inputs a text encoder takes its words from. */
const TEXT_INPUTS = ['text', 'prompt', 'text_g', 'clip_l', 't5xxl', 'value', 'string', 'text_a']

/** The text at the end of a link: a string widget, or a node that holds one. */
function textOf(graph: Graph, v: unknown, depth = 0): string | null {
  if (typeof v === 'string') return v
  if (depth > 6) return null
  const n = node(graph, v)
  if (!n?.inputs) return null
  for (const k of TEXT_INPUTS) {
    const t = textOf(graph, n.inputs[k], depth + 1)
    if (t !== null) return t
  }
  return null
}

/** The prompt of a conditioning link: through guidance and combine nodes to the encoder. */
function promptOf(graph: Graph, link: unknown, depth = 0): string | null {
  const n = node(graph, link)
  if (!n?.inputs || depth > 8) return null
  const type = String(n.class_type ?? '')
  if (/TextEncode|CLIPText|PromptEncode/i.test(type)) {
    for (const k of TEXT_INPUTS) {
      const t = textOf(graph, n.inputs[k])
      if (t !== null && t.trim() !== '') return t
    }
    return null
  }
  for (const k of CONDITIONING_INPUTS) {
    if (isLink(n.inputs[k])) {
      const t = promptOf(graph, n.inputs[k], depth + 1)
      if (t !== null) return t
    }
  }
  return null
}

const SAMPLER_TYPES = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced|KSampler \(Efficient\))$/

/** The settings a ComfyUI API graph ran with. Null when it is not one. */
export function madeWithFromComfyGraph(json: string): Partial<MadeWith> | null {
  let graph: Graph
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    graph = parsed as Graph
  } catch {
    return null
  }
  const nodes = Object.values(graph).filter((n) => n && typeof n === 'object' && n.inputs && typeof n.inputs === 'object')
  if (nodes.length === 0) return null
  const out: Partial<MadeWith> = {}
  const sampler = nodes.find((n) => SAMPLER_TYPES.test(String(n.class_type ?? '')))
  if (sampler?.inputs) {
    const i = sampler.inputs
    out.seed = num(i.seed) ?? num(i.noise_seed) ?? undefined
    out.steps = num(i.steps) ?? undefined
    out.cfgScale = num(i.cfg) ?? undefined
    out.sampler = str(i.sampler_name) ?? undefined
    out.scheduler = str(i.scheduler) ?? undefined
    let positive: unknown = i.positive
    let negative: unknown = i.negative
    // The custom sampler: noise, guider, sampler and sigmas are nodes of their own.
    const noise = node(graph, i.noise)?.inputs
    if (noise) out.seed ??= num(noise.noise_seed) ?? num(noise.seed) ?? undefined
    const guider = node(graph, i.guider)?.inputs
    if (guider) {
      out.cfgScale ??= num(guider.cfg) ?? undefined
      positive ??= guider.positive ?? guider.conditioning
      negative ??= guider.negative
    }
    const pick = node(graph, i.sampler)?.inputs
    if (pick) out.sampler ??= str(pick.sampler_name) ?? undefined
    const sigmas = node(graph, i.sigmas)?.inputs
    if (sigmas) {
      out.steps ??= num(sigmas.steps) ?? undefined
      out.scheduler ??= str(sigmas.scheduler) ?? undefined
    }
    const p = promptOf(graph, positive)
    if (p !== null) out.prompt = p
    const n = promptOf(graph, negative)
    if (n !== null) out.negativePrompt = n
  }
  if (out.prompt === undefined) {
    // No sampler found, or no link to follow: the first text encoder with words.
    for (const n of nodes) {
      if (!/TextEncode|CLIPText/i.test(String(n.class_type ?? ''))) continue
      const t = TEXT_INPUTS.map((k) => textOf(graph, n.inputs?.[k])).find((x) => x !== null && x.trim() !== '')
      if (t) { out.prompt = t; break }
    }
  }
  for (const n of nodes) {
    const i = n.inputs!
    const model = str(i.ckpt_name) ?? str(i.unet_name)
    if (model && out.model === undefined) out.model = model
    const lat = /Empty.*Latent/i.test(String(n.class_type ?? ''))
    if (lat && out.width === undefined && num(i.width) && num(i.height)) {
      out.width = num(i.width)!
      out.height = num(i.height)!
    }
    const lora = str(i.lora_name)
    if (lora && /Lora/i.test(String(n.class_type ?? ''))) {
      ;(out.loras ??= []).push({ name: lora, strength: num(i.strength_model) ?? num(i.strength) ?? 1 })
    }
  }
  for (const k of Object.keys(out) as (keyof MadeWith)[]) if (out[k] === undefined) delete out[k]
  return out
}

/** The settings of A1111-style "parameters": prompt, "Negative prompt:", then "Key: value, ...". */
export function madeWithFromParameters(text: string): Partial<MadeWith> | null {
  if (!text.trim()) return null
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let last = lines.length - 1
  while (last > 0 && !lines[last].trim()) last--
  const settingsLine = /(^|,\s*)Steps:\s*\d+/.test(lines[last]) ? lines[last] : ''
  const body = settingsLine ? lines.slice(0, last) : lines
  const negAt = body.findIndex((l) => l.startsWith('Negative prompt:'))
  const out: Partial<MadeWith> = {
    prompt: (negAt >= 0 ? body.slice(0, negAt) : body).join('\n').trim(),
  }
  if (negAt >= 0) out.negativePrompt = body.slice(negAt).join('\n').replace(/^Negative prompt:\s*/, '').trim()
  const fields = new Map<string, string>()
  for (const m of settingsLine.matchAll(/([A-Za-z][\w ]*?):\s*("(?:[^"\\]|\\.)*"|[^,]*)/g)) fields.set(m[1].trim().toLowerCase(), m[2].trim())
  const n = (k: string) => { const v = Number(fields.get(k)); return Number.isFinite(v) && fields.has(k) ? v : undefined }
  out.steps = n('steps')
  out.cfgScale = n('cfg scale')
  out.seed = n('seed')
  out.sampler = fields.get('sampler')
  out.scheduler = fields.get('schedule type')
  out.model = fields.get('model')
  const size = /^(\d+)x(\d+)$/.exec(fields.get('size') ?? '')
  if (size) { out.width = Number(size[1]); out.height = Number(size[2]) }
  for (const k of Object.keys(out) as (keyof MadeWith)[]) if (out[k] === undefined) delete out[k]
  return out
}

/** A short stable id for a file, so the same file is the same entry every time. */
export function restoredId(subfolder: string, filename: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const s = `${subfolder}/${filename}`
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return `out-${h1.toString(36)}${h2.toString(36)}`
}

/** The gallery entry for one scanned file. */
export function entryFromScan(f: ScannedFile): GalleryItem {
  const made = (f.prompt ? madeWithFromComfyGraph(f.prompt) : null) ?? (f.parameters ? madeWithFromParameters(f.parameters) : null) ?? {}
  const model = made.model ?? ''
  const item: GalleryItem = {
    id: restoredId(f.subfolder, f.filename),
    type: f.kind,
    filename: f.filename,
    subfolder: f.subfolder,
    comfyType: 'output',
    prompt: made.prompt ?? '',
    negativePrompt: made.negativePrompt ?? '',
    model,
    modelType: model ? classifyModel(model) : 'unknown',
    seed: made.seed ?? 0,
    steps: made.steps ?? 0,
    cfgScale: made.cfgScale ?? 0,
    sampler: made.sampler ?? '',
    scheduler: made.scheduler ?? '',
    width: made.width ?? f.width ?? 0,
    height: made.height ?? f.height ?? 0,
    batchSize: 1,
    createdAt: f.modifiedMs || Date.now(),
  }
  if (made.loras?.length) item.loras = made.loras
  // Without a prompt the tile and the details name the file.
  if (!item.prompt) item.label = f.filename
  return item
}

export interface RestoreResult {
  /** False: LU cannot read this ComfyUI's output folder. */
  reachable: boolean
  folder: string
  /** Media files found. */
  found: number
  /** Entries the gallery did not have and has now. */
  added: number
  /** Found entries that brought their prompt along. */
  withPrompt: number
  /** The scan stopped at its limit. */
  truncated: boolean
}

/** Scan the output folder and add what the gallery does not list yet. */
export async function restoreFromOutputFolder(
  scan: () => Promise<OutputScan> = () => backendCall<OutputScan>('scan_comfy_output'),
): Promise<RestoreResult> {
  const result = await scan()
  if (!result?.reachable) return { reachable: false, folder: result?.folder ?? '', found: 0, added: 0, withPrompt: 0, truncated: false }
  const items = result.files.map(entryFromScan)
  const added = useCreateStore.getState().restoreGalleryItems(items)
  return {
    reachable: true,
    folder: result.folder,
    found: items.length,
    added,
    withPrompt: items.filter((g) => g.prompt).length,
    truncated: result.truncated,
  }
}
