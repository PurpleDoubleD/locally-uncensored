// The still on a 3D model's gallery tile (C3D-PLAN 1.7). The 3D view draws it
// from its own canvas the first time it shows a model, and it is kept here
// per device, under the id of the gallery entry. A small database of its own:
// a poster that cannot be written must never count as a failed write of the
// app's stores (idbStorage reports those to the user).
//
// Without IndexedDB (tests, a locked-down webview) the stills live in memory
// for the session, and the tile shows the cube until one is drawn.

const DB = 'lu-3d-posters'
const STORE = 'posters'
const memory = new Map<string, string>()
const listeners = new Set<(id: string) => void>()

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

let dbPromise: Promise<IDBDatabase | null> | null = null
const db = () => (dbPromise ??= open())

/** The still of an entry, or null when none was drawn yet. */
export async function readPoster(id: string): Promise<string | null> {
  const hit = memory.get(id)
  if (hit) return hit
  const d = await db()
  if (!d) return null
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(id)
      req.onsuccess = () => {
        const v = typeof req.result === 'string' ? req.result : null
        if (v) memory.set(id, v)
        resolve(v)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** Keep the still of an entry. Only JPEG and PNG data URLs are taken. */
export async function writePoster(id: string, dataUrl: string): Promise<void> {
  if (!/^data:image\/(jpeg|png);base64,/.test(dataUrl) || dataUrl.length > 400_000) return
  memory.set(id, dataUrl)
  for (const fn of listeners) fn(id)
  const d = await db()
  if (!d) return
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(dataUrl, id)
  } catch {
    // The memory copy stays for this session.
  }
}

/** Drop the still of a deleted entry. */
export async function deletePoster(id: string): Promise<void> {
  memory.delete(id)
  const d = await db()
  if (!d) return
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
  } catch {
    // Nothing to do: a leftover still is never shown without its entry.
  }
}

/** Called with the id whenever a still is written. */
export function onPoster(fn: (id: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function __resetPostersForTests(): void {
  memory.clear()
  listeners.clear()
  dbPromise = null
}
