// @vitest-environment jsdom
/**
 * Gap L6 (mobile-docs/r38/luecken.md, fixed in r39/restore.md). When only
 * localStorage was dropped, the start takes the full restore. IndexedDB still
 * holds the chats and memories then, and they are NEWER than the native
 * backup (a copy written up to 1 s or 5 s later). The full restore used to
 * write the backup over them. Now a present store is merged record by record,
 * the newer copy wins, nothing present is removed, nothing is doubled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  idb: new Map<string, string>(),
  backup: {} as Record<string, string>,
  ragBackup: {} as Record<string, unknown>,
  chunks: {} as Record<string, unknown[]>,
  vectors: {} as Record<string, unknown>,
}))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: async (cmd: string) => {
    if (cmd === 'restore_stores') return JSON.stringify(world.backup)
    if (cmd === 'restore_rag_chunks') return JSON.stringify(world.ragBackup)
    if (cmd === 'is_onboarding_done') return true
    return null
  },
}))
vi.mock('../../../lib/idbStorage', () => ({
  hasStoredItem: async (key: string) => world.idb.has(key),
  hasReadableItem: async (key: string) => world.idb.has(key),
  hasFailedRead: () => false,
  onIdbWrite: () => () => {},
  idbStorage: {
    getItem: async (key: string) => world.idb.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      world.idb.set(key, value)
    },
    removeItem: async (key: string) => {
      world.idb.delete(key)
    },
  },
}))
vi.mock('../../../lib/chat-backup-recovery', () => ({ recoverChatsFromBackup: async () => {} }))
vi.mock('../../lib/store-journal', () => ({ mergeStoreJournal: async () => {} }))
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: { persist: { hasHydrated: () => true, onFinishHydration: () => {} }, getState: () => ({ conversations: [], importConversations: () => {} }) },
}))
vi.mock('../../../lib/ragDB', () => ({
  exportAllChunks: async () => ({ ...world.chunks }),
  importAllChunks: async (snapshot: Record<string, unknown[]>) => {
    Object.assign(world.chunks, snapshot)
    return Object.keys(snapshot).length
  },
}))
vi.mock('../../../lib/memoryEmbedDB', () => ({
  exportAll: async () => ({ ...world.vectors }),
  importAll: async (snapshot: Record<string, unknown>) => {
    Object.assign(world.vectors, snapshot)
    return Object.keys(snapshot).length
  },
}))

const chat = (id: string, updatedAt: number, text = id) => ({ id, title: id, updatedAt, createdAt: 1, messages: [{ id: `${id}-m`, role: 'user', content: text }] })
const chats = (list: unknown[]) => JSON.stringify({ state: { conversations: list }, version: 0 })
const memory = (id: string, updatedAt: number, content = id) => ({ id, type: 'user', title: id, description: id, content, tags: [], createdAt: 1, updatedAt, source: 'manual' })
const memories = (list: unknown[]) => JSON.stringify({ state: { entries: list, accountCollections: {}, settings: { autoExtractEnabled: false } }, version: 3 })

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  world.idb = new Map()
  world.chunks = {}
  world.vectors = {}
  world.ragBackup = {}
  Object.defineProperty(window, 'location', { value: { ...window.location, reload: vi.fn() }, configurable: true })
})

async function start() {
  const { runStoreRestore } = await import('../restore')
  return runStoreRestore()
}

function liveChats(): Array<{ id: string; updatedAt: number; messages: Array<{ content: string }> }> {
  return JSON.parse(world.idb.get('chat-conversations')!).state.conversations
}

describe('the full restore when only localStorage was dropped (gap L6)', () => {
  it('keeps the newer chats and memories of IndexedDB and takes from the backup only what is newer there', async () => {
    world.backup = {
      'chat-settings': '{"state":{"settings":{}}}',
      // The backup, a second older: chat "a" before its last answer, "b" newer than IndexedDB has it (a refused write), "gone" deleted since.
      'chat-conversations': chats([chat('b', 300, 'b from the backup'), chat('a', 100, 'a old'), chat('gone', 50)]),
      'locally-uncensored-memory': memories([memory('m1', 100, 'old text'), memory('m-deleted', 20)]),
    }
    world.idb.set('chat-conversations', chats([chat('new', 400), chat('a', 200, 'a with its last answer'), chat('b', 150, 'b live')]))
    world.idb.set('locally-uncensored-memory', memories([memory('m1', 200, 'edited text'), memory('m2', 210)]))

    expect((await start()).kind).toBe('reloading')

    const list = liveChats()
    expect(list.map((c) => c.id)).toEqual(['new', 'b', 'a'])
    expect(list.find((c) => c.id === 'a')!.messages[0].content).toBe('a with its last answer')
    expect(list.find((c) => c.id === 'b')!.messages[0].content).toBe('b from the backup')
    const mem = JSON.parse(world.idb.get('locally-uncensored-memory')!).state.entries as Array<{ id: string; content: string }>
    expect(mem.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(mem[0].content).toBe('edited text')
    // localStorage came back from the backup as before.
    expect(localStorage.getItem('chat-settings')).toBe('{"state":{"settings":{}}}')
  })

  it('a store that is present and not older is not written at all', async () => {
    const live = chats([chat('a', 200)])
    world.backup = { 'chat-settings': '{"state":{}}', 'chat-conversations': chats([chat('a', 100)]) }
    world.idb.set('chat-conversations', live)
    await start()
    expect(world.idb.get('chat-conversations')).toBe(live)
  })

  it('a store IndexedDB lost as well still comes back whole from the backup', async () => {
    const saved = chats([chat('a', 100), chat('b', 90)])
    world.backup = { 'chat-settings': '{"state":{}}', 'chat-conversations': saved }
    await start()
    expect(world.idb.get('chat-conversations')).toBe(saved)
  })

  it('passages and memory vectors IndexedDB still has are not put back over, missing ones are', async () => {
    world.backup = { 'chat-settings': '{"state":{}}' }
    world.ragBackup = {
      doc1: [{ id: 'doc1-0', documentId: 'doc1', content: 'old reading', embedding: [0.1], index: 0 }],
      doc2: [{ id: 'doc2-0', documentId: 'doc2', content: 'only in the backup', embedding: [0.2], index: 0 }],
      __memory_vectors__: { m1: { model: 'e', dim: 1, vector: [0.5], contentHash: 'old' }, m9: { model: 'e', dim: 1, vector: [0.9], contentHash: 'x' } },
    }
    world.chunks = { doc1: [{ id: 'doc1-0', documentId: 'doc1', content: 'read again', embedding: [0.3], index: 0 }] }
    world.vectors = { m1: { model: 'e', dim: 1, vector: [0.7], contentHash: 'new' } }
    await start()
    expect((world.chunks.doc1[0] as { content: string }).content).toBe('read again')
    expect((world.chunks.doc2[0] as { content: string }).content).toBe('only in the backup')
    expect((world.vectors.m1 as { contentHash: string }).contentHash).toBe('new')
    expect(world.vectors.m9).toBeDefined()
  })
})
