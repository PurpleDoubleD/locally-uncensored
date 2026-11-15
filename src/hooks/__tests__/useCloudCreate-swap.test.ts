/**
 * Swap Character (07.11.2026, port of the web's C52) through the Create
 * tab's start: what goes to the server, what stops before any upload.
 * Nothing is rendered or booked: upload, quote and submit are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

// A full, hand-written mock (no `...actual` spread): the real ../../api/cloud/jobs
// pulls in the Supabase client (api/cloud/supabase.ts), which touches
// `localStorage` at import time and blows up outside a browser-like test
// environment. The established pattern in this directory (see
// useCloudCreate-b3-adult-gate-fires-before-upload.test.ts) is a fake
// CloudJobError/QuoteChangedError pair instead of the real classes.
const hoisted = vi.hoisted(() => {
  class FakeCloudJobError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, meta?: { code?: string }) {
      super(message)
      this.status = status
      this.code = meta?.code
    }
  }
  class FakeQuoteChangedError extends FakeCloudJobError {
    credits: number
    constructor(message: string, credits: number) {
      super(message, 409, { code: 'quote_changed' })
      this.credits = credits
    }
  }
  const submitted: Array<{ kind: string; model: string; prompt: string; params: Record<string, unknown> }> = []
  const hochgeladen: string[] = []
  return {
    FakeCloudJobError,
    FakeQuoteChangedError,
    submitted,
    hochgeladen,
    uploadInput: vi.fn(async (_blob: unknown, slot: string) => {
      hochgeladen.push(slot)
      return `user-1/staged-${slot}.${slot === 'audio' ? 'mp3' : slot === 'video' ? 'mp4' : 'png'}`
    }),
    getJob: vi.fn(async () => ({ id: 'quelle', result_url: 'https://storage.example/clip.mp4' })),
    submitCloudJob: vi.fn(async (payload: (typeof submitted)[number]) => {
      submitted.push(payload)
      return { id: 'job-test', quota: { cost: 1000, used: 1000, limit: 100000 } }
    }),
    pollJob: vi.fn(async () => ({
      id: 'job-test', kind: 'video', model: 'longcat-avatar', status: 'succeeded',
      result_url: 'https://storage.example/out.mp4', created_at: new Date().toISOString(),
    })),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    adoptInput: vi.fn(async (jobId: string, role: string) => {
      hochgeladen.push(`adopt ${jobId} ${role}`)
      return `user-1/adopted-${jobId}.jpg`
    }),
    studioQuote: vi.fn(async (..._args: unknown[]) => ({ credits: 42 })),
  }
})
const { submitted, hochgeladen } = hoisted

// Sidesteps loadContentPolicy's own call into ../../api/cloud/jobs
// (getContentPolicy). 'off' keeps clientSafety() to its CSAM-only floor,
// same as an account whose policy has not loaded yet.
vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))

vi.mock('../../api/cloud/jobs', () => ({
  uploadInput: hoisted.uploadInput,
  getJob: hoisted.getJob,
  submitCloudJob: hoisted.submitCloudJob,
  pollJob: hoisted.pollJob,
  cancelJob: hoisted.cancelJob,
  adoptInput: hoisted.adoptInput,
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: hoisted.FakeQuoteChangedError,
}))

// Review A1/B3 (Runde 2): useCloudCreate now quotes a Studio run right
// before booking (see useCloudCreate.ts, the "Confirming the price…" step)
// and uses that number as max_credits. A fixed 42 keeps every existing
// assertion below about the OTHER params fields unaffected; the dedicated
// max_credits/quote_changed behavior gets its own tests further down.
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))

// The length of the video as the WebView measures it (no <video> in node).
vi.mock('../../components/create/experimental/useStudioPrice', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  mediaSeconds: async () => 6.006,
}))

import { useCloudCreate } from '../useCloudCreate'
import { swapKeyOf } from '../../lib/create/swap-frame'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { useCharacterHubReleaseStore } from '../../lib/create/character-hub-release'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'
import { SWAP_CONSENT_MISSING } from '../../lib/render/swap'

const FOTO = { filename: 'face.png', url: 'data:image/png;base64,AA', width: 512, height: 768 }
const CLIP = { name: 'dance.mp4', url: 'blob:dance', blob: new Blob(['x'], { type: 'video/mp4' }) }

beforeEach(() => {
  // An account the server released the Character area for (features.characterHub).
  useCharacterHubReleaseStore.setState({ fromMe: true, fromCatalog: null })
  submitted.length = 0
  hochgeladen.length = 0
  hoisted.studioQuote.mockClear()
  hoisted.studioQuote.mockResolvedValue({ credits: 42 })
  hoisted.uploadInput.mockClear()
  hoisted.submitCloudJob.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud',
    source: null, audioInput: null, videoInput: null, voiceFromJob: null,
    extendSource: null, gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudOpModel: '',
  })
  useCreateStore.getState().setPrompt('left from another tab')
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.getState().setIntent('swap_character')
  useCreateStore.setState({ swapFigures: [{ image: null, role: '' }], swapSeconds: null, swapConsent: false, swapBuilt: null, swapFrame: null })
})

describe('Swap Character from the Create tab', () => {
  it('sends a studio run with every photo, the roles, the length and the consent, and no prompt', async () => {
    useCreateStore.getState().setCloudOpModel('openjutsu-character-swap')
    useCreateStore.setState({
      videoInput: CLIP, swapSeconds: 10, swapConsent: true,
      swapFigures: [{ image: FOTO, role: 'the woman on the left' }, { image: FOTO, role: '' }],
      cloudStudioOptions: { resolution: '480p' },
    })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    const p = submitted[0].params
    expect(submitted[0].model).toBe('openjutsu-character-swap')
    expect(submitted[0].kind).toBe('video')
    expect(submitted[0].prompt).toBe('')
    expect(p.op).toBe('studio')
    expect(p.video_path).toBe('user-1/staged-video.mp4')
    expect(p.image_paths).toEqual(['user-1/staged-source.png', 'user-1/staged-source.png'])
    expect(p.source_path).toBeUndefined()
    expect(p.studio_options).toEqual({ resolution: '480p', roles: ['the woman on the left', 'the second person from the left'] })
    expect(p.clip_seconds).toBe(10)
    expect(p.swap_consent).toBe(true)
    expect(p.label).toBe('Swap Character')
    expect(p.max_credits).toBe(42)
    expect(hochgeladen).toEqual(['video', 'source', 'source'])
    // The quote sees what the run sends: the cut length and the roles.
    const quoted = hoisted.studioQuote.mock.calls[0] as unknown[]
    expect(quoted[0]).toBe('openjutsu-character-swap')
    expect(quoted[2]).toMatchObject({ clip_seconds: 10, swap_consent: true, image_paths: p.image_paths, studio_options: p.studio_options })
  })

  it('runs Wan 2.2 Animate as replace with the photo as still', async () => {
    useCreateStore.getState().setCloudOpModel('wan-2.2-animate-replace')
    useCreateStore.setState({ videoInput: CLIP, swapSeconds: 60, swapConsent: true, swapFigures: [{ image: FOTO, role: '' }] })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    const p = submitted[0].params
    expect(submitted[0].model).toBe('wan-2.2-animate-replace')
    expect(p.source_path).toBe('user-1/staged-source.png')
    expect(p.image_paths).toBeUndefined()
    expect(p.studio_options).toEqual({ mode: 'replace' })
    expect(p.clip_seconds).toBe(60)
    expect(p.swap_consent).toBe(true)
  })

  it('stops before any upload without the consent, with the server sentence', async () => {
    useCreateStore.setState({ videoInput: CLIP, swapFigures: [{ image: FOTO, role: '' }], swapConsent: false })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe(SWAP_CONSENT_MISSING)
    expect(hoisted.uploadInput).not.toHaveBeenCalled()
    expect(submitted).toHaveLength(0)
  })

  it('stops before any upload while a person has no photo', async () => {
    useCreateStore.setState({ videoInput: CLIP, swapConsent: true, swapFigures: [{ image: FOTO, role: '' }, { image: null, role: '' }] })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Add a photo for person 2, or remove that person.')
    expect(hoisted.uploadInput).not.toHaveBeenCalled()
  })

  it('never sends the Stage source of another tab', async () => {
    useCreateStore.getState().setCloudOpModel('openjutsu-character-swap')
    useCreateStore.setState({ source: { ...FOTO, filename: 'other.png' }, videoInput: CLIP, swapConsent: true, swapFigures: [{ image: FOTO, role: '' }] })
    await useCloudCreate().generate()
    expect(submitted[0].params.source_path).toBeUndefined()
    expect(submitted[0].params.image_paths).toEqual(['user-1/staged-source.png'])
  })

  it('refuses on a server whose catalogue does not list the swap models', async () => {
    useCloudCatalogStore.setState({ models: neuerServer().filter((m) => !['openjutsu-character-swap', 'wan-2.2-animate-replace', 'scail-2', 'kling-v3-pro-motion-control'].includes(m.id)) })
    useCreateStore.setState({ videoInput: CLIP, swapConsent: true, swapFigures: [{ image: FOTO, role: '' }] })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Swap Character needs a newer LU Cloud. Try again later.')
    expect(submitted).toHaveLength(0)
  })

  it('SCAIL 2 (the default) waits for the confirmed first frame, before any upload', async () => {
    useCreateStore.setState({ videoInput: CLIP, swapConsent: true, swapFigures: [{ image: FOTO, role: '' }] })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Build the first frame and check it before you start the video.')
    expect(hoisted.uploadInput).not.toHaveBeenCalled()
    expect(submitted).toHaveLength(0)
    // A frame that is built but not confirmed, or built for other inputs, does not count.
    const figures = [{ image: FOTO, role: '', mark: { x: 0.3, y: 0.5 } }]
    useCreateStore.setState({ swapFigures: figures, swapBuilt: { jobId: 'f1', url: 'https://x/f.jpg', key: swapKeyOf(CLIP.url, figures), confirmed: false } })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(0)
    useCreateStore.setState({ swapBuilt: { jobId: 'f1', url: 'https://x/f.jpg', key: swapKeyOf('blob:other', figures), confirmed: true } })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(0)
  })

  it('SCAIL 2 runs on the confirmed first frame: adopted, video step, 720p replace, whole seconds', async () => {
    const figures = [{ image: FOTO, role: '', mark: { x: 0.2, y: 0.5 } }, { image: FOTO, role: '', mark: { x: 0.8, y: 0.5 } }]
    useCreateStore.setState({
      videoInput: CLIP, swapConsent: true, swapFigures: figures,
      swapBuilt: { jobId: 'frame-7', url: 'https://x/f.jpg', key: swapKeyOf(CLIP.url, figures), confirmed: true },
    })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    const p = submitted[0].params
    expect(submitted[0].model).toBe('scail-2')
    expect(submitted[0].prompt).toBe('')
    expect(p.source_path).toBe('user-1/adopted-frame-7.jpg')
    expect(p.image_paths).toBeUndefined()
    expect(p.video_path).toBe('user-1/staged-video.mp4')
    expect(p.swap_step).toBe('video')
    expect(p.swap_consent).toBe(true)
    expect(p.clip_seconds).toBe(6)
    expect(p.studio_options).toEqual({ resolution: '720p', mode: 'replace' })
    // The photos do not go up again: only the video, and the frame by adopt.
    expect(hochgeladen).toEqual(['video', 'adopt frame-7 image'])
    // The quote sees the same fields, the video step too.
    expect(hoisted.studioQuote.mock.calls[0][2]).toMatchObject({ swap_step: 'video', clip_seconds: 6, source_path: p.source_path })
  })

  it('Kling runs on the confirmed first frame without a prompt, orientation by the video, original sound', async () => {
    useCreateStore.getState().setCloudOpModel('kling-v3-pro-motion-control')
    const figures = [{ image: FOTO, role: '' }]
    useCreateStore.setState({
      videoInput: CLIP, swapConsent: true, swapSeconds: 4, swapFigures: figures,
      swapBuilt: { jobId: 'frame-8', url: 'https://x/f.jpg', key: swapKeyOf(CLIP.url, figures), confirmed: true },
    })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    const p = submitted[0].params
    expect(submitted[0].model).toBe('kling-v3-pro-motion-control')
    expect(submitted[0].prompt).toBe('')
    expect(p.studio_options).toEqual({ character_orientation: 'video', keep_original_sound: true })
    expect(p.clip_seconds).toBe(4)
    expect(p.swap_step).toBe('video')
    expect(p.source_path).toBe('user-1/adopted-frame-8.jpg')
  })
})
