/**
 * Dieselbe Zahl darf nicht in vier Schreibweisen dastehen.
 *
 * Gegenprobe G2, 04.09.2026, echter Windows-Build. Der Wert 8192, die
 * Kontextlaenge der laufenden Engine, erschien an fuenf Stellen in vier
 * Schreibweisen, zwei davon auf demselben Bildschirm:
 *
 *   Settings, LU Engine (expert), Statuszeile      ctx 8,192
 *   Settings, dasselbe Feld drei Zeilen tiefer     8192
 *   Settings, Hilfetext daneben                    0 = default (8192)
 *   Chat, Zaehler ueber dem Eingabefeld            1.3k/8.2k
 *   Chat, Klapplade desselben Zaehlers             Auto · 8K
 *
 * Im Chat standen also 8192 geteilt durch 1000 und 8192 geteilt durch 1024
 * uebereinander. In ContextDropdown stand seit D-S06 der richtige Satz dazu
 * ("Wer den Unterschied las, suchte einen, den es nicht gibt"), aber die
 * beiden Rechnungen standen weiter nebeneinander, jede in ihrer Datei.
 *
 * Zwei Entscheidungen, beide begruendet:
 *
 *  1. Im Chat gewinnt die Kibi-Rechnung, weil die Stufen des Reglers echte
 *     Zweierpotenzen sind. 4096, 8192, 16384 heissen 4K, 8K, 16K.
 *  2. In den Einstellungen gewinnt die rohe Zahl, weil das Eingabefeld
 *     darunter und der Hilfetext daneben roh sind.
 *
 * Run: npx vitest run src/lib/__tests__/eine-zahl-eine-schreibweise.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatContextWindow } from '../formatters'
import { ENGINE_DEFAULT_CTX } from '../builtin-ctx'

const lies = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')

describe('formatContextWindow', () => {
  it('die Stufen des Reglers heissen, wie sie heissen', () => {
    expect(formatContextWindow(4096)).toBe('4K')
    expect(formatContextWindow(8192)).toBe('8K')
    expect(formatContextWindow(16384)).toBe('16K')
    expect(formatContextWindow(32768)).toBe('32K')
    expect(formatContextWindow(65536)).toBe('64K')
    expect(formatContextWindow(131072)).toBe('128K')
  })

  it('ein krummer Zwischenwert behaelt eine Nachkommastelle', () => {
    // Der Verbrauch ist nie eine Zweierpotenz, und auf die naechste Stufe
    // gerundet saehe er aus wie das Fenster selbst.
    expect(formatContextWindow(1300)).toBe('1.3K')
    expect(formatContextWindow(20000)).toBe('19.5K')
  })

  it('unter der ersten Stufe steht die Zahl selbst', () => {
    expect(formatContextWindow(512)).toBe('512')
    expect(formatContextWindow(1)).toBe('1')
  })

  it('null heisst Auto und nicht null', () => {
    expect(formatContextWindow(0)).toBe('Auto')
    expect(formatContextWindow(-1)).toBe('Auto')
  })

  // Negativkontrolle: genau das war der Fehler, die beiden Rechnungen an
  // derselben Zahl.
  it('die alten zwei Rechnungen sagten Verschiedenes', () => {
    const alt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    expect(alt(8192)).toBe('8.2k')
    expect(formatContextWindow(8192)).toBe('8K')
    expect(alt(8192).toLowerCase()).not.toBe(formatContextWindow(8192).toLowerCase())
  })
})

describe('verdrahtet', () => {
  it('Zaehler und Klapplade rechnen aus derselben Hand', () => {
    const zaehler = lies('components/chat/TokenCounter.tsx')
    const lade = lies('components/chat/ContextDropdown.tsx')
    expect(zaehler).toContain('const formatK = formatContextWindow')
    expect(lade).toContain('const fmt = formatContextWindow')
    // Und keiner von beiden rechnet noch selbst.
    expect(zaehler).not.toContain('(n / 1000).toFixed(1)')
    expect(lade).not.toContain('n % 1024 === 0')
  })

  it('die Statuszeile der Engine schreibt roh wie das Feld darunter', () => {
    const src = lies('components/settings/BuiltinEngineSettings.tsx')
    expect(src).toContain('ctx {String(status.ctx)}')
    // Und nicht mehr mit Tausendertrennung, die das Feld darunter nicht hat.
    expect(src).not.toContain('ctx {formatCount(status.ctx)}')
    // Feld und Hilfetext, damit der Test merkt, wenn sich die Nachbarn aendern.
    expect(src).toContain('placeholder="8192"')
    expect(src).toContain('0 = default (8192)')
  })

  it('und die Vorgabe im Auto-Eintrag ist nicht mehr fest verdrahtet', () => {
    const lade = lies('components/chat/ContextDropdown.tsx')
    expect(lade).toContain('fmt(ENGINE_DEFAULT_CTX)')
    expect(lade).not.toContain("' · 8K'")
    // Und die Konstante sagt dasselbe wie der Platzhalter im Feld.
    expect(formatContextWindow(ENGINE_DEFAULT_CTX)).toBe('8K')
    expect(String(ENGINE_DEFAULT_CTX)).toBe('8192')
  })
})
