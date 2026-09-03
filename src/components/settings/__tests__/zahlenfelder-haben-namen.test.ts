/**
 * Jedes Zahlenfeld in den Einstellungen hat einen Namen im Bedienungsbaum.
 *
 * Persona-Lauf vom 03.09.2026, Befund 13: „Die Zahlenfelder für die
 * Unteragenten-Grenzen haben keine zugängliche Beschriftung — sie tauchen im
 * Bedienungsbaum gar nicht auf." Sie stimmte fuer ALLE neun Zahlenfelder der
 * Seite, nicht nur fuer die zwei, die ihr aufgefallen sind.
 *
 * Sichtbar steht daneben ein `<span>`. Das reicht dem Auge und niemandem
 * sonst: ohne `<label for>` oder `aria-label` hat das Feld keinen Namen —
 * fuer einen Screenreader, fuer eine Tastaturbedienung, und auch fuer jeden
 * automatischen Rundgang, der die Seite ueber den Bedienungsbaum liest (das
 * ist genau, wie `e2e/ui-language.spec.ts` sie liest).
 *
 * Geprueft wird am Quelltext, weil vitest hier ohne DOM laeuft. Der Test
 * zerlegt die `<input …/>`-Bloecke und verlangt fuer jeden mit
 * `type="number"` einen Namen.
 *
 * Lauf: npx vitest run src/components/settings/__tests__/zahlenfelder-haben-namen.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const JSX = readFileSync(resolve(__dirname, '..', 'SettingsPage.tsx'), 'utf8')

/** Jeder `<input …/>`-Block als eigener Text. */
function inputBloecke(quelle: string): string[] {
  const bloecke: string[] = []
  let i = quelle.indexOf('<input')
  while (i !== -1) {
    const ende = quelle.indexOf('/>', i)
    if (ende === -1) break
    bloecke.push(quelle.slice(i, ende + 2))
    i = quelle.indexOf('<input', ende)
  }
  return bloecke
}

describe('Zahlenfelder in den Einstellungen', () => {
  const zahlenfelder = inputBloecke(JSX).filter((b) => b.includes('type="number"'))

  it('es gibt ueberhaupt welche — sonst prueft die Zeile darunter nichts', () => {
    expect(zahlenfelder.length).toBeGreaterThanOrEqual(9)
  })

  it('jedes traegt einen zugaenglichen Namen', () => {
    const ohne = zahlenfelder.filter(
      (b) => !/aria-label=/.test(b) && !/aria-labelledby=/.test(b) && !/\bid=/.test(b),
    )
    // Die Fundstelle mitgeben: eine nackte Zahl waere hier nutzlos.
    expect(ohne.map((b) => b.replace(/\s+/g, ' ').slice(0, 120))).toEqual([])
  })

  it('die beiden aus dem Bericht heissen wie das, was daneben steht', () => {
    const treffer = zahlenfelder.filter((b) => /subAgentMax/.test(b))
    expect(treffer).toHaveLength(2)
    expect(treffer.some((b) => /aria-label="Sub-agent tool calls"/.test(b))).toBe(true)
    expect(treffer.some((b) => /aria-label="Sub-agent steps"/.test(b))).toBe(true)
  })
})
