// @vitest-environment jsdom
/**
 * Gap L2 (mobile-docs/r38/luecken.md). A document read in the last seconds
 * before a kill stood in the list after the start (`rag-store` lives in
 * localStorage), but its passages were gone with the dropped IndexedDB and
 * not yet in the native backup (30 s beat). Search found nothing in it and
 * said nothing. The quiet repair now marks such a document.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  backup: {} as Record<string, unknown>,
  live: {} as Record<string, unknown[]>,
  idbUnreadable: false,
}))

vi.mock('../../../api/backend', () => ({
  isTauri: () => true,
  backendCall: async (cmd: string) => {
    if (cmd === 'restore_rag_chunks') return JSON.stringify(world.backup)
    return null
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
  exportAllChunks: async () => {
    if (world.idbUnreadable) throw new Error('IndexedDB could not be opened')
    return { ...world.live }
  },
  importAllChunks: async (snapshot: Record<string, unknown[]>) => {
    Object.assign(world.live, snapshot)
    return Object.keys(snapshot).length
  },
}))

const chunk = (documentId: string) => ({ id: `${documentId}-0`, documentId, content: 'text', embedding: [0.1], index: 0 })
const doc = (id: string) => ({ id, name: `${id}.txt`, type: 'txt' as const, size: 4, addedAt: 1, chunkCount: 1 })

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  sessionStorage.clear()
  world.backup = {}
  world.live = {}
  world.idbUnreadable = false
  localStorage.setItem('chat-settings', '{"state":{}}')
})

async function start() {
  const { useRAGStore } = await import('../../../stores/ragStore')
  useRAGStore.setState({ documents: { c1: [doc('old'), doc('late')] }, pausedIndex: {}, ragEnabled: { c1: true } })
  const { runStoreRestore, restoreDecided } = await import('../restore')
  await runStoreRestore()
  await restoreDecided
  return useRAGStore.getState()
}

describe('documents after a dropped IndexedDB (gap L2)', () => {
  it('a document in neither IndexedDB nor the backup leaves the list as "not saved"; one from the backup stays', async () => {
    world.backup = { old: [chunk('old')] }
    const state = await start()
    expect(state.documents.c1.map((d) => d.id)).toEqual(['old'])
    expect(world.live.old).toHaveLength(1)
    expect(state.pausedIndex.c1).toEqual([expect.objectContaining({ name: 'late.txt', state: 'failed', code: 'not_saved' })])
  })

  it('a document whose passages are in IndexedDB stays', async () => {
    world.live = { old: [chunk('old')], late: [chunk('late')] }
    const state = await start()
    expect(state.documents.c1.map((d) => d.id)).toEqual(['old', 'late'])
    expect(state.pausedIndex).toEqual({})
  })

  it('nothing is judged when IndexedDB cannot be read', async () => {
    world.idbUnreadable = true
    const state = await start()
    expect(state.documents.c1).toHaveLength(2)
    expect(state.pausedIndex).toEqual({})
  })
})
