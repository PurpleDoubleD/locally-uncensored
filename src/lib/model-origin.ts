// Neurons' "Get the original" (3.1.3, David 21.11.2026): the model a changed
// model came from is read from its provenance, not guessed from its name.
// "Huihui Qwen 3.8 27B" is the abliterated one; its original is Qwen 3.8 27B.
//
// Order: the GGUF's own base_model fields, then the base_model chain of the
// Hugging Face cards, and only then the cleaned name. Whatever comes out must
// sit at the official maker and carry no tweak mark. When that cannot be shown
// no model is named: better nothing than the wrong one.
//
// Cards and GGUF heads are other people's data. Only the named fields are read,
// every repo name is checked against REPO_ID before it goes into an address,
// and nothing from them is run or rendered as HTML.

import { looksTweaked, saysMore, PLAIN_UPLOADERS } from './original-search'
import type { GgufChoice } from '../api/discover'

export interface OriginBase {
  name?: string | null
  organization?: string | null
  repoUrl?: string | null
}

/** What a GGUF head says about where it came from (commands/neuron/model.rs). */
export interface ModelOrigin {
  basename?: string | null
  sizeLabel?: string | null
  /** general.source.repo_url and the like, best first. */
  sourceRepos?: string[]
  bases?: OriginBase[]
  /** The file's name without its folder: read for the quant only, never sent. */
  file?: string | null
}

export interface OriginCard {
  id: string
  baseModels: string[]
}

/** The network, handed in so the logic is testable. `null` = could not tell. */
export interface OriginIo {
  card: (repo: string) => Promise<OriginCard | null>
  /** Repos whose name matches, for the name fallback. */
  search: (name: string) => Promise<string[] | null>
  /** GGUF repos Hugging Face lists as quantized from this repo. */
  ggufsOf: (repo: string) => Promise<string[] | null>
  choices: (repo: string) => Promise<GgufChoice[] | null>
}

export type OriginalOffer =
  /** A checked original with a checked download. */
  | { kind: 'exact'; name: string; repo: string; ggufRepo: string; file: string; quant?: string }
  /** Not sure enough to name a model: only a search for the base name. */
  | { kind: 'search'; query: string }

/** Makers whose own account is the original. Lower case. */
export const OFFICIAL_MAKERS = [
  'qwen', 'google', 'meta-llama', 'mistralai', 'microsoft', 'deepseek-ai', 'nvidia', 'ibm-granite',
  'zai-org', 'thudm', 'moonshotai', 'openai', 'tiiuae', 'allenai', 'cohereforai', 'coherelabs',
  'minimaxai', 'stepfun-ai', 'baichuan-inc', 'openbmb', 'internlm', 'lgai-exaone', 'bigscience',
  'stabilityai', 'xai-org', 'tencent', 'apple', 'huggingfacetb', 'liquidai', 'nousresearch',
]

/** People and groups known for changed versions: never part of a model's name. */
const TWEAK_AUTHORS = ['huihui', 'huihui-ai', 'hauhaucs', 'hauhau', 'davidau', 'mlabonne', 'failspy', 'thedrummer', 'sao10k']

/** Words dropped from a name in the fallback; the first group also marks a repo. */
const MARK_WORDS = ['abliterated', 'abliteration', 'obliterated', 'uncensored', 'decensored', 'heretic', 'aggressive', 'defiant', 'nsfw', 'mtp']
const FILLER_WORDS = ['the', 'gguf']

const REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/
const SAFE_NAME = /^[\p{L}\p{N} ._-]{2,80}$/u
const MAX_DEPTH = 6
const MAX_GGUF_CHECKS = 4

const orgOf = (repo: string) => repo.split('/')[0].toLowerCase()
const nameOf = (repo: string) => repo.split('/').pop() ?? ''
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9.]/g, '')
const tokens = (t: string) => t.split(/[\s_-]+/).filter(Boolean)

export function isRepoId(text: string): boolean {
  return REPO_ID.test(text) && !text.includes('..')
}

/** "https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/x" → "Qwen/Qwen3.8-27B". */
export function repoFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/?#]+)\/([^/?#]+)/i.exec(url.trim())
  if (!m) return null
  const repo = `${m[1]}/${m[2]}`
  return isRepoId(repo) ? repo : null
}

export function hasTweakMark(repo: string): boolean {
  if (TWEAK_AUTHORS.includes(orgOf(repo))) return true
  const words = tokens(nameOf(repo).toLowerCase())
  if (words.some((w) => TWEAK_AUTHORS.includes(w) || MARK_WORDS.includes(w))) return true
  return looksTweaked(repo)
}

export function isOfficialOriginal(repo: string): boolean {
  return isRepoId(repo) && OFFICIAL_MAKERS.includes(orgOf(repo)) && !hasTweakMark(repo)
}

const SIZE = /^(?:\d+x)?\d+(?:\.\d+)?[bm]$/i

/** The size a name carries ("27B"), or null. */
export function sizeIn(name: string): string | null {
  return tokens(name).find((w) => SIZE.test(w))?.toLowerCase() ?? null
}

/** The fallback: the name without tweak words and authors. Generation, size
 *  and variant stay exactly as they are. Null when it is no plain name. */
export function cleanModelName(basename?: string | null, sizeLabel?: string | null): string | null {
  if (!basename) return null
  const size = sizeLabel?.trim() ?? ''
  const drop = new Set([...TWEAK_AUTHORS, ...MARK_WORDS, ...FILLER_WORDS])
  const kept = tokens(basename).filter((w) => !drop.has(w.toLowerCase()))
  if (kept.length === 0) return null
  if (size && !kept.some((w) => same(w, size))) kept.push(size)
  const name = kept.join(' ')
  return SAFE_NAME.test(name) ? name : null
}

/** "Qwen3.8-27B" → "Qwen 3.8 27B". */
export function displayName(repo: string): string {
  return tokens(nameOf(repo)).join(' ').replace(/^([A-Za-z]+)(\d)/, '$1 $2')
}

type Walk = { root: string } | { root: null; unknown: boolean }

/** Follows base_model up to the maker's own repo. A maker's own fine-tune
 *  (an Instruct on its base model) already is the original. */
async function walk(start: string, io: OriginIo): Promise<Walk> {
  const seen = new Set<string>()
  let repo = start
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!isRepoId(repo) || seen.has(repo.toLowerCase())) return { root: null, unknown: false }
    seen.add(repo.toLowerCase())
    const card = await io.card(repo)
    if (!card) return { root: null, unknown: true }
    const id = isRepoId(card.id) ? card.id : repo
    if (isOfficialOriginal(id) && card.baseModels.every((b) => orgOf(b) === orgOf(id))) return { root: id }
    if (card.baseModels.length !== 1) return { root: null, unknown: false }
    repo = card.baseModels[0]
  }
  return { root: null, unknown: false }
}

const QUANT = /(?:^|[-._])(Q\d+(?:_\d+)?(?:_[A-Z]+)*|IQ\d+_[A-Z0-9]+|BF16|F16|F32)(?=$|[-._])/i

export function quantOfFile(file?: string | null): string | null {
  return file ? QUANT.exec(file.replace(/\.gguf$/i, ''))?.[1].toUpperCase() ?? null : null
}

/** The same quant when it fits, else the largest that fits, else the smallest. */
export function pickChoice(choices: GgufChoice[], quant: string | null, budgetBytes?: number): GgufChoice | null {
  const whole = choices.filter((c) => !c.incomplete && c.quant)
  if (whole.length === 0) return null
  const fits = (c: GgufChoice) => !budgetBytes || c.totalBytes <= budgetBytes
  const own = whole.find((c) => c.quant === quant && fits(c))
  if (own) return own
  if (budgetBytes) {
    const largest = whole.filter(fits).sort((a, b) => b.totalBytes - a.totalBytes)[0]
    if (largest) return largest
    return [...whole].sort((a, b) => a.totalBytes - b.totalBytes)[0]
  }
  return whole.find((c) => c.quant === 'Q4_K_M') ?? whole[0]
}

/** A GGUF shown to be exactly this original, without a tweak mark. */
async function checkedGguf(root: string, quant: string | null, budgetBytes: number | undefined, io: OriginIo) {
  const listed = (await io.ggufsOf(root)) ?? []
  const rank = (r: string) => (orgOf(r) === orgOf(root) ? 0 : PLAIN_UPLOADERS.includes(orgOf(r)) ? 1 : 2)
  // Only what Hugging Face lists: a guessed address answers 401 and would
  // count as a failed run, so nothing would ever be remembered.
  const candidates = [...new Set(listed)]
    .filter((r) => isRepoId(r) && !hasTweakMark(r) && !saysMore(r, nameOf(root).replace(/-/g, ' ')))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_GGUF_CHECKS)
  for (const repo of candidates) {
    const card = await io.card(repo)
    if (!card) continue
    const provenBase = card.baseModels.length === 1 && same(card.baseModels[0], root)
    if (!provenBase && !(orgOf(repo) === orgOf(root) && card.baseModels.length === 0)) continue
    const choices = await io.choices(repo)
    const choice = choices ? pickChoice(choices, quant, budgetBytes) : null
    if (choice) return { ggufRepo: repo, file: choice.path, quant: choice.quant }
  }
  return null
}

function fitsSize(root: string, size?: string | null): boolean {
  const wanted = size?.trim().toLowerCase()
  const has = sizeIn(nameOf(root))
  return !wanted || !has || wanted === has
}

/** The original of a changed model, or what may safely be searched for. */
export async function resolveOriginal(origin: ModelOrigin, io: OriginIo, budgetBytes?: number): Promise<OriginalOffer | null> {
  const clean = cleanModelName(origin.basename, origin.sizeLabel)
  const asSearch: OriginalOffer | null = clean ? { kind: 'search', query: clean } : null

  const fromBases = (origin.bases ?? []).map((b) => {
    const url = repoFromUrl(b.repoUrl)
    if (url) return url
    const guess = b.organization && b.name ? `${b.organization}/${b.name.trim().replace(/\s+/g, '-')}` : null
    return guess && isRepoId(guess) && OFFICIAL_MAKERS.includes(orgOf(guess)) ? guess : null
  }).filter((r): r is string => !!r)
  const fromSource = (origin.sourceRepos ?? []).map(repoFromUrl).filter((r): r is string => !!r)
  const seeds = [...new Set(fromBases.length > 0 ? fromBases : fromSource)]

  const roots = new Set<string>()
  for (const seed of seeds) {
    const w = await walk(seed, io)
    if (w.root) roots.add(w.root)
  }
  // Several different originals: a merge, there is no one original.
  if (roots.size > 1) return asSearch

  let root = [...roots][0] ?? null
  if (!root && clean) {
    const wanted = squash(clean)
    for (const hit of (await io.search(clean)) ?? []) {
      if (!isOfficialOriginal(hit) || squash(nameOf(hit)) !== wanted) continue
      const w = await walk(hit, io)
      if (w.root && same(w.root, hit)) { root = w.root; break }
    }
  }
  if (!root || !fitsSize(root, origin.sizeLabel)) return asSearch

  const gguf = await checkedGguf(root, quantOfFile(origin.file), budgetBytes, io)
  if (!gguf) return { kind: 'search', query: displayName(root) }
  return { kind: 'exact', name: displayName(root), repo: root, ...gguf }
}

/** The fields of a Hugging Face model answer that are read, and no others. */
export function parseCard(raw: string, asked: string): OriginCard | null {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (typeof data !== 'object' || data === null || 'error' in data) return null
  const d = data as { id?: unknown; cardData?: { base_model?: unknown } | null; tags?: unknown }
  const field = d.cardData?.base_model
  const fromCard = typeof field === 'string' ? [field] : Array.isArray(field) ? field.filter((b): b is string => typeof b === 'string') : []
  const fromTags = Array.isArray(d.tags)
    ? d.tags.filter((t): t is string => typeof t === 'string' && /^base_model:[^:]+\/[^:]+$/.test(t)).map((t) => t.slice('base_model:'.length))
    : []
  const baseModels = [...new Set((fromCard.length > 0 ? fromCard : fromTags).map((b) => b.trim()))]
  return { id: typeof d.id === 'string' ? d.id : asked, baseModels }
}
