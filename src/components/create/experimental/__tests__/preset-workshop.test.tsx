// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PresetWorkshop } from '../PresetWorkshop'
import { PresetShelf } from '../PresetShelf'
import { Modal } from '../../../ui/Modal'
import { STUDIO_MODELS, studioPreviewCredits } from '../../../../lib/render/studio-contract'
import { CREATE_PRESETS, type CreatePreset } from '../../../../lib/render/create-presets'
import { presetModels } from '../../../../lib/render/preset-models'
import { promptIdeas } from '../../../../lib/render/prompt-ideas'
import { useCreateStore } from '../../../../stores/createStore'
import { useCloudCatalogStore } from '../../../../stores/cloudCatalogStore'
import { CLOUD_MODEL_SEED, type CloudModel } from '../../../../lib/render/cloud-models'
import { neuerServer } from '../../../../lib/render/__tests__/fixtures/test-catalogs'
import { sortByTier } from '../../../../lib/render/model-tier'
import { CloudJobError } from '../../../../api/cloud/client'
import { QuoteChangedError } from '../../../../api/cloud/jobs'
import { StudioQuoteChangedError } from '../../../../api/cloud/studio'

// Portiert aus uselu apps/web/components/create/experimental/__tests__/
// preset-workshop.test.tsx (Quelle: cloud-create-presets-20260919). Desktop-
// Anpassungen (P6):
//  - kein Handy-Zweig: `ShelfMitZustand` haelt weiterhin nur den Auf-Zu-
//    Zustand der Schiene fuer den Aufrufer, jetzt ohne die MobileCreateTools-
//    Begruendung.
//  - `studioQuote()`/`modelRuntimes()` (P3, src/api/cloud/studio.ts) statt
//    rohem `fetch('/api/jobs/studio-quote')`/`fetch('/api/jobs/runtime')`;
//    `uploadInput`/`submitCloudJob`/`pollJob`/`getJob`/`cancelJob` aus
//    src/api/cloud/jobs.ts statt aus einer Web-eigenen cloud-jobs.ts. Der
//    globale `fetch`-Stub bleibt nur fuer das Herunterladen eines VORIGEN
//    Ergebnisses (adopt()) stehen: das ist ein signierter S3-Link, keine
//    Cloud-API-Route, und blieb im Web genauso ein blosses `fetch`.
//  - neue Faelle unten: die Schiene erscheint nur auf der Wolken-Spur UND nur,
//    wenn der Katalog `quote_required` fuehrt (Portplan Abschnitt 5/P6-
//    Auftrag); ein Server ohne Studio sperrt den Start mit dem festen Satz;
//    ein 409 beim Buchen zeigt den neuen Preis statt still neu zu buchen.

function ShelfMitZustand(props: Omit<Parameters<typeof PresetShelf>[0], 'open' | 'onOpenChange'>) {
  const [offen, setOffen] = useState(false)
  return <PresetShelf {...props} open={offen} onOpenChange={setOffen} />
}

/** Dieselbe Sperrklinke wie in CreateExperimental.tsx: ein `Modal` um die
 *  Werkstatt, nichts Eigenes daneben. Testet die Verdrahtung, nicht die
 *  ganze Buehne (die haengt an ComfyUI/Cloud-Kontext weit ueber diese Datei
 *  hinaus). */
function WerkstattFenster({ preset, onClosed }: { preset: CreatePreset; onClosed?: () => void }) {
  const [open, setOpen] = useState(true)
  const close = () => { setOpen(false); onClosed?.() }
  return (
    <Modal open={open} onClose={close} title={preset.title} maxWidth="max-w-4xl" panelPad="p-0">
      <div className="flex h-[min(600px,90vh)] flex-col overflow-hidden">
        <PresetWorkshop preset={preset} onGenerate={() => {}} onClose={close} />
      </div>
    </Modal>
  )
}

// P2-Befund (studio-p2.md, "Preisluecken im Notvorrat"): `flux-schnell` und
// `wan-2.2-720p` fuehren im statischen Notvorrat bis heute KEIN `credits`-
// Feld. Im echten Betrieb heilt das die erste Katalogaktualisierung, hier
// braucht es einen Preis, damit die klassischen Faelle unten (Modellwechsel,
// Frames/Fps) ueberhaupt einen bestaetigbaren Preis sehen.
const QUOTE_REQUIRED_CATALOG: CloudModel[] = neuerServer().map((m) =>
  m.id === 'flux-schnell' ? { ...m, credits: { base: 300 } }
    : m.id === 'wan-2.2-720p' ? { ...m, credits: { base: 5000, long: 8000 } }
      : m)

const mocks = vi.hoisted(() => ({
  submit: vi.fn(), poll: vi.fn(), refresh: vi.fn(), upload: vi.fn(), getJob: vi.fn(), cancel: vi.fn(),
  quote: vi.fn(), runtimes: vi.fn(),
}))
vi.mock('../CreateContext', () => ({ useCreateExp: () => ({ refreshQuota: mocks.refresh }) }))
vi.mock('../../../../api/cloud/jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/cloud/jobs')>()),
  submitCloudJob: mocks.submit, pollJob: mocks.poll, uploadInput: mocks.upload, getJob: mocks.getJob, cancelJob: mocks.cancel,
}))
vi.mock('../../../../api/cloud/studio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/cloud/studio')>()),
  studioQuote: mocks.quote, modelRuntimes: mocks.runtimes,
}))

// jsdom kennt keinen ResizeObserver; `Select` (P4/Bestand) braucht ihn nur,
// um die Menuegroesse an offenen Platz anzupassen, fuer die Faelle hier
// reicht ein Stub, der nichts tut.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) })))
  useCreateStore.setState({ backend: 'cloud', isGenerating: false, gallery: [] })
  useCloudCatalogStore.setState({ models: QUOTE_REQUIRED_CATALOG })
  mocks.submit.mockResolvedValue({ id: 'test-job', quota: { cost: 0 } })
  mocks.poll.mockResolvedValue({ status: 'failed', error: 'Stopped before provider call' })
  mocks.upload.mockResolvedValue('11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png')
  mocks.runtimes.mockResolvedValue({})
  mocks.quote.mockImplementation(async (model: string, prompt: string, params: { studio_options?: Record<string, unknown> }) => ({
    credits: studioPreviewCredits(model, params.studio_options ?? {}, undefined, 1, prompt.length),
  }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); useCloudCatalogStore.setState({ models: CLOUD_MODEL_SEED }) })

// Review B5 (Runde 4, 20.09.2026): PresetWorkshop fired one studioQuote()
// call per keystroke (48 of 48 for a 48-character prompt), the same disease
// B4 (Runde 3) found and fixed in the Composer's useStudioPrice.ts, reusing
// its debounce helper (useDebouncedValue.ts). Mirrors
// use-studio-price-rate-limit.test.ts's shape, on the actual component
// instead of the hook.
it('48 keystrokes at a 600 ms pace debounce down to at most TWO quote calls (Review B5)', async () => {
  vi.useFakeTimers()
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  const field = screen.getByLabelText('Preset prompt')
  const text = 'a slow typist writes one letter at a time, thinking'.slice(0, 48)
  expect(text).toHaveLength(48)
  let typed = ''
  for (const ch of text) {
    typed += ch
    fireEvent.change(field, { target: { value: typed } })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  }
  // The customer stops: 1800ms settles the prompt debounce, then the
  // effect's own 650ms network debounce fires the (at most) second call.
  await act(async () => { await vi.advanceTimersByTimeAsync(1800) })
  await act(async () => { await vi.advanceTimersByTimeAsync(650) })
  expect(mocks.quote.mock.calls.length).toBeLessThanOrEqual(2)
})

// Review B5: a 429 on the LIVE quote (rate limit, not a version gap) must
// not lock Generate. The last CONFIRMED price stays usable and bookable
// while the rate limit stands; a 404/CORS version gap still blocks, that
// case is covered separately above ("Start bleibt gesperrt...").
it('a 429 on the live quote leaves Generate usable with the last confirmed price (Review B5)', async () => {
  vi.useFakeTimers()
  mocks.quote.mockResolvedValueOnce({ credits: 1500 })
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(1800) })
  await act(async () => { await vi.advanceTimersByTimeAsync(650) })
  expect(screen.getAllByText(/1,500 credits/).length).toBeGreaterThan(0)
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false)

  mocks.quote.mockRejectedValueOnce(new CloudJobError('Please wait before requesting another quote', 429))
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature, closer up' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(1800) })
  await act(async () => { await vi.advanceTimersByTimeAsync(650) })
  // Still the old, confirmed number, still bookable: no alert, no lock.
  expect(screen.getAllByText(/1,500 credits/).length).toBeGreaterThan(0)
  expect(screen.queryByRole('alert')).toBeNull()
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await act(async () => { await Promise.resolve() })
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  expect(mocks.submit.mock.calls[0][0]).toMatchObject({ params: { max_credits: 1500 } })
})

it('prices automatically and starts the category with one Generate click', async () => {
  const onGenerate = vi.fn()
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={onGenerate} />)
  expect(screen.queryByText('Review price')).toBeNull()
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'A misty forest creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  expect(screen.getAllByText(/1,500 credits/).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
  expect(onGenerate).toHaveBeenCalledTimes(1)
  expect(useCreateStore.getState().intent()).toBe('image')
  expect(mocks.submit.mock.calls[0][0]).toMatchObject({ model: 'preset-chroma', params: { max_credits: 1500 } })
})

it('invalidates the prior quote when the prompt is cleared', async () => {
  render(<PresetWorkshop preset={CREATE_PRESETS[0]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'A character portrait' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: '' } })
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(true)
})

it('starts collapsed and shows one illustrated card per preset', () => {
  const select = vi.fn(); render(<ShelfMitZustand onSelect={select} />)
  expect(screen.queryAllByRole('img')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Expand presets' }))
  expect(screen.getAllByRole('img')).toHaveLength(CREATE_PRESETS.length)
  fireEvent.click(screen.getByRole('button', { name: /Horror Creature/ }))
  expect(select).toHaveBeenCalledWith(CREATE_PRESETS[1])
})

// P6: die Schiene ist Wolken-Spur, und zwar nur mit einem Katalog, der
// Studio kennt. Beide Bedingungen einzeln geprueft, damit ein kuenftiger
// Bug nicht zwei Ursachen hinter einem gruenen Test versteckt.
it('die Schiene fehlt auf der lokalen Spur, auch wenn der Katalog Studio fuehrt', () => {
  useCreateStore.setState({ backend: 'local' })
  const { container } = render(<ShelfMitZustand onSelect={() => {}} />)
  expect(screen.queryByRole('button', { name: 'Expand presets' })).toBeNull()
  expect(container.innerHTML).toBe('')
})

it('die Schiene fehlt auf der Wolken-Spur, solange der Katalog kein quote_required fuehrt', () => {
  useCloudCatalogStore.setState({ models: CLOUD_MODEL_SEED })
  const { container } = render(<ShelfMitZustand onSelect={() => {}} />)
  expect(screen.queryByRole('button', { name: 'Expand presets' })).toBeNull()
  expect(container.innerHTML).toBe('')
})

it('updates WAN price instantly before upload, and exposes the full API duration range', () => {
  const m = STUDIO_MODELS['wan-3.0']
  render(<PresetWorkshop preset={{ id: 'wan-3.0', title: m.label, summary: '', category: 'Video', adult: false, accent: '', steps: [{ model: 'wan-3.0', kind: 'video', op: 'studio', title: m.label, role: 'animate' }] }} onClose={() => {}} onGenerate={() => {}} />)
  expect(screen.getByText('≈ 25,000 credits')).toBeTruthy()
  const duration = screen.getByLabelText('Duration') as HTMLInputElement
  expect(duration.min).toBe('2'); expect(duration.max).toBe('30')
  fireEvent.change(duration, { target: { value: '30' } })
  expect(screen.getByText('≈ 150,000 credits')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '1080p' } })
  expect(screen.getByText('≈ 600,000 credits')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(true)
  // Ohne Eingabe wird kein Anbieterpreis angefragt. Die Laufzeitabfrage beim
  // Oeffnen ist etwas anderes und zaehlt hier nicht.
  expect(mocks.quote).not.toHaveBeenCalled()
})

it('preserves numeric duration enum values for MiniMax and supports all three style LoRAs', () => {
  const m = STUDIO_MODELS['minimax-h3']; const { unmount } = render(<PresetWorkshop preset={{ id: 'minimax-h3', title: m.label, summary: '', category: 'Video', adult: false, accent: '', steps: [{ model: 'minimax-h3', kind: 'video', op: 'studio', title: m.label, role: 'animate' }] }} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '3' } })
  expect(screen.getByText('≈ 12,000 credits')).toBeTruthy()
  unmount()
  render(<PresetWorkshop preset={CREATE_PRESETS[4]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '+ Advanced settings' }))
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: '+ Add style LoRA' }))
  expect(screen.getByLabelText('LoRA 3 strength')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '+ Add style LoRA' })).toBeNull()
})

// Die Frage, die diesen Bereich abnimmt: eine Sekunde mehr oder weniger, und
// der Preis muss mitgehen. Er darf NICHT der alte bleiben, und der alte darf
// auch nicht stehenbleiben, waehrend der neue noch unterwegs ist. Gebucht wird
// am Ende genau die Zahl, die zuletzt auf dem Schirm stand.
it('re-quotes the server price when the duration changes, and books the new one', async () => {
  const m = STUDIO_MODELS['wan-3.0']
  render(<PresetWorkshop preset={{ id: 'wan-3.0', title: m.label, summary: '', category: 'Video', adult: false, accent: '', steps: [{ model: 'wan-3.0', kind: 'video', op: 'studio', title: m.label, role: 'animate' }] }} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'A slow pan across the valley' } })
  fireEvent.change(screen.getByLabelText('Add image'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
  await waitFor(() => expect(screen.getByText('25,000 credits')).toBeTruthy(), { timeout: 3000 })
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false)

  fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '10' } })
  // Sofort: der bestaetigte Preis ist weg und der Knopf zu, damit niemand die
  // alte Zahl fuer die neue Dauer buchen kann.
  expect(screen.queryByText('25,000 credits')).toBeNull()
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(true)

  await waitFor(() => expect(screen.getByText('50,000 credits')).toBeTruthy(), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
  expect(mocks.submit.mock.calls[0][0]).toMatchObject({ model: 'wan-3.0', params: { max_credits: 50000, studio_options: { duration: 10 } } })
})

// Der Schritt ist der Auftrag, nicht das Modell. Wer das Modell wechselt,
// bekommt den Preis des gewechselten und bucht auch den.
const eigenes = (role: 'image' | 'animate', model: string, kind: 'image' | 'video') => ({ id: 'x', title: 'x', summary: '', category: 'Video' as const, adult: false, accent: '', steps: [{ model, kind, op: 'studio' as const, title: 'x', role }] })

// Die Auswahl im Fenster klappt auf und zeigt die ganze Liste. Die Faelle
// fahren sie wie ein Kunde, ueber Klicks. Desktop-Abweichung vom Web-`Select`
// (P4-Befund, siehe studio-p4.md): der Options-Button traegt hier zusaetzlich
// `role="option"` (Web: nur ein `<button>` ohne Rollen-Override), also wird
// nach `option` statt nach `button` gefragt.
const aufklappen = (name: string) => { const k = screen.getByLabelText(name); fireEvent.click(k); return k }
// Nur der Name zaehlt: Marken (Best, Open weights) und Preis stehen daneben.
const nameVon = (b: HTMLElement) => (b.querySelector('.truncate')?.textContent ?? b.textContent ?? '').trim()
const eintraege = (name: string) => { aufklappen(name); const liste = screen.getAllByRole('option').filter((b) => b.closest('.lu-elevated')); const namen = liste.map((b) => nameVon(b)); fireEvent.click(screen.getByLabelText(name)); return namen }
const waehlen = (name: string, text: string) => { aufklappen(name); const treffer = screen.getAllByRole('option').find((b) => b.closest('.lu-elevated') && nameVon(b) === text); if (!treffer) throw new Error(`Eintrag nicht gefunden: ${text}`); fireEvent.click(treffer) }

it('ein Preset mit Freigabe bietet nur die offenen Modelle an', async () => {
  // Ein gefilterter Endpunkt verweigert einen Horror- oder Spicy-Lauf und
  // kostet die Credits trotzdem. Er steht dort also gar nicht erst.
  render(<PresetWorkshop preset={CREATE_PRESETS[0]} onClose={() => {}} onGenerate={() => {}} />)
  const namen = eintraege('Model')
  expect(namen).toEqual(sortByTier(presetModels('image', true)).map((m) => m.label))
  expect(namen).toContain('Chroma Uncensored')
  expect(namen).not.toContain('Flux Schnell (fast)')
})

it('laesst den Kunden das Modell des Schrittes wechseln und bucht das gewechselte', async () => {
  render(<PresetWorkshop preset={eigenes('image', 'preset-chroma', 'image')} onClose={() => {}} onGenerate={() => {}} />)
  expect(screen.getByLabelText('Model').textContent).toContain('Chroma')
  const namen = eintraege('Model')
  expect(namen).toContain('Flux Schnell (fast)')
  // Derselbe Endpunkt steht nicht zweimal drin, einmal als Studio-Zwilling.
  expect(namen.filter((n) => n === 'Chroma Uncensored')).toHaveLength(1)

  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a portrait in warm light' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  const anbieterfragenVorher = mocks.quote.mock.calls.length
  waehlen('Model', 'Flux Schnell (fast)')
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(true)

  await waitFor(() => expect(screen.getByText('300 credits')).toBeTruthy(), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
  expect(mocks.submit.mock.calls[0][0]).toMatchObject({ model: 'flux-schnell', kind: 'image', params: { op: 'generate', max_credits: 300, width: 1024, height: 1024 } })
  // Ein klassisches Modell rechnet die Route mit derselben Formel nach. Es
  // fragt keinen Anbieterpreis an, sonst stuende dort eine zweite Zahl.
  expect(mocks.quote.mock.calls.length).toBe(anbieterfragenVorher)
})

it('schickt beim klassischen Clip Frames und Fps und nicht duration', async () => {
  render(<PresetWorkshop preset={eigenes('animate', 'preset-wan-2.2-spicy', 'video')} onClose={() => {}} onGenerate={() => {}} />)
  waehlen('Model', 'Wan 2.2 720p')
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a slow pan across the valley' } })
  fireEvent.change(screen.getByLabelText('Add image'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.change(screen.getByLabelText('Duration'), { target: { value: '8' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
  const sent = mocks.submit.mock.calls[0][0]
  expect(sent).toMatchObject({ model: 'wan-2.2-720p', kind: 'video', params: { op: 'animate', frames: 128, fps: 16 } })
  expect(sent.params.duration).toBeUndefined()
})

// Ein fertiges Ergebnis darf keine Sackgasse sein. Vorher stand der Schritt
// beim naechsten Oeffnen des Presets wieder auf dem alten Bild, ohne einen Weg
// zurueck.
it('wirft das Ergebnis eines Schrittes auf Wunsch weg und faengt ganz von vorn an', async () => {
  mocks.poll.mockResolvedValue({ id: 'test-job', status: 'succeeded', kind: 'image', result_url: 'https://example.test/a.png', model: 'preset-chroma', prompt: 'a' })
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(screen.getByAltText('Generated result')).toBeTruthy(), { timeout: 3000 })

  // Nochmal: dasselbe Ergebnis weg, Prompt und Eingaben bleiben stehen.
  fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
  expect(screen.queryByAltText('Generated result')).toBeNull()
  expect((screen.getByLabelText('Preset prompt') as HTMLTextAreaElement).value).toBe('a misty forest creature')

  // Von vorn: nichts bleibt stehen, auch der Prompt nicht.
  fireEvent.click(screen.getByRole('button', { name: /Start over/ }))
  expect((screen.getByLabelText('Preset prompt') as HTMLTextAreaElement).value).toBe('')
  expect(screen.queryByRole('button', { name: /Start over/ })).toBeNull()
})

it('haengt eine Prompt-Vorgabe an den eigenen Text an, statt ihn zu ersetzen', async () => {
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  expect(eintraege('Prompt ideas')).toEqual(promptIdeas('image', 'Horror').map((i) => i.label))
  const feld = screen.getByLabelText('Preset prompt') as HTMLTextAreaElement
  fireEvent.change(feld, { target: { value: 'a tall creature in the corridor' } })
  waehlen('Prompt ideas', 'Trail camera')
  expect(feld.value.startsWith('a tall creature in the corridor, ')).toBe(true)
  expect(feld.value).toContain('trail camera photograph')
})

// Das Fenster gehoert dem Kunden, solange sein Schritt laeuft. generate()
// ruft den Schliesser nicht selbst.
it('bleibt waehrend der Generation offen und meldet den Start nur', async () => {
  let offen = true
  mocks.poll.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 80)); return { id: 'test-job', status: 'succeeded', kind: 'image', result_url: 'https://example.test/a.png', model: 'preset-chroma', prompt: 'a' } })
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => { offen = false }} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(screen.getByAltText('Generated result')).toBeTruthy(), { timeout: 3000 })
  expect(offen).toBe(true)
})

it('bietet Continue oben in der Leiste an und nicht als Banner ueber dem Bild', () => {
  const weiter = vi.fn()
  render(<ShelfMitZustand onSelect={() => {}} resume={{ title: 'Uncensored Anime', onResume: weiter }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Expand presets' }))
  const knopf = screen.getByRole('button', { name: 'Continue' })
  expect(knopf.parentElement?.textContent).toContain(`Presets · ${CREATE_PRESETS.length}`)
  fireEvent.click(knopf)
  expect(weiter).toHaveBeenCalledTimes(1)
})

it('zeigt kein Continue, solange nichts laeuft', () => {
  render(<ShelfMitZustand onSelect={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Expand presets' }))
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
})

// Was der Kunde hochlaedt, steht im Viewer. Das Preset-Bild ist eine
// Illustration und nicht sein Material.
it('zeigt das hochgeladene Bild im Viewer statt der Preset-Illustration', async () => {
  const urls: string[] = []
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => { const u = `blob:test-${urls.length}`; urls.push(u); return u }, revokeObjectURL: (u: string) => { urls.splice(urls.indexOf(u), 1) } }))
  render(<PresetWorkshop preset={CREATE_PRESETS[4]} onClose={() => {}} onGenerate={() => {}} />)
  expect(screen.getByAltText('Preset inspiration')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Add image'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } })
  await waitFor(() => expect(screen.getByAltText('Your input')).toBeTruthy(), { timeout: 3000 })
  expect(screen.queryByAltText('Preset inspiration')).toBeNull()
  expect((screen.getByAltText('Your input') as HTMLImageElement).src).toBe('blob:test-0')

  fireEvent.click(screen.getByRole('button', { name: 'Remove input' }))
  await waitFor(() => expect(screen.getByAltText('Preset inspiration')).toBeTruthy())
  expect(urls).toHaveLength(0)
})

// Talking Avatar: die Stimme aus Schritt 1 gehoert in Schritt 2, ohne dass
// jemand das Fenster schliesst, die Datei herunterlaedt und wieder hochlaedt.
it('traegt das Ergebnis eines Schrittes von selbst in die Eingabe des naechsten', async () => {
  const stimme = 'https://example.test/voice.mp3'
  mocks.poll.mockResolvedValue({ id: 'job-1', status: 'succeeded', kind: 'audio', result_url: stimme, model: 'preset-qwen3-tts', prompt: 'hello' })
  mocks.getJob.mockResolvedValue({ id: 'job-1', status: 'succeeded', kind: 'audio', result_url: stimme })
  mocks.quote.mockImplementation(async (model: string, prompt: string, params: { studio_options?: Record<string, unknown> }) => ({
    credits: studioPreviewCredits(model, params.studio_options ?? {}, 5, 1, prompt.length) ?? 1000,
  }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url) === stimme) return { ok: true, blob: async () => new Blob(['x'], { type: 'audio/mpeg' }) }
    return { ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) }
  }))
  render(<PresetWorkshop preset={CREATE_PRESETS[6]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'hello there' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Next step/ })).toBeTruthy(), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: /Next step/ }))
  // Schritt 2 laedt die Stimme selbst hoch und meldet die Eingabe als gesetzt.
  await waitFor(() => expect(screen.getByText(/Replace audio/)).toBeTruthy(), { timeout: 3000 })
  expect(mocks.upload).toHaveBeenCalledTimes(1)
  expect(mocks.upload.mock.calls[0][1]).toBe('audio')
})

// Horror Creature: das Bild aus Schritt 1 gehoert in Schritt 2. Derselbe
// Fluss wie bei der Stimme, nur mit einem Standbild.
it('traegt auch ein Bild von selbst in den naechsten Schritt', async () => {
  const bild = 'https://example.test/creature.png'
  mocks.poll.mockResolvedValue({ id: 'job-1', status: 'succeeded', kind: 'image', result_url: bild, model: 'preset-chroma', prompt: 'a creature' })
  mocks.getJob.mockResolvedValue({ id: 'job-1', status: 'succeeded', kind: 'image', result_url: bild })
  mocks.quote.mockImplementation(async (model: string, prompt: string, params: { studio_options?: Record<string, unknown> }) => ({
    credits: studioPreviewCredits(model, params.studio_options ?? {}, 5, 1, prompt.length) ?? 1500,
  }))
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  expect(CREATE_PRESETS[1].steps[1].model).toBe('open-video')
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a tall pale creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Next step/ })).toBeTruthy(), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: /Next step/ }))
  await waitFor(() => expect(screen.getByText(/Replace image/)).toBeTruthy(), { timeout: 3000 })
  expect(mocks.upload).toHaveBeenCalledTimes(1)
  expect(mocks.upload.mock.calls[0][1]).toBe('source')
  await waitFor(() => expect(screen.getByAltText('Your input')).toBeTruthy())
})

it('zeigt keinen Knopf fuer das vorige Ergebnis und haelt Optionales aus dem Weg', async () => {
  const bild = 'https://example.test/creature.png'
  mocks.poll.mockResolvedValue({ id: 'job-1', status: 'succeeded', kind: 'image', result_url: bild, model: 'preset-chroma', prompt: 'a creature' })
  mocks.getJob.mockResolvedValue({ id: 'job-1', status: 'succeeded', kind: 'image', result_url: bild })
  mocks.quote.mockImplementation(async (model: string, prompt: string, params: { studio_options?: Record<string, unknown> }) => ({
    credits: studioPreviewCredits(model, params.studio_options ?? {}, 5, 1, prompt.length) ?? 1500,
  }))
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a tall pale creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /Next step/ })).toBeTruthy(), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: /Next step/ }))
  await waitFor(() => expect(screen.getByText(/Replace image/)).toBeTruthy(), { timeout: 3000 })
  expect(screen.queryByRole('button', { name: 'Use previous result' })).toBeNull()
  expect(screen.getByText(/Replace image/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Remove input' })).toBeTruthy()
})

it('haelt ein optionales Endbild unter den erweiterten Einstellungen', () => {
  const m = STUDIO_MODELS['wan-3.0']
  render(<PresetWorkshop preset={{ id: 'wan-3.0', title: m.label, summary: '', category: 'Video', adult: false, accent: '', steps: [{ model: 'wan-3.0', kind: 'video', op: 'studio', title: m.label, role: 'animate' }] }} onClose={() => {}} onGenerate={() => {}} />)
  expect(screen.getByText(/Add image/)).toBeTruthy()
  expect(screen.queryByText(/Add last image/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '+ Advanced settings' }))
  expect(screen.getByText(/Add last image/)).toBeTruthy()
})

// P6: ein Server, der Studio noch nicht kennt (oder die zwei Routen ohne CORS
// vor P0), antwortet auf studio-quote mit 404 oder einem rohen Netzfehler.
// studioQuote() (P3) wandelt beides in denselben festen Text um. Start bleibt
// gesperrt, weil `quote` nie gesetzt wird: kein Rueckfall auf die eigene
// Formel, kein Buchen einer geratenen Zahl.
it('Start bleibt gesperrt und zeigt den festen Text, wenn der Server das Studio nicht kennt', async () => {
  mocks.quote.mockRejectedValue(new CloudJobError('This feature needs a newer LU Cloud server. Try again later.', 404))
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature' } })
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This feature needs a newer LU Cloud server. Try again later.'), { timeout: 3000 })
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(true)
  expect(mocks.submit).not.toHaveBeenCalled()
})

// P6: 409 quote_changed beim Buchen (POST /api/jobs, real erwarteter Fall
// laut Portplan Abschnitt 4 Punkt 3, die Preisabfrage selbst liefert ihn
// laut P3-Bericht heute nicht). Der neue, vom Server bestaetigte Preis
// erscheint, aber es wird NICHT still mit ihm weitergebucht: submitCloudJob
// wurde genau einmal aufgerufen, ein zweiter Klick waere noetig.
it('zeigt bei 409 quote_changed den neuen Preis, statt still neu zu buchen', async () => {
  mocks.submit.mockRejectedValueOnce(new QuoteChangedError('The price has changed.', 4200))
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('4,200 credits'), { timeout: 3000 })
  expect(screen.getAllByText(/4,200 credits/).length).toBeGreaterThan(0)
  expect(mocks.submit).toHaveBeenCalledTimes(1)
  // Der Knopf ist wieder bedienbar, gegen den NEUEN Preis: ein zweiter,
  // ausdruecklicher Klick bucht ihn, keiner buchte ihn automatisch.
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
  expect(mocks.submit.mock.calls[1][0]).toMatchObject({ params: { max_credits: 4200 } })
  // review-studio-B.md, kleiner Punkt 5: genau HIER darf sich der Schluessel
  // nicht wiederholen, weil der Preis wirklich anders ist (ein NEUER Lauf,
  // nicht derselbe wiederholte).
  expect(mocks.submit.mock.calls[1][0].params.client_request_id)
    .not.toBe(mocks.submit.mock.calls[0][0].params.client_request_id)
})

// review-studio-B.md, kleiner Punkt 5: die Idempotenz haengt daran, dass ein
// Wiederholungsversuch DENSELBEN client_request_id schickt. Ein Absenden,
// das an einem gewoehnlichen Fehler (keine Preisaenderung) scheitert und ein
// zweites Mal versucht wird, ohne dass die Quote neu gezogen wurde, muss
// denselben Schluessel tragen, sonst bucht der Server zwei Auftraege fuer
// einen Klick, den der Kunde als einen einzigen Versuch sieht.
it('schickt bei einem Wiederholungsversuch ohne neue Quote denselben client_request_id', async () => {
  mocks.submit.mockRejectedValueOnce(new Error('network blip'))
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
  const first = mocks.submit.mock.calls[0][0].params.client_request_id
  const second = mocks.submit.mock.calls[1][0].params.client_request_id
  expect(first).toBeDefined()
  expect(second).toBe(first)
})

// P6: `StudioQuoteChangedError` aus der Preisabfrage selbst (P3 haelt den
// Pfad vorsorglich bereit, siehe studio-p3.md "Fuer P9 offen"). Derselbe
// Grundsatz, nur an der fruehen Stelle: die Preisanzeige uebernimmt den
// bestaetigten Preis, bucht aber nichts von selbst.
it('zeigt bei 409 quote_changed auf die Preisabfrage selbst ebenfalls den neuen Preis', async () => {
  mocks.quote.mockRejectedValueOnce(new StudioQuoteChangedError('The price has changed.', 900))
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'a misty forest creature' } })
  await waitFor(() => expect(screen.getAllByText(/900 credits/).length).toBeGreaterThan(0), { timeout: 3000 })
  expect(screen.getByRole('alert').textContent).toBe('The price changed. Review the new price before starting.')
  expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false)
  expect(mocks.submit).not.toHaveBeenCalled()
})

// P6: das Preset-Fenster ist ein Popup mit X und Escape (Hausregel,
// e2e/escape-closes-overlays.spec.ts). Derselbe `Modal`-Baustein wie jedes
// andere Fenster im Haus, hier ueber die tatsaechliche Verdrahtung geprueft.
it('Escape schliesst die Werkstatt', async () => {
  const closed = vi.fn()
  render(<WerkstattFenster preset={CREATE_PRESETS[1]} onClosed={closed} />)
  expect(screen.getByRole('dialog', { name: CREATE_PRESETS[1].title })).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(closed).toHaveBeenCalledTimes(1)
})

it('das X schliesst die Werkstatt', async () => {
  const closed = vi.fn()
  render(<WerkstattFenster preset={CREATE_PRESETS[1]} onClosed={closed} />)
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(closed).toHaveBeenCalledTimes(1)
})

// Bug hunt 01.10.2026 (K3). The request id was only renewed with a new quote,
// so Generate after a failed step sent the old one, and the server handed the
// failed job back instead of starting a new one.
it('sends a new request id when Generate is pressed again after a failed step', async () => {
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'A misty forest creature' } })
  const generate = () => screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement
  await waitFor(() => expect(generate().disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(generate())
  await waitFor(() => expect(screen.getAllByText(/Stopped before provider call/).length).toBeGreaterThan(0))
  await waitFor(() => expect(generate().disabled).toBe(false))
  fireEvent.click(generate())
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
  const ids = mocks.submit.mock.calls.map((c) => c[0].params.client_request_id)
  expect(ids[0]).toBeTruthy()
  expect(ids[1]).toBeTruthy()
  expect(ids[1]).not.toBe(ids[0])
})

// Same hunt: after a success the quote is dropped, and Try again left the same
// inputs, so no new quote came and Generate stayed disabled.
it('can generate again after Try again on a finished step', async () => {
  mocks.poll.mockResolvedValue({ id: 'test-job', status: 'succeeded', kind: 'image', model: 'preset-chroma', result_url: 'https://x/y.png', created_at: '2026-10-01T00:00:00Z' })
  render(<PresetWorkshop preset={CREATE_PRESETS[1]} onClose={() => {}} onGenerate={() => {}} />)
  fireEvent.change(screen.getByLabelText('Preset prompt'), { target: { value: 'A misty forest creature' } })
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  fireEvent.click(await screen.findByRole('button', { name: /Try again/ }))
  await waitFor(() => expect((screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 })
})
