// The 22.11.2026 run on the RTX 5080: a 24 fps clip came back 3.2 s long while
// the app said five. The run's length is frames at the run's rate, so it has
// to hold for every source rate the sampler can draw from.
import { describe, it, expect } from 'vitest'
import { swapLocalFrames } from '../swap-local'

describe('swapLocalFrames', () => {
  it.each([24, 30, 60])('a long %i fps clip gives the promised five seconds', (sourceFps) => {
    const frames = swapLocalFrames(7, 16)
    expect(frames).toBe(81)
    expect(frames / 16).toBeCloseTo(5.06, 2)
    expect(Math.floor((frames / 16) * sourceFps)).toBeGreaterThanOrEqual(frames)
  })

  it.each([[3, 45], [2, 29], [4.9, 77], [5, 77], [1, 13]])('a %f s clip is never stretched', (seconds, frames) => {
    expect(swapLocalFrames(seconds, 16)).toBe(frames)
    expect(frames / 16).toBeLessThanOrEqual(seconds)
    expect((frames - 1) % 4).toBe(0)
  })

  it('a very short clip still gets a frame count Wan can run', () => {
    expect(swapLocalFrames(0.1, 16)).toBe(5)
  })

  it('an unreadable length counts as long enough', () => {
    expect(swapLocalFrames(undefined, 16)).toBe(81)
    expect(swapLocalFrames(0, 16)).toBe(81)
  })

  it('reads a missing rate as Wan\'s 16 fps', () => {
    expect(swapLocalFrames(7, 0)).toBe(81)
  })
})
