/**
 * Ein Wegweiser in einer Meldung darf nur Reiter nennen, die es gibt.
 *
 * Der Fall: seit 02aa2244 heisst der linke Reiter auf der Models-Seite
 * "Get new". Drei Fehlermeldungen im Bild- und Videoweg schickten den Kunden
 * weiter nach "Models -> Discover". Wer im Agentenmodus ohne Bildmodell ein
 * Bild erzeugen liess, bekam also den Namen eines Reiters, den es auf der
 * Seite nicht mehr gibt (src/api/vram-handoff.ts:781, 802, 824).
 *
 * Der Test liest die Reiterbeschriftungen aus der Models-Seite selbst und
 * haelt jeden "Models -> X"-Wegweiser im Baum dagegen. Wird ein Reiter noch
 * einmal umbenannt, faellt der Test, nicht der Kunde.
 *
 * Die zweite Satzform, "the X tab", ist seit der Nachlese dabei. Sie stand in
 * src/lib/constants.ts:349, in der Beschreibung des Starter-Modells: "pick
 * bigger models from the Discover tab once you're in." Das ist einer der
 * ersten Saetze, die ein neuer Kunde ueberhaupt liest, und er nannte denselben
 * verschwundenen Reiter. Geprueft wird dabei nur gegen Namen, die die
 * Reiterleiste der Models-Seite frueher getragen hat: "the Create tab" und
 * "the Code tab" zeigen auf andere Seiten und gehen niemanden hier etwas an.
 *
 * Der Nachbarwaechter fuer die andere Satzform ("Open Models, X and ...")
 * steht in src/lib/__tests__/der-rat-nennt-nur-echte-knoepfe.test.ts.
 *
 * Run: npx vitest run src/api/__tests__/der-wegweiser-nennt-echte-reiter.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const src = resolve(__dirname, '..', '..')
const rust = resolve(__dirname, '..', '..', '..', 'src-tauri', 'src')

/** Die Beschriftungen der Reiterleiste, gelesen aus der Models-Seite. */
function reiterBeschriftungen(): string[] {
  const datei = readFileSync(join(src, 'components', 'models', 'ModelManager.tsx'), 'utf8')
  const namen: string[] = []
  for (const knopf of datei.matchAll(/aria-pressed=\{tab === '[a-z]+'\}/g)) {
    const rest = datei.slice(knopf.index ?? 0)
    const text = rest.match(/\/>\s*([A-Za-z][A-Za-z ]*)/)
    if (text) namen.push(text[1].trim())
  }
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

/** Zeichenketten einer Zeile. Kommentarzeilen zaehlen nicht als Kundentext. */
function kundentexte(zeile: string): string[] {
  const roh = zeile.trim()
  if (roh.startsWith('//') || roh.startsWith('*') || roh.startsWith('/*')) return []
  const out: string[] = []
  for (const m of zeile.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

const WEGWEISER = /Models\s*(?:→|->|&rarr;)\s*(.+)$/g
const REITERSATZ = /\bthe ([A-Z][A-Za-z ]*?) tab\b/g

/**
 * Namen, die die Reiterleiste der Models-Seite frueher getragen hat.
 *
 * Ein Kundentext, der einen davon nennt, schickt den Kunden zu einem Reiter,
 * den es auf der Seite nicht mehr gibt. Kommt der Name eines Tages zurueck,
 * faellt er hier von allein wieder heraus, weil gegen die echte Leiste
 * geprueft wird und nicht gegen diese Liste allein.
 */
const FRUEHERE_REITER = ['Discover']

describe('der Wegweiser auf die Models-Seite', () => {
  const reiter = reiterBeschriftungen()

  it('die Models-Seite hat die Reiter "Get new" und "Installed"', () => {
    expect(reiter).toEqual(['Get new', 'Installed'])
  })

  it('jeder "Models -> X"-Wegweiser im Baum nennt einen Reiter, den es gibt', () => {
    const suender: string[] = []
    for (const f of [...dateien(src, /\.tsx?$/), ...dateien(rust, /\.rs$/)]) {
      for (const [i, zeile] of readFileSync(f, 'utf8').split('\n').entries()) {
        for (const text of kundentexte(zeile)) {
          for (const treffer of text.matchAll(WEGWEISER)) {
            const rest = treffer[1]
            if (!reiter.some((r) => rest.startsWith(r))) {
              suender.push(`${f}:${i + 1} schickt nach "${rest.slice(0, 20)}"`)
            }
          }
        }
      }
    }
    expect(suender).toEqual([])
  })

  // Negativkontrolle im Test selbst: genau die drei alten Saetze standen in
  // der Anwendung, und genau die muessen als Verstoss durchfallen.
  it('der alte Satz waere aufgefallen', () => {
    const alt = 'Error: No image model installed. Download one from Models → Discover (e.g. "FLUX.1 [schnell] FP8") and try again.'
    const treffer = [...alt.matchAll(WEGWEISER)]
    expect(treffer).toHaveLength(1)
    expect(reiter.some((r) => treffer[0][1].startsWith(r))).toBe(false)
  })

  it('und jeder "the X tab"-Wegweiser genauso', () => {
    const suender: string[] = []
    for (const f of [...dateien(src, /\.tsx?$/), ...dateien(rust, /\.rs$/)]) {
      for (const [i, zeile] of readFileSync(f, 'utf8').split('\n').entries()) {
        for (const text of kundentexte(zeile)) {
          for (const treffer of text.matchAll(REITERSATZ)) {
            const name = treffer[1]
            if (FRUEHERE_REITER.includes(name) && !reiter.includes(name)) {
              suender.push(`${f}:${i + 1} nennt "${name}"`)
            }
          }
        }
      }
    }
    expect(suender).toEqual([])
  })

  // Negativkontrolle: genau der Satz, den ein neuer Kunde im Onboarding las.
  it('der Satz aus dem Onboarding waere aufgefallen', () => {
    const alt = "Great to verify your setup; pick bigger models from the Discover tab once you're in."
    const treffer = [...alt.matchAll(REITERSATZ)]
    expect(treffer).toHaveLength(1)
    expect(FRUEHERE_REITER).toContain(treffer[0][1])
    expect(reiter).not.toContain(treffer[0][1])
  })

  it('die drei Meldungen im Bild- und Videoweg zeigen auf "Get new"', () => {
    const datei = readFileSync(join(src, 'api', 'vram-handoff.ts'), 'utf8')
    const wege = [...datei.matchAll(/Models\s*→\s*([A-Za-z][A-Za-z ]*)/g)].map((m) => m[1].trim())
    expect(wege).toEqual(['Get new', 'Get new', 'Get new'])
  })
})
