/**
 * C59 bench, AG3 on the 9B: 23 web searches in one turn, each query a word
 * apart, so no repeat detector fired. A streak of search-only steps now
 * steers at six and ends the turn at twelve.
 */
import { describe, it, expect } from 'vitest'
import { AgentLoopGuard } from '../agent-loop-guard'

const search = (q: string) => [{ name: 'web_search', args: JSON.stringify({ query: q }) }]

describe('web searches in a row', () => {
  it('steer at six, halt at twelve, each query different', () => {
    const g = new AgentLoopGuard()
    const verdicts = Array.from({ length: 12 }, (_, i) => g.recordBatch(search(`bash mv rename ${i}`)).action)
    expect(verdicts.slice(0, 5).every((v) => v === 'ok')).toBe(true)
    expect(verdicts[5]).toBe('steer')
    expect(verdicts.slice(6, 11).every((v) => v === 'ok')).toBe(true)
    expect(verdicts[11]).toBe('halt')
  })

  it('reading a page in between starts the count again', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 5; i++) expect(g.recordBatch(search(`q${i}`)).action).toBe('ok')
    expect(g.recordBatch([{ name: 'web_fetch', args: JSON.stringify({ url: 'https://example.org' }) }]).action).toBe('ok')
    for (let i = 0; i < 5; i++) expect(g.recordBatch(search(`r${i}`)).action).toBe('ok')
  })

  it('switched off, it stays quiet', () => {
    const g = new AgentLoopGuard({ enabled: false })
    for (let i = 0; i < 15; i++) expect(g.recordBatch(search(`q${i}`)).action).toBe('ok')
  })
})
