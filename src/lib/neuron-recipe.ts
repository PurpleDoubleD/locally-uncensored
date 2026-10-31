// Neuron recipes (3.0.9, N2): what people share as "coordinates", read and
// written by LU.
//
// Since late October 2026 people pass single MLP neurons around as short
// codes, "L13N7956-1.0 L14N8949+1.0" (neuronary.org, neuron-explorer),
// "14:8949:+1.0" (gguf-neuron-explorer) or "L9 N9009 +0.7". LU reads those,
// and writes its own sliders the same way:
//
//   @cheerful+0.60     a ready slider, by its id
//   F11690+0.80        a feature of the model's sparse autoencoder
//   L13N7956-1.00      layer 13, MLP neuron 7956, dose −1
//   own sliders        only in the link, as their example lines
//
// One line to copy: "LU neurons · <model> · <coordinates>", and a link
// "locallyuncensored://neuron?v=1&model=…&c=…&o=…" that also carries own
// sliders. A recipe holds numbers and example sentences, nothing else: no
// path, no address, no command. Everything is checked strictly; whatever
// does not fit is refused with the reason, never guessed.

export type RecipeEntry =
  | { kind: 'preset'; id: string; strength: number }
  | { kind: 'feature'; feature: number; strength: number }
  | { kind: 'neuron'; layer: number; neuron: number; dose: number }
  | { kind: 'own'; name: string; more: string[]; less: string[]; strength: number }

export interface Recipe {
  /** The model the recipe was made on, as its maker named it. */
  model: string | null
  entries: RecipeEntry[]
}

export type RecipeParse =
  | { ok: true; recipe: Recipe; notes: string[] }
  | { ok: false; error: string }

export const RECIPE_SCHEME = 'locallyuncensored'
export const RECIPE_HOST = 'neuron'
export const RECIPE_MAX_CHARS = 8000
export const RECIPE_MAX_ENTRIES = 24
/** Neuron doses are in median residual norms (the neuronary unit); shared
 *  recipes stay within about ±1.2, and ±3 already wrecks any model. */
export const NEURON_MAX_DOSE = 3
const MAX_LAYER = 511
const MAX_INDEX = 1 << 20
const OWN_MAX_LINES = 40
const OWN_MAX_LINE = 300
const OWN_MAX_NAME = 40
const MODEL_MAX = 120

const NUM = '([-+−]?\\d{1,2}(?:\\.\\d{1,4})?)'
// A slider id may hold dashes, so its value needs its sign: "@detailed-0.4"
// is detailed at −0.4, not a slider called "detailed-".
const SIGNED = '([-+−]\\d{1,2}(?:\\.\\d{1,4})?)'
const RE_PRESET = new RegExp(`^@([a-z][a-z0-9-]{0,31}?)${SIGNED}$`)
const RE_FEATURE = new RegExp(`^F(\\d{1,7})${NUM}$`, 'i')
const RE_NEURON = new RegExp(`^L(\\d{1,3})N(\\d{1,7})${NUM}$`, 'i')
const RE_COLON = new RegExp(`^(\\d{1,3}):(\\d{1,7}):${NUM}$`)
const RE_MODEL = /^[\p{L}\p{N} ._\-/:()+]+$/u

function num(s: string): number {
  return Number(s.replace('−', '-'))
}

/** Control characters other than line breaks and tabs: never in a recipe. */
function hasControl(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(s)
}

function short(s: string): string {
  return s.length > 24 ? `${s.slice(0, 24)}…` : s
}

/** Tokens like "L9", "N9009", "+0.7" written apart are glued back together,
 *  so "L9 N9009 +0.7" reads as one coordinate. */
function glue(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^L\d{1,3}$/i.test(t) && /^N\d{1,7}$/i.test(tokens[i + 1] ?? '') && /^[-+−]?\d/.test(tokens[i + 2] ?? '')) {
      out.push(`${t}${tokens[i + 1]}${tokens[i + 2]}`)
      i += 2
    } else if (/^L\d{1,3}N\d{1,7}$/i.test(t) && /^[-+−]\d/.test(tokens[i + 1] ?? '')) {
      out.push(`${t}${tokens[i + 1]}`)
      i += 1
    } else if (/^L\d{1,3}$/i.test(t) && /^N\d{1,7}$/i.test(tokens[i + 1] ?? '')) {
      // "L34 N3838" without a strength, as articles write it.
      out.push(`${t}${tokens[i + 1]}`)
      i += 1
    } else out.push(t)
  }
  return out
}

/** Why a code that looks like a coordinate is not one LU can use. */
function unsupported(t: string): string | null {
  if (/^L\d+E\d+N\d+/i.test(t) || /^\d+:E\d+:/i.test(t)) return `“${short(t)}” is a neuron inside a mixture-of-experts layer. LU can only push neurons of dense layers.`
  if (/^\d+:\d+:x/i.test(t) || /^\d+:H\d+/i.test(t)) return `“${short(t)}” scales a neuron or head (gain). LU only adds directions, so it cannot apply this one.`
  if (/^\d+:dir:/i.test(t)) return `“${short(t)}” names a direction file from another program. Make it in LU from examples instead.`
  return null
}

function checkStrength(t: string, v: number, max: number): string | null {
  if (!Number.isFinite(v)) return `“${short(t)}” has no valid number.`
  if (Math.abs(v) > max) return `“${short(t)}”: ${v} is outside −${max} … +${max}.`
  return null
}

/** One coordinate token, or the reason it is refused. */
export function parseToken(raw: string, presetIds: ReadonlySet<string>): RecipeEntry | string {
  const t = raw.trim().replace(/,$/, '')
  let m = RE_PRESET.exec(t)
  if (m) {
    if (!presetIds.has(m[1])) return `“${short(t)}”: LU has no ready slider called “${m[1]}”.`
    const s = num(m[2])
    return checkStrength(t, s, 1) ?? { kind: 'preset', id: m[1], strength: s }
  }
  m = RE_FEATURE.exec(t)
  if (m) {
    const f = Number(m[1])
    if (f >= MAX_INDEX) return `“${short(t)}”: feature number too large.`
    const s = num(m[2])
    return checkStrength(t, s, 1) ?? { kind: 'feature', feature: f, strength: s }
  }
  m = RE_NEURON.exec(t) ?? RE_COLON.exec(t)
  if (m) {
    const layer = Number(m[1])
    const neuron = Number(m[2])
    if (layer > MAX_LAYER || neuron >= MAX_INDEX) return `“${short(t)}”: layer or neuron number too large.`
    const d = num(m[3])
    return checkStrength(t, d, NEURON_MAX_DOSE) ?? { kind: 'neuron', layer, neuron, dose: d }
  }
  return unsupported(t) ?? `“${short(t)}” is not a coordinate LU knows. Examples: L14N8949+1.0, @cheerful+0.5, F11690+0.8.`
}

function cleanLines(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > OWN_MAX_LINES) return null
  const out: string[] = []
  for (const l of v) {
    if (typeof l !== 'string') return null
    const s = l.trim()
    if (!s || s.length > OWN_MAX_LINE || hasControl(s) || /[\r\n]/.test(s)) return null
    out.push(s)
  }
  return out
}

/** Own sliders from the link's `o` parameter: a JSON list of
 *  {n: name, s: strength, m: [more…], l: [less…]}. */
function parseOwn(json: string): RecipeEntry[] | string {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return 'The own sliders in this link are damaged.'
  }
  if (!Array.isArray(data) || data.length > 8) return 'The own sliders in this link are damaged.'
  const out: RecipeEntry[] = []
  for (const d of data) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return 'The own sliders in this link are damaged.'
    const keys = Object.keys(d)
    if (keys.some((k) => !['n', 's', 'm', 'l'].includes(k))) return 'The own sliders in this link carry fields LU does not read.'
    const { n, s, m, l } = d as Record<string, unknown>
    if (typeof n !== 'string' || !n.trim() || n.trim().length > OWN_MAX_NAME || hasControl(n)) return 'An own slider in this link has no usable name.'
    if (typeof s !== 'number' || !Number.isFinite(s) || Math.abs(s) > 1) return `Own slider “${short(n)}”: strength outside −1 … +1.`
    const more = cleanLines(m)
    const less = cleanLines(l)
    if (!more || !less) return `Own slider “${short(n)}”: needs 1–${OWN_MAX_LINES} example lines on each side, each up to ${OWN_MAX_LINE} characters.`
    out.push({ kind: 'own', name: n.trim(), more, less, strength: s })
  }
  return out
}

function entryKey(e: RecipeEntry): string {
  switch (e.kind) {
    case 'preset': return `p:${e.id}`
    case 'feature': return `f:${e.feature}`
    case 'neuron': return `n:${e.layer}:${e.neuron}`
    case 'own': return `o:${e.name.toLowerCase()}`
  }
}

function finish(model: string | null, entries: RecipeEntry[], extra: string[] = []): RecipeParse {
  if (entries.length === 0) return { ok: false, error: 'No coordinates found. Paste a line like “L14N8949+1.0 @cheerful+0.5”, or an LU link.' }
  const notes: string[] = [...extra]
  const byKey = new Map<string, RecipeEntry>()
  for (const e of entries) {
    const k = entryKey(e)
    if (byKey.has(k)) notes.push(`${k.startsWith('n:') ? 'A neuron' : 'A slider'} appears twice; the last value counts.`)
    byKey.set(k, e)
  }
  if (byKey.size > RECIPE_MAX_ENTRIES) return { ok: false, error: `More than ${RECIPE_MAX_ENTRIES} coordinates. LU takes at most ${RECIPE_MAX_ENTRIES} at once.` }
  if (model !== null && (model.length > MODEL_MAX || !RE_MODEL.test(model))) return { ok: false, error: 'The model name in this recipe has characters LU does not accept.' }
  return { ok: true, recipe: { model, entries: [...byKey.values()] }, notes: [...new Set(notes)] }
}

/** Neurons named without a strength get the dose shared recipes use. */
export const NEURON_DEFAULT_DOSE = 1
const RE_NEURON_BARE = /^L(\d{1,3})N(\d{1,7})$/i

function parseCoords(text: string, presetIds: ReadonlySet<string>, notes: string[] = []): RecipeEntry[] | string {
  const tokens = glue(text.split(/[\s,;]+/).filter(Boolean))
  const out: RecipeEntry[] = []
  for (const t of tokens) {
    const bare = RE_NEURON_BARE.exec(t)
    if (bare) {
      const layer = Number(bare[1])
      const neuron = Number(bare[2])
      if (layer > MAX_LAYER || neuron >= MAX_INDEX) return `“${short(t)}”: layer or neuron number too large.`
      out.push({ kind: 'neuron', layer, neuron, dose: NEURON_DEFAULT_DOSE })
      notes.push(`No strength given for ${t.toUpperCase()}: LU uses +1.0, the usual dose. Change it on the slider.`)
      continue
    }
    const e = parseToken(t, presetIds)
    if (typeof e === 'string') return e
    out.push(e)
  }
  return out
}

function parseLink(link: string, presetIds: ReadonlySet<string>): RecipeParse {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return { ok: false, error: 'This link is damaged.' }
  }
  if (url.protocol !== `${RECIPE_SCHEME}:`) return { ok: false, error: 'Only LU neuron links are read here.' }
  // `locallyuncensored://neuron?…`: the host is "neuron" (some engines put
  // it into the path for unknown schemes).
  const host = url.host || url.pathname.replace(/^\/\//, '').split('/')[0]
  const rest = url.host ? url.pathname : url.pathname.replace(/^\/\/[^/?]*/, '')
  if (host !== RECIPE_HOST || (rest && rest !== '/') || url.hash || url.username || url.password || url.port) {
    return { ok: false, error: 'This is not an LU neuron link.' }
  }
  const seen = new Set<string>()
  for (const k of url.searchParams.keys()) {
    if (!['v', 'model', 'c', 'o'].includes(k)) return { ok: false, error: `The link carries “${short(k)}”, which a neuron link never has. Nothing was read.` }
    if (seen.has(k)) return { ok: false, error: `The link carries “${k}” twice. Nothing was read.` }
    seen.add(k)
  }
  if (url.searchParams.get('v') !== '1') return { ok: false, error: 'This link is from a newer LU. Update LU to read it.' }
  const model = url.searchParams.get('model')
  const entries: RecipeEntry[] = []
  const linkNotes: string[] = []
  const c = url.searchParams.get('c')
  if (c) {
    if (hasControl(c)) return { ok: false, error: 'The link has hidden characters. Nothing was read.' }
    const coords = parseCoords(c, presetIds, linkNotes)
    if (typeof coords === 'string') return { ok: false, error: coords }
    entries.push(...coords)
  }
  const o = url.searchParams.get('o')
  if (o) {
    const own = parseOwn(o)
    if (typeof own === 'string') return { ok: false, error: own }
    entries.push(...own)
  }
  return finish(model?.trim() || null, entries, linkNotes)
}

/**
 * Reads what someone pasted: an LU link, LU's own copy line, or plain
 * coordinates from elsewhere ("Qwen3.5-4B: L13N7956-1.0 L14N8949+1.0").
 */
export function parseRecipe(input: string, presetIds: ReadonlySet<string>): RecipeParse {
  const text = input.trim()
  if (!text) return { ok: false, error: 'Paste coordinates or an LU neuron link first.' }
  if (text.length > RECIPE_MAX_CHARS) return { ok: false, error: `Too long: LU reads recipes up to ${RECIPE_MAX_CHARS} characters.` }
  if (hasControl(text)) return { ok: false, error: 'The text has hidden characters. Nothing was read.' }

  // A link anywhere in the text wins: LU's copy puts it on the second line.
  const link = /locallyuncensored:\/\/\S+/i.exec(text)
  if (link) return parseLink(link[0], presetIds)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { ok: false, error: 'LU reads only its own neuron links and plain coordinates, no other web addresses.' }

  // "LU neurons · Model · coords", "Model: coords" or just coords.
  let model: string | null = null
  let coords = text
  const parts = text.split(/\s+[·|]\s+/)
  if (parts.length > 1) {
    const kept = parts.filter((p) => !/^LU neurons$/i.test(p.trim()))
    if (kept.length >= 2) {
      model = kept[0].trim()
      coords = kept.slice(1).join(' ')
    } else coords = kept.join(' ')
  } else {
    const colon = /^([^:]{2,120}):\s+(.+)$/s.exec(text)
    if (colon && !/^\d+$/.test(colon[1].trim()) && typeof parseToken(colon[1].trim().split(/\s+/)[0], presetIds) === 'string') {
      model = colon[1].trim()
      coords = colon[2]
    }
  }
  const notes: string[] = []
  const entries = parseCoords(coords, presetIds, notes)
  if (typeof entries === 'string') return { ok: false, error: entries }
  return finish(model, entries, notes)
}

function signed(v: number): string {
  return `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(2)}`
}

export function entryCode(e: RecipeEntry): string {
  switch (e.kind) {
    case 'preset': return `@${e.id}${signed(e.strength)}`
    case 'feature': return `F${e.feature}${signed(e.strength)}`
    case 'neuron': return `L${e.layer}N${e.neuron}${signed(e.dose)}`
    case 'own': return `“${e.name}” ${signed(e.strength)}`
  }
}

/** The coordinates as one line, own sliders left out (they travel in the
 *  link). */
export function coordsLine(recipe: Recipe): string {
  return recipe.entries.filter((e) => e.kind !== 'own').map(entryCode).join(' ')
}

/** The model name a recipe carries: plain, without characters a reader
 *  would refuse. */
export function recipeModelName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._\-/()+]/gu, '').trim().slice(0, MODEL_MAX)
}

export function recipeLink(recipe: Recipe): string {
  const p = new URLSearchParams()
  p.set('v', '1')
  if (recipe.model) p.set('model', recipeModelName(recipe.model))
  const c = coordsLine(recipe)
  if (c) p.set('c', c)
  const own = recipe.entries.filter((e): e is Extract<RecipeEntry, { kind: 'own' }> => e.kind === 'own')
  if (own.length) p.set('o', JSON.stringify(own.map((e) => ({ n: e.name, s: e.strength, m: e.more, l: e.less }))))
  return `${RECIPE_SCHEME}://${RECIPE_HOST}?${p.toString()}`
}

/** What "Copy" puts on the clipboard: a line people can read and type, and
 *  under it the link that carries everything. */
export function recipeText(recipe: Recipe): string {
  const head = ['LU neurons', recipe.model ? recipeModelName(recipe.model) : null, coordsLine(recipe) || null].filter(Boolean).join(' · ')
  return `${head}\n${recipeLink(recipe)}`
}

/** Model names compared loosely: "Qwen/Qwen3.5-4B" and
 *  "qwen3.5-4b-instruct-q8_0.gguf" are the same model. */
export function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/\.gguf$/, '')
    .replace(/-gguf$/, '')
    .replace(/[-_.](?:i?q\d[\w]*|f16|bf16|f32|ud[-_]\w+)$/i, '')
    .replace(/[^a-z0-9]/g, '')
}

export type ModelFit = 'same' | 'other' | 'unknown'

export function modelFit(recipeModel: string | null, ...ours: Array<string | null | undefined>): ModelFit {
  if (!recipeModel) return 'unknown'
  const want = normalizeModelName(recipeModel)
  if (!want) return 'unknown'
  for (const o of ours) {
    if (!o) continue
    const have = normalizeModelName(o)
    if (have && (have === want || have.startsWith(want) || want.startsWith(have))) return 'same'
  }
  return 'other'
}

/** A stable id for an own slider brought in by a recipe, so the same recipe
 *  brought in twice lands on the same slider. Same shape as Rust's own ids
 *  ("own-<name>-<tag>"). */
export function recipeOwnId(e: Extract<RecipeEntry, { kind: 'own' }>): string {
  const base = e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  let h = 0x811c9dc5
  for (const ch of `${e.name}\u0001${e.more.join('\n')}\u0002${e.less.join('\n')}`) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const tag = `r${(h & 0xfffff).toString(16)}`
  return base ? `own-${base}-${tag}` : `own-${tag}`
}

/** The id Rust gives a feature slider (commands/neuron/mod.rs feature_id). */
export function featureVectorId(saeId: string, feature: number): string {
  return `f-${saeId.includes('270m') ? 'g270m' : 'g1b'}-${feature}`
}

/** The id the engine piece gives a single-neuron slider (AN-P11-N2.md). */
export function neuronVectorId(layer: number, neuron: number): string {
  return `n-L${layer}-N${neuron}`
}
