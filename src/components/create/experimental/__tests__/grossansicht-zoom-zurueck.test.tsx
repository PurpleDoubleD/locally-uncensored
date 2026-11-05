// @vitest-environment jsdom
/**
 * Discord #bug-reports 01.11.2026 (3.0.8, Windows): zoomed into a picture of
 * the large view and back out, the picture stayed shifted to the left, to its
 * right the last pixel column was smeared over the whole width in vertical
 * stripes, and the app showed through underneath.
 *
 * The zoom state itself comes back clean (scale 1, no pan, centred origin;
 * measured in Chromium and WebKit with wheel and trackpad). What stayed on
 * screen was the picture's composited layer from the zoom, which WebView2 did
 * not paint again. So the picture now gets a fresh element whenever the zoom
 * is back at 1, and the large view has an opaque backdrop: a stale layer, if
 * one is left, never lets the app show through.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/grossansicht-zoom-zurueck.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ quota: null, enhanceVideo: vi.fn() }),
}))
vi.mock('../useComfyMedia', () => ({
  useComfyMedia: () => ({ src: 'blob:media', onError: vi.fn(), onLoad: vi.fn() }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))

import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { Lightbox } from '../Lightbox'

const ITEM = (id: string): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: `prompt ${id}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 1536, height: 2304, batchSize: 1, createdAt: 1,
})

beforeEach(() => {
  useCreateStore.setState({ backend: 'local', gallery: [ITEM('a')], galleryFolders: [], galleryFolderOpen: null })
})
afterEach(() => { cleanup() })

function Viewer() {
  const [item, setItem] = useState<GalleryItem | null>(useCreateStore.getState().gallery[0])
  return <Lightbox item={item} onClose={() => setItem(null)} onNavigate={setItem} />
}
const img = () => screen.getByTestId('lightbox-image') as HTMLImageElement
const wheel = (dy: number, n: number) => { for (let i = 0; i < n; i++) fireEvent.wheel(img(), { deltaY: dy }) }

describe('zoom in and back out in the large view', () => {
  it('back at 1 the picture is centred, without pan, on a fresh element', () => {
    render(<Viewer />)
    const before = img()
    wheel(-100, 12)
    expect(img().dataset.zoom).toBe('5')
    fireEvent.mouseDown(img(), { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseMove(window, { clientX: 60, clientY: 40 })
    fireEvent.mouseUp(window)
    wheel(100, 12)
    expect(img().dataset.zoom).toBe('1')
    expect(img().dataset.pan).toBe('0,0')
    // A new element: the zoomed layer is not carried back to scale 1.
    expect(img()).not.toBe(before)
  })

  it('the same after a double-click back to the fitted size', () => {
    render(<Viewer />)
    wheel(-100, 3)
    const zoomed = img()
    fireEvent.doubleClick(img())
    expect(img().dataset.zoom).toBe('1')
    expect(img()).not.toBe(zoomed)
  })

  it('zooming in keeps the element (no flicker while zooming)', () => {
    render(<Viewer />)
    const before = img()
    wheel(-100, 3)
    expect(img()).toBe(before)
  })

  it('the large view has an opaque backdrop, the app never shows through', () => {
    render(<Viewer />)
    const backdrop = img().closest('.fixed.inset-0') as HTMLElement
    const classes = backdrop.className.split(/\s+/)
    expect(classes).toContain('bg-black')
    expect(classes.some((c) => /^bg-black\/\d+$/.test(c))).toBe(false)
  })
})
