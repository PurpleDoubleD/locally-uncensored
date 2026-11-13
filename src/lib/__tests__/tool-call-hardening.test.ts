/**
 * C59 A3: two ways a local model's call got lost on the way.
 *
 * 1. Qwen3-Coder / Qwen3.5 templates write calls as XML
 *    (<function=name><parameter=k>v</parameter></function>). A server whose
 *    parser does not know the form hands it through as text.
 * 2. A server that takes the model for a thinking model puts the call into the
 *    reasoning channel, and the answer stays empty (llama.cpp #20809).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseFunctionXmlCalls, parseHermesToolCalls, stripToolCallTags } from '../../api/hermes-tool-calling'
import { parseLooseToolCalls, toolCallsFromReasoning } from '../loose-tool-parse'
import { recoverToolCallsFromReasoning } from '../../hooks/codex/tool-call-recovery'

const QWEN_XML = `<tool_call>
<function=file_write>
<parameter=path>
summary.md
</parameter>
<parameter=content>
- Dach neu decken
- Heizung warten
</parameter>
</function>
</tool_call>`

describe("Qwen's XML call form", () => {
  it('becomes a call with its arguments, multi-line values kept', () => {
    expect(parseHermesToolCalls(QWEN_XML)).toEqual([
      { name: 'file_write', arguments: { path: 'summary.md', content: '- Dach neu decken\n- Heizung warten' } },
    ])
  })

  it('works without the <tool_call> wrapper and reads JSON-looking values as JSON', () => {
    const text = '<function=file_read>\n<parameter=path>\nbig.txt\n</parameter>\n<parameter=offset>\n1200\n</parameter>\n</function>'
    expect(parseHermesToolCalls(text)).toEqual([{ name: 'file_read', arguments: { path: 'big.txt', offset: 1200 } }])
    expect(parseFunctionXmlCalls('<function=f><parameter=x>\n{"a":1}\n</parameter></function>')[0].arguments).toEqual({ x: { a: 1 } })
  })

  it('the loose parser lifts it out of prose, for known names only', () => {
    const prose = `Ich schreibe die Datei.\n${QWEN_XML}`
    expect(parseLooseToolCalls(prose, ['file_write']).calls.map((c) => c.name)).toEqual(['file_write'])
    expect(parseLooseToolCalls(prose, ['file_read']).calls).toEqual([])
  })

  it('is stripped from the visible text', () => {
    expect(stripToolCallTags(`Okay.\n<function=a>\n<parameter=b>\nc\n</parameter>\n</function>`).trim()).toBe('Okay.')
  })

  it('JSON inside <tool_call> still parses as before', () => {
    expect(parseHermesToolCalls('<tool_call>{"name":"file_list","arguments":{"path":"."}}</tool_call>'))
      .toEqual([{ name: 'file_list', arguments: { path: '.' } }])
  })
})

describe('a call stranded in the reasoning channel', () => {
  const thinking = `The user wants a summary. I will read the file.\n<tool_call>\n{"name": "file_read", "arguments": {"path": "notes.txt"}}\n</tool_call>`

  it('is lifted when the turn has no call and no answer', () => {
    expect(toolCallsFromReasoning(thinking, '', 0, ['file_read'])).toEqual([{ name: 'file_read', arguments: { path: 'notes.txt' } }])
  })

  it('stays where it is when the turn answered or called something', () => {
    expect(toolCallsFromReasoning(thinking, 'Here is the summary.', 0, ['file_read'])).toEqual([])
    expect(toolCallsFromReasoning(thinking, '', 1, ['file_read'])).toEqual([])
  })

  it('never reads prose or unknown names as a call', () => {
    expect(toolCallsFromReasoning('Maybe I should call file_read(path="x") first.', '', 0, ['file_read'])).toEqual([])
    expect(toolCallsFromReasoning(thinking, '', 0, ['file_write'])).toEqual([])
  })

  it('the Code tab uses the same rule', () => {
    expect(recoverToolCallsFromReasoning([], '', thinking, ['file_read']))
      .toEqual([{ function: { name: 'file_read', arguments: { path: 'notes.txt' } } }])
    const native = [{ function: { name: 'file_list', arguments: { path: '.' } } }]
    expect(recoverToolCallsFromReasoning(native, '', thinking, ['file_read'])).toBe(native)
  })

  it('both loops call it', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')
    // CA K2: both loops run the one chain (lib/agent-core/recover.ts), which
    // ends with the reasoning step, and hand it the turn's thinking.
    expect(src('hooks/useAgentChat.ts')).toMatch(/recoverTurnCalls\(\{[\s\S]{0,120}thinking: turnThinking/)
    expect(src('hooks/useCodex.ts').match(/recoverTurnCalls\(\{ toolCalls, content: turnContent, thinking: turn\.thinking/g)?.length).toBe(2)
    expect(src('lib/agent-core/recover.ts')).toContain('toolCallsFromReasoning(')
  })
})
