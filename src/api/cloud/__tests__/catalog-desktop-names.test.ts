/**
 * The media catalog as the app shows it.
 *
 * The cloud lists the open media models under a neutral word on its own
 * domain and sends the app's name next to it as `native_label`. The app
 * shows that name everywhere a catalog name appears. A server that does not
 * send the field (every server before 08.10.2026) is shown under `label`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cloudFetch = vi.hoisted(() => vi.fn())
vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>()
  return { ...actual, cloudFetch }
})

import { desktopCatalog, getCatalog } from '../catalog'
import { cloudModelById, refreshCatalog, useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { modelLabel } from '../../../lib/render/preset-models'
import { galleryLabel } from '../../../lib/render/gallery-label'
import { CLOUD_MODEL_SEED } from '../../../lib/render/cloud-models'
import type { GalleryItem } from '../../../stores/createStore'

const REST = {
  ops: { removebg: 1, eraser: 1, upscale_image: 1, upscale_video_per_s: 1, upscale_video_min: 1 },
  voice: { stt: 1, tts_per_1k_chars: 1 },
  media_live: true,
  tier: 'hosted',
  monthly_credits: 1,
}

const WIRE = {
  ...REST,
  models: [
    { id: 'flux-2-dev', label: 'Flux 2 Dev', kind: 'image' as const },
    { id: 'chroma', label: 'Chroma Unfiltered', native_label: 'Chroma Uncensored', kind: 'image' as const, adult: true },
    { id: 'wan-2.2-spicy-extend', label: 'Wan 2.2 Unfiltered Extend', native_label: 'Wan 2.2 Uncensored Extend', kind: 'video' as const, ops: ['extend' as const], adult: true },
    { id: 'wan-3.0-spicy', label: 'Wan 3.0 Unfiltered', native_label: 'Wan 3.0 Uncensored', kind: 'video' as const, ops: ['studio' as const], quote_required: true, adult: true },
  ],
}

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  cloudFetch.mockReset()
  useCloudCatalogStore.setState({ fetchedAt: null, models: CLOUD_MODEL_SEED, ops: null, voice: null, mediaLive: null })
})

describe('desktopCatalog', () => {
  it('takes the name the server sends for the app, and leaves every other entry as it is', () => {
    const c = desktopCatalog(WIRE)
    expect(c.models.map((m) => m.label)).toEqual(['Flux 2 Dev', 'Chroma Uncensored', 'Wan 2.2 Uncensored Extend', 'Wan 3.0 Uncensored'])
    // Nothing else of an entry moves, and the wire field does not travel on.
    expect(c.models[1]).toEqual({ id: 'chroma', label: 'Chroma Uncensored', kind: 'image', adult: true })
    for (const m of c.models) expect(m).not.toHaveProperty('native_label')
    expect({ ...c, models: [] }).toEqual({ ...REST, models: [] })
  })

  it('a server without the field is shown under its label', () => {
    const old = { ...REST, models: WIRE.models.map(({ native_label: _gone, ...m }) => m) }
    expect(desktopCatalog(old).models.map((m) => m.label)).toEqual(old.models.map((m) => m.label))
  })

  it('an empty or malformed field never blanks a name', () => {
    const odd = { ...REST, models: [
      { id: 'a', label: 'A', native_label: '', kind: 'image' as const },
      { id: 'b', label: 'B', native_label: '   ', kind: 'image' as const },
      { id: 'c', label: 'C', native_label: 7, kind: 'image' as const },
      { id: 'd', label: 'D', native_label: null, kind: 'image' as const },
    ] }
    expect(desktopCatalog(odd).models.map((m) => m.label)).toEqual(['A', 'B', 'C', 'D'])
  })
})

describe('the live catalog reaches every reader under the app name', () => {
  it('getCatalog asks the same route as before and returns the app names', async () => {
    cloudFetch.mockResolvedValue(answer(WIRE))
    const c = await getCatalog()
    expect(cloudFetch).toHaveBeenCalledWith('/api/jobs/catalog?v=2&with=3d')
    expect(c.models.find((m) => m.id === 'chroma')?.label).toBe('Chroma Uncensored')
  })

  it('the store, the model name of a run and the gallery line all read it', async () => {
    cloudFetch.mockResolvedValue(answer(WIRE))
    await refreshCatalog()
    expect(cloudModelById('chroma')?.label).toBe('Chroma Uncensored')
    expect(cloudModelById('wan-2.2-spicy-extend')?.label).toBe('Wan 2.2 Uncensored Extend')
    // What a Studio run without a prompt is stored and listed under.
    expect(modelLabel('wan-3.0-spicy')).toBe('Wan 3.0 Uncensored')
    // A gallery entry without a title of its own falls back to the catalog name.
    const item = { id: 'g', type: 'image', model: 'chroma' } as unknown as GalleryItem
    expect(galleryLabel(item)).toBe('Image · Chroma Uncensored')
    // And nothing the store holds carries the server's own word.
    expect(JSON.stringify(useCloudCatalogStore.getState().models)).not.toContain('Unfiltered')
  })

  it('a server without the field: the store shows its labels', async () => {
    cloudFetch.mockResolvedValue(answer({ ...REST, models: WIRE.models.map(({ native_label: _gone, ...m }) => m) }))
    await refreshCatalog()
    expect(cloudModelById('chroma')?.label).toBe('Chroma Unfiltered')
  })
})
