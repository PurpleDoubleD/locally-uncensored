/**
 * Vier Token-Zeilen, die nichts miteinander zu tun haben ausser der Krankheit:
 * D-T08 (zwei Radiussysteme), D-T09 (ein Hellmodus-Schatten im Dunkeln),
 * D-T07 (eine Controlhoehe neben der Leiter), D-T11 (`transition-all`).
 *
 * Sie stehen zusammen, weil jede fuer sich zwei Pruefungen braucht und vier
 * Dateien mit je zwei Pruefungen schwerer zu lesen waeren als eine mit acht.
 *
 * ── D-T08: die Radiusleiter, am 01.09.2026 im Fenster nachgemessen ──
 *
 *     rounded      4px      rounded-lg   8px
 *     rounded-sm   4px      rounded-xl   8px   ← dieselbe Zahl wie lg
 *     rounded-md   6px      rounded-2xl 10px
 *
 * `rounded-lg` und `rounded-xl` waren derselbe Wert. Wer eine Stufe ueber
 * 8px meinte, musste in eckige Klammern: `rounded-[10px]` (3x),
 * `rounded-[8px]` (8x), `rounded-[6px]` (4x), `rounded-[5px]` (20x). Und die
 * sichtbarste Folge stand nebeneinander auf dem Bildschirm: die Hauptpane
 * (`rounded-xl`, 8px) neben der Sidebar (`rounded-[10px]`, 10px) — zwei
 * Flaechen einer Familie mit verschiedenen Ecken, gemessen mit
 * getComputedStyle.
 *
 * Jetzt sind die px-Tokens des Hauses die Quelle und keine zwei Namen
 * teilen sich einen Wert. Nachgemessen nach der Aenderung: Hauptpane 10px,
 * Sidebar 10px.
 *
 * ── D-T09: ein Schatten kann im Dunkeln nichts heben ──
 *
 * Nicht „shadow-sm ist zu schwach eingestellt", sondern: ein Schatten kann
 * nur abdunkeln, ist also nach unten durch Schwarz begrenzt. Diese Datei
 * rechnet die Obergrenze nach.
 *
 * ── Was hier NICHT geprueft werden kann ──
 *
 *   • ob 10px die richtige Ecke ist. Entscheidung, steht im Kommentar.
 *   • ob die Reiter in der Kopfzeile mit 32px besser aussehen. Der Grund
 *     fuer GENAU diese Stufe steht an der Call-Site; hier wird nur
 *     festgenagelt, dass es diese ist und keine andere.
 *   • ob die 42 verbliebenen `transition-all` alle noetig sind. Sie sind
 *     gezaehlt, nicht geprueft; die Analyse steht im Bericht.
 *
 * Run: npx vitest run src/components/__tests__/radius-schatten-hoehe-und-bewegung.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over } from './wcag-contrast'

const ROOT = resolve(__dirname, '..', '..', '..')
const SRC = resolve(ROOT, 'src')
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

// ── Die Radiusleiter, aufgeloest wie der Browser sie aufloest ──────────

/** Das Wurzelmass. Steht in index.css, wird nicht angenommen. */
const WURZEL_PX = Number(CSS_CODE.match(/html\s*\{[^}]*font-size:\s*(\d+)px/)?.[1])

/**
 * Tailwinds eigene Radiusleiter, GELESEN statt angenommen — genauso, wie
 * `icon-leiter.test.ts` lucides Formel aus dem Paket liest. Aendert ein
 * Tailwind-Update die Werkseinstellung, faellt dieser Test und nicht erst
 * der Blick ins Fenster.
 */
function tailwindRadien(): Map<string, string> {
  const theme = readFileSync(resolve(ROOT, 'node_modules', 'tailwindcss', 'theme.css'), 'utf8')
  const m = new Map<string, string>()
  for (const t of theme.matchAll(/--radius-([a-z0-9]+):\s*([^;]+);/g)) m.set(t[1], t[2].trim())
  return m
}

/** Unsere Ueberschreibungen aus dem @theme-Block. */
function hausRadien(): Map<string, string> {
  const block = CSS_CODE.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const m = new Map<string, string>()
  for (const t of block.matchAll(/--radius-([a-z0-9]+):\s*([^;]+);/g)) m.set(t[1], t[2].trim())
  return m
}

/** Die px-Tokens aus dem :root-Block. */
function pxTokens(): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of CSS_CODE.matchAll(/--radius-(control|panel|pill):\s*(\d+)px/g)) {
    m.set(t[1], Number(t[2]))
  }
  return m
}

const PX = pxTokens()

/** `0.5rem` / `10px` / `var(--radius-control)` → Zahl in CSS-Pixeln. */
function aufloesen(wert: string): number {
  const v = wert.trim()
  const varRef = v.match(/^var\(--radius-(control|panel|pill)\)$/)
  if (varRef) {
    const n = PX.get(varRef[1])
    if (n === undefined) throw new Error(`unbekanntes Token: ${v}`)
    return n
  }
  if (v.endsWith('rem')) return parseFloat(v) * WURZEL_PX
  if (v.endsWith('px')) return parseFloat(v)
  throw new Error(`nicht aufloesbar: ${v}`)
}

/** Die Stufen, die die App wirklich schreibt. `rounded-full` ist keine Stufe. */
const GENUTZTE_STUFEN = ['sm', 'md', 'lg', 'xl', '2xl'] as const

function effektiveLeiter(): Map<string, number> {
  const tw = tailwindRadien()
  const haus = hausRadien()
  const out = new Map<string, number>()
  for (const name of GENUTZTE_STUFEN) {
    const roh = haus.get(name) ?? tw.get(name)
    if (roh === undefined) throw new Error(`keine Definition fuer --radius-${name}`)
    out.set(name, aufloesen(roh))
  }
  return out
}

describe('EINE Radiusleiter, und keine zwei Namen auf derselben Zahl', () => {
  it('das Wurzelmass ist 16px — sonst meinen rem und px nicht dasselbe', () => {
    expect(WURZEL_PX).toBe(16)
  })

  it('jede genutzte Stufe hat genau einen Wert, und keine teilt ihn', () => {
    const leiter = effektiveLeiter()
    const werte = [...leiter.values()]
    // DAS war der Befund: lg und xl standen beide auf 8.
    expect(new Set(werte).size, `Kollision in ${JSON.stringify([...leiter])}`).toBe(werte.length)
  })

  it('und die Leiter steigt wirklich — sm < md < lg < xl < 2xl', () => {
    const leiter = effektiveLeiter()
    const werte = GENUTZTE_STUFEN.map((n) => leiter.get(n) as number)
    for (let i = 1; i < werte.length; i++) {
      expect(werte[i], `${GENUTZTE_STUFEN[i]} nicht groesser als ${GENUTZTE_STUFEN[i - 1]}`)
        .toBeGreaterThan(werte[i - 1])
    }
  })

  it('die px-Tokens des Hauses SIND die Leiter, nicht ein zweites System daneben', () => {
    const haus = hausRadien()
    // Nicht „zufaellig derselbe Zahlenwert", sondern woertlich dasselbe Token:
    // wer --radius-control aendert, verschiebt rounded-lg mit.
    expect(haus.get('lg')).toBe('var(--radius-control)')
    expect(haus.get('2xl')).toBe('var(--radius-panel)')
    const leiter = effektiveLeiter()
    expect(leiter.get('lg')).toBe(PX.get('control'))
    expect(leiter.get('2xl')).toBe(PX.get('panel'))
  })

  it('--radius-3xl ist weg, weil es niemand aufruft', () => {
    // Es stand auf 0.75rem, hatte 0 Fundstellen und ergab im Browser als
    // leere Variable 0px — eine Stufe, die beim ersten Gebrauch falsch
    // gewesen waere.
    expect(hausRadien().has('3xl')).toBe(false)
    expect(ALL).not.toMatch(/(?<![\w-])rounded(?:-[a-z]+)?-3xl(?![\w-])/)
  })

  it('die Hauptpane und die Sidebar tragen dieselbe Ecke', () => {
    // Der sichtbare Teil des Befunds. Die Sidebar gehoert in diesem
    // Durchgang einem anderen Agenten, also wird sie hier GELESEN: ihre
    // 10px sind der Massstab, an den die Pane geht.
    const side = DATEIEN.find(([n]) => n === 'components/layout/Sidebar.tsx')?.[1] ?? ''
    expect(side).toContain('rounded-[10px]')
    const shell = DATEIEN.find(([n]) => n === 'components/layout/AppShell.tsx')?.[1] ?? ''
    expect(shell).toMatch(/<main className="[^"]*rounded-xl/)
    expect(effektiveLeiter().get('xl')).toBe(10)
  })
})

// ── D-T09: der Schatten ist ein Hellmodus-Rezept ───────────────────────

describe('ein Schatten kann im Dunkeln nichts heben — die Rechnung', () => {
  /** Tailwinds `shadow-sm`: zwei Lagen a 10 % Schwarz; uebereinander 19 %. */
  const ZWEI_LAGEN = 1 - (1 - 0.1) ** 2

  it('shadow-sm traegt im Hellmodus und traegt im Dunkelmodus nicht', () => {
    const sichtbarkeit = (grund: string, alpha: number) =>
      contrast(over('#000000', grund, alpha), grund)

    // hell: eine echte Stufe
    expect(sichtbarkeit('#ffffff', ZWEI_LAGEN)).toBeGreaterThan(1.5)
    expect(sichtbarkeit('#e5e7eb', ZWEI_LAGEN)).toBeGreaterThan(1.5)

    // dunkel: unter dem, was dieses Haus schon einmal als „Rauschen"
    // verworfen hat (die Pane-Kante im Hellmodus stand bei 1,008:1 und
    // wurde in D-S42 genau deshalb ersetzt).
    expect(sichtbarkeit('#141414', ZWEI_LAGEN)).toBeLessThan(1.05)
    expect(sichtbarkeit('#1e1e1e', ZWEI_LAGEN)).toBeLessThan(1.07)
    expect(sichtbarkeit('#363636', ZWEI_LAGEN)).toBeLessThan(1.16)
  })

  it('und es hilft nicht, ihn dunkler zu stellen: schwarz ist die Obergrenze', () => {
    // Das ist der Kern und der Grund, warum hier kein „dunkler Schatten"
    // erfunden wird, so wie bei --shadow-lg/xl/2xl.
    expect(contrast('#000000', '#141414')).toBeLessThan(1.15)
    expect(contrast('#000000', '#1e1e1e')).toBeLessThan(1.27)
    // Zum Vergleich dieselbe Rechnung im Hellmodus.
    expect(contrast('#000000', '#ffffff')).toBeGreaterThan(20)
    // Eine Kante schafft dort mehr als jeder Schatten koennte.
    expect(contrast(over('#ffffff', '#1e1e1e', 0.15), '#1e1e1e')).toBeGreaterThan(1.5)
  })

  it('die Regel schaltet GENAU den Schatten ab, nicht die Ringe daneben', () => {
    // Tailwind 4 baut `box-shadow` aus fuenf Variablen zusammen.
    // `box-shadow: none` haette jeden `ring-*` auf demselben Element
    // mitgeloescht; im Fenster nachgemessen ueberlebt der Ring so.
    const regel = CSS_CODE.match(/\.dark\s+\.shadow-sm\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(regel, 'es gibt keine .dark .shadow-sm-Regel').not.toBe('')
    const deklarationen = regel.split(';').map((s) => s.trim()).filter(Boolean)
    expect(deklarationen).toEqual(['--tw-shadow: 0 0 #0000'])
    expect(regel).not.toContain('box-shadow')
  })

  it('im Hellmodus wird nichts abgeschaltet', () => {
    expect(CSS_CODE).not.toMatch(/\.light\s+\.shadow-sm/)
  })
})

// ── D-T07: eine Hoehe, und zwar genau diese ────────────────────────────

describe('die Reiter der Kopfzeile stehen auf einer benannten Stufe', () => {
  const header = DATEIEN.find(([n]) => n === 'components/layout/Header.tsx')?.[1] ?? ''

  it('das Nav-Rezept nimmt --control-h-md — und nur sie', () => {
    const rezept = header.match(/const NAV_BASE = '([^']*)'/)?.[1] ?? ''
    expect(rezept, 'kein NAV_BASE gefunden').not.toBe('')
    expect(rezept).toContain('h-[var(--control-h-md)]')
    // Nicht bloss „keine rohe Hoehe", sondern die EXAKTE Stufe: mit sm
    // oder lg faellt dieser Test genauso.
    expect(rezept).not.toContain('--control-h-sm')
    expect(rezept).not.toContain('--control-h-lg')
    expect(rezept).not.toMatch(/(?<![\w-])h-\d/)
  })

  it('die Stufe ist wirklich 32px und nicht heimlich verschoben', () => {
    expect(CSS_CODE).toMatch(/--control-h-md:\s*32px/)
  })
})

// ── D-T11: transition-all ist gezaehlt und gedeckelt ───────────────────

describe('transition-all darf nur schrumpfen', () => {
  // Gemessen am 01.09.2026: 54 Fundstellen vorher, 42 nachher. Migriert
  // wurden nur die, deren Zustandswechsel BEWEISBAR ausschliesslich
  // Farbwerte betrifft (Rand immer vorhanden, nur Farbe wechselt).
  // Ausdruecklich NICHT migriert: Stellen mit ring-Wechsel (box-shadow),
  // mit Randbreite 0→1, mit opacity, und `.lu-primary`, dessen
  // :disabled-Zustand `filter` und `opacity` animiert.
  const SCHRANKE = 42

  it(`hoechstens ${SCHRANKE} Fundstellen`, () => {
    const n = (ALL.match(/(?<![\w-])transition-all(?![\w-])/g) ?? []).length
    expect(n).toBeLessThanOrEqual(SCHRANKE)
  })

  it('die Motion-Leiter ist da, an die die naechste Stelle gehen kann', () => {
    for (const t of ['--motion-fast', '--motion-base', '--motion-slow', '--motion-ease']) {
      expect(CSS_CODE).toContain(t)
    }
  })
})
