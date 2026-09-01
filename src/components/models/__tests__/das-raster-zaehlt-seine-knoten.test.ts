/**
 * D-S26 · „Keine Virtualisierung: 53 Karten = 1610 DOM-Knoten, 300 Modelle ≈ 9000."
 *
 * Der Befund steht in §4 „Models" des Design-Audits und nennt
 * `DiscoverModels.tsx:899` / `:917` — die beiden Raster, die jede Gruppe
 * ausgeben. Die vorgeschlagene Abhilfe ist dieselbe wie bei RP-1/T-11 im
 * Transkript, und dort wurde sie umgesetzt: `content-visibility: auto`.
 *
 * DIESE DATEI IST DIE MESSUNG, NICHT DIE UMSETZUNG — und die Messung sagt,
 * dass dasselbe Mittel hier NICHT traegt. Was gemessen wurde:
 *
 * ── 1. Knoten, hier im Test, aus dem echten Katalog ──────────────────
 * `renderToStaticMarkup` ueber jede Gruppe beider Reiter. Ergebnis unten in
 * den Tests, und es reproduziert die Zahl des Audits: 53 Kacheln.
 *
 * ── 2. Layoutkosten, in der laufenden App ────────────────────────────
 * Chromium, Dev-Server auf :5273, Models-Reiter, 1600×900, dreispaltig.
 * Erzwungenes Style+Layout (`scroller.offsetHeight` nach Invalidierung),
 * Median aus 41 Messungen, davor 15 Aufwaermrunden:
 *
 *     53 Kacheln   (1304 Elementknoten, Seite gesamt 1595)   0,2 ms
 *    303 Kacheln   (Kacheln geklont, ≈ 7500 Knoten)          1,1 ms
 *
 * Mit `content-visibility: auto` + `contain-intrinsic-size: auto 125px` auf
 * jeder Kachel, gleiche Messung, gleiche Sitzung:
 *
 *     53 Kacheln   0,2 ms   (unveraendert)
 *    303 Kacheln   1,1 ms   (unveraendert)
 *
 * Und es kostet etwas: `scrollHeight` wuchs von 2187 auf 2637 px (53) bzw.
 * von 11367 auf 13842 px (303) — die geschaetzte Ersatzhoehe liegt rund 20 %
 * ueber der echten, der Rollbalken luege also, bis man an jeder Kachel
 * einmal vorbeigescrollt ist.
 *
 * ── Warum es im Transkript hilft und hier nicht ──────────────────────
 * Eine Nachrichtenblase ist ein gerendertes Markdown-Dokument — Codebloecke
 * mit Prism-Spans, KaTeX, Tabellen, oft hunderte Knoten mit teurem Layout.
 * Eine Modellkachel sind rund 25 Flexboxen. `content-visibility` spart das
 * Layout eines Teilbaums; wo der Teilbaum 25 Kaesten gross ist, gibt es
 * nichts zu sparen. Die 1,1 ms bei 303 Kacheln sind das ganze Budget.
 *
 * ── Was stattdessen hier steht ───────────────────────────────────────
 * Die Zahlen, und eine Schranke. Der Befund rechnet mit 300 Modellen; die
 * App kann heute gar nicht so viele zeigen (Katalog + gedeckelte
 * HF-Suche, siehe unten). Wenn der Katalog waechst, faellt dieser Test auf
 * und sagt: jetzt neu messen — statt dass jemand in zwei Jahren eine
 * Bibliothek einbaut, weil in einem Audit von 2026 eine Hochrechnung stand.
 *
 * ── Was hier NICHT gemessen ist ──────────────────────────────────────
 * Paint und Compositing (nur Style+Layout wurden erzwungen), das Mounten
 * der 300 Kacheln durch React, und Maschinen, die langsamer sind als diese.
 * Die Browsermessung stammt aus EINER Sitzung auf EINEM Geraet.
 *
 * Run: npx vitest run src/components/models/__tests__/das-raster-zaehlt-seine-knoten.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ModelTile, groupModels } from '../ModelTiles'
import { getMainstreamTextModels, getUncensoredTextModels } from '../../../api/discover'
import type { DiscoverModel } from '../../../api/discover'

const SCREEN = readFileSync(resolve(__dirname, '../DiscoverModels.tsx'), 'utf8')
const DISCOVER = readFileSync(resolve(__dirname, '../../../api/discover.ts'), 'utf8')

/** Elementknoten eines Markups. Textknoten zaehlt der Audit mit; diese Zahl
 *  ist also die untere, nicht die groessere. */
const elements = (html: string) => html.match(/<[a-zA-Z]/g)?.length ?? 0

const renderGroup = (g: DiscoverModel[]) =>
  renderToStaticMarkup(createElement(ModelTile, {
    variants: g,
    vramGb: 12,
    isInstalled: () => false,
    dlState: () => null,
    onDownload: () => {},
    onInfo: () => {},
    onOpenUrl: () => {},
  }))

function messeReiter(models: DiscoverModel[]) {
  const groups = groupModels(models)
  const knoten = groups.reduce((sum, g) => sum + elements(renderGroup(g)), 0)
  return { kacheln: groups.length, knoten, proKachel: knoten / groups.length }
}

describe('D-S26 · was das Raster wirklich kostet', () => {
  it('der Katalog ergibt die 53 Kacheln, die der Audit gezaehlt hat', () => {
    expect(messeReiter(getMainstreamTextModels()).kacheln).toBe(53)
    expect(messeReiter(getUncensoredTextModels()).kacheln).toBe(53)
  })

  it('eine Kachel ist rund 28 Elementknoten gross, nicht 300', () => {
    const m = messeReiter(getMainstreamTextModels())
    expect(m.proKachel).toBeGreaterThan(20)
    expect(m.proKachel).toBeLessThan(35)
  })

  it('ein Reiter kostet rund 1500 Elementknoten — die Zahl des Audits', () => {
    // Audit: „53 Karten = 1610 DOM-Knoten". Hier gezaehlt sind nur Elemente;
    // im Browser waren es 1304 im Raster und 1595 auf der ganzen Seite.
    for (const models of [getMainstreamTextModels(), getUncensoredTextModels()]) {
      const { knoten } = messeReiter(models)
      expect(knoten).toBeGreaterThan(1000)
      expect(knoten).toBeLessThan(2000)
    }
  })

  it('die Obergrenze des Screens ist gedeckelt: Katalog + 20 HF-Treffer', () => {
    // Die „300 Modelle" des Befundes sind eine Hochrechnung. Was heute
    // gleichzeitig im DOM stehen kann, ist Katalog plus HuggingFace-Suche,
    // und die Suche fragt mit `limit=20`.
    expect(DISCOVER).toMatch(/huggingface\.co\/api\/models\?[^`'"]*limit=20/)
    const groesster = Math.max(
      messeReiter(getMainstreamTextModels()).kacheln,
      messeReiter(getUncensoredTextModels()).kacheln,
    )
    expect(groesster + 20).toBeLessThan(150)
  })

  it('SCHRANKE: waechst der Katalog ueber das Gemessene hinaus, neu messen', () => {
    // Kein Grenzwert aus dem Gefuehl: 150 Kacheln sind rund das Dreifache
    // des Standes, bei dem 0,2 ms gemessen wurden, und liegen unter den
    // 303 Kacheln, bei denen 1,1 ms gemessen wurden. Wer diese Zeile rot
    // sieht, hat einen Katalog in einer Groesse, fuer die es hier keine
    // Messung gibt — also messen, nicht raten. Die Anleitung dafuer steht
    // im Kopf dieser Datei.
    for (const models of [getMainstreamTextModels(), getUncensoredTextModels()]) {
      expect(groupModels(models).length).toBeLessThan(150)
    }
  })
})

describe('D-S26 · die Entscheidung steht im Code, nicht nur im Bericht', () => {
  it('keine Virtualisierungsbibliothek, kein Slice, kein Fenster', () => {
    expect(SCREEN).not.toMatch(/react-window|react-virtuoso|virtua|@tanstack\/react-virtual/)
    expect(SCREEN).not.toMatch(/gridGroups\.slice\(/)
  })

  it('auch kein content-visibility — gemessen, nicht vergessen', () => {
    // Der Unterschied zu MessageList (T-11) ist Absicht und steht dort wie
    // hier begruendet. Wer es hier doch einbaut, muss diesen Test anfassen
    // und stolpert dabei ueber die Zahlen im Kopf dieser Datei.
    expect(SCREEN).not.toContain('contentVisibility')
    expect(SCREEN).not.toContain('containIntrinsicSize')
  })

  it('die Begruendung samt Messwerten steht am Raster', () => {
    const grid = SCREEN.slice(SCREEN.indexOf('D-S26'), SCREEN.indexOf('D-S26') + 1800)
    expect(grid).toContain('content-visibility')
    expect(grid).toMatch(/1304|1595/)   // die im Browser gezaehlten Knoten
    expect(grid).toMatch(/1,1 ms|1.1 ms/)
  })
})
