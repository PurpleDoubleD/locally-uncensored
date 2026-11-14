/**
 * Sound in Swap and Motion (14.11.2026, port of the web's useCloudCreate-ton):
 * what the video run sends, and the lip sync step after it. Nothing is
 * rendered or booked: upload, adopt, quote, submit and poll are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

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
  const steps: string[] = []
  const lipOutcome = { status: 'succeeded' as 'succeeded' | 'failed', error: null as string | null }
  return {
    FakeCloudJobError,
    FakeQuoteChangedError,
    submitted,
    steps,
    lipOutcome,
    uploadInput: vi.fn(async (_blob: unknown, slot: string) => {
      steps.push(`upload ${slot}`)
      return `user-1/staged-${slot}`
    }),
    getJob: vi.fn(async (id: string) => ({ id, result_url: `https://storage.example/${id}.mp3` })),
    submitCloudJob: vi.fn(async (payload: (typeof submitted)[number]) => {
      submitted.push(payload)
      return { id: `job-${submitted.length}` }
    }),
    pollJob: vi.fn(async (id: string) => {
      const lip = id === 'job-2'
      return {
        id, kind: 'video', model: lip ? 'latentsync' : 'scail-2',
        status: lip ? lipOutcome.status : 'succeeded',
        error: lip ? lipOutcome.error : null,
        result_url: lip && lipOutcome.status !== 'succeeded' ? null : `https://storage.example/${id}.mp4`,
        created_at: new Date().toISOString(),
      }
    }),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    adoptInput: vi.fn(async (jobId: string, role: string) => {
      steps.push(`adopt ${jobId} ${role}`)
      return `user-1/adopted-${jobId}-${role}`
    }),
    studioQuote: vi.fn(async () => ({ credits: 42 })),
  }
})
const { submitted, steps, lipOutcome } = hoisted

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
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))
// Clip 6.006 s, voice 9 s (no <video>/<audio> in node).
vi.mock('../../components/create/experimental/useStudioPrice', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  mediaSeconds: async (_url: string, kind: string) => (kind === 'audio' ? 9 : 6.006),
}))

import { useCloudCreate } from '../useCloudCreate'
import { swapKeyOf } from '../../lib/create/swap-frame'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'
import { LIPSYNC_ONE_PERSON } from '../../lib/render/sound'

const FOTO = { filename: 'face.png', url: 'data:image/png;base64,AA', width: 512, height: 768 }
const CLIP = { name: 'dance.mp4', url: 'blob:dance', blob: new Blob(['x'], { type: 'video/mp4' }) }
const VOICE = { name: 'voice.mp3', url: 'blob:voice', blob: new Blob(['a'], { type: 'audio/mpeg' }) }

function katalog() {
  return neuerServer().map((m) => (m.id === 'latentsync'
    ? { ...m, credits: { base: 9000, length: { basis: 'audio' as const, block: 1, per_block: 3000, min: 3, max: 300, quote: 10 } } }
    : m))
}

function swapReady(figures: Array<{ image: typeof FOTO; role: string; mark?: { x: number; y: number } }>) {
  useCreateStore.setState({
    videoInput: CLIP, swapConsent: true, swapFigures: figures,
    swapBuilt: { jobId: 'frame-1', url: 'https://x/f.jpg', key: swapKeyOf(CLIP.url, figures), confirmed: true },
  })
}

beforeEach(() => {
  submitted.length = 0
  steps.length = 0
  lipOutcome.status = 'succeeded'
  lipOutcome.error = null
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud',
    source: null, audioInput: null, videoInput: null, voiceFromJob: null,
    extendSource: null, gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudOpModel: '',
    sound: 'original', lipsyncModel: 'latentsync', lipsyncCredits: null,
  })
  useCloudCatalogStore.setState({ models: katalog() })
  useCreateStore.getState().setIntent('swap_character')
  useCreateStore.setState({ swapFigures: [{ image: null, role: '' }], swapSeconds: null, swapConsent: false, swapBuilt: null, swapFrame: null })
})

describe('Sound of the video run', () => {
  it('Swap sends the original sound by default', async () => {
    swapReady([{ image: FOTO, role: '' }])
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].params.sound).toBe('original')
  })

  it('No sound: sound none, and Kling gets keep_original_sound false', async () => {
    useCreateStore.getState().setCloudOpModel('kling-v3-pro-motion-control')
    useCreateStore.setState({ sound: 'none' })
    swapReady([{ image: FOTO, role: '' }])
    await useCloudCreate().generate()
    const p = submitted[0].params
    expect(p.sound).toBe('none')
    expect(p.studio_options).toEqual({ character_orientation: 'video', keep_original_sound: false })
    // The quote sees the same options.
    expect((hoisted.studioQuote.mock.calls.at(-1) as unknown[])[2]).toMatchObject({ studio_options: p.studio_options })
  })

  it('Motion on the cloud sends the sound, the local lane never reaches here', async () => {
    useCreateStore.getState().setIntent('motion')
    useCreateStore.setState({ source: FOTO as never, videoInput: CLIP })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted[0].params.sound).toBe('original')
  })
})

describe('New voice, lips in sync', () => {
  it('stops before any upload with two people, with the one person sentence', async () => {
    useCreateStore.setState({ sound: 'lipsync', audioInput: VOICE })
    swapReady([{ image: FOTO, role: '', mark: { x: 0.2, y: 0.5 } }, { image: FOTO, role: '', mark: { x: 0.8, y: 0.5 } }])
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe(`${LIPSYNC_ONE_PERSON}. Pick Original sound or remove the other people.`)
    expect(steps).toEqual([])
    expect(submitted).toHaveLength(0)
  })

  it('stops before any upload without a voice', async () => {
    useCreateStore.setState({ sound: 'lipsync' })
    swapReady([{ image: FOTO, role: '' }])
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Add the new voice: upload audio, make one, or pick an earlier voice.')
    expect(submitted).toHaveLength(0)
  })

  it('Swap: after the video, LatentSync on the own result with the uploaded voice, swap step lipsync with the tick', async () => {
    useCreateStore.setState({ sound: 'lipsync', audioInput: VOICE, lipsyncCredits: 18000 })
    swapReady([{ image: FOTO, role: '' }])
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(2)
    // The video run keeps the original sound until the second step.
    expect(submitted[0].params.sound).toBe('original')
    expect(submitted[0].params.audio_path).toBeUndefined()
    const lip = submitted[1]
    expect(lip.model).toBe('latentsync')
    expect(lip.params).toMatchObject({
      op: 'lipsync', video_path: 'user-1/adopted-job-1-video', audio_path: 'user-1/staged-audio',
      fit_audio: true, swap_step: 'lipsync', swap_consent: true, max_credits: 18000, label: 'Lip sync',
    })
    expect(steps).toEqual(['upload video', 'adopt frame-1 image', 'adopt job-1 video', 'upload audio'])
    // Both land in the gallery: the swap and the version with the new voice.
    const g = useCreateStore.getState().gallery
    expect(g.map((x) => x.model).sort()).toEqual(['latentsync', 'scail-2'])
  })

  it('Motion with an earlier voice: adopted, no swap step', async () => {
    useCreateStore.getState().setIntent('motion')
    useCreateStore.setState({ source: FOTO as never, videoInput: CLIP, sound: 'lipsync', voiceFromJob: { jobId: 'tts-9', label: 'Hello' } })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(2)
    const lip = submitted[1].params
    expect(lip.audio_path).toBe('user-1/adopted-tts-9-audio')
    expect(lip.swap_step).toBeUndefined()
    expect(lip.swap_consent).toBeUndefined()
    // 9 s voice on a 6.006 s clip: the voice is cut to the clip, LatentSync
    // bills every started second, 7 s at 3,000.
    expect(lip.max_credits).toBe(21000)
  })

  it('a failed lip sync keeps the swap in the gallery and says so', async () => {
    lipOutcome.status = 'failed'
    lipOutcome.error = 'no face found'
    useCreateStore.setState({ sound: 'lipsync', audioInput: VOICE })
    swapReady([{ image: FOTO, role: '' }])
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBe('Your video is in the gallery, but the lip sync failed: no face found. The lip sync was not charged.')
    expect(useCreateStore.getState().gallery.map((x) => x.model)).toEqual(['scail-2'])
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })
})
