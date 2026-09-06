/**
 * Ein Klick auf Use startet die Engine EINMAL, auch wenn sie nicht hochkommt.
 *
 * Gemessen am 03.09.2026 auf dem Windows-Release-Build. Eine absichtlich
 * abgeschnittene GGUF (gueltiger Magic, 2 MB Nullen) ueber den Use-Knopf
 * gestartet, ein Prozesswaechter zaehlte mit: VIER lu-llama-server, in zwei
 * Paaren 5,7 s auseinander, alle vier mit identischem argv. Auf dem Schirm
 * stand "It was tried twice".
 *
 * Ursache sind zwei Aufrufer an einer Engine. `useModels.activateModel` ruft
 * `setActiveModel(name)`, und der Speicher (`stores/modelStore.ts`) startet in
 * derselben Aktualisierung selbst eine Aktivierung; danach ruft der Hook im
 * selben Tick noch einmal. Der Kommentar im Speicher sagt, Rusts argv-
 * Idempotenz mache den zweiten Aufruf zum Nichtstun. Fuer ein Modell, das
 * LAEDT, stimmt das. Fuer eines, das nicht laedt, gibt es keine laufende
 * Engine, mit deren argv man vergleichen koennte, also laeuft die ganze
 * Routine ein zweites Mal, Wiederholungsversuch inklusive.
 *
 * Run: npx vitest run src/api/__tests__/ein-klick-startet-die-engine-einmal.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import { activateBuiltinModel, listBundledModels, __resetActivationsForTests } from '../engine'
import { backendCall } from '../backend'
import type { BuiltinEngineTuning } from '../../types/settings'

/** Die volle Struktur, damit der Test denselben Vertrag benutzt wie die App. */
const einstellung = (ctx: number): BuiltinEngineTuning => ({
  ctx,
  flashAttn: 'auto',
  cacheTypeK: 'f16',
  cacheTypeV: 'f16',
  threads: 0,
  gpuLayers: -1,
  mlock: false,
  noMmap: false,
})

const PFAD = 'C:\\models\\diag-kaputt.gguf'
const aufruf = backendCall as unknown as ReturnType<typeof vi.fn>

/** Wie viele Male ein echter Engine-Start bestellt wurde. */
const starts = () =>
  aufruf.mock.calls.filter(([cmd]) => cmd === 'swap_bundled_model' || cmd === 'start_bundled_engine').length

beforeEach(async () => {
  __resetActivationsForTests()
  aufruf.mockReset()
  // Die Liste einmal echt beantworten, damit der Pfad im Modul bekannt ist.
  aufruf.mockResolvedValueOnce({ models: [{ name: 'diag-kaputt', path: PFAD }] })
  await listBundledModels()
  aufruf.mockReset()
})

describe('zwei Aufrufer, eine Engine', () => {
  it('bestellt bei zwei gleichzeitigen Aktivierungen genau einen Start', async () => {
    aufruf.mockResolvedValue({ port: 8127 })
    const [a, b] = await Promise.all([
      activateBuiltinModel('openai::diag-kaputt'),
      activateBuiltinModel('diag-kaputt'),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(starts()).toBe(1)
  })

  it('bestellt auch dann einen Start, wenn die Engine gar nicht hochkommt', async () => {
    // Der teure Fall: ohne laufende Engine greift Rusts argv-Idempotenz nicht,
    // und der zweite Aufruf haette die ganze Routine ein zweites Mal gefahren.
    const tot = new Error('The LU Engine started and exited again before it could serve on port 8127.')
    aufruf.mockRejectedValue(tot)
    const ergebnisse = await Promise.allSettled([
      activateBuiltinModel('openai::diag-kaputt'),
      activateBuiltinModel('diag-kaputt'),
    ])
    expect(ergebnisse.map((e) => e.status)).toEqual(['rejected', 'rejected'])
    // Beide Aufrufer erfahren denselben Grund, keiner bekommt ein stilles OK.
    for (const e of ergebnisse) {
      expect((e as PromiseRejectedResult).reason).toBe(tot)
    }
    expect(starts()).toBe(1)
  })

  it('laesst einen spaeteren Klick wieder wirklich starten (Negativkontrolle)', async () => {
    // Zusammenfassen darf nur gleichzeitige Aufrufer betreffen. Wer nach einem
    // gescheiterten Start noch einmal klickt, will einen echten neuen Versuch.
    aufruf.mockRejectedValue(new Error('tot'))
    await activateBuiltinModel('diag-kaputt').catch(() => undefined)
    await activateBuiltinModel('diag-kaputt').catch(() => undefined)
    expect(starts()).toBe(2)
  })

  it('trennt zwei Aktivierungen mit unterschiedlicher Einstellung', async () => {
    aufruf.mockResolvedValue({ port: 8127 })
    await Promise.all([
      activateBuiltinModel('diag-kaputt', einstellung(8192)),
      activateBuiltinModel('diag-kaputt', einstellung(32768)),
    ])
    expect(starts()).toBe(2)
  })
})
