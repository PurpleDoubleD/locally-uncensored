/**
 * C76: the stored mask (white where painted, on black) back into what is
 * drawn: an alpha mask for the editor, a red tint for the preview.
 *
 * Run: npx vitest run src/components/create/canvas/__tests__/mask-pixels-c76.test.ts
 */
import { describe, expect, it } from 'vitest'
import { maskToAlpha, MASK_TINT, MASK_TINT_OPACITY } from '../mask-pixels'

const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat())

describe('a stored mask as pixels to draw', () => {
  it('white becomes opaque, black see-through, grey keeps its share', () => {
    const d = px([255, 255, 255, 255], [0, 0, 0, 255], [128, 128, 128, 255])
    maskToAlpha(d, [255, 255, 255])
    expect([...d]).toEqual([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 128])
  })

  it('the preview tint is the editor\'s red at half strength', () => {
    const d = px([255, 255, 255, 255], [0, 0, 0, 255])
    maskToAlpha(d, MASK_TINT, MASK_TINT_OPACITY)
    expect([...d]).toEqual([239, 68, 68, 128, 239, 68, 68, 0])
  })

  it('a see-through pixel of the file stays see-through', () => {
    const d = px([255, 255, 255, 0])
    maskToAlpha(d, [255, 255, 255])
    expect(d[3]).toBe(0)
  })
})
