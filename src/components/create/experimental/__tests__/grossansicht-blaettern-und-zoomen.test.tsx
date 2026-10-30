// @vitest-environment jsdom
/**
 * Discord (Forum "Ability to sort gallery in more detail",
 * 20.10.2026): in Edit oeffnet ein Bild aus der Galerie die Grossansicht, und
 * dort stand der Prompt aufgeklappt, in Create unter der Buehne zugeklappt.
 * Jetzt ist er in beiden zu. Dazu aus derselben Rueckmeldung: mit den Pfeilen
 * (auf dem Schirm und auf der Tastatur) durch die Galerie blaettern, in der
 * Reihenfolge des Panels, und ein Bild mit dem Mausrad vergroessern.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/grossansicht-blaettern-und-zoomen.test.tsx
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
import { Lightbox, galleryNeighbor } from '../Lightbox'

const ITEM = (id: string, extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: `prompt ${id}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 512, height: 512, batchSize: 1, createdAt: 1, intent: 'edit', ...extra,
})

beforeEach(() => {
  useCreateStore.setState({
    backend: 'local',
    gallery: [ITEM('a', { folderId: 'f-1' }), ITEM('b'), ITEM('c', { folderId: 'f-1' })],
    galleryFolders: [{ id: 'f-1', name: 'Portraits' }],
    galleryFolderOpen: null,
  })
})
afterEach(() => { cleanup() })

function Viewer({ start }: { start: string }) {
  const [item, setItem] = useState<GalleryItem | null>(useCreateStore.getState().gallery.find((g) => g.id === start) ?? null)
  return <Lightbox item={item} onClose={() => setItem(null)} onNavigate={setItem} />
}
const shownPrompt = () => (screen.getByTestId('lightbox-image') as HTMLImageElement).alt

describe('die Grossansicht aus der Galerie', () => {
  it('oeffnet mit zugeklapptem Prompt, auch fuer ein Bild aus Edit', () => {
    render(<Viewer start="a" />)
    expect((screen.getByTestId('prompt-details') as HTMLDetailsElement).open).toBe(false)
  })

  it('blaettert mit den Pfeilen auf dem Schirm, ohne Pfeil vor dem ersten und nach dem letzten', () => {
    render(<Viewer start="a" />)
    expect(screen.queryByTestId('lightbox-prev')).toBeNull()
    fireEvent.click(screen.getByTestId('lightbox-next'))
    expect(shownPrompt()).toBe('prompt b')
    fireEvent.click(screen.getByTestId('lightbox-next'))
    expect(shownPrompt()).toBe('prompt c')
    expect(screen.queryByTestId('lightbox-next')).toBeNull()
    fireEvent.click(screen.getByTestId('lightbox-prev'))
    expect(shownPrompt()).toBe('prompt b')
  })

  it('blaettert mit den Pfeiltasten', () => {
    render(<Viewer start="b" />)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(shownPrompt()).toBe('prompt c')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(shownPrompt()).toBe('prompt a')
    // Am Anfang bleibt es beim ersten.
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(shownPrompt()).toBe('prompt a')
  })

  it('folgt dem offenen Ordner des Panels', () => {
    useCreateStore.setState({ galleryFolderOpen: 'f-1' })
    render(<Viewer start="a" />)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(shownPrompt()).toBe('prompt c')
  })

  it('ohne onNavigate gibt es keine Pfeile, wie bisher', () => {
    render(<Lightbox item={ITEM('a')} onClose={() => {}} />)
    expect(screen.queryByTestId('lightbox-prev')).toBeNull()
    expect(screen.queryByTestId('lightbox-next')).toBeNull()
  })

  it('vergroessert mit dem Mausrad, hoechstens fuenffach, und ein Doppelklick setzt zurueck', () => {
    render(<Viewer start="a" />)
    const img = () => screen.getByTestId('lightbox-image') as HTMLImageElement
    expect(img().dataset.zoom).toBe('1')
    fireEvent.wheel(img(), { deltaY: -100 })
    expect(Number(img().dataset.zoom)).toBeCloseTo(1.2)
    for (let i = 0; i < 20; i++) fireEvent.wheel(img(), { deltaY: -100 })
    expect(Number(img().dataset.zoom)).toBe(5)
    fireEvent.doubleClick(img())
    expect(img().dataset.zoom).toBe('1')
    // Ein anderes Bild beginnt ungezoomt.
    fireEvent.wheel(img(), { deltaY: -100 })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(img().dataset.zoom).toBe('1')
  })
})

describe('B47: ein gezoomtes Bild mit gedrueckter Maustaste verschieben', () => {
  const box = (el: HTMLElement, scale: number) => {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400 * scale, height: 300 * scale, right: 400 * scale, bottom: 300 * scale, x: 0, y: 0, toJSON: () => ({}) })
  }

  it('verschiebt erst nach dem Zoomen, folgt der Maus auch ausserhalb, und das Loslassen dort schliesst nichts', () => {
    const onClose = vi.fn()
    useCreateStore.setState({ gallery: [ITEM('a')] })
    render(<Lightbox item={ITEM('a')} onClose={onClose} />)
    const img = () => screen.getByTestId('lightbox-image') as HTMLImageElement
    box(img(), 1)
    // Ungezoomt bewegt ein Ziehen nichts.
    fireEvent.mouseDown(img(), { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 160, clientY: 130 })
    fireEvent.mouseUp(window)
    expect(img().dataset.pan).toBe('0,0')

    fireEvent.wheel(img(), { deltaY: -100 })
    fireEvent.wheel(img(), { deltaY: -100 })
    const scale = Number(img().dataset.zoom)
    expect(scale).toBeCloseTo(1.44)
    box(img(), scale)
    fireEvent.mouseDown(img(), { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 160, clientY: 130 })
    expect(img().dataset.pan).toBe('60,30')
    // Weit ueber den Rand hinaus: es bleibt immer ein Teil des Bildes zu sehen.
    fireEvent.mouseMove(window, { clientX: 5000, clientY: -5000 })
    expect(img().dataset.pan).toBe(`${Math.round(400 * (scale - 1))},${-Math.round(300 * (scale - 1))}`)
    fireEvent.mouseUp(window)
    fireEvent.click(document.querySelector('.lu-on-dark') as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
    // Danach ist ein Klick daneben wieder ein Klick.
    fireEvent.click(document.querySelector('.lu-on-dark') as HTMLElement)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('ein Doppelklick und das Herauszoomen auf 1 setzen die Verschiebung zurueck', () => {
    useCreateStore.setState({ gallery: [ITEM('a')] })
    render(<Lightbox item={ITEM('a')} onClose={() => {}} />)
    const img = () => screen.getByTestId('lightbox-image') as HTMLImageElement
    fireEvent.wheel(img(), { deltaY: -100 })
    box(img(), 1.2)
    fireEvent.mouseDown(img(), { button: 0, clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 20, clientY: 10 })
    fireEvent.mouseUp(window)
    expect(img().dataset.pan).toBe('20,10')
    fireEvent.wheel(img(), { deltaY: 100 })
    expect(img().dataset.zoom).toBe('1')
    expect(img().dataset.pan).toBe('0,0')
    fireEvent.wheel(img(), { deltaY: -100 })
    expect(img().dataset.pan).toBe('0,0')
  })
})

describe('galleryNeighbor', () => {
  it('kennt die Enden und Eintraege ausserhalb des Ordners', () => {
    const all = useCreateStore.getState().gallery
    expect(galleryNeighbor(all, null, 'a', -1)).toBeNull()
    expect(galleryNeighbor(all, null, 'a', 1)?.id).toBe('b')
    expect(galleryNeighbor(all, 'f-1', 'b', 1)).toBeNull()
  })
})
