/**
 * Compact layers (3.0.9): the current view starts at the newest compaction,
 * each earlier one is a layer, and no message is ever lost on the way.
 *
 * Run: npx vitest run src/lib/__tests__/compact-layers.test.ts
 */
import { describe, it, expect } from 'vitest'
import { AUTO_OK_PREFIX, compactCuts, layerItems, type LayerItem } from '../compact-layers'
import type { CompactionRecord, Message } from '../../types/chat'
import type { AgentBlock } from '../../types/agent-mode'

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id, role: id.startsWith('u') ? 'user' : 'assistant', content: `text ${id}`, timestamp: 0, ...over,
})

const record = (over: Partial<CompactionRecord>): CompactionRecord => ({
  id: 'r1', summary: 'S', upToMessageId: 'a2', replaced: 4, atMessageCount: 6,
  tokensBefore: 9000, tokensAfter: 500, trigger: 'auto', at: 100, ...over,
})

const step = (id: string, t: number): AgentBlock => ({ id, phase: 'tool_call', content: id, timestamp: t })
const cutBlock = (id: string, t: number, before = 7000, after = 3000): AgentBlock => ({
  id, phase: 'reflection', content: 'Summarised …', timestamp: t, compaction: { before, after, replaced: 5 },
})

const ids = (items: LayerItem[]): string[] =>
  items.map((it) => (it.kind === 'line' ? `|${it.cut.key}|` : it.message.id))

const blocksOf = (items: LayerItem[], id: string): string[] => {
  const it = items.find((i) => i.kind === 'message' && i.message.id === id)
  return it && it.kind === 'message' ? (it.message.agentBlocks ?? []).map((b) => b.id) : []
}

describe('without compaction', () => {
  it('there is no layer and the view is the whole chat', () => {
    const messages = [msg('u1'), msg('a1')]
    const cuts = compactCuts(messages, undefined)
    expect(cuts).toEqual([])
    expect(ids(layerItems(messages, cuts, null))).toEqual(['u1', 'a1'])
  })
})

describe('a per-turn compaction (/compact or the auto trigger)', () => {
  const messages = [msg('u1'), msg('a1'), msg('u2'), msg('a2'), msg('u3'), msg('a3'), msg('u4'), msg('a4')]
  const rec = record({ endMessageId: 'a3', contextBefore: 29_594, contextAfter: 18_330 })

  it('the current view starts with the line, behind the cut', () => {
    const cuts = compactCuts(messages, [rec])
    expect(ids(layerItems(messages, cuts, null))).toEqual(['|r1|', 'u3', 'a3', 'u4', 'a4'])
  })

  it('the layer before it ends at the newest message when it ran', () => {
    const cuts = compactCuts(messages, [rec])
    expect(ids(layerItems(messages, cuts, 0))).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  })

  it('carries the whole-payload numbers, else the old per-record ones', () => {
    expect(compactCuts(messages, [rec])[0]).toMatchObject({ before: 29_594, after: 18_330 })
    expect(compactCuts(messages, [record({})])[0]).toMatchObject({ before: 9000, after: 500 })
  })

  it('a record from before 3.0.9 ends its layer at atMessageCount', () => {
    const cuts = compactCuts(messages, [record({ atMessageCount: 5 })])
    expect(ids(layerItems(messages, cuts, 0))).toEqual(['u1', 'a1', 'u2', 'a2', 'u3'])
  })

  it('a record whose anchor is gone is no cut', () => {
    expect(compactCuts(messages, [record({ upToMessageId: 'gone' })])).toEqual([])
  })

  it('the notice an auto-compaction wrote up to 3.0.8 is left out, the line says it', () => {
    const old = [...messages.slice(0, 6), msg(`${AUTO_OK_PREFIX}r1`, { role: 'system', notice: 'info' }), msg('u4')]
    const cuts = compactCuts(old, [record({ endMessageId: 'a3' })])
    expect(ids(layerItems(old, cuts, null))).toEqual(['|r1|', 'u3', 'a3', 'u4'])
  })
})

describe('a compaction in the middle of an Agent or Code run', () => {
  const answer = msg('a1', {
    content: 'final answer',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    agentBlocks: [step('s1', 1), step('s2', 2), cutBlock('k1', 3), step('s3', 4), step('s4', 5)],
  })
  const messages = [msg('u0'), msg('a0'), msg('u1'), answer]

  it('the current view starts at the block, inside the answer', () => {
    const cuts = compactCuts(messages, undefined)
    expect(cuts).toHaveLength(1)
    const now = layerItems(messages, cuts, null)
    expect(ids(now)).toEqual(['|k1|', 'a1'])
    expect(blocksOf(now, 'a1')).toEqual(['s3', 's4'])
    // The answer's text and numbers came after the cut and stay with it.
    const a1 = now[1]
    expect(a1.kind === 'message' && a1.message.content).toBe('final answer')
  })

  it('the layer before holds the steps up to the cut, without the final text', () => {
    const cuts = compactCuts(messages, undefined)
    const before = layerItems(messages, cuts, 0)
    expect(ids(before)).toEqual(['u0', 'a0', 'u1', 'a1'])
    expect(blocksOf(before, 'a1')).toEqual(['s1', 's2'])
    const a1 = before[3]
    expect(a1.kind === 'message' && a1.message.content).toBe('')
    expect(a1.kind === 'message' && a1.message.usage).toBeUndefined()
  })

  it('two cuts in one answer make two layers', () => {
    const two = msg('a1', { agentBlocks: [step('s1', 1), cutBlock('k1', 2), step('s2', 3), cutBlock('k2', 4), step('s3', 5)] })
    const m = [msg('u1'), two]
    const cuts = compactCuts(m, undefined)
    expect(cuts.map((c) => c.key)).toEqual(['k1', 'k2'])
    expect(blocksOf(layerItems(m, cuts, 0), 'a1')).toEqual(['s1'])
    expect(ids(layerItems(m, cuts, 1))).toEqual(['|k1|', 'a1'])
    expect(blocksOf(layerItems(m, cuts, 1), 'a1')).toEqual(['s2'])
    expect(blocksOf(layerItems(m, cuts, null), 'a1')).toEqual(['s3'])
  })
})

describe('nothing is lost', () => {
  // The rule the 2.6.8 guard protected ("a compaction takes nothing away from
  // the transcript") in its 3.0.9 form: every stored message, and every step
  // of every answer, is in at least one layer.
  it('every message and every step is reachable through the layers', () => {
    const run = msg('a3', { agentBlocks: [step('s1', 201), step('s2', 202), cutBlock('k1', 203), step('s3', 204), cutBlock('k2', 205), step('s4', 206)] })
    const messages = [msg('u1'), msg('a1'), msg('u2'), msg('a2'), msg('u3'), run, msg('u4'), msg('a4')]
    const records = [record({ id: 'r1', upToMessageId: 'a1', endMessageId: 'a2', at: 100 })]
    const cuts = compactCuts(messages, records)
    expect(cuts.map((c) => c.key)).toEqual(['r1', 'k1', 'k2'])

    const seenMessages = new Set<string>()
    const seenSteps = new Set<string>()
    for (let layer = 0; layer <= cuts.length; layer++) {
      for (const it of layerItems(messages, cuts, layer === cuts.length ? null : layer)) {
        if (it.kind !== 'message') continue
        seenMessages.add(it.message.id)
        for (const b of it.message.agentBlocks ?? []) seenSteps.add(b.id)
      }
    }
    expect([...seenMessages].sort()).toEqual(messages.map((m) => m.id).sort())
    expect([...seenSteps].sort()).toEqual(['s1', 's2', 's3', 's4'])
  })

  it('the stored messages are not touched', () => {
    const answer = msg('a1', { agentBlocks: [step('s1', 1), cutBlock('k1', 2), step('s2', 3)] })
    const messages = [msg('u1'), answer]
    const copy = JSON.parse(JSON.stringify(messages))
    const cuts = compactCuts(messages, undefined)
    layerItems(messages, cuts, 0)
    layerItems(messages, cuts, null)
    expect(messages).toEqual(copy)
  })
})
