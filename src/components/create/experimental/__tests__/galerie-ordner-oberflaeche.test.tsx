// @vitest-environment jsdom
/**
 * D3 (Discord feature-requests, 09.10.2026): Ordner in der Galerie.
 *
 * Oben im Galerie-Panel steht ein Filter "All" plus die Ordner, jeweils mit
 * Anzahl, und er zeigt nur die Eintraege des gewaehlten Ordners. Aus der
 * Grossansicht (Lightbox) laesst sich ein Bild in einen Ordner legen, ohne
 * dass die Grossansicht dabei zugeht. Ordner verwalten (anlegen, umbenennen,
 * entfernen) laeuft ueber den Ordner-Knopf, Entfernen behaelt die Bilder.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/galerie-ordner-oberflaeche.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({ quota: null, enhanceVideo: vi.fn() }),
}))
vi.mock('../useComfyMedia', () => ({
  useComfyMedia: () => ({ src: 'blob:media', onError: vi.fn(), onLoad: vi.fn() }),
}))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => false, MLX_MODEL_PREFIX: 'MLX ' }))
const trash = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../../../lib/gallery-trash', async (o) => ({ ...(await o<typeof import('../../../../lib/gallery-trash')>()), trashGalleryFile: trash }))

import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { CreatePanel } from '../CreatePanel'
import { Lightbox } from '../Lightbox'

const ITEM = (id: string, extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: `prompt ${id}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 512, height: 512, batchSize: 1, createdAt: 1, ...extra,
})

const st = () => useCreateStore.getState()

beforeEach(() => {
  trash.mockClear()
  useCreateStore.setState({
    backend: 'local',
    gallery: [ITEM('a', { folderId: 'f-1' }), ITEM('b', { folderId: 'f-1' }), ITEM('c')],
    galleryFolders: [{ id: 'f-1', name: 'Portraits' }, { id: 'f-2', name: 'Empty' }],
    galleryFolderOpen: null,
  })
})
afterEach(() => { cleanup() })

const panel = () => render(<CreatePanel open onOpenChange={() => {}} activeId={null} onSelect={() => {}} />)
const tiles = () => document.querySelectorAll('.grid > .relative').length

describe('the folder filter in the gallery', () => {
  it('names All and every folder with its count, and shows only the picked folder', () => {
    panel()
    const filter = screen.getByRole('button', { name: 'Show folder' })
    expect(filter.textContent).toContain('All (3)')
    expect(tiles()).toBe(3)
    fireEvent.click(filter)
    const options = screen.getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['All (3)', 'Portraits (2)', 'Empty (0)'])
    fireEvent.click(screen.getByRole('option', { name: 'Portraits (2)' }))
    expect(st().galleryFolderOpen).toBe('f-1')
    expect(tiles()).toBe(2)
  })

  it('an empty folder says so instead of "Nothing generated yet"', () => {
    useCreateStore.setState({ galleryFolderOpen: 'f-2' })
    panel()
    expect(screen.getByText('Nothing in this folder yet.')).toBeTruthy()
  })

  it('without folders there is no filter, only the way to make one', () => {
    useCreateStore.setState({ galleryFolders: [] })
    panel()
    expect(screen.queryByRole('button', { name: 'Show folder' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
    const dialog = screen.getByTestId('gallery-folders')
    fireEvent.change(within(dialog).getByLabelText('New folder name'), { target: { value: 'Trip' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }))
    expect(st().galleryFolders.map((f) => f.name)).toEqual(['Trip'])
  })

  it('removing a folder in the dialog keeps its pictures in All', () => {
    panel()
    fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder Portraits' }))
    expect(st().galleryFolders.map((f) => f.id)).toEqual(['f-2'])
    expect(st().gallery).toHaveLength(3)
    expect(st().gallery.every((g) => !g.folderId)).toBe(true)
    expect(trash).not.toHaveBeenCalled()
  })

  it('renames a folder in the dialog', () => {
    panel()
    fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
    const field = screen.getByLabelText('Name of folder Portraits')
    fireEvent.change(field, { target: { value: 'Faces' } })
    fireEvent.blur(field)
    expect(st().galleryFolders[0].name).toBe('Faces')
  })

  it('a tile moves its picture into a folder', () => {
    panel()
    fireEvent.click(screen.getAllByRole('button', { name: 'Move to folder' })[2])
    const dialog = screen.getByTestId('move-to-folder')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('option', { name: 'Empty' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    expect(st().gallery.find((g) => g.id === 'c')!.folderId).toBe('f-2')
  })
})

describe('Move to folder in the large view', () => {
  it('files the picture under the chosen folder and the large view stays open', async () => {
    const onClose = vi.fn()
    render(<Lightbox item={st().gallery[2]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Move to folder/ }))
    const dialog = screen.getByTestId('move-to-folder')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('option', { name: 'Portraits' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    expect(st().gallery.find((g) => g.id === 'c')!.folderId).toBe('f-1')
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByTestId('move-to-folder')).toBeNull())
    expect(screen.getByRole('button', { name: /Move to folder/ })).toBeTruthy()
  })

  it('a new folder typed there is made and used', () => {
    render(<Lightbox item={st().gallery[0]} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Move to folder/ }))
    const dialog = screen.getByTestId('move-to-folder')
    fireEvent.change(within(dialog).getByLabelText('New folder name'), { target: { value: 'Best of' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    const made = st().galleryFolders.find((f) => f.name === 'Best of')!
    expect(made).toBeTruthy()
    expect(st().gallery.find((g) => g.id === 'a')!.folderId).toBe(made.id)
  })
})
