import { describe, it, expect, vi } from 'vitest'
import { measureRun } from '../benchmark-run'
import { BENCHMARK_PROMPTS } from '../benchmark-prompts'
import type { ChatStreamChunk } from '../../api/providers/types'

/**
 * measureRun is the accounting the benchmark hook used to bury inside a React
 * callback, where nothing could reach it. Lifted out, it can be run against a
 * scripted stream, which is the only way to reproduce the one case David cared
 * about without a live model: a reasoning model that works out the right answer
 * and then hits its token budget before printing it.
 */

async function* streamOf(chunks: Partial<ChatStreamChunk>[]): AsyncGenerator<ChatStreamChunk> {
  for (const c of chunks) yield { content: '', done: false, ...c } as ChatStreamChunk
}

/** A clock that returns each value in turn, so timing is exact in a test. */
function steppedClock(...values: number[]): () => number {
  let i = 0
  return () => {
    const v = values[Math.min(i, values.length - 1)]
    i++
    return v
  }
}

const check = (id: string) => BENCHMARK_PROMPTS.find((p) => p.id === id)!.check

describe('measureRun', () => {
  it("catches David's case: reasoning reaches the answer but the budget cuts it off", async () => {
    // The model thinks its way to 9 (visible in `thinking`), then the stream
    // ends on 'length' before any answer content. A speed-only benchmark sees
    // 50 tok/s and calls it a healthy run. The truth is a wrong, truncated one.
    const m = await measureRun(
      streamOf([
        { thinking: 'The farmer has 17 sheep. ' },
        { thinking: 'All but 9 run away, so 9 stay. ' },
        { thinking: 'Double-checking the wording... ' },
        { done: true, finishReason: 'length', evalCount: 300, evalDurationMs: 6000 },
      ]),
      check('reasoning'),
      { clock: steppedClock(0, 200, 6200) },
    )
    expect(m.correct).toBe(false) // the answer was never printed
    expect(m.finishReason).toBe('length') // and this says why
    expect(m.totalTokens).toBe(300) // authoritative count, thinking included
    expect(m.thinkTokens).toBe(300) // all of it was reasoning
    expect(m.tokensPerSec).toBe(50) // fast, which is exactly the trap
    expect(m.timeToFirstToken).toBe(200)
  })

  it('scores a clean thinking run correct and splits the think tokens off', async () => {
    const m = await measureRun(
      streamOf([
        { thinking: 'Reasoning about the sheep. ' },
        { content: 'The farmer has ' },
        { content: '9 sheep left.' },
        { done: true, finishReason: 'stop', evalCount: 40, evalDurationMs: 1000 },
      ]),
      check('reasoning'),
      { clock: steppedClock(0, 120, 1120) },
    )
    expect(m.correct).toBe(true)
    expect(m.finishReason).toBe('stop')
    expect(m.totalTokens).toBe(40)
    // one thinking chunk of three total chunks, scaled onto the authoritative
    // total: round(40 * 1/3) = 13
    expect(m.thinkTokens).toBe(13)
  })

  it('a model that does not think out loud spends zero think tokens', async () => {
    const m = await measureRun(
      streamOf([
        { content: 'def fibonacci(n):\n' },
        { content: '    return n\n' },
        { done: true, finishReason: 'stop' },
      ]),
      check('code'),
      { clock: steppedClock(0, 100, 1100) },
    )
    expect(m.thinkTokens).toBe(0)
    expect(m.totalTokens).toBe(2) // two content chunks, JS fallback (no API metrics)
    expect(m.correct).toBe(true)
    expect(m.tokensPerSec).toBeCloseTo(2, 5) // 2 tokens / 1000ms generation
  })

  it('falls back to wall-clock rate when the stream arrives buffered', async () => {
    // No server metrics and the whole response lands in a ~0ms window: the
    // post-TTFT formula would divide by almost nothing, so measureRun uses the
    // wall-clock rate instead (the Bug M v2.4.7 guard).
    const m = await measureRun(
      streamOf([{ content: 'nine' }, { done: true, finishReason: 'stop' }]),
      check('reasoning'),
      { clock: steppedClock(0, 10, 60) },
    )
    expect(m.correct).toBe(true) // spelled-out answer
    expect(m.tokensPerSec).toBeCloseTo((1 / 60) * 1000, 3)
  })

  it('carries a disconnect reason through untouched', async () => {
    const m = await measureRun(
      streamOf([{ content: 'partial ans' }, { done: true, finishReason: 'disconnect' }]),
      check('code'),
      { clock: steppedClock(0, 50, 550) },
    )
    expect(m.finishReason).toBe('disconnect')
    expect(m.correct).toBe(false)
  })
})

// P3 from the review of C1 (2026-08-14). The wall clock is the half of the
// brake meant for "the benchmark simply stops moving", and it was the one case
// it could not catch: the check lived inside the for-await body, so it only ran
// when a chunk arrived. A model that stops sending parks the loop on a pending
// next() forever. The token cap cannot help there either, because a stalled
// stream produces no tokens.
describe('the wall clock reaches a stream that has stopped sending', () => {
  /** A stream that yields one chunk and then never resolves again. */
  function stalling(): AsyncIterable<ChatStreamChunk> {
    let served = false
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (!served) {
              served = true
              return Promise.resolve({ done: false, value: { content: 'hi', done: false } })
            }
            return new Promise<never>(() => { /* the stall */ })
          },
          return() { return Promise.resolve({ done: true, value: undefined }) },
        }
      },
    }
  }

  it('stops with finishReason timeout instead of hanging', async () => {
    const onLimit = vi.fn()
    const m = await measureRun(stalling(), () => true, {
      clock: () => 0,
      maxMs: 50,
      // Trip immediately, so the test does not wait on a real timer.
      deadlineIn: () => Promise.resolve(),
      onLimit,
    })
    expect(m.finishReason).toBe('timeout')
    expect(onLimit).toHaveBeenCalledWith('timeout')
  })

  it('closes the generator so the model is not left generating', async () => {
    let closed = false
    const stream: AsyncIterable<ChatStreamChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next() { return new Promise<never>(() => {}) },
          return() { closed = true; return Promise.resolve({ done: true, value: undefined }) },
        }
      },
    }
    await measureRun(stream, () => true, {
      clock: () => 0, maxMs: 10, deadlineIn: () => Promise.resolve(),
    })
    expect(closed).toBe(true)
  })

  it('a stream that finishes normally is untouched by the deadline', async () => {
    async function* good(): AsyncGenerator<ChatStreamChunk> {
      yield { content: 'a', done: false }
      yield { content: 'b', finishReason: 'stop', done: true }
    }
    const m = await measureRun(good(), () => true, {
      clock: () => 0,
      maxMs: 1000,
      // A deadline that never fires, the shape of a healthy run.
      deadlineIn: () => new Promise<void>(() => {}),
    })
    expect(m.finishReason).toBe('stop')
    expect(m.totalTokens).toBe(2)
  })
})
