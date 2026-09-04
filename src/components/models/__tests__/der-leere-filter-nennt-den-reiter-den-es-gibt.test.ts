/**
 * Ein Knopf, der auf einen Reiter fuehrt, nennt ihn beim Namen, den er hat.
 *
 * Seit 02aa2244 heisst der linke Reiter der Models-Seite "Get new". Zwei der
 * drei Knoepfe, die dorthin fuehren, wurden umgestellt, der dritte nicht: wer
 * Models, dann Installed, dann eine Kategorie ohne installierte Modelle
 * oeffnete, bekam "Discover text models" angeboten und suchte danach oben
 * vergeblich. Genau dieser Fehler ist im Bild- und Videoweg schon einmal
 * aufgetreten (src/api/__tests__/der-wegweiser-nennt-echte-reiter.test.ts) und
 * in Fehlermeldungen (src/lib/__tests__/der-rat-nennt-nur-echte-knoepfe.test.ts).
 * Die beiden Waechter lesen Meldungstexte; dieser liest die Knoepfe der Seite
 * selbst.
 *
 * Run: npx vitest run src/components/models/__tests__/der-leere-filter-nennt-den-reiter-den-es-gibt.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SEITE = readFileSync(resolve(__dirname, '..', 'ModelManager.tsx'), 'utf8')

/** Die sichtbare Beschriftung hinter einem Icon, also das, was ein Mensch liest. */
function beschriftung(abschnitt: string): string {
  return (abschnitt.match(/\/>\s*([A-Za-z][A-Za-z ]*)/)?.[1] ?? '').trim()
}

/** Wie der Reiter `tab` in der Reiterleiste heisst. */
function reiterName(tab: string): string {
  const knopf = SEITE.indexOf(`aria-pressed={tab === '${tab}'}`)
  expect(knopf, `kein Reiterknopf fuer ${tab}`).toBeGreaterThan(0)
  const name = beschriftung(SEITE.slice(knopf, SEITE.indexOf('</button>', knopf)))
  expect(name.length).toBeGreaterThan(0)
  return name
}

/** Jeder Knopf, der auf den Reiter fuehrt, mit seiner Beschriftung. */
function knoepfeZumReiter(tab: string): string[] {
  const muster = new RegExp(`onClick=\\{\\(\\) => setTab\\('${tab}'\\)\\}([\\s\\S]*?)</button>`, 'g')
  return [...SEITE.matchAll(muster)].map((m) => beschriftung(m[1]))
}

describe('die Knoepfe der Models-Seite nennen ihre Reiter richtig', () => {
  const getNew = reiterName('discover')

  it('der Reiter heisst "Get new"', () => {
    expect(getNew).toBe('Get new')
    expect(reiterName('installed')).toBe('Installed')
  })

  it('alle drei Wege dorthin nennen ihn so', () => {
    const knoepfe = knoepfeZumReiter('discover')
    // Der Reiter selbst, der Leerzustand ohne jedes Modell, der Leerzustand
    // eines Kategoriefilters. Faellt einer weg, faellt diese Zahl auf, statt
    // dass ein leeres Ergebnis gruen durchgeht.
    expect(knoepfe).toHaveLength(3)
    for (const k of knoepfe) {
      expect(k, `"${k}" nennt keinen Reiter, den es gibt`).toContain(getNew)
    }
  })

  // NEGATIVKONTROLLE: genau der alte Text muss durchfallen, und "Discover"
  // steht auf keinem Knopf mehr, der irgendwohin fuehrt.
  it('der alte Text waere aufgefallen', () => {
    expect(beschriftung('<Sparkles size={11} /> Discover {modeMeta.label.toLowerCase()} models'))
      .not.toContain(getNew)
    for (const k of knoepfeZumReiter('discover')) {
      expect(k).not.toContain('Discover')
    }
  })
})
