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
 * Run: npx vitest run src/stores/__tests__/delete-conversation-cascade.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
}

describe('deleteConversation sweeps the four dependent stores', () => {
  beforeEach(() => {
    deletedDocs.length = 0
    useChatStore.setState({ conversations: [], activeConversationId: null })
    useRAGStore.setState({ documents: {}, ragEnabled: {}, chunks: [] })
    useTodoStore.setState({ byConversation: {}, updatedAt: {} })
    usePermissionStore.setState({ conversationOverrides: {} })
    useStagedChangesStore.setState({ byChat: {} })
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
  })

  it('one failing store does not stop the other three or the delete itself', () => {
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
    boom.mockRestore()
  })
})
