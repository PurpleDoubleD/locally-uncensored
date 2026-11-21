/**
 * GH #172 and #174 in the store: kept versions, Save without a send, and
 * duplicating or branching a chat with the settings that live in other
 * stores.
 *
 * Run: npx vitest run src/stores/__tests__/chatStore-forks-and-copies.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const ragDb = vi.hoisted(() => ({
  saved: new Map<string, unknown[]>(),
  stored: new Map<string, unknown[]>(),
}))
vi.mock('../../lib/ragDB', () => ({
  saveChunks: vi.fn(async (docId: string, chunks: unknown[]) => { ragDb.saved.set(docId, chunks) }),
  loadChunks: vi.fn(async (ids: string[]) => ids.flatMap((id) => ragDb.stored.get(id) ?? [])),
  deleteChunks: vi.fn(async () => {}),
}))

import { useChatStore, migratePersistedChat } from '../chatStore'
import { useAgentModeStore } from '../agentModeStore'
import { usePermissionStore } from '../permissionStore'
import { useCodexStore } from '../codexStore'
import { useTodoStore } from '../todoStore'
import { useRAGStore } from '../ragStore'
import type { Conversation, Message } from '../../types/chat'

const m = (id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message =>
  ({ id, role, content, timestamp: 1, ...extra })

function seed(extra: Partial<Conversation> = {}): Conversation {
  const conv: Conversation = {
    id: 'src', title: 'Story', model: 'm', systemPrompt: '', mode: 'lu', createdAt: 1, updatedAt: 1,
    messages: [
      m('u1', 'user', 'Q1'), m('a1', 'assistant', 'A1'),
      m('u2', 'user', 'Q2'), m('a2', 'assistant', 'A2'),
      m('u3', 'user', 'Q3'), m('a3', 'assistant', 'A3'),
    ],
    ...extra,
  }
  useChatStore.setState({ conversations: [conv], activeConversationId: conv.id })
  return conv
}
const get = (id: string) => useChatStore.getState().conversations.find((c) => c.id === id)!
const ids = (id: string) => get(id).messages.map((x) => x.id)

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
  useAgentModeStore.setState({ agentModeActive: {}, workspaces: {} })
  usePermissionStore.setState({ conversationOverrides: {} })
  useCodexStore.setState({ modeByConversation: {} })
  useTodoStore.setState({ byConversation: {}, updatedAt: {} })
  useRAGStore.setState({ documents: {}, ragEnabled: {}, chunks: [] })
  ragDb.saved.clear()
  ragDb.stored.clear()
})

describe('GH #172: Save changes only the text', () => {
  it('keeps every later turn and the number of messages', () => {
    seed()
    useChatStore.getState().saveUserEdit('src', 'u1', 'Q1 fixed')
    expect(get('src').messages.map((x) => x.content)).toEqual(['Q1 fixed', 'A1', 'Q2', 'A2', 'Q3', 'A3'])
    expect(get('src').forks).toBeUndefined()
  })

  it('never edits an answer through the user path', () => {
    seed()
    useChatStore.getState().saveUserEdit('src', 'a1', 'hijack')
    expect(get('src').messages[1].content).toBe('A1')
  })
})

describe('GH #172: a resend keeps the old continuation', () => {
  it('forkFrom returns the key, and the old turns come back with switchFork', () => {
    seed()
    const key = useChatStore.getState().forkFrom('src', 'u2')
    expect(key).toBe('a1')
    expect(ids('src')).toEqual(['u1', 'a1'])
    useChatStore.getState().addMessage('src', m('u2b', 'user', 'Q2 edited'))
    useChatStore.getState().addMessage('src', m('a2b', 'assistant', 'B'))
    useChatStore.getState().switchFork('src', 'a1', 0)
    expect(ids('src')).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    useChatStore.getState().switchFork('src', 'a1', 1)
    expect(ids('src')).toEqual(['u1', 'a1', 'u2b', 'a2b'])
  })

  it('a refused resend goes back to what was shown', () => {
    seed()
    const key = useChatStore.getState().forkFrom('src', 'u2')!
    useChatStore.getState().restoreEmptyFork('src', key)
    expect(ids('src')).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(get('src').forks).toBeUndefined()
  })

  it('deleting the message a fork hangs on keeps the versions', () => {
    seed()
    useChatStore.getState().forkFrom('src', 'u2')
    useChatStore.getState().addMessage('src', m('u2b', 'user', 'Q2 edited'))
    useChatStore.getState().deleteMessage('src', 'a1')
    expect(get('src').forks?.a1).toBeUndefined()
    expect(get('src').forks?.u1.versions).toHaveLength(2)
    useChatStore.getState().switchFork('src', 'u1', 0)
    expect(ids('src')).toEqual(['u1', 'u2', 'a2', 'u3', 'a3'])
  })
})

describe('a chat stored before 3.0.7 (no versions anywhere)', () => {
  it('passes the load migration unchanged and can be forked', () => {
    const stored = {
      conversations: [{
        id: 'old', title: 'old', model: 'm', systemPrompt: '', createdAt: 1, updatedAt: 1,
        messages: [m('x1', 'user', 'hi'), m('y1', 'assistant', 'hello')],
      }],
      activeConversationId: 'old',
    }
    const before = JSON.stringify(stored)
    const migrated = migratePersistedChat(stored) as typeof stored
    expect(JSON.stringify(migrated)).toBe(before)
    useChatStore.setState({ conversations: migrated.conversations as Conversation[], activeConversationId: 'old' })
    expect(useChatStore.getState().forkFrom('old', 'x1')).toBe('@start')
    expect(get('old').messages).toEqual([])
    expect(get('old').forks?.['@start'].versions).toHaveLength(2)
  })
})

describe('GH #174: Duplicate chat and Branch from here', () => {
  function withSideState() {
    seed({ personaEnabled: true, personaId: 'pirate', groupModels: ['a', 'b'], groupPersonas: { b: 'p' }, sampling: { temperature: 0.2 } })
    useAgentModeStore.getState().setAgentModeActive('src', true)
    useAgentModeStore.getState().setWorkspace('src', { kind: 'folder', path: '/tmp/work' })
    usePermissionStore.getState().setConversationOverride('src', 'terminal', 'blocked')
    useCodexStore.setState({ modeByConversation: { src: 'bypass' } })
    useTodoStore.getState().setTodos('src', [{ id: 't', content: 'step', status: 'pending' }] as never)
    useRAGStore.setState({
      documents: { src: [{ id: 'd1', name: 'notes.txt', type: 'txt', size: 3, addedAt: 1, chunkCount: 1 }] },
      ragEnabled: { src: true },
      chunks: [{ id: 'k1', documentId: 'd1', content: 'abc', embedding: [1, 2], index: 0 }],
    })
  }

  it('Duplicate: an independent copy with persona, group, sampling and every side setting, opened', async () => {
    withSideState()
    useChatStore.getState().forkFrom('src', 'u3')
    useChatStore.getState().addMessage('src', m('u3b', 'user', 'Q3 b'))
    const id = useChatStore.getState().duplicateConversation('src')!
    expect(id).not.toBe('src')
    expect(useChatStore.getState().activeConversationId).toBe(id)
    expect(useChatStore.getState().conversations[0].id).toBe(id)
    const copy = get(id)
    expect(copy.title).toBe('Story (copy)')
    expect(copy.messages.map((x) => x.id)).toEqual(ids('src'))
    expect(copy.forks?.a2.versions).toHaveLength(2)
    expect(copy.personaEnabled).toBe(true)
    expect(copy.personaId).toBe('pirate')
    expect(copy.groupModels).toEqual(['a', 'b'])
    expect(copy.groupPersonas).toEqual({ b: 'p' })
    expect(copy.sampling).toEqual({ temperature: 0.2 })

    expect(useAgentModeStore.getState().agentModeActive[id]).toBe(true)
    expect(useAgentModeStore.getState().workspaces[id]).toEqual({ kind: 'folder', path: '/tmp/work' })
    expect(usePermissionStore.getState().conversationOverrides[id]).toEqual({ terminal: 'blocked' })
    expect(useCodexStore.getState().modeByConversation[id]).toBe('bypass')
    expect(useTodoStore.getState().byConversation[id]).toHaveLength(1)

    // Documents: same names, new ids, own chunks, so deleting one chat
    // never takes the other's chunks along.
    await vi.waitFor(() => expect(useRAGStore.getState().chunks.filter((c) => c.documentId !== 'd1')).toHaveLength(1))
    const docs = useRAGStore.getState().documents[id]
    expect(docs.map((d) => d.name)).toEqual(['notes.txt'])
    expect(docs[0].id).not.toBe('d1')
    expect(useRAGStore.getState().ragEnabled[id]).toBe(true)
    expect(ragDb.saved.get(docs[0].id)).toHaveLength(1)

    // Independent: a change in the copy stays in the copy.
    useChatStore.getState().saveUserEdit(id, 'u1', 'only in the copy')
    useChatStore.getState().setGroupModels(id, ['a'])
    expect(get('src').messages[0].content).toBe('Q1')
    expect(get('src').groupModels).toEqual(['a', 'b'])
    useChatStore.getState().deleteConversation(id)
    expect(useRAGStore.getState().documents.src).toHaveLength(1)
    expect(useAgentModeStore.getState().agentModeActive.src).toBe(true)
  })

  it('Duplicate reads the chunks from disk when they are not loaded', async () => {
    withSideState()
    useRAGStore.setState({ chunks: [] })
    ragDb.stored.set('d1', [{ id: 'k1', documentId: 'd1', content: 'abc', embedding: [1], index: 0 }])
    const id = useChatStore.getState().duplicateConversation('src')!
    await vi.waitFor(() => expect(useRAGStore.getState().chunks).toHaveLength(1))
    expect(useRAGStore.getState().chunks[0].documentId).toBe(useRAGStore.getState().documents[id][0].id)
  })

  it('Branch from here: up to and including the message, same settings, no task list', () => {
    withSideState()
    const id = useChatStore.getState().duplicateConversation('src', { endAt: 'a2' })!
    expect(get(id).title).toBe('Story (branch)')
    expect(ids(id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(get(id).sampling).toEqual({ temperature: 0.2 })
    expect(get(id).personaId).toBe('pirate')
    expect(get(id).groupPersonas).toEqual({ b: 'p' })
    expect(useAgentModeStore.getState().agentModeActive[id]).toBe(true)
    expect(useTodoStore.getState().byConversation[id]).toBeUndefined()
    // The source is untouched.
    expect(ids('src')).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(useChatStore.getState().activeConversationId).toBe(id)
  })

  it('Agent history: a branch at an answer keeps its hidden tool pairs whole', () => {
    const at = 1
    const m = (id: string, role: 'user' | 'assistant' | 'tool', extra: Record<string, unknown> = {}) => ({ id, role, content: id, timestamp: at, ...extra })
    useChatStore.setState({ activeConversationId: 'tools', conversations: [{
      id: 'tools', title: 'Tools', model: 'm', systemPrompt: '', createdAt: at, updatedAt: at, mode: 'lu',
      messages: [
        m('u1', 'user'),
        m('h1', 'assistant', { hidden: true, tool_calls: [{ id: 'c1', function: { name: 'read', arguments: {} } }] }),
        m('h2', 'tool', { hidden: true, tool_call_id: 'c1' }),
        m('a1', 'assistant'),
        m('u2', 'user'),
        m('h3', 'assistant', { hidden: true, tool_calls: [{ id: 'c2', function: { name: 'read', arguments: {} } }] }),
        m('h4', 'tool', { hidden: true, tool_call_id: 'c2' }),
        m('a2', 'assistant'),
      ],
    }] as never })
    for (const [endAt, want] of [['a1', 4], ['a2', 8]] as const) {
      const copy = get(useChatStore.getState().duplicateConversation('tools', { endAt })!)
      expect(copy.messages).toHaveLength(want)
      const called = copy.messages.flatMap((x) => x.tool_calls?.map((c) => c.id) ?? [])
      const answered = copy.messages.flatMap((x) => (x.tool_call_id ? [x.tool_call_id] : []))
      expect(answered).toEqual(called)
    }
    expect(get('tools').messages).toHaveLength(8)
  })

  it('an unknown chat or message makes no copy', () => {
    seed()
    expect(useChatStore.getState().duplicateConversation('nope')).toBeNull()
    expect(useChatStore.getState().duplicateConversation('src', { endAt: 'nope' })).toBeNull()
    expect(useChatStore.getState().conversations).toHaveLength(1)
  })
})
