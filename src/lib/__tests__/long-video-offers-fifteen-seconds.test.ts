/**
 * P5 (3.0.9): the Length control stops at 15 s. The B18 box runs made 30 s
 * with clean seams, but every section came out more saturated and sharper
 * than the one before, clearly so past 10–15 s. Until David decides (D2) the
 * control offers 15 s; one constant opens it to 30 s.
 *
 * Run: npx vitest run src/lib/__tests__/long-video-offers-fifteen-seconds.test.ts
 */
import { describe, expect, it } from 'vitest'
import { LONG_SECONDS_CAP, MAX_LONG_SECONDS, planLongVideo } from '../long-video'
import { longVideoRequest, type LongVideoAsk } from '../long-video-run'
import { useCreateStore } from '../../stores/createStore'

const ask = (over: Partial<LongVideoAsk>): LongVideoAsk => ({
  mode: 'video', intent: 'video',
  model: 'wan2.2_i2v_high_noise_14B_Q4_K_S.gguf', type: 'wan',
  installed: ['wan2.2_i2v_high_noise_14B_Q4_K_S.gguf'],
  longVideoSeconds: 15, longVideoMode: 'sections', fps: 16, frames: 81, extendClip: null,
  ...over,
})

describe('the Length control offers 15 s for now', () => {
  it('the limit is 15 s, the sections themselves still reach 30 s', () => {
    expect(MAX_LONG_SECONDS).toBe(15)
    expect(LONG_SECONDS_CAP).toBe(30)
    expect(planLongVideo('wan', 30, 16)!.seconds).toBeGreaterThanOrEqual(30)
  })

  it('the store keeps a longer ask at 15 s', () => {
    useCreateStore.getState().setLongVideoSeconds(30)
    expect(useCreateStore.getState().longVideoSeconds).toBe(15)
    useCreateStore.getState().setLongVideoSeconds(12)
    expect(useCreateStore.getState().longVideoSeconds).toBe(12)
  })

  it('a saved 30 s from before makes a 15 s clip, not 30', () => {
    const r = longVideoRequest(ask({ longVideoSeconds: 30 }))
    expect(r?.kind).toBe('sections')
    if (r?.kind !== 'sections') return
    // 81 + 76 + 76 = 233 frames, 14.6 s: a fourth section would add 0.4 s
    // for a whole run.
    expect(r.plan.seconds).toBeGreaterThan(14.5)
    expect(r.plan.seconds).toBeLessThan(15.3)
    expect(r.plan.sections).toEqual([81, 81, 81])
  })

  it('Extend Video adds at most 15 s in one go', () => {
    const r = longVideoRequest(ask({ intent: 'extend', longVideoSeconds: 30, extendClip: new Blob(['x']) }))
    expect(r?.kind).toBe('sections')
    if (r?.kind !== 'sections') return
    expect(r.plan.seconds).toBeLessThan(15.3)
  })
})
