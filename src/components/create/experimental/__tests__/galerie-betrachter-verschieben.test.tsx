// @vitest-environment jsdom
/**
 * D3-Nachtrag (Discord #bug-reports, 01.11.2026, in 3.0.8):
 *
 * 1) "Move to folder" aus der Grossansicht war im Hellmodus kaum lesbar, die
 *    Zeile fuer den neuen Ordner fast unsichtbar. Der Dialog hing in der
 *    schwarzen Grossansicht (`lu-on-dark`), die die helle Schrift fuer dunkle
 *    Flaechen erzwingt; der Dialog selbst ist im Hellmodus weiss (gemessen
 *    1,10:1). Er gehoert nicht in diese Flaeche.
 *
 * 2) Wurde das offene Bild aus dem offenen Ordner verschoben, zeigte die
 *    Grossansicht keine Pfeile mehr: das Bild stand nicht mehr in der Ansicht,
 *    nach der geblaettert wird. Jetzt springt sie auf das naechste Bild der
 *    Ansicht (am Ende auf das vorige) und schliesst, wenn keins mehr da ist.
 *    Das gilt fuer jede Verschiebung, auch fuer mehrere auf einmal.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/galerie-betrachter-verschieben.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ quota: null, enhanceVideo: vi.fn() }),
}))
vi.mock('../useComfyMedia', () => ({
  useComfyMedia: () => ({ src: 'blob:media', onError: vi.fn(), onLoad: vi.fn() }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))

import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { Lightbox, viewSuccessor } from '../Lightbox'

const ITEM = (id: string, extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: `prompt ${id}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 512, height: 512, batchSize: 1, createdAt: 1, ...extra,
})

beforeEach(() => {
  useCreateStore.setState({
    backend: 'local',
    // Im Ordner "Portraits": a, c, d. b liegt in keinem.
    gallery: [ITEM('a', { folderId: 'f-1' }), ITEM('b'), ITEM('c', { folderId: 'f-1' }), ITEM('d', { folderId: 'f-1' })],
    galleryFolders: [{ id: 'f-1', name: 'Portraits' }, { id: 'f-2', name: 'Done' }],
    galleryFolderOpen: 'f-1',
  })
})
afterEach(() => { cleanup() })

function Viewer({ start }: { start: string }) {
  const [item, setItem] = useState<GalleryItem | null>(useCreateStore.getState().gallery.find((g) => g.id === start) ?? null)
  return (
    <>
      <Lightbox item={item} onClose={() => setItem(null)} onNavigate={setItem} />
      <span data-testid="closed">{item ? 'open' : 'closed'}</span>
    </>
  )
}
const shownPrompt = () => (screen.getByTestId('lightbox-image') as HTMLImageElement).alt

/** Over the dialog of the large view: a new folder by name, then Move. */
function moveByDialog(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Move to folder' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Move' }))
}

describe('viewSuccessor', () => {
  it('nimmt das naechste noch gezeigte, am Ende das vorige, sonst keins', () => {
    expect(viewSuccessor(['a', 'c', 'd'], ['a', 'd'], 'c')).toBe('d')
    expect(viewSuccessor(['a', 'c', 'd'], ['a', 'c'], 'd')).toBe('c')
    // Mehrere auf einmal weg: das naechste, das noch da ist.
    expect(viewSuccessor(['a', 'c', 'd', 'e'], ['a', 'e'], 'c')).toBe('e')
    expect(viewSuccessor(['a', 'c', 'd'], ['a'], 'c')).toBe('a')
    expect(viewSuccessor(['c'], [], 'c')).toBeNull()
  })
})

describe('Verschieben aus der Grossansicht', () => {
  it('der Dialog liegt nicht in der dunklen Flaeche der Grossansicht (Hellmodus lesbar)', () => {
    render(<Viewer start="c" />)
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder' }))
    const field = screen.getByRole('textbox', { name: 'New folder name' })
    expect(field.closest('.lu-on-dark')).toBeNull()
    expect(screen.getByTestId('move-to-folder').closest('.lu-on-dark')).toBeNull()
  })

  it('ein Klick im Dialog schliesst die Grossansicht nicht', () => {
    render(<Viewer start="c" />)
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder' }))
    fireEvent.click(screen.getByTestId('move-to-folder'))
    expect(screen.getByTestId('closed').textContent).toBe('open')
  })

  it('springt nach dem Verschieben auf das naechste Bild des Ordners, und die Pfeile gehen wieder', () => {
    render(<Viewer start="c" />)
    moveByDialog('Elsewhere')
    expect(shownPrompt()).toBe('prompt d')
    expect(useCreateStore.getState().gallery.find((g) => g.id === 'c')?.folderId).not.toBe('f-1')
    fireEvent.click(screen.getByTestId('lightbox-prev'))
    expect(shownPrompt()).toBe('prompt a')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(shownPrompt()).toBe('prompt d')
  })

  it('am Ende des Ordners springt sie auf das vorige', () => {
    render(<Viewer start="d" />)
    moveByDialog('Elsewhere')
    expect(shownPrompt()).toBe('prompt c')
    expect(screen.getByTestId('lightbox-prev')).toBeTruthy()
  })

  it('schliesst, wenn im Ordner nichts mehr zu sehen ist', () => {
    useCreateStore.setState({ gallery: [ITEM('a', { folderId: 'f-1' }), ITEM('b')] })
    render(<Viewer start="a" />)
    moveByDialog('Elsewhere')
    expect(screen.getByTestId('closed').textContent).toBe('closed')
  })

  it('in "All" bleibt das Bild stehen und die Pfeile bleiben', () => {
    useCreateStore.setState({ galleryFolderOpen: null })
    render(<Viewer start="b" />)
    moveByDialog('Elsewhere')
    expect(shownPrompt()).toBe('prompt b')
    expect(screen.getByTestId('lightbox-prev')).toBeTruthy()
    expect(screen.getByTestId('lightbox-next')).toBeTruthy()
  })

  it('mehrere auf einmal verschoben: weiter mit dem naechsten, das noch im Ordner ist', () => {
    render(<Viewer start="a" />)
    act(() => { useCreateStore.getState().moveToGalleryFolder(['a', 'c'], 'f-2') })
    expect(shownPrompt()).toBe('prompt d')
    expect(screen.queryByTestId('lightbox-prev')).toBeNull()
  })

  it('ein Bild, das von vornherein nicht im offenen Ordner steht, bleibt offen', () => {
    render(<Viewer start="b" />)
    act(() => { useCreateStore.getState().moveToGalleryFolder(['c'], 'f-2') })
    expect(shownPrompt()).toBe('prompt b')
    expect(screen.getByTestId('closed').textContent).toBe('open')
  })
})
