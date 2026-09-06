import { describe, it, expect } from 'vitest'
import {
  groupAgentBlocks,
  groupIsLive,
  activeToolCall,
  groupDurationLabel,
} from '../tool-call-groups'
import type { AgentBlockGroup, BandNote } from '../tool-call-groups'
import type { AgentBlock, AgentToolCall } from '../../types/agent-mode'

// The group union is discriminated by `kind`; these narrow it and say so out
// loud when a test's premise is wrong. The `as any` they replace let a test
// read `.calls` off a 'single' group and compare undefined against undefined.
function asBand(g: AgentBlockGroup): Extract<AgentBlockGroup, { kind: 'tools' }> {
  if (g.kind !== 'tools') throw new Error(`expected a tools band, got kind=${g.kind}`)
  return g
}
function asSingle(g: AgentBlockGroup): Extract<AgentBlockGroup, { kind: 'single' }> {
  if (g.kind !== 'single') throw new Error(`expected a single block, got kind=${g.kind}`)
  return g
}

let ts = 0
function call(name: string, status: AgentToolCall['status'], duration?: number): AgentToolCall {
  return { id: `c-${++ts}`, toolName: name, args: {}, status, duration, timestamp: ts }
}
function toolBlock(tc: AgentToolCall): AgentBlock {
  return { id: `b-${tc.id}`, phase: 'tool_call', content: '', toolCall: tc, toolCalls: [tc], timestamp: ++ts }
}
function answerBlock(content: string): AgentBlock {
  return { id: `a-${++ts}`, phase: 'answer', content, timestamp: ts }
}

describe('groupAgentBlocks', () => {
  it('collects consecutive tool calls into one group', () => {
    const a = toolBlock(call('file_read', 'completed'))
    const b = toolBlock(call('file_write', 'completed'))
    const groups = groupAgentBlocks([a, b])
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('tools')
    expect(asBand(groups[0]).calls.map((c) => c.toolName)).toEqual(['file_read', 'file_write'])
  })

  // G14-4 (David 2026-08-07): this test used to assert the OPPOSITE, that an
  // interleaved answer splits the band. That split is exactly the stack he
  // was looking at ("die Toolcalls kommen alle untereinander"), because any
  // model that narrates between calls produced band(1), note, band(1). The
  // documented behaviour is now: interior narration is absorbed as a note.
  it('absorbs narration between calls into ONE band, anchored to its call', () => {
    const t1 = toolBlock(call('file_read', 'completed'))
    const ans = answerBlock('Step 1 done, proceeding to step 2.')
    const t2 = toolBlock(call('file_write', 'completed'))
    const t3 = toolBlock(call('shell_execute', 'completed'))
    const groups = groupAgentBlocks([t1, ans, t2, t3])
    expect(groups.map(g => g.kind)).toEqual(['tools'])
    const band = asBand(groups[0])
    expect(band.calls).toHaveLength(3)
    expect(band.notes).toEqual([{ afterCall: 0, block: ans }])
  })

  it('NEGATIVE CONTROL: the trailing answer stays OUTSIDE the band', () => {
    // The final answer is the model's actual reply. Swallowing it into a
    // collapsed band would hide the one thing David asked to see (G14-2).
    const t1 = toolBlock(call('file_read', 'completed'))
    const t2 = toolBlock(call('file_write', 'completed'))
    const fin = answerBlock('All done, results above.')
    const groups = groupAgentBlocks([t1, t2, fin])
    expect(groups.map(g => g.kind)).toEqual(['tools', 'single'])
    expect(asBand(groups[0]).notes).toEqual([])
  })

  it('NEGATIVE CONTROL: narration before the FIRST call is not band content', () => {
    const intro = answerBlock('Let me start by reading the file.')
    const t1 = toolBlock(call('file_read', 'completed'))
    const t2 = toolBlock(call('file_write', 'completed'))
    const groups = groupAgentBlocks([intro, t1, t2])
    expect(groups.map(g => g.kind)).toEqual(['single', 'tools'])
  })

  it('G21-2: an interior thinking block is absorbed as a note, band unbroken', () => {
    // Until 2026-08-07 this case asserted the SPLIT ('tools','single','tools').
    // David, live at R19: "die Denkblasen muessen zwischen den Tool Calls dann
    // genau da kommen, in der richtigen Reihenfolge" AND the band must stay
    // one row (G14-4), so round k's thought anchors after round k-1's call.
    const t1 = toolBlock(call('file_read', 'completed'))
    const think: AgentBlock = { id: `th-${++ts}`, phase: 'thinking', content: 'hm', timestamp: ts }
    const t2 = toolBlock(call('file_write', 'completed'))
    const groups = groupAgentBlocks([t1, think, t2])
    expect(groups.map(g => g.kind)).toEqual(['tools'])
    const band = asBand(groups[0])
    expect(band.notes.map((n) => [n.afterCall, n.block.phase])).toEqual([[0, 'thinking']])
  })

  it('G21-2 NEGATIVE CONTROL: a TRAILING thought stays a single after the band', () => {
    const t1 = toolBlock(call('file_read', 'completed'))
    const think: AgentBlock = { id: `th-${++ts}`, phase: 'thinking', content: 'closing thought', timestamp: ts }
    const groups = groupAgentBlocks([t1, think])
    expect(groups.map(g => g.kind)).toEqual(['tools', 'single'])
    expect(asSingle(groups[1]).block.phase).toBe('thinking')
  })

  it('multiple notes between two calls all anchor to the earlier call, in order', () => {
    const t1 = toolBlock(call('file_read', 'completed'))
    const n1 = answerBlock('first note')
    const n2 = answerBlock('second note')
    const t2 = toolBlock(call('file_write', 'completed'))
    const band = asBand(groupAgentBlocks([t1, n1, n2, t2])[0])
    expect(band.notes.map((n) => [n.afterCall, n.block.content])).toEqual([
      [0, 'first note'],
      [0, 'second note'],
    ])
  })

  it('keeps a lone tool call as a group of one', () => {
    const groups = groupAgentBlocks([toolBlock(call('web_search', 'running'))])
    expect(groups).toHaveLength(1)
    expect(asBand(groups[0]).calls).toHaveLength(1)
  })

  it('passes a tool_call block without a call payload through as single', () => {
    const broken: AgentBlock = { id: 'x', phase: 'tool_call', content: '', timestamp: 1 }
    const groups = groupAgentBlocks([broken])
    expect(groups[0].kind).toBe('single')
  })
})

// ── G34 (David 2026-08-07, R17d) ──────────────────────────────────────────
// "die tools sind nicht im call band alle untereinander." The screenshots
// showed 15+ loose chips with loose Thinking rows between them. Replaying the
// REAL persisted R17d sequence (47 rounds of thinking+call pairs, each pair
// sharing one timestamp, pulled from the app's IndexedDB) proves the grouping
// itself is correct: ONE band, every interior thought absorbed. The loose
// chips were the band EXPANDED BY THE HARNESS: __luTools clicks every
// "N steps" header once a minute to count the trail and left them open, and
// ToolCallBand renders `expanded` above `live`. Fixed in the harness
// (__luTools collapses what it opened); this test pins the app side down.
describe('G34: the real R17d shape groups into one band', () => {
  function r17dSequence(rounds: number): AgentBlock[] {
    // Exactly the persisted shape: per round one thinking block and one call
    // block with the SAME millisecond timestamp (round end writes both).
    const blocks: AgentBlock[] = []
    for (let round = 0; round < rounds; round++) {
      const at = 1_000 + round * 15_000
      blocks.push({ id: `th-${round}`, phase: 'thinking', content: `thought ${round}`, timestamp: at })
      const tc: AgentToolCall = { id: `tc-${round}`, toolName: `tool_${round}`, args: {}, status: 'completed', timestamp: at }
      blocks.push({ id: `bl-${round}`, phase: 'tool_call', content: '', toolCall: tc, toolCalls: [tc], timestamp: at })
    }
    return blocks
  }

  it('47 thinking+call rounds produce one leading thought and ONE band of 47', () => {
    const groups = groupAgentBlocks(r17dSequence(47))
    expect(groups).toHaveLength(2)
    expect(groups[0].kind).toBe('single')
    expect(asSingle(groups[0]).block.phase).toBe('thinking')
    const band = asBand(groups[1])
    expect(band.kind).toBe('tools')
    expect(band.calls).toHaveLength(47)
    // Every per-round thought except the leading one is an interior note.
    expect(band.notes).toHaveLength(46)
    expect(band.notes.every((n: BandNote) => n.block.phase === 'thinking')).toBe(true)
  })

  it('NEGATIVE CONTROL: a trailing thought stays outside the band (G21-2)', () => {
    const blocks = r17dSequence(3)
    blocks.push({ id: 'th-final', phase: 'thinking', content: 'closing thought', timestamp: 99_000 })
    const groups = groupAgentBlocks(blocks)
    const last = asSingle(groups[groups.length - 1])
    expect(last.kind).toBe('single')
    expect(last.block.id).toBe('th-final')
    const found = groups.find((g) => g.kind === 'tools')
    expect(found).toBeDefined()
    const band = asBand(found!)
    expect(band.calls).toHaveLength(3)
    expect(band.notes).toHaveLength(2)
  })
})

describe('band state helpers', () => {
  it('is live while any call runs or awaits approval, done otherwise', () => {
    expect(groupIsLive([call('a', 'completed'), call('b', 'running')])).toBe(true)
    expect(groupIsLive([call('a', 'completed'), call('b', 'pending_approval')])).toBe(true)
    expect(groupIsLive([call('a', 'completed'), call('b', 'failed')])).toBe(false)
  })

  it('active call prefers approval, then earliest running, then the last call', () => {
    const done = call('a', 'completed')
    const run1 = call('b', 'running')
    const run2 = call('c', 'running')
    const pending = call('d', 'pending_approval')
    expect(activeToolCall([done, run1, run2, pending]).toolName).toBe('d')
    expect(activeToolCall([done, run1, run2]).toolName).toBe('b')
    expect(activeToolCall([done, call('e', 'failed')]).toolName).toBe('e')
  })

  it('sums durations into the chip duration format', () => {
    expect(groupDurationLabel([call('a', 'completed', 300), call('b', 'completed', 400)])).toBe('700ms')
    expect(groupDurationLabel([call('a', 'completed', 800), call('b', 'completed', 700)])).toBe('1.5s')
    expect(groupDurationLabel([call('a', 'running')])).toBeNull()
  })
})
