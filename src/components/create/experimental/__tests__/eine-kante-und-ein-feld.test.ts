/**
 * Zwei Befunde der Prompt-Spalte, die dieselbe Ursache haben: eine Form, die
 * ihren Inhalt verleugnet.
 *
 * D-S32 — die Reglerzeile ueber dem Prompt.
 *   ZURUECKGEDREHT am 05.09.2026 auf Davids Ansage am Windows-Bau: „die
 *   einstellungen ueber der promptbox sollen immer mittig ueber der promptbox
 *   zentriert stehen." Der Audit hatte die Zeile auf die linke Kante des
 *   Prompttextes gesetzt (`justify-start` plus 15px Polster), weil eine
 *   mittige Zeile ueber linksbuendigem Text als zweite Kante las. David sieht
 *   es umgekehrt, und ihm gehoert die Entscheidung; dieser Test bewacht
 *   seither die Mitte statt der Kante.
 *   Gemessen vor der Rueckdrehung (1296x808, --ui-scale 1.15, gerenderte
 *   Pixel): Promptbox-Mitte x=648, Inhalt der Reglerzeile auf x=505,7 (Image)
 *   und x=497,4 (Edit).
 *   Der zweite Teil des alten Befundes, `transform: scale(0.7)` auf derselben
 *   Zeile, ist mit c7076fca weg. Den bewacht `ein-massstab.test.ts`, hier
 *   geht es nur um die Ausrichtung.
 *
 * D-S33 — das Negativfeld.
 *   Es war eine randlose Zeile unter einer Haarlinie, in derselben Groesse und
 *   auf derselben Kante wie der Prompt darueber; nichts an ihm sagte „hier
 *   faengt eine zweite Eingabe an". Dazu stand der eingetippte Wert in
 *   `text-gray-400` (6,78:1 auf #1b1b1b), waehrend die globale
 *   Platzhalterregel gray-200 malte (13,91:1) — das Feld war LEER
 *   auffaelliger als gefuellt. Und sein Schalter hiess „Neg", eine Abkuerzung,
 *   deren Aufloesung nur im Hover-`title` stand, ohne jedes Zustandsattribut.
 *
 * Was hier NICHT geprueft werden kann: die Pixelkanten. vitest laeuft unter
 * `environment: 'node'`. Die Messwerte stehen an den Aenderungen selbst; hier
 * steht die Quelle, aus der sie folgen — dass die 15 px genau das Mass des
 * Panelrandes plus seines Innenabstandes sind, ist der Grund, warum die beiden
 * Kanten nicht auseinanderlaufen koennen, und genau das rechnen die Faelle
 * unten aus der Datei nach.
 *
 * Run: npx vitest run src/components/create/experimental/__tests__/eine-kante-und-ein-feld.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '../Composer.tsx'), 'utf8')
/** Kommentare raus — sie ZITIEREN `justify-center` und `text-gray-400` als
 *  das, was dort stand. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

describe('D-S32: die Reglerzeile steht mittig ueber der Promptbox', () => {
  it('keine Reglerzeile steht mehr auf einer eigenen linken Kante', () => {
    // Die Negativkontrolle des Zustands bis 05.09.2026: `justify-start` plus
    // ein linkes Polster stand auf allen drei Rueckgaben von LaneControls
    // (Bild, Audio, Video). Eine davon stehen zu lassen waere der halbe Fix.
    expect(code).not.toMatch(/justify-start/)
    expect(code).not.toMatch(/pl-\[15px\]/)
  })

  it('alle Reglerzeilen teilen sich EINE Rezeptkonstante, und die ist zentriert', () => {
    const rezept = code.match(/const LANE_ROW = '([^']+)'/)
    expect(rezept, 'LANE_ROW fehlt in Composer.tsx').toBeTruthy()
    expect(rezept![1]).toContain('justify-center')
    // Drei Verwendungen: `{LANE_ROW}` einmal und `cn(LANE_ROW, …)` zweimal.
    const nutzungen = code.match(/LANE_ROW/g) ?? []
    expect(nutzungen.length).toBe(4) // Definition + drei Zeilen
  })

  it('die Zeile ist ein Geschwister des Promptpanels, teilt also dessen Mitte', () => {
    // Warum `justify-center` reicht und keine Zahl noetig ist: Reglerzeile und
    // Promptpanel liegen in DERSELBEN Spalte (`mx-auto w-full max-w-[…]`),
    // sind damit gleich breit und haben dieselbe Mitte. Faende das hier nicht
    // mehr statt, waere die Zentrierung eine Zusage ohne Deckung.
    const spalte = code.match(/className="mx-auto w-full max-w-\[(\d+)px\] space-y-[\d.]+"/)
    expect(spalte, 'die gemeinsame Spalte von Reglerzeile und Promptpanel fehlt').toBeTruthy()
    const panel = code.match(/className="rounded-\[var\(--radius-panel\)\][^"]*"/)
    expect(panel, 'Promptpanel nicht gefunden').toBeTruthy()
    expect(panel![0]).toMatch(/\bborder\b/)
  })
})

describe('D-S33: das Negativfeld sieht aus wie ein Feld', () => {
  /** Der Block, in dem das Negativfeld steht — an seinem Platzhalter erkannt. */
  const negBlock = () => {
    const i = code.indexOf('What to avoid')
    expect(i, 'Negativfeld nicht gefunden').toBeGreaterThan(-1)
    return code.slice(Math.max(0, i - 900), i + 200)
  }

  it('hat eigene Flaeche und eigenen Rand', () => {
    const b = negBlock()
    expect(b).toMatch(/bg-white\/\[0\.03\]/)
    expect(b).toMatch(/border border-white\//)
  })

  it('haengt nicht mehr nur an einer Trennlinie', () => {
    expect(negBlock()).not.toMatch(/border-t border-white\/\[0\.06\]/)
  })

  it('sagt hin, was es ist — nicht nur im Platzhalter', () => {
    expect(negBlock()).toMatch(/Negative prompt/)
  })

  it('der eingetippte Wert wird nicht mehr gedimmt', () => {
    // `className="text-gray-400"` auf dem PromptField war der Grund, warum
    // der Platzhalter kontrastreicher war als der Wert.
    expect(negBlock()).not.toMatch(/className="text-gray-400"/)
  })
})

describe('D-S33: der Schalter sagt, dass er einer ist', () => {
  const schalter = () => {
    const i = code.indexOf('onClick={toggleNegative}')
    expect(i, 'Negativ-Schalter nicht gefunden').toBeGreaterThan(-1)
    return code.slice(i, i + 600)
  }

  it('meldet seinen Zustand', () => {
    expect(schalter()).toMatch(/aria-pressed=\{showNegative\}/)
    expect(schalter()).toMatch(/aria-expanded=\{showNegative\}/)
  })

  it('zeigt auf das Feld, das er aufklappt', () => {
    const id = schalter().match(/aria-controls="([^"]+)"/)
    expect(id, 'aria-controls fehlt').toBeTruthy()
    // Das Ziel muss es auch geben, sonst zeigt das Attribut ins Leere.
    expect(code).toMatch(new RegExp(`id="${id![1]}"`))
  })

  it('heisst nicht mehr „Neg"', () => {
    expect(schalter()).not.toMatch(/>\s*Neg\s*</)
  })
})
