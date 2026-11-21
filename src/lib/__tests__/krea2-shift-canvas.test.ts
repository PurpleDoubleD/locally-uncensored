import { describe, it, expect } from 'vitest'
import { krea2ShiftCanvas } from '../frame-refs'

// ComfyUI's ModelSamplingFlux at max 1.15, base 0.5, and its flux_time_shift.
const mu = (w: number, h: number) => { const m = 0.65 / 3840; return (w * h / 256) * m + 0.5 - m * 256 }
const sigma = (u: number, t: number) => Math.exp(u) / (Math.exp(u) + (1 / t - 1))

describe('Krea 2 with a reference: the shift stops growing at 2560x1440', () => {
  it('the uncapped 4K schedule is the broken one', () => {
    expect(sigma(mu(3840, 2160), 1 / 8)).toBeGreaterThan(0.98)
    expect(sigma(mu(2560, 1440), 1 / 8)).toBeLessThan(0.75)
  })
  it('sizes up to 2560x1440 are unchanged', () => {
    for (const [width, height] of [[1024, 1024], [1920, 1080], [2560, 1440]]) {
      expect(krea2ShiftCanvas(width, height)).toEqual({ width, height })
    }
  })
  it('4K gets the shift of 2560x1440', () => {
    expect(krea2ShiftCanvas(3840, 2160)).toEqual({ width: 2560, height: 1440 })
  })
  it('any large shape stays under the cap, on the step of 8, in its proportions', () => {
    for (const [w, h] of [[2160, 3840], [4096, 4096], [5000, 1000], [3000, 2000]]) {
      const c = krea2ShiftCanvas(w, h)
      expect(c.width * c.height).toBeLessThanOrEqual(2560 * 1440)
      expect(c.width % 8).toBe(0)
      expect(c.height % 8).toBe(0)
      expect(Math.abs(c.width / c.height - w / h) / (w / h)).toBeLessThan(0.02)
    }
  })
})
