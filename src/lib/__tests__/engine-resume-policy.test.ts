/**
 * GH #118: the boot resume of the built-in engine was one shot and swallowed
 * its failure. The repair is a retry, and a retry needs a ceiling, because the
 * failure it retries can also be a model this machine will never load.
 *
 * Run: npx vitest run src/lib/__tests__/engine-resume-policy.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { RESUME_ATTEMPTS, resumeBackoffMs, runEngineResume } from '../engine-resume-policy'
import { engineStartIsWorthRetrying } from '../engine-start-failure'

describe('resumeBackoffMs', () => {
  it('waits between the tries, and waits longer the second time', () => {
    const first = resumeBackoffMs(0)
    const second = resumeBackoffMs(1)
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThan(first!)
  })

  // Negative control, and the whole point of the ceiling: an engine that will
  // never come up must not keep the machine busy forever.
  it('stops after the budget instead of looping', () => {
    expect(resumeBackoffMs(RESUME_ATTEMPTS - 1)).toBeNull()
    expect(resumeBackoffMs(RESUME_ATTEMPTS)).toBeNull()
    expect(resumeBackoffMs(99)).toBeNull()
  })

  it('refuses nonsense attempt numbers', () => {
    expect(resumeBackoffMs(-1)).toBeNull()
    expect(resumeBackoffMs(1.5)).toBeNull()
  })

  it('gives more than one try, which is what the ticket lacked', () => {
    expect(RESUME_ATTEMPTS).toBeGreaterThan(1)
    const delays = Array.from({ length: RESUME_ATTEMPTS }, (_, i) => resumeBackoffMs(i))
    expect(delays.filter((d) => d !== null)).toHaveLength(RESUME_ATTEMPTS - 1)
  })
})

describe('runEngineResume: the loop itself (review S7)', () => {
  const noSleep = async () => {}
  const always = () => true

  it('does nothing when the engine is already up', async () => {
    const activate = vi.fn()
    const out = await runEngineResume({
      status: async () => ({ running: true }),
      eligible: always,
      activate,
      worthRetrying: always,
      sleep: noSleep,
    })
    expect(out.outcome).toBe('already-running')
    expect(activate).not.toHaveBeenCalled()
  })

  it('starts once when there is something to resume', async () => {
    const activate = vi.fn(async () => true)
    const out = await runEngineResume({
      status: async () => ({ running: false }),
      eligible: always,
      activate,
      worthRetrying: always,
      sleep: noSleep,
    })
    expect(out.outcome).toBe('started')
    expect(activate).toHaveBeenCalledTimes(1)
    expect(out.sleptMs).toEqual([])
  })

  it('does not retry what there is nothing to retry for', async () => {
    const activate = vi.fn()
    const out = await runEngineResume({
      status: async () => ({ running: false }),
      eligible: () => false,
      activate,
      worthRetrying: always,
      sleep: noSleep,
    })
    expect(out.outcome).toBe('not-eligible')
    expect(out.attempts).toBe(1)
    expect(activate).not.toHaveBeenCalled()
  })

  it('retries a death, waits longer each time, and stops at the ceiling', async () => {
    // The failure the ticket needed a second chance for.
    const activate = vi.fn(async () => {
      throw new Error('The built-in engine started and exited again before it could serve on port 8127.')
    })
    const slept: number[] = []
    const out = await runEngineResume({
      status: async () => ({ running: false }),
      eligible: always,
      activate,
      worthRetrying: engineStartIsWorthRetrying,
      sleep: async (ms) => { slept.push(ms) },
    })
    expect(out.outcome).toBe('gave-up')
    expect(activate).toHaveBeenCalledTimes(RESUME_ATTEMPTS)
    expect(slept).toHaveLength(RESUME_ATTEMPTS - 1)
    expect(slept[1]).toBeGreaterThan(slept[0])
  })

  // The S3 finding: repeating a health-budget timeout spends the same budget
  // again, up to ten minutes on a big GGUF, and re-runs the ComfyUI cache drop
  // and the Ollama eviction every time.
  it('never repeats a health-budget timeout', async () => {
    const activate = vi.fn(async () => {
      throw new Error('The built-in engine did not become healthy on port 8127 within 220s')
    })
    const slept: number[] = []
    const out = await runEngineResume({
      status: async () => ({ running: false }),
      eligible: always,
      activate,
      worthRetrying: engineStartIsWorthRetrying,
      sleep: async (ms) => { slept.push(ms) },
    })
    expect(out.outcome).toBe('gave-up')
    expect(activate).toHaveBeenCalledTimes(1)
    expect(slept).toEqual([])
  })

  it('a second attempt that works ends the loop', async () => {
    let calls = 0
    const activate = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('exited again before it could serve')
      return true
    })
    const out = await runEngineResume({
      status: async () => ({ running: false }),
      eligible: always,
      activate,
      worthRetrying: engineStartIsWorthRetrying,
      sleep: noSleep,
    })
    expect(out.outcome).toBe('started')
    expect(out.attempts).toBe(2)
  })
})
