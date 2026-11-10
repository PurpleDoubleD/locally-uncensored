// @vitest-environment jsdom
/**
 * Finding D-VW (check of package 17 on Android, mobile-docs/r41/funde.md).
 * A document read while IndexedDB refused every write was kept by the phone in
 * the native backup and in a note. The last write of localStorage before the
 * kill was torn, so at the start the list did not have it, and the check of
 * gap L2 never saw it: gone without a word in 9 of 11 runs. The start now puts
 * the entry of the note back before that check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  backup: {} as Record<string, unknown>,
  live: {} as Record<string, unknown[]>,
  vault: new Map<string, string>(),
}))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: async (cmd: string) => {
    if (cmd === 'restore_rag_chunks') return JSON.stringify(world.backup)
    return null
  },
}))
vi.mock('../../policy/decision-vault', () => ({
  decisionVaultAvailable: () => true,
  loadDecision: async (id: string) => world.vault.get(id) || null,
  saveDecision: async (id: string, value: string) => {
    if (value) world.vault.set(id, value)
    else world.vault.delete(id)
    return true
  },
}))
vi.mock('../../../lib/idbStorage', () => ({
  hasStoredItem: async () => true,
  hasReadableItem: async () => true,
  hasFailedRead: () => false,
  onIdbWrite: () => () => {},
  idbStorage: { getItem: async () => 'present', setItem: async () => {}, removeItem: async () => {} },
}))
vi.mock('../../../lib/chat-backup-recovery', () => ({ recoverChatsFromBackup: async () => {} }))
vi.mock('../../lib/store-journal', () => ({ mergeStoreJournal: async () => {} }))
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: { persist: { hasHydrated: () => true, onFinishHydration: () => {} }, getState: () => ({ conversations: [], importConversations: () => {} }) },
}))
vi.mock('../../../lib/ragDB', () => ({
  saveChunks: async () => {},
  deleteChunks: async () => {},
  loadChunks: async () => [],
  exportAllChunks: async () => ({ ...world.live }),
  importAllChunks: async (snapshot: Record<string, unknown[]>) => {
    Object.assign(world.live, snapshot)
    return Object.keys(snapshot).length
  },
}))

const chunk = (documentId: string) => ({ id: `${documentId}-0`, documentId, content: 'text', embedding: [0.1], index: 0 })
const doc = (id: string) => ({ id, name: `${id}.txt`, type: 'txt' as const, size: 4, addedAt: 1, chunkCount: 1 })
const NOTE = 'lu-document-journal'
const note = () => JSON.parse(world.vault.get(NOTE) ?? '{"docs":[]}').docs as { meta: { id: string } }[]

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  world.backup = {}
  world.live = {}
  world.vault = new Map()
  localStorage.setItem('chat-settings', '{"state":{}}')
})

async function start(listed: string[]) {
  const { useRAGStore } = await import('../../../stores/ragStore')
  useRAGStore.setState({ documents: { c1: listed.map(doc) }, pausedIndex: {}, ragEnabled: { c1: true } })
  const { runStoreRestore, restoreDecided } = await import('../restore')
  await runStoreRestore()
  await restoreDecided
  return useRAGStore.getState()
}

describe('a document kept in the journal after the list lost it (D-VW)', () => {
  it('comes back with its passages from the native backup, and stays in the note until a start finds it in the list', async () => {
    world.vault.set(NOTE, JSON.stringify({ docs: [{ conversationId: 'c1', meta: doc('late') }] }))
    world.backup = { old: [chunk('old')], late: [chunk('late')] }
    world.live = { old: [chunk('old')] }
    const state = await start(['old'])
    expect(state.documents.c1.map((d) => d.id)).toEqual(['old', 'late'])
    expect(world.live.late).toHaveLength(1)
    expect(state.pausedIndex).toEqual({})
    expect(note().map((e) => e.meta.id)).toEqual(['late'])
  })

  it('without its passages anywhere it is shown as "not fully saved", never gone without a word', async () => {
    world.vault.set(NOTE, JSON.stringify({ docs: [{ conversationId: 'c1', meta: doc('late') }] }))
    world.live = { old: [chunk('old')] }
    const state = await start(['old'])
    expect(state.documents.c1.map((d) => d.id)).toEqual(['old'])
    expect(state.pausedIndex.c1).toEqual([expect.objectContaining({ name: 'late.txt', state: 'failed', code: 'not_saved' })])
    expect(world.vault.has(NOTE)).toBe(false)
  })

  it('an entry the list still has leaves the note, nothing is added twice', async () => {
    world.vault.set(NOTE, JSON.stringify({ docs: [{ conversationId: 'c1', meta: doc('late') }] }))
    world.live = { late: [chunk('late')] }
    const state = await start(['late'])
    expect(state.documents.c1.map((d) => d.id)).toEqual(['late'])
    expect(world.vault.has(NOTE)).toBe(false)
  })
})
