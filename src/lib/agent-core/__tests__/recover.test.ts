import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recoverTurnCalls } from '../recover'

const tools = [
  { name: 'file_read', inputSchema: { properties: { path: {} }, required: ['path'] } },
  { name: 'file_write', inputSchema: { properties: { path: {}, content: {} }, required: ['path', 'content'] } },
  { name: 'shell_execute', inputSchema: { properties: { command: {} }, required: ['command'] } },
  { name: 'video_generate', inputSchema: { properties: { prompt: {} }, required: ['prompt'] } },
]

const names = (r: ReturnType<typeof recoverTurnCalls>) => r.toolCalls.map((c) => c.function.name)

describe('one recovery chain for every loop (CA K2)', () => {
  it('keeps native calls and repairs a near-miss name', () => {
    const r = recoverTurnCalls({
      toolCalls: [{ function: { name: 'video_generation', arguments: { prompt: 'a cat' } } }],
      content: '',
      tools,
    })
    expect(names(r)).toEqual(['video_generate'])
    expect(r.source).toBe('native')
  })

  it('resolves a generic "function" call from its arguments (GH #147)', () => {
    const r = recoverTurnCalls({
      toolCalls: [{ function: { name: 'function', arguments: { command: 'ls' } } }],
      content: '',
      tools,
    })
    expect(names(r)).toEqual(['shell_execute'])
  })

  it('lifts a fenced JSON call out of the answer and leaves the prose', () => {
    const content = 'I will read it now.\n```json\n{"name": "file_read", "arguments": {"path": "notes.txt"}}\n```'
    const r = recoverTurnCalls({ toolCalls: [], content, tools })
    expect(names(r)).toEqual(['file_read'])
    expect(r.source).toBe('content')
    expect(r.content).toContain('I will read it now.')
    expect(r.content).not.toContain('"name"')
  })

  it('lifts a prose call the Code tab used to miss', () => {
    const r = recoverTurnCalls({ toolCalls: [], content: 'file_read(path="src/math.ts")', tools })
    expect(names(r)).toEqual(['file_read'])
    expect(r.toolCalls[0].function.arguments).toEqual({ path: 'src/math.ts' })
    expect(r.source).toBe('content')
  })

  it('never runs example JSON that names an unknown tool', () => {
    const content = 'For example:\n```json\n{"name": "delete_everything", "arguments": {}}\n```'
    const r = recoverTurnCalls({ toolCalls: [], content, tools })
    expect(r.toolCalls).toEqual([])
    expect(r.source).toBe('none')
  })

  it('takes a call stuck in the reasoning channel only when the answer is empty', () => {
    const thinking = '<tool_call>{"name": "file_read", "arguments": {"path": "a.txt"}}</tool_call>'
    expect(names(recoverTurnCalls({ toolCalls: [], content: '', thinking, tools }))).toEqual(['file_read'])
    expect(recoverTurnCalls({ toolCalls: [], content: 'Done.', thinking, tools }).toolCalls).toEqual([])
  })

  it('accepts extra names such as tool_search in a compact run', () => {
    const thinking = '<tool_call>{"name": "tool_search", "arguments": {"query": "rename files"}}</tool_call>'
    const r = recoverTurnCalls({ toolCalls: [], content: '', thinking, tools, extraNames: ['tool_search'] })
    expect(names(r)).toEqual(['tool_search'])
  })

  it('cleans a JSON echo next to a native call', () => {
    const r = recoverTurnCalls({
      toolCalls: [{ id: 'a', function: { name: 'file_read', arguments: { path: 'x' } } }],
      content: 'Reading.\n{"name": "file_read", "arguments": {"path": "x"}}',
      tools,
    })
    expect(r.toolCalls).toHaveLength(1)
    expect(r.content).not.toContain('"name"')
  })

  it('is the one chain the Agent tab, the Code tab and the sub-agent run', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')
    expect(src('hooks/useAgentChat.ts')).toContain('recoverTurnCalls(')
    expect(src('hooks/useCodex.ts').match(/recoverTurnCalls\(/g)?.length).toBeGreaterThanOrEqual(3)
    expect(src('api/agents/sub-agent.ts')).toContain('recoverTurnCalls(')
    expect(src('hooks/useAgentChat.ts')).not.toContain('parseLooseToolCalls(')
  })
})
