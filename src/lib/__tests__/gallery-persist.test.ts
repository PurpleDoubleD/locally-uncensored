/**
 * C27 (3.1.0): the gallery list moves from the create-store blob in
 * localStorage (cap 200) to its own IndexedDB key, without a cap.
 *
 * After the chat loss of 3.0.9 the rule for this move is: nothing a user made
 * may get lost on the way, also not when the app dies in the middle of it.
 * These tests run the move against a storage that can fail to read, fail to
 * write and lose a write (a kill), and check every entry each time.
 *
 * Run: npx vitest run src/lib/__tests__/gallery-persist.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  GALLERY_BEFORE_MOVE_KEY, GALLERY_KEY, MIRROR_SORTED, MIRROR_UNSORTED, DELETED_KEPT,
  downgradeMirror, joinAtStart, joinGalleries, rememberDeleted, sanitizeEntries, startGalleryPersistence,
  storedForm, type StoredEntry,
} from '../gallery-persist'

interface Entry extends StoredEntry {
  prompt: string
  dataUrl?: string
  unavailable?: boolean
}

const entry = (n: number, extra: Partial<Entry> = {}): Entry => ({ id: `g${n}`, createdAt: n, prompt: `prompt ${n}`, ...extra })
const range = (from: number, count: number, extra: Partial<Entry> = {}) => Array.from({ length: count }, (_, i) => entry(from + count - 1 - i, extra))
const ids = (items: readonly StoredEntry[]) => items.map((g) => g.id)

/** An async key/value storage like idbStorage, with the ways it can go wrong. */
function memStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  const failed = new Set<string>()
  const ctl = {
    data,
    /** Reads of these keys fail (idbStorage latches them in hasFailedRead). */
    failReads: new Set<string>(),
    /** Writes of these keys throw. */
    failWrites: new Set<string>(),
    /** Writes report success and land nowhere: the app was killed. */
    killed: false,
    writes: [] as string[],
  }
  const storage = {
    getItem: async (k: string) => {
      if (ctl.failReads.has(k)) { failed.add(k); return null }
      failed.delete(k)
      return data.get(k) ?? null
    },
    setItem: async (k: string, v: string) => {
      if (ctl.failWrites.has(k)) throw new Error('disk full')
      if (ctl.killed) return
      ctl.writes.push(k)
      data.set(k, v)
    },
    removeItem: async (k: string) => { data.delete(k) },
  }
  return { storage, readFailed: (k: string) => failed.has(k), ctl }
}

/** The create store as far as the move sees it. */
function fakeStore(initial: Entry[]) {
  let items = initial
  const listeners = new Set<(n: Entry[], p: Entry[]) => void>()
  const store = {
    uncapped: false,
    getItems: () => items,
    setItems: (next: Entry[]) => {
      const prev = items
      items = next
      for (const l of listeners) l(next, prev)
    },
    subscribe: (l: (n: Entry[], p: Entry[]) => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    setUncapped: (on: boolean) => { store.uncapped = on },
  }
  return store
}

function stored(ctl: { data: Map<string, string> }): Entry[] | null {
  const raw = ctl.data.get(GALLERY_KEY)
  return raw ? (JSON.parse(raw).state.items as Entry[]) : null
}

async function start(mem: ReturnType<typeof memStorage>, store: ReturnType<typeof fakeStore>, hydrated?: Entry[]) {
  return startGalleryPersistence<Entry>({
    storage: mem.storage,
    readFailed: mem.readFailed,
    durable: true,
    getItems: store.getItems,
    hydratedItems: hydrated ? () => hydrated : undefined,
    setItems: store.setItems,
    subscribe: store.subscribe,
    setUncapped: store.setUncapped,
    waitMs: 0,
  })
}

describe('the first move', () => {
  it('keeps the old list as it was, then stores every entry and checks it', async () => {
    const legacy = [...range(1, 150), ...range(500, 40, { folderId: 'f-1' })]
    const mem = memStorage()
    const store = fakeStore(legacy)
    const h = await start(mem, store)
    expect(h.state).toBe('saved')
    expect(store.uncapped).toBe(true)
    // The copy by hand comes first and is the old list, word for word.
    expect(mem.ctl.writes[0]).toBe(GALLERY_BEFORE_MOVE_KEY)
    expect(JSON.parse(mem.ctl.data.get(GALLERY_BEFORE_MOVE_KEY)!)).toEqual(legacy)
    expect(new Set(ids(stored(mem.ctl)!))).toEqual(new Set(ids(legacy)))
    expect(stored(mem.ctl)!.find((g) => g.id === 'g520')).toEqual(entry(520, { folderId: 'f-1' }))
  })

  it('an empty gallery writes no copy and still moves', async () => {
    const mem = memStorage()
    const h = await start(mem, fakeStore([]))
    expect(h.state).toBe('saved')
    expect(mem.ctl.data.has(GALLERY_BEFORE_MOVE_KEY)).toBe(false)
    expect(stored(mem.ctl)).toEqual([])
  })

  it('never stores runtime fields', async () => {
    const mem = memStorage()
    await start(mem, fakeStore([entry(1, { dataUrl: 'blob:x', unavailable: true })]))
    expect(stored(mem.ctl)![0]).toEqual(entry(1))
  })
})

describe('no cap after the move', () => {
  it('3000 stored plus the 200 copy: all 3000 and the new ones, nothing dropped', async () => {
    const big = range(1, 3000)
    const mem = memStorage({ [GALLERY_KEY]: JSON.stringify({ state: { items: big }, version: 1 }) })
    // The create-store copy: the newest 200, plus 5 renders an older build made after a downgrade.
    const copy = [...range(5001, 5), ...big.slice(0, 200)]
    const store = fakeStore(copy)
    const h = await start(mem, store)
    expect(h.state).toBe('saved')
    expect(store.getItems()).toHaveLength(3005)
    expect(ids(store.getItems()).slice(0, 6)).toEqual(['g5005', 'g5004', 'g5003', 'g5002', 'g5001', 'g3000'])
    expect(stored(mem.ctl)).toHaveLength(3005)
    // Nothing was copied aside: there was a stored list already.
    expect(mem.ctl.data.has(GALLERY_BEFORE_MOVE_KEY)).toBe(false)
  })

  it('every later change is written, many changes in one write', async () => {
    const mem = memStorage()
    const store = fakeStore(range(1, 3))
    const h = await start(mem, store)
    const before = mem.ctl.writes.length
    for (let i = 0; i < 50; i++) store.setItems([entry(100 + i), ...store.getItems()])
    await h.flush()
    expect(mem.ctl.writes.length - before).toBe(1)
    expect(stored(mem.ctl)).toHaveLength(53)
  })
})

describe('a read that failed', () => {
  it('writes nothing and keeps the cap', async () => {
    const original = JSON.stringify({ state: { items: range(1, 900) }, version: 1 })
    const mem = memStorage({ [GALLERY_KEY]: original })
    mem.ctl.failReads.add(GALLERY_KEY)
    const store = fakeStore(range(1000, 200))
    const h = await start(mem, store)
    expect(h.state).toBe('unreadable')
    expect(store.uncapped).toBe(false)
    expect(mem.ctl.writes).toEqual([])
    expect(mem.ctl.data.get(GALLERY_KEY)).toBe(original)
    // Later changes are not written either.
    store.setItems([entry(5000), ...store.getItems()])
    await h.flush()
    expect(mem.ctl.writes).toEqual([])
  })

  it('a damaged value is set aside, never written over', async () => {
    const mem = memStorage({ [GALLERY_KEY]: '{"state": {"items": [trunc' })
    const store = fakeStore(range(1, 10))
    const h = await start(mem, store)
    expect(h.state).toBe('saved')
    const aside = [...mem.ctl.data.keys()].find((k) => k.startsWith(`${GALLERY_KEY}-damaged-`))
    expect(aside).toBeDefined()
    expect(mem.ctl.data.get(aside!)).toBe('{"state": {"items": [trunc')
    expect(stored(mem.ctl)).toHaveLength(10)
  })
})

describe('killed in the middle of the move', () => {
  it('before the list landed: the next start moves it again, nothing lost, the copy is not replaced', async () => {
    const legacy = range(1, 120)
    const mem = memStorage()
    // The copy lands, then the app dies: the list write and everything after it go nowhere.
    const realSet = mem.storage.setItem
    let n = 0
    mem.storage.setItem = async (k, v) => { n++; if (n > 1) mem.ctl.killed = true; return realSet(k, v) }
    const first = await start(mem, fakeStore(legacy))
    expect(first.state).toBe('unconfirmed')
    expect(mem.ctl.data.has(GALLERY_KEY)).toBe(false)
    expect(JSON.parse(mem.ctl.data.get(GALLERY_BEFORE_MOVE_KEY)!)).toHaveLength(120)

    // Next launch: the create-store copy is still the old list, plus one render.
    mem.storage.setItem = realSet
    mem.ctl.killed = false
    const second = fakeStore([entry(999), ...legacy])
    const h = await start(mem, second)
    expect(h.state).toBe('saved')
    expect(stored(mem.ctl)).toHaveLength(121)
    // The copy by hand is still the list from before the first move.
    expect(JSON.parse(mem.ctl.data.get(GALLERY_BEFORE_MOVE_KEY)!)).toHaveLength(120)
  })

  it('after the list landed, before the check: the next start joins without doubles', async () => {
    const legacy = range(1, 120)
    const mem = memStorage()
    await start(mem, fakeStore(legacy))
    const h = await start(mem, fakeStore(legacy))
    expect(h.state).toBe('saved')
    expect(stored(mem.ctl)).toHaveLength(120)
    expect(new Set(ids(stored(mem.ctl)!)).size).toBe(120)
  })

  it('the copy by hand cannot be written: no move, the old way holds', async () => {
    const legacy = range(1, 50)
    const mem = memStorage()
    mem.ctl.failWrites.add(GALLERY_BEFORE_MOVE_KEY)
    const store = fakeStore(legacy)
    const h = await start(mem, store)
    expect(h.state).toBe('unreadable')
    expect(store.uncapped).toBe(false)
    expect(mem.ctl.data.has(GALLERY_KEY)).toBe(false)
    expect(store.getItems()).toBe(legacy)
  })

  it('the list write throws: it stays in memory without the cap and is written on the next change', async () => {
    const mem = memStorage()
    mem.ctl.failWrites.add(GALLERY_KEY)
    const store = fakeStore(range(1, 30))
    const h = await start(mem, store)
    expect(h.state).toBe('unconfirmed')
    expect(store.getItems()).toHaveLength(30)
    mem.ctl.failWrites.delete(GALLERY_KEY)
    store.setItems([entry(77), ...store.getItems()])
    expect(await h.verify()).toBe(true)
    expect(stored(mem.ctl)).toHaveLength(31)
  })
})

describe('what changed in the app wins', () => {
  it('a deleted entry does not come back from the create-store copy', async () => {
    const mem = memStorage()
    const store = fakeStore(range(1, 5))
    const h = await start(mem, store)
    store.setItems(store.getItems().filter((g) => g.id !== 'g3'))
    await h.flush()
    h.stop()
    // The copy in localStorage missed that write (quota) and still has g3.
    const next = fakeStore(range(1, 5))
    await start(mem, next)
    expect(ids(next.getItems())).not.toContain('g3')
  })

  it('a change made before the move ran is kept over the stored entry', async () => {
    const mem = memStorage({ [GALLERY_KEY]: JSON.stringify({ state: { items: range(1, 4) }, version: 1 }) })
    const atLaunch = range(1, 4)
    // Moved to a folder and one removed, while the restore was still deciding.
    const now = atLaunch.filter((g) => g.id !== 'g2').map((g) => (g.id === 'g4' ? { ...g, folderId: 'f-9' } : g))
    const store = fakeStore(now)
    await start(mem, store, atLaunch)
    expect(ids(store.getItems())).toEqual(['g4', 'g3', 'g1'])
    expect(store.getItems()[0].folderId).toBe('f-9')
  })
})

describe('the parts', () => {
  it('joinGalleries keeps every entry of both sides', () => {
    const { items, added } = joinGalleries(range(1, 3), [...range(2, 3), entry(9)])
    expect(ids(items)).toEqual(['g9', 'g4', 'g3', 'g2', 'g1'])
    expect(added).toBe(2)
  })

  it('joinAtStart without a stored list keeps memory as it is', () => {
    const memory = range(1, 3)
    expect(joinAtStart({ stored: null, memory, hydrated: memory, deleted: [] }).items).toEqual(memory)
  })

  it('downgradeMirror keeps the newest unsorted and sorted entries, hidden ones last', () => {
    const items = [
      ...range(10000, MIRROR_UNSORTED + 50),
      ...range(5000, MIRROR_SORTED + 50, { folderId: 'f' }),
      ...range(1, 10, { hidden: true }),
    ]
    const m = downgradeMirror(items)
    expect(m.filter((g) => !g.folderId)).toHaveLength(MIRROR_UNSORTED)
    expect(m.filter((g) => g.folderId)).toHaveLength(MIRROR_SORTED)
    expect(m.some((g) => g.hidden)).toBe(false)
    expect(m[0].id).toBe(`g${10000 + MIRROR_UNSORTED + 49}`)
    // A small list is the copy itself.
    const small = range(1, 20)
    expect(downgradeMirror(small)).toBe(small)
  })

  it('rememberDeleted keeps the newest ids only', () => {
    const many = Array.from({ length: DELETED_KEPT + 10 }, (_, i) => `d${i}`)
    const kept = rememberDeleted([], many)
    expect(kept).toHaveLength(DELETED_KEPT)
    expect(kept[kept.length - 1]).toBe(`d${DELETED_KEPT + 9}`)
  })

  it('sanitizeEntries keeps unknown fields and drops only what cannot be an entry', () => {
    const out = sanitizeEntries<Entry>([
      entry(1, { prompt: 'x' }), null, 'nope', { createdAt: 3 }, { id: 'g1', createdAt: 9 },
      { id: 'g5', createdAt: 'later', future: { a: 1 }, tags: ['a', 'A', 7, ' b '], hidden: 'yes' },
    ])
    expect(ids(out)).toEqual(['g1', 'g5'])
    expect(out[1]).toEqual({ id: 'g5', createdAt: 0, future: { a: 1 }, tags: ['a', 'b'] })
  })

  it('storedForm leaves an entry without runtime fields as the same object', () => {
    const e = entry(1)
    expect(storedForm(e)).toBe(e)
  })
})
