// SDXL on the RTX 5080, 23.11.2026: a mask with an empty prompt cleared the
// area in 2 of 6 runs and painted something new in the others.
import { describe, it, expect } from 'vitest'
import { MASK_PROMPT_PLACEHOLDER, MASK_READY_LINE, maskReadyLine } from '../local-edit-mask'

describe('the line under a painted mask', () => {
  it('says the area is repainted and can vary', () => {
    expect(MASK_READY_LINE).toContain('repaint')
    expect(MASK_READY_LINE).toContain('can vary')
    expect(`${MASK_READY_LINE} ${MASK_PROMPT_PLACEHOLDER}`).not.toMatch(/\bremove\b/i)
  })

  it('names Erase on LU Cloud where cloud tools are shown', () => {
    expect(maskReadyLine(true)).toContain('Erase on LU Cloud')
  })

  it('names no cloud tool when cloud features are off', () => {
    expect(maskReadyLine(false)).toBe(MASK_READY_LINE)
    expect(maskReadyLine(false)).not.toMatch(/cloud/i)
  })
})
