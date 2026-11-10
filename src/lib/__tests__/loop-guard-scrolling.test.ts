/** browser_scroll (P-L, C53) repeats its arguments by design; only a long scroll streak meets the guard. */
import { describe, it, expect } from 'vitest'
import { AgentLoopGuard } from '../agent-loop-guard'

const scroll = { name: 'browser_scroll', args: '{"direction":"down"}' }

describe('scrolling is not a loop', () => {
  it('nine identical scrolls pass, the tenth steers, the twentieth halts', () => {
    const g = new AgentLoopGuard()
    const v = Array.from({ length: 20 }, () => g.recordBatch([scroll]).action)
    expect(v.slice(0, 9).every((a) => a === 'ok')).toBe(true)
    expect(v[9]).toBe('steer')
    expect(v[19]).toBe('halt')
  })

  it('anything else in between starts the streak again', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 9; i++) g.recordBatch([scroll])
    g.recordBatch([{ name: 'browser_snapshot', args: '{}' }])
    expect(g.recordBatch([scroll]).action).toBe('ok')
  })
})
