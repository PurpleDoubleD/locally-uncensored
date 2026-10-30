// @vitest-environment jsdom
/**
 * B40 (3.0.9, Discord boromirofgeo 29.10.2026): the gallery and the large view
 * say which LoRAs a picture was made with, and at what strength. The entry
 * carries them since this change (GalleryItem.loras, written by the local
 * runs through ranLoras).
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/galerie-zeigt-die-loras.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ quota: null, enhanceVideo: vi.fn() }),
}))
vi.mock('../useComfyMedia', () => ({
  useComfyMedia: () => ({ src: 'blob:media', onError: vi.fn() }),
}))

import type { GalleryItem } from '../../../../stores/createStore'
import { Lightbox } from '../Lightbox'
import { ranLoras, runSettings, runSettingsText } from '../../../../lib/render/run-settings'

afterEach(() => { cleanup() })

const ITEM = (extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id: 'a', type: 'image', filename: '', subfolder: '', prompt: 'a red fox in the snow',
  negativePrompt: '', model: 'sd_xl_base_1.0.safetensors', modelType: 'sdxl',
  seed: 4242, steps: 25, cfgScale: 7, sampler: 'dpmpp_2m', scheduler: 'karras',
  width: 1024, height: 768, batchSize: 1, createdAt: 1, intent: 'image', ...extra,
})
const LORAS = [{ name: 'styles/film_grain.safetensors', strength: 0.55 }, { name: 'detail_tweaker_xl.safetensors', strength: 1.2 }]

describe('B40: the LoRAs of a picture', () => {
  it('stand right under the model, each with its strength', () => {
    expect(runSettings(ITEM({ loras: LORAS })).slice(0, 3)).toEqual([
      { label: 'Model', value: 'sd xl base 1.0' },
      { label: 'LoRA', value: 'film grain · 0.55' },
      { label: 'LoRA', value: 'detail tweaker xl · 1.2' },
    ])
  })

  it('go into the copied text too', () => {
    expect(runSettingsText(ITEM({ loras: LORAS }))).toContain('LoRA: film grain · 0.55\nLoRA: detail tweaker xl · 1.2')
  })

  it('the large view lists both', () => {
    render(<Lightbox item={ITEM({ loras: LORAS })} onClose={() => {}} />)
    const text = screen.getByTestId('run-settings').textContent ?? ''
    expect(text).toContain('film grain · 0.55')
    expect(text).toContain('detail tweaker xl · 1.2')
  })

  it('an entry without LoRAs, and a tool, list none', () => {
    expect(runSettings(ITEM()).some((s) => s.label === 'LoRA')).toBe(false)
    expect(runSettings(ITEM({ intent: 'upscale', loras: LORAS })).some((s) => s.label === 'LoRA')).toBe(false)
  })

  it('ranLoras writes the field only when LoRAs ran', () => {
    expect(ranLoras([])).toEqual({})
    expect(ranLoras(LORAS)).toEqual({ loras: LORAS })
  })
})
