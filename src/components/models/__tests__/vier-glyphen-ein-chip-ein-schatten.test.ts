/**
 * Models-Screen · D-S22 bis D-S25
 *
 * Vier Befunde aus §4 „Models" des Design-Audits, alle vier in derselben
 * Kachelzeile bzw. direkt darueber:
 *
 *   D-S22  „Vier verschiedene Glyphen im selben Slot neben dem Titel
 *           (Flame/Wrench/Eye/Feather), alle 11px, alle text-gray-500,
 *           ohne Legende."
 *   D-S23  „Quant-Dropdown und statischer Groessen-Chip haben identische
 *           Klassen an identischer Position, Unterschied ist nur ein
 *           10px-Chevron."
 *   D-S24  „53× ‚Get' traegt shadow-sm — das Light-Mode-Rezept
 *           rgba(0,0,0,.1), auf #141414 unsichtbar."
 *   D-S25  „Zwei Segmented-Sprachen 47px uebereinander: Mainstream/
 *           Unfiltered rechteckig, Groessenfilter als Pills."
 *
 * Was hier WIRKLICH gerendert wird: `ModelTile` und `BundleTile` laufen
 * durch `react-dom/server` — echte Komponenten, echte Props, echtes Markup.
 * Kein Mock und kein jsdom noetig, weil beide reine Darstellung sind.
 * `DiscoverModels` selbst ist ein Bildschirm voller Store-Hooks und
 * Tauri-Aufrufe; die zwei Filterreihen darin sind deshalb am Quelltext
 * gepinnt — dasselbe Verfahren wie in `long-transcripts-stay-cheap.test.ts`.
 *
 * Was hier NICHT geprueft werden kann: ob die Legende oben tatsaechlich
 * gefunden wird, ob 26px hohe Controls in der Kachel gut aussehen, und ob
 * Wrench und Feather auf 12px unterscheidbar sind. Das gehoert ins laufende
 * Fenster.
 *
 * Run: npx vitest run src/components/models/__tests__/vier-glyphen-ein-chip-ein-schatten.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ModelTile, BundleTile, CapLegend, CAPABILITIES } from '../ModelTiles'
import { ICON_SM } from '../../ui/icon-size'
import type { DiscoverModel, ModelBundle } from '../../../api/discover'

const TILES = readFileSync(resolve(__dirname, '../ModelTiles.tsx'), 'utf8')
const SCREEN = readFileSync(resolve(__dirname, '../DiscoverModels.tsx'), 'utf8')

/** Ohne Kommentare — sonst zaehlt der Befund, der ueber der Zeile erklaert
 *  wird, als der Befund selbst. */
const ohneKommentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')

const M = (name: string, sizeGB: number, extra: Partial<DiscoverModel> = {}): DiscoverModel => ({
  name,
  description: `${name} · a model`,
  pulls: '120k',
  tags: ['Q4_K_M'],
  updated: '',
  sizeGB,
  ...extra,
})

const tile = (variants: DiscoverModel[], vramGb: number | null = 12) =>
  renderToStaticMarkup(createElement(ModelTile, {
    variants,
    vramGb,
    isInstalled: () => false,
    dlState: () => null,
    onDownload: () => {},
    onInfo: () => {},
    onOpenUrl: () => {},
  }))

// ── D-S22 ───────────────────────────────────────────────────────────

describe('D-S22 · vier Bedeutungen, eine Optik, keine Legende', () => {
  const alles = M('Qwen3 8B', 5, {
    hot: true,
    agent: true,
    lightweight: true,
    tags: ['Q4_K_M', 'vision'],
  })

  it('der Faehigkeits-Slot traegt nur noch Faehigkeiten — die Flamme ist keine', () => {
    // `hot` ist Beliebtheit, dieselbe Kategorie wie `pulls`. Ein Slot, der
    // zwei Kategorien mischt, ist der Grund, warum er sich nicht lesen laesst.
    expect(CAPABILITIES.map(c => c.key)).toEqual(['agent', 'vision', 'lightweight'])
    expect(CAPABILITIES.some(c => c.key === ('hot' as never))).toBe(false)
  })

  it('die Flamme steht bei der Downloadzahl, nicht beim Titel', () => {
    const html = tile([alles])
    const titel = html.indexOf('Qwen3 8B</h3>')
    const blurb = html.indexOf('</p>')            // Ende des Kachelkopfs
    const flamme = html.indexOf('Hot right now')
    const zahl = html.indexOf('120k')
    expect(titel).toBeGreaterThan(-1)
    // Aus dem Kopf heraus …
    expect(flamme).toBeGreaterThan(blurb)
    // … und in die Metazeile hinein, vor die Downloadzahl.
    expect(flamme).toBeLessThan(zahl)
    // Zwischen Flamme und Zahl liegt nichts als das Icon selbst.
    expect(html.slice(flamme, zahl)).not.toContain('<button')
  })

  it('jedes Zeichen sagt seinen Namen, auch ohne Maus', () => {
    const html = tile([alles])
    for (const cap of CAPABILITIES) {
      expect(html).toContain(`aria-label="${cap.title}"`)
      expect(html).toContain(`title="${cap.title}"`)
    }
    expect(html).toContain('role="img"')
  })

  it('es GIBT eine Legende, und sie zeigt dieselben Zeichen in derselben Groesse', () => {
    const legende = renderToStaticMarkup(createElement(CapLegend))
    const kachel = tile([alles])
    for (const cap of CAPABILITIES) {
      expect(legende).toContain(cap.label)
      expect(legende).toContain(cap.title)
    }
    // Dieselben Pfade heisst: dasselbe Icon. Ein Vergleich der SVG-Rohdaten
    // faengt einen Austausch, den ein Textvergleich der Labels nicht sieht.
    const pfade = (s: string) => [...s.matchAll(/ d="([^"]+)"/g)].map(m => m[1])
    const inLegende = new Set(pfade(legende))
    expect(inLegende.size).toBeGreaterThan(2)
    for (const p of inLegende) expect(pfade(kachel)).toContain(p)
    // Und dieselbe Groesse — sonst ist es keine Legende, sondern ein Bild.
    expect(legende).toContain(`width="${ICON_SM}"`)
    expect(kachel).toContain(`width="${ICON_SM}"`)
  })

  it('und sie steht wirklich auf dem Screen, ueber dem Raster', () => {
    // Eine Legende, die nur im Test existiert, ist keine.
    expect(SCREEN).toMatch(/<CapLegend\s*\/>/)
    const legendeIdx = SCREEN.indexOf('<CapLegend')
    const rasterIdx = SCREEN.indexOf('{gridGroups.map(')
    expect(legendeIdx).toBeGreaterThan(-1)
    expect(legendeIdx).toBeLessThan(rasterIdx)
  })

  it('die Legende kann nicht von den Kacheln abweichen — eine Tabelle, zwei Leser', () => {
    // `CapIcons` und `CapLegend` lesen beide `CAPABILITIES`; es gibt keine
    // zweite Liste, die man vergessen koennte nachzuziehen.
    const code = TILES.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    expect(code.match(/CAPABILITIES\s*[.:]/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(code).toMatch(/CAPABILITIES\.filter\(/)
    expect(code).toMatch(/CAPABILITIES\.map\(/)
  })

  it('ein Modell ohne Faehigkeiten bekommt keinen leeren Slot', () => {
    const html = tile([M('Plain', 5)])
    expect(html).not.toContain('role="img"')
  })
})

// ── D-S23 ───────────────────────────────────────────────────────────

describe('D-S23 · ein Bedienelement, das aussah wie eine Anzeige', () => {
  const zweiQuants = [M('Q4', 5, { group: 'Fam' }), M('Q8', 9, { group: 'Fam' })]

  it('der Aufklapper traegt das Control-Rezept des Hauses', () => {
    const html = tile(zweiQuants)
    expect(html).toContain('class="lu-control tabular-nums"')
  })

  it('er sagt, dass er ein Aufklapper ist — und ob er offen ist', () => {
    const html = tile(zweiQuants)
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
  })

  it('sein Zustand kommt aus ARIA, nicht aus einer zweiten Faerbung', () => {
    // `.lu-control[aria-expanded="true"]` faerbt (index.css). Die Call-Site
    // schreibt keine eigene Offen-Klasse dazu, also koennen Optik und
    // Barrierefreiheit nicht auseinanderlaufen.
    const picker = TILES.slice(TILES.indexOf('aria-haspopup="listbox"') - 400, TILES.indexOf('aria-haspopup="listbox"') + 200)
    expect(picker).not.toMatch(/pickerOpen \? '[^']*bg-/)
  })

  it('der statische Chip bleibt flach: keine Fuellung mit Hover, kein Rand, kein Chevron', () => {
    const nurEine = tile([M('Solo', 7)])
    expect(nurEine).toContain('7 GB')
    expect(nurEine).not.toContain('lu-control')
    expect(nurEine).not.toContain('aria-haspopup')
  })

  it('die beiden Klassenketten sind nicht mehr deckungsgleich', () => {
    // Der Befund in einem Satz: gleiche Klassen, gleiche Stelle. Der Chip
    // traegt seine Flaeche, das Control traegt ein Rezept — kein einziges
    // gemeinsames Erscheinungsmerkmal ausser der Zeile, in der sie stehen.
    const chip = TILES.match(/t-micro px-1\.5 py-0\.5 rounded-md bg-gray-100[^"]*/)?.[0] ?? ''
    expect(chip).not.toBe('')
    expect(chip).not.toContain('lu-control')
    expect(TILES).not.toMatch(/className="flex items-center gap-1 px-1\.5 py-0\.5 rounded-md bg-gray-100/)
  })

  it('das Menue ist eine Liste, und Escape schliesst sie', () => {
    const offen = TILES.slice(TILES.indexOf('role="listbox"'), TILES.indexOf('role="listbox"') + 900)
    expect(offen).toContain('role="option"')
    expect(offen).toContain('aria-selected')
    expect(TILES).toMatch(/e\.key === 'Escape'/)
  })
})

// ── D-S24 ───────────────────────────────────────────────────────────

describe('D-S24 · der Schatten, den niemand je gesehen hat', () => {
  it('kein shadow-sm mehr auf dem ganzen Models-Screen', () => {
    expect(ohneKommentar(TILES)).not.toContain('shadow-sm')
    expect(ohneKommentar(SCREEN)).not.toContain('shadow-sm')
  })

  it('„Get" ist trotzdem der einzige gefuellte UND gerandete Knopf der Kachel', () => {
    const html = tile([M('Solo', 7)])
    expect(html).toContain('Get')
    expect(html).toMatch(/class="[^"]*border border-gray-200[^"]*"/)
    expect(html).not.toContain('shadow')
  })

  it('das Bundle-Pendant traegt dasselbe Rezept, nicht seine eigene Kopie', () => {
    const bundle: ModelBundle = {
      name: 'SDXL Turbo',
      description: 'fast image model',
      files: [{ filename: 'a.safetensors', url: 'https://example.invalid/a', subfolder: 'checkpoints', sizeGB: 6 }],
      totalSizeGB: 6,
      vram: '8 GB',
      category: 'image',
    } as unknown as ModelBundle
    const html = renderToStaticMarkup(createElement(BundleTile, {
      bundle, vramGb: 12, complete: false, downloading: false, hasErrors: false,
      onInstall: () => {}, onRetry: () => {}, onClear: () => {}, onOpenUrl: () => {},
    }))
    expect(html).not.toContain('shadow')
    expect(html).toContain('Get · 6 GB')
    // EIN Rezept, zwei Call-Sites — nicht zwei handgeschriebene Ketten.
    expect((TILES.match(/className=\{TILE_ACTION\}/g) ?? []).length).toBe(2)
  })

  it('echte Erhebung bleibt, wo wirklich etwas schwebt — und kommt aus dem Rezept', () => {
    // Das Aufklappmenue liegt ueber der Kachel darunter — dort ist ein
    // Schatten kein Dekor, sondern die Aussage. Seit D-T06/D-T09 kommt sie
    // nicht mehr aus einer handgeschriebenen Kette (`bg-[#17171c] border
    // border-white/10 shadow-xl`), sondern aus `.lu-elevated`.
    //
    // `ohneKommentar` ist hier keine Kosmetik: die Vorfassung dieser
    // Zusicherung las `expect(TILES).toContain('shadow-xl')` — und die
    // Klasse stand ausser im Menue auch im Kommentar ueber TILE_ACTION.
    // Sie waere gruen geblieben, haette man das Menue ersatzlos gestrichen.
    const code = ohneKommentar(TILES)
    expect(code).toContain('lu-elevated')
    expect(code).not.toContain('shadow-xl')
    expect(code).not.toContain('#17171c')
  })
})

// ── D-S25 ───────────────────────────────────────────────────────────

describe('D-S25 · zwei Segmented-Sprachen 47px uebereinander', () => {
  const rows = SCREEN.slice(SCREEN.indexOf('{/* Filter bar:'), SCREEN.indexOf('{/* D-S22 ·'))

  it('beide Reihen stehen in derselben Spur', () => {
    expect((rows.match(/className=\{SEGMENT_TRACK\}/g) ?? []).length).toBe(2)
    expect(SCREEN).toMatch(/const SEGMENT_TRACK\s*=/)
  })

  it('beide Reihen benutzen dasselbe Segment-Rezept', () => {
    // Vier Mainstream-/Unfiltered- plus sechs Groessen-Segmente, alle
    // `className="lu-control"` ohne Zusatz.
    expect((rows.match(/className="lu-control"/g) ?? []).length).toBe(3)
  })

  it('kein Segment faerbt sich mehr selbst — der Zustand kommt aus aria-pressed', () => {
    expect((rows.match(/aria-pressed=/g) ?? []).length).toBe(3)
    expect(rows).not.toMatch(/subTab === '(mainstream|uncensored)'\s*\n?\s*\?\s*'bg-/)
    expect(rows).not.toMatch(/vramTier === tier\.key\s*\n?[^\n]*\n?\s*\?\s*'bg-/)
  })

  it('die Pillen sind weg — eine Form, nicht zwei', () => {
    expect(rows).not.toContain('rounded-full')
    expect(rows).not.toContain('rounded-md')
  })

  it('die Spur ist nur ein Behaelter, kein drittes Rezept in index.css', () => {
    // Erlaubt sind hier nur die Dateien des Models-Screens; eine neue
    // globale Regel waere an dieser Stelle auch die falsche Antwort.
    const track = SCREEN.slice(SCREEN.indexOf('const SEGMENT_TRACK'), SCREEN.indexOf('const SEGMENT_TRACK') + 400)
    expect(track).toContain('--radius-control')
    expect(track).toContain('p-0.5')
  })
})
