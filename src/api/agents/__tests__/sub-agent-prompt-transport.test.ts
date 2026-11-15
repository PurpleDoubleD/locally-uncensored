import { describe, it, expect, beforeEach, vi } from 'vitest'

// CA K3: a sub-agent on a local model without native tool calling used to get
// a native `tools` payload, ignore it and hand back its intentions as the
// result. It now runs on the same transport verdict as both tabs.

const chatWithTools = vi.fn()
const toolExecute = vi.fn(async () => 'hello from notes')

const READ_DEF = {
  name: 'file_read',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  category: 'filesystem',
  source: 'builtin',
}

let strategy: 'native' | 'hermes_xml' = 'hermes_xml'

vi.mock('../../../stores/modelStore', () => ({
  useModelStore: { getState: () => ({ activeModel: 'ollama::tiny', models: [] }) },
}))
vi.mock('../../providers', () => ({
  getProviderForModel: (name: string) => ({ provider: { chatWithTools }, modelId: name.split('::')[1] ?? name }),
}))
vi.mock('../../../lib/agent-strategy', () => ({
  resolveToolCallingStrategy: async (name: string) => ({
    strategy,
    modelToUse: name.split('::')[1] ?? name,
    modelId: name.split('::')[1] ?? name,
    providerId: 'ollama',
    provider: { chatWithTools },
  }),
}))
vi.mock('../../mcp/tool-registry', () => ({
  toolRegistry: {
    getAll: () => [READ_DEF],
    resolveExecutable: (name: string) => (name === 'file_read' ? READ_DEF : undefined),
    execute: (...args: unknown[]) => toolExecute(...(args as [])),
    getPermissionLevelWithOverrides: () => 'auto',
  },
}))
vi.mock('../../../stores/permissionStore', () => ({
  usePermissionStore: { getState: () => ({ getEffectivePermissions: () => ({}), perToolOverrides: {} }) },
}))
vi.mock('../../../stores/toolAuditStore', () => ({
  useToolAuditStore: { getState: () => ({ record: () => 'audit-1', complete: () => {} }) },
}))

import { defaultSubAgentRunner, SUB_AGENT_BUDGET } from '../sub-agent'
import { AgentBudget } from '../budget'
import type { ChatMessage } from '../../providers/types'

const run = { conversationId: 'c1', mode: 'bypass' } as never

describe('sub-agent on the prompt transport (CA K3)', () => {
  beforeEach(() => {
    chatWithTools.mockReset()
    toolExecute.mockClear()
  })

  it('offers the tools in the prompt, runs a <tool_call> and answers', async () => {
    strategy = 'hermes_xml'
    chatWithTools
      .mockResolvedValueOnce({ content: '<tool_call>{"name": "file_read", "arguments": {"path": "notes.txt"}}</tool_call>', toolCalls: [] })
      .mockResolvedValueOnce({ content: 'The note says hello.', toolCalls: [] })

    const out = await defaultSubAgentRunner('read notes.txt', '', { budget: new AgentBudget({ ...SUB_AGENT_BUDGET }), run })

    expect(out).toBe('The note says hello.')
    expect(toolExecute).toHaveBeenCalledOnce()
    const [, firstMessages, firstTools] = chatWithTools.mock.calls[0] as [string, ChatMessage[], unknown[]]
    expect(firstTools).toEqual([])
    expect(String(firstMessages[0].content)).toContain('file_read')
    // The result went back as text, not in the native `tool` role.
    const [, secondMessages] = chatWithTools.mock.calls[1] as [string, ChatMessage[]]
    expect(secondMessages.some((m) => m.role === 'tool')).toBe(false)
    expect(secondMessages.some((m) => m.role === 'user' && String(m.content).includes('hello from notes'))).toBe(true)
  })

  it('lifts a prose call on the native transport too', async () => {
    strategy = 'native'
    chatWithTools
      .mockResolvedValueOnce({ content: 'file_read(path="notes.txt")', toolCalls: [] })
      .mockResolvedValueOnce({ content: 'Done.', toolCalls: [] })

    const out = await defaultSubAgentRunner('read notes.txt', '', { budget: new AgentBudget({ ...SUB_AGENT_BUDGET }), run })

    expect(out).toBe('Done.')
    expect(toolExecute).toHaveBeenCalledOnce()
    const [, , nativeTools] = chatWithTools.mock.calls[0] as [string, ChatMessage[], unknown[]]
    expect(nativeTools).toHaveLength(1)
  })
})
