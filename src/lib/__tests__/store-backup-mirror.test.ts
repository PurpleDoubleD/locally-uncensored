/**
 * The appData snapshot is fed by idbStorage's write listener, not by re-reading
 * IndexedDB on a timer.
 *
 * WHY THIS FILE EXISTS. `onIdbWrite` + store-backup's `idbMirror` were added
 * with the claim that "the 5 s tick never reads the multi-megabyte blobs out of
 * IndexedDB again" — and nothing asserted it. A counter-check deleted the
 * `emitWrite` call from BOTH branches of `idbStorage.setItem` and the whole
 * suite stayed green: the registry could have been dead code and no one would
 * have found out until a user's battery did.
 *
 * So these tests count the reads the tick actually performs, against a real
 * idbStorage over a fake IndexedDB. Remove either `emitWrite` and they fail.
 *
 * Run: npx vitest run src/lib/__tests__/store-backup-mirror.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
}))

/** A fake IndexedDB that counts every read it is asked for. */
function fakeIndexedDB(data: Record<string, string>) {
  const reads: string[] = []
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => {
          reads.push(k)
          const r: Record<string, unknown> = { onsuccess: null, onerror: null, result: data[k] }
          queueMicrotask(() => (r.onsuccess as (() => void) | null)?.())
          return r
        },
        count: (k: string) => {
          const r: Record<string, unknown> = { onsuccess: null, onerror: null, result: k in data ? 1 : 0 }
          queueMicrotask(() => (r.onsuccess as (() => void) | null)?.())
          return r
        },
        put: (v: string, k: string) => { data[k] = v; return {} },
        delete: (k: string) => { delete data[k]; return {} },
      }),
      set oncomplete(fn: () => void) { queueMicrotask(fn) },
      set onerror(_fn: () => void) {},
      set onabort(_fn: () => void) {},
    }),
  }
  return {
    reads,
    open: () => {
      const req: Record<string, unknown> = {
        onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null,
        result: db, error: null,
      }
      queueMicrotask(() => (req.onsuccess as (() => void) | null)?.())
      return req
    },
  }
}

function fakeLocalStorage() {
  const mem = new Map<string, string>()
  return {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    get length() { return mem.size },
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
  }
}

function writtenSnapshots() {
  return backendCall.mock.calls
    .filter((c) => c[0] === 'backup_stores')
    .map((c) => JSON.parse((c[1] as { data: string }).data) as Record<string, string>)
}

/** Stands in for the thing this is all about: a long coding chat. */
const HISTORY = `{"state":{"conversations":[{"id":"a","messages":["${'x'.repeat(4000)}"]}]}}`
const LONGER = `${HISTORY.slice(0, -2)},"n":2}}`

let idb: ReturnType<typeof fakeIndexedDB>

beforeEach(() => {
  vi.resetModules()
  backendCall.mockReset()
  backendCall.mockResolvedValue(undefined)
  vi.stubGlobal('localStorage', fakeLocalStorage())
  idb = fakeIndexedDB({})
  vi.stubGlobal('indexedDB', idb)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('the backup tick reads a chat blob at most once per session', () => {
  it('takes the new history off the write listener instead of re-reading it', async () => {
    const { idbStorage } = await import('../idbStorage')
    const { backupStoresIfChanged } = await import('../store-backup')

    // First tick: nothing has gone past the listener yet, so the snapshot has
    // to look in IndexedDB. That read is the one this design pays for.
    expect(await backupStoresIfChanged()).toBe('written')
    expect(idb.reads).toContain('chat-conversations')

    await idbStorage.setItem('chat-conversations', HISTORY)
    idb.reads.length = 0

    // Second tick: the exact string is already in hand.
    expect(await backupStoresIfChanged()).toBe('written')
    expect(writtenSnapshots().at(-1)!['chat-conversations']).toBe(HISTORY)
    expect(idb.reads).toEqual([])

    // And it stays that way for every tick after — this is the churn the
    // mirror exists to remove, on an idle app, on battery.
    await idbStorage.setItem('chat-conversations', LONGER)
    idb.reads.length = 0
    expect(await backupStoresIfChanged()).toBe('written')
    expect(writtenSnapshots().at(-1)!['chat-conversations']).toBe(LONGER)
    expect(idb.reads).toEqual([])
  })

  it('a store that legitimately holds nothing is read once, not once per tick', async () => {
    // 'staged-changes' is null for every user who has never approved a code
    // edit. It used to be pulled out of IndexedDB on every single tick because
    // only a NON-null answer was remembered — a read per five seconds that can
    // only ever return nothing, and every one of them another chance for a
    // transient failure to arm the read-failure latch.
    const { backupStoresIfChanged } = await import('../store-backup')

    await backupStoresIfChanged()
    expect(idb.reads).toContain('staged-changes')

    idb.reads.length = 0
    localStorage.setItem('chat-settings', '{"state":{"theme":"light"}}')
    await backupStoresIfChanged()
    localStorage.setItem('chat-settings', '{"state":{"theme":"dark"}}')
    await backupStoresIfChanged()

    expect(idb.reads).toEqual([])
  })

  it('the beforeunload flush carries a write the mirror saw, with no await', async () => {
    // The sync path CANNOT read IndexedDB — an await during teardown means the
    // trailing invoke may never fire. The listener is the only way the chats
    // that were written this session reach that last snapshot.
    const { idbStorage } = await import('../idbStorage')
    const { backupStoresIfChanged, flushSyncStoreBackup } = await import('../store-backup')

    await backupStoresIfChanged()
    await idbStorage.setItem('chat-conversations', HISTORY)

    expect(flushSyncStoreBackup()).toBe('written')
    expect(writtenSnapshots().at(-1)!['chat-conversations']).toBe(HISTORY)
  })

  it('a removed store drops back out of the snapshot', async () => {
    const { idbStorage } = await import('../idbStorage')
    const { backupStoresIfChanged } = await import('../store-backup')

    await idbStorage.setItem('chat-conversations', HISTORY)
    await backupStoresIfChanged()
    expect(writtenSnapshots().at(-1)!['chat-conversations']).toBe(HISTORY)

    await idbStorage.removeItem('chat-conversations')
    idb.reads.length = 0
    expect(await backupStoresIfChanged()).toBe('written')
    expect('chat-conversations' in writtenSnapshots().at(-1)!).toBe(false)
    expect(idb.reads).toEqual([])
  })
})
