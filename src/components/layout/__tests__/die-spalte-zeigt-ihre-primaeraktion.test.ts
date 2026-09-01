/**
 * Die Sidebar zeigt, was sie meint — D-S03, D-S04 und KF-8.
 *
 *   D-S03  „Die Klassenkette des `New Chat`-Knopfes ist byte-identisch zu der
 *          der inaktiven Zeilen — die primaere Aktion des Bereichs steht
 *          optisch unter der Auswahl."
 *   D-S04  „Der dritte Modus-Reiter ist ein Radio-Icon; das Wort `Remote`
 *          steht nur in `title` und `aria-label`."
 *   KF-8   „Ein Tastaturnutzer kann jeden Chat umbenennen und loeschen, aber
 *          keinen oeffnen."
 *
 * ── Was am laufenden Fenster gemessen wurde ──
 *
 * Dev-Server auf Port 5273, Chromium 1280x720, Sidebar 250 CSS-px, Inter,
 * --ui-scale 1,15. Breiten in GERENDERTEN px.
 *
 *   Reiterleiste innen                        264,50
 *   davon zwei Abstaende (2 x 2,5 CSS-px)       5,75
 *   bleibt fuer drei Reiter                   258,75
 *
 *   Reiterbreiten ohne `min-w-0`   82,64 / 82,64 / 93,47
 *   Reiterbreiten mit  `min-w-0`   86,25 / 86,25 / 86,25
 *
 * 86,25 ist das Mass, das alle drei schon vor D-S04 hatten: solange der
 * dritte Reiter nur ein Icon trug, lag jeder Inhalt unter dem freien Mass von
 * `flex-1`. Ein Wort, das laenger ist als „Chat"/„Code", kippt das — die
 * Vorgabe `min-width: auto` laesst ein Flex-Kind nicht unter seine
 * Inhaltsbreite. Deshalb traegt JEDER der drei Reiter `min-w-0`, und deshalb
 * ist D-S04 eine reine Beschriftung ohne Nebenwirkung auf das Raster.
 * Es klemmt dabei nichts: der Span steht auf seiner natuerlichen Breite
 * (50,08 px, Schrumpfung 0), einzeilig (20,69 px hoch), und der Reiter meldet
 * `scrollWidth` 73 = `clientWidth` 73.
 *
 * Und die Tab-Reihenfolge ab dem Suchfeld, gemessen ueber
 * `document.activeElement` (der e2e-Fall in `chat-delete-discoverable.spec.ts`
 * misst dieselbe Kette bei jedem Lauf nach):
 *
 *   vorher   Rename chat, Delete chat, Rename chat, Delete chat, New Chat
 *   nachher  New Chat (Zeile), Rename chat, Delete chat,
 *            first chat (Zeile), Rename chat, Delete chat, New Chat (Knopf)
 *
 * Run: npx vitest run src/components/layout/__tests__/die-spalte-zeigt-ihre-primaeraktion.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf-8')

/** Ohne Kommentare — die Kommentare NENNEN die alten Klassen, und das sollen
 *  sie auch. Ein Test, der sie mitliest, prueft Prosa statt Code. */
const SIDEBAR = read('components', 'layout', 'Sidebar.tsx')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
const CSS = read('index.css')

const between = (from: string, to: string) => {
  const a = SIDEBAR.indexOf(from)
  const b = SIDEBAR.indexOf(to, a)
  expect(a, `Marker fehlt: ${from}`).toBeGreaterThan(-1)
  expect(b, `Marker fehlt: ${to}`).toBeGreaterThan(a)
  return SIDEBAR.slice(a, b)
}

/** Die Reiterzeile ganz oben. */
const TABS = between('gap-[2.5px] px-2.5 pt-2.5 pb-1.25', 'isRemoteMode && remoteEnabled && dispatchedConversationId')
/** Die Chatzeile: von `filtered.map` bis zum leeren Zustand darunter. */
const ROW = between('filtered.map(', 'filtered.length === 0')
/** Der Fuss mit der Primaeraktion. */
const FOOT = between('px-2.5 pb-2.5 pt-1.25 border-t', '{rowMenu && (')

/** Die Klassenkette des `New Chat`-Knopfes, so wie sie im Quelltext steht. */
const neuChatKette = () => {
  const i = FOOT.indexOf('onClick={handleNewChat}')
  expect(i, 'der New-Chat-Knopf ist nicht mehr auffindbar').toBeGreaterThan(-1)
  const m = FOOT.slice(i).match(/className="([^"]+)"/)
  expect(m, 'der New-Chat-Knopf hat keine feste Klassenkette mehr').not.toBeNull()
  return m![1]
}

/** Die drei Klassenketten der Reiter, jeweils nur ihr STATISCHER Teil —
 *  also alles vor dem `${`, das den Aktiv-/Ruhezustand einsetzt. */
const reiterKetten = () =>
  [...TABS.matchAll(/className=\{`([^`$]*)\$\{/g)].map((m) => m[1].trim())

describe('D-S03: die Primaeraktion wiegt mehr als die Auswahl', () => {
  it('sie traegt das EINE Primaer-Rezept des Hauses', () => {
    expect(neuChatKette().split(/\s+/)).toContain('lu-primary')
  })

  it('und zwar das vorhandene — `.lu-primary` faerbt weiter aus dem Token', () => {
    // Kein neues Rezept, keine neue Farbe: der Beweis liegt in index.css.
    const block = CSS.match(/^\.lu-primary\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(block).toContain('background-color: var(--color-lu-accent)')
    expect(block).toContain('color: var(--color-lu-on-accent)')
    // Und im Fuss steht dafuer kein einziges Farbliteral.
    expect(FOOT).not.toMatch(/(?<![\w-])(?:[a-z-]+:)*bg-\[#[0-9a-fA-F]{3,8}\]/)
  })

  it('die neutrale Haut der Liste ist weg, nicht ueberschrieben', () => {
    // Genau die Klassen, mit denen der Knopf wie eine Zeile aussah. Der
    // Ruhezustand `bg-gray-50 dark:bg-white/[0.03]` war blasser als der
    // HOVER-Zustand jeder Zeile und blasser als die AKTIVE Zeile.
    const kette = neuChatKette()
    for (const tot of ['bg-gray-50', 'dark:bg-white/[0.03]', 'text-gray-800', 'dark:text-gray-200', 'border-gray-200']) {
      expect(kette, `die neutrale Haut ist zurueck: ${tot}`).not.toContain(tot)
    }
    // `font-medium` waere eine zweite Quelle fuer dieselbe Aussage —
    // `.lu-primary` setzt `font-weight: 500` selbst.
    expect(kette.split(/\s+/)).not.toContain('font-medium')
  })

  it('die beiden Klassenketten sind nicht laenger dieselbe', () => {
    // Der Befund war „byte-identisch". Also wird byteweise verglichen — und
    // zwar gegen BEIDE Zustaende der Zeile, nicht nur den inaktiven.
    const kette = neuChatKette()
    const zeile = ROW.match(/className=\{`(group flex items-center[^`]*)`\}/)?.[1] ?? ''
    expect(zeile, 'die Chatzeile ist nicht mehr auffindbar').not.toBe('')
    expect(kette).not.toBe(zeile)

    // Schaerfer als Ungleichheit: die Flaechen duerfen sich nicht mehr
    // ueberschneiden. Sonst waere „anders" schon durch ein Leerzeichen erfuellt.
    const flaechen = (s: string) => new Set(
      (s.match(/(?<![\w-])(?:dark:)?bg-[\w[\]/.#-]+/g) ?? []).filter((c) => !c.includes('hover')),
    )
    const gemeinsam = [...flaechen(kette)].filter((c) => flaechen(zeile).has(c))
    expect(gemeinsam, 'Knopf und Zeile teilen sich wieder eine Flaeche').toEqual([])
  })

  it('die Geometrie bleibt, wo D-S17 sie hingestellt hat', () => {
    // `--control-h-lg` heisst in index.css „primary Create button". Das
    // Rezept `.lu-control` waere hier falsch: es setzt `--control-h-sm`
    // (26 px), das Mass der Composer-Werkzeugleiste.
    const kette = neuChatKette()
    expect(kette).toContain('h-[var(--control-h-lg)]')
    expect(kette).toContain('rounded-[8px]')
    expect(kette.split(/\s+/)).not.toContain('lu-control')
    expect(SIDEBAR).not.toMatch(/--control-h-sm/)
  })
})

describe('D-S04: der dritte Reiter traegt sein Wort sichtbar', () => {
  it('alle drei Reiter tragen eine sichtbare Beschriftung', () => {
    const woerter = [...TABS.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1])
    expect(woerter).toEqual(['Chat', 'Code', 'Remote'])
  })

  it('kein Sonderfall: die drei Klassenketten sind Zeichen fuer Zeichen dieselbe', () => {
    // Dem Remote-Reiter fehlten der Abstand zwischen Icon und Wort und die
    // Schriftgroesse — er war auch in der Kette ein Sonderfall, nicht nur in
    // der Beschriftung.
    const ketten = reiterKetten()
    expect(ketten).toHaveLength(3)
    expect(new Set(ketten).size, `drei Ketten, ${new Set(ketten).size} Varianten`).toBe(1)
  })

  it('die Schriftgroesse steht einmal am Behaelter, nicht dreimal darin', () => {
    // Sie war an allen dreien dieselbe Aussage. Ein Elternteil, das die Typo
    // seiner Kinder setzt, ist die kuerzere Stelle — und eine Fundstelle
    // statt drei in dem Zaehler, der die arbitraeren Groessen deckelt.
    const kopf = TABS.slice(0, TABS.indexOf('<button'))
    expect(kopf).toMatch(/(?<![\w-])text-\[12px\]/)
    for (const kette of reiterKetten()) {
      expect(kette).not.toMatch(/(?<![\w-])text-\[/)
    }
  })

  it('und dieselbe Icon-Groesse — vorher 11 / 11 / 14', () => {
    const groessen = [...TABS.matchAll(/<(?:MessageSquare|Code|Radio) size=\{(\d+)\}/g)].map((m) => m[1])
    expect(groessen).toEqual(['11', '11', '11'])
  })

  it('`min-w-0` an allen dreien — sonst nimmt das laengere Wort Platz weg', () => {
    // Gemessen: ohne die Klasse 82,64/82,64/93,47 gerenderte px, mit ihr
    // 86,25/86,25/86,25 — und 86,25 ist das Mass, das vor D-S04 galt.
    expect([...TABS.matchAll(/(?<![\w-])min-w-0(?![\w-])/g)]).toHaveLength(3)
  })

  it('keine Abkuerzung erfunden — der Platz reicht gemessen', () => {
    // `scrollWidth` 73 = `clientWidth` 73, Span auf natuerlicher Breite.
    expect(TABS).not.toMatch(/(?<![\w-])truncate(?![\w-])/)
    expect(TABS).not.toContain('Rmt')
  })

  it('die Hoehenstufe der Reiter ist unangetastet geblieben', () => {
    // D-S17 hat alle drei auf `--control-h-md` gestellt. Diese Aenderung
    // fasst die Hoehe nicht an.
    expect([...TABS.matchAll(/h-\[var\(--control-h-md\)\]/g)]).toHaveLength(3)
    expect(TABS).not.toMatch(/(?<![\w-])h-\[\d+px\]/)
  })
})

describe('KF-8: die Zeile ist eine Auswahl, und sie steht im Weg der Tastatur', () => {
  it('die Liste ist eine Liste, und die Zeile eine Option darin', () => {
    expect(SIDEBAR).toContain('role="listbox"')
    expect(SIDEBAR).toContain('aria-label="Conversations"')
    expect(ROW).toContain('role="option"')
    // `aria-selected` sagt endlich maschinenlesbar, welche Zeile aktiv ist —
    // vorher war das ausschliesslich eine Hintergrundfarbe.
    expect(ROW).toMatch(/aria-selected=\{conv\.id === activeConversationId\}/)
  })

  it('und sie ist ein echter `<button>`, kein `<div tabIndex>`', () => {
    // Vom Element kommen Tab-Stop, Enter UND Leertaste ohne eine Zeile
    // Tastatur-Code. Ein `<div>` haette beide Tasten selbst nachbauen muessen
    // — und die Leertaste scrollt, wenn niemand sie abfaengt.
    const ab = ROW.indexOf('role="option"')
    expect(ROW.slice(ab - 120, ab)).toContain('<button')
    // Der Attributkopf der Option, bis zu ihrem ersten Kind.
    const kopf = ROW.slice(ab, ROW.indexOf('>', ROW.indexOf('className', ab)))
    expect(kopf).not.toMatch(/tabIndex/)
    expect(kopf).not.toMatch(/onKeyDown/)
    // Das eine `onKeyDown` der Zeile gehoert dem Umbenennen-Feld und bleibt.
    expect([...ROW.matchAll(/onKeyDown=/g)]).toHaveLength(1)
  })

  it('die Zeile traegt NICHT `role="button"` — das waere die Falle gewesen', () => {
    // Ein frischer Chat heisst woertlich „New Chat" (chatStore), also traegt
    // die Zeile denselben zugaenglichen Namen wie die Primaeraktion am Fuss.
    // Mit `role="button"` haette jeder `getByRole('button', { name:
    // /New Chat/i })` zwei Treffer — auch der in `e2e/support/ui.ts`.
    expect(ROW).not.toContain('role="button"')
    expect(read('stores', 'chatStore.ts')).toContain("title = 'New Chat'")
  })

  it('die Aktionsknoepfe sind GESCHWISTER der Option, nicht ihre Kinder', () => {
    // `<button>` in `<button>` ist ungueltiges HTML, und der Browser zerlegt
    // es. Die Option muss also zu sein, bevor die Leiste aufgeht.
    const optAb = ROW.indexOf('role="option"')
    const zu = ROW.indexOf('</button>', optAb)
    const leiste = ROW.indexOf('title="Rename chat"')
    expect(zu, 'die Option wird nicht geschlossen').toBeGreaterThan(optAb)
    expect(leiste, 'die Aktionsleiste liegt IN der Option').toBeGreaterThan(zu)
  })

  it('der Fokus auf der Zeile tut, was das Ueberfahren tut', () => {
    // Der Datums-Span weicht auf `group-focus-within`. Ohne die
    // `group-`Zwillinge an der Leiste haette Tab auf die Zeile das Datum
    // ausgeblendet und nichts an seine Stelle gesetzt — der Fokus sitzt dann
    // im GESCHWISTER, wo das blosse `focus-within` ihn nicht sieht.
    const strip = ROW.slice(ROW.indexOf('absolute right-0'))
    expect(strip).toMatch(/group-focus-within:opacity-100/)
    expect(strip).toMatch(/group-focus-within:pointer-events-auto/)
    // Und die beiden alten bleiben: sie gelten, wenn der Fokus IN der Leiste
    // steht, und nur sie halten sie dann offen.
    expect(strip).toMatch(/(?<!group-)focus-within:opacity-100/)
    expect(strip).toMatch(/(?<!group-)focus-within:pointer-events-auto/)
  })

  it('der Klick zaehlt einmal — er sitzt an der Option, nicht mehr an der Zeile', () => {
    const zeile = ROW.slice(0, ROW.indexOf('role="option"'))
    expect(zeile).not.toMatch(/onClick=\{\(\) => \{\s*setActiveConversation/)
    expect(ROW).toMatch(/role="option"[\s\S]{0,200}onClick=\{\(\) => \{\s*setActiveConversation\(conv\.id\)/)
    // Der Rechtsklick bleibt an der ZEILE — er soll ueber der ganzen Zeile
    // aufgehen, auch ueber den Knoepfen, die keine Kinder der Option sind.
    expect(zeile).toContain('onContextMenu')
  })
})
