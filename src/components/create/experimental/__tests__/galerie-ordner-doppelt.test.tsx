// @vitest-environment jsdom
/**
 * FEHLER-D3 #1 (I1, Box-Runde 01.11.2026, Windows): "Move to folder" with a
 * typed name that already exists made one more folder of that name each time;
 * five moves to "Win Test" left five folders "Win Test" with one picture each.
 * addGalleryFolder never looked at the names it had. Since 3.0.7, more often
 * since D3 (several at once, from the large view).
 *
 * Side finding of the same run: the name field of the dialog was visibly
 * flatter than the folder picker above it (18 px against 37 px, WebKit). It
 * carried flex-1, meant for the rows of "Gallery folders", and in the
 * dialog's column that shrank its height.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/galerie-ordner-doppelt.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { MoveToFolderModal } from '../GalleryFolders'

const ITEM = (id: string): GalleryItem => ({
  id, type: 'image', filename: `${id}.png`, subfolder: '', prompt: `prompt ${id}`, negativePrompt: '',
  model: 'm.safetensors', modelType: 'sdxl', seed: 1, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 512, height: 512, batchSize: 1, createdAt: 1,
})
const st = () => useCreateStore.getState()

beforeEach(() => {
  useCreateStore.setState({
    gallery: [ITEM('a'), ITEM('b'), ITEM('c')],
    galleryFolders: [{ id: 'f-1', name: 'D3 Box' }],
    galleryFolderOpen: null,
  })
})
afterEach(() => { cleanup() })

describe('addGalleryFolder', () => {
  it('a name that exists gives back that folder instead of a second one', () => {
    const first = st().addGalleryFolder('Win Test')
    expect(st().addGalleryFolder('Win Test')).toBe(first)
    expect(st().addGalleryFolder('  win   test ')).toBe(first)
    expect(st().addGalleryFolder('d3 box')).toBe('f-1')
    expect(st().galleryFolders.map((f) => f.name)).toEqual(['D3 Box', 'Win Test'])
  })

  it('an existing name is found even when the list is full', () => {
    useCreateStore.setState({ galleryFolders: Array.from({ length: 50 }, (_, i) => ({ id: `f-${i}`, name: `F ${i}` })) })
    expect(st().addGalleryFolder('f 7')).toBe('f-7')
  })
})

describe('the move dialog', () => {
  function moveByName(id: string, name: string) {
    const { unmount } = render(<MoveToFolderModal ids={[id]} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), { target: { value: name } })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    unmount()
  }

  it('the same typed name three times: one folder with three pictures', () => {
    moveByName('a', 'Win Test')
    moveByName('b', 'Win Test')
    moveByName('c', 'win test')
    const named = st().galleryFolders.filter((f) => f.name.toLowerCase() === 'win test')
    expect(named).toHaveLength(1)
    expect(st().gallery.every((g) => g.folderId === named[0].id)).toBe(true)
  })

  it('the name field keeps the height of the picker above it (no flex-1 in the column)', () => {
    render(<MoveToFolderModal ids={['a']} onClose={() => {}} />)
    const field = screen.getByRole('textbox', { name: 'New folder name' })
    expect(field.className.split(/\s+/)).not.toContain('flex-1')
    expect(field.className).toContain('h-[var(--control-h-md)]')
  })
})
