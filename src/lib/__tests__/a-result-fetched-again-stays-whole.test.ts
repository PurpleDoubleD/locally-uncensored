/**
 * CA (13./14.11.2026): a read the model fetched again after its result was
 * capped keeps its NEWEST result whole (context-decay keepWhole). Capping it
 * again only started the next read, cap, read lap, each a full paid request.
 */
import { describe, it, expect } from 'vitest'
import { applyToolResultDecay, DECAY_RESULT_CHARS } from '../context-decay'

type M = { role: string; content: string; key?: string; tool_call_id?: string; tool_calls?: unknown[] }

const big = (tag: string) => tag + 'x'.repeat(DECAY_RESULT_CHARS * 3)

/** Six iterations: the same file read in step 1 and step 4, other reads between. */
function run(): M[] {
  const out: M[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }]
  const reads = ['a.ts', 'b.ts', 'c.ts', 'a.ts', 'd.ts', 'e.ts']
  reads.forEach((f, i) => {
    out.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}` }] })
    out.push({ role: 'tool', content: big(`${f}#${i}`), tool_call_id: `c${i}`, key: `file_read|${f}` })
  })
  return out
}

const keyOf = (m: M) => m.key

describe('keepWhole', () => {
  it('without it, the second read of a.ts ages out and is capped like the rest', () => {
    const r = applyToolResultDecay(run(), { keyOf })
    const second = r.messages.find((m) => m.content.startsWith('a.ts#3'))!
    expect(second.content.length).toBeLessThan(DECAY_RESULT_CHARS * 2)
  })

  it('with it, the newest a.ts result stays whole while its older copy and the others are capped', () => {
    const r = applyToolResultDecay(run(), { keyOf, keepWhole: new Set(['file_read|a.ts']) })
    const first = r.messages.find((m) => m.content.startsWith('a.ts#0'))!
    const second = r.messages.find((m) => m.content.startsWith('a.ts#3'))!
    const other = r.messages.find((m) => m.content.startsWith('b.ts#1'))!
    expect(second.content.length).toBe(big('a.ts#3').length)
    expect(first.content.length).toBeLessThan(DECAY_RESULT_CHARS * 2)
    expect(other.content.length).toBeLessThan(DECAY_RESULT_CHARS * 2)
  })

  it('needs keyOf to know which result is which; without it nothing is pinned', () => {
    const r = applyToolResultDecay(run(), { keepWhole: new Set(['file_read|a.ts']) })
    const second = r.messages.find((m) => m.content.startsWith('a.ts#3'))!
    expect(second.content.length).toBeLessThan(DECAY_RESULT_CHARS * 2)
  })
})

describe('the loops feed it', () => {
  it('both agent loops pass the reads fetched again after a cap', async () => {
    const { readFileSync } = await import('node:fs')
    for (const f of ['../../hooks/useAgentChat.ts', '../../hooks/useCodex.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(src, f).toMatch(/keepWhole: neededAgain,/)
      expect(src, f).toMatch(/if \(trimmedReadKeys\.has\(k\)\) neededAgain\.add\(k\)/)
    }
  })
})
