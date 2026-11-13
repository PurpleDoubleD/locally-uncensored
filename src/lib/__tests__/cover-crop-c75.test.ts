/**
 * C75 on a Mac: the picture of a Qwen-Image 2.1 edit is cut to the asked
 * shape, centred, at its own pixels, before the engine reads it.
 *
 * Run: npx vitest run src/lib/__tests__/cover-crop-c75.test.ts
 */
import { describe, expect, it } from 'vitest'
import { coverCropRect } from '../cover-crop'

describe('the centred piece in the asked shape', () => {
  it('3:2 to 16:9 keeps the width and cuts top and bottom', () => {
    expect(coverCropRect(768, 512, 1664, 928)).toEqual({ sx: 0, sy: 42, sw: 768, sh: 428 })
  })
  it('3:2 to 9:16 keeps the height and cuts the sides', () => {
    expect(coverCropRect(768, 512, 768, 1360)).toEqual({ sx: 239, sy: 0, sw: 289, sh: 512 })
  })
  it('the same shape is the whole picture', () => {
    expect(coverCropRect(1000, 500, 2000, 1000)).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 500 })
  })
  it('never more than the picture, never nothing', () => {
    const r = coverCropRect(10, 3000, 4096, 64)
    expect(r.sw).toBe(10)
    expect(r.sh).toBeGreaterThanOrEqual(1)
    expect(coverCropRect(0, 0, 1, 1)).toEqual({ sx: 0, sy: 0, sw: 1, sh: 1 })
  })
})
