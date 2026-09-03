import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Wer eine Flaeche ueber die App legt, muss sie mit Escape wieder wegnehmen.
 *
 * Sieben Aufklapplisten und Dialoge hatten das nicht, und der Preis war nicht
 * Barrierefreiheit im Abstrakten: die Modellauswahl liegt ueber dem
 * Eingabefeld, blieb nach Escape voll deckend stehen und schluckte danach
 * jeden Tastendruck. Zwei Testleser haben daraus unabhaengig „Enter sendet
 * nicht" und „mein Tippversuch ging verloren" gemacht — beide hatten recht,
 * beide haben die Ursache nicht gesehen.
 *
 * Diese Pruefung ist die billige Haelfte der Sperrklinke: sie deckt JEDE
 * Datei ab, auch die, die kein Browsertest anfaehrt. Die teure Haelfte —
 * dass Escape wirklich wirkt — steht in `e2e/escape-closes-overlays.spec.ts`.
 */

const hier = dirname(fileURLToPath(import.meta.url))
const wurzel = resolve(hier, '..', '..', 'components')

/** Flaechen, die bewusst nichts wegzunehmen haben. */
const AUSNAHMEN = new Set([
  // Hintergrundgrafik hinter der ganzen App. Nichts zum Schliessen, nichts
  // abzufangen — und ein Escape-Haken darauf waere ein Haken ins Leere.
  'three/ParticleBackground.tsx',
])

function alleTsx(dir: string, praefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e === '__tests__') continue
      out.push(...alleTsx(p, `${praefix}${e}/`))
    } else if (e.endsWith('.tsx')) out.push(`${praefix}${e}`)
  }
  return out
}

describe('jede aufgelegte Flaeche laesst sich mit Escape schliessen', () => {
  const kandidaten = alleTsx(wurzel).filter((rel) =>
    readFileSync(join(wurzel, rel), 'utf8').includes('fixed inset-0'),
  )

  it('findet ueberhaupt Kandidaten', () => {
    // Ohne diese Zeile waere die Zusicherung unten gruen, sobald sich die
    // Klassennamen aendern — und niemand wuesste es.
    expect(kandidaten.length).toBeGreaterThan(8)
  })

  it('behandelt Escape oder steht begruendet auf der Ausnahmeliste', () => {
    const offen = kandidaten.filter((rel) => {
      if (AUSNAHMEN.has(rel)) return false
      const q = readFileSync(join(wurzel, rel), 'utf8')
      return !/useDismissOnEscape|['"]Escape['"]/.test(q)
    })
    expect(offen).toEqual([])
  })
})
