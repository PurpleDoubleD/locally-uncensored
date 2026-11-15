/**
 * Die Unterkategorien von Create schicken ein Studio-Modell richtig ab.
 *
 * Port aus the web app (the web app,
 * 19.09.2026): bis dahin war der Studio-Pfad allein im Preset-Fenster zu
 * Hause. Jetzt faehrt ihn auch der normale Composer/useCloudCreate, und daran
 * haengen vier Dinge, die still falsch sein koennen: der Op, die
 * Modelloptionen, und bei einem Clip aus der Galerie die Tatsache, dass der
 * Studio-Pfad ausschliesslich aus dem eigenen Eimer des Kunden liest und
 * keine signierte Adresse annimmt.
 *
 * Abweichung vom Web-Original: das Web kennt eine eigene 'video_upscale'-
 * Absicht (lib/render/create-studio.ts, StudioIntent), die im Desktop-
 * createStore noch nicht existiert (P2-Bericht, "offen fuer P9", P5/P7
 * muessen erst entscheiden, wie sie den Composer erreicht). Der Fall "legt
 * den Galerieclip in den eigenen Eimer" ist deshalb auf die Absicht 'extend'
 * umgestellt: dieselbe Mechanik (ein Clip, der als signierte Adresse
 * vorliegt, geht als HOCHGELADENER Pfad hinaus, nie als Adresse) laesst sich
 * darueber genauso beweisen, ohne eine Absicht vorwegzunehmen, die diesem
 * Paket nicht gehoert.
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

// Review A1/B3 (Runde 2): useCloudCreate now quotes a Studio run right
// before booking (see useCloudCreate.ts, the "Confirming the price…" step)
// and uses that number as max_credits. A fixed 42 keeps every existing
// assertion below about the OTHER params fields unaffected; the dedicated
// max_credits/quote_changed behavior gets its own tests further down.
vi.mock('../../api/cloud/studio', () => ({
  studioQuote: hoisted.studioQuote,
  StudioQuoteChangedError: hoisted.FakeQuoteChangedError,
}))

import { useCloudCreate } from '../useCloudCreate'
import { useCreateStore } from '../../stores/createStore'
import { useCloudCatalogStore } from '../../stores/cloudCatalogStore'
import { neuerServer } from '../../lib/render/__tests__/fixtures/test-catalogs'

const BILD = { filename: 'portrait.png', url: 'data:image/png;base64,AA', width: 512, height: 512 }
const TON = { name: 'voice.mp3', url: 'blob:voice', blob: new Blob(['x']) }

beforeEach(() => {
  submitted.length = 0
  hochgeladen.length = 0
  hoisted.studioQuote.mockClear()
  hoisted.studioQuote.mockResolvedValue({ credits: 42 })
  hoisted.submitCloudJob.mockClear()
  hoisted.submitCloudJob.mockImplementation(async (payload: (typeof submitted)[number]) => {
    submitted.push(payload)
    return { id: 'job-test', quota: { cost: 1000, used: 1000, limit: 100000 } }
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x']) })))
  useCreateStore.setState({
    isGenerating: false, error: null, backend: 'cloud',
    source: null, audioInput: null, videoInput: null, voiceFromJob: null,
    extendSource: null, gallery: [], cloudStudioOptions: {},
    // Review A kleiner Punkt 1 (Runde 3): explicit per test below, null here
    // so a leftover value from one test cannot leak a false block/pass into
    // the next.
    cloudStudioCredits: null,
  })
  useCreateStore.getState().setPrompt('a neutral placeholder line')
  // Review B1: this whole file simulates a server that already knows Studio
  // (that is what every test here submits against). Without `quote_required`
  // on the live catalog, `resolveIntentPick` would fall back to a CLASSIC
  // member for every one of these role intents (create-studio.test.ts has
  // the dedicated fallback coverage for the opposite state).
  useCloudCatalogStore.setState({ models: neuerServer() })
})

describe('Studio-Modelle in den Create-Unterkategorien', () => {
  it('schickt einen sprechenden Avatar als Studio-Lauf mit Foto und Tonspur', async () => {
    const s = useCreateStore.getState()
    s.setIntent('lipsync')
    s.setCloudOpModel('longcat-avatar')
    s.setCloudStudioOptions({ resolution: '720p' })
    useCreateStore.setState({ source: BILD, audioInput: TON })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].model).toBe('longcat-avatar')
    expect(submitted[0].kind).toBe('video')
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.studio_options).toEqual({ resolution: '720p' })
    expect(submitted[0].params.source_path).toBe('user-1/staged-source.png')
    expect(submitted[0].params.audio_path).toBe('user-1/staged-audio.mp3')
  })

  it('laesst den Presenter ohne eigenes Foto starten', async () => {
    const s = useCreateStore.getState()
    s.setIntent('lipsync')
    s.setCloudOpModel('heygen-twin')
    useCreateStore.setState({ source: null, audioInput: TON })
    await useCloudCreate().generate()
    expect(useCreateStore.getState().error).toBeNull()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.audio_path).toBe('user-1/staged-audio.mp3')
  })

  it('wirft einen Rest aus einem anderen Modell weg, statt ihn mitzuschicken', async () => {
    const s = useCreateStore.getState()
    s.setIntent('lipsync')
    s.setCloudOpModel('longcat-avatar')
    // target_megapixels gehoert dem Upscaler, nicht diesem Endpunkt.
    s.setCloudStudioOptions({ resolution: '480p', target_megapixels: 33 })
    useCreateStore.setState({ source: BILD, audioInput: TON })
    await useCloudCreate().generate()
    expect(submitted[0].params.studio_options).toEqual({ resolution: '480p' })
  })

  it('legt einen fertigen Clip in den eigenen Eimer, statt eine Adresse weiterzureichen', async () => {
    const s = useCreateStore.getState()
    s.setIntent('extend')
    s.setCloudOpModel('preset-wan-2.2-spicy-extend')
    s.setCloudStudioOptions({})
    useCreateStore.setState({ extendSource: { jobId: 'quelle', url: 'https://storage.example/clip.mp4', label: 'clip' } })
    await useCloudCreate().generate()
    expect(submitted).toHaveLength(1)
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].params.video_path).toBe('user-1/staged-video.mp4')
    // Genau das darf NICHT passieren: der Studio-Pfad liest keine Adressen.
    expect(submitted[0].params.source_url).toBeUndefined()
  })

  it('schickt bei Musik keine Felder aus unserer eigenen Preistabelle mit', async () => {
    const s = useCreateStore.getState()
    s.setIntent('music')
    s.setCloudOpModel('eleven-music')
    s.setCloudStudioOptions({})
    await useCloudCreate().generate()
    expect(submitted[0].params.op).toBe('studio')
    expect(submitted[0].kind).toBe('audio')
    expect(submitted[0].params.duration).toBeUndefined()
  })

  it('laesst eine klassische Wahl unveraendert ihren alten Weg gehen', async () => {
    const s = useCreateStore.getState()
    s.setIntent('music')
    // ACE-Step (fast) hat das Web am 24.10.2026 zurueckgezogen
    // (retired-models.ts); ACE-Step 1.5 ist die klassische Musikwahl seither.
    s.setCloudOpModel('ace-step-1.5')
    await useCloudCreate().generate()
    expect(submitted[0].model).toBe('ace-step-1.5')
    expect(submitted[0].params.op).toBe('music')
    expect(submitted[0].params.duration).toBeDefined()
    expect(submitted[0].params.studio_options).toBeUndefined()
  })

  it('sendet einen UUID-Idempotenzschluessel bei jedem Absenden', async () => {
    const s = useCreateStore.getState()
    s.setIntent('music')
    s.setCloudOpModel('ace-step')
    await useCloudCreate().generate()
    expect(submitted[0].params.client_request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  // Review A1/B3: das war der eigentliche Blocker beider Urteile. Der
  // normale Create-Weg bucht jetzt nie mehr ohne einen server-bestaetigten
  // Deckel, egal ob das Modell nach Ausgabe oder nach Eingabe abrechnet.
  describe('bucht einen Studio-Lauf nur gegen eine bestaetigte Zahl (Review A1/B3)', () => {
    it('holt vor der Buchung eine frische Quote und schickt sie als max_credits', async () => {
      hoisted.studioQuote.mockResolvedValueOnce({ credits: 7654 })
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      useCreateStore.setState({ source: null, audioInput: TON })
      await useCloudCreate().generate()
      expect(hoisted.studioQuote).toHaveBeenCalledTimes(1)
      expect(hoisted.studioQuote.mock.calls[0][0]).toBe('heygen-twin')
      expect(submitted).toHaveLength(1)
      expect(submitted[0].params.max_credits).toBe(7654)
      expect(submitted[0].params.client_request_id).toBeDefined()
    })

    it('bucht price.mode input/both Modelle (die 17, review-studio-B.md B3) ebenso gegen eine bestaetigte Zahl', async () => {
      hoisted.studioQuote.mockResolvedValueOnce({ credits: 180000 })
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('infinitetalk') // price.mode: 'input', review B3's exact example family
      useCreateStore.setState({ source: BILD, audioInput: TON })
      await useCloudCreate().generate()
      expect(hoisted.studioQuote).toHaveBeenCalledTimes(1)
      expect(submitted[0].params.max_credits).toBe(180000)
    })

    it('zeigt bei einer veralteten Quote den neuen Preis und bucht NICHT still nach', async () => {
      hoisted.studioQuote.mockRejectedValueOnce(new hoisted.FakeQuoteChangedError('The price has changed.', 9999))
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      useCreateStore.setState({ source: null, audioInput: TON })
      await useCloudCreate().generate()
      expect(submitted).toHaveLength(0)
      expect(useCreateStore.getState().error).toContain('9,999')
    })

    it('zeigt bei einer 409 quote_changed BEIM BUCHEN (nicht bei der Quote) den neuen Preis, statt still neu zu buchen', async () => {
      hoisted.submitCloudJob.mockRejectedValueOnce(new hoisted.FakeQuoteChangedError('The price has changed.', 5150))
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      useCreateStore.setState({ source: null, audioInput: TON })
      await useCloudCreate().generate()
      expect(useCreateStore.getState().error).toContain('5,150')
      // The dead branch B1/B3 flagged is alive now: submitCloudJob was
      // actually called (with a max_credits ceiling from the earlier, still
      // successful quote call) and ITS OWN 409 surfaced, instead of the call
      // never happening because max_credits was absent.
      expect(hoisted.submitCloudJob).toHaveBeenCalledTimes(1)
      expect(hoisted.submitCloudJob.mock.calls[0][0].params.max_credits).toBe(42)
    })

    it('bucht nie fuer eine klassische (nicht-Studio) Wahl gegen eine Quote', async () => {
      const s = useCreateStore.getState()
      s.setIntent('music')
      s.setCloudOpModel('ace-step')
      await useCloudCreate().generate()
      expect(hoisted.studioQuote).not.toHaveBeenCalled()
      expect(submitted[0].params.max_credits).toBeUndefined()
    })
  })

  // Review A kleiner Punkt 1 (Runde 2 report, geschlossen Runde 3): the cap
  // must be the number the customer actually SAW (cloudStudioCredits, what
  // CreditsMeter/the Composer meter rendered), not just any server-confirmed
  // number. A confirmed quote coming back HIGHER than the shown price is
  // treated exactly like a 409 quote_changed: new price shown, nothing
  // booked, a second click required. LOWER or equal books directly, same as
  // before, since the customer never sees a bigger bill than they were shown.
  describe('der Deckel ist die GEZEIGTE Zahl, nicht nur eine bestaetigte (Review A kleiner Punkt 1, Runde 3)', () => {
    it('bucht NICHT, wenn die Quote hoeher ausfaellt als der zuletzt gezeigte Preis', async () => {
      hoisted.studioQuote.mockResolvedValueOnce({ credits: 9000 })
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      s.setCloudStudioCredits(5000) // was gerade im Zaehler stand
      useCreateStore.setState({ source: null, audioInput: TON })
      await useCloudCreate().generate()
      expect(submitted).toHaveLength(0)
      expect(useCreateStore.getState().error).toContain('9,000')
    })

    // Review B6 (Runde 4, 20.09.2026): the previous test used
    // `mockResolvedValueOnce`, so a SECOND call to studioQuote would have
    // hit the default `{ credits: 42 }` mock from beforeEach, hiding a bug
    // where the rejection never re-primes cloudStudioCredits. A DETERMINISTIC
    // mock (mockResolvedValue, the real provider returns the same number for
    // the same inputs) proves the second click actually books: a fix that
    // never updates cloudStudioCredits in the rejection branch would show
    // the exact same rejected error on click two, zero bookings, three
    // quote calls for three clicks, which is exactly what Opus B measured
    // against the un-fixed code.
    it('ein zweiter Klick nach der Ablehnung bucht mit der neuen Zahl (Review B6, deterministische Quote)', async () => {
      hoisted.studioQuote.mockResolvedValue({ credits: 9000 })
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      s.setCloudStudioCredits(5000)
      useCreateStore.setState({ source: null, audioInput: TON })

      await useCloudCreate().generate()
      expect(submitted).toHaveLength(0)
      expect(useCreateStore.getState().error).toContain('9,000')
      // The rejection must have re-primed the comparison value, or the
      // second click fails exactly the same way.
      expect(useCreateStore.getState().cloudStudioCredits).toBe(9000)

      await useCloudCreate().generate()
      expect(submitted).toHaveLength(1)
      expect(submitted[0].params.max_credits).toBe(9000)
      expect(hoisted.studioQuote).toHaveBeenCalledTimes(2)
    })

    it('bucht direkt, wenn die Quote GLEICH dem gezeigten Preis ist', async () => {
      hoisted.studioQuote.mockResolvedValueOnce({ credits: 5000 })
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      s.setCloudStudioCredits(5000)
      useCreateStore.setState({ source: null, audioInput: TON })
      await useCloudCreate().generate()
      expect(submitted).toHaveLength(1)
      expect(submitted[0].params.max_credits).toBe(5000)
    })

    it('bucht direkt, wenn die Quote NIEDRIGER ist als der gezeigte Preis', async () => {
      hoisted.studioQuote.mockResolvedValueOnce({ credits: 4200 })
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      s.setCloudStudioCredits(5000)
      useCreateStore.setState({ source: null, audioInput: TON })
      await useCloudCreate().generate()
      expect(submitted).toHaveLength(1)
      expect(submitted[0].params.max_credits).toBe(4200)
    })

    it('bucht direkt, wenn noch nie ein Preis gezeigt wurde (cloudStudioCredits null)', async () => {
      hoisted.studioQuote.mockResolvedValueOnce({ credits: 60000 })
      const s = useCreateStore.getState()
      s.setIntent('lipsync')
      s.setCloudOpModel('heygen-twin')
      s.setCloudStudioCredits(null)
      useCreateStore.setState({ source: null, audioInput: TON })
      await useCloudCreate().generate()
      expect(submitted).toHaveLength(1)
      expect(submitted[0].params.max_credits).toBe(60000)
    })
  })
})
