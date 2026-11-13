// @vitest-environment jsdom
/**
 * D3b (Discord #bug-reports, 01.11.2026, 3.0.8): "all my gallery folders are
 * suddenly empty", twice, no trigger known. The image files were still in the
 * output folder; in LU the folder assignments and the prompts were gone.
 *
 * Cause: the gallery kept the newest 200 entries and dropped everything past
 * that without a word. A new result lands unsorted in front, so every render
 * pushed the oldest entry out, sorted or not; 200 new renders emptied every
 * folder. Now an entry in a folder is never dropped by the cap, the cap counts
 * unsorted entries only, and when some go the gallery says so, once per event.
 *
 * A second way to lose it: "Reset settings & reload" on the error screen
 * removed the whole create-store, gallery and folders with the settings.
 *
 * Run: npx vitest run src/stores/__tests__/galerie-speicher-d3b.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCreateStore, GALLERY_TRIMMED_NOTICE, type GalleryItem } from '../createStore'
import { resetSettingsAndReload } from '../../lib/fatal-error'

const item = (n: number, extra: Partial<GalleryItem> = {}): GalleryItem => ({
  id: `g${n}`, type: 'image', filename: `ComfyUI_${n}.png`, subfolder: '', prompt: `prompt ${n} ${'p'.repeat(1500)}`,
  negativePrompt: '', model: 'm.safetensors', modelType: 'sdxl', seed: n, steps: 20, cfgScale: 5, sampler: 'euler',
  scheduler: 'normal', width: 1024, height: 1024, batchSize: 1, createdAt: n, ...extra,
})
const st = () => useCreateStore.getState()
const inFolder = () => st().gallery.filter((g) => g.folderId === 'f-1')
const unsorted = () => st().gallery.filter((g) => !g.folderId)

beforeEach(() => {
  localStorage.clear()
  useCreateStore.setState({
    backend: 'local',
    galleryFolders: [{ id: 'f-1', name: 'Sorted' }],
    galleryFolderOpen: null,
    // 200 sorted by hand, the oldest renders.
    gallery: Array.from({ length: 200 }, (_, i) => item(1000 - i, { folderId: 'f-1' })),
    galleryNotice: null,
  })
})
afterEach(() => { vi.restoreAllMocks() })

describe('the cap never takes a sorted entry', () => {
  it('200 sorted + 500 new: the folder stays complete, with its prompts', () => {
    for (let i = 0; i < 500; i++) st().addToGallery(item(5000 + i))
    expect(inFolder()).toHaveLength(200)
    expect(inFolder().every((g) => g.prompt.startsWith(`prompt ${g.seed} `))).toBe(true)
    // The cap still holds for unsorted ones: the newest 200.
    expect(unsorted()).toHaveLength(200)
    expect(unsorted()[0].id).toBe('g5499')
    expect(unsorted().some((g) => g.id === 'g5000')).toBe(false)
    // And it is what gets stored.
    const stored = JSON.parse(localStorage.getItem('create-store') ?? '{}').state.gallery as GalleryItem[]
    expect(stored.filter((g) => g.folderId === 'f-1')).toHaveLength(200)
  })

  it('results filed into the open folder are never dropped either', () => {
    useCreateStore.setState({ galleryFolderOpen: 'f-1' })
    for (let i = 0; i < 300; i++) st().addToGallery(item(5000 + i))
    expect(inFolder()).toHaveLength(500)
    expect(st().galleryNotice).toBeNull()
  })

  it('a cloud job list beyond the cap keeps the sorted entries too', () => {
    st().mergeGallery(Array.from({ length: 300 }, (_, i) => item(9000 + i, { id: `j${i}`, jobId: `j${i}` })))
    expect(inFolder()).toHaveLength(200)
    expect(unsorted()).toHaveLength(200)
  })
})

describe('when unsorted entries go, the gallery says so', () => {
  it('no word while nothing is dropped', () => {
    for (let i = 0; i < 200; i++) st().addToGallery(item(5000 + i))
    expect(st().galleryNotice).toBeNull()
  })

  it('one notice for the event, saying what happened', () => {
    for (let i = 0; i < 200; i++) st().addToGallery(item(5000 + i))
    const seen: (string | null)[] = []
    const off = useCreateStore.subscribe((s, prev) => { if (s.galleryNotice !== prev.galleryNotice) seen.push(s.galleryNotice) })
    st().mergeGallery(Array.from({ length: 50 }, (_, i) => item(9000 + i, { id: `j${i}`, jobId: `j${i}` })))
    off()
    expect(seen).toEqual([GALLERY_TRIMMED_NOTICE])
    expect(GALLERY_TRIMMED_NOTICE).toBe('Older unsorted images were removed from the gallery, the files are still in your output folder.')
    st().dismissGalleryNotice()
    expect(st().galleryNotice).toBeNull()
  })

  it('the notice is never stored', () => {
    for (let i = 0; i < 201; i++) st().addToGallery(item(5000 + i))
    expect(st().galleryNotice).toBe(GALLERY_TRIMMED_NOTICE)
    expect(JSON.parse(localStorage.getItem('create-store') ?? '{}').state).not.toHaveProperty('galleryNotice')
  })
})

describe('a full storage never replaces what is stored', () => {
  it('the last good blob stays when the write is refused', () => {
    st().addToGallery(item(5000))
    const good = localStorage.getItem('create-store')
    expect(good).toContain('"g5000"')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    st().addToGallery(item(5001))
    vi.restoreAllMocks()
    expect(localStorage.getItem('create-store')).toBe(good)
  })
})

describe('"Reset settings & reload" keeps the gallery', () => {
  it('drops the settings of Create, keeps entries and folders', () => {
    localStorage.setItem('create-store', JSON.stringify({
      state: { steps: 99, sampler: 'broken', gallery: [item(1, { folderId: 'f-1' })], galleryFolders: [{ id: 'f-1', name: 'Sorted' }] },
      version: 2,
    }))
    localStorage.setItem('chat-settings', '{"state":{},"version":0}')
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    resetSettingsAndReload()
    vi.unstubAllGlobals()
    expect(reload).toHaveBeenCalled()
    expect(localStorage.getItem('chat-settings')).toBeNull()
    const kept = JSON.parse(localStorage.getItem('create-store') ?? 'null')
    expect(kept.version).toBe(2)
    expect(kept.state.gallery.map((g: GalleryItem) => [g.id, g.folderId, g.prompt.slice(0, 8)])).toEqual([['g1', 'f-1', 'prompt 1']])
    expect(kept.state.galleryFolders).toEqual([{ id: 'f-1', name: 'Sorted' }])
    expect(kept.state).not.toHaveProperty('steps')
    expect(kept.state).not.toHaveProperty('sampler')
  })

  it('a create-store that is not readable is removed as before', () => {
    localStorage.setItem('create-store', '{broken')
    vi.stubGlobal('location', { ...window.location, reload: vi.fn() })
    resetSettingsAndReload()
    vi.unstubAllGlobals()
    expect(localStorage.getItem('create-store')).toBeNull()
  })
})
