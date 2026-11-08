// Hide and tag gallery entries (3.1.0, Discord D27, promised 05.11.2026:
// "hide from gallery" and tags).
//
// Both are labels inside the app, like folders (lib/gallery-folders.ts):
// hiding an entry takes it out of the list and keeps its file, its prompt and
// its folder; a tag is a short word on the entry that the gallery can filter
// by. Nothing here reaches a file.

/** Longest tag kept. */
export const TAG_MAX = 32
/** Most tags on one entry. */
export const TAGS_PER_ITEM = 12

/** The shape of an entry as far as hiding and tags are concerned. */
export interface TaggedItem {
  hidden?: boolean
  tags?: string[]
  folderId?: string
}

/** A typed tag made ready to keep, or null when nothing is left of it. A
 *  leading "#" is dropped, inner spaces fold to one. */
export function cleanTag(raw: string): string | null {
  const clean = raw.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').slice(0, TAG_MAX).trim()
  return clean ? clean : null
}

const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/** Whether the entry carries `tag`, whatever its case. */
export function hasTag(item: TaggedItem, tag: string): boolean {
  return (item.tags ?? []).some((t) => same(t, tag))
}

/** The entry's tags with `tag` added. Unchanged (same array) when it is there
 *  already, when the tag is empty, or when the entry is full. */
export function withTag(tags: readonly string[] | undefined, raw: string): string[] | undefined {
  const tag = cleanTag(raw)
  const list = tags ?? []
  if (!tag || list.some((t) => same(t, tag)) || list.length >= TAGS_PER_ITEM) return tags as string[] | undefined
  return [...list, tag]
}

/** The entry's tags without `tag`; undefined when none are left. */
export function withoutTag(tags: readonly string[] | undefined, tag: string): string[] | undefined {
  if (!tags) return undefined
  const left = tags.filter((t) => !same(t, tag))
  if (left.length === tags.length) return tags as string[]
  return left.length > 0 ? left : undefined
}

/**
 * A tag list read back from storage. Anything that is not a short string goes,
 * so a damaged blob gives fewer tags instead of a crash.
 */
export function sanitizeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  let out: string[] | undefined
  for (const t of raw) {
    if (typeof t !== 'string') continue
    out = withTag(out, t)
  }
  return out
}

/** Every tag in use, the most used first, then by name. Spelled as it was
 *  first met. */
export function tagCounts(items: readonly TaggedItem[]): { tag: string; count: number }[] {
  const byKey = new Map<string, { tag: string; count: number }>()
  for (const g of items) {
    for (const t of g.tags ?? []) {
      const key = t.toLocaleLowerCase()
      const hit = byKey.get(key)
      if (hit) hit.count++
      else byKey.set(key, { tag: t, count: 1 })
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export interface GalleryView {
  /** null: "All". */
  folderId: string | null
  /** null: no tag filter. */
  tag: string | null
  /** Show the hidden entries instead of the others. */
  hidden: boolean
}

/**
 * The entries one view shows, in the order they come. Hidden entries appear
 * only in the "Hidden" view, which shows nothing else, so a hidden entry is
 * never in the way and always one click from coming back.
 */
export function itemsInView<T extends TaggedItem>(items: readonly T[], view: GalleryView): T[] {
  return items.filter((g) =>
    !!g.hidden === view.hidden
    && (view.folderId === null || g.folderId === view.folderId)
    && (view.tag === null || hasTag(g, view.tag)))
}

/** How many entries are hidden. */
export function hiddenCount(items: readonly TaggedItem[]): number {
  let n = 0
  for (const g of items) if (g.hidden) n++
  return n
}
