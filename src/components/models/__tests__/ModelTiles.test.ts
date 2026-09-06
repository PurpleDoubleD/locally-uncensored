import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeFit, groupModels, pickDefaultVariant } from '../ModelTiles'
import { contrast, over } from '../../__tests__/wcag-contrast'
import type { DiscoverModel, DownloadProgress } from '../../../api/discover'

// The fit hint is a pure function of (model size, DETECTED vram) — these
// cases pin down what end users on different GPUs actually see, without
// needing the hardware on a test box. Thresholds: fits ≤ 0.85×VRAM (leave
// headroom for KV-cache/context), tight ≤ 1.15×VRAM, else big.
describe('computeFit — per-user hardware hint', () => {
  it('returns unknown (→ hint hidden) when hardware or size is missing', () => {
    expect(computeFit(undefined, 12)).toBe('unknown')
    expect(computeFit(5, null)).toBe('unknown')
    expect(computeFit(0, 12)).toBe('unknown')
  })

  it('8 GB GPU: small models fit, 12B-class tight, 20B-class spills to CPU', () => {
    expect(computeFit(5, 8)).toBe('fits')      // 8B Q4
    expect(computeFit(6.9, 8)).toBe('tight')   // 12B Q4 — loads, little headroom
    expect(computeFit(8, 8)).toBe('tight')     // exactly at VRAM
    expect(computeFit(13, 8)).toBe('big')
  })

  it('12 GB GPU (the dev box): 10 GB quant fits, 13 GB tight, 16 GB spills', () => {
    expect(computeFit(10, 12)).toBe('fits')    // GLM 4.7 Flash IQ2_M
    expect(computeFit(13, 12)).toBe('tight')   // Qwen 3.6 27B Q3
    expect(computeFit(16, 12)).toBe('big')     // 27B Q4
  })

  it('24 GB GPU: 20 GB MoEs green, 25 GB tight', () => {
    expect(computeFit(20, 24)).toBe('fits')
    expect(computeFit(25, 24)).toBe('tight')
    expect(computeFit(42, 24)).toBe('big')
  })

  it('48–50 GB GPU: 23 GB Ornith green; the 42 GB 70B flips tight→green at 50', () => {
    expect(computeFit(23, 48)).toBe('fits')    // Ornith 1.0 35B
    expect(computeFit(42, 48)).toBe('tight')   // 70B Q4 — real headroom is thin
    expect(computeFit(42, 50)).toBe('fits')    // 42 ≤ 50×0.85
    expect(computeFit(45, 50)).toBe('tight')   // Mistral Medium 3.5
    expect(computeFit(144, 50)).toBe('big')    // DeepSeek V4 Flash multi-part
  })

  it('never hides or blocks — big is a hint, not a gate (see FIT_META copy)', () => {
    // computeFit only classifies; there is no code path from 'big' to a
    // disabled Get button — asserted here as a contract statement.
    expect(computeFit(371, 12)).toBe('big')
  })
})

const M = (name: string, sizeGB: number, extra: Partial<DiscoverModel> = {}): DiscoverModel => ({
  name, description: name, pulls: '', tags: [], updated: '', sizeGB, ...extra,
})
const noDl = (_m: DiscoverModel): DownloadProgress | null => null
const notInstalled = (_m: DiscoverModel) => false

describe('pickDefaultVariant — the size picker recommendation', () => {
  const variants = [
    M('Q8', 27, { group: 'G' }),
    M('Q4', 16, { group: 'G' }),
    M('IQ2', 9, { group: 'G' }),
  ]

  it('no hardware detected → smallest variant (safe default)', () => {
    expect(pickDefaultVariant(variants, null, notInstalled, noDl).name).toBe('IQ2')
  })

  it('12 GB GPU → largest variant that still fits (9 GB, not 16)', () => {
    expect(pickDefaultVariant(variants, 12, notInstalled, noDl).name).toBe('IQ2')
  })

  it('24 GB GPU → the 16 GB quant; 50 GB GPU → the 27 GB quant', () => {
    expect(pickDefaultVariant(variants, 24, notInstalled, noDl).name).toBe('Q4')
    expect(pickDefaultVariant(variants, 50, notInstalled, noDl).name).toBe('Q8')
  })

  it('an installed variant always wins over the fit recommendation', () => {
    const installed = (m: DiscoverModel) => m.name === 'Q8'
    expect(pickDefaultVariant(variants, 12, installed, noDl).name).toBe('Q8')
  })
})

describe('groupModels — quant collapsing', () => {
  it('groups by `group` key, preserves catalog order, singletons stay single', () => {
    const models = [
      M('A Q4', 16, { group: 'A' }),
      M('B', 5),
      M('A Q8', 27, { group: 'A' }),
    ]
    const groups = groupModels(models)
    expect(groups.length).toBe(2)
    expect(groups[0].map(m => m.name)).toEqual(['A Q4', 'A Q8'])
    expect(groups[1].map(m => m.name)).toEqual(['B'])
  })
})

/**
 * Ton-Pass (Audit Welle 3): „Too big for your GPU" → „Laeuft auf CPU,
 * langsamer". Seit dem 04.09.2026 haelt derselbe Block auch die mittlere
 * Stufe fest, und zwar aus einem NEUEN Grund.
 *
 * WARUM SICH DIE REGEL GEAENDERT HAT: David, 04.09.2026, „kein gelb mehr ohne
 * farbe ... nicht so klotzig ueberall die fehlermeldungen und anmerkungen".
 * Damit hat die App nur noch zwei Toene, ruhig und Fehler, und Bernstein ist
 * keiner davon mehr (`src/lib/hinweis.ts`). Der Test hat vorher genau das
 * Gegenteil festgeschrieben: er verlangte in `punkte[1]` ausdruecklich
 * Bernstein und rechnete den Hellmodus-Kontrast dieses Tons nach. Beides ist
 * hier nicht geloescht, sondern umgestellt, denn der Sinn bleibt derselbe:
 * die Leiter muss eine Leiter bleiben und darf keine Stufe in einem
 * Warnungston tragen. Neu ist nur, welche Toene als Warnung gelten.
 *
 * Der Punkt „passt knapp" ist der Fall, an dem das haengt: er sagt, dass das
 * Modell passt. In der Farbe zu malen, mit der die App bis dahin jede Warnung
 * gemalt hat, war dieselbe Verwechslung wie „laeuft langsam" in Rot, nur eine
 * Stufe hoeher.
 *
 * Der Anhang des Audits nennt die Fit-Semantik dieses Grids als eine der
 * fuenf Stellen auf Benchmark-Niveau — mit genau einer Ausnahme: „Genau eine
 * Zeile ist falsch: `big.dot = 'bg-red-400/80'` — „laeuft langsam" ist kein
 * Fehler und darf nicht die Fehlerfarbe tragen." Bei der Re-Verifikation
 * stand sie eine Zeile tiefer als angegeben (:33 statt :32) und unveraendert
 * da, samt Label.
 *
 * WAS SICH HIER PRUEFEN LAESST: dass weder die Fehlerfarbe noch der alte
 * Warnungston in der Leiter stehen, dass das Label nicht mehr verbietet, was
 * der Code ausdruecklich erlaubt, und was die neuen Farben rechnerisch
 * bringen. WAS NICHT: ob Blau und Orange auf einem 6px-Punkt nebeneinander
 * unterscheidbar sind. Das ist der eine Punkt, der ins laufende Fenster
 * gehoert; hier steht nur die Zahl. (Dass es besser steht als vorher, ist
 * immerhin argumentierbar: Bernstein und Orange lagen auf dem Farbkreis
 * nebeneinander, Blau liegt es nicht.)
 *
 * Gelesen wird der Quelltext, weil FIT_META modulprivat ist und es auch
 * bleiben soll: es ist eine Darstellungstabelle, kein Vertrag.
 */
describe('Ton-Pass: „laeuft langsam" ist kein Fehler, „passt knapp" keine Warnung', () => {
  const SRC = readFileSync(resolve(__dirname, '../ModelTiles.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
  const zeile = SRC.match(/^\s*big:\s*\{[^}]*\},$/m)?.[0] ?? ''

  it('die Zeile, um die es geht, existiert noch', () => {
    expect(zeile).toContain('dot:')
    expect(zeile).toContain('label:')
    expect(zeile).toContain('title:')
  })

  it('der Punkt traegt keine Fehlerfarbe mehr', () => {
    // `red-300/400/500/600` sind die Toene, mit denen diese App an rund
    // hundert Stellen „kaputt oder wird geloescht" sagt.
    expect(zeile).not.toMatch(/red-\d/)
    expect(zeile).toContain('bg-orange-500/80')
  })

  it('die Leiter bleibt eine Leiter: drei Zustaende, drei Farben', () => {
    // Die mittlere Stufe hiess hier bis zum 04.09.2026 Bernstein. Sie heisst
    // jetzt Blau, weil die App nur noch zwei Toene kennt und keiner davon
    // Bernstein ist; die Leiter nennt damit den Ort statt einer Temperatur:
    // Grafikspeicher, knapp daneben, CPU.
    const punkte = [...SRC.matchAll(/dot: '([^']+)'/g)].map((m) => m[1])
    expect(punkte).toHaveLength(4)
    expect(new Set(punkte).size).toBe(4)
    expect(punkte[0]).toContain('emerald')
    expect(punkte[1]).toContain('sky')
    expect(punkte[2]).toContain('orange')
  })

  it('keine Stufe traegt mehr den alten Warnungston, nirgends in der Datei', () => {
    // Der Ton ist nicht nur aus der Leiter raus, er ist aus der Datei raus.
    // Stuende er zwei Bildschirme tiefer an einem Chip, waere die Regel aus
    // `src/lib/hinweis.ts` genau so weit weg wie vorher.
    expect(readFileSync(resolve(__dirname, '../ModelTiles.tsx'), 'utf-8'))
      .not.toMatch(/amber-|yellow-/)
  })

  it('das Label nennt die Folge und verbietet nichts', () => {
    // `computeFit` sagt es selbst, eine Bildschirmseite hoeher: „Never used
    // to BLOCK a download — purely an honest hint." „Too big" las sich als
    // Sperre, die es nie gab.
    expect(SRC).not.toContain('Too big')
    expect(zeile).toMatch(/label: 'Runs on CPU, slower'/)
    expect(zeile.toLowerCase()).toContain('slower')
  })

  it('der Tooltip sagt, dass es trotzdem geht', () => {
    expect(zeile).toMatch(/title: '[^']*works[^']*'/)
    expect(zeile).not.toMatch(/title: '[^']*slow\.[^']*'/)
  })

  it('beide Farbtausche kosten keinen Kontrast (gerechnet, nicht geschaetzt)', () => {
    // Kachelflaeche: `bg-gray-50` hell, `bg-white/[0.03]` ueber #1e1e1e
    // dunkel. Alle Punkte sind zu 80 % deckend.
    const kachelDunkel = over('#ffffff', '#1e1e1e', 0.03)
    const vorher = over('#f87171', kachelDunkel, 0.8)   // red-400/80
    const nachher = over('#f97316', kachelDunkel, 0.8)  // orange-500/80
    expect(contrast(vorher, kachelDunkel)).toBeCloseTo(4.05, 1)
    expect(contrast(nachher, kachelDunkel)).toBeCloseTo(3.98, 1)
    // Im Dunkelmodus erfuellt der Punkt 1.4.11 vorher wie nachher.
    expect(contrast(nachher, kachelDunkel)).toBeGreaterThanOrEqual(3)

    // Dasselbe fuer die mittlere Stufe. Der alte Ton war heller als der neue,
    // der Tausch kostet dunkel also etwas; er bleibt ueber 3:1 und gewinnt
    // dafuer im Hellmodus, wo der alte Ton der schlechteste der Leiter war.
    const mitteVorher = over('#f59e0b', kachelDunkel, 0.8)   // der alte Warnungston
    const mitteNachher = over('#0ea5e9', kachelDunkel, 0.8)  // sky-500/80
    expect(contrast(mitteVorher, kachelDunkel)).toBeCloseTo(5.08, 1)
    expect(contrast(mitteNachher, kachelDunkel)).toBeCloseTo(4.01, 1)
    expect(contrast(mitteNachher, kachelDunkel)).toBeGreaterThanOrEqual(3)
  })

  it('NEBENBEFUND, ungefixt: im Hellmodus traegt die GANZE Leiter nicht', () => {
    // Nicht durch diese Aenderung entstanden und nicht auf einen Punkt
    // allein zu reparieren — hier festgehalten, damit der Befund nicht
    // wieder verlorengeht. Getragen wird die Aussage im Normalfall vom
    // Label daneben; nur `<FitHint compact />` blendet es aus und laesst
    // den Punkt allein stehen.
    const hell = '#f9fafb'
    for (const [name, farbe] of [
      ['emerald-500', '#10b981'],
      ['sky-500', '#0ea5e9'],
      ['orange-500', '#f97316'],
    ] as const) {
      const c = contrast(over(farbe, hell, 0.8), hell)
      expect(c, `${name} im Hellmodus`).toBeLessThan(3)
    }
    expect(SRC).toContain('compact')
  })
})
