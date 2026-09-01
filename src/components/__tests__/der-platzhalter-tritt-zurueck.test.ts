/**
 * Der Platzhalter ist leiser als der Wert.
 *
 * Befund D-A4: die zwei ungeschichteten Regeln in index.css setzten den
 * Platzhalter auf gray-800 (hell) bzw. gray-200 (dunkel) — also praktisch auf
 * die Textfarbe selbst. Die Grundrelation eines Eingabefeldes stand damit
 * verkehrt herum: ein leeres Feld las sich so stark wie ein ausgefuelltes, im
 * Hellmodus sogar mit dem IDENTISCHEN Kontrastwert.
 *
 * Warum die Regeln so weit reichen: sie stehen ausserhalb jeder `@layer` und
 * schlagen damit jede Tailwind-Utility, in beiden Schreibweisen. Am 01.09.2026
 * im laufenden Fenster gegengeprueft (Chromium 149, vier Sondenfelder):
 *
 *   dunkel  <input>                         -> gray-200
 *           class="placeholder:text-gray-600" -> gray-200   (v4-Utility verliert)
 *           class="placeholder-gray-600"      -> gray-200
 *   hell    <input>                         -> gray-800
 *           class="placeholder:text-gray-600" -> gray-800   (v4-Utility verliert)
 *           class="placeholder-gray-600"      -> gray-600   (Rescue-Regel greift)
 *
 * Es gibt also genau EINEN Platzhalterwert je Modus, und er steht in diesen
 * beiden Zeilen. Dieser Test rechnet ihn nach — aus den Werten in index.css,
 * nicht aus abgeschriebenen Zahlen, mit derselben WCAG-2.1-Implementierung,
 * die `primary-recipe.test.ts` und `hellmodus-restluecken.test.ts` benutzen.
 *
 * Die geprueften Gruende sind die gemessenen Feldgruende der App, nicht
 * gewaehlte Beispiele — Herkunft steht jeweils an der Konstante.
 *
 * Was hier NICHT geprueft werden kann: ob der Platzhalter in JEDEM Feld leiser
 * ist als sein Text. Der Text ist pro Feld anders geschrieben (`text-gray-100`
 * bis `text-gray-500`), und wo er selbst gedimmt ist, kann eine globale
 * Platzhalterfarbe die Relation nicht garantieren. Der Test nagelt die zwei
 * Zeilen fest, die es global entscheiden; die Restfaelle stehen im Bericht.
 *
 * Run: npx vitest run src/components/__tests__/der-platzhalter-tritt-zurueck.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over, rgbToHex } from './wcag-contrast'

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf-8')

/** Den Platzhalterwert eines Modus aus index.css lesen. */
function platzhalter(mode: 'light' | 'dark'): string {
  const m = css.match(new RegExp(`\\.${mode} ::placeholder \\{ color: (rgb\\([^)]*\\)); \\}`))
  if (!m) throw new Error(`Regel .${mode} ::placeholder fehlt in index.css`)
  return rgbToHex(m[1])
}

/** Was der Rescue-Layer im Hellmodus aus einer grauen Textklasse macht. */
function rescued(utility: string): string {
  const m = css.match(new RegExp(`\\.light \\.${utility} \\{ color: (rgb\\([^)]*\\)); \\}`))
  if (!m) throw new Error(`Rescue-Regel .light .${utility} fehlt in index.css`)
  return rgbToHex(m[1])
}

const WEISS = '#ffffff'
const GRAU_100 = '#f3f4f6' // Tailwind gray-100 — die Textfarbe des Promptfeldes

/**
 * Die Feldgruende, gegen die gerechnet wird. Alle vier am 01.09.2026 aus
 * getComputedStyle im laufenden Fenster abgelesen, nicht aus Klassennamen:
 *
 *   dunkel/hellster  #1e1e1e (Galerie- und Buehnenblase) + bg-white/5
 *   dunkel/typisch   #141414 (Create-Flaeche) + bg-white/[0.03]  = das Promptfeld
 *   hell/hellster    #ffffff
 *   hell/dunkelster  #ffffff + bg-black/4
 */
const DUNKEL_HELLSTER = over(WEISS, '#1e1e1e', 0.05)
const DUNKEL_PROMPT = over(WEISS, '#141414', 0.03)
const HELL_DUNKELSTER = over('#000000', WEISS, 0.04)

describe('die Feldgruende sind die gemessenen', () => {
  it('die abgedeckten Farben stimmen mit den Messwerten ueberein', () => {
    // Die drei Werte stehen so in den Kommentaren von index.css und
    // Composer.tsx. Waere `over` falsch, wuerden die Rechnungen unten
    // stillschweigend andere Zahlen liefern als die dort behaupteten.
    expect(DUNKEL_HELLSTER).toBe('#292929')
    expect(DUNKEL_PROMPT).toBe('#1b1b1b')
    expect(HELL_DUNKELSTER).toBe('#f5f5f5')
  })
})

describe('der Platzhalter bleibt lesbar', () => {
  it('faellt in keinem Modus unter 4,5:1', () => {
    // Die Untergrenze. Wer den Platzhalter nur weit genug zurueckdreht, hat
    // den Befund umgedreht statt behoben — dieser Fall verhindert das.
    expect(contrast(platzhalter('dark'), DUNKEL_HELLSTER)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(platzhalter('dark'), DUNKEL_PROMPT)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(platzhalter('light'), WEISS)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(platzhalter('light'), HELL_DUNKELSTER)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('der Platzhalter tritt hinter den Wert zurueck', () => {
  it('dunkel: deutlich leiser als der Text des Promptfeldes', () => {
    const text = contrast(GRAU_100, DUNKEL_PROMPT)
    const ph = contrast(platzhalter('dark'), DUNKEL_PROMPT)
    expect(ph).toBeLessThan(text)
    // „Deutlich": hoechstens zwei Drittel. Vorher waren es 89 % (13,91 von
    // 15,65) — ein Abstand, den niemand als Rangordnung liest.
    expect(ph / text).toBeLessThanOrEqual(2 / 3)
  })

  it('hell: deutlich leiser als der Text des Promptfeldes', () => {
    // Im Hellmodus ist die Textfarbe nicht gray-100, sondern das, was der
    // Rescue-Layer daraus macht — deshalb hier aus der Datei gelesen und
    // nicht angenommen.
    const text = contrast(rescued('text-gray-100'), WEISS)
    const ph = contrast(platzhalter('light'), WEISS)
    expect(ph).toBeLessThan(text)
    expect(ph / text).toBeLessThanOrEqual(2 / 3)
  })

  it('hell: Platzhalter und Wert sind nicht mehr dieselbe Farbe', () => {
    // Der schaerfste Teil des Befundes: bis 2.6.7 waren es beide gray-800,
    // also exakt derselbe Kontrastwert. Dieser Fall faellt schon auf die
    // Gleichheit, unabhaengig von jedem Schwellenwert.
    expect(platzhalter('light')).not.toBe(rescued('text-gray-100'))
  })
})

describe('die beiden Werte sind keine neu erfundenen Zahlen', () => {
  it('dunkel: derselbe Wert, auf den der Rescue-Layer dimme Textklassen hebt', () => {
    const m = css.match(/\.dark \.text-gray-500 \{ color: (rgb\([^)]*\)); \}/)
    expect(m, '.dark .text-gray-500 fehlt in index.css').toBeTruthy()
    expect(platzhalter('dark')).toBe(rgbToHex(m![1]))
  })

  it('hell: derselbe Wert, den die placeholder-Rescue-Regel ohnehin setzt', () => {
    const m = css.match(/\.light \.placeholder-gray-600::placeholder \{ color: (rgb\([^)]*\)); \}/)
    expect(m, '.light .placeholder-gray-600::placeholder fehlt in index.css').toBeTruthy()
    expect(platzhalter('light')).toBe(rgbToHex(m![1]))
  })
})
