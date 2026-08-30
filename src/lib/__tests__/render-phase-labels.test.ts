/**
 * R16 Befund 3 und 4, measured on the Windows box (2026-08-30, 12 GB GPU,
 * 16 GB RAM, z_image_bf16 at 11.46 GB), five image runs:
 *
 *   - Befund 3: a STILL IMAGE was told "Decoding frames, the last long
 *     stretch...". It has no frames, and that section ran 2.5 s to 3.7 s,
 *     the shortest of the whole render, not the longest.
 *
 *   - Befund 4: "Sampling..." stood on screen from +34 s while the first real
 *     sampling step arrived at +74 s. The label hung on ComfyUI entering the
 *     KSampler node, which is where it moves the weights into memory, not on
 *     sampling.
 *
 * Run: npx vitest run src/lib/__tests__/render-phase-labels.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { phaseForExecutingNode, phaseForProgressStep } from '../render-phase-labels'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')

describe('the decode phase (Befund 3)', () => {
  it('an image decodes an image, not frames', () => {
    const step = phaseForExecutingNode('VAEDecode', 'image')
    expect(step).toEqual({ phase: 'decoding', pct: 90, label: 'Decoding image...' })
    expect(phaseForExecutingNode('VAEDecodeTiled', 'image')?.label).toBe('Decoding image...')
  })

  it('a video still decodes frames, because a video has them', () => {
    expect(phaseForExecutingNode('VAEDecode', 'video')?.label).toBe('Decoding frames...')
  })

  it('NEGATIVE: no lane claims this is the long stretch', () => {
    // Never measured, and measured false for image: 2.5 s to 3.7 s, the
    // shortest section of all five runs.
    for (const mode of ['image', 'video'] as const) {
      const label = phaseForExecutingNode('VAEDecode', mode)!.label
      expect(label).not.toMatch(/long|longest|last|slow|almost there/i)
    }
  })

  it('NEGATIVE: an image is never told about frames', () => {
    expect(phaseForExecutingNode('VAEDecode', 'image')!.label).not.toMatch(/frame/i)
  })
})

describe('the sampling claim (Befund 4)', () => {
  it('entering the sampler is called a load, because that is what runs there', () => {
    const step = phaseForExecutingNode('KSampler', 'image')
    expect(step).toEqual({ phase: 'loading-model', pct: 32, label: 'Loading model...' })
    // Every sampler ComfyUI reports, not just the plain one.
    for (const n of ['KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']) {
      expect(phaseForExecutingNode(n, 'image')!.phase).toBe('loading-model')
    }
  })

  it('NEGATIVE: nothing says sampling before a step has been reported', () => {
    // The 40 s lie. Entering the node is not sampling in it.
    for (const n of ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']) {
      for (const mode of ['image', 'video'] as const) {
        expect(phaseForExecutingNode(n, mode)!.label).not.toMatch(/sampl/i)
        expect(phaseForExecutingNode(n, mode)!.phase).not.toBe('sampling')
      }
    }
  })

  it('the first reported step is what turns the phase into sampling', () => {
    const step = phaseForProgressStep(1, 20, 'loading-model')
    expect(step).toEqual({ phase: 'sampling', pct: 38, label: 'Sampling step 1/20...' })
    expect(phaseForProgressStep(20, 20, 'sampling')).toEqual({
      phase: 'sampling', pct: 90, label: 'Sampling step 20/20...',
    })
  })

  it('NEGATIVE: a decode that reports steps does not walk the render back into sampling', () => {
    // A tiled VAE decode reports progress too. Repainting the label there
    // would put "Sampling step 3/8" over a render that is already writing
    // the picture out.
    expect(phaseForProgressStep(3, 8, 'decoding')).toBeNull()
  })

  it('NEGATIVE: a broken step count changes nothing', () => {
    expect(phaseForProgressStep(1, 0, 'queued')).toBeNull()
    expect(phaseForProgressStep(Number.NaN, 20, 'queued')).toBeNull()
  })

  it('the load phases keep their own words', () => {
    expect(phaseForExecutingNode('UNETLoader', 'image')!.label).toBe('Loading model...')
    expect(phaseForExecutingNode('DualCLIPLoader', 'image')!.label).toBe('Loading text encoder...')
    expect(phaseForExecutingNode('VAELoader', 'image')!.label).toBe('Loading VAE...')
    // A node with nothing to say leaves the label where it was.
    expect(phaseForExecutingNode('CLIPTextEncode', 'image')).toBeNull()
    expect(phaseForExecutingNode('SaveImage', 'image')).toBeNull()
  })
})

describe('the Create tab uses this module and holds no labels of its own', () => {
  it('useCreate asks for the phase instead of writing one', () => {
    const src = read('src/hooks/useCreate.ts')
    expect(src).toMatch(/import \{ phaseForExecutingNode, phaseForProgressStep \} from '\.\.\/lib\/render-phase-labels'/)
    expect(src).toMatch(/phaseForExecutingNode\(classType, mode === 'video' \? 'video' : 'image'\)/)
    expect(src).toMatch(/phaseForProgressStep\(value, max, st\.progressPhase\)/)
  })

  it('NEGATIVE: the two wrong lines are gone from the hook', () => {
    const src = read('src/hooks/useCreate.ts')
    expect(src).not.toContain('Decoding frames, the last long stretch')
    expect(src).not.toContain("setPhase(35, 'Sampling...')")
  })
})
