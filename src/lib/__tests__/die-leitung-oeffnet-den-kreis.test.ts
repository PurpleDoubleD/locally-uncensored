/**
 * @vitest-environment jsdom
 *
 * Der Kreis, den die dynamischen Importe nur unsichtbar gemacht haben.
 *
 * `npm run cycles` (ci.yml:78) meldete am 04.09.2026 fuenf Kreise und beendete
 * sich mit 1. Alle fuenf liefen ueber dieselbe Datei:
 *
 *   1) api/builtin-ensure > stores/providerStore > lib/builtin-slot-eviction
 *   2) api/lu-engine-switch > api/providers > api/providers/openai-provider >
 *      api/builtin-ensure > stores/providerStore > lib/builtin-slot-eviction
 *   3) api/builtin-ensure > stores/providerStore > lib/builtin-slot-eviction >
 *      stores/modelStore > api/engine
 *   4) stores/providerStore > lib/builtin-slot-eviction > stores/modelStore >
 *      api/engine
 *   5) stores/providerStore > lib/builtin-slot-eviction > stores/modelStore >
 *      stores/chatStore > stores/remoteStore
 *
 * Gemessen mit einer bereinigten Kopie des Baums: nimmt man genau die drei
 * `await import(...)` aus lib/builtin-slot-eviction.ts heraus, meldet madge
 * "No circular dependency found". Es haengt an diesen Kanten und an nichts
 * sonst.
 *
 * Der Satz, der im Repo schon steht (stores/providerStore.ts, Audit W-T2):
 * "Die Begruendung stimmte, die Aufloesung nicht: der dynamische Import hat den
 * Kreis nicht geoeffnet, sondern nur unsichtbar gemacht." Dieselbe Umkehr wie
 * dort: der eine sagt an, der andere meldet sich an, und die Leitung dazwischen
 * gehoert keinem von beiden.
 *
 * Diese Wache haelt beides fest, den offenen Kreis UND die Wirkung, die dabei
 * unveraendert bleiben musste. Der Steckplatzwechsel ohne geladene Wechselzeile
 * steht in der-steckplatz-nimmt-die-wahl-mit.test.ts, die api/lu-engine-switch
 * bewusst nicht laedt.
 *
 * Run: npx vitest run src/lib/__tests__/die-leitung-oeffnet-den-kreis.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

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

// Nur der Start der Engine wird abgefangen, der Rest des Moduls bleibt echt:
// `builtinSlotSwitchedOff` liest den providerStore und ist genau die Frage, die
// der Rueckweg zum Zustellzeitpunkt stellen muss.
const { ensureSpy } = vi.hoisted(() => ({ ensureSpy: vi.fn(async (_name: string) => {}) }))
vi.mock('../../api/builtin-ensure', async (importOriginal) => {
  const echt = await importOriginal<typeof import('../../api/builtin-ensure')>()
  return { ...echt, ensureBuiltinEngineAlive: (name: string) => ensureSpy(name) }
})

const {
  __resetBuiltinSlotOffloadForTests,
  BUILTIN_SLOT_OFFLOAD_GRACE_MS,
} = await import('../builtin-slot-eviction')
const { slotHandbackUpdate } = await import('../openai-slot-handover')
const { handbackAwaitsTheUsersPick, CHAT_PROVIDER_SWITCH_HOLD_MS } = await import('../../api/lu-engine-switch')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')
const { useLuEngineSwitchStore } = await import('../../stores/luEngineSwitchStore')

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8')
/** Nur der ausfuehrbare Teil, ohne die Kommentare, die den Kreis erklaeren. */
const ohneKommentare = (quelle: string) =>
  quelle.split('\n').filter((z) => !/^\s*(\*|\/\/|\/\*)/.test(z)).join('\n')

const LU_ROW = 'openai::Qwen3-4B-Q4_K_M'
const LMS_ROW = 'openai::qwen2.5-0.5b-instruct@q4_k_m'
const OLLAMA_ROW = 'llama3:8b'
const LMS_URL = 'http://localhost:1234/v1'

const ROWS = [
  { name: LU_ROW, model: 'Qwen3-4B-Q4_K_M', size: 2_300_000_000, type: 'text', provider: 'openai', providerName: 'LU Engine' },
  { name: LMS_ROW, model: 'qwen2.5-0.5b-instruct@q4_k_m', size: 0, type: 'text', provider: 'openai', providerName: 'LM Studio' },
  { name: OLLAMA_ROW, model: OLLAMA_ROW, size: 0, type: 'text', provider: 'ollama', providerName: 'Ollama' },
]

/** Der Steckplatz nach einem Wechsel zur LU Engine: unsere Engine drin, LM
 *  Studio auf der Standby-Karte. */
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

/** Mikrotasks durchlassen. Die Kette ist zwei Stufen tief, genau wie die beiden
 *  `await import(...)` vorher: ansagen, raeumen, ansagen, sagen. */
async function durchlassen(): Promise<void> {
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0)
}

const zeile = () => useLuEngineSwitchStore.getState().note

beforeEach(async () => {
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(CHAT_PROVIDER_SWITCH_HOLD_MS + 1)
  handbackAwaitsTheUsersPick()
  backendCall.mockClear()
  ensureSpy.mockClear()
  __resetBuiltinSlotOffloadForTests()
  useLuEngineSwitchStore.getState().dismiss()
  useModelStore.setState({ activeModel: null })
  useProviderStore.getState().resetProvidersToDefaults()
  await durchlassen()
  useModelStore.setState({ models: ROWS as never, activeModel: null })
  __resetBuiltinSlotOffloadForTests()
  useLuEngineSwitchStore.getState().dismiss()
  backendCall.mockClear()
  ensureSpy.mockClear()
})
afterEach(() => {
  __resetBuiltinSlotOffloadForTests()
  vi.useRealTimers()
})

describe('DER KREIS IST AUF, nicht nur unsichtbar', () => {
  it('die Regel holt sich weder einen Store noch eine api-Datei nach', () => {
    const code = ohneKommentare(read('src/lib/builtin-slot-eviction.ts'))
    expect(code, 'ein dynamischer Import ist fuer madge dieselbe Kante').not.toMatch(/await import\(/)
    expect(code).not.toMatch(/import\(\s*['"]\.\.\/(stores|api)\//)
  })

  it('die Leitung selbst hat keine einzige Laufzeitkante', () => {
    // Der Punkt der ganzen Bauform. Ein Leitungsmodul, das selbst irgendwohin
    // zeigt, verschiebt den Kreis nur.
    const leitung = read('src/lib/builtin-slot-handover.ts')
    const kanten = leitung.match(/^import\s+(?!type\b)/gm)
    expect(kanten, 'die Leitung importiert zur Laufzeit').toBeNull()
  })

  it('der Modell-Store meldet sich an, statt sich holen zu lassen', () => {
    const store = read('src/stores/modelStore.ts')
    expect(store).toMatch(/onBuiltinSlotLostToForeignBackend\(/)
    expect(store).toMatch(/onBuiltinSlotRegained\(/)
  })

  it('die Wechselzeile meldet sich an, und ihr Modul haengt am Hauptfenster', () => {
    // Anders als der Modell-Store ist api/lu-engine-switch nicht in jedem
    // Webview geladen. Im Hauptfenster traegt es AppShell; faellt dieser Anker,
    // wird die Ansage stumm, ohne dass sonst etwas rot wird.
    expect(read('src/api/lu-engine-switch.ts')).toMatch(/onChatPickLostItsEngine\(/)
    expect(read('src/components/layout/AppShell.tsx'))
      .toMatch(/from '\.\.\/\.\.\/api\/lu-engine-switch'/)

    // Die Kette hat ein zweites Glied, und ohne dieses hier war sie nur halb
    // bewacht: dass AppShell aus lu-engine-switch importiert, nuetzt nichts,
    // wenn AppShell selbst erst spaeter geladen wird. Wird der Import in
    // App.tsx eines Tages ein `lazy(() => import(...))`, bliebe die Zusicherung
    // darueber gruen und die Ansage im Hauptfenster trotzdem stumm. Deshalb
    // steht hier ausdruecklich, dass es ein STATISCHER Import ist.
    const app = read('src/App.tsx')
    expect(app, 'App.tsx laedt AppShell nicht mehr statisch, der Anker traegt nicht')
      .toMatch(/^import \{[^}]*\bAppShell\b[^}]*\} from/m)
    expect(app, 'AppShell haengt jetzt an einem dynamischen Import')
      .not.toMatch(/lazy\([^)]*AppShell|import\([^)]*AppShell/)
  })

  it('kein Gedankenstrich in der neuen Leitung', () => {
    expect(read('src/lib/builtin-slot-handover.ts')).not.toMatch(/[–—]/)
  })
})

describe('DIE WIRKUNG BLEIBT: Enable auf der Standby-Karte', () => {
  it('die Wahl faellt, und die Zeile nennt beide Namen', async () => {
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()

    expect(useProviderStore.getState().providers.openai.managed).toBe(false)
    expect(useModelStore.getState().activeModel).toBeNull()
    const satz = zeile()
    expect(satz, 'kein Wort zum gewechselten Chip').not.toBeNull()
    expect(satz).toContain('Qwen3-4B-Q4_K_M')
    expect(satz).toContain('LM Studio')
  })

  it('und die Nachsicht bleibt ganz: geraeumt wird ohne zweites stop_bundled_engine', async () => {
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()
    expect(useModelStore.getState().activeModel).toBeNull()
    expect(backendCall, 'die Nachsicht wurde ueberholt').not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(BUILTIN_SLOT_OFFLOAD_GRACE_MS)
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(backendCall.mock.calls[0][0]).toBe('stop_bundled_engine')
  })

  it('eine Wahl, die der Aufrufer im selben Durchlauf neu setzt, bleibt stehen', async () => {
    // Die Reihenfolge aus useModels.activateModel. Die Zustellung muss deshalb
    // hinter der laufenden set()-Runde liegen, sonst raeumt dieser Weg eine
    // Wahl, die er heute stehen laesst.
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    useModelStore.setState({ activeModel: LMS_ROW })
    await durchlassen()

    expect(useModelStore.getState().activeModel).toBe(LMS_ROW)
    expect(zeile()).toBeNull()
  })

  it('eine Ollama-Wahl ueberlebt die Uebergabe und bekommt kein Wort', async () => {
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: OLLAMA_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()

    expect(useModelStore.getState().activeModel).toBe(OLLAMA_ROW)
    expect(zeile()).toBeNull()
  })

  it('der Rueckweg holt die Engine mit der stehenden Wahl zurueck', async () => {
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    // Die Freigabe wirklich laufen lassen, sonst ist der Rueckweg nur eine
    // abgesagte Frist und hat nichts zu holen.
    enableAufDerStandbyKarte()
    await vi.advanceTimersByTimeAsync(BUILTIN_SLOT_OFFLOAD_GRACE_MS)
    await durchlassen()
    expect(backendCall).toHaveBeenCalledWith('stop_bundled_engine')

    // Die Wahl ist mit dem Steckplatz gefallen. Der Nutzer waehlt sie neu, dann
    // kommt der Steckplatz zurueck (Enable auf der Karte der LU Engine).
    useModelStore.setState({ activeModel: LU_ROW })
    enableAufDerStandbyKarte()
    await durchlassen()

    expect(useProviderStore.getState().providers.openai.managed).toBe(true)
    expect(ensureSpy).toHaveBeenCalledWith(LU_ROW)
  })

  it('ohne gelaufene Freigabe wird nichts zurueckgeholt', async () => {
    // Sonst wuerde jedes Enable auf einer Karte, die den Steckplatz nie
    // verloren hat, eine Engine anstossen, die laengst laeuft.
    luEngineImSteckplatz()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })

    enableAufDerStandbyKarte()
    await durchlassen()
    useModelStore.setState({ activeModel: LU_ROW })
    enableAufDerStandbyKarte()
    await durchlassen()

    expect(ensureSpy).not.toHaveBeenCalled()
  })
})
