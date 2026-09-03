/**
 * Deleting a chat has to take the chat's side state with it.
 *
 * M4/3: deleteConversation removed exactly one row — the one in
 * `conversations` — and left the conversation id behind in ragStore (plus its
 * 768-float vectors in ragDB), todoStore, permissionStore and
 * stagedChangesStore. Nothing can ever collect those: the id is the only thing
 * that could prove they are orphans, and the id is what was thrown away. The
 * vectors are the expensive half — they kept being exported to
 * rag_chunks_backup.json every 30 s for the lifetime of the installation.
 *
 * AS-08 follow-up: the sweep documented FIVE stores and ran FOUR. codexStore
 * was the missing one, with five conversation-keyed maps of its own — and one
 * of them, `modeByConversation`, is persisted, so that leak outlived the
 * process. The threads map is the expensive one: an event ring of up to 500
 * entries, each an untruncated terminal result or a full unified diff, held
 * for a chat that no longer exists — and its status kept voting in
 * lib/run-idle.ts, so a chat deleted mid-run could defer every idle-gated
 * dialog for the rest of the session.
 *
 * Run: npx vitest run src/stores/__tests__/delete-conversation-cascade.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// zustand's persist middleware defaults to `window.localStorage` and RETURNS
// EARLY without attaching its `persist` API when that is missing
// (node_modules/zustand/esm/middleware.mjs:343). codexStore takes the default,
// so under vitest's node environment it would have no persist API at all and
// the test below could not ask the real middleware what it writes. Give it a
// real Storage — hoisted, because the store is created at import time. This is
// the platform, not a stand-in for anything under test.
vi.hoisted(() => {
  const mem = new Map<string, string>()
  const storage: Storage = {
    get length() { return mem.size },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, String(v)) },
    removeItem: (k) => { mem.delete(k) },
    clear: () => { mem.clear() },
  }
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    writable: true,
    configurable: true,
  })
})

const deletedDocs: string[] = []
vi.mock('../../lib/ragDB', () => ({
  saveChunks: vi.fn(async () => {}),
  loadChunks: vi.fn(async () => []),
  deleteChunks: vi.fn(async (docId: string) => { deletedDocs.push(docId) }),
}))

import { useChatStore } from '../chatStore'
import { useRAGStore } from '../ragStore'
import { useTodoStore } from '../todoStore'
import { usePermissionStore } from '../permissionStore'
import { useStagedChangesStore } from '../stagedChangesStore'
import { useCodexStore } from '../codexStore'

function seedSideState(id: string) {
  const docId = `doc-${id}`
  useRAGStore.setState((s) => ({
    documents: { ...s.documents, [id]: [{ id: docId, name: 'spec.pdf', size: 10, chunkCount: 2, uploadedAt: 1 } as never] },
    ragEnabled: { ...s.ragEnabled, [id]: true },
    chunks: [
      ...s.chunks,
      { id: `c-${id}`, documentId: docId, content: 'a', embedding: [0.1], index: 0 } as never,
      { id: `o-${id}`, documentId: 'other-doc', content: 'b', embedding: [0.2], index: 0 } as never,
    ],
  }))
  useTodoStore.getState().setTodos(id, [{ content: 'step one', status: 'pending' }])
  usePermissionStore.getState().setConversationOverride(id, 'terminal', 'auto')
  useStagedChangesStore.getState().stage(id, {
    path: 'main.py', oldContent: '', newContent: 'x', diff: '+x',
  })
  // All five codexStore maps, each through the store's own writers so the
  // seeding cannot drift from what the app really puts there.
  useCodexStore.getState().initThread(id, '/repo')
  useCodexStore.getState().addEvent(id, {
    id: `ev-${id}`, type: 'terminal_output', content: 'x'.repeat(4096), timestamp: 1,
  })
  useCodexStore.getState().setThreadStatus(id, 'running')
  useCodexStore.getState().chooseCodexMode(id, 'bypass', false)
  useCodexStore.getState().chooseCodexMode(id, 'plan', false)   // fills prePlanModeByConversation
  useCodexStore.getState().chooseCodexMode(id, 'ask', true)     // parks, run active
  useCodexStore.getState().setPlanApproval(id, { planText: 'p', messageId: 'm', createdAt: 1 })
}

/** The five maps codexStore keys by conversation id. */
function codexMapsHolding(id: string): string[] {
  const s = useCodexStore.getState()
  const maps: [string, Record<string, unknown>][] = [
    ['threads', s.threads],
    ['modeByConversation', s.modeByConversation],
    ['parkedModeByConversation', s.parkedModeByConversation],
    ['prePlanModeByConversation', s.prePlanModeByConversation],
    ['planApprovalByConversation', s.planApprovalByConversation],
  ]
  return maps.filter(([, m]) => id in m).map(([name]) => name)
}

describe('deleteConversation sweeps the five dependent stores', () => {
  beforeEach(() => {
    deletedDocs.length = 0
    useChatStore.setState({ conversations: [], activeConversationId: null })
    useRAGStore.setState({ documents: {}, ragEnabled: {}, chunks: [] })
    useTodoStore.setState({ byConversation: {}, updatedAt: {} })
    usePermissionStore.setState({ conversationOverrides: {} })
    useStagedChangesStore.setState({ byChat: {} })
    useCodexStore.setState({
      threads: {},
      modeByConversation: {},
      parkedModeByConversation: {},
      prePlanModeByConversation: {},
      planApprovalByConversation: {},
    })
  })

  it('leaves nothing keyed by the deleted conversation id', () => {
    const id = useChatStore.getState().createConversation('llama3', '')
    seedSideState(id)

    useChatStore.getState().deleteConversation(id)

    expect(useChatStore.getState().conversations).toHaveLength(0)
    expect(useRAGStore.getState().documents).not.toHaveProperty(id)
    expect(useRAGStore.getState().ragEnabled).not.toHaveProperty(id)
    expect(useTodoStore.getState().byConversation).not.toHaveProperty(id)
    expect(useTodoStore.getState().updatedAt).not.toHaveProperty(id)
    expect(usePermissionStore.getState().conversationOverrides).not.toHaveProperty(id)
    expect(useStagedChangesStore.getState().byChat).not.toHaveProperty(id)
    // The consequence, not the shape of the list: no codexStore map still
    // holds the id. A sweep that cleared only `threads` fails here.
    expect(codexMapsHolding(id)).toEqual([])
  })

  it('the seed really filled all five codex maps — otherwise the sweep proves nothing', () => {
    const id = useChatStore.getState().createConversation('llama3', '')
    seedSideState(id)
    expect(codexMapsHolding(id)).toEqual([
      'threads',
      'modeByConversation',
      'parkedModeByConversation',
      'prePlanModeByConversation',
      'planApprovalByConversation',
    ])
  })

  it('the PERSISTED codex map is cleared — the difference between until-restart and forever', () => {
    const id = useChatStore.getState().createConversation('llama3', '')
    seedSideState(id)
    // partialize decides what actually reaches storage. Asked of the real
    // middleware, not read off the source, so a change to what is persisted
    // cannot leave this test claiming something that is no longer true.
    const partialize = useCodexStore.persist.getOptions().partialize
    const before = partialize?.(useCodexStore.getState()) ?? {}
    expect(JSON.stringify(before)).toContain(id)

    useChatStore.getState().deleteConversation(id)

    const after = partialize?.(useCodexStore.getState()) ?? {}
    expect(JSON.stringify(after)).not.toContain(id)
    expect(useCodexStore.getState().modeByConversation).not.toHaveProperty(id)
  })

  it('deletes the embedding vectors from ragDB, not just the document row', () => {
    const id = useChatStore.getState().createConversation('llama3', '')
    seedSideState(id)

    useChatStore.getState().deleteConversation(id)

    expect(deletedDocs).toEqual([`doc-${id}`])
    // Chunks belonging to another conversation's document stay put.
    expect(useRAGStore.getState().chunks.map((c) => c.documentId)).toEqual(['other-doc'])
  })

  it('does not touch another conversation', () => {
    const keep = useChatStore.getState().createConversation('llama3', '')
    const drop = useChatStore.getState().createConversation('llama3', '')
    seedSideState(keep)
    seedSideState(drop)

    useChatStore.getState().deleteConversation(drop)

    expect(useTodoStore.getState().byConversation).toHaveProperty(keep)
    expect(usePermissionStore.getState().conversationOverrides).toHaveProperty(keep)
    expect(useStagedChangesStore.getState().byChat).toHaveProperty(keep)
    expect(useRAGStore.getState().ragEnabled).toHaveProperty(keep)
    expect(codexMapsHolding(keep)).toHaveLength(5)
    expect(codexMapsHolding(drop)).toEqual([])
  })

  it('one failing store does not stop the other four or the delete itself', () => {
    const id = useChatStore.getState().createConversation('llama3', '')
    seedSideState(id)
    const boom = vi.spyOn(useRAGStore.getState(), 'removeConversation').mockImplementation(() => {
      throw new Error('rag store exploded')
    })

    expect(() => useChatStore.getState().deleteConversation(id)).not.toThrow()

    expect(useChatStore.getState().conversations).toHaveLength(0)
    expect(useTodoStore.getState().byConversation).not.toHaveProperty(id)
    expect(usePermissionStore.getState().conversationOverrides).not.toHaveProperty(id)
    expect(useStagedChangesStore.getState().byChat).not.toHaveProperty(id)
    expect(codexMapsHolding(id)).toEqual([])
    boom.mockRestore()
  })
})
