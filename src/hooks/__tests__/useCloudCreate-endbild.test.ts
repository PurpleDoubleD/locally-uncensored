/**
 * B38 (Discord 30.10.2026, thirdorbital): Animate in LU Cloud mit Start- UND
 * Endbild. Die Studio-Modelle mit last_image im Anbieter-Schema (Wan 3.0,
 * Seedance 2.5, LTX 2.5, MiniMax H3) bekommen das Endbild als
 * last_image_path, eigener Upload. Ein Modell ohne dieses Feld bekommt es nie.
 *
 * Nichts wird erzeugt: Absenden, Hochladen und Preisbestaetigung sind gemockt
 * (dieselbe Vorrichtung wie useCloudCreate-mehrere-bilder.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('react', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useCallback: (fn: unknown) => fn }
})

type Payload = { kind: string; model: string; prompt: string; params: Record<string, unknown> }
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
  class FakeQuoteChanged extends FakeCloudJobError {
    credits: number
    constructor(message: string, credits: number) {
      super(message, 409, { code: 'quote_changed' })
      this.credits = credits
    }
  }
  const plan = {
    booked: undefined as number | undefined,
    stopped: undefined as 'credits_exhausted' | 'error' | undefined,
    oldServer: false,
    outcome: {} as Record<string, 'succeeded' | 'failed'>,
    upload: 0,
    cancel409: new Set<string>(),
  }
  return {
    FakeCloudJobError,
    FakeQuoteChanged,
    plan,
    submitted: [] as Payload[],
    abgebrochen: [] as string[],
    hochgeladen: [] as string[],
    quote: vi.fn(async (..._a: unknown[]) => ({ credits: 5000 })),
  }
})
const { submitted, abgebrochen, hochgeladen, plan } = hoisted

vi.mock('../useContentPolicy', () => ({
  contentPolicySnapshot: () => 'off' as const,
  loadContentPolicy: async () => 'off' as const,
}))
vi.mock('../../api/cloud/jobs', () => ({
  uploadInput: vi.fn(async (_b: unknown, slot: string) => { hochgeladen.push(slot); return `user-1/staged-${slot}-${++plan.upload}.png` }),
  getJob: vi.fn(),
  cancelJob: vi.fn(async (id: string) => {
    if (plan.cancel409.has(id)) throw new hoisted.FakeCloudJobError('running', 409)
    abgebrochen.push(id)
    return { status: 'canceled' }
  }),
  submitCloudJob: vi.fn(async (payload: Payload) => {
    submitted.push(payload)
    const asked = (payload.params.count as number | undefined) ?? 1
    const booked = plan.booked ?? asked
    const ids = Array.from({ length: booked }, (_, i) => `job-${i}`)
    if (asked === 1 || plan.oldServer) return { id: ids[0], quota: { cost: 300 } }
    return {
      id: ids[0], quota: { cost: 300 },
      jobs: ids.map((id) => ({ id, status: 'queued', cost: 300 })), requested: asked,
      ...(plan.stopped ? { stopped: plan.stopped } : {}),
    }
  }),
  pollJob: vi.fn(async (id: string) => {
    const status = plan.outcome[id] ?? 'succeeded'
    return {
      id, kind: 'image', model: 'flux-schnell', status,
      result_url: status === 'succeeded' ? `https://storage.example/${id}.png` : null,
      error: status === 'failed' ? 'provider said no' : null,
      created_at: new Date().toISOString(), params: {},
    }
  }),
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: hoisted.FakeQuoteChanged,
}))
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.quote,
  StudioQuoteChangedError: hoisted.FakeQuoteChanged,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'

const BILD = { filename: 'a.png', url: 'data:image/png;base64,AA', width: 512, height: 512 }

beforeEach(() => {
  submitted.length = 0; abgebrochen.length = 0; hochgeladen.length = 0
  plan.booked = undefined; plan.stopped = undefined; plan.oldServer = false; plan.outcome = {}; plan.upload = 0; plan.cancel409.clear()
  hoisted.quote.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', source: null, mask: null, references: [],
    gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudImageCount: 1,
  })
  useCreateStore.getState().setPrompt('a neutral placeholder line')
  useCloudCatalogStore.setState({ models: neuerServer() })
})

const ENDE = { filename: 'z.png', url: 'data:image/png;base64,ZZ', width: 512, height: 512 }

describe('Animate mit Endbild', () => {
  it('Wan 3.0 bekommt Start- und Endbild, das Endbild als eigener Upload', async () => {
    const s = useCreateStore.getState()
    s.setIntent('animate'); s.setCloudVideoModel('wan-3.0')
    useCreateStore.setState({ source: BILD, endImage: ENDE })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted[0].model).toBe('wan-3.0')
    expect(submitted[0].params.source_path).toBe('user-1/staged-source-1.png')
    expect(submitted[0].params.last_image_path).toBe('user-1/staged-source-2.png')
    expect(hochgeladen).toHaveLength(2)
    // Die bestaetigte Zahl kennt das Endbild auch.
    expect((hoisted.quote.mock.calls[0][2] as { last_image_path?: string }).last_image_path).toBe('user-1/staged-source-2.png')
  })

  it('ohne Endbild bleibt es beim Startbild (Rueckfall-Waechter)', async () => {
    const s = useCreateStore.getState()
    s.setIntent('animate'); s.setCloudVideoModel('wan-3.0')
    useCreateStore.setState({ source: BILD, endImage: null })
    await useCloudCreate().generate()
    expect(submitted[0].params.last_image_path).toBeUndefined()
    expect(hochgeladen).toHaveLength(1)
  })

  it('ein Referenzmodell ohne last_image bekommt kein Endbild', async () => {
    const s = useCreateStore.getState()
    s.setIntent('animate'); s.setCloudVideoModel('minimax-h3-ref')
    useCreateStore.setState({ source: BILD, endImage: ENDE, references: [] })
    await useCloudCreate().generate()
    expect(submitted[0].params.last_image_path).toBeUndefined()
  })
})
