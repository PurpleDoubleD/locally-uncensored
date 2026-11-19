/**
 * Scene to Video (3.1.3, the web's tab of 16.11.2026) through the Create
 * tab's start on LU Cloud: what goes to the server, what stops before any
 * upload. Nothing is rendered or booked: upload, quote and submit are mocked
 * (the mock block is the one of useCloudCreate-swap.test.ts).
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
import { useCreateStore, EMPTY_SCENE } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'

const CLIP = { name: 'scene.mov', url: 'blob:scene', blob: new Blob(['x'], { type: 'video/quicktime' }) }
const MEASURED = { videoUrl: 'blob:scene', seconds: 7.4, width: 720, height: 1280 }

beforeEach(() => {
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
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.getState().setIntent('scene')
  useCreateStore.setState({ scene: { ...EMPTY_SCENE } })
  useCreateStore.getState().setPrompt('a rainy neon street at night')
})

/** The scene video on the stage, measured as SceneStage measures it. */
function withClip(frame: typeof EMPTY_SCENE.frame = null) {
  useCreateStore.setState({ videoInput: CLIP })
  useCreateStore.setState((s) => ({ scene: { ...s.scene, clip: MEASURED, frame } }))
}

describe('Scene to Video from the Create tab (LU Cloud)', () => {
  it('sends Wan 3.0 Scene a studio run with the video, the keep-the-camera sentence and the scene label', async () => {
    withClip()
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    const run = submitted[0]
    expect(run.model).toBe('wan-3.0-video-edit')
    expect(run.kind).toBe('video')
    expect(run.prompt).toBe('a rainy neon street at night Keep the camera movement, the timing, the framing and the position of every object from the video.')
    expect(run.params.op).toBe('studio')
    expect(run.params.video_path).toBe('user-1/staged-video.mp4')
    expect(run.params.source_path).toBeUndefined()
    expect(run.params.image_paths).toBeUndefined()
    expect(run.params.label).toBe('Scene to Video')
    expect(run.params.max_credits).toBe(42)
    expect(hochgeladen).toEqual(['video'])
    // The quote prices the same words and the same video.
    const quoted = hoisted.studioQuote.mock.calls[0] as unknown[]
    expect(quoted[0]).toBe('wan-3.0-video-edit')
    expect(quoted[1]).toBe(run.prompt)
    expect(quoted[2]).toMatchObject({ video_path: 'user-1/staged-video.mp4' })
    // The gallery keeps the customer's own words.
    const item = useCreateStore.getState().gallery[0]
    expect(item?.prompt).toBe('a rainy neon street at night')
    expect(item?.intent).toBe('scene')
  })

  it('sends VACE the length and the size of the clip and the look alone', async () => {
    useCreateStore.getState().setCloudOpModel('wan-2.1-vace')
    withClip()
    await useCloudCreate().generate()
    const run = submitted[0]
    expect(run.model).toBe('wan-2.1-vace')
    expect(run.prompt).toBe('a rainy neon street at night')
    expect(run.params.studio_options).toMatchObject({ size: '720*1280', duration: 7 })
  })

  it('an own first frame goes where the model reads a picture, and the prompt names it', async () => {
    withClip({ kind: 'upload', url: 'data:image/png;base64,AA', width: 720, height: 1280, videoUrl: 'blob:scene' })
    await useCloudCreate().generate()
    const run = submitted[0]
    expect(run.params.image_paths).toEqual(['user-1/staged-source.png'])
    expect(run.prompt).toContain('The reference image shows the first frame.')
    expect(hochgeladen).toEqual(['video', 'source'])
  })

  it('a first frame made on the cloud is adopted as an own result, not uploaded again', async () => {
    withClip({ kind: 'designed', jobId: 'frame-1', url: 'https://storage.example/f.jpg', model: 'gpt-image-2-edit', videoUrl: 'blob:scene' })
    await useCloudCreate().generate()
    expect(submitted[0].params.image_paths).toEqual(['user-1/adopted-frame-1.jpg'])
    expect(hochgeladen).toEqual(['video', 'adopt frame-1 image'])
  })

  it('a model that reads no first frame gets none', async () => {
    useCreateStore.getState().setCloudOpModel('flux-3-video-edit')
    useCreateStore.setState({ videoInput: { ...CLIP, name: 'scene.mp4', blob: new Blob(['x'], { type: 'video/mp4' }) } })
    useCreateStore.setState((s) => ({ scene: { ...s.scene, clip: MEASURED, frame: { kind: 'upload', url: 'data:image/png;base64,AA', width: 1, height: 1, videoUrl: 'blob:scene' } } }))
    await useCloudCreate().generate()
    expect(submitted[0].params.image_paths).toBeUndefined()
    expect(submitted[0].params.source_path).toBeUndefined()
    expect(hochgeladen).toEqual(['video'])
  })

  it('stops before any upload: no video, a too short clip, no words, MOV on FLUX 3, a frame still in the making', async () => {
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Add your scene video first.')
    withClip()
    useCreateStore.setState((s) => ({ scene: { ...s.scene, clip: { ...MEASURED, seconds: 1.2 } } }))
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toMatch(/1\.2 seconds long/)
    withClip()
    useCreateStore.getState().setPrompt('  ')
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Describe the look of your scene.')
    useCreateStore.getState().setPrompt('a forest')
    useCreateStore.getState().setCloudOpModel('flux-3-video-edit')
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toMatch(/MP4 only/)
    useCreateStore.getState().setCloudOpModel('wan-3.0-video-edit')
    useCreateStore.setState((s) => ({ scene: { ...s.scene, frameBusy: true } }))
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toMatch(/first frame is still being made/)
    expect(hoisted.uploadInput).not.toHaveBeenCalled()
    expect(submitted).toHaveLength(0)
  })

  it('a server without the scene models says so instead of sending a classic job', async () => {
    useCloudCatalogStore.setState({ models: neuerServer().filter((m) => !['wan-3.0-video-edit', 'seedance-2.5-flash-video-edit', 'wan-2.1-vace', 'aleph-2', 'flux-3-video-edit'].includes(m.id)) })
    withClip()
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Scene to Video needs a newer LU Cloud. Try again later.')
    expect(submitted).toHaveLength(0)
  })

  it('never sends the Stage source of another tab', async () => {
    useCreateStore.setState({ source: { filename: 'other.png', url: 'data:image/png;base64,AA', width: 8, height: 8 } })
    withClip()
    await useCloudCreate().generate()
    expect(submitted[0].params.source_path).toBeUndefined()
    expect(hochgeladen).toEqual(['video'])
  })
})
