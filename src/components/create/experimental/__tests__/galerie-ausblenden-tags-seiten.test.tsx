// @vitest-environment jsdom
/**
 * The gallery panel in 3.1.0: no cap any more, so the tiles come in pages
 * (C27); entries can be hidden and shown again, and tagged and filtered by
 * tag (D27, promised on Discord 05.11.2026).
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/galerie-ausblenden-tags-seiten.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ quota: null, enhanceVideo: vi.fn() }),
}))
vi.mock('../useComfyMedia', () => ({
  useComfyMedia: () => ({ src: 'blob:media', onError: vi.fn(), onLoad: vi.fn() }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))

import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { CreatePanel, GALLERY_PAGE, emptyLine } from '../CreatePanel'

const ITEM = (n: number, extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id: `g${n}`, type: 'image', filename: `${n}.png`, subfolder: '', prompt: `prompt ${n}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 512, height: 512, batchSize: 1, createdAt: n, ...extra,
})

/** IntersectionObserver that the test fires by hand. */
const observers: { cb: IntersectionObserverCallback; el: Element | null }[] = []
class FakeIO {
  cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) { this.cb = cb }
  observe(el: Element) { observers.push({ cb: this.cb, el }) }
  disconnect() { for (let i = observers.length - 1; i >= 0; i--) if (observers[i].cb === this.cb) observers.splice(i, 1) }
  unobserve() {}
  takeRecords() { return [] }
}
const scrollToEnd = () => act(() => {
  for (const o of [...observers]) o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver)
})

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIO)
  observers.length = 0
  useCreateStore.setState({
    backend: 'local', gallery: [], galleryFolders: [], galleryFolderOpen: null, galleryTagOpen: null,
    galleryShowHidden: false, galleryNotice: null,
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const panel = () => render(<CreatePanel open onOpenChange={() => {}} activeId={null} onSelect={() => {}} />)
const tiles = () => document.querySelectorAll('[data-gallery-id]')

describe('pages instead of a cap', () => {
  it('1000 entries: the first page, then the next as the end scrolls into view', () => {
    useCreateStore.setState({ gallery: Array.from({ length: 1000 }, (_, i) => ITEM(1000 - i)) })
    panel()
    expect(tiles()).toHaveLength(GALLERY_PAGE)
    expect(screen.getByTestId('gallery-more').textContent).toBe(`${GALLERY_PAGE} of 1000`)
    scrollToEnd()
    expect(tiles()).toHaveLength(GALLERY_PAGE * 2)
    // The count in the header is the whole view, not the page.
    expect(screen.getByText('1000')).toBeTruthy()
  })

  it('a short list has no page line', () => {
    useCreateStore.setState({ gallery: [ITEM(2), ITEM(1)] })
    panel()
    expect(tiles()).toHaveLength(2)
    expect(screen.queryByTestId('gallery-more')).toBeNull()
  })
})

describe('hide and show again', () => {
  beforeEach(() => { useCreateStore.setState({ gallery: [ITEM(3), ITEM(2), ITEM(1)] }) })

  it('the tile button hides an entry; Hidden shows it and brings it back', () => {
    panel()
    const tile = document.querySelector('[data-gallery-id="g2"]')!.parentElement!
    fireEvent.click(within(tile).getByRole('button', { name: 'Hide from gallery' }))
    expect([...tiles()].map((t) => t.getAttribute('data-gallery-id'))).toEqual(['g3', 'g1'])
    // The entry is still in the store, with its file and prompt.
    expect(useCreateStore.getState().gallery.find((g) => g.id === 'g2')).toMatchObject({ hidden: true, filename: '2.png', prompt: 'prompt 2' })
    fireEvent.click(screen.getByRole('button', { name: 'Hidden (1)' }))
    expect([...tiles()].map((t) => t.getAttribute('data-gallery-id'))).toEqual(['g2'])
    const hiddenTile = document.querySelector('[data-gallery-id="g2"]')!.parentElement!
    fireEvent.click(within(hiddenTile).getByRole('button', { name: 'Show again' }))
    expect(useCreateStore.getState().gallery.find((g) => g.id === 'g2')!.hidden).toBeUndefined()
    expect(screen.getByText('Nothing hidden here.')).toBeTruthy()
  })

  it('the right-click menu hides several at once', () => {
    panel()
    fireEvent.click(document.querySelector('[data-gallery-id="g3"]')!, { ctrlKey: true })
    fireEvent.click(document.querySelector('[data-gallery-id="g1"]')!, { ctrlKey: true })
    fireEvent.contextMenu(document.querySelector('[data-gallery-id="g1"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide 2 from gallery' }))
    expect([...tiles()].map((t) => t.getAttribute('data-gallery-id'))).toEqual(['g2'])
  })
})

describe('tags', () => {
  it('the tag dialog adds a tag, the filter shows only those entries', () => {
    useCreateStore.setState({ gallery: [ITEM(3), ITEM(2), ITEM(1)] })
    panel()
    fireEvent.contextMenu(document.querySelector('[data-gallery-id="g2"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tags…' }))
    const field = screen.getByRole('textbox', { name: 'New tag' })
    fireEvent.change(field, { target: { value: 'Keeper' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(useCreateStore.getState().gallery.find((g) => g.id === 'g2')!.tags).toEqual(['Keeper'])
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    act(() => { useCreateStore.getState().setGalleryTagOpen('keeper') })
    expect([...tiles()].map((t) => t.getAttribute('data-gallery-id'))).toEqual(['g2'])
  })
})

describe('empty views', () => {
  it('say why they are empty', () => {
    expect(emptyLine(0, { folder: false, tag: false, hidden: false })).toBe('Nothing generated yet.')
    expect(emptyLine(5, { folder: true, tag: false, hidden: false })).toBe('Nothing in this folder yet.')
    expect(emptyLine(5, { folder: false, tag: true, hidden: false })).toBe('No items with this tag here.')
    expect(emptyLine(5, { folder: false, tag: false, hidden: true })).toBe('Nothing hidden here.')
    expect(emptyLine(5, { folder: false, tag: false, hidden: false })).toBe('Everything here is hidden.')
  })
})
