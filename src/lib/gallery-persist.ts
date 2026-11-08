// The gallery list on IndexedDB, without the cap (3.1.0, C27).
//
// boromirofgeo, Discord 05.11. and 06.11.2026: "200 not enough", after the
// gallery had dropped his sorted folders (D3b). Until 3.1.0 the list sat in the
// create-store blob in localStorage, about 5 MB for the whole origin, so it was
// cut at 200 unsorted entries.
//
// Now the full list lives under its own IndexedDB key, `lu-gallery`, written
// through lib/idbStorage like the chats: the same read-failure latch (a list
// that could not be read is never written over), the same appData backup
// (lib/store-backup STORE_KEYS) and the same restore after a wiped profile.
//
// The way over, safe at every step (tests: gallery-persist*.test.ts):
//   1. Read `lu-gallery`. A read that failed stops here: the old way stays,
//      cap and all, and nothing is written. Next start tries again.
//   2. Nothing there yet and an old list in memory: that list is written once
//      to `lu-gallery-before-310` as it was, before anything else happens.
//   3. The stored list and the one in memory are joined by id. Nothing is
//      dropped: an entry in either side is in the result, unless it was
//      deleted in the app since (`deleted`, kept for this purpose).
//   4. Written, then read back and checked entry by entry. Only then is the
//      move called done.
//   5. The create-store blob keeps a small copy, the newest entries
//      (downgradeMirror). It is what an older LU reads after a downgrade, and
//      what step 3 joins back in after an upgrade. It replaces the old list in
//      place, so there is no separate delete that could come too early.
// A kill anywhere in between leaves either the old list (steps 1 to 3) or both
// (4, 5), and the next start runs the same steps over what it finds.

import type { StateStorage } from 'zustand/middleware'
import { coalescedJSONStorage, type CoalescedStorage } from './coalescedStorage'
import { log } from './logger'
import { sanitizeTags } from './gallery-tags'

export const GALLERY_KEY = 'lu-gallery'
/** The old list, exactly as it was before the first move. Written once, never
 *  overwritten, never read by the app: the way back by hand. */
export const GALLERY_BEFORE_MOVE_KEY = 'lu-gallery-before-310'
/** Version of the stored value. */
export const GALLERY_DOC_VERSION = 1

/** Entries an older LU keeps in the create-store copy: unsorted ones. */
export const MIRROR_UNSORTED = 200
/** And entries in folders. The old cap kept every one of those; the copy
 *  keeps the newest 300, so the blob stays within localStorage. */
export const MIRROR_SORTED = 300
/** Ids of deleted entries kept so the copy cannot bring them back. */
export const DELETED_KEPT = 5000

/** Fields that only exist while the app runs (createStore partialize strips
 *  the same ones). */
const RUNTIME_FIELDS = ['dataUrl', 'unavailable', 'unavailableReason', 'reloadKey'] as const

/** The least an entry needs for this module. */
export interface StoredEntry {
  id: string
  createdAt: number
  folderId?: string
  hidden?: boolean
  tags?: string[]
}

export interface GalleryDoc<T extends StoredEntry> {
  items: T[]
  /** Ids deleted in the app, newest last. */
  deleted?: string[]
}

/** An entry as it is stored: without its runtime fields. */
export function storedForm<T extends StoredEntry>(item: T): T {
  if (!RUNTIME_FIELDS.some((k) => k in item)) return item
  const copy: Record<string, unknown> = { ...(item as object) }
  for (const k of RUNTIME_FIELDS) delete copy[k]
  return copy as unknown as T
}

/**
 * Entries read back from storage. Only what cannot be an entry at all goes (no
 * object, no id); every other field is kept as written, so nothing a user made
 * is thrown away for a field this version does not know. Doubles keep the
 * first. Tags and the hidden flag are cleaned, they are read by this code.
 */
export function sanitizeEntries<T extends StoredEntry>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const e = r as Record<string, unknown>
    if (typeof e.id !== 'string' || !e.id || seen.has(e.id)) continue
    seen.add(e.id)
    const fixed: Record<string, unknown> = { ...e }
    if (typeof fixed.createdAt !== 'number' || !Number.isFinite(fixed.createdAt)) fixed.createdAt = 0
    if ('hidden' in fixed && typeof fixed.hidden !== 'boolean') delete fixed.hidden
    if ('tags' in fixed) {
      const tags = sanitizeTags(fixed.tags)
      if (tags) fixed.tags = tags
      else delete fixed.tags
    }
    out.push(fixed as unknown as T)
  }
  return out
}

/** Newest first; equal times keep their order. */
export function newestFirst<T extends StoredEntry>(items: readonly T[]): T[] {
  return items
    .map((g, i) => ({ g, i }))
    .sort((a, b) => b.g.createdAt - a.g.createdAt || a.i - b.i)
    .map(({ g }) => g)
}

/**
 * Join two lists by id. Every entry of `primary` stays as it is; an entry of
 * `other` comes in when `primary` does not have its id and it was not deleted.
 * The result is newest first. `added` counts what came from `other`.
 */
export function joinGalleries<T extends StoredEntry>(
  primary: readonly T[],
  other: readonly T[],
  deleted: Iterable<string> = [],
): { items: T[]; added: number } {
  const have = new Set(primary.map((g) => g.id))
  const gone = new Set(deleted)
  const extra = other.filter((g) => !have.has(g.id) && !gone.has(g.id))
  if (extra.length === 0) return { items: primary as T[], added: 0 }
  return { items: newestFirst([...primary, ...extra]), added: extra.length }
}

/**
 * Step 3 with what happened in this session before it ran. `hydrated` is the
 * list as the create-store blob gave it at launch, `memory` the list now. An
 * entry changed since launch (moved, tagged, hidden: a new object) wins over
 * the stored one; an entry removed since launch is deleted here too, so the
 * stored list cannot bring it back.
 */
export function joinAtStart<T extends StoredEntry>(args: {
  stored: readonly T[] | null
  memory: readonly T[]
  hydrated: readonly T[]
  deleted: readonly string[]
}): { items: T[]; deleted: string[]; added: number } {
  const { stored, memory, hydrated } = args
  const memIds = new Set(memory.map((g) => g.id))
  const deleted = rememberDeleted(args.deleted, hydrated.filter((g) => !memIds.has(g.id)).map((g) => g.id))
  if (!stored) return { items: newestFirst(memory), deleted, added: 0 }
  const atLaunch = new Map(hydrated.map((g) => [g.id, g]))
  const changed = new Map(memory.filter((g) => atLaunch.has(g.id) && atLaunch.get(g.id) !== g).map((g) => [g.id, g]))
  const gone = new Set(deleted)
  const primary = stored.filter((g) => !gone.has(g.id)).map((g) => changed.get(g.id) ?? g)
  const { items, added } = joinGalleries(primary, memory, deleted)
  return { items, deleted, added }
}

/**
 * The small copy in the create-store blob (step 5 above): the newest
 * MIRROR_UNSORTED unsorted entries and the newest MIRROR_SORTED in folders,
 * hidden ones last in line. `items` is newest first.
 */
export function downgradeMirror<T extends StoredEntry>(items: readonly T[]): T[] {
  const out: T[] = []
  let unsorted = 0
  let sorted = 0
  for (const pass of [false, true]) {
    for (const g of items) {
      if (!!g.hidden !== pass) continue
      if (g.folderId) { if (sorted < MIRROR_SORTED) { out.push(g); sorted++ } }
      else if (unsorted < MIRROR_UNSORTED) { out.push(g); unsorted++ }
    }
  }
  return out.length === items.length ? (items as T[]) : newestFirst(out)
}

/** `deleted` with `ids` added, the oldest dropped past DELETED_KEPT. */
export function rememberDeleted(deleted: readonly string[], ids: readonly string[]): string[] {
  if (ids.length === 0) return deleted as string[]
  const fresh = new Set(ids)
  const next = [...deleted.filter((id) => !fresh.has(id)), ...ids]
  return next.length > DELETED_KEPT ? next.slice(next.length - DELETED_KEPT) : next
}

/** What the move came to; for the log, the panel and the tests. */
export type GalleryPersistState =
  /** Not started, or waiting for the restore decision. The old way holds. */
  | 'waiting'
  /** `lu-gallery` could not be read. The old way holds, nothing is written. */
  | 'unreadable'
  /** No IndexedDB here. The old way holds. */
  | 'unavailable'
  /** Written and read back entry by entry. No cap. */
  | 'saved'
  /** Running without the cap, but the last check did not find every entry. */
  | 'unconfirmed'

export interface GalleryPersistDeps<T extends StoredEntry> {
  /** lib/idbStorage in the app. */
  storage: StateStorage
  /** idbStorage's hasFailedRead. */
  readFailed: (key: string) => boolean
  /** False where IndexedDB is missing: idbStorage would then write to
   *  localStorage, which cannot hold a list without the cap. */
  durable: boolean
  getItems: () => T[]
  /** The list as it was right after the create store hydrated at launch
   *  (the same objects). Defaults to the list when the move starts. */
  hydratedItems?: () => T[]
  setItems: (items: T[]) => void
  /** Called with the list every time it changes. Returns the unsubscribe. */
  subscribe: (listener: (items: T[], prev: T[]) => void) => () => void
  /** Told when the list may grow past the cap. */
  setUncapped: (on: boolean) => void
  /** Coalescing window of the writes, ms. */
  waitMs?: number
}

export interface GalleryPersistence {
  readonly state: GalleryPersistState
  /** Write what is pending now. Resolves when it has landed. */
  flush: () => Promise<void>
  /** Write, read back, compare. True when every entry is stored. */
  verify: () => Promise<boolean>
  stop: () => void
}

function parseDoc<T extends StoredEntry>(raw: string | null): { doc: GalleryDoc<T> | null; damaged: boolean } {
  if (raw == null) return { doc: null, damaged: false }
  try {
    const value = JSON.parse(raw) as { state?: unknown } | null
    const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : null
    if (!state || typeof state !== 'object' || !Array.isArray((state as { items?: unknown }).items)) {
      return { doc: null, damaged: true }
    }
    const s = state as { items: unknown; deleted?: unknown }
    const deleted = Array.isArray(s.deleted) ? s.deleted.filter((d): d is string => typeof d === 'string') : []
    return { doc: { items: sanitizeEntries<T>(s.items), deleted }, damaged: false }
  } catch {
    return { doc: null, damaged: true }
  }
}

/**
 * Run the move (steps 1 to 4 above) and keep the list written afterwards.
 * Resolves once the first write has been checked (or the read failed).
 */
export async function startGalleryPersistence<T extends StoredEntry>(deps: GalleryPersistDeps<T>): Promise<GalleryPersistence> {
  let state: GalleryPersistState = 'waiting'
  let ready = false
  let deleted: string[] = []
  let unsubscribe: (() => void) | null = null
  const writer: CoalescedStorage<GalleryDoc<T>> = coalescedJSONStorage<GalleryDoc<T>>(deps.storage, {
    ready: () => ready,
    waitMs: deps.waitMs ?? 400,
    maxWaitMs: 3000,
  })
  const queue = (items: readonly T[]) => {
    writer.setItem(GALLERY_KEY, { state: { items: items.map(storedForm), deleted }, version: GALLERY_DOC_VERSION })
  }
  const verify = async (): Promise<boolean> => {
    await writer.flush()
    const wanted = deps.getItems()
    let back: string | null
    try {
      back = await Promise.resolve(deps.storage.getItem(GALLERY_KEY))
    } catch {
      back = null
    }
    const { doc } = deps.readFailed(GALLERY_KEY) ? { doc: null } : parseDoc<T>(back)
    const stored = new Set((doc?.items ?? []).map((g) => g.id))
    const ok = !!doc && wanted.every((g) => stored.has(g.id))
    state = ok ? 'saved' : 'unconfirmed'
    return ok
  }
  const handle: GalleryPersistence = {
    get state() { return state },
    flush: () => writer.flush(),
    verify,
    stop: () => { unsubscribe?.(); unsubscribe = null },
  }

  if (!deps.durable) {
    state = 'unavailable'
    return handle
  }

  // 1. Read.
  let raw: string | null
  try {
    raw = await Promise.resolve(deps.storage.getItem(GALLERY_KEY))
  } catch (err) {
    raw = null
    log.error('[gallery] reading the gallery list threw', { err: String(err) })
    state = 'unreadable'
    return handle
  }
  if (deps.readFailed(GALLERY_KEY)) {
    log.error('[gallery] the gallery list could not be read, keeping the old way and writing nothing')
    state = 'unreadable'
    return handle
  }
  const { doc, damaged } = parseDoc<T>(raw)
  if (damaged && raw != null) {
    // Kept aside as it is, never written over: what cannot be read now may be
    // read by hand later.
    const aside = `${GALLERY_KEY}-damaged-${Date.now()}`
    try { await Promise.resolve(deps.storage.setItem(aside, raw)) } catch { /* the log says it */ }
    log.error('[gallery] the stored gallery list is damaged, set aside and starting from the list in memory', { aside })
  }
  deleted = doc?.deleted ?? []

  // 2. The old list, once, before the first write.
  const before = deps.getItems()
  if (!doc && before.length > 0) {
    try {
      const there = await Promise.resolve(deps.storage.getItem(GALLERY_BEFORE_MOVE_KEY))
      if (there == null && !deps.readFailed(GALLERY_BEFORE_MOVE_KEY)) {
        await Promise.resolve(deps.storage.setItem(GALLERY_BEFORE_MOVE_KEY, JSON.stringify(before.map(storedForm))))
      }
    } catch (err) {
      // No copy, no move: the old way holds until a copy can be made.
      log.error('[gallery] could not keep a copy of the old gallery list, not moving it yet', { err: String(err) })
      state = 'unreadable'
      return handle
    }
  }

  // 3. Join. What the store got while we read (a render that finished) is in
  // getItems() now and joins too.
  const memory = deps.getItems()
  const joined = joinAtStart({ stored: doc?.items ?? null, memory, hydrated: deps.hydratedItems?.() ?? before, deleted })
  deleted = joined.deleted
  ready = true
  deps.setUncapped(true)
  if (joined.items.length !== memory.length || joined.items.some((g, i) => g !== memory[i])) deps.setItems(joined.items)
  if (joined.added > 0 || doc) log.info('[gallery] gallery list loaded', { stored: doc?.items.length ?? 0, joined: joined.added })

  unsubscribe = deps.subscribe((items, prev) => {
    if (items === prev) return
    const now = new Set(items.map((g) => g.id))
    const gone = prev.filter((g) => !now.has(g.id)).map((g) => g.id)
    deleted = rememberDeleted(deleted, gone)
    queue(items)
  })

  // 4. Write and check.
  queue(deps.getItems())
  const ok = await verify()
  if (!ok) log.error('[gallery] the gallery list did not read back complete, it stays in memory and is written again on the next change')
  return handle
}
