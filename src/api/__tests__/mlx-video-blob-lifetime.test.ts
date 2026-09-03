/**
 * M7 · "MLX blob URLs are never released".
 *
 * A `blob:` URL pins its Blob in the renderer until somebody revokes it, and an
 * MLX clip is tens to hundreds of megabytes. The old contract was "caller owns
 * the URL's lifetime (revoke it when the gallery item is dropped, if ever)" —
 * and "if ever" is what happened. Repo count at the time: 27 createObjectURL
 * against 20 revokeObjectURL.
 *
 * Two ends are closed here: mlx-video owns what it mints (re-reading a path
 * replaces its predecessor), and createStore releases an item's media on every
 * path that drops it from the gallery — removal, clear, and the silent
 * overflow past the 200-item cap.
 *
 * Run: npx vitest run src/api/__tests__/mlx-video-blob-lifetime.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: (...a: unknown[]) => backendCall(...a) }
})

const {
  readVideoAsBlobUrl, releaseVideoBlobUrl, releaseAllVideoBlobUrls, heldVideoBlobUrlCount,
} = await import('../mlx-video')
const { useCreateStore } = await import('../../stores/createStore')
type GalleryItem = import('../../stores/createStore').GalleryItem

// ── a countable stand-in for the renderer's blob table ─────────────────────
let minted = 0
const live = new Set<string>()

beforeEach(() => {
  releaseAllVideoBlobUrls()
  minted = 0
  live.clear()
  backendCall.mockReset()
  // 'AAAA' decodes to three zero bytes — the payload is irrelevant, the
  // bookkeeping is not.
  backendCall.mockResolvedValue('AAAA')
  globalThis.URL.createObjectURL = () => {
    const url = `blob:test/${++minted}`
    live.add(url)
    return url
  }
  globalThis.URL.revokeObjectURL = (url: string) => { live.delete(url) }
  useCreateStore.setState({ gallery: [], audioInput: null, videoInput: null })
})

function galleryItem(id: string, dataUrl?: string): GalleryItem {
  return {
    id, type: 'video', filename: '', subfolder: '', dataUrl,
    prompt: '', negativePrompt: '', model: '', modelType: 'wan',
    seed: 0, steps: 1, cfgScale: 1, sampler: '', scheduler: '',
    width: 1, height: 1, batchSize: 1, createdAt: 0,
  } as GalleryItem
}

describe('mlx-video owns the URLs it mints', () => {
  it('hands back a blob: URL and tracks it', async () => {
    const url = await readVideoAsBlobUrl('/out/a.mp4')
    expect(url).toMatch(/^blob:/)
    expect(live.has(url)).toBe(true)
    expect(heldVideoBlobUrlCount()).toBe(1)
  })

  it('re-reading the SAME path replaces its predecessor instead of stacking', async () => {
    // A restored tile, a retry, a second look at the same render. Before, each
    // one added another full copy of the clip to the renderer's memory.
    const first = await readVideoAsBlobUrl('/out/a.mp4')
    const second = await readVideoAsBlobUrl('/out/a.mp4')
    expect(second).not.toBe(first)
    expect(live.has(first)).toBe(false)
    expect(live.size).toBe(1)
    expect(heldVideoBlobUrlCount()).toBe(1)
  })

  it('different paths are held side by side — they are different renders', async () => {
    await readVideoAsBlobUrl('/out/a.mp4')
    await readVideoAsBlobUrl('/out/b.mp4')
    expect(live.size).toBe(2)
    expect(heldVideoBlobUrlCount()).toBe(2)
  })

  it('release drops the URL and forgets it', async () => {
    const url = await readVideoAsBlobUrl('/out/a.mp4')
    releaseVideoBlobUrl(url)
    expect(live.size).toBe(0)
    expect(heldVideoBlobUrlCount()).toBe(0)
  })

  it('release is safe on anything that is not a blob: URL of ours', () => {
    expect(() => releaseVideoBlobUrl(undefined)).not.toThrow()
    expect(() => releaseVideoBlobUrl(null)).not.toThrow()
    expect(() => releaseVideoBlobUrl('https://cdn.example/x.mp4')).not.toThrow()
    expect(() => releaseVideoBlobUrl('data:video/mp4;base64,AAAA')).not.toThrow()
    // A https:// result must never be revoked — it is not ours to revoke.
    expect(heldVideoBlobUrlCount()).toBe(0)
  })

  it('a double release is a no-op, not a crash', async () => {
    const url = await readVideoAsBlobUrl('/out/a.mp4')
    releaseVideoBlobUrl(url)
    releaseVideoBlobUrl(url)
    expect(heldVideoBlobUrlCount()).toBe(0)
  })
})

describe('the gallery gives its media back', () => {
  it('removing an item releases its blob', async () => {
    const url = await readVideoAsBlobUrl('/out/a.mp4')
    useCreateStore.getState().addToGallery(galleryItem('one', url))
    useCreateStore.getState().removeFromGallery('one')
    expect(live.size).toBe(0)
  })

  it('clearing the gallery releases every blob it held', async () => {
    for (const p of ['/a.mp4', '/b.mp4', '/c.mp4']) {
      useCreateStore.getState().addToGallery(galleryItem(p, await readVideoAsBlobUrl(p)))
    }
    expect(live.size).toBe(3)
    useCreateStore.getState().clearGallery()
    expect(live.size).toBe(0)
  })

  it('an item pushed off the 200-item cap releases its blob too', async () => {
    // This one had no UI at all: the cap dropped the oldest render silently,
    // and with it the only reference that could ever have revoked its bytes.
    const oldest = await readVideoAsBlobUrl('/oldest.mp4')
    useCreateStore.getState().addToGallery(galleryItem('oldest', oldest))
    for (let i = 0; i < 200; i++) {
      useCreateStore.getState().addToGallery(galleryItem(`fill-${i}`))
    }
    expect(useCreateStore.getState().gallery).toHaveLength(200)
    expect(useCreateStore.getState().gallery.some((g) => g.id === 'oldest')).toBe(false)
    expect(live.has(oldest)).toBe(false)
  })

  it('cloud results are left alone — their URLs are not ours', () => {
    useCreateStore.getState().addToGallery({
      ...galleryItem('cloud'), remoteUrl: 'https://cdn.example/x.mp4', jobId: 'j1',
    } as GalleryItem)
    expect(() => useCreateStore.getState().removeFromGallery('cloud')).not.toThrow()
  })

  it('a patch does NOT revoke the URL the tile may still be loading', () => {
    // updateGalleryItem lands while the tile is on screen (a lazy re-sign, a
    // restore-from-disk). Revoking there would break the very media the patch
    // exists to fix.
    const url = 'blob:test/live'
    live.add(url)
    useCreateStore.getState().addToGallery(galleryItem('one', url))
    useCreateStore.getState().updateGalleryItem('one', { dataUrl: 'blob:test/other' })
    expect(live.has(url)).toBe(true)
  })
})

describe('a staged input file is freed when it is replaced', () => {
  const ref = (name: string) => {
    const url = globalThis.URL.createObjectURL(new Blob())
    return { name, url, blob: new Blob() }
  }

  it('picking another driving video releases the previous pick', () => {
    // SpecialIntentControls mints a fresh blob: URL per pick; five
    // re-selections used to pin five files with only the last reachable.
    const first = ref('a.mp4')
    useCreateStore.getState().setVideoInput(first)
    useCreateStore.getState().setVideoInput(ref('b.mp4'))
    expect(live.has(first.url)).toBe(false)
    expect(live.size).toBe(1)
  })

  it('clearing the slot releases it', () => {
    const first = ref('a.mp4')
    useCreateStore.getState().setVideoInput(first)
    useCreateStore.getState().setVideoInput(null)
    expect(live.size).toBe(0)
  })

  it('the same goes for the voice clip', () => {
    const first = ref('a.wav')
    useCreateStore.getState().setAudioInput(first)
    useCreateStore.getState().setAudioInput(ref('b.wav'))
    expect(live.has(first.url)).toBe(false)
    expect(live.size).toBe(1)
  })

  it('re-setting the identical ref does not revoke the URL still in use', () => {
    const only = ref('a.mp4')
    useCreateStore.getState().setVideoInput(only)
    useCreateStore.getState().setVideoInput(only)
    expect(live.has(only.url)).toBe(true)
  })
})
