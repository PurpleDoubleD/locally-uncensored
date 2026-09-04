/**
 * @vitest-environment jsdom
 *
 * Der Chip im Chat nennt ein Modell, das nichts mehr bedient.
 *
 * Gemessen am Stand von 2.6.8: in Settings, AI Backends steht die LU Engine im
 * geteilten `openai`-Steckplatz und LM Studio daneben auf der Standby-Karte.
 * Ein Druck auf Enable dort gibt den Steckplatz an LM Studio, die LU Engine
 * geht in den Standby, und Port 8127 stirbt. Der Waehler im Chat steht danach
 * weiter auf `openai::Qwen3-4B-Q4_K_M`, einem GGUF, das nur die eigene Engine
 * bedienen konnte.
 *
 * Und ausgerechnet hier faellt die Selbstheilung des Absendewegs aus. Sie
 * haengt in `api/providers/openai-provider.ts:717` und `:903` hinter
 * `this.config.managed === true`, und managed ist nach der Uebergabe false;
 * `builtinSlotSwitchedOff` (`api/builtin-ensure.ts`) verlangt dasselbe managed
 * und greift auch nicht. Es gibt also niemanden mehr, der die Engine
 * zurueckholt oder wenigstens einen ehrlichen Satz sagt. Was der Nutzer beim
 * Absenden bekommt, ist eine Fremdmeldung ueber eine unbekannte
 * Modell-Kennung.
 *
 * Also faellt die Wahl mit dem Steckplatz. Danach steht im Waehler wieder
 * `Select Model` und die Frage stellt sich nicht mehr.
 *
 * Run: npx vitest run src/lib/__tests__/der-steckplatz-nimmt-die-wahl-mit.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const backendCall = vi.fn(async (..._args: unknown[]) => ({}))
vi.mock('../../api/backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => true,
  isMacOS: () => false,
  isWindows: () => true,
  isLinux: () => false,
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const {
  builtinSlotHandedToForeignBackend,
  __resetBuiltinSlotOffloadForTests,
  BUILTIN_SLOT_OFFLOAD_GRACE_MS,
} = await import('../builtin-slot-eviction')
const { slotHandbackUpdate } = await import('../openai-slot-handover')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')

const LU_ROW = 'openai::Qwen3-4B-Q4_K_M'
const LMS_ROW = 'openai::qwen2.5-0.5b-instruct@q4_k_m'
const OLLAMA_ROW = 'llama3:8b'
const LMS_URL = 'http://localhost:1234/v1'

/** Was der Steckplatz sieht, ohne den Rest der Provider-Konfiguration. */
const BUILTIN = { enabled: true, managed: true }
const FOREIGN = { enabled: true, managed: false }

/** Die Zeilen, die im Waehler stehen, in der Form, die `bundledToAIModels` und
 *  die Fremdlisten wirklich schreiben. */
const ROWS = [
  { name: LU_ROW, model: 'Qwen3-4B-Q4_K_M', size: 2_300_000_000, type: 'text', provider: 'openai', providerName: 'LU Engine' },
  { name: LMS_ROW, model: 'qwen2.5-0.5b-instruct@q4_k_m', size: 0, type: 'text', provider: 'openai', providerName: 'LM Studio' },
  { name: OLLAMA_ROW, model: OLLAMA_ROW, size: 0, type: 'text', provider: 'ollama', providerName: 'Ollama' },
]

/** Die Modelliste, ohne dass die Modell-Union hier nachgebaut werden muss. */
function listeSetzen(): void {
  useModelStore.setState({ models: ROWS as never, activeModel: null })
}

/** Der Steckplatz, wie er nach einem Wechsel zur LU Engine dasteht: unsere
 *  Engine drin, LM Studio auf der Standby-Karte. */
function luEngineImSteckplatz(): void {
  useProviderStore.getState().setProviderConfig('openai', {
    enabled: true, managed: true, name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1',
    isLocal: true, displaced: { name: 'LM Studio', baseUrl: LMS_URL, isLocal: true },
  })
}

/** Genau der Druck auf Enable der Standby-Karte (ProviderConfig.tsx). */
function enableAufDerStandbyKarte(): void {
  const update = slotHandbackUpdate(useProviderStore.getState().providers.openai)
  useProviderStore.getState().setProviderConfig('openai', update!)
}

/** Mikrotasks durchlassen: die Raeumung liest den Zustand erst hinter ihrem
 *  ersten `await import(...)`, und die Slot-Ansage stellt ebenfalls verzoegert
 *  zu. */
async function durchlassen(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(async () => {
  vi.useFakeTimers()
  backendCall.mockClear()
  __resetBuiltinSlotOffloadForTests()
  useModelStore.setState({ activeModel: null })
  useProviderStore.getState().resetProvidersToDefaults()
  await durchlassen()
  listeSetzen()
  __resetBuiltinSlotOffloadForTests()
  backendCall.mockClear()
})
afterEach(() => {
  __resetBuiltinSlotOffloadForTests()
  vi.useRealTimers()
})

describe('die Regel, ohne Zeitgeber und ohne Store', () => {
  it('unsere Engine gibt den Steckplatz an ein eingeschaltetes fremdes Backend ab', () => {
    expect(builtinSlotHandedToForeignBackend(BUILTIN, FOREIGN)).toBe(true)
  })

  it('die Gegenrichtung nicht, dort ist die Wahl das Modell, das gleich geladen wird', () => {
    expect(builtinSlotHandedToForeignBackend(FOREIGN, BUILTIN)).toBe(false)
  })

  it('Disable auf der eigenen Engine nicht, dafuer gibt es die Ein-Aus-Invariante', () => {
    expect(builtinSlotHandedToForeignBackend(BUILTIN, { enabled: false, managed: true })).toBe(false)
  })

  it('ein fremdes Backend, das ausgeschaltet in den Steckplatz geschrieben wird, auch nicht', () => {
    expect(builtinSlotHandedToForeignBackend(BUILTIN, { enabled: false, managed: false })).toBe(false)
  })

  it('fremd zu fremd nicht, da war nie eine Engine von uns im Spiel', () => {
    expect(builtinSlotHandedToForeignBackend(FOREIGN, FOREIGN)).toBe(false)
  })

  it('und ein Schreiben, das den Steckplatz gar nicht bewegt, auch nicht', () => {
    expect(builtinSlotHandedToForeignBackend(BUILTIN, BUILTIN)).toBe(false)
    expect(builtinSlotHandedToForeignBackend(null, FOREIGN)).toBe(false)
    expect(builtinSlotHandedToForeignBackend(BUILTIN, null)).toBe(false)
  })
})

describe('DER BEFUND: Enable auf der Standby-Karte nimmt die Wahl mit', () => {
  it('die Wahl auf einem GGUF ueberlebt die Uebergabe nicht', async () => {
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()

    const slot = useProviderStore.getState().providers.openai
    expect(slot.name, 'der Steckplatz ging gar nicht ueber').toBe('LM Studio')
    expect(slot.managed).toBe(false)
    expect(
      useModelStore.getState().activeModel,
      'der Chip nennt weiter ein Modell, das auf 8127 lag, und dort liegt nichts mehr',
    ).toBeNull()
  })

  it('und die Frist bleibt ganz: geraeumt wird ohne ein zweites stop_bundled_engine', async () => {
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()
    expect(useModelStore.getState().activeModel).toBeNull()
    // Ueber `setActiveModel(null)` haengt an diesem Wechsel ein sofortiges
    // `stop_bundled_engine`, und das wuerde die 30 Sekunden Nachsicht
    // ueberholen, die dieses Modul selbst verwaltet.
    expect(backendCall, 'die Nachsicht wurde ueberholt').not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(BUILTIN_SLOT_OFFLOAD_GRACE_MS)
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(backendCall.mock.calls[0][0]).toBe('stop_bundled_engine')
  })
})

describe('NEGATIVKONTROLLE: wessen Wahl stehen bleibt', () => {
  it('die Engine, die den Steckplatz ZURUECKnimmt, behaelt ihr Modell', async () => {
    // Genau diese Wahl ist es, die `bringEngineBack` gleich laedt. Wer sie
    // hier raeumt, laesst die zurueckgeholte Engine ohne Modell stehen.
    useProviderStore.getState().setProviderConfig('openai', {
      enabled: true, managed: false, name: 'LM Studio', baseUrl: LMS_URL, isLocal: true,
      displaced: { name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true },
    })
    await durchlassen()
    __resetBuiltinSlotOffloadForTests()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte() // hier ist es die Karte der LU Engine
    await durchlassen()

    expect(useProviderStore.getState().providers.openai.managed).toBe(true)
    expect(useModelStore.getState().activeModel).toBe(LU_ROW)
  })

  it('eine Wahl, die der Aufrufer im selben Durchlauf neu setzt, bleibt stehen', async () => {
    // Die Reihenfolge aus useModels.activateModel: erst den Steckplatz
    // abgeben, dann ohne await die Zeile des uebernehmenden Backends setzen.
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    useModelStore.setState({ activeModel: LMS_ROW })
    await durchlassen()

    expect(
      useModelStore.getState().activeModel,
      'die frisch gesetzte richtige Wahl wurde mitgeraeumt',
    ).toBe(LMS_ROW)
  })

  it('eine Ollama-Wahl ueberlebt die Uebergabe, sie wird woanders bedient', async () => {
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: OLLAMA_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()

    expect(useModelStore.getState().activeModel).toBe(OLLAMA_ROW)
  })

  it('eine Wahl, die in der Liste gar nicht steht, wird nicht geraten', async () => {
    // Vor der ersten Inventar-Runde ist die persistierte Wahl nur ein Name.
    // Sicherer, sie stehen zu lassen: die naechste Liste prueft sie ohnehin.
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ models: [] as never, activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()

    expect(useModelStore.getState().activeModel).toBe(LU_ROW)
  })

})

describe('warum niemand sonst das auffaengt', () => {
  it('der Absendeweg fragt die Engine nur, solange der Steckplatz ihr gehoert', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    // Beide Absendestellen haengen hinter demselben managed, und managed ist
    // nach der Uebergabe false. Die Selbstheilung schaltet sich also
    // ausgerechnet dann ab, wenn sie gebraucht wuerde, und deshalb muss die
    // Wahl selbst fallen statt auf eine Rettung zu warten.
    const provider = readFileSync(resolve(repo, 'src/api/providers/openai-provider.ts'), 'utf8')
    const bewacht = provider.match(/managed === true\)[\s\S]{0,40}?ensureBuiltinEngineAlive/g)
    expect(bewacht, 'die Selbstheilung haengt nicht mehr an managed').toHaveLength(2)
    // Und die ehrliche Meldung ueber die abgeschaltete Engine verlangt
    // dasselbe managed, greift hier also auch nicht.
    const ensure = readFileSync(resolve(repo, 'src/api/builtin-ensure.ts'), 'utf8')
    const abgeschaltet = ensure.slice(ensure.indexOf('export function builtinSlotSwitchedOff'))
    expect(abgeschaltet.slice(0, 200)).toMatch(/cfg\.managed === true/)
  })
})
