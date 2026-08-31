/**
 * A failed IndexedDB READ must never turn into an empty write.
 *
 * M4/4, filed as unproven. It is reachable: `idbGet` used to resolve `null`
 * from its own `onerror`, so an unreadable transaction was indistinguishable
 * from an empty key. zustand hydrated the DEFAULT state from that null and
 * persisted on the very next set() — one bad read replaced the whole chat
 * history, and the appData snapshot (built from the same reads) was replaced
 * seconds later with a copy that no longer had the chats in it either.
 *
 * Run: npx vitest run src/lib/__tests__/idbStorage-read-failure.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Fake IndexedDB whose reads fail while `failReads` is on. Writes always work,
 * so a write that lands is proof the guard let it through.
 */
function fakeIndexedDB(data: Record<string, string>) {
  const state = { failReads: true }
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => {
          const r: Record<string, unknown> = {
            onsuccess: null, onerror: null,
            result: data[k], error: new DOMException('store is not readable', 'NotReadableError'),
          }
          queueMicrotask(() => {
            if (state.failReads) (r.onerror as (() => void) | null)?.()
            else (r.onsuccess as (() => void) | null)?.()
          })
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
    state,
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

const HISTORY = '{"state":{"conversations":[{"id":"a","messages":[1,2,3]}]}}'
const EMPTY = '{"state":{"conversations":[]}}'

describe('idbStorage tells a failed read apart from an empty one', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('does not let the state hydrated from a failed read overwrite the stored history', async () => {
    const data: Record<string, string> = { 'chat-conversations': HISTORY }
    const idb = fakeIndexedDB(data)
    vi.stubGlobal('indexedDB', idb)
    const { idbStorage, hasFailedRead } = await import('../idbStorage')

    // Hydration: the read fails, so the store comes up empty.
    expect(await idbStorage.getItem('chat-conversations')).toBeNull()
    expect(hasFailedRead('chat-conversations')).toBe(true)

    // zustand persists that empty state on the next set(). The row must survive.
    idb.state.failReads = false // the transient failure is over
    await idbStorage.setItem('chat-conversations', EMPTY)
    expect(data['chat-conversations']).toBe(HISTORY)
    expect(hasFailedRead('chat-conversations')).toBe(true)
  })

  it('refuses again while the key stays unreadable', async () => {
    const data: Record<string, string> = { 'chat-conversations': HISTORY }
    const idb = fakeIndexedDB(data)
    vi.stubGlobal('indexedDB', idb)
    const { idbStorage } = await import('../idbStorage')

    await idbStorage.getItem('chat-conversations')
    await idbStorage.setItem('chat-conversations', EMPTY)
    expect(data['chat-conversations']).toBe(HISTORY)
  })

  it('releases the hold when a later read proves the key really is empty', async () => {
    // A first run behind a transient failure: nothing is stored, so there is
    // nothing to protect and refusing forever would mean never persisting.
    const data: Record<string, string> = {}
    const idb = fakeIndexedDB(data)
    vi.stubGlobal('indexedDB', idb)
    const { idbStorage, hasFailedRead } = await import('../idbStorage')

    expect(await idbStorage.getItem('chat-conversations')).toBeNull()
    expect(hasFailedRead('chat-conversations')).toBe(true)

    idb.state.failReads = false
    await idbStorage.setItem('chat-conversations', EMPTY)
    expect(data['chat-conversations']).toBe(EMPTY)
    expect(hasFailedRead('chat-conversations')).toBe(false)
  })

  it('a successful read clears the hold and normal writes resume', async () => {
    const data: Record<string, string> = { 'chat-conversations': HISTORY }
    const idb = fakeIndexedDB(data)
    vi.stubGlobal('indexedDB', idb)
    const { idbStorage, hasFailedRead } = await import('../idbStorage')

    await idbStorage.getItem('chat-conversations')
    idb.state.failReads = false
    expect(await idbStorage.getItem('chat-conversations')).toBe(HISTORY)
    expect(hasFailedRead('chat-conversations')).toBe(false)

    await idbStorage.setItem('chat-conversations', EMPTY)
    expect(data['chat-conversations']).toBe(EMPTY)
  })

  it('holds back only the key that failed', async () => {
    const data: Record<string, string> = { 'chat-conversations': HISTORY, 'locally-uncensored-memory': 'mem' }
    const idb = fakeIndexedDB(data)
    vi.stubGlobal('indexedDB', idb)
    const { idbStorage, hasFailedRead } = await import('../idbStorage')

    await idbStorage.getItem('chat-conversations')
    expect(hasFailedRead('locally-uncensored-memory')).toBe(false)

    idb.state.failReads = false
    await idbStorage.setItem('locally-uncensored-memory', 'new-mem')
    expect(data['locally-uncensored-memory']).toBe('new-mem')
  })
})

describe('the appData snapshot is not replaced while a store is unreadable', () => {
  const backendCall = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    backendCall.mockReset()
    backendCall.mockResolvedValue(undefined)
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('../idbStorage') })

  it('skips the write instead of saving a snapshot with the chats missing', async () => {
    // backup_stores REPLACES the file. A snapshot built while the chat key is
    // unreadable simply has no chats in it, and writing it destroys the last
    // copy that did.
    const failed = new Set<string>(['chat-conversations'])
    vi.doMock('../idbStorage', () => ({
      idbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      hasFailedRead: (k: string) => failed.has(k),
      onIdbWrite: () => () => {},
    }))
    vi.doMock('../../api/backend', () => ({ backendCall: (...a: unknown[]) => backendCall(...a) }))

    const { backupStoresIfChanged, backupStoresNow, flushSyncStoreBackup } = await import('../store-backup')

    expect(await backupStoresIfChanged()).toBe('held-back')
    expect(flushSyncStoreBackup()).toBe('held-back')
    expect(await backupStoresNow()).toBe(false)
    expect(backendCall).not.toHaveBeenCalled()

    failed.clear()
    expect(await backupStoresIfChanged()).toBe('written')
    expect(backendCall).toHaveBeenCalledWith('backup_stores', expect.anything())
  })
})
