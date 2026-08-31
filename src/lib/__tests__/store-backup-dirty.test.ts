/**
 * The appData snapshot must only be written when a store actually changed.
 *
 * M4: the triad serialised the WHOLE chat history and re-wrote
 * %APPDATA%/store_backup.json every five seconds, unconditionally, with no
 * dirty check — the multi-megabyte churn coalescedStorage was written to stop,
 * reintroduced one layer up and running forever on an idle app.
 *
 * Run: npx vitest run src/lib/__tests__/store-backup-dirty.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const backendCall = vi.fn()
vi.mock('../../api/backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
}))

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

/** Payloads handed to the backup_stores command, parsed. */
function writtenSnapshots() {
  return backendCall.mock.calls
    .filter((c) => c[0] === 'backup_stores')
    .map((c) => JSON.parse((c[1] as { data: string }).data) as Record<string, string>)
}

describe('store backup only writes on a change', () => {
  beforeEach(() => {
    vi.resetModules()
    backendCall.mockReset()
    backendCall.mockResolvedValue(undefined)
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes the first snapshot of a session and then goes quiet', async () => {
    const { backupStoresIfChanged } = await import('../store-backup')

    expect(await backupStoresIfChanged()).toBe('written')
    expect(writtenSnapshots()).toHaveLength(1)

    // The five-second tick used to fire here, and here, and here...
    expect(await backupStoresIfChanged()).toBe('unchanged')
    expect(await backupStoresIfChanged()).toBe('unchanged')
    expect(await backupStoresIfChanged()).toBe('unchanged')
    expect(writtenSnapshots()).toHaveLength(1)
  })

  it('a changed localStorage-backed store makes exactly one write', async () => {
    const { backupStoresIfChanged } = await import('../store-backup')
    await backupStoresIfChanged()

    localStorage.setItem('chat-settings', '{"state":{"settings":{"theme":"light"}}}')
    expect(await backupStoresIfChanged()).toBe('written')
    expect(await backupStoresIfChanged()).toBe('unchanged')
    expect(writtenSnapshots()).toHaveLength(2)
    expect(writtenSnapshots()[1]['chat-settings']).toContain('light')
  })

  it('a changed IndexedDB-backed store is noticed without re-reading it', async () => {
    const { backupStoresIfChanged } = await import('../store-backup')
    const { idbStorage } = await import('../idbStorage')
    await backupStoresIfChanged()

    await Promise.resolve(idbStorage.setItem('chat-conversations', '{"state":{"conversations":[1]}}'))
    expect(await backupStoresIfChanged()).toBe('written')
    expect(writtenSnapshots()[1]['chat-conversations']).toContain('conversations')
    expect(await backupStoresIfChanged()).toBe('unchanged')
    expect(writtenSnapshots()).toHaveLength(2)
  })

  it('the timestamp alone never counts as a change', async () => {
    const { backupStoresIfChanged } = await import('../store-backup')
    await backupStoresIfChanged()
    const first = writtenSnapshots()[0]
    expect(first.__ts).toBeTruthy() // a fresh install still writes a dated file

    await new Promise((r) => setTimeout(r, 5))
    expect(await backupStoresIfChanged()).toBe('unchanged')
  })

  it('a failed write is retried instead of being remembered as done', async () => {
    const { backupStoresIfChanged } = await import('../store-backup')
    backendCall.mockRejectedValue(new Error('invoke failed'))

    expect(await backupStoresIfChanged()).toBe('written')
    await Promise.resolve() // let the rejection land
    await Promise.resolve()

    backendCall.mockResolvedValue(undefined)
    // Nothing changed in the stores, but nothing reached disk either.
    expect(await backupStoresIfChanged()).toBe('written')
  })

  it('the beforeunload flush never writes a snapshot with the chats missing', async () => {
    // The sync path cannot await IndexedDB, so it reads the write mirror. Until
    // the first async backup has filled it, "no chats" and "nobody has looked"
    // are the same thing — and writing REPLACES the file that has them.
    const { backupStoresIfChanged, flushSyncStoreBackup } = await import('../store-backup')
    const { idbStorage } = await import('../idbStorage')
    await Promise.resolve(idbStorage.setItem('chat-conversations', '{"state":{"conversations":[1]}}'))
    await backupStoresIfChanged()

    // Simulate the mirror being empty at teardown by starting a fresh module
    // with the same stored data: nothing has been written this session.
    vi.resetModules()
    backendCall.mockClear()
    const fresh = await import('../store-backup')
    expect(fresh.flushSyncStoreBackup()).toBe('held-back')
    expect(backendCall).not.toHaveBeenCalled()

    // Once the async path has read the chats once, the sync flush is safe.
    await fresh.backupStoresIfChanged()
    localStorage.setItem('workflow-store', '{"state":{}}')
    expect(fresh.flushSyncStoreBackup()).toBe('written')
    expect(writtenSnapshots().at(-1)!['chat-conversations']).toContain('conversations')
  })

  it('the beforeunload flush is synchronous and also skips an unchanged store', async () => {
    const { backupStoresIfChanged, flushSyncStoreBackup } = await import('../store-backup')
    await backupStoresIfChanged()

    expect(flushSyncStoreBackup()).toBe('unchanged')

    localStorage.setItem('workflow-store', '{"state":{}}')
    // No await anywhere: the page is tearing down and an await would mean the
    // trailing invoke never fires.
    expect(flushSyncStoreBackup()).toBe('written')
    expect(writtenSnapshots()).toHaveLength(2)
  })
})
