/**
 * D-S18, zweiter Durchgang: warum ZWEI die richtige Zahl ist.
 *
 * Der Befund hiess „Drei Baender vor dem ersten Inhalt": Titlebar (h-8),
 * Header (h-10) und die Sitzungsleiste. Das dritte ist mit `b3f0f786` unter
 * das Transkript gezogen — nichts darin gehoerte zur naechsten Nachricht.
 * Offen blieb laut Matrix der Schritt von 2 auf 1.
 *
 * ── Die Messung, die die Frage beantwortet ────────────────────────────────
 *
 * Am 01.09.2026 am laufenden Dev-Server (Port 5273, Chromium, --ui-scale
 * 1.15), Farben aus `getComputedStyle` und ueber eine 1x1-Canvas nach sRGB
 * aufgeloest, Hoehen aus `getBoundingClientRect`:
 *
 *   Fensterrahmen (`#root > div`)   hell #e5e7eb   dunkel #141414
 *   Header  (h-10, 40 CSS-px)       hell #e5e7eb   dunkel #141414
 *   Inhaltspane (`<main>`)          hell #ffffff   dunkel #1e1e1e
 *
 *   Kontrast Header gegen Fensterrahmen: 1.00:1, in BEIDEN Modi.
 *   `border-bottom-width` 0px, `box-shadow` none, an beiden.
 *
 * Und ausserhalb von Tauri (Browser, `window.__TAURI_INTERNALS__` fehlt)
 * rendert die Titlebar `null`: gemessen stand vor dem Inhalt genau EIN
 * Element, der Header.
 *
 * ── Die Entscheidung ──────────────────────────────────────────────────────
 *
 * Zwei bleibt, und zwar nicht aus Vorsicht, sondern weil die Messung sagt,
 * dass es optisch schon eins ist. Titlebar, Header und der Fensterrahmen
 * tragen DIESELBE Flaeche, ohne Kante und ohne Schatten dazwischen. Was ein
 * „Band" zu einem Band macht, ist ein sichtbarer Streifen; hier gibt es
 * einen durchgehenden Fenstergrund, auf dem eine gerundete Pane liegt. Der
 * Schritt von 2 auf 1 waere ein DOM-Schritt ohne Bildschirmwirkung.
 *
 * Was er dagegen kosten wuerde, ist real: Titlebar und Header zu verschmelzen
 * heisst, die Drag-Region, die Hoehenreservierung fuer die nativen
 * macOS-Ampeln und die Windows/Linux-Fensterknoepfe (46x32) in die Kopfzeile
 * zu verlegen — an einem Bauteil, das im Browser gar nicht rendert und
 * deshalb ohne Tauri-Build nicht pruefbar ist. Fensterchrome blind umbauen
 * fuer null gemessene Pixel ist kein Handel, den man macht.
 *
 * ── Was dieser Test bewacht ───────────────────────────────────────────────
 *
 * Genau die Voraussetzung der Entscheidung, nicht die Entscheidung selbst:
 * solange die beiden verbliebenen Streifen EINE Flaeche sind, ist zwei die
 * richtige Zahl. Bekommt einer von ihnen eine eigene Flaeche, eine Kante oder
 * einen Schatten, sind es wieder zwei sichtbare Baender — dann faellt dieser
 * Test, und die Frage ist neu zu stellen, statt still weiterzugelten.
 *
 * Er pinnt deshalb die GLEICHHEIT der Flaechen, nicht ihren Wert: benennt der
 * Token-Durchgang `bg-gray-200` in ein Token um, bleibt der Test gruen,
 * solange beide Streifen mitziehen.
 *
 * Titlebar.tsx, Header.tsx und AppShell.tsx gehoeren in diesem Durchgang
 * einem anderen Agenten. Sie werden hier nur GELESEN.
 *
 * Run: npx vitest run src/components/chat/__tests__/zwei-baender-sind-eine-flaeche.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const COMPONENTS = resolve(__dirname, '..', '..')
const read = (rel: string) => readFileSync(resolve(COMPONENTS, rel), 'utf-8')

/** Ohne Kommentare — sonst faerbt eine Begruendung die Negativkontrollen rot. */
const codeOnly = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

const TITLEBAR = codeOnly(read('layout/Titlebar.tsx'))
const HEADER = codeOnly(read('layout/Header.tsx'))
const SHELL = codeOnly(read('layout/AppShell.tsx'))
const VIEW = codeOnly(read('chat/ChatView.tsx'))

/**
 * Die Flaechenklassen eines className-Strings, sortiert und normalisiert.
 * `bg-gray-200 dark:bg-lu-canvas` und `dark:bg-lu-canvas bg-gray-200` sind
 * dieselbe Flaeche; ein zusaetzliches `bg-white/5` waere eine andere.
 */
function flaeche(cls: string): string {
  return (cls.match(/(?:dark:)?bg-[A-Za-z0-9/.[\]#_-]+/g) ?? []).sort().join(' ')
}

/** Die beiden `h-8`-Streifen der Titlebar (mac und Windows/Linux). */
function titlebarStreifen(): string[] {
  return [...TITLEBAR.matchAll(/className="(h-8[^"]*)"/g)].map((m) => m[1])
}

/** Der className-String des ersten Elements, das `marker` enthaelt. */
function classNameMit(src: string, marker: string): string {
  const treffer = [...src.matchAll(/className="([^"]*)"/g)].map((m) => m[1])
  const gefunden = treffer.find((c) => c.includes(marker))
  expect(gefunden, `Kein className mit "${marker}" gefunden`).toBeDefined()
  return gefunden as string
}

describe('D-S18: die zwei verbliebenen Streifen sind EINE Flaeche', () => {
  // 04.09.2026: die Kopfzeile war ein Raster und ist jetzt eine Flex-Zeile
  // mit absolut gesetzter Mitte (das Drehrad muss hart mittig stehen). An
  // der FLAECHE, um die es hier geht, aendert das nichts.
  const headerFlaeche = flaeche(classNameMit(HEADER, 'h-10 flex'))

  it('der Header traegt ueberhaupt eine benannte Flaeche', () => {
    expect(headerFlaeche).not.toBe('')
  })

  it('die Titlebar traegt dieselbe Flaeche — in BEIDEN Fassungen', () => {
    // Zwei Rueckgaben: macOS (leerer Streifen, der die Hoehe fuer die nativen
    // Ampeln reserviert) und Windows/Linux (eigene Fensterknoepfe, weil
    // `decorations: false` den Systembalken ersetzt). Beide sind `h-8`.
    const streifen = titlebarStreifen()
    expect(streifen.length, 'Die beiden Titlebar-Fassungen wurden nicht gefunden').toBe(2)
    for (const s of streifen) expect(flaeche(s)).toBe(headerFlaeche)
  })

  it('und der Fensterrahmen darunter auch — es ist ein Grund, keine Leiter', () => {
    // Gemessen: Kontrast Header gegen Rahmen 1.00:1 in beiden Modi. Genau das
    // steht hier als Quelltextgleichung.
    expect(flaeche(classNameMit(SHELL, 'h-screen w-screen'))).toBe(headerFlaeche)
  })

  it('NEGATIVKONTROLLE: keine Trennkante und kein Schatten zwischen ihnen', () => {
    // Eine Kante oder ein Schatten waere der Strich, der aus einer Flaeche
    // zwei Baender macht — und damit das Argument dieses Befundes zurueck.
    const streifen = [classNameMit(HEADER, 'h-10 flex'), ...titlebarStreifen()]
    for (const s of streifen) {
      expect(s, s).not.toMatch(/\bborder-b\b/)
      expect(s, s).not.toMatch(/\bshadow-/)
      expect(s, s).not.toMatch(/\bdivide-/)
    }
  })

  it('ausserhalb von Tauri ist es ohnehin nur EIN Streifen', () => {
    // Der Grund, warum der Schritt von 2 auf 1 ohne Tauri-Build nicht einmal
    // pruefbar waere: im Browser existiert das zweite Band gar nicht.
    expect(TITLEBAR).toMatch(/if \(!isTauri\) return null/)
  })

  it('und das, was verlegt werden muesste, ist Fensterchrome', () => {
    // Der Preis des letzten Schritts, als Quelltext: eine Drag-Region, ein
    // plattformabhaengiger Zweig und eigene Fensterknoepfe (46x32). Nichts
    // davon ist Layout, alles davon ist Fensterrahmen — und der mac-Zweig ist
    // ein LEERER Streifen, der nur die Hoehe der nativen Ampeln reserviert.
    // Ihn zu verschmelzen hiesse, diese Reservierung in die Kopfzeile zu
    // verlegen.
    expect(TITLEBAR).toContain('data-tauri-drag-region')
    expect(TITLEBAR).toMatch(/isMacOS\(\)/)
    expect(TITLEBAR).toMatch(/w-\[46px\] h-8/)
  })
})

describe('D-S18: das dritte Band bleibt unter dem Transkript', () => {
  it('die Sitzungsleiste steht hinter der Nachrichtenliste', () => {
    const strip = VIEW.indexOf('data-testid="chat-session-strip"')
    const list = VIEW.indexOf('<MessageList')
    const composer = VIEW.indexOf('<ChatInput')
    expect(strip).toBeGreaterThan(-1)
    expect(strip).toBeGreaterThan(list)
    expect(composer).toBeGreaterThan(strip)
  })

  it('und ChatView legt vor dem Transkript nichts Neues davor', () => {
    // Was oberhalb von <MessageList> im Chat-Zweig steht, ist genau ein
    // Element: <PlanBar />. Es rendert `null`, solange es keinen Plan gibt,
    // kostet im Normalfall also kein Band. Jedes weitere Element hier waere
    // ein drittes Band durch die Hintertuer.
    const zweig = VIEW.slice(VIEW.indexOf('key="chat"'), VIEW.indexOf('<MessageList'))
    const elemente = [...zweig.matchAll(/<([A-Z][A-Za-z]*)\b/g)].map((m) => m[1])
    expect(elemente).toEqual(['PlanBar'])
    expect(codeOnly(read('chat/PlanBar.tsx'))).toMatch(/todos\.length === 0\) return null/)
  })
})
