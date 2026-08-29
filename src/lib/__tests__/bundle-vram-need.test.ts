import { describe, it, expect } from 'vitest'
import { bundleVramNeedGb } from '../hardware'
import { getImageBundles, getVideoBundles } from '../../api/discover'

// Counter-check on the Windows box, 2026-08-29, 12 GB card: "SDXL VAE
// (fp16-fix) · addon" (0.33 GB) and "Pixel Art XL · SDXL LoRA" (0.17 GB) both
// carried the red dot and the label "Too big for your GPU". Their requirement
// string is "any", the old parser found no digit in it and answered 99 GB.
//
// The tile's own verdict is `!vram ? unknown : need <= vram ? fits : need <=
// vram + 2 ? tight : big`, so these cases pin the number that verdict reads.

const fitOnGpu = (needGb: number, vramGb: number) =>
  needGb <= vramGb ? 'fits' : needGb <= vramGb + 2 ? 'tight' : 'big'

describe('bundleVramNeedGb — what a bundle really asks of the GPU', () => {
  it('reads the upper bound of a range', () => {
    expect(bundleVramNeedGb({ vramRequired: '6-8 GB', totalSizeGB: 2.8 })).toBe(8)
    expect(bundleVramNeedGb({ vramRequired: '10-12 GB', totalSizeGB: 14 })).toBe(12)
  })

  it('reads a plus as two GB more than the number', () => {
    expect(bundleVramNeedGb({ vramRequired: '12+ GB', totalSizeGB: 16.6 })).toBe(14)
    expect(bundleVramNeedGb({ vramRequired: '24+ GB', totalSizeGB: 40 })).toBe(26)
  })

  it('reads a plain number, prose around it included', () => {
    expect(bundleVramNeedGb({ vramRequired: '24 GB', totalSizeGB: 24 })).toBe(24)
    expect(bundleVramNeedGb({ vramRequired: '16 GB best, offloads on less', totalSizeGB: 20 })).toBe(16)
  })

  it('"any" falls back to the download size, not to a made up ceiling', () => {
    expect(bundleVramNeedGb({ vramRequired: 'any', totalSizeGB: 0.33 })).toBe(0.33)
    expect(bundleVramNeedGb({ vramRequired: 'any', totalSizeGB: 0.17 })).toBe(0.17)
  })

  it('a missing requirement and a missing size still yield a number', () => {
    expect(bundleVramNeedGb({})).toBe(0)
    expect(bundleVramNeedGb({ vramRequired: '' })).toBe(0)
  })

  it('the two add-ons stop reading "Too big for your GPU" on a 12 GB card', () => {
    const image = getImageBundles()
    const vae = image.find(b => b.name === 'SDXL VAE (fp16-fix) · addon')!
    const lora = image.find(b => b.name === 'Pixel Art XL · SDXL LoRA')!
    expect(vae).toBeTruthy()
    expect(lora).toBeTruthy()
    expect(fitOnGpu(bundleVramNeedGb(vae), 12)).toBe('fits')
    expect(fitOnGpu(bundleVramNeedGb(lora), 12)).toBe('fits')
    // And on the smallest card we ship hints for.
    expect(fitOnGpu(bundleVramNeedGb(vae), 4)).toBe('fits')
    expect(fitOnGpu(bundleVramNeedGb(lora), 4)).toBe('fits')
  })

  it('a genuinely huge bundle still reads big on a 12 GB card', () => {
    const all = [...getImageBundles(), ...getVideoBundles()]
    const heavy = all.find(b => b.vramRequired.includes('24'))!
    expect(heavy).toBeTruthy()
    expect(fitOnGpu(bundleVramNeedGb(heavy), 12)).toBe('big')
  })

  it('no catalogue bundle answers with the old 99 GB placeholder', () => {
    for (const b of [...getImageBundles(), ...getVideoBundles()]) {
      expect(bundleVramNeedGb(b), b.name).toBeLessThan(99)
    }
  })
})
