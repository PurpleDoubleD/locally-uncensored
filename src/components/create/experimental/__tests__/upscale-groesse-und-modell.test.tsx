// @vitest-environment jsdom
/**
 * 3.1.0, Discord 08.11.: "Enhance only does x2 and x4, no
 * advanced settings". Local Enhance on ComfyUI now takes any factor from 1x
 * to 8x or a target long side, and the upscale model from
 * models/upscale_models. The real run is in useCreate-local-upscale.test.ts.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/upscale-groesse-und-modell.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), quota: null,
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
    connected: true, modelsLoaded: true, modelLoadError: null, mlxMissing: null,
    installCapability: vi.fn(), installModelBundle: vi.fn(),
  }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false }))

import { Composer } from '../Composer'
import { useCreateStore } from '../../../../stores/createStore'
import { buildUpscaleWorkflow } from '../../../../api/dynamic-workflow'
import {
  normalizeUpscaleLongSide, pickUpscaleModel, upscaleFactorFor, upscaleSizeLabel, upscaleTooLargeLine,
} from '../../../../lib/local-upscale'

const X4 = 'RealESRGAN_x4plus.safetensors'
const X2 = '2x-AnimeSharp.pth'
const composer = () => render(<Composer onOpenAdvanced={() => {}} onOpenWorkflows={() => {}} />)
const openSize = () => fireEvent.click(screen.getByRole('button', { name: 'Upscale size' }))
const st = () => useCreateStore.getState()

beforeEach(() => {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, error: null, gallery: [], source: null,
    upscaleFactor: 2, upscaleLongSide: null, upscaleModelPick: null, upscaleModelList: [X4],
  } as never)
  st().setIntent('upscale')
})
afterEach(cleanup)

describe('the size menu', () => {
  it('lists factors and long sides, not only 2x and 4x', () => {
    composer()
    openSize()
    const rows = screen.getAllByRole('option').map((o) => o.textContent)
    for (const want of ['1.5x', '2x', '3x', '4x', 'Other factor…', '2048 px (2K)', '3840 px (4K)', '7680 px (8K)', 'Other long side…']) {
      expect(rows.some((r) => r?.startsWith(want))).toBe(true)
    }
  })

  it('3x and a long side are kept, a long side replaces the factor and back', () => {
    composer()
    openSize()
    fireEvent.click(screen.getByRole('option', { name: /^3x/ }))
    expect(st().upscaleFactor).toBe(3)
    openSize()
    fireEvent.click(screen.getByRole('option', { name: /^3840 px/ }))
    expect(st().upscaleLongSide).toBe(3840)
    expect(screen.getByRole('button', { name: 'Upscale size' }).textContent).toContain('3840 px')
    openSize()
    fireEvent.click(screen.getByRole('option', { name: /^2x/ }))
    expect([st().upscaleFactor, st().upscaleLongSide]).toEqual([2, null])
  })

  it('another factor is typed, and kept inside 1x to 8x', () => {
    composer()
    openSize()
    fireEvent.click(screen.getByRole('option', { name: 'Other factor…' }))
    const field = screen.getByRole('textbox', { name: 'Upscale factor' })
    fireEvent.change(field, { target: { value: '2,5' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(st().upscaleFactor).toBe(2.5)
    expect(screen.getByRole('button', { name: 'Upscale size' }).textContent).toContain('2.5x')
    fireEvent.change(screen.getByRole('textbox', { name: 'Upscale factor' }), { target: { value: '12' } })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Upscale factor' }))
    expect(st().upscaleFactor).toBe(8)
  })

  it('another long side is typed in pixels', () => {
    composer()
    openSize()
    fireEvent.click(screen.getByRole('option', { name: 'Other long side…' }))
    const field = screen.getByRole('textbox', { name: 'Upscale long side' })
    fireEvent.change(field, { target: { value: '5000' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(st().upscaleLongSide).toBe(5000)
  })
})

describe('the model menu', () => {
  it('only one model: no menu, it is simply used', () => {
    composer()
    expect(screen.queryByRole('button', { name: 'Upscale model' })).toBeNull()
  })

  it('several: Auto names what it takes, a pick is saved, Auto clears it', () => {
    useCreateStore.setState({ upscaleModelList: [X4, X2] } as never)
    composer()
    const menu = () => screen.getByRole('button', { name: 'Upscale model' })
    expect(menu().textContent).toContain('Auto: RealESRGAN_x4plus')
    fireEvent.click(menu())
    fireEvent.click(screen.getByRole('option', { name: /^2x-AnimeSharp/ }))
    expect(st().upscaleModelPick).toBe(X2)
    fireEvent.click(menu())
    fireEvent.click(screen.getByRole('option', { name: /^Auto/ }))
    expect(st().upscaleModelPick).toBeNull()
  })
})

describe('the rules', () => {
  it('a long side becomes the factor of this picture, exactly', () => {
    expect(upscaleFactorFor(1920, 1080, 2, 3840)).toBe(2)
    expect(upscaleFactorFor(640, 480, 2, 1920)).toBe(3)
    expect(upscaleFactorFor(640, 480, 2.5, null)).toBe(2.5)
    expect([upscaleSizeLabel(1.5, null), upscaleSizeLabel(2, 3840)]).toEqual(['1.5x', '3840 px'])
    expect([normalizeUpscaleLongSide(9000), normalizeUpscaleLongSide(10), normalizeUpscaleLongSide('x')]).toEqual([8192, 256, null])
  })

  it('a long side that does not enlarge is refused; the same size is allowed (a 1x restoration model)', () => {
    expect(upscaleTooLargeLine(4000, 3000, 3840 / 4000, '3840 px')).toMatch(/already 4000×3000, larger than 3840 px/)
    expect(upscaleTooLargeLine(4000, 3000, 1, '4000 px')).toBeNull()
  })

  it('a picked model counts only while ComfyUI still lists it', () => {
    expect(pickUpscaleModel([X4, X2], X2)).toBe(X2)
    expect(pickUpscaleModel([X4], X2)).toBe(X4)
  })

  it('past the model scale the rest is a resize: 8x on a 4x model, 1.5x on a 2x model', () => {
    const methods = ['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos']
    const nodes = (m: string) => ({
      LoadImage: {}, ImageUpscaleWithModel: {}, SaveImage: {},
      UpscaleModelLoader: { input: { required: { model_name: [[m]] } } },
      ImageScaleBy: { input: { required: { upscale_method: [methods] } } },
      ImageScale: { input: { required: { upscale_method: [methods] } } },
    })
    const scaleOf = (model: string, factor: number) => {
      const g = buildUpscaleWorkflow({ image: 'p.png', model, factor, sourceWidth: 640, sourceHeight: 480 }, nodes(model))
      const n = Object.values(g).find((x) => x.class_type === 'ImageScaleBy')
      return [n?.inputs.scale_by, n?.inputs.upscale_method]
    }
    expect(scaleOf(X4, 8)).toEqual([2, 'lanczos'])
    expect(scaleOf(X2, 1.5)).toEqual([0.75, 'area'])
  })
})
