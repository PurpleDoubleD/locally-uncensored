/**
 * AS-09, Settings-Haelfte: der Abschnitt „Speech" als eigene Komponente und
 * die eine Probe-und-Installier-Maschine hinter STT und TTS.
 *
 * Wie in der Onboarding-Haelfte zwei Sorten Zusicherung:
 *
 *   — `makeProbeReducer` ist rein, also ist der erste Block echtes Verhalten.
 *   — Der zweite Block ist Buchfuehrung am Quelltext, mit Sperrklinken:
 *     die Zahlen duerfen sinken, nicht steigen.
 *
 * Was hier NICHT bewiesen wird: dass der Abschnitt im Fenster gleich
 * aussieht wie vorher. Das Projekt hat keinen Renderer (`environment:
 * 'node'`), der Vergleich lief von Hand am laufenden Dev-Server.
 *
 * Lauf: npx vitest run src/components/settings/__tests__/speech-abschnitt-und-probe.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initialProbe, makeProbeReducer, needsInstall, showsHint, type ProbeInstall } from '../probe-install'

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const read = (rel: string) => codeOnly(readFileSync(resolve(__dirname, '..', rel), 'utf8'))
const PAGE = read('SettingsPage.tsx')
const SPEECH = read('SpeechSettings.tsx')

interface Probe { available: boolean }
const reducer = makeProbeReducer<Probe>()
const run = (...actions: Parameters<typeof reducer>[1][]): ProbeInstall<Probe> =>
  actions.reduce(reducer, initialProbe<Probe>())

describe('die Probe-und-Installier-Maschine', () => {
  it('faengt ladend an — ein rotes Kreuz vor dem ersten Ergebnis waere gelogen', () => {
    const s = initialProbe<Probe>()
    expect(s).toEqual({ probe: null, loading: true, installing: false, installError: null })
    // Und solange nichts vorliegt, wird auch kein Installationsknopf angeboten.
    expect(needsInstall(s)).toBe(false)
    expect(showsHint(s)).toBe(false)
  })

  it('eine Probe, die etwas findet, bietet keine Installation an', () => {
    const s = run({ type: 'probed', probe: { available: true } })
    expect(s.loading).toBe(false)
    expect(needsInstall(s)).toBe(false)
  })

  it('eine Probe, die nichts findet, bietet sie an — mit Erklaerzeile', () => {
    const s = run({ type: 'probed', probe: { available: false } })
    expect(needsInstall(s)).toBe(true)
    expect(showsHint(s)).toBe(true)
  })

  it('waehrend der Installation bleibt der Knopf, die Erklaerzeile geht', () => {
    const s = run({ type: 'probed', probe: { available: false } }, { type: 'installStart' })
    expect(needsInstall(s)).toBe(true)
    expect(showsHint(s)).toBe(false)
  })

  it('ein Installationsfehler ersetzt die Erklaerzeile', () => {
    const s = run(
      { type: 'probed', probe: { available: false } },
      { type: 'installStart' },
      { type: 'installFailed', error: 'pip exit 1' },
      { type: 'installDone' },
    )
    expect(s.installError).toBe('pip exit 1')
    expect(s.installing).toBe(false)
    expect(showsHint(s)).toBe(false)
  })

  it('ein neuer Anlauf loescht den Fehler des vorigen', () => {
    const s = run(
      { type: 'installStart' },
      { type: 'installFailed', error: 'pip exit 1' },
      { type: 'installDone' },
      { type: 'installStart' },
    )
    expect(s.installError).toBeNull()
    expect(s.installing).toBe(true)
  })

  it('eine gescheiterte Probe laesst den letzten bekannten Stand stehen', () => {
    // Genau wie vorher: `setStatus` stand im `.then`, `setLoading(false)` im
    // `.finally`. Ein Fehlschlag hat den Status nicht auf null gesetzt.
    const s = run({ type: 'probed', probe: { available: true } }, { type: 'probing' }, { type: 'probeFailed' })
    expect(s.probe).toEqual({ available: true })
    expect(s.loading).toBe(false)
  })

  it('`installDone` sagt nichts ueber Erfolg — das sagt die Probe danach', () => {
    // Der `finally`-Block der beiden Handler feuert auf JEDEM Weg und stoesst
    // danach die Probe an. Die Phase „fertig installiert" gibt es hier
    // bewusst nicht: ob etwas da ist, weiss nur die Probe.
    const s = run({ type: 'installStart' }, { type: 'installDone' })
    expect(s.installing).toBe(false)
    expect(s.probe).toBeNull()
  })
})

describe('AS-09: der Abschnitt ist ausgezogen, nicht nur verschoben', () => {
  it('SettingsPage() haelt hoechstens 2 eigene `useState` — vorher 13', () => {
    // Sperrklinke. Die 13 waren: whisperStatus/Loading/Installing/InstallError,
    // ttsStatus/Loading/Installing/InstallError, installedVoices, voiceBusy,
    // voiceError, entryFocus, tab. Elf davon gehoerten dem Speech-Abschnitt.
    const body = PAGE.slice(PAGE.indexOf('export function SettingsPage()'), PAGE.indexOf('\nfunction UpdateSection()'))
    expect((body.match(/=\s*useState[<(]/g) ?? []).length).toBeLessThanOrEqual(2)
  })

  it('die acht doppelt gefuehrten Felder sind eine Maschine, zweimal benutzt', () => {
    expect((SPEECH.match(/=\s*useReducer\(/g) ?? []).length).toBe(2)
    expect(SPEECH).toContain('makeProbeReducer<WhisperProbe>()')
    expect(SPEECH).toContain('makeProbeReducer<TtsProbe>()')
    // Und die alten acht Namen gibt es nirgends mehr.
    for (const gone of [
      'whisperStatus', 'whisperLoading', 'whisperInstalling', 'whisperInstallError',
      'ttsStatus', 'ttsLoading', 'ttsInstalling', 'ttsInstallError',
    ]) {
      expect(PAGE, gone).not.toContain(gone)
      expect(SPEECH, gone).not.toContain(gone)
    }
  })

  it('die Proben laufen im Abschnitt, nicht beim Oeffnen der Seite', () => {
    // DAS ist der Gewinn, der nicht in der Zahl steckt: der Mount-Effekt mit
    // den drei Backend-Aufrufen stand in SettingsPage() und lief bei JEDEM
    // Oeffnen der Einstellungen — auch auf „General", wo der Abschnitt gar
    // nicht gerendert wird.
    expect(PAGE).not.toContain('checkWhisperAvailable')
    expect(PAGE).not.toContain('listInstalledPiperVoices')
    expect(SPEECH).toContain('void refreshWhisper()')
    expect(SPEECH).toContain('void refreshTts()')
    expect(SPEECH).toContain('void refreshVoices()')
    // Und der Abschnitt haengt wirklich nur am Voice-Tab.
    const voiceBranch = PAGE.slice(PAGE.indexOf("{tab === 'voice-remote' && (<>"), PAGE.indexOf('<ResetSection tab={tab} />'))
    expect(voiceBranch).toContain('<SpeechSettings />')
    expect((PAGE.match(/<SpeechSettings \/>/g) ?? []).length).toBe(1)
  })

  it('SettingsPage abonniert nicht mehr den GANZEN Voice-Store', () => {
    // `const voiceSettings = useVoiceStore()` ohne Selektor liess die ganze
    // Seite bei jedem Schreibvorgang im Voice-Store neu rendern — auch beim
    // Tippen in ein Feld eines anderen Tabs.
    expect(PAGE).not.toContain('const voiceSettings = useVoiceStore()')
    expect(PAGE).toContain('useVoiceStore((s) => s.resetVoiceDefaults)')
  })

  it('der Zeilenschalter steht einmal, nicht zweimal', () => {
    const toggle = read('InlineToggle.tsx')
    expect((toggle.match(/export function InlineToggle/g) ?? [])).toHaveLength(1)
    expect(PAGE).not.toMatch(/function InlineToggle\(/)
    expect(SPEECH).not.toMatch(/function InlineToggle\(/)
    expect(PAGE).toContain("import { InlineToggle } from './InlineToggle'")
    expect(SPEECH).toContain("import { InlineToggle } from './InlineToggle'")
  })

  it('die Stimmenlisten stehen bei dem Abschnitt, der sie benutzt', () => {
    expect(PAGE).not.toContain('PIPER_VOICES')
    expect(PAGE).not.toContain('CLOUD_TTS_VOICES')
    expect(SPEECH).toContain('const PIPER_VOICES')
    expect(SPEECH).toContain('const CLOUD_TTS_VOICES')
  })

  it('NEGATIVKONTROLLE: die Auffrischung nach der Installation ist NICHT weggefallen', () => {
    // Die Proben schreiben weiterhin in den Voice-Store, sonst wachte der
    // Mikrofonknopf nach einer In-App-Installation erst beim Neustart auf.
    expect(SPEECH).toContain('setSttAvailable(!!s.available)')
    expect(SPEECH).toContain('setTtsAvailable(!!s.available)')
    expect(SPEECH).toContain('await refreshWhisper()')
    expect(SPEECH).toContain('await refreshTts()')
  })

  it('D-S30 gilt auch hier: der gewaehlte Motor ist kein Aktionsknopf', () => {
    expect(SPEECH).toContain('bg-lu-accent-soft text-gray-900 dark:text-white border-lu-accent-edge dark:border-lu-accent')
    expect(SPEECH).not.toContain('bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white border-gray-300')
  })
})
