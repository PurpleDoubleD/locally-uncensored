/**
 * A1 LOOP-GUARD: the sanctioned re-read must not read as a loop.
 *
 * Two independent review lenses found the same trap: age decay makes re-reading
 * a file the CORRECT move, and re-reading a file is exactly what the loop guard
 * was built to stop. Left alone, the guard would steer at the third re-read and
 * halt at the fifth, and its steer text would tell the model to "use the result
 * from before", which after a cap is the 4k stub. That sentence is an order to
 * work against content the model cannot see, i.e. the Morgan failure, issued by
 * our own harness.
 */

import { describe, it, expect } from 'vitest'
import { AgentLoopGuard } from '../agent-loop-guard'

const READ = (path: string) => ({ name: 'file_read', args: JSON.stringify({ path }) })
const keyOf = (path: string) => `file_read|${JSON.stringify({ path })}`

/**
 * A batch that carries the same read next to a call that differs every time.
 * Detector 2 keys on the whole batch signature, so a varying companion keeps
 * it out of the picture and leaves detector 3 (the per-key read counter) as
 * the one under test.
 */
const readPlusNoise = (path: string, n: number) => [
  READ(path),
  { name: 'file_search', args: `{"q":"noise-${n}"}` },
]

describe('A1 loop guard: a read whose result was capped never counts', () => {
  it('read in step 1, capped from step 3, re-reads in steps 4, 7 and 10 all pass', () => {
    const guard = new AgentLoopGuard()
    const trimmed = new Set([keyOf('src/big.ts')])

    // Step 1: the first read, nothing capped yet.
    expect(guard.recordBatch([READ('src/big.ts')]).action).toBe('ok')
    // Steps 2 and 3: other work, so no two identical batches sit back to back.
    expect(guard.recordBatch([{ name: 'file_list', args: '{"path":"."}' }]).action).toBe('ok')
    expect(guard.recordBatch([{ name: 'file_search', args: '{"q":"x"}' }]).action).toBe('ok')

    // From here the builder reports the read as capped.
    for (const step of [4, 7, 10]) {
      expect(
        guard.recordBatch([READ('src/big.ts')], { trimmedReadKeys: trimmed }).action,
        `step ${step}`,
      ).toBe('ok')
      guard.recordBatch([{ name: 'file_list', args: `{"path":"${step}"}` }])
      guard.recordBatch([{ name: 'file_search', args: `{"q":"${step}"}` }])
    }
  })

  it('negative control: without the capped marker the third read steers', () => {
    const guard = new AgentLoopGuard()
    expect(guard.recordBatch(readPlusNoise('src/big.ts', 1)).action).toBe('ok')
    expect(guard.recordBatch(readPlusNoise('src/big.ts', 2)).action).toBe('ok')
    const third = guard.recordBatch(readPlusNoise('src/big.ts', 3))
    expect(third.action).toBe('steer')
  })

  it('negative control: without the capped marker the fifth read halts', () => {
    const guard = new AgentLoopGuard()
    let last = guard.recordBatch(readPlusNoise('src/big.ts', 0))
    for (let i = 1; i < 8 && last.action !== 'halt'; i++) {
      last = guard.recordBatch(readPlusNoise('src/big.ts', i))
    }
    expect(last.action).toBe('halt')
    expect(last.action === 'halt' && last.reason).toMatch(/identical arguments/)
  })

  it('with the capped marker the same eight rounds never halt', () => {
    const guard = new AgentLoopGuard()
    const trimmed = new Set([keyOf('src/big.ts')])
    const verdicts: string[] = []
    for (let i = 0; i < 8; i++) {
      verdicts.push(guard.recordBatch(readPlusNoise('src/big.ts', i), { trimmedReadKeys: trimmed }).action)
    }
    expect(verdicts).toEqual(new Array(8).fill('ok'))
  })
})

describe('A1 loop guard: the steer text never orders work against a stub', () => {
  it('says "use the result from before" only when the result is still there', () => {
    const guard = new AgentLoopGuard()
    guard.recordBatch(readPlusNoise('a.ts', 1))
    guard.recordBatch(readPlusNoise('a.ts', 2))
    const steer = guard.recordBatch(readPlusNoise('a.ts', 3))
    expect(steer.action).toBe('steer')
    expect(steer.action === 'steer' && steer.message).toContain('Use the result from before')
  })

  it('never emits that sentence for a read the builder capped', () => {
    const guard = new AgentLoopGuard()
    const trimmed = new Set([keyOf('a.ts')])
    const seen: string[] = []
    for (let i = 0; i < 12; i++) {
      // Varying companion so detector 1 (three identical batches in a row)
      // stays out of it; that one is the deliberate backstop, tested below.
      const v = guard.recordBatch(readPlusNoise('a.ts', i), { trimmedReadKeys: trimmed })
      if (v.action === 'steer') seen.push(v.message)
    }
    expect(seen).toEqual([])
  })
})

describe('A1 loop guard: detector 2 skips capped re-reads', () => {
  it('three identical read batches within six steps halt normally', () => {
    const guard = new AgentLoopGuard()
    const other = (n: number) => [{ name: 'file_list', args: `{"path":"${n}"}` }]
    guard.recordBatch([READ('x.ts')])
    guard.recordBatch(other(1))
    guard.recordBatch([READ('x.ts')])
    guard.recordBatch(other(2))
    const third = guard.recordBatch([READ('x.ts')])
    // Detector 2 warns on a third identical read batch inside the six-step
    // window and halts the next one (C59 A5); the decay had to be taught about both.
    expect(third.action).toBe('steer')
    guard.recordBatch(other(3))
    expect(guard.recordBatch([READ('x.ts')]).action).toBe('halt')
  })

  it('the same three batches pass when every read was capped', () => {
    const guard = new AgentLoopGuard()
    const trimmed = new Set([keyOf('x.ts')])
    const other = (n: number) => [{ name: 'file_list', args: `{"path":"${n}"}` }]
    expect(guard.recordBatch([READ('x.ts')], { trimmedReadKeys: trimmed }).action).toBe('ok')
    guard.recordBatch(other(1))
    expect(guard.recordBatch([READ('x.ts')], { trimmedReadKeys: trimmed }).action).toBe('ok')
    guard.recordBatch(other(2))
    expect(guard.recordBatch([READ('x.ts')], { trimmedReadKeys: trimmed }).action).toBe('ok')
  })
})

describe('A1 loop guard: a read-only plan run survives its own re-reads', () => {
  it('five reads of one reference file over twelve steps do not halt', () => {
    const guard = new AgentLoopGuard()
    const trimmed = new Set([keyOf('docs/spec.md')])
    const verdicts: string[] = []
    for (let step = 1; step <= 12; step++) {
      const batch = step % 3 === 1
        ? [READ('docs/spec.md')]
        : [{ name: 'file_search', args: `{"q":"step${step}"}` }]
      verdicts.push(guard.recordBatch(batch, { trimmedReadKeys: trimmed }).action)
    }
    expect(verdicts.filter((v) => v === 'halt')).toEqual([])
  })
})

describe('A1 loop guard: the backstop is deliberately left in place', () => {
  it('three byte-identical batches back to back still halt, capped or not', () => {
    const guard = new AgentLoopGuard()
    const trimmed = new Set([keyOf('y.ts')])
    guard.recordBatch([READ('y.ts')], { trimmedReadKeys: trimmed })
    guard.recordBatch([READ('y.ts')], { trimmedReadKeys: trimmed })
    const third = guard.recordBatch([READ('y.ts')], { trimmedReadKeys: trimmed })
    expect(third.action).toBe('steer')
    expect(guard.recordBatch([READ('y.ts')], { trimmedReadKeys: trimmed }).action).toBe('halt')
  })
})
