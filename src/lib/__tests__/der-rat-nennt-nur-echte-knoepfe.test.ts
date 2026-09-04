/**
 * Ein Rat in einer Fehlermeldung darf nur Knoepfe nennen, die es gibt.
 *
 * Gegenprobe G1, 04.09.2026: nach dem Klick auf eine kaputte GGUF-Datei stand
 * in der Meldung "Open Models, Discover and install a different quant." Der
 * Testkunde hat alle fuenf Hauptseiten nach dem Wort "Discover" durchsucht und
 * null Treffer gehabt. Die Reiter auf der Models-Seite heissen "Get new" und
 * "Installed". Der Rat schickte den Kunden ausserdem zu einem ANDEREN Quant,
 * obwohl die Datei nur unvollstaendig heruntergeladen war und dieselbe Datei
 * noch einmal zu laden der richtige Weg ist.
 *
 * Der Test liest die Reiterbeschriftungen aus der Models-Seite und haelt jeden
 * "Open Models, X"-Rat in der Anwendung dagegen.
 *
 * Run: npx vitest run src/lib/__tests__/der-rat-nennt-nur-echte-knoepfe.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const src = resolve(__dirname, '..', '..')
const rust = resolve(__dirname, '..', '..', '..', 'src-tauri', 'src')

/** Die Beschriftungen der Reiterleiste, so wie ein Mensch sie liest. */
function reiterBeschriftungen(): string[] {
  const datei = readFileSync(join(src, 'components', 'models', 'ModelManager.tsx'), 'utf8')
  const anfang = datei.indexOf('{/* Get new / Installed segment')
  const ende = datei.indexOf('<div className="flex-1" />', anfang)
  expect(anfang).toBeGreaterThan(0)
  expect(ende).toBeGreaterThan(anfang)
  const leiste = datei.slice(anfang, ende)
  const namen = [...leiste.matchAll(/\/>\s*([A-Za-z][A-Za-z ]*?)\s*$/gm)].map((m) => m[1].trim())
  expect(namen.length).toBeGreaterThan(1)
  return namen
}

function dateien(dir: string, endung: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules' || e === 'target') continue
      out.push(...dateien(p, endung))
    } else if (endung.test(e)) out.push(p)
  }
  return out
}

describe('der Rat in Fehlermeldungen', () => {
  const reiter = reiterBeschriftungen()

  it('die Models-Seite hat wirklich einen Reiter "Get new"', () => {
    expect(reiter).toContain('Get new')
    expect(reiter).toContain('Installed')
  })

  it('jeder "Open Models, X"-Rat nennt einen Reiter, den es gibt', () => {
    const suender: string[] = []
    for (const f of [...dateien(src, /\.tsx?$/), ...dateien(rust, /\.rs$/)]) {
      const text = readFileSync(f, 'utf8')
      for (const [i, zeile] of text.split('\n').entries()) {
        for (const treffer of zeile.matchAll(/Open Models,\s+([A-Z][A-Za-z ]*?)\s+and\b/g)) {
          if (!reiter.includes(treffer[1])) {
            suender.push(`${f}:${i + 1} nennt "${treffer[1]}"`)
          }
        }
      }
    }
    expect(suender).toEqual([])
  })

  // Negativkontrolle: genau dieser Satz stand in der Anwendung, und genau
  // dieser Satz muss den Test rot machen.
  it('der alte Satz waere aufgefallen', () => {
    const alt = 'Open Models, Discover and install a different quant.'
    const treffer = [...alt.matchAll(/Open Models,\s+([A-Z][A-Za-z ]*?)\s+and\b/g)]
    expect(treffer).toHaveLength(1)
    expect(reiter).not.toContain(treffer[0][1])
  })

  it('kein Rat schickt den Kunden zu einem anderen Quant', () => {
    const suender: string[] = []
    for (const f of [...dateien(src, /\.tsx?$/), ...dateien(rust, /\.rs$/)]) {
      const text = readFileSync(f, 'utf8')
      for (const [i, zeile] of text.split('\n').entries()) {
        if (/install a different quant/.test(zeile)) suender.push(`${f}:${i + 1}`)
      }
    }
    expect(suender).toEqual([])
  })
})
