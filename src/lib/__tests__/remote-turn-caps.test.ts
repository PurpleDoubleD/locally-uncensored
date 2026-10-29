/**
 * A turn from the paired phone never uses more than the device may
 * (lib/remote-turn-caps): the categories its rights leave out are off in the
 * permissions for that chat, and the tool registry refuses them outright,
 * whatever a per-tool override or the Code preset would allow. Plus the
 * approval queue's answer by id that the phone uses.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { capsFor, setTurnCaps, clearTurnCaps, capCategory } from '../remote-turn-caps'
import { usePermissionStore } from '../../stores/permissionStore'
import { ToolRegistry } from '../../api/mcp/tool-registry'
import {
  answerApproval, enqueueApproval, dequeueApproval, listApprovals, resetApprovals, subscribeApprovalAnswers,
} from '../approval-queue'
import type { AgentToolCall } from '../../types/agent-mode'

afterEach(() => { clearTurnCaps('c1'); resetApprovals() })

describe('rights as the upper bound of a phone turn', () => {
  it('maps the missing rights to blocked categories', () => {
    expect(capsFor({ agent: true, files: true, terminal: true, create: true })).toEqual({})
    expect(capsFor({ agent: false, files: false, terminal: false, create: false })).toEqual({
      filesystem: 'blocked', terminal: 'blocked', desktop: 'blocked', mcp: 'blocked', image: 'blocked', video: 'blocked', workflow: 'blocked', web: 'blocked', system: 'blocked',
    })
  })

  it('wins over conversation and per-tool settings, only in that chat and only while it runs', () => {
    const store = usePermissionStore.getState()
    store.setConversationOverride('c1', 'terminal', 'auto')
    store.setToolOverride('shell_execute', 'auto')
    setTurnCaps('c1', { agent: true, files: true, terminal: false, create: true })
    expect(usePermissionStore.getState().getEffectivePermissions('c1').terminal).toBe('blocked')
    expect(usePermissionStore.getState().getEffectivePermissionForTool('shell_execute', 'terminal', 'c1')).toBe('blocked')
    expect(usePermissionStore.getState().getEffectivePermissionForTool('shell_execute', 'terminal', 'other')).toBe('auto')
    clearTurnCaps('c1')
    expect(usePermissionStore.getState().getEffectivePermissions('c1').terminal).toBe('auto')
    store.clearToolOverride('shell_execute')
    store.clearConversationOverrides('c1')
  })

  it('the registry refuses a capped tool for that chat and runs it elsewhere', async () => {
    const reg = new ToolRegistry()
    let ran = 0
    reg.registerBuiltin({
      name: 'shell_execute', description: 'x', category: 'terminal', source: 'builtin',
      inputSchema: { type: 'object', properties: {}, required: [] },
    }, async () => { ran++; return 'ok' })
    setTurnCaps('c1', { agent: true, files: true, terminal: false, create: true })
    const run = (conversationId: string) => ({ conversationId }) as never
    expect(await reg.execute('shell_execute', {}, 0, run('c1'))).toMatch(/not allowed for the phone/)
    expect(ran).toBe(0)
    expect(await reg.execute('shell_execute', {}, 0, run('c2'))).toBe('ok')
    expect(ran).toBe(1)
  })

  it('a tool of an external MCP server needs terminal, not create', async () => {
    expect(capCategory({ category: 'workflow', source: 'external' })).toBe('terminal')
    expect(capCategory({ category: 'workflow', source: 'builtin' })).toBe('workflow')
    const reg = new ToolRegistry()
    let ran = 0
    reg.registerBuiltin({
      name: 'mcp_any', description: 'x', category: 'workflow', source: 'external',
      inputSchema: { type: 'object', properties: {}, required: [] },
    }, async () => { ran++; return 'ok' })
    const run = { conversationId: 'c1' } as never
    setTurnCaps('c1', { agent: true, files: true, terminal: false, create: true })
    expect(await reg.execute('mcp_any', {}, 0, run)).toMatch(/not allowed for the phone/)
    setTurnCaps('c1', { agent: true, files: false, terminal: true, create: false })
    expect(await reg.execute('mcp_any', {}, 0, run)).toBe('ok')
    expect(ran).toBe(1)
  })
})

describe('answering an approval by id', () => {
  const call = (id: string) => ({ id, toolName: 't', args: {}, status: 'pending_approval', timestamp: 1 }) as AgentToolCall

  it('answers that one wherever it waits, once, and says who answered', async () => {
    const heard: Array<[string, boolean, string]> = []
    subscribeApprovalAnswers((_c, id, ok, by) => { heard.push([id, ok, by]) })
    const results: Record<string, boolean> = {}
    for (const id of ['a', 'b']) enqueueApproval('c1', { toolCall: call(id), resolve: (ok) => { results[id] = ok } })
    expect(listApprovals('c1').map((t) => t.id)).toEqual(['a', 'b'])
    expect(answerApproval('c1', 'b', true)).toBe(true)
    expect(answerApproval('c1', 'b', false)).toBe(false)
    expect(results).toEqual({ b: true })
    // The desktop's click on the head is heard as the desktop's.
    dequeueApproval('c1')?.resolve(false)
    expect(heard).toEqual([['b', true, 'phone'], ['a', false, 'desktop']])
    expect(listApprovals('c1')).toEqual([])
  })
})
