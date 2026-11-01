// @vitest-environment jsdom
/**
 * D3 (3.0.9, Discord 01.11.2026): several images and videos at once in the
 * Create gallery. Cmd/Ctrl-click, Shift range, Cmd/Ctrl+A, Escape; then the
 * right-click menu or the bar above the grid: move to a folder, download,
 * delete. Only what a single tile already does, through the same code
 * (removeFromGallery, the move dialog, downloadGalleryItem). Delete asks
 * first and names the count.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/galerie-mehrfachauswahl.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ quota: null, enhanceVideo: vi.fn() }),
}))
vi.mock('../useComfyMedia', () => ({
  useComfyMedia: () => ({ src: 'blob:media', onError: vi.fn(), onLoad: vi.fn() }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))
const trash = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../../../lib/gallery-trash', () => ({ trashGalleryFile: trash }))
const download = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../galleryDownload', () => ({ downloadGalleryItem: download }))

import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { CreatePanel } from '../CreatePanel'

const ITEM = (id: string, extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: `prompt ${id}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 512, height: 512, batchSize: 1, createdAt: 1, ...extra,
})

const st = () => useCreateStore.getState()
const onSelect = vi.fn()

beforeEach(() => {
  trash.mockClear()
  download.mockClear()
  onSelect.mockClear()
  useCreateStore.setState({
    backend: 'local',
    gallery: [ITEM('a'), ITEM('b'), ITEM('c', { type: 'video', filename: 'c.mp4' }), ITEM('d')],
    galleryFolders: [{ id: 'f-1', name: 'Portraits' }],
    galleryFolderOpen: null,
  })
})
const ownRemove = useCreateStore.getState().removeFromGallery
afterEach(() => { cleanup(); useCreateStore.setState({ removeFromGallery: ownRemove }) })

const panel = () => render(<CreatePanel open onOpenChange={() => {}} activeId={null} onSelect={onSelect} />)
const tile = (id: string) => document.querySelector(`[data-gallery-id="${id}"]`) as HTMLElement
const selected = () => [...document.querySelectorAll('[data-gallery-id][aria-pressed="true"]')].map((e) => e.getAttribute('data-gallery-id'))
const bar = () => screen.queryByRole('toolbar', { name: 'Selected items' })

describe('selecting', () => {
  it('Cmd/Ctrl-click picks several without opening any', () => {
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.click(tile('c'), { ctrlKey: true })
    expect(selected()).toEqual(['a', 'c'])
    expect(onSelect).not.toHaveBeenCalled()
    expect(bar()!.textContent).toContain('2 selected')
  })

  it('two clicks before the next render both count (Mac run, D3 probe)', () => {
    panel()
    const click = (id: string, init: MouseEventInit) =>
      tile(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
    act(() => {
      click('a', { metaKey: true })
      click('c', { metaKey: true })
    })
    expect(selected()).toEqual(['a', 'c'])
    act(() => {
      click('b', {})
      click('d', { shiftKey: true })
    })
    expect(selected()).toEqual(['b', 'c', 'd'])
  })

  it('Shift-click takes the range from the last clicked item', () => {
    panel()
    fireEvent.click(tile('a'))
    expect(onSelect).toHaveBeenCalledWith('a')
    fireEvent.click(tile('c'), { shiftKey: true })
    expect(selected()).toEqual(['a', 'b', 'c'])
  })

  it('Cmd/Ctrl+A selects all shown, Escape clears', () => {
    panel()
    fireEvent.keyDown(tile('b'), { key: 'a', metaKey: true })
    expect(selected()).toEqual(['a', 'b', 'c', 'd'])
    fireEvent.keyDown(tile('b'), { key: 'Escape' })
    expect(selected()).toEqual([])
    expect(bar()).toBeNull()
  })

  it('a plain click opens the item and drops the selection', () => {
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.click(tile('d'))
    expect(selected()).toEqual([])
    expect(onSelect).toHaveBeenCalledWith('d')
  })
})

describe('the right-click menu', () => {
  it('on a selected tile acts on all selected, and names the count', () => {
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.click(tile('b'), { metaKey: true })
    fireEvent.contextMenu(tile('b'), { clientX: 40, clientY: 40 })
    const menu = screen.getByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Move 2 to folder…', 'Download 2', 'Delete 2…'])
  })

  it('on an unselected tile acts on that tile alone', () => {
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.contextMenu(tile('d'), { clientX: 40, clientY: 40 })
    expect(selected()).toEqual(['d'])
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Move to folder…', 'Download', 'Delete…'])
  })

  it('Delete asks with the count first; Cancel keeps everything', () => {
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.click(tile('c'), { metaKey: true })
    fireEvent.contextMenu(tile('a'), { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete 2…' }))
    const dialog = screen.getByTestId('gallery-delete-confirm')
    expect(dialog.textContent).toContain('Delete 2 items? Their files move to the Recycle Bin.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(st().gallery.map((g) => g.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(trash).not.toHaveBeenCalled()
  })

  it('confirmed, each goes the single tile\'s way (removeFromGallery → trash)', async () => {
    // The tile's own delete, wrapped to see each call. (The trash mock alone
    // misses the second of two same-tick dynamic imports under vitest.)
    const own = st().removeFromGallery
    const removed: string[] = []
    useCreateStore.setState({ removeFromGallery: (id: string) => { removed.push(id); own(id) } })
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.click(tile('c'), { metaKey: true })
    fireEvent.contextMenu(tile('a'), { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete 2…' }))
    fireEvent.click(within(screen.getByTestId('gallery-delete-confirm')).getByRole('button', { name: 'Delete 2' }))
    expect(st().gallery.map((g) => g.id)).toEqual(['b', 'd'])
    expect(removed).toEqual(['a', 'c'])
    await waitFor(() => expect(trash).toHaveBeenCalled())
    expect(selected()).toEqual([])
  })
})

describe('the bar', () => {
  it('moves all selected into a folder with the existing dialog', () => {
    panel()
    fireEvent.click(tile('b'), { metaKey: true })
    fireEvent.click(tile('d'), { metaKey: true })
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Move to folder' }))
    fireEvent.click(within(screen.getByTestId('move-to-folder')).getByRole('button', { name: 'Move' }))
    expect(st().gallery.filter((g) => g.folderId === 'f-1').map((g) => g.id)).toEqual(['b', 'd'])
  })

  it('downloads each selected through downloadGalleryItem, one after the other', async () => {
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.click(tile('c'), { metaKey: true })
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2))
    expect(download.mock.calls.map((c) => (c as unknown as [GalleryItem])[0].id)).toEqual(['a', 'c'])
  })

  it('Clear selection empties it', () => {
    panel()
    fireEvent.click(tile('a'), { metaKey: true })
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Clear selection' }))
    expect(selected()).toEqual([])
  })
})
