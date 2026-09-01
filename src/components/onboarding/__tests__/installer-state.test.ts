/**
 * Die eine Installer-Zustandsmaschine (AS-09) — und die Rechnung, dass die
 * Zerlegung wirklich eine ist.
 *
 * Zwei Teile:
 *
 *  1. `installerReducer` als Verhalten. Er ist rein, also ist das hier ein
 *     echter Verhaltenstest, kein Quelltextabgleich. Geprueft sind vor allem
 *     die drei Regeln, die vorher pro Installer als lose Zeilenfolge in
 *     einem Klick-Handler standen und deshalb pro Installer anders sein
 *     konnten — und teilweise waren.
 *
 *  2. Die BUCHFUEHRUNG. Eine Zerlegung, die 34 `useState` auf vier Dateien
 *     verteilt, hat nichts gewonnen. Die Zahlen unten werden aus der Datei
 *     gezaehlt, nicht behauptet, und sie sind eine Sperrklinke: sie duerfen
 *     sinken, nicht steigen.
 *
 * Lauf: npx vitest run src/components/onboarding/__tests__/installer-state.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  installerReducer,
  IDLE_INSTALLER,
  isRunning,
  isReady,
  elapsedSeconds,
  formatElapsed,
  lastLog,
  type InstallerState,
} from '../installer-state'

/**
 * Nur der Code. Die Zaehlungen und die Negativkontrollen unten duerfen nicht
 * an Kommentaren haengen, die die alten Namen zitieren, um die Aenderung zu
 * erklaeren.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const SRC = codeOnly(readFileSync(resolve(__dirname, '..', 'Onboarding.tsx'), 'utf8'))

/** Kurzschreibweise: eine Folge von Aktionen auf den Ruhezustand anwenden. */
const run = (...actions: Parameters<typeof installerReducer>[1][]): InstallerState =>
  actions.reduce(installerReducer, IDLE_INSTALLER)

describe('der Reducer: der Ablauf, den alle vier Installer teilen', () => {
  it('im Ruhezustand laeuft nichts und ist nichts fertig', () => {
    expect(isRunning(IDLE_INSTALLER)).toBe(false)
    expect(isReady(IDLE_INSTALLER)).toBe(false)
    expect(IDLE_INSTALLER.error).toBe('')
    expect(IDLE_INSTALLER.startedAt).toBeNull()
  })

  it('`start` merkt sich die Startzeit und nimmt die erste Logzeile an', () => {
    const s = run({ type: 'start', at: 1000, log: 'Installing Python 3.12 via winget…' })
    expect(isRunning(s)).toBe(true)
    expect(s.startedAt).toBe(1000)
    expect(s.logs).toEqual(['Installing Python 3.12 via winget…'])
  })

  it('`start` loescht den Fehler des vorigen Versuchs', () => {
    const s = run({ type: 'start', at: 1 }, { type: 'fail', error: 'boom' }, { type: 'start', at: 2 })
    expect(s.error).toBe('')
    expect(isRunning(s)).toBe(true)
  })

  it('`start` loescht auch Fortschritt und Logs des vorigen Versuchs', () => {
    // Das war vorher NICHT so: die vier Klick-Handler setzten beim Neustart
    // `installing`, `error`, `startTime` und `elapsed` zurueck — aber nicht
    // `status`, `logs`, `progress`, `total`, `speed`. Ein zweiter Anlauf
    // startete deshalb mit dem Fortschrittsbalken des ersten.
    const s = run(
      { type: 'start', at: 1 },
      { type: 'progress', status: 'downloading', logs: ['a', 'b'], received: 50, total: 100, speed: 10 },
      { type: 'fail', error: 'boom' },
      { type: 'start', at: 2 },
    )
    expect(s).toMatchObject({ status: '', logs: [], received: 0, total: 0, speed: 0 })
  })

  it('`progress` fuehrt nur die Felder nach, die der Tick wirklich brachte', () => {
    const s = run(
      { type: 'start', at: 0 },
      { type: 'progress', status: 'downloading', received: 10, total: 100 },
      { type: 'progress', received: 20 },
    )
    expect(s).toMatchObject({ status: 'downloading', received: 20, total: 100 })
  })

  it('ein `progress` NACH dem Ende aendert nichts mehr', () => {
    // Der Poll laeuft asynchron. Zwischen `clearInterval` und der letzten
    // Antwort kann noch ein Tick unterwegs sein; vorher hat der die Anzeige
    // einer fertigen Installation wieder auf „laeuft" gezogen.
    const done = run({ type: 'start', at: 0 }, { type: 'ready' })
    expect(installerReducer(done, { type: 'progress', status: 'downloading', received: 5 })).toBe(done)

    const failed = run({ type: 'start', at: 0 }, { type: 'fail', error: 'boom' })
    expect(installerReducer(failed, { type: 'progress', received: 5 })).toBe(failed)
  })

  it('`ready` und `fail` loeschen beide die Startzeit — sonst laeuft die Uhr weiter', () => {
    expect(run({ type: 'start', at: 5 }, { type: 'ready' }).startedAt).toBeNull()
    expect(run({ type: 'start', at: 5 }, { type: 'fail', error: 'x' }).startedAt).toBeNull()
  })

  it('`ready` loescht den Fehler, `fail` setzt ihn', () => {
    expect(run({ type: 'start', at: 0 }, { type: 'fail', error: 'x' }, { type: 'ready' }).error).toBe('')
    const f = run({ type: 'start', at: 0 }, { type: 'fail', error: 'did not finish' })
    expect(f.error).toBe('did not finish')
    expect(isRunning(f)).toBe(false)
    expect(isReady(f)).toBe(false)
  })

  it('`warn` meldet, ohne die Phase umzuwerfen — der ComfyUI-Fall', () => {
    // Installation durch, `start_comfyui` danach nicht: „failed" waere dafuer
    // die falsche Auskunft, die Installation IST gelungen.
    const s = run({ type: 'start', at: 0 }, { type: 'ready' }, { type: 'warn', error: 'installed but did not start' })
    expect(isReady(s)).toBe(true)
    expect(s.error).toBe('installed but did not start')
    // Und ein leerer String loescht die Meldung wieder.
    expect(installerReducer(s, { type: 'warn', error: '' }).error).toBe('')
  })

  it('`reset` fuehrt wirklich auf den Ruhezustand zurueck', () => {
    const s = run({ type: 'start', at: 9 }, { type: 'progress', received: 3 }, { type: 'reset' })
    expect(s).toEqual(IDLE_INSTALLER)
  })
})

describe('abgeleitet statt gespeichert: die Uhr', () => {
  it('vergangene Sekunden sind eine Subtraktion, kein Zustand', () => {
    expect(elapsedSeconds(10_000, 10_000)).toBe(0)
    expect(elapsedSeconds(10_000, 11_500)).toBe(1)
    expect(elapsedSeconds(10_000, 135_000)).toBe(125)
  })

  it('ohne Start ist nichts vergangen', () => {
    expect(elapsedSeconds(null, 999_999)).toBe(0)
  })

  it('nie negativ — der Takt kann eine Sekunde alt sein, wenn ein Lauf beginnt', () => {
    // Der gemeinsame Takt speichert `Date.now()` einmal pro Sekunde. Startet
    // ein Installer dazwischen, liegt `startedAt` hinter dem letzten Takt.
    expect(elapsedSeconds(11_000, 10_000)).toBe(0)
  })

  it('`m:ss` wie in allen vier Anzeigen vorher', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(9)).toBe('0:09')
    expect(formatElapsed(60)).toBe('1:00')
    expect(formatElapsed(125)).toBe('2:05')
    expect(formatElapsed(3_600)).toBe('60:00')
  })

  it('die letzte Logzeile, ohne die vier handgeschriebenen Kopien', () => {
    expect(lastLog(['a', 'b'])).toBe('b')
    expect(lastLog([])).toBe('')
    expect(lastLog(undefined)).toBe('')
  })
})

// ── Die Buchfuehrung ──────────────────────────────────────────────────────

describe('AS-09: die Zerlegung ist eine, keine Verschiebung', () => {
  const useStates = (SRC.match(/=\s*useState[<(]/g) ?? []).length
  const useReducers = (SRC.match(/=\s*useReducer\(/g) ?? []).length

  it('Onboarding.tsx haelt hoechstens 25 `useState` — vorher 58', () => {
    // Sperrklinke: die Zahl darf sinken, nicht steigen. 58 ist der Stand am
    // HEAD (`ed9d6e52`), den AUDIT-COVERAGE unter AS-09 mit „59" fuehrt —
    // der Audit zaehlt die Import-Zeile mit.
    expect(useStates).toBeLessThanOrEqual(25)
  })

  it('die vier Installer sind vier Reducer auf EINER Maschine', () => {
    expect(useReducers).toBe(4)
    for (const name of ['comfyInstall', 'pythonInstall', 'ollama', 'lmstudio']) {
      expect(SRC).toContain(`useReducer(installerReducer, IDLE_INSTALLER)`)
      expect(SRC, name).toContain(name)
    }
  })

  it('und die Maschine steht genau einmal, in einer eigenen Datei', () => {
    const machine = readFileSync(resolve(__dirname, '..', 'installer-state.ts'), 'utf8')
    expect((machine.match(/export function installerReducer/g) ?? [])).toHaveLength(1)
    // Keine zweite Kopie in der Komponente: die alten Feldnamen sind fort.
    for (const gone of [
      'setOllamaInstalling', 'setLmstudioInstalling', 'setComfyInstalling', 'setPythonInstalling',
      'setOllamaElapsed', 'setLmstudioElapsed', 'setPythonElapsed', 'setInstallStartTime',
      'setPythonReady', 'setOllamaReady', 'setLmstudioReady',
    ]) {
      expect(SRC, gone).not.toContain(gone)
    }
  })

  it('EIN Takt statt vier Intervallen', () => {
    // Das Muster `setInterval(() => set<X>Elapsed(...))` gab es viermal.
    expect(SRC).not.toMatch(/setInterval\([^)]*Elapsed/)
    expect(SRC).toContain('const [now, setNow] = useState(() => Date.now())')
    expect(SRC).toContain('setInterval(() => setNow(Date.now()), 1000)')
    // Und er laeuft nur, wenn ueberhaupt etwas laeuft.
    expect(SRC).toContain('if (anyStartedAt === null) return')
  })

  it('NEGATIVKONTROLLE: die Schrittzahl allein waere keine Zerlegung gewesen', () => {
    // Der Audit verlangt „eine Zerlegung pro Schritt". Eine solche haette die
    // 34 Felder auf sechs Dateien verteilt und vier Kopien vier Kopien
    // gelassen. Was zaehlt, ist, dass die WIEDERHOLUNG weg ist: ein
    // Modul beschreibt vier Installer.
    const machine = readFileSync(resolve(__dirname, '..', 'installer-state.ts'), 'utf8')
    expect((machine.match(/^export (function|const|type|interface) /gm) ?? []).length).toBeGreaterThan(5)
    expect(useReducers).toBe(4)
  })
})
