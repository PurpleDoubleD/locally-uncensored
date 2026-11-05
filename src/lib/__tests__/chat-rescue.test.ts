/**
 * Restore chats from backup (3.0.10), and the launch check that missed them.
 *
 * perrt, Discord 05.11.2026, on 3.0.8: every chat gone, the memories still
 * there. Run: npx vitest run src/lib/__tests__/chat-rescue.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const backend = vi.hoisted(() => vi.fn())
vi.mock('../../api/backend', () => ({ isTauri: () => true, backendCall: backend }))

import { useChatStore } from '../../stores/chatStore'
import type { Conversation } from '../../types/chat'
import { parseImportedChats } from '../chat-export'
import { chatsMissingFrom, restoreChatsFromBackup, countRestorableChats, shouldShowRescueHint, readDismissedAt, rememberDismissed } from '../chat-rescue'

/**
 * Conversations in the shape 3.0.8 persisted them (src/types/chat.ts at
 * v3.0.8): no customParams, no groupSitOut, no historyTrim, compaction
 * records without contextBefore/endMessageId.
 */
function chat308(id: string, updatedAt: number, extra: Record<string, unknown> = {}): Conversation {
  return {
    id,
    title: `chat ${id}`,
    messages: [
      { id: `${id}-u`, role: 'user', content: 'hello', timestamp: updatedAt - 2 },
      { id: `${id}-a`, role: 'assistant', content: 'hi', timestamp: updatedAt - 1, model: 'llama3' },
    ],
    model: 'llama3',
    systemPrompt: '',
    mode: 'lu',
    createdAt: 1,
    updatedAt,
    personaEnabled: false,
    ...extra,
  } as unknown as Conversation
}

/** What `chat_backup_conversations` hands back: one JSON array. */
function backupAnswer(list: unknown[]) {
  backend.mockImplementation(async (cmd: string) => {
    if (cmd === 'chat_backup_conversations') return JSON.stringify(list)
    throw new Error(`unexpected ${cmd}`)
  })
}

describe('restore chats from backup', () => {
  beforeEach(() => {
    backend.mockReset()
    useChatStore.setState({ conversations: [], activeConversationId: null })
  })

  it('brings back the chats the store lost and keeps the one written after the loss', async () => {
    // After the loss: the store has one new chat. The backups hold the old ones,
    // a group chat among them, plus an older copy of the new chat.
    useChatStore.setState({ conversations: [chat308('new', 500)] })
    backupAnswer([
      chat308('a', 100),
      chat308('group', 200, { groupModels: ['llama3', 'qwen'], groupPersonas: { qwen: 'p1' } }),
      chat308('compacted', 300, { compactions: [{ id: 'k1', at: 290, atMessageCount: 2, summary: 's', tokensBefore: 10, tokensAfter: 2 }] }),
      chat308('new', 400),
      { id: 'broken' },
      null,
    ])

    const live = () => useChatStore.getState().conversations
    expect(await countRestorableChats(live)).toBe(3)

    const added = await restoreChatsFromBackup(live, useChatStore.getState().importConversations)
    expect(added).toBe(3)
    const ids = live().map((c) => c.id)
    expect(ids).toEqual(['new', 'compacted', 'group', 'a'])
    expect(new Set(ids).size).toBe(ids.length)
    // The chat written after the loss is the live one, not the backup's older copy.
    expect(live().find((c) => c.id === 'new')!.updatedAt).toBe(500)
    expect(live().find((c) => c.id === 'group')!.groupModels).toEqual(['llama3', 'qwen'])

    // Twice changes nothing.
    expect(await restoreChatsFromBackup(live, useChatStore.getState().importConversations)).toBe(0)
    expect(live()).toHaveLength(4)
  })

  it('an empty or missing backup restores nothing', async () => {
    backupAnswer([])
    expect(await restoreChatsFromBackup(() => [], vi.fn())).toBe(0)
    backend.mockResolvedValue('')
    expect(await countRestorableChats(() => [])).toBe(0)
  })

  it('keeps one entry per id even if the list repeats one', () => {
    const list = chatsMissingFrom([], [chat308('x', 1), chat308('x', 2)])
    expect(list.map((c) => c.id)).toEqual(['x'])
  })
})

describe('a store backup picked by hand', () => {
  it('imports its chats and merges them next to the ones written since', () => {
    // perrt: about five hours on after the loss, two new chats; the old ones
    // only in a store_backup.prev.json he copied out to a rescue folder.
    useChatStore.setState({ conversations: [chat308('new1', 900), chat308('new2', 950)] })
    const file = JSON.stringify({
      __ts: 'x',
      'chat-conversations': JSON.stringify({ state: { conversations: [chat308('old1', 100), chat308('old2', 200)], activeConversationId: 'old2' } }),
      'chat-settings': '{}',
    })
    const { added } = useChatStore.getState().importConversations(parseImportedChats(file), 'merge')
    expect(added).toBe(2)
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['new2', 'new1', 'old2', 'old1'])
  })

  it('a backup whose chats are unreadable says so', () => {
    expect(() => parseImportedChats(JSON.stringify({ 'chat-conversations': 'garbled' }))).toThrow(/could not be read/)
  })
})

describe('the hint at launch', () => {
  it('shows for an empty list with chats in the backup', () => {
    expect(shouldShowRescueHint(0, 12, null)).toBe(true)
    expect(shouldShowRescueHint(0, 0, null)).toBe(false)
  })

  it('shows when the backup holds more chats than the list (a new chat after the loss)', () => {
    expect(shouldShowRescueHint(1, 40, null)).toBe(true)
    // A couple of deleted chats in an archive is not that.
    expect(shouldShowRescueHint(30, 2, null)).toBe(false)
  })

  it('stays away after Dismiss until the backup holds more', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    rememberDismissed(storage, 12)
    expect(readDismissedAt(storage)).toBe(12)
    expect(shouldShowRescueHint(0, 12, readDismissedAt(storage))).toBe(false)
    expect(shouldShowRescueHint(0, 13, readDismissedAt(storage))).toBe(true)
  })
})

// ── The launch check (AppShell) ─────────────────────────────────────────────

/** IndexedDB stand-in that stores any value, string or not. */
function fakeIndexedDB(data: Record<string, unknown>) {
  const request = (result: unknown) => {
    const r: Record<string, unknown> = { onsuccess: null, onerror: null, result, error: null }
    queueMicrotask(() => (r.onsuccess as (() => void) | null)?.())
    return r
  }
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => request(data[k]),
        count: (k: string) => request(k in data ? 1 : 0),
        put: (v: unknown, k: string) => { data[k] = v; return {} },
        delete: (k: string) => { delete data[k]; return {} },
      }),
      set oncomplete(fn: () => void) { queueMicrotask(fn) },
      set onerror(_fn: () => void) {},
      set onabort(_fn: () => void) {},
    }),
  }
  return {
    open: () => {
      const req: Record<string, unknown> = { onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null, result: db, error: null }
      queueMicrotask(() => (req.onsuccess as (() => void) | null)?.())
      return req
    },
  }
}

function fakeLocalStorage(init: Record<string, string> = {}) {
  const mem = new Map(Object.entries(init))
  return {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
}

describe('the launch check sees what hydration sees', () => {
  const saved = { idb: Reflect.get(globalThis, 'indexedDB'), ls: Reflect.get(globalThis, 'localStorage') }

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', { value: saved.idb, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: saved.ls, configurable: true, writable: true })
    vi.resetModules()
  })

  async function load(rows: Record<string, unknown>, ls: Record<string, string> = {}) {
    vi.resetModules()
    Object.defineProperty(globalThis, 'indexedDB', { value: fakeIndexedDB(rows), configurable: true, writable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: fakeLocalStorage(ls), configurable: true, writable: true })
    vi.doMock('../storage-health', () => ({
      requestPersistentStorage: async () => true,
      reportStorageReadFailure: () => {}, reportStorageReadOk: () => {},
      reportStorageWriteFailure: () => {}, reportStorageWriteOk: () => {},
    }))
    return await import('../idbStorage')
  }

  it('a row that is no string: the old check said present, hydration got nothing', async () => {
    const { idbStorage, hasStoredItem, hasReadableItem } = await load({ 'chat-conversations': { state: { conversations: [] } } })
    expect(await idbStorage.getItem('chat-conversations')).toBeNull()
    // The 3.0.8 rule: "present", so nothing was restored.
    expect(await hasStoredItem('chat-conversations')).toBe(true)
    // The 3.0.10 rule: empty, so the backup goes back in.
    expect(await hasReadableItem('chat-conversations')).toBe(false)
  })

  it('a leftover "[object Object]" in localStorage: same blind spot', async () => {
    const { idbStorage, hasStoredItem, hasReadableItem } = await load({}, { 'chat-conversations': '[object Object]' })
    expect(await idbStorage.getItem('chat-conversations')).toBeNull()
    expect(await hasStoredItem('chat-conversations')).toBe(true)
    expect(await hasReadableItem('chat-conversations')).toBe(false)
  })

  it('a real value is present for both', async () => {
    const value = JSON.stringify({ state: { conversations: [chat308('a', 1)] } })
    const { hasStoredItem, hasReadableItem } = await load({ 'chat-conversations': value })
    expect(await hasStoredItem('chat-conversations')).toBe(true)
    expect(await hasReadableItem('chat-conversations')).toBe(true)
  })
})
