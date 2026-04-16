/**
 * Smoke tests for the Message type system.
 *
 * Verifies the shape and semantics of the Message interface that underpins
 * all of Chat, Codex, Agent, and Remote. These are structural tests that
 * read the type definitions to ensure no fields are accidentally removed.
 *
 * Also tests the Conversation type and chat mode union.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Message, Conversation, Role } from '../chat'

// ── Type-level tests using actual values ────────────────────────────────

describe('Message interface — field support', () => {
  it('supports all 4 roles', () => {
    const roles: Role[] = ['user', 'assistant', 'system', 'tool']
    expect(roles).toHaveLength(4)
  })

  it('constructs a basic user message', () => {
    const m: Message = {
      id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now(),
    }
    expect(m.role).toBe('user')
    expect(m.hidden).toBeUndefined()
  })

  it('constructs an assistant message with thinking', () => {
    const m: Message = {
      id: 'msg-2', role: 'assistant', content: 'Answer',
      thinking: 'Let me think...', timestamp: Date.now(),
    }
    expect(m.thinking).toBe('Let me think...')
  })

  it('constructs a hidden tool-call message (Codex continue)', () => {
    const m: Message = {
      id: 'msg-3', role: 'assistant', content: '', timestamp: Date.now(),
      hidden: true,
      tool_calls: [{ function: { name: 'file_write', arguments: { path: 'x.ts', content: 'code' } } }],
    }
    expect(m.hidden).toBe(true)
    expect(m.tool_calls).toHaveLength(1)
    expect(m.tool_calls![0].function.name).toBe('file_write')
  })

  it('constructs a tool result message', () => {
    const m: Message = {
      id: 'msg-4', role: 'tool', content: 'File written successfully.',
      timestamp: Date.now(), hidden: true,
    }
    expect(m.role).toBe('tool')
  })

  it('constructs a message with images', () => {
    const m: Message = {
      id: 'msg-5', role: 'user', content: 'Describe this',
      timestamp: Date.now(),
      images: [{ data: 'base64...', mimeType: 'image/png', name: 'screenshot.png' }],
    }
    expect(m.images).toHaveLength(1)
    expect(m.images![0].mimeType).toBe('image/png')
  })

  it('constructs a message with RAG sources', () => {
    const m: Message = {
      id: 'msg-6', role: 'assistant', content: 'Based on your docs...',
      timestamp: Date.now(),
      sources: [{ documentName: 'readme.md', chunkIndex: 0, preview: 'First paragraph...' }],
    }
    expect(m.sources).toHaveLength(1)
  })

  it('constructs a message with agentBlocks', () => {
    const m: Message = {
      id: 'msg-7', role: 'assistant', content: 'Done',
      timestamp: Date.now(),
      agentBlocks: [],
      toolCallSummary: '3 files written',
    }
    expect(m.toolCallSummary).toBe('3 files written')
  })
})

describe('Conversation interface', () => {
  it('supports all 5 chat modes', () => {
    const modes: Conversation['mode'][] = ['lu', 'codex', 'openclaw', 'claude-code', 'remote']
    for (const mode of modes) {
      const c: Conversation = {
        id: `conv-${mode}`, title: 'Test', messages: [],
        model: 'gemma4:12b', systemPrompt: '', mode,
        createdAt: Date.now(), updatedAt: Date.now(),
      }
      expect(c.mode).toBe(mode)
    }
  })
})

// ── Source-level drift detection ────────────────────────────────────────

describe('Message type source integrity', () => {
  const src = readFileSync(resolve(__dirname, '../chat.ts'), 'utf8')

  it('Message has id, role, content, timestamp', () => {
    expect(src).toContain('id: string')
    expect(src).toContain('role: Role')
    expect(src).toContain('content: string')
    expect(src).toContain('timestamp: number')
  })

  it('Message has optional hidden field', () => {
    expect(src).toContain('hidden?: boolean')
  })

  it('Message has optional tool_calls field', () => {
    expect(src).toContain('tool_calls?:')
  })

  it('Message has optional thinking field', () => {
    expect(src).toContain('thinking?: string')
  })

  it('Message has optional images field', () => {
    expect(src).toContain('images?: ImageAttachment[]')
  })

  it('Conversation has mode with all 5 options', () => {
    expect(src).toContain("'lu'")
    expect(src).toContain("'codex'")
    expect(src).toContain("'openclaw'")
    expect(src).toContain("'claude-code'")
    expect(src).toContain("'remote'")
  })

  it('Role union has all 4 types', () => {
    expect(src).toContain("'user'")
    expect(src).toContain("'assistant'")
    expect(src).toContain("'system'")
    expect(src).toContain("'tool'")
  })
})
