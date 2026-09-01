/**
 * D-T05 (zwei Akzente nebeneinander) und D-T06 (die Shell malt Literale).
 *
 * ── D-T05: der Audit hatte recht in der Beobachtung und unrecht im Schluss ──
 *
 * Beobachtung, am 01.09.2026 nachgezaehlt: `--color-lu-accent` ist #a094f8,
 * #7c3aed stand an 20 Stellen in drei Dateien als Literal, und das
 * Brand-Kit-Violett #8b5cf6 kommt in `src/` 0x vor. Der naheliegende
 * Schluss — auf EINEN Hex zusammenfallen — ist nachgerechnet falsch.
 *
 * Es sind keine zwei Marken, es sind zwei ROLLEN. #7c3aed steht
 * ausschliesslich an der Cloud, und Cloud ist in dieser App ein
 * Geldzustand. Und es ist die einzige Farbe der vier Kandidaten, die an
 * ihren eigenen Call-Sites AA haelt. Dieser Test rechnet alle vier nach,
 * damit die Ablehnung eine Zahl hat und keine Meinung ist.
 *
 * Geaendert wurde deshalb nicht die Farbe, sondern ihre Herkunft: aus
 * zwanzig Literalen wird eine Definition.
 *
 * ── D-T06: EIN Token dazu, und begruendet KEINE gespiegelte Leiter ──
 *
 * Die Flaechenleiter hiess an ihrer untersten Stufe „app canvas", aber die
 * Leinwand der App ist #141414 und nicht #202020. Gezaehlt:
 *
 *     #141414  9 Fundstellen  kein Token   ← die meistbenutzte Flaeche
 *     #1e1e1e  5 Fundstellen  kein Token
 *     --color-lu-base   #202020  2 Fundstellen (zwei Modale)
 *     --color-lu-raised #2d2d2d  0 Fundstellen — im Fenster als LEERE
 *                                Variable gemessen
 *
 * Ein Token dazu (`--color-lu-canvas`), und die Migration betrifft
 * ausschliesslich die DUNKLE Seite: das helle Gegenstueck jeder Call-Site
 * bleibt Zeichen fuer Zeichen stehen, der Tausch ist damit in beiden Modi
 * folgenlos.
 *
 * ── Was hier NICHT geprueft werden kann ──
 *
 *   • ob Violett die richtige Cloud-Farbe ist. Geprueft wird nur, dass sie
 *     lesbar ist und aus einer Quelle kommt.
 *   • ob #1e1e1e ein Token bekommen sollte. Es teilt seinen Wert mit der
 *     Sidebar, und die gehoert in diesem Durchgang einem anderen Agenten.
 *   • ob die drei verbliebenen #141414-Literale falsch sind. Sie stehen in
 *     Dateien, die dieser Durchgang nur lesen darf; sie sind hier gezaehlt.
 *
 * Run: npx vitest run src/components/__tests__/zwei-akzente-und-eine-leinwand.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over } from './wcag-contrast'

const SRC = resolve(__dirname, '..', '..')
const CSS = readFileSync(resolve(SRC, 'index.css'), 'utf8')
const nurCode = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const CSS_CODE = nurCode(CSS)

function appDateien(dir = SRC): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__') continue
    const p = resolve(dir, e.name)
    if (e.isDirectory()) out.push(...appDateien(p))
    else if (/\.tsx?$/.test(e.name)) out.push([p.slice(SRC.length + 1), readFileSync(p, 'utf8')])
  }
  return out
}
const DATEIEN = appDateien()
const ALL = DATEIEN.map(([, s]) => s).join('\n')

/** Ein Farbtoken aus index.css lesen — nicht aus dem Gedaechtnis. */
function token(name: string): string {
  const v = CSS_CODE.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
  if (!v) throw new Error(`kein Token --color-${name}`)
  return v.toLowerCase()
}

// ── D-T05 ──────────────────────────────────────────────────────────────

describe('der Cloud-Akzent ist eine Rolle, keine zweite Marke', () => {
  const CLOUD = token('lu-cloud')
  const LIFT = token('lu-cloud-lift')
  const HAUS = token('lu-accent')
  const KANTE = token('lu-accent-edge')
  const BRANDKIT = '#8b5cf6'

  /** Die sechs Textstellen der Cloud, mit ihren echten Deckungen. */
  const stellen = (hell: string, dunkel: string) => [
    contrast(hell, over(hell, '#ffffff', 0.15)), // Abzeichen ueber dem Eingabefeld
    contrast(dunkel, over(dunkel, '#1e1e1e', 0.15)),
    contrast(hell, over(hell, '#ffffff', 0.10)), // Cloud-Schalter
    contrast(dunkel, over(dunkel, '#1e1e1e', 0.10)),
    contrast(hell, over(hell, '#ffffff', 0.05)), // Kachel im Gate-Dialog
    contrast(dunkel, over(dunkel, '#1e1e1e', 0.05)),
  ]
  const minimum = (hell: string, dunkel: string) => Math.min(...stellen(hell, dunkel))

  it('das heutige Paar haelt AA an jeder seiner Stellen', () => {
    expect(minimum(CLOUD, LIFT)).toBeGreaterThanOrEqual(4.5)
  })

  it('und jeder Kollaps auf EINE Farbe faellt durch — mit Zahlen', () => {
    // A: nur der Haus-Akzent. B: das Brand-Kit-Violett. C: das Haus-PAAR.
    // Alle drei liegen unter 4,5:1, alle drei kosten gegenueber heute.
    const heute = minimum(CLOUD, LIFT)
    const a = minimum(HAUS, HAUS)
    const b = minimum(BRANDKIT, BRANDKIT)
    const c = minimum(KANTE, HAUS)
    for (const [name, wert] of [['A #a094f8', a], ['B #8b5cf6', b], ['C Hauspaar', c]] as const) {
      expect(wert, `${name} haelt AA — dann waere die Ablehnung falsch`).toBeLessThan(4.5)
      expect(wert, `${name} ist nicht schlechter als heute`).toBeLessThan(heute)
    }
  })

  it('die gefuellte Cloud-Flaeche traegt weissen Text in BEIDEN Modi', () => {
    // Sie hat bewusst kein dark:-Gegenstueck; deshalb muss die eine Farbe
    // fuer beide reichen.
    expect(contrast('#ffffff', CLOUD)).toBeGreaterThanOrEqual(4.5)
    // Mit dem Haus-Akzent waere genau das nicht mehr wahr.
    expect(contrast('#ffffff', HAUS)).toBeLessThan(3)
  })

  it('kein einziges Cloud-Literal ist uebrig', () => {
    const orte: string[] = []
    for (const [name, src] of DATEIEN) {
      for (const m of src.matchAll(/#(?:7c3aed|a78bfa)/gi)) orte.push(`${name}: ${m[0]}`)
    }
    expect(orte).toEqual([])
  })

  it('und die Tokens werden wirklich aufgerufen', () => {
    expect((ALL.match(/(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring)-lu-cloud(?![\w-])/g) ?? []).length)
      .toBeGreaterThanOrEqual(10)
    expect(ALL).toContain('dark:text-lu-cloud-lift')
  })

  it('das Brand-Kit-Violett kommt weiterhin nirgends vor', () => {
    // Der Audit fuehrte es als „die eigentliche Wahrheit". Es hat in
    // dieser App nie eine Call-Site gehabt, und es bekommt hier keine.
    expect(ALL.toLowerCase()).not.toContain(BRANDKIT)
    expect(CSS_CODE.toLowerCase()).not.toContain(BRANDKIT)
  })
})

// ── D-T06 ──────────────────────────────────────────────────────────────

describe('die Leinwand hat einen Namen bekommen', () => {
  it('--color-lu-canvas ist genau der Wert, der vorher als Literal dastand', () => {
    expect(token('lu-canvas')).toBe('#141414')
  })

  it('die sechs erreichbaren Call-Sites nehmen das Token', () => {
    const erwartet = [
      'components/layout/AppShell.tsx',
      'components/layout/Header.tsx',
      'components/layout/Titlebar.tsx',
      'components/layout/ViewSkeletons.tsx',
      'components/ui/ContextMenu.tsx',
    ]
    for (const f of erwartet) {
      const src = DATEIEN.find(([n]) => n === f)?.[1] ?? ''
      expect(src, f).not.toBe('')
      expect(src, `${f} nimmt das Token nicht`).toContain('dark:bg-lu-canvas')
      expect(src, `${f} hat noch ein Literal`).not.toContain('dark:bg-[#141414]')
    }
    // Titlebar zeichnet zwei Varianten desselben Balkens.
    const tb = DATEIEN.find(([n]) => n === 'components/layout/Titlebar.tsx')?.[1] ?? ''
    expect((tb.match(/dark:bg-lu-canvas/g) ?? []).length).toBe(2)
  })

  it('jede Call-Site behaelt ihr eigenes Hell-Gegenstueck — der Tausch ist folgenlos', () => {
    // DAS ist der Grund, warum der Tausch keine Farbe bewegt: die dunkle
    // Seite wechselt die Schreibweise, die helle bleibt unangetastet.
    for (const [, src] of DATEIEN) {
      for (const m of src.matchAll(/[\w-/[\].]*\bdark:bg-lu-canvas\b/g)) {
        const zeile = src.split('\n').find((z) => z.includes(m[0])) ?? ''
        expect(zeile, `ohne Hell-Gegenstueck: ${zeile.trim().slice(0, 90)}`)
          .toMatch(/(?<![\w-:])bg-(white|gray-200)(?![\w-])/)
      }
    }
  })

  it('die drei unerreichbaren Literale sind gezaehlt, nicht uebersehen', () => {
    // Sidebar und die beiden Create-Dateien gehoeren in diesem Durchgang
    // anderen Agenten. Die Zahl darf sinken, nicht steigen.
    const rest = DATEIEN
      .filter(([, s]) => s.includes('dark:bg-[#141414]'))
      .map(([n]) => n)
      .sort()
    expect(rest).toEqual([
      'components/create/experimental/CreateExperimental.tsx',
      'components/create/experimental/MaskEditor.tsx',
      'components/layout/Sidebar.tsx',
    ])
  })

  it('es gibt bewusst KEINE gespiegelte Hell-Leiter', () => {
    // Der Vorschlag lautete, `--color-lu-*` im `.light`-Block zu spiegeln.
    // Nachgezaehlt zerfaellt #141414 im Hellmodus in zwei Rollen — die
    // Fundstellen tragen `bg-gray-200` ODER `bg-white` als Gegenstueck —,
    // eine Spiegelung muesste also eine der beiden falsch faerben.
    const gegenstuecke = new Set<string>()
    for (const [, src] of DATEIEN) {
      for (const zeile of src.split('\n')) {
        if (!zeile.includes('dark:bg-lu-canvas')) continue
        const m = zeile.match(/(?<![\w-:])bg-(white|gray-200)(?![\w-])/)
        if (m) gegenstuecke.add(m[1])
      }
    }
    expect([...gegenstuecke].sort()).toEqual(['gray-200', 'white'])
    expect(CSS_CODE).not.toMatch(/\.light\s*\{[^}]*--color-lu-(canvas|base|panel|raised|overlay)/)
  })

  it('das tote Token steht als tot da', () => {
    // --color-lu-raised hat 0 Call-Sites. Es zu entfernen waere eine
    // eigene Entscheidung; es unbeschriftet stehen zu lassen war der
    // Zustand, aus dem der Befund entstand.
    expect(ALL).not.toMatch(/(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring)-lu-raised(?![\w-])/)
    const zeile = CSS.split('\n').find((z) => /^\s*--color-lu-raised:/.test(z)) ?? ''
    expect(zeile, 'keine Deklarationszeile gefunden').not.toBe('')
    expect(zeile).toContain('0 Call-Sites')
  })
})
