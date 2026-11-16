// A character saved as photos (Discord, 2026-10: "If I like the
// look of a character who appeared in a video I generated, is there a way to
// simply save that character?").
//
// A character in LU was only ever a trained LoRA. This is the short way in
// front of that: a name plus a handful of photos, kept on this machine. The
// photos load back into the reference strip with one click (models that read
// several photos of a figure need no training at all), or go to Character
// Studio as the start of a training set.
//
// The bytes live in IndexedDB, never in localStorage: thirty frames are a few
// megabytes, and the create store's own quota is five.

/** The most photos one saved character keeps. Cloud training takes 30. */
export const MAX_CHARACTER_PHOTOS = 30
export const MAX_CHARACTER_NAME = 40

export interface SavedCharacter {
  id: string
  name: string
  createdAt: number
  photos: Blob[]
}

/** What is written to disk. Bytes plus type instead of a Blob: WebKit has
 *  lost Blobs stored in IndexedDB before, an ArrayBuffer always comes back. */
export interface StoredCharacter {
  id: string
  name: string
  createdAt: number
  photos: { type: string; bytes: ArrayBuffer }[]
}

const DB_NAME = 'lu-saved-characters'
const STORE = 'characters'

const hasIDB = (): boolean => {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null } catch { return false }
}

// Without IndexedDB (a test run, a degraded webview) the characters live for
// the session only. Saving still works, it just does not survive a restart.
const memory = new Map<string, StoredCharacter>()

let db: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  if (db) return db
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('indexedDB open blocked'))
  })
  db = opening
  // A failed open must not stay cached, or one busy moment breaks the session.
  opening.catch(() => { if (db === opening) db = null })
  return opening
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((database) => new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, mode)
    const req = run(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  }))
}

async function readAll(): Promise<StoredCharacter[]> {
  if (!hasIDB()) return [...memory.values()]
  return request<StoredCharacter[]>('readonly', (s) => s.getAll())
}

async function write(row: StoredCharacter): Promise<void> {
  if (!hasIDB()) { memory.set(row.id, row); return }
  await request('readwrite', (s) => s.put(row))
}

// ── A copy outside IndexedDB (phone only) ───────────────────────────────
//
// On Android a full phone can make the WebView drop all of IndexedDB at the
// next start (mobile-docs/r35/n6b.md), and these characters had no other
// copy (gap L3, mobile-docs/r38/luecken.md). The phone registers a mirror
// (mobile/lib/saved-characters-backup.ts) that writes them beside the native
// store backup. Without one (the desktop, a browser) nothing changes.

export interface SavedCharactersMirror {
  /** Called after every save and delete with every character as stored. */
  sync(rows: readonly StoredCharacter[]): Promise<void>
}

let mirror: SavedCharactersMirror | null = null

export function setSavedCharactersMirror(next: SavedCharactersMirror | null): void {
  mirror = next
}

/** The mirror follows the store. A failure costs the copy, never the save. */
async function mirrorAll(): Promise<void> {
  if (!mirror) return
  try {
    await mirror.sync(await readAll())
  } catch {
    /* the mirror logs; the next save or start tries again */
  }
}

/** Every character as stored, for the mirror at the start. Throws when the store cannot be read. */
export function readStoredCharacters(): Promise<StoredCharacter[]> {
  return readAll()
}

/** Put characters back from the copy, all in one transaction, so a reload in
 *  the middle leaves all or none of them. */
export async function restoreStoredCharacters(rows: readonly StoredCharacter[]): Promise<void> {
  if (rows.length === 0) return
  if (!hasIDB()) {
    for (const row of rows) memory.set(row.id, row)
  } else {
    const database = await open()
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const row of rows) store.put(row)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }
  changed()
}

const listeners = new Set<() => void>()
/** Fires after every save and delete. */
export function subscribeSavedCharacters(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
function changed(): void {
  for (const fn of listeners) fn()
}

function revive(row: StoredCharacter): SavedCharacter {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    photos: row.photos.map((p) => new Blob([p.bytes], { type: p.type || 'image/jpeg' })),
  }
}

/** Every saved character, newest first. */
export async function listSavedCharacters(): Promise<SavedCharacter[]> {
  const rows = await readAll()
  return rows.sort((a, b) => b.createdAt - a.createdAt).map(revive)
}

export interface SaveResult {
  character: SavedCharacter
  /** Photos that were added by this save. */
  added: number
  /** Photos that did not fit under the limit. */
  dropped: number
  /** True when the name already existed and the photos joined it. */
  merged: boolean
}

/**
 * Saves photos under a name. A name that exists already (upper and lower case
 * count as the same) gets the photos added, so a second video of the same
 * figure grows the same character.
 */
export async function saveCharacter(name: string, photos: readonly Blob[]): Promise<SaveResult> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, MAX_CHARACTER_NAME)
  if (!clean) throw new Error('Give the character a name.')
  if (photos.length === 0) throw new Error('Add at least one frame first.')
  const rows = await readAll()
  const existing = rows.find((r) => r.name.toLowerCase() === clean.toLowerCase())
  const room = MAX_CHARACTER_PHOTOS - (existing?.photos.length ?? 0)
  const take = photos.slice(0, Math.max(0, room))
  if (take.length === 0) {
    throw new Error(`${existing?.name ?? clean} already has ${MAX_CHARACTER_PHOTOS} photos, the most a character keeps.`)
  }
  const fresh = await Promise.all(take.map(async (p) => ({ type: p.type || 'image/jpeg', bytes: await p.arrayBuffer() })))
  const row: StoredCharacter = existing
    ? { ...existing, photos: [...existing.photos, ...fresh] }
    : { id: crypto.randomUUID(), name: clean, createdAt: Date.now(), photos: fresh }
  await write(row)
  await mirrorAll()
  changed()
  return { character: revive(row), added: take.length, dropped: photos.length - take.length, merged: !!existing }
}

/**
 * Gives a saved character another name. A name another character already
 * has (upper and lower case count as the same) is refused, so two saves
 * never fold into one by a rename.
 */
export async function renameSavedCharacter(id: string, name: string): Promise<SavedCharacter> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, MAX_CHARACTER_NAME)
  if (!clean) throw new Error('Give the character a name.')
  const rows = await readAll()
  const row = rows.find((r) => r.id === id)
  if (!row) throw new Error('This character is no longer there.')
  if (rows.some((r) => r.id !== id && r.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`There is already a character called ${clean}.`)
  }
  const next: StoredCharacter = { ...row, name: clean }
  await write(next)
  await mirrorAll()
  changed()
  return revive(next)
}

export async function deleteSavedCharacter(id: string): Promise<void> {
  if (!hasIDB()) memory.delete(id)
  else await request('readwrite', (s) => s.delete(id))
  await mirrorAll()
  changed()
}

/** Test seam: forget the in-memory characters. */
export function __resetSavedCharacters(): void {
  memory.clear()
  mirror = null
}
