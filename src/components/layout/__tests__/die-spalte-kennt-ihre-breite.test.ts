/**
 * Die Sidebar misst, statt zu raten — D-S14, D-S15, D-S17 (und der
 * abgelehnte D-S49).
 *
 *   D-S14  „Doppelte Kuerzung: `truncate(conv.title, 30)` UND CSS-`truncate`
 *          an derselben Stelle."
 *   D-S15  „Hover-Icons behalten ihren Layoutplatz (`opacity-0
 *          group-hover:opacity-100`, ohne `absolute`/`hidden`) — ~55px
 *          Titelbreite dauerhaft."
 *   D-S17  „Vier Control-Hoehen auf 250px Breite, kein `--control-h-*`."
 *   D-S49  „Kein einziger Schriftgroessen-Breakpoint (app-weit 0 Treffer fuer
 *          `(sm|md|lg|xl|2xl):text-`)."  -> BEGRUENDET ABGELEHNT, siehe unten.
 *
 * ── Was am laufenden Fenster gemessen wurde ──
 *
 * Eigener Dev-Server auf Port 5311 (vorher, `git archive` von b3f0f786) und
 * 5312 (nachher), Chromium 900x900, Inter. Rendermasse in gerenderten px
 * (--ui-scale 1,15), Hoehen ueber `offsetHeight`, also in CSS-px des
 * unskalierten Entwurfsrasters:
 *
 *                                   vorher      nachher
 *   Titelbox der Chatzeile          118,02 px   180,67 px   (+53 %)
 *   Zeichen, die hineinpassen       14          22          (+57 %)
 *   Aktionsleiste im Fluss          62,66 px    0 px
 *   Zeilenhoehe (Ruhe/Hover/Fokus)  36 px       32 px  (konstant in allen 3)
 *   Reiter Chat / Code / Remote     30/30/26    32/32/32
 *   Suchfeld                        31          32
 *   Dispatch / New Chat             36          40
 *   LAN / Internet                  33          40
 *   Zeilen bis die Spalte voll ist  15          17
 *
 * Und die Eigenschaft, die diese Datei NICHT sehen kann, aber der Grund fuer
 * `pointer-events-none` ist: `document.elementFromPoint` 12 px vom rechten
 * Rand einer NICHT ueberfahrenen Zeile lieferte vorher „Delete chat", nachher
 * die Zeile selbst.
 *
 * ── Warum die Sidebar der andere Fall ist als D-S07 ──
 *
 * In `chat/MessageBubble.tsx` ist bei D-S07 ausdruecklich die umgekehrte
 * Entscheidung getroffen worden: dort BEHAELT die Leiste ihren Platz. Der
 * Unterschied ist die Achse — dort belegt sie Hoehe unter einer Nachricht in
 * einem scrollenden Protokoll, hier Breite in einer Zeile fester Hoehe.
 * Dieser Test haelt beide Seiten fest, damit die zwei Dateien nicht
 * unbemerkt aufeinander zulaufen.
 *
 * Run: npx vitest run src/components/layout/__tests__/die-spalte-kennt-ihre-breite.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..', '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf-8')

const RAW = read('components', 'layout', 'Sidebar.tsx')
/** Ohne Kommentare — die Kommentare NENNEN die alten Werte, und das sollen
 *  sie auch. Ein Test, der sie mitliest, prueft Prosa statt Code. */
const SIDEBAR = RAW
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
const BUBBLE = read('components', 'chat', 'MessageBubble.tsx')
const CSS = read('index.css')

/** Der Abschnitt zwischen zwei Markern im Code. */
const between = (from: string, to: string) => {
  const a = SIDEBAR.indexOf(from)
  const b = SIDEBAR.indexOf(to, a)
  expect(a, `Marker fehlt: ${from}`).toBeGreaterThan(-1)
  expect(b, `Marker fehlt: ${to}`).toBeGreaterThan(a)
  return SIDEBAR.slice(a, b)
}

/** Die Chatzeile: von `filtered.map` bis zum leeren Zustand darunter. */
const ROW = between('filtered.map(', 'filtered.length === 0')
/** Die Reiterzeile ganz oben. */
const TABS = between('gap-[2.5px] px-2.5 pt-2.5 pb-1.25', 'isRemoteMode && remoteEnabled && dispatchedConversationId')
/** Das Suchfeld. */
const SEARCH = between('placeholder="Search..."', 'flex-1 overflow-y-auto')
/** Der Fuss mit der Primaeraktion. */
const FOOT = between('px-2.5 pb-2.5 pt-1.25 border-t', '{rowMenu && (')

describe('D-S14: eine Kuerzung, und zwar die, die die Spalte kennt', () => {
  it('die JS-Kuerzung ist weg — samt Import', () => {
    // Sie hat in dieser Sidebar nie ein Zeichen entfernt: 30 Zeichen brauchen
    // 229,27 gerenderte px, die Titelbox hatte 118,02 und hat jetzt 180,67.
    expect(ROW).not.toMatch(/truncate\(\s*conv\.title/)
    expect(SIDEBAR).not.toMatch(/import\s*\{\s*truncate\s*\}/)
    expect(SIDEBAR).not.toContain("from '../../lib/formatters'")
  })

  it('die CSS-Kuerzung ist geblieben — sie ist die messende', () => {
    expect(ROW).toMatch(/<p className="text-\[13px\] truncate flex-1 min-w-0"/)
  })

  it('und der volle Titel steht jetzt im DOM, also auch im Tooltip', () => {
    // `truncate(t, 30)` schrieb drei echte Punkte IN den Text; Kopieren,
    // Vorlesen und `title=` haetten den beschnittenen String bekommen.
    expect(ROW).toMatch(/title=\{conv\.title\}>\{conv\.title\}<\/p>/)
  })
})

describe('D-S15: die Aktionsleiste gibt ihren Layoutplatz her', () => {
  it('sie liegt ausserhalb des Flusses statt 62,66 px zu belegen', () => {
    expect(ROW).toMatch(/absolute right-0 top-1\/2 -translate-y-1\/2/)
  })

  it('`absolute` und NICHT `hidden` — sonst waere sie tastaturlos', () => {
    // `display: none` ist nicht fokussierbar. Das Kontextmenue der Zeile
    // haengt an `onContextMenu`, ist also ebenfalls nur mit Zeiger zu
    // oeffnen — mit `hidden` gaebe es KEINEN Weg mehr zu Umbenennen/Loeschen.
    const strip = ROW.slice(ROW.indexOf('absolute right-0'))
    expect(strip.slice(0, 400)).not.toMatch(/\bhidden\b/)
    expect(strip).toMatch(/group-hover:opacity-100/)
    expect(strip).toMatch(/focus-within:opacity-100/)
  })

  it('unsichtbar heisst auch: faengt keine Klicks ab', () => {
    // Gemessen am HEAD: `elementFromPoint` 12 px vom rechten Rand einer nicht
    // ueberfahrenen Zeile lieferte „Delete chat". Eine Leiste, die jetzt UEBER
    // Datum und Titelende liegt, darf das erst recht nicht.
    expect(ROW).toMatch(/pointer-events-none/)
    expect(ROW).toMatch(/group-hover:pointer-events-auto/)
    expect(ROW).toMatch(/focus-within:pointer-events-auto/)
  })

  it('das Datum weicht, wenn die Leiste kommt — mit `group-`Praefix', () => {
    // Ohne das lagen 62,66 px Icons ueber 49,33 px Datumstext. Und ohne das
    // `group-` sieht der Datums-Span den Fokus nicht: der sitzt im Geschwister.
    expect(ROW).toMatch(/group-hover:opacity-0 group-focus-within:opacity-0/)
  })

  it('die eine Ausnahme ist benannt und an EINER Bedingung aufgehaengt', () => {
    // Auf der abgesetzten Remote-Zeile steht der QR-Knopf im Fluss und ist der
    // dokumentierte Weg zurueck zum QR-Blatt (Bug #16) — eine daruebergelegte
    // Leiste wuerde ihn beim Ueberfahren verdecken.
    expect(SIDEBAR).toMatch(
      /const qrMarker = isRemoteMode && conv\.id === dispatchedConversationId && remoteEnabled/,
    )
    expect(ROW).toMatch(/\$\{qrMarker \? '' : 'absolute right-0/)
    // Und die Bedingung steht genau einmal ausgeschrieben, nicht dreimal.
    expect([...SIDEBAR.matchAll(/conv\.id === dispatchedConversationId/g)]).toHaveLength(1)
  })

  it('die Zeilenhoehe steht fest — sonst waere `absolute` gefaehrlich', () => {
    // Vorher bestimmten die 26 px hohen Hover-Knoepfe plus py-1.25 die Hoehe.
    // Faellt die Leiste aus dem Fluss, ohne dass die Hoehe gesetzt ist, springt
    // die Liste unter dem Zeiger — genau der Fall, wegen dem D-S07 anders
    // entschieden hat.
    expect(ROW).toMatch(/group flex items-center gap-\[7\.5px\] px-2\.5 h-\[var\(--control-h-md\)\]/)
    expect(ROW).not.toMatch(/group flex items-center gap-\[7\.5px\] px-2\.5 py-/)
  })

  it('MessageBubble hat die UMGEKEHRTE Entscheidung, und behaelt sie', () => {
    // Dort belegt die Leiste Hoehe unter einer Nachricht in einem scrollenden
    // Protokoll. Faellt sie aus dem Fluss, ruecken alle folgenden Nachrichten
    // nach oben, waehrend der Zeiger darauf steht. Hier belegt sie Breite in
    // einer Zeile fester Hoehe. Wer die beiden angleicht, faellt hier durch.
    const vis = BUBBLE.slice(BUBBLE.indexOf('const actionBarVisibility'))
    expect(vis.slice(0, 300)).toMatch(/opacity-0 group-hover:opacity-100 group-focus-within:opacity-100/)
    expect(vis.slice(0, 300)).not.toMatch(/\babsolute\b|\bhidden\b/)
  })
})

describe('D-S17: die Hoehen kommen aus der Leiter, nicht aus dem Padding', () => {
  it('die Leiter hat drei Stufen, und es sind weiter drei', () => {
    const stufen = [...CSS.matchAll(/--control-h-([a-z]+):\s*(\d+)px/g)].map((m) => [m[1], m[2]])
    expect(stufen).toEqual([['sm', '26'], ['md', '32'], ['lg', '40']])
  })

  it('die Sidebar benutzt nur Namen von dieser Leiter', () => {
    const benutzt = [...SIDEBAR.matchAll(/var\(--control-h-([a-z]+)\)/g)].map((m) => m[1])
    expect(benutzt.length).toBeGreaterThan(0)
    expect([...new Set(benutzt)].sort()).toEqual(['lg', 'md'])
  })

  it('alle drei Reiter tragen dieselbe Stufe — vorher 30/30/26', () => {
    const reiter = [...TABS.matchAll(/h-\[var\(--control-h-md\)\]/g)]
    expect(reiter).toHaveLength(3)
    expect(TABS).not.toMatch(/py-1\.25 rounded-\[5px\]/)
  })

  it('das Suchfeld traegt sie auch — vorher 31', () => {
    expect(SEARCH).toMatch(/h-\[var\(--control-h-md\)\] rounded-\[8px\]/)
    expect(SEARCH).not.toMatch(/pr-2\.5 py-1\.25/)
  })

  it('die Primaeraktion am Fuss traegt die grosse Stufe, und nur sie', () => {
    // --control-h-lg heisst in index.css ausdruecklich „primary Create
    // button". New Chat, Dispatch und der LAN/Internet-Waehler stehen in
    // genau diesem Slot: drei Knoepfe, eine Rolle.
    expect([...FOOT.matchAll(/h-\[var\(--control-h-lg\)\]/g)]).toHaveLength(4)
    expect(FOOT).not.toMatch(/py-\[7\.5px\] rounded-\[8px\]/)
    // Und `lg` kommt sonst nirgends in der Datei vor.
    expect([...SIDEBAR.matchAll(/--control-h-lg/g)]).toHaveLength(4)
  })

  it('keine rohe Hoehe mehr an den sieben Controls', () => {
    // `sm` (26) kommt in dieser Spalte NICHT vor: das ist das Mass der
    // Composer-Werkzeugleiste (`.lu-control`). Dass der Remote-Reiter
    // zufaellig schon auf 26 stand, war kein Argument — ihm fehlte nur der
    // Textspan.
    expect(SIDEBAR).not.toMatch(/--control-h-sm/)
    for (const teil of [TABS, SEARCH, FOOT]) {
      expect(teil).not.toMatch(/\bh-\[\d+px\]/)
    }
  })
})

describe('D-S49: abgelehnt — es gibt EINEN Massstab, und Breakpoints sind keiner', () => {
  /**
   * Der Befund stimmt als Zaehlung und faellt als Auftrag durch:
   *
   *   Layout-Breakpoints hat die App (38 Stueck, `hidden lg:flex` in der
   *   Kopfzeile und Rasterspalten). Die beantworten „passt es noch", also
   *   eine Ja/Nein-Frage.
   *
   *   Schriftgroessen-Breakpoints beantworten „wie gross", und diese Frage
   *   beantwortet seit c7076fca `--ui-scale` an einer Stelle: 16px Wurzel und
   *   `zoom: var(--ui-scale)` auf `#root`. Ein `md:text-[15px]` LAEGE INNERHALB
   *   dieses zoom, wuerde also mitskaliert — die App haette zwei Regler, und
   *   der Nutzer saehe ihr Produkt.
   *
   *   Dazu messen die beiden in verschiedenen Einheiten. Gemessen am HEAD
   *   (Chromium, Fenster 900 px): `window.innerWidth` = 900 und
   *   `matchMedia('(min-width: 768px)')` trifft zu — waehrend ein
   *   `position: fixed; inset: 0`-Kasten INNERHALB von #root 783 CSS-px breit
   *   ist (900 / 1,15). Der `md:`-Schalter feuert also bei 783 px Layout, nicht
   *   bei 768, und der Versatz ist genau --ui-scale. Wer den Regler dreht,
   *   verschiebt jeden Schriftgroessen-Breakpoint mit.
   *
   * Deshalb bleibt es bei null — und dieser Test ist die Wache dafuer, nicht
   * der Beweis einer Aenderung. Er wurde absichtlich rot gemacht (ein
   * `md:text-[15px]` in Sidebar.tsx), um zu zeigen, dass er zubeissen kann.
   */
  const tsxFiles = (dir: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__') continue
      const p = resolve(dir, e.name)
      if (e.isDirectory()) out.push(...tsxFiles(p))
      else if (e.name.endsWith('.tsx')) out.push(p)
    }
    return out
  }

  it('null Schriftgroessen-Breakpoints, app-weit', () => {
    const treffer: string[] = []
    for (const f of tsxFiles(resolve(SRC, 'components'))) {
      const s = readFileSync(f, 'utf-8')
      for (const m of s.matchAll(/(?:^|[\s"'`])((?:sm|md|lg|xl|2xl):text-[^\s"'`]+)/g)) {
        treffer.push(`${f.slice(SRC.length + 1)}: ${m[1]}`)
      }
    }
    expect(treffer).toEqual([])
  })

  it('der eine Massstab steht weiter an genau einer Stelle', () => {
    expect(CSS).toMatch(/--ui-scale:\s*1\.15/)
    expect([...CSS.matchAll(/zoom:\s*var\(--ui-scale\)/g)]).toHaveLength(1)
    // Und die Sidebar hat keinen eigenen mehr (D-A3 / D-S46).
    expect(SIDEBAR).not.toMatch(/zoom/)
  })
})
