/**
 * Fund M4 (05.10.2026, Vorlage: the web app):
 * eine Ansicht ohne Promptfeld schickt
 * keinen Prompt. Der Speicher haelt einen einzigen Prompt fuer alle
 * Unterkategorien. Talking Character und Motion Control zeigten kein Feld und
 * schickten trotzdem den Text mit, der noch aus dem Bild-Tab dort stand.
 *
 * Nichts wird erzeugt: Absenden, Hochladen und Abholen sind gemockt.
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
  CloudJobError: hoisted.FakeCloudJobError,
  QuoteChangedError: hoisted.FakeQuoteChangedError,
}))

// A Studio run confirms its price right before booking (useCloudCreate.ts,
// the "Confirming the price…" step). The quote is asked with the run's prompt.
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore, type CreateIntent } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'
import { INTENTS, intentTakesPrompt } from '../../components/create/experimental/intents'
import { intentPickerModels } from '../../lib/render/create-studio'
import { STUDIO_MODELS, studioSchema } from '../../lib/render/studio-contract'

const BILD = { filename: 'portrait.png', url: 'data:image/png;base64,AA', width: 512, height: 512 }
const TON = { name: 'voice.mp3', url: 'blob:voice', blob: new Blob(['x']) }
const CLIP = { name: 'drive.mp4', url: 'blob:drive', blob: new Blob(['x']) }
const REST = 'a neon-lit alley in the rain'

beforeEach(() => {
  submitted.length = 0
  hochgeladen.length = 0
  hoisted.studioQuote.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCloudCatalogStore.setState({ models: neuerServer() })
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud', improvePrompt: false,
    source: null, mask: null, audioInput: null, videoInput: null, voiceFromJob: null,
    extendSource: null, gallery: [], cloudStudioOptions: {}, cloudStudioCredits: null, promptHistory: [],
    cloudOpModel: '', cloudOpPicks: {},
  })
  useCreateStore.getState().setIntent('image')
  useCreateStore.getState().setPrompt(REST)
})

describe('Ansichten ohne Promptfeld', () => {
  it('Talking Character schickt den Rest aus dem Bild-Tab nicht mit, klassisch und Studio', async () => {
    const { generate } = useCloudCreate()
    for (const model of ['infinitetalk-fast', 'seedance-2.5-avatar']) {
      submitted.length = 0
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel(model)
      useCreateStore.setState({ source: BILD, audioInput: TON })
      await generate()
      expect(useCreateStore.getState().error, model).toBeNull()
      expect(submitted, model).toHaveLength(1)
      expect(submitted[0].model, model).toBe(model)
      expect(submitted[0].prompt, model).toBe('')
      expect(JSON.stringify(submitted[0]), model).not.toContain(REST)
    }
    // Auch der Preis wird ohne den fremden Text bestaetigt.
    expect(hoisted.studioQuote.mock.calls.at(-1)?.[1]).toBe('')
  })

  it('Motion Control schickt ihn nicht mit', async () => {
    useCreateStore.getState().setIntent('motion')
    useCreateStore.setState({ source: BILD, videoInput: CLIP })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].prompt).toBe('')
  })

  it('Remove Background schickt ihn nicht mit und schreibt ihn nicht in den Verlauf', async () => {
    useCreateStore.getState().setIntent('removebg')
    useCreateStore.setState({ source: BILD })
    await useCloudCreate().generate()
    expect(submitted[0].prompt).toBe('')
    expect(useCreateStore.getState().promptHistory).not.toContain(REST)
  })

  it('ein Text, den die Pruefung ablehnt, haelt einen Lauf ohne Promptfeld nicht auf', async () => {
    useCreateStore.getState().setPrompt('a 12 year old girl, nude')
    useCreateStore.getState().setIntent('lipsync')
    useCreateStore.setState({ source: BILD, audioInput: TON })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].prompt).toBe('')
  })

  it('eine Ansicht mit Promptfeld schickt ihn weiter', async () => {
    useCreateStore.getState().setCloudImageModel('flux-schnell')
    await useCloudCreate().generate()
    expect(submitted[0].prompt).toBe(REST)
    expect(useCreateStore.getState().promptHistory).toContain(REST)
  })

  it('kein Studio-Modell einer Ansicht ohne Promptfeld verlangt einen Prompt', () => {
    // 3D has a prompt field "From text" only: its picture and video ways run
    // their own models (studioIntentOf), and those must not ask for words.
    const views = INTENTS.filter((m) => !intentTakesPrompt(m.id as CreateIntent))
      .flatMap((m) => (m.id === '3d' ? (['3d-image', '3d-video'] as const) : [m.id as CreateIntent]))
    for (const view of views) {
      const meta = { id: view }
      for (const m of intentPickerModels(view)) {
        const studio = STUDIO_MODELS[m.id]
        if (!studio) continue
        expect(studioSchema(m.id).required ?? [], `${meta.id} ${m.id}`).not.toContain(studio.promptField ?? 'prompt')
      }
    }
  })
})
