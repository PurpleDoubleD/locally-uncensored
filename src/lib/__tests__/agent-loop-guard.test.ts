/**
 * AgentLoopGuard — the detector package built from Morgan's live loop
 * (2026-07-26): identical file_read repeated for 5 minutes plus the same
 * narration line every iteration, while the old "3 identical batches in a
 * row" rule never fired because a nudge or one varying argument reset it.
 */
import { describe, it, expect } from 'vitest'
import { AgentLoopGuard } from '../agent-loop-guard'

const read = (path: string) => ({ name: 'file_read', args: JSON.stringify({ path }) })
const write = (path: string) => ({ name: 'file_write', args: JSON.stringify({ path, content: 'x' }) })
const shell = (command: string) => ({ name: 'shell_execute', args: JSON.stringify({ command }) })

describe('AgentLoopGuard — identical reads (Morgan repro)', () => {
  it('intervenes no later than the 3rd identical file_read', () => {
    const g = new AgentLoopGuard()
    expect(g.recordBatch([read('rotation.py')]).action).toBe('ok')
    expect(g.recordBatch([read('rotation.py')]).action).toBe('ok')
    const third = g.recordBatch([read('rotation.py')])
    // The 3rd identical batch also trips the back-to-back rule — either way
    // the loop must not reach a 4th silent repetition.
    expect(['steer', 'halt']).toContain(third.action)
  })

  it('halts identical reads even when other calls vary in between', () => {
    const g = new AgentLoopGuard()
    // Interleave a DIFFERENT read each time so no batch-level rule can fire
    // on its own — this is the pattern that dodged the old guard.
    expect(g.recordBatch([read('a.py'), read('x1.py')]).action).toBe('ok')
    expect(g.recordBatch([read('a.py'), read('x2.py')]).action).toBe('ok')
    const v3 = g.recordBatch([read('a.py'), read('x3.py')])
    expect(v3.action).toBe('steer')
    expect(v3.action === 'steer' && v3.message).toMatch(/file_read 3 times/)
    expect(g.recordBatch([read('a.py'), read('x4.py')]).action).toBe('ok') // steer fires once
    const v5 = g.recordBatch([read('a.py'), read('x5.py')])
    expect(v5.action).toBe('halt')
    expect(v5.action === 'halt' && v5.reason).toMatch(/file_read repeated 5×/)
  })

  it('resets the read counters after a mutating call (re-read after change is legit)', () => {
    const g = new AgentLoopGuard()
    expect(g.recordBatch([read('a.py')]).action).toBe('ok')
    expect(g.recordBatch([read('a.py')]).action).toBe('ok')
    expect(g.recordBatch([shell('sed -i s/x/y/ a.py')]).action).toBe('ok')
    // Fresh epoch: the same read twice more is fine.
    expect(g.recordBatch([read('a.py')]).action).toBe('ok')
    expect(g.recordBatch([read('a.py')]).action).toBe('ok')
  })
})

describe('AgentLoopGuard — batch signatures', () => {
  it('steers on 3 identical batches back-to-back and halts on the 4th (C59 A5, any tool)', () => {
    const g = new AgentLoopGuard()
    expect(g.recordBatch([write('f.py')]).action).toBe('ok')
    expect(g.recordBatch([write('f.py')]).action).toBe('ok')
    const s = g.recordBatch([write('f.py')])
    expect(s.action).toBe('steer')
    expect(s.action === 'steer' && s.message).toMatch(/exactly the same tool calls \(file_write\) 3 times in a row/)
    const v = g.recordBatch([write('f.py')])
    expect(v.action).toBe('halt')
    expect(v.action === 'halt' && v.reason).toMatch(/4× in a row/)
  })

  it('a different batch after the warning starts the count again', () => {
    const g = new AgentLoopGuard()
    for (let i = 0; i < 2; i++) g.recordBatch([write('f.py')])
    expect(g.recordBatch([write('f.py')]).action).toBe('steer')
    expect(g.recordBatch([shell('npm test')]).action).toBe('ok')
    expect(g.recordBatch([write('f.py')]).action).toBe('ok')
  })

  it('halts on A,B,A,B,A read alternation the consecutive rule cannot see', () => {
    const g = new AgentLoopGuard()
    expect(g.recordBatch([read('a.py')]).action).toBe('ok')
    expect(g.recordBatch([read('b.py')]).action).toBe('ok')
    expect(g.recordBatch([read('a.py')]).action).toBe('ok')
    expect(g.recordBatch([read('b.py')]).action).toBe('ok')
    expect(g.recordBatch([read('a.py')]).action).toBe('steer')
    g.recordBatch([read('b.py')])
    const v = g.recordBatch([read('a.py')])
    expect(v.action).toBe('halt')
    expect(v.action === 'halt' && v.reason).toMatch(/no workspace change/)
  })

  it('never halts a legitimate edit → test → edit → test cycle with an identical test command', () => {
    const g = new AgentLoopGuard()
    for (let round = 0; round < 5; round++) {
      expect(g.recordBatch([write(`fix-${round}.py`)]).action).toBe('ok')
      expect(g.recordBatch([shell('npm test')]).action).toBe('ok')
    }
  })
})

describe('AgentLoopGuard — narration', () => {
  it('steers when the model repeats the same line 3× in a row and halts on the 4th', () => {
    const g = new AgentLoopGuard()
    const line = 'Let me check the rotation engine to understand how spell priorities are determined:'
    expect(g.recordNarration(line).action).toBe('ok')
    expect(g.recordNarration(line).action).toBe('ok')
    expect(g.recordNarration(line).action).toBe('steer')
    const v = g.recordNarration(line)
    expect(v.action).toBe('halt')
    expect(v.action === 'halt' && v.reason).toMatch(/repeated the same message 4×/)
  })

  it('normalizes whitespace and case before comparing', () => {
    const g = new AgentLoopGuard()
    expect(g.recordNarration('Checking the   config file now').action).toBe('ok')
    expect(g.recordNarration('checking the config FILE now').action).toBe('ok')
    expect(g.recordNarration('Checking the config file now').action).toBe('steer')
  })

  it('ignores trivial short lines and resets on new content', () => {
    const g = new AgentLoopGuard()
    expect(g.recordNarration('Done.').action).toBe('ok')
    expect(g.recordNarration('Done.').action).toBe('ok')
    expect(g.recordNarration('Done.').action).toBe('ok')
    const line = 'Now updating the parser to handle nested blocks'
    expect(g.recordNarration(line).action).toBe('ok')
    expect(g.recordNarration(line).action).toBe('ok')
    expect(g.recordNarration('And now the tests for the parser change').action).toBe('ok')
    expect(g.recordNarration(line).action).toBe('ok') // streak was broken
  })
})
