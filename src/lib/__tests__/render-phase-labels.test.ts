/**
 * R16 Befund 3, measured on the Windows box (2026-08-30, 12 GB GPU, 16 GB RAM,
 * z_image_bf16 at 11.46 GB), five image runs: a STILL IMAGE was told "Decoding
 * frames, the last long stretch...". It has no frames, and that section ran
 * 2.5 s to 3.7 s, the shortest of the whole render, not the longest.
 *
 * Run: npx vitest run src/lib/__tests__/render-phase-labels.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { phaseForExecutingNode } from '../render-phase-labels'

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

describe('the Create tab uses this module and holds no labels of its own', () => {
  it('useCreate asks for the phase instead of writing one', () => {
    const src = read('src/hooks/useCreate.ts')
    expect(src).toMatch(/import \{ phaseForExecutingNode, phaseForProgressStep \} from '\.\.\/lib\/render-phase-labels'/)
    expect(src).toMatch(/phaseForExecutingNode\(classType, mode === 'video' \? 'video' : 'image'\)/)
    expect(src).toMatch(/phaseForProgressStep\(value, max, st\.progressPhase\)/)
  })

  it('NEGATIVE: the wrong line is gone from the hook', () => {
    const src = read('src/hooks/useCreate.ts')
    expect(src).not.toContain('Decoding frames, the last long stretch')
  })
})
