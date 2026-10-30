/**
 * "Improve my prompt" im Cloud-Lauf (02.10.2026, Paritaet zu
 * the web app).
 *
 * Nichts wird erzeugt und nichts gesprochen: Absenden, Hochladen, Abholen,
 * Preisbestaetigung und der Chat-Aufruf sind gemockt.
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

const improve = vi.hoisted(() => ({
  calls: [] as { prompt: string; kind: string; label?: string }[],
  outcome: { status: 'improved', prompt: 'A rewritten prompt.' } as { status: string; prompt?: string },
  gate: null as Promise<void> | null,
}))
vi.mock('../../lib/render/improve-prompt-run', () => ({
  improvePrompt: vi.fn(async (prompt: string, target: { kind: string; modelLabel?: string }) => {
    improve.calls.push({ prompt, kind: target.kind, label: target.modelLabel })
    if (improve.gate) await improve.gate
    return improve.outcome
  }),
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { useModelStore } from '../../stores/modelStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'

beforeEach(() => {
  submitted.length = 0; abgebrochen.length = 0; hochgeladen.length = 0
  plan.booked = undefined; plan.stopped = undefined; plan.oldServer = false; plan.outcome = {}; plan.upload = 0; plan.cancel409.clear()
  hoisted.quote.mockClear()
  improve.calls.length = 0
  improve.outcome = { status: 'improved', prompt: 'A rewritten prompt.' }
  improve.gate = null
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', source: null, mask: null, references: [],
    gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, cloudImageCount: 1, improvePrompt: false,
  })
  useModelStore.setState({ activeModel: 'lu-cloud::glm-5.3' } as never)
  useCreateStore.getState().setPrompt('my own words')
  useCreateStore.getState().setIntent('image')
  useCreateStore.getState().setCloudImageModel('flux-schnell')
  useCloudCatalogStore.setState({ models: neuerServer() })
})

describe('Improve my prompt: Cloud (Desktop)', () => {
  it('ist aus: kein Aufruf, der Lauf nimmt den Prompt des Nutzers', async () => {
    await useCloudCreate().generate()
    expect(improve.calls).toHaveLength(0)
    expect(submitted[0].prompt).toBe('my own words')
    expect(useCreateStore.getState().gallery[0].promptOriginal).toBeUndefined()
  })

  it('ist an: der Lauf schickt die neue Fassung, die Galerie zeigt beide, das Prompt-Feld bleibt', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    await useCloudCreate().generate()
    expect(improve.calls).toEqual([{ prompt: 'my own words', kind: 'image', label: expect.any(String) }])
    expect(submitted[0].prompt).toBe('A rewritten prompt.')
    const item = useCreateStore.getState().gallery[0]
    expect(item.prompt).toBe('A rewritten prompt.')
    expect(item.promptOriginal).toBe('my own words')
    expect(item.rewrittenBy).toBe('glm-5.3')
    expect(item.improveFailed).toBeUndefined()
    expect(useCreateStore.getState().prompt).toBe('my own words')
    expect(useCreateStore.getState().error).toBeNull()
    // Der Verlauf merkt sich, was der Nutzer schrieb.
    expect(useCreateStore.getState().promptHistory[0]).toBe('my own words')
  })

  it('scheitert das Umschreiben, laeuft der Lauf mit dem Original und vermerkt es', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    improve.outcome = { status: 'failed' }
    await useCloudCreate().generate()
    expect(submitted[0].prompt).toBe('my own words')
    const item = useCreateStore.getState().gallery[0]
    expect(item.prompt).toBe('my own words')
    expect(item.promptOriginal).toBeUndefined()
    expect(item.improveFailed).toBe(true)
    expect(useCreateStore.getState().error).toBeNull()
  })

  it('kommt derselbe Text zurueck, bleibt der Lauf ohne Vermerk', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    improve.outcome = { status: 'unchanged' }
    await useCloudCreate().generate()
    expect(submitted[0].prompt).toBe('my own words')
    expect(useCreateStore.getState().gallery[0].improveFailed).toBeUndefined()
  })

  it('eine neue Fassung, die die Sicherheitsregel bricht, wird nicht geschickt', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    improve.outcome = { status: 'improved', prompt: 'a nude child on a beach' }
    await useCloudCreate().generate()
    expect(submitted[0].prompt).toBe('my own words')
    expect(useCreateStore.getState().gallery[0].improveFailed).toBe(true)
  })

  it('ein Video schreibt als Video um', async () => {
    const s = useCreateStore.getState()
    s.setImprovePrompt(true); s.setIntent('video'); s.setCloudVideoModel('wan-2.2-720p')
    await useCloudCreate().generate()
    expect(improve.calls[0].kind).toBe('video')
  })

  it('Bearbeiten schreibt als Anweisung um (B48)', async () => {
    const s = useCreateStore.getState()
    s.setImprovePrompt(true); s.setIntent('edit'); s.setCloudImageModel('qwen-image-2.1-edit')
    useCreateStore.setState({
      source: { filename: 'a.png', url: 'data:image/png;base64,AA', width: 512, height: 512 },
      mask: { filename: 'm.png', url: 'data:image/png;base64,AA', width: 512, height: 512 },
    })
    await useCloudCreate().generate()
    expect(improve.calls).toHaveLength(1)
    expect(improve.calls[0].kind).toBe('edit')
    expect(submitted[0].prompt).not.toBe('my own words')
  })

  it('Cancel waehrend des Umschreibens: nichts wird abgeschickt', async () => {
    useCreateStore.getState().setImprovePrompt(true)
    let open!: () => void
    improve.gate = new Promise<void>((r) => { open = r })
    const hook = useCloudCreate()
    const run = hook.generate()
    await new Promise((r) => setTimeout(r, 0))
    await hook.cancel()
    open()
    await run
    expect(submitted).toHaveLength(0)
    expect(useCreateStore.getState().isGenerating).toBe(false)
  })

  it('der Schalter ist standardmaessig aus und nimmt nur ein echtes true an', () => {
    useCreateStore.setState({ improvePrompt: false })
    expect(useCreateStore.getState().improvePrompt).toBe(false)
    useCreateStore.getState().setImprovePrompt('yes' as unknown as boolean)
    expect(useCreateStore.getState().improvePrompt).toBe(false)
  })
})

// Fund M1 (05.10.2026): bei Mureka Song ist das Textfeld der Liedtext.
// Die Umschreibung machte daraus eine Stilbeschreibung, und die wurde gesungen.
describe('Improve my prompt: Musik', () => {
  const LIED = '[Verse]\nmorning light on the kitchen floor'

  it('ein Liedtext wird nie umgeschrieben, auch wenn der Schalter an ist', async () => {
    const { generate } = useCloudCreate()
    const s = useCreateStore.getState()
    s.setIntent('music'); s.setCloudOpModel('mureka-song'); s.setPrompt(LIED)
    useCreateStore.setState({ improvePrompt: true })
    await generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(improve.calls).toHaveLength(0)
    expect(submitted[0].model).toBe('mureka-song')
    expect(submitted[0].prompt).toBe(LIED)
    expect(submitted[0].params.prompt_original).toBeUndefined()
  })

  it('eine Stilbeschreibung wird weiter umgeschrieben', async () => {
    const s = useCreateStore.getState()
    s.setIntent('music'); s.setCloudOpModel('eleven-music'); s.setPrompt('slow jazz, upright bass')
    useCreateStore.setState({ improvePrompt: true })
    await useCloudCreate().generate()
    expect(improve.calls).toHaveLength(1)
    expect(improve.calls[0].kind).toBe('music')
    expect(submitted[0].prompt).toBe('A rewritten prompt.')
  })
})
