// @vitest-environment jsdom
/**
 * Hint IMP-A (check of package 18 on Android, mobile-docs/r47/reste.md). Two
 * documents of a chat import were in the list after one start and gone a few
 * starts later, their passages still in the native backup, no sentence
 * anywhere. No step of the app removed them: the list in localStorage came
 * back older than it was (a record of an earlier session lost, the newer ones
 * kept), and nothing at the start held it against the native backup. The
 * start now puts back what the backup lists and the list lost, unless the
 * document left the list on purpose in a session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  chunkBackup: {} as Record<string, unknown>,
  stores: null as Record<string, string> | null,
  live: {} as Record<string, unknown[]>,
}))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: async (cmd: string) => {
    if (cmd === 'restore_rag_chunks') return JSON.stringify(world.chunkBackup)
    if (cmd === 'restore_stores') return world.stores ? JSON.stringify(world.stores) : null
    return null
  },
}))
vi.mock('../../policy/decision-vault', () => ({
  decisionVaultAvailable: () => true,
  loadDecision: async () => null,
  saveDecision: async () => true,
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
  deleteChunks: async (id: string) => {
    delete world.live[id]
  },
  loadChunks: async () => [],
  exportAllChunks: async () => ({ ...world.live }),
  importAllChunks: async (snapshot: Record<string, unknown[]>) => {
    Object.assign(world.live, snapshot)
    return Object.keys(snapshot).length
  },
}))

const chunk = (documentId: string) => ({ id: `${documentId}-0`, documentId, content: 'text', embedding: [0.1], index: 0 })
const doc = (id: string) => ({ id, name: `${id}.md`, type: 'txt' as const, size: 4, addedAt: 1, chunkCount: 1 })
const SEARCH = 'imported-search'
const ragValue = (documents: Record<string, string[]>) =>
  JSON.stringify({ state: { documents: Object.fromEntries(Object.entries(documents).map(([c, ids]) => [c, ids.map(doc)])), ragEnabled: {}, pausedIndex: {} }, version: 0 })

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  world.chunkBackup = {}
  world.stores = null
  world.live = {}
  localStorage.setItem('chat-settings', '{"state":{}}')
})

async function start(listed: Record<string, string[]>) {
  const { useRAGStore } = await import('../../../stores/ragStore')
  useRAGStore.setState({ documents: Object.fromEntries(Object.entries(listed).map(([c, ids]) => [c, ids.map(doc)])), pausedIndex: {}, ragEnabled: {} })
  const { runStoreRestore, restoreDecided } = await import('../restore')
  await runStoreRestore()
  await restoreDecided
  return useRAGStore.getState()
}

describe('a document the list lost between two sessions (IMP-A)', () => {
  it('the case of the report: the documents of the import come back from the backup, searchable', async () => {
    // The list came back as it was before the import: the chat of the import is not even a key in it.
    world.stores = { 'rag-store': ragValue({ c1: ['old'], [SEARCH]: ['impA-holiday', 'impA-bread'] }) }
    world.chunkBackup = { old: [chunk('old')], 'impA-holiday': [chunk('impA-holiday')], 'impA-bread': [chunk('impA-bread')] }
    world.live = { old: [chunk('old')] }
    const state = await start({ c1: ['old'] })
    expect(state.documents[SEARCH]?.map((d) => d.id)).toEqual(['impA-holiday', 'impA-bread'])
    expect(world.live['impA-holiday']).toHaveLength(1)
    expect(state.pausedIndex).toEqual({})
  })

  it('without its passages anywhere it is shown as "not fully saved", never gone without a word', async () => {
    world.stores = { 'rag-store': ragValue({ c1: ['old', 'late'] }) }
    world.live = { old: [chunk('old')] }
    const state = await start({ c1: ['old'] })
    expect(state.documents.c1.map((d) => d.id)).toEqual(['old'])
    expect(state.pausedIndex.c1).toEqual([expect.objectContaining({ name: 'late.md', state: 'failed', code: 'not_saved' })])
  })

  it('a document removed on purpose in a session stays removed, also while the backup still lists it', async () => {
    world.live = { keep: [chunk('keep')], gone: [chunk('gone')] }
    const { useRAGStore } = await import('../../../stores/ragStore')
    useRAGStore.setState({ documents: { c1: [doc('keep'), doc('gone')] }, pausedIndex: {}, ragEnabled: {} })
    const { installDocumentRemovals } = await import('../../lib/document-list-recovery')
    installDocumentRemovals()
    useRAGStore.getState().removeDocument('c1', 'gone')
    // The kill came before the backup knew of it.
    world.stores = { 'rag-store': ragValue({ c1: ['keep', 'gone'] }) }
    world.chunkBackup = { keep: [chunk('keep')], gone: [chunk('gone')] }
    vi.resetModules()
    const state = await start({ c1: ['keep'] })
    expect(state.documents.c1.map((d) => d.id)).toEqual(['keep'])
    expect(state.pausedIndex).toEqual({})
  })

  it('every way out of the list in a session is noted: removed, chat cleared, chat deleted, marked as not saved', async () => {
    const { useRAGStore } = await import('../../../stores/ragStore')
    useRAGStore.setState({ documents: { c1: [doc('a'), doc('b')], c2: [doc('c')], c3: [doc('d')] }, pausedIndex: {}, ragEnabled: {} })
    const { installDocumentRemovals, parseRemovals, DOCUMENT_REMOVALS_KEY } = await import('../../lib/document-list-recovery')
    const { markDocumentsNotSaved } = await import('../../lib/rag-missing-chunks')
    installDocumentRemovals()
    useRAGStore.getState().removeDocument('c1', 'a')
    useRAGStore.getState().clearConversationDocs('c2')
    useRAGStore.getState().removeConversation('c3')
    markDocumentsNotSaved([{ conversationId: 'c1', meta: doc('b') }])
    expect(Object.keys(parseRemovals(localStorage.getItem(DOCUMENT_REMOVALS_KEY))).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('nothing the list has is added twice, also under another chat; no backup changes nothing', async () => {
    world.stores = { 'rag-store': ragValue({ c1: ['x'], c2: ['y'] }) }
    world.live = { x: [chunk('x')], y: [chunk('y')] }
    let state = await start({ c1: ['x', 'y'] })
    expect(state.documents.c1.map((d) => d.id)).toEqual(['x', 'y'])
    expect(state.documents.c2).toBeUndefined()
    world.stores = null
    vi.resetModules()
    state = await start({ c1: ['x'] })
    expect(state.documents.c1.map((d) => d.id)).toEqual(['x'])
  })
})
