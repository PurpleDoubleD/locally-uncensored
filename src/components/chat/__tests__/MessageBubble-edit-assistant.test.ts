/**
 * D#81 (TheRealNovelist): the model's answer can be edited in place.
 * The store half is a real behaviour test; the component half is a source
 * guard in the house pattern (no render harness in this repo).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../../../stores/chatStore'
import type { Message } from '../../../types/chat'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    content: 'the original answer',
    timestamp: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  useChatStore.setState({ conversations: [], activeConversationId: null })
})

describe('assistant edit, store half', () => {
  it('rewrites the answer in place and later context reads the edit', () => {
    const s = useChatStore.getState()
    const convId = s.createConversation('gemma4:12b', '', 'lu')
    const m = msg()
    s.addMessage(convId, m)
    s.updateMessageContent(convId, m.id, 'the corrected answer')
    const stored = useChatStore.getState().conversations[0].messages.find((x) => x.id === m.id)
    expect(stored?.content).toBe('the corrected answer')
    // No resend semantics: nothing after the message was touched.
    expect(useChatStore.getState().conversations[0].messages).toHaveLength(1)
  })
})

describe('assistant edit, component wiring (source guards)', () => {
  const src = readFileSync(join(__dirname, '../MessageBubble.tsx'), 'utf8')

  it('offers a pencil on assistant messages', () => {
    expect(src).toContain('aria-label="Edit response"')
  })

  it('assistant saves rewrite the store, user saves keep the resend path', () => {
    expect(src).toContain('updateMessageContent(activeConversationId, message.id, next)')
    expect(src).toContain('onEdit?.(message.id, next)')
  })

  it('hides the pencil where there is no single editable text', () => {
    // Block-built turns render per-iteration text, and a still-streaming
    // turn would overwrite the edit a frame later.
    expect(src).toContain('!hasRealAnswerBlocks')
    expect(src).toMatch(/canEditAssistant = !isUser && !hasRealAnswerBlocks/)
    expect(src).toContain('!isStreaming && !replyStillWriting')
  })

  it('the edit textarea opens for both roles, not only the user', () => {
    expect(src).toContain('{isEditing ? (')
    expect(src).not.toContain('{isUser && isEditing ? (')
  })
})
