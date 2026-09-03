/**
 * Die Chatspalte laesst sich breiter ziehen — D1, zweite Haelfte.
 *
 * ── DER BEFUND ─────────────────────────────────────────────────────────────
 *
 * David am 02.09.2026: "Der left Sidepanel bei Chat Agent und Code ist
 * Textmaessig als Sessionname und Datum nicht sauber bis zum Ende durchgezogen
 * bzw dynamisch mit vergroesserung anpassend."
 *
 * Zwei Haelften, und die erste war schon behoben: die Zeile schrieb frueher
 * `truncate(conv.title, 30)`, also einen harten Schnitt bei 30 Zeichen MIT
 * echten Punkten im DOM, und darueber lief zusaetzlich der CSS-Schnitt. Seit
 * dem Design-Strang steht dort der volle Titel und `text-overflow: ellipsis`
 * misst. Am laufenden Fenster nachgemessen (02.09.2026, Port 5273,
 * --ui-scale 1,15):
 *
 *   Titelkasten                169,0 px
 *   Inhalt "Call delegate_…"   307,0 px   → CSS kuerzt, Punkte NICHT im Text
 *   `title`-Attribut           identisch zum vollen Titel
 *
 * ── WAS NOCH FEHLTE ────────────────────────────────────────────────────────
 *
 * Die zweite Haelfte des Satzes — "dynamisch mit vergroesserung anpassend" —
 * konnte gar nicht erfuellt sein: es gab keine Vergroesserung. Die Spalte war
 * auf 250 px festgenagelt (vorher 200), `--ui-scale` skaliert per `zoom` alles
 * gemeinsam und aendert das VERHAELTNIS nicht. Wer einen langen Sitzungsnamen
 * lesen wollte, hatte keinen Weg dazu ausser dem Tooltip.
 *
 * ── DIE MESSUNG, DIE BEIDE HAELFTEN VERBINDET ─────────────────────────────
 *
 * Am laufenden Fenster nachgemessen (02.09.2026, 1280x800, Inter, Titelkasten
 * = Spalte minus ~85 px fuer Polsterung, Datum und Abstand), mit dem
 * Beispieltitel "refactor the auth guard, run the tests and report which specs
 * fail" (66 Zeichen):
 *
 *   Spalte  Kasten   ALT: Zeichen / tote Pixel   NEU: Zeichen / tote Pixel
 *   250 px  165 px      30 / — (CSS schnitt ohnehin nach)     23 /   2
 *   320 px  235 px      30 /  19                              34 /   5
 *   400 px  315 px      30 /  99                              45 /   7
 *   480 px  395 px      30 / 179                              56 /  12
 *
 * Bei der ALTEN festen Breite war der CSS-Schnitt fast kosmetisch: 30 Zeichen
 * plus Punkte sind dort schon breiter als der Kasten, CSS schnitt also ohnehin
 * nach. Er wird erst entscheidend, weil die Spalte jetzt ziehbar ist.
 *
 * Und umgekehrt genauso: eine ziehbare Spalte OHNE den CSS-Schnitt waere
 * wertlos. Bei 480 px stuenden dort weiterhin 30 Zeichen und 179 leere Pixel —
 * fast der halbe Kasten. Die zwei Haelften von Davids Satz sind eine Aenderung,
 * und keine der beiden traegt allein.
 *
 * ── WARUM EIN DRITTEL UND NICHT DIE HAELFTE ────────────────────────────────
 *
 * Explorer und Agenten-Panel klemmen auf das halbe Fenster. Diese Spalte nicht,
 * und der Grund ist ein anderer: die beiden sind ARBEITSFLAECHEN (ein Pfad darf
 * lang sein, eine Agentenzeile auch), diese hier ist NAVIGATION. Eine
 * Navigation, die das halbe Fenster nimmt, hat den Zweck verfehlt, fuer den man
 * sie aufzieht. Dazu eine absolute Decke: ein Sitzungsname braucht nie mehr als
 * 480 px, und auf einem 4K-Schirm waere ein Drittel sonst ueber 1200 px.
 *
 * Lauf: npx vitest run src/stores/__tests__/die-spalte-laesst-sich-ziehen.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  useUIStore,
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from '../uiStore'

const here = dirname(fileURLToPath(import.meta.url))
const lies = (p: string) => readFileSync(resolve(here, '../..', p), 'utf8')

/** Ein Fenster, das gross genug ist, dass die Fensterklemme nicht mitredet. */
const WEIT = 4000

describe('Die Klemme', () => {
  it('haelt den Boden — schmaler wird die Spalte unlesbar', () => {
    expect(clampSidebarWidth(10, WEIT)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(-500, WEIT)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('haelt die absolute Decke, auch auf einem riesigen Schirm', () => {
    // Der Fall, den eine reine Drittel-Regel durchgelassen haette: auf 4000 px
    // waere ein Drittel 1333 px Navigationsspalte.
    expect(clampSidebarWidth(9999, WEIT)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('nimmt nie mehr als ein Drittel des Fensters', () => {
    // 900 px Fenster → 300 px erlaubt, obwohl die absolute Decke hoeher liegt.
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH, 900)).toBe(300)
  })

  it('der Boden gewinnt gegen das Drittel, nicht umgekehrt', () => {
    // In einem sehr schmalen Fenster waere ein Drittel unter dem Boden. Dann
    // muss der Boden stehen, sonst faellt die Spalte auf null zusammen und die
    // Zeilen sind gar nicht mehr lesbar.
    expect(clampSidebarWidth(250, 400)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('faengt Unsinn ab, statt ihn zu speichern', () => {
    expect(clampSidebarWidth(NaN, WEIT)).toBe(SIDEBAR_DEFAULT_WIDTH)
    // Infinity faellt in DIESELBE Wache wie NaN und liefert die Vorgabe, nicht
    // die Decke. Ich hatte hier zuerst die Decke erwartet — falsch, und zwar
    // aus einem Grund, der es wert ist zu stehen: `Number.isFinite(Infinity)`
    // ist false. Explorer und Agenten-Panel machen es genauso; eine dritte
    // Auslegung derselben Frage waere schlimmer als die strengere Antwort.
    expect(clampSidebarWidth(Infinity, WEIT)).toBe(SIDEBAR_DEFAULT_WIDTH)
    // Eine Fensterbreite, die es noch nicht gibt (Messung vor dem ersten
    // Anstrich), darf die Spalte nicht auf den Boden zwingen.
    expect(clampSidebarWidth(300, NaN)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('rundet auf ganze Pixel', () => {
    expect(Number.isInteger(clampSidebarWidth(287.4, WEIT))).toBe(true)
  })
})

describe('Der Store', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH })
  })

  it('startet auf der Vorgabebreite', () => {
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('nimmt eine gezogene Breite an — geklemmt', () => {
    useUIStore.getState().setSidebarWidth(360, WEIT)
    expect(useUIStore.getState().sidebarWidth).toBe(360)
    useUIStore.getState().setSidebarWidth(9999, WEIT)
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('die Breite ueberlebt einen Neustart', () => {
    // Ohne den Eintrag in `partialize` waere jede Ziehbewegung beim naechsten
    // Start vergessen — der haeufigste Weg, so eine Funktion nutzlos zu machen.
    expect(lies('stores/uiStore.ts')).toMatch(/partialize[\s\S]{0,900}sidebarWidth/)
  })
})

describe('Die Spalte benutzt die Breite wirklich', () => {
  // Quellwaechter, weil vitest hier nur .test.ts einsammelt: eine .tsx wird
  // nie gerendert, also kann kein Test die gezogene Spalte SEHEN. Diese drei
  // Zusicherungen sind das Naechstbeste — sie halten fest, dass die Komponente
  // an der Breite haengt und nicht an einer Zahl im Klassennamen.
  const quelle = () => lies('components/layout/Sidebar.tsx')

  it('die feste Breite im Klassennamen ist weg', () => {
    expect(quelle()).not.toContain('w-[250px]')
  })

  it('die Spalte liest die Breite aus dem Store', () => {
    expect(quelle()).toMatch(/sidebarWidth/)
  })

  it('es gibt einen Ziehgriff, und er ist im e2e adressierbar', () => {
    expect(quelle()).toContain('data-testid="sidebar-resize-handle"')
    expect(quelle()).toContain('cursor-col-resize')
  })
})
