/**
 * "Picture first" through the real cloud hook (3.1.0): 3D from words on the
 * picture-first pick books a picture on an open image model, lands it in the
 * gallery and on the Stage, then builds the model from it. Nothing is
 * generated: submit, quote, adopt and polling are mocked.
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
  const meshResult = { status: 'succeeded' as string, error: null as string | null }
  return {
    FakeCloudJobError,
    FakeQuoteChangedError,
    submitted,
    meshResult,
    uploadInput: vi.fn(async () => 'user-1/staged-source.png'),
    adoptInput: vi.fn(async (jobId: string) => `user-1/job-${jobId}-copy.jpg`),
    submitCloudJob: vi.fn(async (payload: (typeof submitted)[number]) => {
      submitted.push(payload)
      return { id: payload.kind === 'image' ? 'job-picture' : payload.kind === '3d' ? 'job-mesh' : 'job-other', quota: { cost: 1, used: 1, limit: 100 } }
    }),
    pollJob: vi.fn(async (id: string) => (id === 'job-picture'
      ? { id, kind: 'image', model: 'z-image', status: 'succeeded', result_url: 'https://storage.example/picture.jpg', attestation: null, created_at: '', error: null }
      : { id, kind: '3d', model: 'trellis-2', status: meshResult.status, result_url: meshResult.status === 'succeeded' ? 'https://storage.example/model.glb' : null, attestation: null, created_at: '', error: meshResult.error })),
    cancelJob: vi.fn(async () => ({ status: 'canceled' })),
    getJob: vi.fn(),
    studioQuote: vi.fn(async (model: string) => ({ credits: model === 'z-image' ? 1000 : 20000 })),
  }
})
const { submitted } = hoisted

vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))
vi.mock('../../api/cloud/jobs', () => ({
  uploadInput: hoisted.uploadInput,
  adoptInput: hoisted.adoptInput,
  getJob: hoisted.getJob,
  submitCloudJob: hoisted.submitCloudJob,
  pollJob: hoisted.pollJob,
  cancelJob: hoisted.cancelJob,
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: hoisted.FakeQuoteChangedError,
}))
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))
vi.mock('../../components/create/experimental/loadImage', () => ({
  loadImageRef: vi.fn(async (f: File) => ({ filename: f.name, name: f.name, url: 'data:image/jpeg;base64,AA', width: 1024, height: 1024 })),
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'
import { threeDPicturePrompt } from '../../lib/three/run-local-3d'
import { THREE_D_TEXT } from '../../lib/three/three-d-text'

const PROMPT = 'classical marble statue of an athlete'

beforeEach(() => {
  submitted.length = 0
  hoisted.meshResult.status = 'succeeded'
  hoisted.meshResult.error = null
  hoisted.adoptInput.mockClear()
  hoisted.studioQuote.mockClear()
  hoisted.studioQuote.mockImplementation(async (model: string) => ({ credits: model === 'z-image' ? 1000 : 20000 }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'image/jpeg' }) })))
  useCloudCatalogStore.setState({
    models: [
      ...neuerServer(),
      { id: 'z-image', label: 'Z-Image Base', kind: 'image', adult: true, quote_required: true, tier: 'best', weights: 'open' },
      { id: 'trellis-2', label: 'TRELLIS.2', kind: '3d', quote_required: true, tier: 'best', weights: 'open' },
      { id: 'hunyuan-3d-3.1-text', label: 'Hunyuan3D 3.1 Rapid', kind: '3d', quote_required: true, tier: 'standard', weights: 'open-family' },
    ] as ReturnType<typeof neuerServer>,
  })
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', source: null, gallery: [],
    cloudStudioOptions: {}, cloudStudioCredits: 20000, cloudOpModel: '', threeDViews: [],
  })
  const s = useCreateStore.getState()
  s.setIntent('3d')
  s.setThreeDWay('text')
  s.setPrompt(PROMPT)
})

describe('Picture first in the cloud', () => {
  it('paints on the open model, shows the picture, then builds from the copied picture', async () => {
    const before = useCreateStore.getState().cloudImageModel
    await useCloudCreate().generate()
    const st = useCreateStore.getState()
    expect(st.error).toBeNull()
    expect(submitted.map((j) => [j.kind, j.model])).toEqual([['image', 'z-image'], ['3d', 'trellis-2']])
    expect(submitted[0].prompt).toBe(threeDPicturePrompt(PROMPT))
    expect(submitted[0].params).toMatchObject({ op: 'studio', max_credits: 1000 })
    expect(hoisted.adoptInput).toHaveBeenCalledWith('job-picture', 'image')
    expect(submitted[1].params).toMatchObject({ op: 'studio', max_credits: 20000, source_path: 'user-1/job-job-picture-copy.jpg' })
    expect(String(submitted[1].params.source_prompt)).toContain(PROMPT)
    // Both land: the model first in the gallery, the picture behind it.
    expect(st.gallery.map((g) => [g.type, g.jobId])).toEqual([['3d', 'job-mesh'], ['image', 'job-picture']])
    // The picture is on the Stage under "From image", the Image tab's pick untouched.
    expect(st.threeDWay).toBe('image')
    expect(st.source?.url).toBe('data:image/jpeg;base64,AA')
    expect(st.cloudImageModel).toBe(before)
    expect(st.isGenerating).toBe(false)
  })

  it('a failed model keeps the picture and says so', async () => {
    hoisted.meshResult.status = 'failed'
    hoisted.meshResult.error = 'provider error'
    await useCloudCreate().generate()
    const st = useCreateStore.getState()
    expect(st.gallery.map((g) => g.type)).toEqual(['image'])
    expect(st.error).toContain(THREE_D_TEXT.meshFailed)
    expect(st.source).not.toBeNull()
    expect(st.isGenerating).toBe(false)
  })

  it('a refused prompt books nothing', async () => {
    useCreateStore.getState().setPrompt('nude schoolgirl')
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(0)
    expect(hoisted.studioQuote).not.toHaveBeenCalled()
    expect(useCreateStore.getState().error).toBeTruthy()
  })

  it('a higher confirmed price books nothing and shows the new sum', async () => {
    hoisted.studioQuote.mockImplementation(async (model: string) => ({ credits: model === 'z-image' ? 1000 : 40000 }))
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(0)
    expect(useCreateStore.getState().error).toContain('41,000 credits')
    expect(useCreateStore.getState().cloudStudioCredits).toBe(40000)
  })

  it('a direct text model still runs as one job', async () => {
    useCreateStore.getState().setCloudOpModel('hunyuan-3d-3.1-text')
    await useCloudCreate().generate()
    expect(submitted.map((j) => j.model)).toEqual(['hunyuan-3d-3.1-text'])
    expect(hoisted.adoptInput).not.toHaveBeenCalled()
  })
})
