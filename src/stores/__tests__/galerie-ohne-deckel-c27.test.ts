// @vitest-environment jsdom
/**
 * C27 (3.1.0) in the create store: no cap once the list has its own IndexedDB
 * key, the create-store blob keeps only the short copy for a downgrade, and
 * entries can be hidden and tagged (D27).
 *
 * The move itself: src/lib/__tests__/gallery-persist.test.ts.
 *
 * Run: npx vitest run src/stores/__tests__/galerie-ohne-deckel-c27.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useCreateStore, setGalleryUncapped, type GalleryItem } from '../createStore'
import { MIRROR_SORTED, MIRROR_UNSORTED } from '../../lib/gallery-persist'
import { itemsInView, tagCounts } from '../../lib/gallery-tags'

const item = (n: number, extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id: `g${n}`, type: 'image', filename: `ComfyUI_${n}.png`, subfolder: '', prompt: `prompt ${n}`,
  negativePrompt: '', model: 'm.safetensors', modelType: 'sdxl', seed: n, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 1024, height: 1024, batchSize: 1, createdAt: n, ...extra,
})
const st = () => useCreateStore.getState()
const storedGallery = () => JSON.parse(localStorage.getItem('create-store') ?? '{}').state.gallery as GalleryItem[]

beforeEach(() => {
  localStorage.clear()
  useCreateStore.setState({
    backend: 'local', gallery: [], galleryFolders: [{ id: 'f-1', name: 'Sorted' }], galleryFolderOpen: null,
    galleryTagOpen: null, galleryShowHidden: false, galleryNotice: null,
  })
})
afterEach(() => { setGalleryUncapped(false) })

describe('without the cap', () => {
  it('keeps 1500 renders and says nothing about trimming', () => {
    setGalleryUncapped(true)
    for (let i = 0; i < 1500; i++) st().addToGallery(item(i))
    expect(st().gallery).toHaveLength(1500)
    expect(st().galleryNotice).toBeNull()
  })

  it('the create-store blob holds only the short copy, newest first', () => {
    setGalleryUncapped(true)
    for (let i = 0; i < 400; i++) st().addToGallery(item(i, { folderId: 'f-1' }))
    for (let i = 0; i < 400; i++) st().addToGallery(item(1000 + i))
    const blob = storedGallery()
    expect(blob.filter((g) => !g.folderId)).toHaveLength(MIRROR_UNSORTED)
    expect(blob.filter((g) => g.folderId)).toHaveLength(MIRROR_SORTED)
    expect(blob[0].id).toBe('g1399')
  })

  it('before the move the cap holds as it did (no IndexedDB, or not read yet)', () => {
    for (let i = 0; i < 300; i++) st().addToGallery(item(i))
    expect(st().gallery).toHaveLength(200)
    expect(storedGallery()).toHaveLength(200)
  })
})

describe('hide and tags (D27)', () => {
  beforeEach(() => { useCreateStore.setState({ gallery: [item(3), item(2), item(1)] }) })

  it('a hidden entry keeps its file, prompt and folder and shows only under Hidden', () => {
    st().moveToGalleryFolder(['g2'], 'f-1')
    st().setGalleryHidden(['g2'], true)
    const g2 = st().gallery.find((g) => g.id === 'g2')!
    expect(g2).toMatchObject({ hidden: true, filename: 'ComfyUI_2.png', prompt: 'prompt 2', folderId: 'f-1' })
    expect(itemsInView(st().gallery, { folderId: null, tag: null, hidden: false }).map((g) => g.id)).toEqual(['g3', 'g1'])
    expect(itemsInView(st().gallery, { folderId: null, tag: null, hidden: true }).map((g) => g.id)).toEqual(['g2'])
    st().setGalleryHidden(['g2'], false)
    expect(st().gallery.find((g) => g.id === 'g2')!.hidden).toBeUndefined()
  })

  it('tags go on several entries, once each, and come off again', () => {
    st().tagGalleryItems(['g1', 'g3'], ' #Portrait ')
    st().tagGalleryItems(['g1'], 'portrait')
    st().tagGalleryItems(['g1'], 'night')
    expect(st().gallery.find((g) => g.id === 'g1')!.tags).toEqual(['Portrait', 'night'])
    expect(tagCounts(st().gallery)).toEqual([{ tag: 'Portrait', count: 2 }, { tag: 'night', count: 1 }])
    expect(itemsInView(st().gallery, { folderId: null, tag: 'PORTRAIT', hidden: false }).map((g) => g.id)).toEqual(['g3', 'g1'])
    st().setGalleryTagOpen('night')
    st().untagGalleryItems(['g1'], 'NIGHT')
    expect(st().gallery.find((g) => g.id === 'g1')!.tags).toEqual(['Portrait'])
    // Nobody carries the filtered tag any more: the filter goes.
    expect(st().galleryTagOpen).toBeNull()
  })

  it('hidden and tags are stored, the view is not', () => {
    st().setGalleryHidden(['g1'], true)
    st().tagGalleryItems(['g3'], 'keep')
    st().setGalleryShowHidden(true)
    const blob = JSON.parse(localStorage.getItem('create-store')!).state
    expect(blob.gallery.find((g: GalleryItem) => g.id === 'g1').hidden).toBe(true)
    expect(blob.gallery.find((g: GalleryItem) => g.id === 'g3').tags).toEqual(['keep'])
    expect(blob).not.toHaveProperty('galleryShowHidden')
    expect(blob).not.toHaveProperty('galleryTagOpen')
  })
})

describe('restore from the output folder', () => {
  it('adds only entries for files the gallery does not list yet', () => {
    useCreateStore.setState({ gallery: [item(5), item(1)] })
    const n = st().restoreGalleryItems([
      item(9, { id: 'r-a', filename: 'ComfyUI_9.png' }),
      item(1, { id: 'r-b', filename: 'ComfyUI_1.png' }),
      item(3, { id: 'r-c', filename: 'ComfyUI_3.png', subfolder: 'video' }),
    ])
    expect(n).toBe(2)
    expect(st().gallery.map((g) => g.id)).toEqual(['r-a', 'g5', 'r-c', 'g1'])
  })
})
