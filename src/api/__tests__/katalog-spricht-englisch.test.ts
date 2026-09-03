import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Der Katalog ist Oberflaeche, nicht Notiz.
 *
 * Ein Persona-Lauf am 03.09.2026 fand mitten in einem durchgehend englischen
 * Katalog zwei deutsche Beschreibungen und schrieb dazu: „Wirkt unfertig."
 * Genau so ist es auch entstanden — die Eintraege kamen aus einer Recherche,
 * deren Notizen deutsch waren, und niemand hat den Sprachwechsel bemerkt.
 *
 * Warum hier statisch und nicht im Browser: `ui-language.spec.ts` laeuft ueber
 * die Ansichten und sieht nur, was gerade gerendert ist — ein Katalog mit
 * ueber hundert Eintraegen ist das nie ganz. Diese Pruefung liest die Quelle
 * und deckt jeden Eintrag ab, auch den, den niemand aufklappt.
 *
 * Kommentare bleiben ausdruecklich frei: der Quelltext dieses Hauses ist
 * deutsch begruendet, und ein Waechter, der die Begruendungen verbietet,
 * wuerde abgeschaltet. Geprueft wird, was der Kunde liest.
 */

const hier = dirname(fileURLToPath(import.meta.url))
const quelle = readFileSync(resolve(hier, '..', 'discover.ts'), 'utf8')

/** Woerter, die in einem englischen Satz nicht vorkommen. */
const DEUTSCH =
  /\b(dieselbe|derselbe|ganze|ganzen|kommt|kommen|aus dem|aus der|fuer|für|Groesse|Groessen|Qualitaet|Qualitaets|kleinstes|kleinste|mehrteilig|Mehrteilig|ohne|schon|wenn|nicht|sind|wie|bei|von|zum|zur|und|oder|Sprung|Punkt|Basis wie)\b/

/** Jedes Feld dieses Moduls, das als Text auf dem Schirm landet. */
function sichtbareTexte(): Array<{ feld: string; zeile: number; text: string }> {
  const out: Array<{ feld: string; zeile: number; text: string }> = []
  for (const feld of ['description', 'name', 'group']) {
    const re = new RegExp(`${feld}: '((?:[^'\\\\]|\\\\.)*)'`, 'g')
    for (const m of quelle.matchAll(re)) {
      out.push({ feld, zeile: quelle.slice(0, m.index).split('\n').length, text: m[1] })
    }
  }
  return out
}

describe('der Modellkatalog spricht Englisch', () => {
  it('findet ueberhaupt Texte — sonst prueft die Zusicherung nichts', () => {
    // Ein Waechter, dessen Regex ins Leere greift, ist immer gruen.
    expect(sichtbareTexte().length).toBeGreaterThan(100)
  })

  it('kein Umlaut und kein deutsches Wort in einem sichtbaren Feld', () => {
    const treffer = sichtbareTexte()
      .filter((t) => /[äöüÄÖÜß]/.test(t.text) || DEUTSCH.test(t.text))
      .map((t) => `discover.ts:${t.zeile} (${t.feld}): ${t.text.slice(0, 100)}`)
    expect(treffer).toEqual([])
  })
})
