/**
 * One click swap (14.11.2026, port of the web's buildSwapVideoSubmit,
 * 4395e8d1): the video job the chain sends after the frame step. Built from
 * the store like a Create run of Swap Character, without its image, with
 * swap_step 'video', the consent, the sound and the shown price as ceiling.
 * The gate: without the account switch nothing is built and nothing goes up.
 * Nothing is rendered or booked: upload, adopt, quote, submit are mocked.
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

import { buildSwapVideoSubmit } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { useCharacterHubReleaseStore } from '../../lib/create/character-hub-release'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'

const FOTO = { filename: 'face.png', url: 'data:image/png;base64,AA', width: 512, height: 768 }
const CLIP = { name: 'dance.mp4', url: 'blob:dance', blob: new Blob(['x'], { type: 'video/mp4' }) }

function katalog() {
  return neuerServer().map((m) => (m.id === 'latentsync'
    ? { ...m, credits: { base: 9000, length: { basis: 'audio' as const, block: 1, per_block: 3000, min: 3, max: 300, quote: 10 } } }
    : m))
}

beforeEach(() => {
  // An account the server released the Character area for (features.characterHub).
  useCharacterHubReleaseStore.setState({ fromMe: true, fromCatalog: null })
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

const MARKED = [{ image: FOTO, role: '', mark: { x: 0.3, y: 0.4 } }, { image: FOTO, role: 'the man in grey', mark: { x: 0.7, y: 0.4 } }]

function ready(model = 'scail-2', figures = MARKED) {
  useCreateStore.getState().setCloudOpModel(model)
  useCreateStore.setState({ videoInput: CLIP, swapConsent: true, swapFigures: figures, cloudStudioCredits: 48000 })
}

describe('the video job of the chain', () => {
  it('SCAIL 2: swap_step video, the consent, the length, the sound, the shown price; no photos, no frame yet', async () => {
    ready()
    const submit = await buildSwapVideoSubmit('scail-2')
    expect(submit.model).toBe('scail-2')
    expect(submit.kind).toBe('video')
    const p = submit.params as unknown as Record<string, unknown>
    expect(p.op).toBe('studio')
    expect(p.swap_step).toBe('video')
    expect(p.swap_consent).toBe(true)
    expect(p.sound).toBe('original')
    expect(p.max_credits).toBe(48000)
    expect(p.clip_seconds).toBe(6)
    expect(p.video_path).toBe('user-1/staged-video')
    expect(p.label).toBe('Swap Character')
    expect(p.source_path).toBeUndefined()
    expect(p.image_paths).toBeUndefined()
    expect(p.studio_options).toMatchObject({ mode: 'replace', resolution: '720p' })
    // Only the video went up; the photos go into the frame step.
    expect(steps).toEqual(['upload video'])
    expect(submitted).toHaveLength(0)
  })

  it('No sound goes with the job, Kling gets keep_original_sound false', async () => {
    ready('kling-v3-pro-motion-control', [MARKED[0]])
    useCreateStore.setState({ sound: 'none' })
    const p = (await buildSwapVideoSubmit('kling-v3-pro-motion-control')).params as unknown as Record<string, unknown>
    expect(p.sound).toBe('none')
    expect(p.studio_options).toMatchObject({ keep_original_sound: false })
  })

  it('a new voice with two people is refused before anything goes up', async () => {
    ready()
    useCreateStore.setState({ sound: 'lipsync' })
    await expect(buildSwapVideoSubmit('scail-2')).rejects.toThrow()
    expect(steps).toEqual([])
  })

  it('without the account switch: Coming soon, nothing goes up', async () => {
    useCharacterHubReleaseStore.setState({ fromMe: false, fromCatalog: null })
    ready()
    await expect(buildSwapVideoSubmit('scail-2')).rejects.toThrow('Swap Character is coming soon to your LU Cloud.')
    expect(steps).toEqual([])
  })

  it('without the video nothing is built', async () => {
    ready()
    useCreateStore.setState({ videoInput: null })
    await expect(buildSwapVideoSubmit('scail-2')).rejects.toThrow('Add the original video first.')
  })
})
