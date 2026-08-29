/**
 * Runde 4, Nebenbefund N1 of the D1 counter-check (Windows build 2026-08-29):
 * `image_generate` with an empty `model` argument ignored the model chosen in
 * the Create tab. The ComfyUI side is fixed in api/model-pick.ts; this covers
 * the macOS MLX side, which had the same shape (sd-turbo, then whatever was
 * installed first, and the user's choice nowhere in the chain).
 *
 * Run: npx vitest run src/lib/__tests__/mlx-model-match.test.ts
 */
import { describe, it, expect } from 'vitest'
import { defaultMlxImageModel, resolveMlxModel } from '../mlx-model-match'

const INSTALLED = [
  { id: 'flux-schnell', name: 'FLUX Schnell' },
  { id: 'sd-turbo', name: 'SD Turbo' },
  { id: 'sdxl-turbo', name: 'SDXL Turbo' },
]

describe('defaultMlxImageModel', () => {
  it('uses the Create tab selection by id', () => {
    expect(defaultMlxImageModel(INSTALLED, 'sdxl-turbo')?.id).toBe('sdxl-turbo')
  })

  it('uses the Create tab selection by display name', () => {
    expect(defaultMlxImageModel(INSTALLED, 'FLUX Schnell')?.id).toBe('flux-schnell')
  })

  it('beats the sd-turbo default', () => {
    expect(defaultMlxImageModel(INSTALLED, 'flux-schnell')?.id).toBe('flux-schnell')
  })

  // ── Negative controls: the old automation has to survive untouched. ──
  it('negative control: no Create selection keeps the sd-turbo default', () => {
    expect(defaultMlxImageModel(INSTALLED, '')?.id).toBe('sd-turbo')
    expect(defaultMlxImageModel(INSTALLED, null)?.id).toBe('sd-turbo')
    expect(defaultMlxImageModel(INSTALLED, undefined)?.id).toBe('sd-turbo')
  })

  it('negative control: a Create selection nothing matches keeps the default', () => {
    expect(defaultMlxImageModel(INSTALLED, 'qqqq')?.id).toBe('sd-turbo')
  })

  it('negative control: without sd-turbo the first installed model still answers', () => {
    const noTurbo = [{ id: 'flux-schnell', name: 'FLUX Schnell' }]
    expect(defaultMlxImageModel(noTurbo, 'qqqq')?.id).toBe('flux-schnell')
  })

  it('negative control: an empty install yields nothing', () => {
    expect(defaultMlxImageModel([], 'sd-turbo')).toBeUndefined()
  })
})

describe('resolveMlxModel keeps its tolerant matching after the move', () => {
  it('matches on a normalized id', () => {
    expect(resolveMlxModel('SD_Turbo', INSTALLED)?.id).toBe('sd-turbo')
  })

  it('matches a substring of a display name', () => {
    expect(resolveMlxModel('schnell', INSTALLED)?.id).toBe('flux-schnell')
  })

  it('negative control: no match and empty input return null', () => {
    expect(resolveMlxModel('midjourney', INSTALLED)).toBeNull()
    expect(resolveMlxModel(undefined, INSTALLED)).toBeNull()
    expect(resolveMlxModel('sd-turbo', [])).toBeNull()
  })
})
