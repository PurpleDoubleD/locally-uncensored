/**
 * Der Statusanker — D-S11.
 *
 * Befund: „`WorkingAnchor.tsx:38` ist ein einzelnes Wort in 12,88px mit
 * Shimmer — im Standbild nicht von Fliesstext unterscheidbar."
 *
 * Das Wort „im Standbild" ist der ganze Befund. Der Shimmer trug die Aussage,
 * solange er lief und solange jemand hinsah. Er laeuft aber nicht immer:
 *
 *   - in einem Screenshot (jeder Bugreport, jede Doku) steht er still,
 *   - unter `prefers-reduced-motion` haelt ihn die Regel in index.css nach
 *     einem Durchlauf an (`animation-iteration-count: 1`),
 *   - und wer nicht gerade hinschaut, sieht ihn ohnehin nicht.
 *
 * In all diesen Faellen blieb ein graues Wort in Textgroesse ueber dem
 * Transkript stehen, direkt dort, wo sonst eine Antwort anfaengt.
 *
 * Dieser Test prueft deshalb genau die Merkmale, die OHNE Bewegung wirken:
 * Behaelter, Marker, Groessenstufe — und die Ansage fuer Screenreader, fuer
 * die das Wort vorher gar nichts war.
 *
 * Run: npx vitest run src/components/chat/__tests__/der-statusanker-ist-kein-fliesstext.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '..', 'WorkingAnchor.tsx'), 'utf-8')
const CSS = readFileSync(resolve(__dirname, '..', '..', '..', 'index.css'), 'utf-8')
const CODE = SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')

describe('im Standbild ist es ein Status, kein Absatz', () => {
  it('es steht in einem Behaelter mit Kante und Radius', () => {
    expect(CODE).toMatch(/rounded-full border border-gray-200 dark:border-white\/10/)
  })

  it('der Behaelter ist so breit wie sein Inhalt, nicht wie die Zeile', () => {
    // Ohne `w-fit` liefe ein `flex`-Kind auf die volle Spaltenbreite und
    // saehe wieder aus wie eine Textzeile mit einem Rahmen drumherum.
    expect(CODE).toMatch(/inline-flex w-fit items-center/)
  })

  it('und traegt einen Marker, der auch im Stillstand ein Marker ist', () => {
    expect(CODE).toMatch(/lu-band-dot w-1\.5 h-1\.5 rounded-full/)
  })

  it('der Marker benutzt die vorhandene Klasse, nicht eine zweite eigene', () => {
    // `.lu-band-dot` gibt es schon fuer die Werkzeugleiste. Ein zweites
    // Pulsieren mit einer eigenen Dauer waere die 19. Motion-Zahl der App.
    expect(CSS.match(/^\.lu-band-dot\s*\{/gm) ?? []).toHaveLength(1)
  })

  it('die Schriftgroesse kommt von der Typo-Leiter, nicht aus einer eigenen Zahl', () => {
    // Vorher `text-[0.7rem]` — bei 18,4px Wurzelmass 12,88px, genau die Zahl
    // aus dem Befund, und keine Stufe irgendeiner Leiter.
    expect(CODE).toMatch(/lu-tool-shimmer t-control/)
    expect(CODE).not.toMatch(/text-\[0\.7rem\]/)
  })

  it('der Sekundenzaehler traegt das Zahlen-Rezept des Hauses', () => {
    // Er zaehlt viermal pro Sekunde hoch; mit Proportionalziffern ruckt die
    // Zeile bei jedem Wechsel von „1" auf „8". Vorher stand
    // `font-mono tabular-nums` von Hand daneben — dasselbe Rezept, zweite
    // Schreibweise.
    expect(CODE).toMatch(/lu-hud-num/)
    expect(CODE).not.toMatch(/font-mono tabular-nums/)
  })
})

describe('und es sagt jetzt auch etwas, wenn niemand hinsieht', () => {
  it('der Anker ist eine Statusregion', () => {
    expect(CODE).toMatch(/role="status"/)
    expect(CODE).toMatch(/aria-live="polite"/)
  })

  it('der Sekundenzaehler ist davon ausgenommen', () => {
    // Sonst spricht die Ansage im Viertelsekundentakt (das Intervall steht
    // oben in dieser Datei auf 250 ms).
    const clock = CODE.slice(CODE.indexOf('{elapsed >= 1 &&'), CODE.indexOf('formatElapsed(elapsed)'))
    expect(clock).toMatch(/aria-hidden="true"/)
    expect(SRC).toMatch(/setInterval\([\s\S]{0,120}?, 250\)/)
  })

  it('der Marker ebenfalls — er ist Dekoration, das Wort traegt die Aussage', () => {
    const dot = CODE.slice(CODE.indexOf('lu-band-dot') - 200, CODE.indexOf('lu-band-dot'))
    expect(dot).toMatch(/aria-hidden="true"/)
  })
})

describe('die Farbe des Markers ist gerechnet, nicht geraten', () => {
  /** WCAG 2.1 relative Luminanz. */
  const lum = (r: number, g: number, b: number) => {
    const f = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

  it('hell traegt die Akzentkante, weil der Akzent selbst zu schwach ist', () => {
    // Behaelter hell = bg-gray-50 (#f9fafb).
    const grund = lum(249, 250, 251)
    const akzent = lum(160, 148, 248)      // --color-lu-accent  #a094f8
    const kante = lum(139, 124, 240)       // --color-lu-accent-edge #8b7cf0
    expect(+ratio(akzent, grund).toFixed(2)).toBe(2.49)   // reicht nicht
    expect(+ratio(kante, grund).toFixed(2)).toBe(3.22)    // reicht (>= 3:1)
    expect(CODE).toContain('bg-lu-accent-edge dark:bg-lu-accent')
  })

  it('dunkel reicht der Akzent selbst mit Abstand', () => {
    // Behaelter dunkel = white/[0.03] ueber #1e1e1e = #252525.
    const grund = lum(37, 37, 37)
    const akzent = lum(160, 148, 248)
    expect(ratio(akzent, grund)).toBeGreaterThan(3)
    expect(+ratio(akzent, grund).toFixed(2)).toBe(5.9)
  })
})
