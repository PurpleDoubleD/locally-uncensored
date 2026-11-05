// @vitest-environment jsdom
/**
 * "Transparent background" (02.10.2026): der Schalter in den Bild-Einstellungen,
 * nur fuer lokales Qwen-Image 2.1, und das Karomuster fuer das Ergebnis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const host = vi.hoisted(() => ({ mlx: false }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => host.mlx }))
vi.mock('../../../../api/comfyui', () => ({
  classifyModel: (n: string) => (/qwen_image_2\.1/.test(n) ? 'qwenimage' : 'sdxl'),
  // B18: the video length controls ask for the card size.
  getSystemVRAM: async () => null,
  isI2VModel: () => false,
  isT2VCapable: () => true,
  getImageUrl: (f: string) => `http://127.0.0.1:8188/view?filename=${f}`,
}))
vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
  }),
}))

import { ParamGroups } from '../ParamGroups'
import { ResultView } from '../OutputView'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'

const QWEN = 'qwen_image_2.1_int8_convrot.safetensors'
const SDXL = 'sdxl_base.safetensors'

function setup(model: string, type: string, extra: Record<string, unknown> = {}) {
  useCreateStore.setState({
    backend: 'local', isGenerating: false, transparentBackground: false,
    imageModel: model, imageModelList: [{ name: model, type }], cloudOp: null, utilityOp: null, removebg: false,
    ...extra,
  } as never)
  useCreateStore.getState().setMode('image')
}

beforeEach(() => { host.mlx = false })
afterEach(() => { cleanup() })

describe('Schalter Transparent background', () => {
  it('steht bei lokalem Qwen-Image 2.1 und ist standardmaessig aus', () => {
    setup(QWEN, 'qwenimage')
    render(<ParamGroups />)
    const sw = screen.getByRole('switch', { name: /transparent background/i })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText(/see-through background/i)).toBeTruthy()
  })

  it('schaltet sich um und wird gemerkt', () => {
    setup(QWEN, 'qwenimage')
    render(<ParamGroups />)
    fireEvent.click(screen.getByRole('switch', { name: /transparent background/i }))
    expect(useCreateStore.getState().transparentBackground).toBe(true)
    expect(screen.getByRole('switch', { name: /transparent background/i }).getAttribute('aria-checked')).toBe('true')
  })

  it('fehlt bei jedem anderen Modell', () => {
    setup(SDXL, 'sdxl')
    render(<ParamGroups />)
    expect(screen.queryByText('Transparent background')).toBeNull()
  })

  it('fehlt in der Cloud und bei Video', () => {
    setup(QWEN, 'qwenimage', { backend: 'cloud' })
    const { unmount } = render(<ParamGroups />)
    expect(screen.queryByText('Transparent background')).toBeNull()
    unmount()
    setup(QWEN, 'qwenimage')
    useCreateStore.getState().setMode('video')
    const v = render(<ParamGroups />)
    expect(screen.queryByText('Transparent background')).toBeNull()
    v.unmount()
  })

  it('steht auch auf dem Mac, bei Qwen-Image 2.1 und bei keinem anderen Modell', () => {
    // 08.10.2026: die zweite Bild-Engine des Mac behaelt den Alphakanal, der
    // Schalter ist derselbe Prompt-Rahmen wie unter Windows.
    host.mlx = true
    setup('MLX Qwen-Image 2.1 8-bit', 'qwenimage')
    const q = render(<ParamGroups />)
    expect(screen.getByRole('switch', { name: /transparent background/i })).toBeTruthy()
    q.unmount()
    setup('MLX SD Turbo', 'sd15')
    render(<ParamGroups />)
    expect(screen.queryByText('Transparent background')).toBeNull()
  })

  it('fehlt beim Bearbeiten', () => {
    setup(QWEN, 'qwenimage')
    useCreateStore.getState().setIntent('edit')
    render(<ParamGroups />)
    expect(screen.queryByText('Transparent background')).toBeNull()
  })
})

const ITEM = (extra: Partial<GalleryItem>): GalleryItem => ({
  id: 'a', type: 'image', filename: 'lu_00001_.png', subfolder: '', prompt: 'a red apple', negativePrompt: '',
  model: QWEN, modelType: 'qwenimage', seed: 1, steps: 25, cfgScale: 1, sampler: 'euler', scheduler: 'simple',
  width: 1024, height: 1024, batchSize: 1, createdAt: 1, ...extra,
})

describe('Vorschau: Schachbrett', () => {
  it('ein transparentes Bild liegt auf dem Karomuster, ein gewoehnliches nicht', () => {
    const t = render(<ResultView item={ITEM({ transparent: true })} onFullscreen={() => {}} />)
    expect(t.container.querySelector('img')?.className).toContain('lu-checker')
    t.unmount()
    const p = render(<ResultView item={ITEM({})} onFullscreen={() => {}} />)
    expect(p.container.querySelector('img')?.className).not.toContain('lu-checker')
  })

  it('der Ausschnitt aus Remove Background behaelt sein Karomuster', () => {
    const r = render(<ResultView item={ITEM({ intent: 'removebg' })} onFullscreen={() => {}} />)
    expect(r.container.querySelector('img')?.className).toContain('lu-checker')
  })
})

