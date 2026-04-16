import { describe, it, expect } from 'vitest'
import { migratePersistedChat } from '../chatStore'
import type { AgentBlock, AgentToolCall } from '../../types/agent-mode'

const legacyCall: AgentToolCall = {
  id: 't1',
  toolName: 'web_search',
  args: { query: 'x' },
  status: 'completed',
  timestamp: 1,
}

describe('chatStore — migratePersistedChat', () => {
  it('returns null/undefined/non-object shapes unchanged', () => {
    expect(migratePersistedChat(null)).toBe(null)
    expect(migratePersistedChat(undefined)).toBe(undefined)
    expect(migratePersistedChat({})).toEqual({})
  })

  it('leaves conversations without agentBlocks untouched', () => {
    const state = {
      conversations: [
        {
          id: 'c1',
          messages: [{ id: 'm1', role: 'user', content: 'hi' }],
        },
      ],
    }
    const result = migratePersistedChat(state)
    expect(result.conversations[0].messages[0].content).toBe('hi')
  })

  it('wraps legacy singular toolCall into toolCalls array across nested messages', () => {
    const block: AgentBlock = {
      id: 'b1',
      phase: 'tool_call',
      content: '',
      timestamp: 1,
      toolCall: legacyCall,
    }
    const state = {
      conversations: [
        {
          id: 'c1',
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              content: 'ok',
              agentBlocks: [block],
            },
          ],
        },
      ],
    }
    const result = migratePersistedChat(state)
    const migratedBlock = result.conversations[0].messages[0].agentBlocks[0]
    expect(migratedBlock.toolCalls).toEqual([legacyCall])
    expect(migratedBlock.toolCall).toBe(legacyCall) // preserved for transition
  })

  it('migrates multiple blocks in multiple conversations', () => {
    const state = {
      conversations: [
        {
          id: 'c1',
          messages: [
            {
              id: 'm1',
              agentBlocks: [
                { id: 'b1', phase: 'tool_call', content: '', timestamp: 1, toolCall: legacyCall },
                { id: 'b2', phase: 'thinking', content: 'hmm', timestamp: 2 },
              ],
            },
          ],
        },
        {
          id: 'c2',
          messages: [
            {
              id: 'm2',
              agentBlocks: [
                { id: 'b3', phase: 'tool_call', content: '', timestamp: 3, toolCall: { ...legacyCall, id: 't2' } },
              ],
            },
          ],
        },
      ],
    }
    const result = migratePersistedChat(state)
    expect(result.conversations[0].messages[0].agentBlocks[0].toolCalls).toHaveLength(1)
    // Non-tool block untouched.
    expect(result.conversations[0].messages[0].agentBlocks[1].toolCalls).toBeUndefined()
    expect(result.conversations[1].messages[0].agentBlocks[0].toolCalls?.[0].id).toBe('t2')
  })

  it('is idempotent — re-running migration does not double-wrap', () => {
    const state = {
      conversations: [
        {
          id: 'c1',
          messages: [
            {
              id: 'm1',
              agentBlocks: [
                {
                  id: 'b1',
                  phase: 'tool_call',
                  content: '',
                  timestamp: 1,
                  toolCall: legacyCall,
                  toolCalls: [legacyCall],
                },
              ],
            },
          ],
        },
      ],
    }
    const once = migratePersistedChat(state)
    const twice = migratePersistedChat(once)
    expect(twice.conversations[0].messages[0].agentBlocks[0].toolCalls).toEqual([legacyCall])
  })

  it('handles malformed agentBlocks array without crashing', () => {
    const state = {
      conversations: [
        {
          id: 'c1',
          messages: [
            {
              id: 'm1',
              agentBlocks: [null, undefined, { id: 'b1', phase: 'tool_call', content: '', timestamp: 1 }],
            },
          ],
        },
      ],
    }
    expect(() => migratePersistedChat(state)).not.toThrow()
  })

  it('tolerates non-array conversations gracefully', () => {
    expect(migratePersistedChat({ conversations: 'not-an-array' })).toEqual({ conversations: 'not-an-array' })
  })
})
