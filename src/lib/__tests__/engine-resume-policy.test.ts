/**
 * GH #118: the boot resume of the built-in engine was one shot and swallowed
 * its failure. The repair is a retry, and a retry needs a ceiling, because the
 * failure it retries can also be a model this machine will never load.
 *
 * Run: npx vitest run src/lib/__tests__/engine-resume-policy.test.ts
 */
import { describe, it, expect } from 'vitest'
import { RESUME_ATTEMPTS, resumeBackoffMs } from '../engine-resume-policy'

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
