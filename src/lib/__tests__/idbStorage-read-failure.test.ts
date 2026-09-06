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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

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
        // holdBackWrite asks "does this key hold anything" with count(), not
        // get(): the answer is one bit and get() materialised megabytes for it.
        count: (k: string) => {
          const r: Record<string, unknown> = {
            onsuccess: null, onerror: null,
            result: k in data ? 1 : 0,
            error: new DOMException('store is not readable', 'NotReadableError'),
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

describe('the appData snapshot omits an unreadable store instead of emptying it', () => {
  const backendCall = vi.fn()

  const snapshots = () =>
    backendCall.mock.calls
      .filter((c) => c[0] === 'backup_stores')
      .map((c) => JSON.parse((c[1] as { data: string }).data) as Record<string, string>)

  beforeEach(() => {
    vi.resetModules()
    backendCall.mockReset()
    backendCall.mockResolvedValue(undefined)
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('../idbStorage') })

  /** An idbStorage whose chat key is latched unreadable, counting the reads. */
  function mockUnreadable(failed: Set<string>, reads: string[]) {
    vi.doMock('../idbStorage', () => ({
      idbStorage: {
        getItem: (k: string) => { reads.push(k); return failed.has(k) ? null : (localStorage.getItem(k) ?? null) },
        setItem: () => {},
        removeItem: () => {},
      },
      hasFailedRead: (k: string) => failed.has(k),
      onIdbWrite: () => () => {},
    }))
    vi.doMock('../../api/backend', () => ({ backendCall: (...a: unknown[]) => backendCall(...a) }))
  }

  it('still backs up the other stores, with the unreadable key absent', async () => {
    // `backup_stores` does NOT replace the file: commands/system.rs reads the
    // backup already on disk and carries over every key the incoming snapshot
    // lost (keys_lost + merged_backup). So a snapshot built while the chat key
    // is unreadable is INCOMPLETE, not destructive — the chats keep the value
    // they had. What must never happen is the key turning up EMPTY, which is
    // what the merge cannot tell from a real deletion.
    //
    // The old rule refused the whole write instead, which cost the other 23
    // stores their backup for as long as it lasted.
    const failed = new Set<string>(['chat-conversations'])
    const reads: string[] = []
    mockUnreadable(failed, reads)

    const { backupStoresIfChanged, backupStoresNow, flushSyncStoreBackup } = await import('../store-backup')
    localStorage.setItem('chat-settings', '{"state":{"theme":"dark"}}')

    expect(await backupStoresIfChanged()).toBe('written')
    const snap = snapshots().at(-1)!
    expect('chat-conversations' in snap).toBe(false)
    expect(snap['chat-settings']).toContain('dark')

    localStorage.setItem('workflow-store', '{"state":{}}')
    expect(flushSyncStoreBackup()).toBe('written')
    expect('chat-conversations' in snapshots().at(-1)!).toBe(false)

    expect(await backupStoresNow()).toBe(true)
    expect('chat-conversations' in snapshots().at(-1)!).toBe(false)
  })

  it('keeps re-reading the latched key, so the latch is not a dead end', async () => {
    // Only a later READ can clear the read-failure latch (idbStorage's getItem
    // and holdBackWrite are the only two places that delete from it). The old
    // guard checked the latch and returned BEFORE building the snapshot, so
    // nothing ever read the key again and one transient failure stopped the
    // backup for the rest of the session.
    const failed = new Set<string>(['chat-conversations'])
    const reads: string[] = []
    mockUnreadable(failed, reads)

    const { backupStoresIfChanged } = await import('../store-backup')
    await backupStoresIfChanged()

    reads.length = 0
    localStorage.setItem('chat-settings', '{"state":{"theme":"light"}}')
    await backupStoresIfChanged()
    expect(reads).toContain('chat-conversations')

    // ...and once IndexedDB comes back, the key is in the snapshot again.
    failed.clear()
    localStorage.setItem('chat-conversations', '{"state":{"conversations":[1]}}')
    expect(await backupStoresIfChanged()).toBe('written')
    expect(snapshots().at(-1)!['chat-conversations']).toContain('conversations')
  })
})

/**
 * The rule above is only safe because of what the Rust command does, so that
 * is pinned here rather than assumed. If commands/system.rs ever stops merging
 * a lost key back in, "omit and write" becomes "delete", and this test is the
 * thing that says so.
 */
describe('backup_stores merges a lost key instead of replacing the file', () => {
  it('is wired into the command, not just defined next to it', () => {
    const rust = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../src-tauri/src/commands/system.rs'),
      'utf8',
    )
    const command = rust.slice(rust.indexOf('pub fn backup_stores('))
    const body = command.slice(0, command.indexOf('\n}\n'))
    expect(body).toContain('keys_lost(')
    expect(body).toContain('merged_backup(')
    // The previous file has to be READ before the new one is written, or there
    // is nothing to merge from.
    expect(body).toMatch(/read_to_string\(&target\)[\s\S]*keys_lost\(/)
  })
})
