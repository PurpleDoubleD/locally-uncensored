/**
 * Smoke tests for chatStore — the central conversation state manager.
 *
 * Tests all critical store operations that underpin Chat, Codex, Agent, and Remote:
 * - createConversation (all modes: lu, codex, claude-code, remote)
 * - addMessage / updateMessageContent / updateMessageThinking
 * - insertMessageBefore (Codex continue capability)
 * - deleteConversation / renameConversation
 * - deleteMessagesAfter (edit/regenerate)
 * - Hidden message handling
 * - searchConversations
 * - Auto-rename on first user message
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chatStore'
import type { Message } from '../../types/chat'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

describe('chatStore — conversation CRUD', () => {
  it('creates a conversation and sets it active', () => {
    const id = useChatStore.getState().createConversation('gemma4:12b', '', 'lu')
    const state = useChatStore.getState()
    expect(state.activeConversationId).toBe(id)
    expect(state.conversations).toHaveLength(1)
    expect(state.conversations[0].mode).toBe('lu')
    expect(state.conversations[0].title).toBe('New Chat')
  })

  it('creates Codex conversation with correct title', () => {
    const id = useChatStore.getState().createConversation('qwen3-coder:30b', '', 'codex')
    expect(useChatStore.getState().conversations[0].title).toBe('Codex Chat')
    expect(useChatStore.getState().conversations[0].mode).toBe('codex')
  })

  it('creates Claude Code conversation', () => {
    useChatStore.getState().createConversation('hermes3:8b', '', 'claude-code')
    expect(useChatStore.getState().conversations[0].title).toBe('Claude Code')
  })

  it('auto-numbers remote conversations', () => {
    useChatStore.getState().createConversation('gemma4', '', 'remote')
    useChatStore.getState().createConversation('gemma4', '', 'remote')
    useChatStore.getState().createConversation('gemma4', '', 'remote')
    const convs = useChatStore.getState().conversations
    const titles = convs.map(c => c.title).sort()
    expect(titles).toEqual(['Remote Chat 1', 'Remote Chat 2', 'Remote Chat 3'])
  })

  it('deletes a conversation', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    expect(useChatStore.getState().conversations).toHaveLength(1)
    useChatStore.getState().deleteConversation(id)
    expect(useChatStore.getState().conversations).toHaveLength(0)
    expect(useChatStore.getState().activeConversationId).toBeNull()
  })

  it('renames a conversation', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    useChatStore.getState().renameConversation(id, 'My Great Chat')
    expect(useChatStore.getState().conversations[0].title).toBe('My Great Chat')
  })

  it('auto-renames "New Chat" on first user message', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    useChatStore.getState().addMessage(id, msg({ content: 'Tell me about quantum physics and how it works' }))
    expect(useChatStore.getState().conversations[0].title).toBe('Tell me about quantum physics and how it works')
  })

  it('does NOT auto-rename Codex/Remote chats', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    useChatStore.getState().addMessage(id, msg({ content: 'Build a website' }))
    // Codex Chat title stays — auto-rename only kicks on title === 'New Chat'
    expect(useChatStore.getState().conversations[0].title).toBe('Codex Chat')
  })
})

describe('chatStore — message operations', () => {
  it('adds a message to a conversation', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    const m = msg()
    useChatStore.getState().addMessage(id, m)
    const conv = useChatStore.getState().conversations[0]
    expect(conv.messages).toHaveLength(1)
    expect(conv.messages[0].id).toBe(m.id)
  })

  it('updates message content', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    const m = msg({ role: 'assistant', content: '' })
    useChatStore.getState().addMessage(id, m)
    useChatStore.getState().updateMessageContent(id, m.id, 'Updated content')
    expect(useChatStore.getState().conversations[0].messages[0].content).toBe('Updated content')
  })

  it('updates message thinking', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    const m = msg({ role: 'assistant', content: 'answer' })
    useChatStore.getState().addMessage(id, m)
    useChatStore.getState().updateMessageThinking(id, m.id, 'Let me think...')
    expect(useChatStore.getState().conversations[0].messages[0].thinking).toBe('Let me think...')
  })

  it('deletes messages after a given message (edit/regenerate)', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'lu')
    const m1 = msg({ content: 'first' })
    const m2 = msg({ role: 'assistant', content: 'reply1' })
    const m3 = msg({ content: 'second' })
    const m4 = msg({ role: 'assistant', content: 'reply2' })
    useChatStore.getState().addMessage(id, m1)
    useChatStore.getState().addMessage(id, m2)
    useChatStore.getState().addMessage(id, m3)
    useChatStore.getState().addMessage(id, m4)
    expect(useChatStore.getState().conversations[0].messages).toHaveLength(4)

    // deleteMessagesAfter deletes the target message AND everything after it
    useChatStore.getState().deleteMessagesAfter(id, m3.id)
    const msgs = useChatStore.getState().conversations[0].messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('first')
    expect(msgs[1].content).toBe('reply1')
  })
})

describe('chatStore — insertMessageBefore (Codex continue capability)', () => {
  it('inserts a hidden message before the target', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    const userMsg = msg({ content: 'build me a website' })
    const assistantMsg = msg({ role: 'assistant', content: 'Done!' })
    useChatStore.getState().addMessage(id, userMsg)
    useChatStore.getState().addMessage(id, assistantMsg)

    const hiddenMsg = msg({
      role: 'assistant',
      content: '',
      hidden: true,
      tool_calls: [{ function: { name: 'file_write', arguments: { path: 'index.html', content: '<html></html>' } } }],
    })
    useChatStore.getState().insertMessageBefore(id, assistantMsg.id, hiddenMsg)

    const msgs = useChatStore.getState().conversations[0].messages
    expect(msgs).toHaveLength(3)
    // Order: user → hidden → assistant
    expect(msgs[0].id).toBe(userMsg.id)
    expect(msgs[1].id).toBe(hiddenMsg.id)
    expect(msgs[1].hidden).toBe(true)
    expect(msgs[1].tool_calls).toHaveLength(1)
    expect(msgs[2].id).toBe(assistantMsg.id)
  })

  it('inserts multiple hidden messages in correct order', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    const userMsg = msg({ content: 'write 3 files' })
    const assistantMsg = msg({ role: 'assistant', content: 'Done!' })
    useChatStore.getState().addMessage(id, userMsg)
    useChatStore.getState().addMessage(id, assistantMsg)

    // Insert 3 hidden messages (tool chain: read → write → write)
    const h1 = msg({ role: 'assistant', content: '', hidden: true, tool_calls: [{ function: { name: 'file_read', arguments: { path: 'x.ts' } } }] })
    const h2 = msg({ role: 'tool', content: 'file contents...', hidden: true })
    const h3 = msg({ role: 'assistant', content: '', hidden: true, tool_calls: [{ function: { name: 'file_write', arguments: { path: 'x.ts', content: 'new' } } }] })

    useChatStore.getState().insertMessageBefore(id, assistantMsg.id, h1)
    useChatStore.getState().insertMessageBefore(id, assistantMsg.id, h2)
    useChatStore.getState().insertMessageBefore(id, assistantMsg.id, h3)

    const msgs = useChatStore.getState().conversations[0].messages
    expect(msgs).toHaveLength(5)
    expect(msgs.map(m => m.id)).toEqual([userMsg.id, h1.id, h2.id, h3.id, assistantMsg.id])
    expect(msgs.filter(m => m.hidden)).toHaveLength(3)
  })

  it('appends to end when beforeId not found', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    const m1 = msg({ content: 'first' })
    useChatStore.getState().addMessage(id, m1)

    const m2 = msg({ content: 'orphan', hidden: true })
    useChatStore.getState().insertMessageBefore(id, 'nonexistent-id', m2)

    const msgs = useChatStore.getState().conversations[0].messages
    expect(msgs).toHaveLength(2)
    expect(msgs[1].id).toBe(m2.id) // appended at end
  })
})

describe('chatStore — hidden message filtering (UI must skip these)', () => {
  it('hidden messages exist in store but should be filterable', () => {
    const id = useChatStore.getState().createConversation('gemma4', '', 'codex')
    useChatStore.getState().addMessage(id, msg({ role: 'user', content: 'hello' }))
    useChatStore.getState().addMessage(id, msg({ role: 'assistant', content: '', hidden: true }))
    useChatStore.getState().addMessage(id, msg({ role: 'tool', content: 'ok', hidden: true }))
    useChatStore.getState().addMessage(id, msg({ role: 'assistant', content: 'Done' }))

    const conv = useChatStore.getState().conversations[0]
    const allMsgs = conv.messages
    const visibleMsgs = allMsgs.filter(m => m.role !== 'system' && !m.hidden)

    expect(allMsgs).toHaveLength(4)
    expect(visibleMsgs).toHaveLength(2) // user + final assistant
    expect(visibleMsgs[0].content).toBe('hello')
    expect(visibleMsgs[1].content).toBe('Done')
  })
})

describe('chatStore — search', () => {
  it('searches conversations by message content', () => {
    const id1 = useChatStore.getState().createConversation('gemma4', '', 'lu')
    const id2 = useChatStore.getState().createConversation('gemma4', '', 'lu')
    useChatStore.getState().addMessage(id1, msg({ content: 'quantum physics explanation' }))
    useChatStore.getState().addMessage(id2, msg({ content: 'cooking recipe for pasta' }))

    const results = useChatStore.getState().searchConversations('quantum')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe(id1)
  })
})
