/**
 * Fund 6 (3.0.7): the Frames slider of a local Wan runs to 121, but Wan 2.1
 * learned its clips at 81 frames and turns restless past that. Nothing said
 * so; the slider read as if any length were fine. Past 81 a line under it now
 * says where Wan holds steady and points to Extend Video.
 *
 * Run: npx vitest run src/lib/__tests__/wan-says-where-its-length-turns-restless.test.ts
 */
import { describe, it, expect } from 'vitest'
import { frameRangeFor, lengthHint, WAN_STEADY_FRAMES } from '../video-length'

describe('the length hint under the Frames slider', () => {
  it('stays away while Wan is within its steady length', () => {
    expect(lengthHint('wan', 1)).toBeNull()
    expect(lengthHint('wan', WAN_STEADY_FRAMES)).toBeNull()
  })

  it('names the steady length and the Length control past it (B18)', () => {
    expect(frameRangeFor('wan').max).toBeGreaterThan(WAN_STEADY_FRAMES)
    const hint = lengthHint('wan', WAN_STEADY_FRAMES + 4)
    expect(hint).toMatch(/81 frames/)
    expect(hint).toMatch(/Length in seconds/)
  })

  it('is for Wan 2.1 only: Wan 2.2 and LTX learned longer clips', () => {
    expect(lengthHint('wan22', 121)).toBeNull()
    expect(lengthHint('ltx', 121)).toBeNull()
    expect(lengthHint('ltx25', 257)).toBeNull()
  })
})
