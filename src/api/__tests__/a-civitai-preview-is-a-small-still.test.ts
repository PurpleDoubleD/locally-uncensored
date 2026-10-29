/**
 * Discord #bug-reports, 29.10.2026 (Ubuntu): "when searching for models in app
 * from civitai searchbox, the app crashes".
 *
 * The search put the first image of each hit into an `<img>` as CivitAI names
 * it: the original file. Measured for "wan", 20 hits with 19 previews: 13 were MP4 videos, 68 MB
 * together (the largest 15.9 MB), for 56 px cards. WebKitGTK decodes a video in
 * an `<img>` with GStreamer, so Linux ran up to twenty video decoders per
 * search. The CDN's `anim=false` gives one JPEG frame of the same file instead
 * (measured: image/jpeg, 111 KB; all 19 together 1.89 MB).
 *
 * Run: npx vitest run src/api/__tests__/a-civitai-preview-is-a-small-still.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const fetchExternal = vi.fn()
vi.mock('../backend', () => ({
  backendCall: vi.fn(),
  fetchExternal: (...args: unknown[]) => fetchExternal(...args),
  isTauri: () => true,
  isMacOS: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

import { searchCivitaiModels, civitaiThumbUrl } from '../discover'

// The shape of the real answer for "wan" (29.10.2026), shortened to two hits.
const VIDEO = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/aea4631f-3ca2-4641-9cb3-7509ab47e97a/original=true/94287650.mp4'
const IMAGE = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/9fd7e6dd-f91f-44b8-b2b2-12a1dbf30515/original=true/72289903.jpeg'
const answer = JSON.stringify({
  items: [
    { id: 1, name: 'Wan Video 2.2', stats: {}, modelVersions: [{ images: [{ type: 'video', url: VIDEO }], files: [{ name: 'a.safetensors', sizeKB: 1 }] }] },
    { id: 2, name: 'Wan Video 2.1', stats: {}, modelVersions: [{ images: [{ type: 'image', url: IMAGE }], files: [{ name: 'b.safetensors', sizeKB: 1 }] }] },
  ],
})

beforeEach(() => {
  fetchExternal.mockReset()
  fetchExternal.mockResolvedValue(answer)
})

describe('the preview of a CivitAI hit', () => {
  it('is never the original file', async () => {
    const hits = await searchCivitaiModels('wan')
    for (const h of hits) expect(h.thumbnailUrl).not.toContain('original=true')
  })

  it('asks the CDN for a still frame of a video, not for the video', async () => {
    const [video] = await searchCivitaiModels('wan')
    expect(video.thumbnailUrl).toBe(
      'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/aea4631f-3ca2-4641-9cb3-7509ab47e97a/anim=false,width=450,optimized=true/94287650.mp4')
  })

  it('asks for a small rendition of an image', async () => {
    const [, image] = await searchCivitaiModels('wan')
    expect(image.thumbnailUrl).toBe(
      'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/9fd7e6dd-f91f-44b8-b2b2-12a1dbf30515/anim=false,width=450,optimized=true/72289903.jpeg')
  })
})

describe('civitaiThumbUrl', () => {
  it('fills in the settings part an older answer leaves out', () => {
    expect(civitaiThumbUrl('https://image.civitai.com/k/u/1.jpeg', 'image'))
      .toBe('https://image.civitai.com/k/u/anim=false,width=450,optimized=true/1.jpeg')
  })

  it('gives a video on any other host no preview at all', () => {
    expect(civitaiThumbUrl('https://example.test/clip.mp4', 'video')).toBeUndefined()
    expect(civitaiThumbUrl('https://example.test/clip.webm')).toBeUndefined()
  })

  // Negative controls: what is not a video on the CDN stays as it was.
  it('leaves an image on another host as it is', () => {
    expect(civitaiThumbUrl('https://example.test/a.png', 'image')).toBe('https://example.test/a.png')
  })

  it('has nothing to show for no address or a broken one', () => {
    expect(civitaiThumbUrl(undefined)).toBeUndefined()
    expect(civitaiThumbUrl('not a url', 'image')).toBeUndefined()
  })
})
