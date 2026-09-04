/**
 * Gelb ist aus der Oberflaeche verschwunden und darf nicht zurueckkommen.
 *
 * David, 04.09.2026: „ich will nirgends gelbe anmerkungen oder fehlermeldungen
 * sehen, das sieht ja todes scheisse aus" und „kein gelb mehr ohne farbe. und
 * sauber, nicht so klotzig ueberall die fehlermeldungen und anmerkungen."
 *
 * Gezaehlt vorher: 319 Vorkommen in 52 Dateien. Die Begruendung, warum es zwei
 * Toene gibt und keinen dritten, steht in `lib/hinweis.ts`.
 *
 * Warum das ein Test sein muss und keine Absprache: eine Regel, die 52 Dateien
 * betrifft, ueberlebt keine drei Wochen, wenn niemand sie nachhaelt. Der
 * naechste, der eine Warnung baut, greift zu Gelb, weil Gelb ueberall die
 * Farbe fuer Warnungen ist. Genau so sind die 319 entstanden.
 *
 * Kommentare zaehlen ausdruecklich MIT, aber nur, wenn dort ein Klassenname
 * steht. Tailwind liest den Quelltext als Text, auch die Kommentare, und macht
 * aus einem Kuerzel in einer Erklaerung eine echte Regel im ausgelieferten
 * Bundle. Das faengt zwar auch `keine-klasse-aus-prosa` ab, aber dieser Test
 * sagt den Grund dazu.
 *
 * Run: npx vitest run src/lib/__tests__/kein-gelb-in-der-oberflaeche.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const SRC = resolve(__dirname, '../..')

/** Jede Quelldatei der Anwendung. Tests zaehlen nicht mit: dort STEHT das
 *  Wort, weil dort seine Abwesenheit geprueft wird. */
function quellen(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      quellen(p, out)
    } else if (/\.tsx?$/.test(name) || /\.css$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

const DATEIEN = quellen(SRC)

/** Der Text ohne Kommentare. */
const ohneKommentare = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

describe('kein Gelb in der Oberflaeche', () => {
  it('findet ueberhaupt die Quellen, sonst prueft der Rest nichts', () => {
    // Negativkontrolle gegen einen leeren Lauf: waere der Sammler kaputt,
    // waeren alle Faelle unten gruen und wuerden nichts bedeuten.
    expect(DATEIEN.length).toBeGreaterThan(300)
    expect(DATEIEN.some((d) => d.endsWith('hinweis.ts'))).toBe(true)
  })

  it('keine amber- oder yellow-Klasse im Code', () => {
    const treffer: string[] = []
    for (const d of DATEIEN) {
      const code = ohneKommentare(readFileSync(d, 'utf8'))
      for (const m of code.matchAll(/\b(?:amber|yellow)-[a-z0-9/[\].]+/g)) {
        treffer.push(`${relative(SRC, d)}: ${m[0]}`)
      }
    }
    expect(treffer, treffer.join('\n')).toEqual([])
  })

  it('und auch keine im Kommentar, weil Tailwind Kommentare mitliest', () => {
    // `lib/hinweis.ts` traegt die Begruendung der ganzen Regel und nennt die
    // beiden Woerter dabei ohne Bindestrich, ist also keine Ausnahme, sondern
    // faellt gar nicht erst auf.
    const treffer: string[] = []
    for (const d of DATEIEN) {
      const s = readFileSync(d, 'utf8')
      for (const m of s.matchAll(/\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(?:amber|yellow)-[a-z0-9/[\].]+/g)) {
        treffer.push(`${relative(SRC, d)}: ${m[0]}`)
      }
    }
    expect(treffer, treffer.join('\n')).toEqual([])
  })

  it('und kein Gelb als roher Farbwert', () => {
    // Der naheliegende Ausweg um die zwei Regeln oben herum. Die Werte sind
    // die Gelbtoene der Tailwind-Palette in beiden Familien, plus die zwei
    // vollen Gelbs, die ein Mensch von Hand tippt.
    const roh = [
      '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#fffbeb', '#fef3c7',
      '#facc15', '#eab308', '#ca8a04', '#a16207', '#fefce8', '#fef9c3',
      '#ffff00', '#ffd700',
    ]
    const treffer: string[] = []
    for (const d of DATEIEN) {
      const s = readFileSync(d, 'utf8').toLowerCase()
      for (const wert of roh) if (s.includes(wert)) treffer.push(`${relative(SRC, d)}: ${wert}`)
    }
    expect(treffer, treffer.join('\n')).toEqual([])
  })

  it('die Regel liegt an einer Stelle und wird auch benutzt', () => {
    // Ohne diesen Fall koennte jemand die Farben wieder ueberall einzeln
    // hinschreiben, nur eben in Grau, und die naechste Runde faengt von vorn
    // an.
    const regel = readFileSync(resolve(SRC, 'lib/hinweis.ts'), 'utf8')
    expect(regel).toContain('HINWEIS_TEXT')
    expect(regel).toContain('PUNKT_FARBE')
    const nutzer = DATEIEN.filter((d) => {
      if (d.endsWith('hinweis.ts')) return false
      const s = readFileSync(d, 'utf8')
      return s.includes('lib/hinweis') || s.includes('ui/Hinweis') || s.includes("from '../hinweis'")
    })
    expect(nutzer.length, 'niemand liest die Regel').toBeGreaterThan(3)
  })
})
