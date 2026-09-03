/**
 * T-69 · Der Timer, der nie aufhoerte
 *
 * Der Befund (Technik-Audit, „Discovery & Downloads", `DiscoverModels.tsx:586`):
 *
 *   „The built-in-engine install path awaits each file with an uncancellable
 *    setInterval that never settles if the user pauses or cancels — leaking a
 *    2 Hz timer per attempt and hanging the install promise forever."
 *
 * Am HEAD stand das so da (`:595-601`): ein `setInterval(…, 500)`, dessen
 * `clearInterval` nur in zwei Zweigen vorkam, `complete` und `error`. Der
 * Download kennt aber sechs Zustaende, und `cancel()` loescht die Zeile ganz.
 * Pause, Abbruch und Ansichtswechsel trafen also keinen der beiden Zweige.
 *
 * Diese Datei prueft die fuenf Ausgaenge einzeln und dazu zwei Dinge, die der
 * alte Code beide nicht konnte: dass am Ende KEIN Timer mehr laeuft, und dass
 * das Abonnement abgemeldet ist.
 *
 * Kein Mock: der Store hier ist ein echter zustand-Store aus derselben
 * vendorten Version (5.0.12), die `downloadStore` benutzt — dieselbe
 * `subscribe`/`setState`-Mechanik, nur ohne Rust und ohne Persistenz. Der
 * duenne Zaehler um `subscribe` reicht jeden Aufruf durch und ersetzt nichts;
 * er ist da, weil zustand die Zahl seiner Zuhoerer nicht selbst herausgibt.
 *
 * Run: npx vitest run src/components/models/__tests__/der-timer-der-nie-aufhoerte.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { create } from 'zustand'
import { awaitDownloadedFile, FIRST_SIGHT_MS, type DownloadWatcher } from '../DiscoverModels'
import type { DownloadProgress } from '../../../types/downloads'

const row = (
  filename: string,
  status: DownloadProgress['status'],
  error?: string,
): DownloadProgress => ({ progress: 0, total: 100, speed: 0, filename, status, error })

function realStore() {
  const store = create<{ downloads: Record<string, DownloadProgress> }>(() => ({ downloads: {} }))
  let live = 0
  const watcher: DownloadWatcher = {
    getState: () => store.getState(),
    subscribe: (listener) => {
      live += 1
      const off = store.subscribe(listener)
      return () => { live -= 1; off() }
    },
  }
  return {
    watcher,
    put: (r: DownloadProgress) =>
      store.setState(s => ({ downloads: { ...s.downloads, [r.filename]: r } })),
    drop: (filename: string) =>
      store.setState(s => {
        const d = { ...s.downloads }
        delete d[filename]
        return { downloads: d }
      }),
    liveSubscriptions: () => live,
  }
}

const GGUF = 'Qwen3-8B-Q4_K_M.gguf'

describe('T-69 · jeder Ausgang settelt und raeumt auf', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fertig heisst fertig', async () => {
    const s = realStore()
    const ctl = new AbortController()
    s.put(row(GGUF, 'downloading'))
    const wait = awaitDownloadedFile(s.watcher, GGUF, ctl.signal)
    s.put(row(GGUF, 'complete'))
    await expect(wait).resolves.toBe('complete')
    expect(s.liveSubscriptions()).toBe(0)
  })

  it('eine Datei, die beim Hinsehen schon fertig ist, wird nicht uebersehen', async () => {
    // Ein reines Abonnement verpasst genau diesen Fall: es wartet auf die
    // NAECHSTE Aenderung, und die kommt nie mehr.
    const s = realStore()
    s.put(row(GGUF, 'complete'))
    await expect(awaitDownloadedFile(s.watcher, GGUF, new AbortController().signal))
      .resolves.toBe('complete')
    expect(s.liveSubscriptions()).toBe(0)
  })

  it('ein Fehlschlag kommt als Fehler heraus, mit dem Text aus Rust', async () => {
    const s = realStore()
    s.put(row(GGUF, 'downloading'))
    const wait = awaitDownloadedFile(s.watcher, GGUF, new AbortController().signal)
    s.put(row(GGUF, 'error', 'HTTP 404'))
    await expect(wait).rejects.toThrow('HTTP 404')
    expect(s.liveSubscriptions()).toBe(0)
  })

  it('PAUSE beendet das Warten — der Fall, der vorher fuer immer stehenblieb', async () => {
    const s = realStore()
    s.put(row(GGUF, 'downloading'))
    const wait = awaitDownloadedFile(s.watcher, GGUF, new AbortController().signal)
    s.put(row(GGUF, 'pausing'))
    s.put(row(GGUF, 'paused'))
    await expect(wait).resolves.toBe('paused')
    expect(s.liveSubscriptions()).toBe(0)
  })

  it('ABBRUCH beendet das Warten — `cancel()` loescht die Zeile, sie wird nicht `error`', async () => {
    // downloadStore.cancel(): `delete updated[id]`. Der alte Code fragte
    // danach ein `undefined` ab und traf keinen seiner beiden Zweige.
    const s = realStore()
    s.put(row(GGUF, 'downloading'))
    const wait = awaitDownloadedFile(s.watcher, GGUF, new AbortController().signal)
    s.drop(GGUF)
    await expect(wait).resolves.toBe('cancelled')
    expect(s.liveSubscriptions()).toBe(0)
  })

  it('ABORT beendet das Warten — die Ansicht wird abgehaengt', async () => {
    const s = realStore()
    s.put(row(GGUF, 'downloading'))
    const ctl = new AbortController()
    const wait = awaitDownloadedFile(s.watcher, GGUF, ctl.signal)
    ctl.abort()
    await expect(wait).resolves.toBe('aborted')
    expect(s.liveSubscriptions()).toBe(0)
  })

  it('ein Signal, das schon abgebrochen ist, legt gar nicht erst los', async () => {
    const s = realStore()
    const ctl = new AbortController()
    ctl.abort()
    await expect(awaitDownloadedFile(s.watcher, GGUF, ctl.signal)).resolves.toBe('aborted')
    expect(s.liveSubscriptions()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('T-69 · „noch nicht da" ist nicht „abgebrochen"', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('eine Zeile, die es noch nicht gibt, gilt nicht als abgebrochen', async () => {
    // Zwischen `startModelDownloadToPath` und dem ersten `refresh()` ist die
    // Zeile leer. Wer das als Abbruch liest, bricht jede Installation sofort ab.
    const s = realStore()
    const wait = awaitDownloadedFile(s.watcher, GGUF, new AbortController().signal)
    vi.advanceTimersByTime(FIRST_SIGHT_MS - 1)
    s.put(row(GGUF, 'connecting'))
    s.put(row(GGUF, 'downloading'))
    s.put(row(GGUF, 'complete'))
    await expect(wait).resolves.toBe('complete')
  })

  it('aber ewig wartet auch dieses Fenster nicht', async () => {
    const s = realStore()
    const wait = awaitDownloadedFile(s.watcher, GGUF, new AbortController().signal)
    const seen = expect(wait).rejects.toThrow(/never showed up/)
    vi.advanceTimersByTime(FIRST_SIGHT_MS)
    await seen
    expect(s.liveSubscriptions()).toBe(0)
  })

  it('die Frist laeuft nur bis zum ersten Lebenszeichen, nicht bis zum Ende', async () => {
    // Ein 40-GB-Download darf Stunden brauchen; die Frist gilt dem Auftauchen
    // der Zeile, nicht dem Herunterladen.
    const s = realStore()
    const wait = awaitDownloadedFile(s.watcher, GGUF, new AbortController().signal)
    s.put(row(GGUF, 'downloading'))
    vi.advanceTimersByTime(FIRST_SIGHT_MS * 10)
    s.put(row(GGUF, 'complete'))
    await expect(wait).resolves.toBe('complete')
  })
})

describe('T-69 · kein Timer bleibt zurueck', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // Der Kern des Befundes: „leaking a 2 Hz timer per attempt". Der alte Code
  // legte einen `setInterval` an, der drei von fuenf Ausgaengen ueberlebte.
  // Hier laeuft nach JEDEM Ausgang kein einziger Timer mehr — und waehrend
  // des Wartens hoechstens einer, die Erstsicht-Frist, kein Abfragetakt.
  const enden: ReadonlyArray<[string, (s: ReturnType<typeof realStore>, c: AbortController) => void]> = [
    ['complete', (s) => s.put(row(GGUF, 'complete'))],
    ['paused', (s) => s.put(row(GGUF, 'paused'))],
    ['cancelled', (s) => s.drop(GGUF)],
    ['aborted', (_s, c) => c.abort()],
  ]

  for (const [name, ende] of enden) {
    it(`nach „${name}" laeuft nichts mehr`, async () => {
      const s = realStore()
      const ctl = new AbortController()
      s.put(row(GGUF, 'downloading'))
      const wait = awaitDownloadedFile(s.watcher, GGUF, ctl.signal)
      // Waehrend des Wartens: KEIN Abfragetakt. Die Erstsicht-Frist ist schon
      // geloescht, weil die Zeile da ist — also genau null Timer.
      expect(vi.getTimerCount()).toBe(0)
      ende(s, ctl)
      await wait
      expect(vi.getTimerCount()).toBe(0)
      expect(s.liveSubscriptions()).toBe(0)
    })
  }

  it('waehrend auf eine noch unsichtbare Zeile gewartet wird, laeuft GENAU eine Frist', async () => {
    const s = realStore()
    const ctl = new AbortController()
    const wait = awaitDownloadedFile(s.watcher, GGUF, ctl.signal)
    expect(vi.getTimerCount()).toBe(1)
    ctl.abort()
    await wait
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('T-69 · der Installpfad benutzt das Warten und keinen Timer mehr', () => {
  // Ohne Render-Harness geprueft am Quelltext — wie es
  // long-transcripts-stay-cheap.test.ts und scroll-pins-bottom.test.ts tun.
  const SRC = new URL('../DiscoverModels.tsx', import.meta.url)

  it('kein setInterval mehr in der Datei', async () => {
    const src = await import('node:fs/promises').then(fs => fs.readFile(SRC, 'utf8'))
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    expect(code).not.toContain('setInterval')
    expect(code).not.toContain('clearInterval')
  })

  it('das Warten haengt an einem AbortSignal, das beim Abhaengen der Ansicht faellt', async () => {
    const src = await import('node:fs/promises').then(fs => fs.readFile(SRC, 'utf8'))
    expect(src).toContain('installWaitRef')
    expect(src).toMatch(/useEffect\(\(\) => \(\) => installWaitRef\.current\?\.abort\(\), \[\]\)/)
    // Ein zweiter Klick darf nicht zwei Warteschlangen auf dieselbe Datei legen.
    expect(src).toMatch(/installWaitRef\.current\?\.abort\(\)\s*\n\s*const wait = new AbortController\(\)/)
  })

  it('nur `complete` fuehrt weiter; Pause und Abbruch sagen es, statt still zu enden', async () => {
    const src = await import('node:fs/promises').then(fs => fs.readFile(SRC, 'utf8'))
    expect(src).toMatch(/if \(outcome === 'complete'\) continue/)
    expect(src).toMatch(/outcome === 'paused'[\s\S]{0,220}setInstallNotice/)
    expect(src).toMatch(/outcome === 'cancelled'[\s\S]{0,220}setInstallNotice/)
    // Eine Pause ist keine Panne: der rote Banner bleibt dem Fehler.
    const notice = src.slice(src.indexOf('{installNotice && ('), src.indexOf('{installNotice && (') + 700)
    expect(notice).not.toMatch(/text-red-|bg-red-/)
  })
})
