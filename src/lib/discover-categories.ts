/**
 * "Better Categories" (Discord feature-requests, 09.11.2026):
 * sort and filter the models of Get new by what they are for, the way Create
 * sorts its work into Image, Edit, Video, Music, Lip sync and Motion.
 *
 * Pure, and read only from what the catalog already says about an entry
 * (its tags, flags and name), so no entry needs a new field and a test can
 * hold every catalog entry against the rules. A category is a filter, never
 * a hiding place: "All" is always there and is the default.
 */
import type { DiscoverModel, ModelBundle } from '../api/model-bundles'

export interface CategoryDef<T> {
  id: string
  label: string
  /** The tooltip of the chip. */
  hint: string
  match: (item: T) => boolean
}

const hasTag = (tags: readonly string[] | undefined, ...wanted: string[]) =>
  !!tags?.some((t) => wanted.some((w) => t.toLowerCase() === w.toLowerCase()))

const text = (m: { name: string; description?: string }) => `${m.name} ${m.description ?? ''}`

// ── Chat ────────────────────────────────────────────────────────────

/** Small enough for a laptop or an 8 GB card, in GB of file. */
export const SMALL_CHAT_GB = 5

export const TEXT_CATEGORIES: CategoryDef<DiscoverModel>[] = [
  {
    id: 'agent', label: 'Agent & tools', hint: 'Can call tools: Agent mode, web search, files, computer control',
    match: (m) => !!m.agent || hasTag(m.tags, 'Tools', 'Computer control'),
  },
  {
    id: 'vision', label: 'Sees images', hint: 'Can look at pictures and the screen',
    match: (m) => hasTag(m.tags, 'Vision') || !!m.mmprojUrl,
  },
  {
    id: 'coding', label: 'Coding', hint: 'Made or tuned for writing code',
    match: (m) => hasTag(m.tags, 'Coding') || /\b(coder|codestral|devstral|code)\b/i.test(m.name),
  },
  {
    id: 'reasoning', label: 'Reasoning', hint: 'Thinks before it answers',
    match: (m) => hasTag(m.tags, 'Reasoning') || /\b(thinking|reasoning|qwq|r1)\b/i.test(m.name),
  },
  {
    id: 'roleplay', label: 'Roleplay & stories', hint: 'Tuned for characters, roleplay and creative writing',
    match: (m) => hasTag(m.tags, 'RP') || /\b(roleplay|role-play|storytelling|creative writing|rp)\b/i.test(text(m)),
  },
  {
    id: 'small', label: 'Small & fast', hint: `Runs on modest hardware: ${SMALL_CHAT_GB} GB or less, or tested on a CPU`,
    match: (m) => !!m.lightweight || (typeof m.sizeGB === 'number' && m.sizeGB > 0 && m.sizeGB <= SMALL_CHAT_GB),
  },
]

// ── Image and Video (the lanes of Create) ───────────────────────────

/** A bundle that is no model on its own: a LoRA, a VAE, a prompt helper, the
 *  companion files of a checkpoint from elsewhere. */
export function isAddonBundle(b: ModelBundle): boolean {
  return !!b.addonFor
    || hasTag(b.tags, 'Addon', 'Companion Files')
    || (b.files.length > 0 && b.files.every((f) => f.subfolder === 'loras'))
}

const isFast = (b: ModelBundle) => hasTag(b.tags, 'Fast', 'Turbo', 'Lightning') || /\b(turbo|schnell|lightning|fast)\b/i.test(b.name)

export const IMAGE_CATEGORIES: CategoryDef<ModelBundle>[] = [
  {
    id: 'generate', label: 'Text to image', hint: 'Makes a picture from a prompt (Create, Image)',
    match: (b) => !isAddonBundle(b) && b.workflow !== 'upscale',
  },
  {
    id: 'edit', label: 'Edit', hint: 'Changes a picture you give it (Create, Edit / Image to Image)',
    match: (b) => !isAddonBundle(b) && (hasTag(b.tags, 'Edit') || /\bedit\b/i.test(b.name)),
  },
  {
    id: 'photo', label: 'Photorealistic', hint: 'Looks like a photo',
    match: (b) => hasTag(b.tags, 'Photorealistic') || /\bphoto(real|realistic)?\b/i.test(b.name),
  },
  {
    id: 'stylized', label: 'Anime & style', hint: 'Anime, illustration and other styles',
    match: (b) => hasTag(b.tags, 'Anime', 'Stylized', 'Style'),
  },
  {
    id: 'fast', label: 'Fast', hint: 'Few steps, quick results',
    match: (b) => !isAddonBundle(b) && isFast(b),
  },
  {
    id: 'enhance', label: 'Enhance', hint: 'Sharpens and enlarges a picture (Create, Enhance)',
    match: (b) => b.workflow === 'upscale' || hasTag(b.tags, 'Upscale', 'Enhance'),
  },
  {
    id: 'addons', label: 'Add-ons', hint: 'LoRAs, VAEs, prompt helpers and companion files for a model you have',
    match: isAddonBundle,
  },
]

/** The Video tab also carries Music, Lip sync and Motion (DiscoverModels'
 *  `laneOf`), so its categories take that lane as a second argument. */
export type VideoItem = { bundle: ModelBundle; lane?: string }

const isVideoModel = (v: VideoItem) => !v.lane && !isAddonBundle(v.bundle)

export const VIDEO_CATEGORIES: CategoryDef<VideoItem>[] = [
  {
    id: 't2v', label: 'Text to video', hint: 'Makes a clip from a prompt (Create, Video)',
    match: (v) => isVideoModel(v) && (hasTag(v.bundle.tags, 'T2V') || !(v.bundle.i2v || hasTag(v.bundle.tags, 'I2V'))),
  },
  {
    id: 'i2v', label: 'Image to video', hint: 'Brings a picture you give it to life (Create, Image to Video)',
    match: (v) => isVideoModel(v) && (!!v.bundle.i2v || hasTag(v.bundle.tags, 'I2V')),
  },
  {
    id: 'sound', label: 'With sound', hint: 'The clip comes with its own audio',
    match: (v) => isVideoModel(v) && hasTag(v.bundle.tags, 'Audio'),
  },
  {
    id: 'music', label: 'Music', hint: 'Songs with vocals (Create, Music)',
    match: (v) => v.lane === 'Music',
  },
  {
    id: 'lipsync', label: 'Lip sync', hint: 'A portrait speaks or sings a voice (Create, Lip sync)',
    match: (v) => v.lane === 'Lip sync',
  },
  {
    id: 'motion', label: 'Motion', hint: 'A character copies the moves of a video (Create, Motion)',
    match: (v) => v.lane === 'Motion',
  },
  {
    id: 'fast', label: 'Fast', hint: 'Few steps or a light model',
    match: (v) => !isAddonBundle(v.bundle) && (isFast(v.bundle) || hasTag(v.bundle.tags, 'Light', 'Low VRAM')),
  },
  {
    id: 'addons', label: 'Add-ons', hint: 'Speed LoRAs and other files for a model you have',
    match: (v) => isAddonBundle(v.bundle),
  },
]

/** Keep the items of one category; 'all' or an unknown id keeps everything,
 *  so a remembered id that a later catalog no longer has never empties the
 *  page. */
export function filterByCategory<T>(items: readonly T[], defs: readonly CategoryDef<T>[], id: string): T[] {
  const def = defs.find((d) => d.id === id)
  return def ? items.filter(def.match) : [...items]
}

/** How many items each category holds, for the counts on the chips. */
export function categoryCounts<T>(items: readonly T[], defs: readonly CategoryDef<T>[]): Record<string, number> {
  const out: Record<string, number> = { all: items.length }
  for (const d of defs) out[d.id] = items.filter(d.match).length
  return out
}

// ── Sorting ─────────────────────────────────────────────────────────

export type SortId = 'recommended' | 'newest' | 'smallest' | 'largest' | 'name'

export const SORTS: { id: SortId; label: string; textOnly?: true }[] = [
  { id: 'recommended', label: 'Recommended' },
  // Only the chat catalog carries a release month.
  { id: 'newest', label: 'Newest', textOnly: true },
  { id: 'smallest', label: 'Smallest' },
  { id: 'largest', label: 'Largest' },
  { id: 'name', label: 'Name' },
]

export function isSortId(v: string): v is SortId {
  return SORTS.some((s) => s.id === v)
}

/**
 * Stable sort by one key. 'recommended' returns the order it was given, which
 * is the hand-made order of the catalog and the tier rule on top of it.
 * Items without the key (no size, no date) go last, in their old order.
 */
export function sortItems<T>(
  items: readonly T[],
  sort: string,
  key: { size: (t: T) => number | undefined; released?: (t: T) => string | undefined; name: (t: T) => string },
): T[] {
  const indexed = items.map((item, i) => ({ item, i }))
  const missingLast = (a: number | string | undefined, b: number | string | undefined) =>
    (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0)
  const cmp = (fn: (a: { item: T; i: number }, b: { item: T; i: number }) => number) =>
    indexed.sort((a, b) => fn(a, b) || a.i - b.i).map(({ item }) => item)
  switch (sort) {
    case 'smallest':
    case 'largest': {
      const sign = sort === 'smallest' ? 1 : -1
      return cmp((a, b) => {
        const x = key.size(a.item), y = key.size(b.item)
        return missingLast(x, y) || (x !== undefined && y !== undefined ? sign * (x - y) : 0)
      })
    }
    case 'newest': {
      if (!key.released) return [...items]
      const rel = key.released
      return cmp((a, b) => {
        const x = rel(a.item), y = rel(b.item)
        return missingLast(x, y) || (x && y ? y.localeCompare(x) : 0)
      })
    }
    case 'name':
      return cmp((a, b) => key.name(a.item).localeCompare(key.name(b.item), undefined, { sensitivity: 'base', numeric: true }))
    default:
      return [...items]
  }
}
