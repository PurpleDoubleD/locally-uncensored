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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over } from './wcag-contrast'
import { quelldateien, quelltext } from './quelldateien'

const ROOT = resolve(__dirname, '..', '..', '..')
const SRC = resolve(ROOT, 'src')
const CSS = readFileSync(resolve(SRC, 'index.css'), 'utf8')
const nurCode = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const CSS_CODE = nurCode(CSS)

const DATEIEN = quelldateien(SRC)
const ALL = DATEIEN.map(([, s]) => s).join('\n')
/** Derselbe Text ohne Kommentare — sonst zaehlt eine Notiz als Call-Site. */
const CODE = DATEIEN.map(([, s]) => nurCode(s)).join('\n')

/**
 * Die Verzeichnisse, die dieses Paket anfassen darf. Alles andere wird hier
 * GEZAEHLT und nicht geaendert — eine Schranke, die fremde Dateien mitregelt,
 * waere in einem Baum mit mehreren Haenden nur eine Quelle falscher roter
 * Laeufe.
 */
const MEIN = (n: string) =>
  /^components\/(chat\/|models\/|ui\/|agents\/|import\/)/.test(n)
  && n !== 'components/chat/ChatView.tsx'

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
    const side = quelltext(DATEIEN, 'components/layout/Sidebar.tsx')
    expect(side).toContain('rounded-[10px]')
    const shell = quelltext(DATEIEN, 'components/layout/AppShell.tsx')
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
  const header = quelltext(DATEIEN, 'components/layout/Header.tsx')

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
  // Gemessen: 54 vorher (Welle 1) → 42 → 33 (Welle 2). Migriert wird nur,
  // wo der Zustandswechsel BEWEISBAR eng ist:
  //   · nur Farbwerte                       → `transition-colors`
  //   · Farbe + Deckkraft                   → `transition` (Tailwinds
  //     kuratierte Liste; sie enthaelt opacity, aber KEINE Layoutmasse)
  //   · nur eine Laenge, die wirklich laeuft → `transition-[width]`
  //     (die drei Fortschrittsbalken) bzw. `transition-[width,height]`
  //     (der Vorschau-Rahmen, dessen Kasten sich beim Umschalten aendert)
  // Ausdruecklich NICHT migriert: Stellen mit ring-Wechsel (box-shadow),
  // mit Randbreite 0→1 und `.lu-primary`, dessen :disabled-Zustand
  // `filter` und `opacity` animiert. In chat/ models/ ui/ agents/ import/
  // bleibt genau EINE stehen: models/ModelCard.tsx wechselt `ring-1`.
  const SCHRANKE = 33

  it(`hoechstens ${SCHRANKE} Fundstellen`, () => {
    const n = (ALL.match(/(?<![\w-])transition-all(?![\w-])/g) ?? []).length
    expect(n).toBeLessThanOrEqual(SCHRANKE)
  })

  it('in den Verzeichnissen dieses Pakets ist genau eine uebrig, und sie ist benannt', () => {
    const rest: string[] = []
    for (const [name, src] of DATEIEN) {
      if (!MEIN(name)) continue
      for (const _ of src.matchAll(/(?<![\w-])transition-all(?![\w-])/g)) rest.push(name)
    }
    expect(rest).toEqual(['components/models/ModelCard.tsx'])
  })

  it('die Motion-Leiter ist da, an die die naechste Stelle gehen kann', () => {
    for (const t of ['--motion-fast', '--motion-base', '--motion-slow', '--motion-ease']) {
      expect(CSS_CODE).toContain(t)
    }
  })

  it('und die JS-Seite der Leiter wird wirklich aufgerufen, nicht nur exportiert', () => {
    // DAS war der eigentliche D-T11-Befund im JS: `MOTION_S` existierte
    // seit Welle 1 in ui/motion.ts und hatte NULL Aufrufer — nur die
    // beiden Federn wurden benutzt. Achtzehn Zahlenliterale standen
    // daneben. Eine Leiter, die niemand betritt, ist keine Leiter.
    const n = (CODE.match(/MOTION_S\./g) ?? []).length
    expect(n).toBeGreaterThanOrEqual(23)
  })

  it('in diesen Verzeichnissen steht keine nackte Dauer mehr — ausser der einen, die keine ist', () => {
    // Was uebrig bleibt, ist `duration: 1.5` an einer Endlosdrehung in
    // chat/RAGPanel.tsx. Die Leiter beschreibt ZUSTANDSWECHSEL (120 / 150
    // / 300 ms); ein Dauerlauf mit `repeat: Infinity` ist kein
    // Zustandswechsel und gehoert nicht darauf.
    const rest: string[] = []
    for (const [name, src] of DATEIEN) {
      if (!MEIN(name)) continue
      for (const m of nurCode(src).matchAll(/duration:\s*([0-9.]+)/g)) {
        rest.push(`${name}: ${m[1]}`)
      }
    }
    expect(rest).toEqual(['components/chat/RAGPanel.tsx: 1.5'])
  })

  it('und keine nackte `duration-N`-Klasse — die Zahlen zeigen aufs Token', () => {
    const rest: string[] = []
    for (const [name, src] of DATEIEN) {
      if (!MEIN(name)) continue
      for (const m of nurCode(src).matchAll(/(?<![\w-])(?:[a-z-]+:)*duration-(\d+)(?![\w-])/g)) {
        rest.push(`${name}: ${m[0]}`)
      }
    }
    expect(rest).toEqual([])
  })
})

// ── D-T07 (Fortsetzung): das Control-Band gehoert den drei Tokens ──────

describe('was die Hoehe eines Bedienelements hat, nennt eine Stufe', () => {
  /** `h-7` → 28, `h-[26px]` → 26, `h-[var(...)]`/`h-[90vh]` → null. */
  function alsPx(klasse: string): number | null {
    const px = klasse.match(/^h-\[(\d+(?:\.\d+)?)px\]$/)
    if (px) return parseFloat(px[1])
    const n = klasse.match(/^h-(\d+(?:\.\d+)?)$/)
    return n ? parseFloat(n[1]) * 4 : null
  }

  /** Die drei Stufen, aus index.css gelesen statt abgeschrieben. */
  const STUFEN = (() => {
    const m = new Map<string, number>()
    for (const t of CSS_CODE.matchAll(/--control-h-(sm|md|lg):\s*(\d+)px/g)) m.set(t[1], Number(t[2]))
    return m
  })()

  it('es sind genau drei, und sie steigen', () => {
    expect([...STUFEN.keys()].sort()).toEqual(['lg', 'md', 'sm'])
    const v = ['sm', 'md', 'lg'].map((k) => STUFEN.get(k) as number)
    expect(v).toEqual([26, 32, 40])
  })

  it('im Band 24–48px steht in diesen Verzeichnissen nur noch EIN Nicht-Token', () => {
    // Das Band ist der Bereich, in dem ein Knopf, ein Feld oder ein
    // Aufklapper wohnt — 24px ist unter der kleinsten Stufe, 48px ueber
    // der groessten. Alles darin, was keine Stufe nennt, ist eine
    // vierte Hoehe.
    //
    // Ist-Stand nach diesem Paket: ZWEI, und beide sind namentlich
    // begruendet, nicht uebersehen.
    //   · agents/WorkflowList.tsx `w-7 h-7` (28px) — eine gerundete
    //     Kachel, in der ein Icon sitzt. Kein Bedienelement.
    //   · chat/avatar-slot.ts `w-6 h-6` (24px) — der Platzhalter neben
    //     einer Nachricht, dessen feste Grundflaeche eine eigene Wache
    //     hat (chat/__tests__/eine-nachricht-eine-leiste.test.ts). Er
    //     richtet sich an der Textzeile aus, nicht an der Controlleiter.
    // Der Vorschau-Knopf in chat/HtmlPreviewFrame.tsx stand daneben auf
    // denselben 28px und ist gezogen worden, weil er ein Knopf IST.
    const treffer: string[] = []
    for (const [name, src] of DATEIEN) {
      if (!MEIN(name)) continue
      for (const m of nurCode(src).matchAll(/(?<![\w-])(?:[a-z-]+:)*(h-\[[^\]]+\]|h-\d+(?:\.\d+)?)(?![\w-])/g)) {
        const px = alsPx(m[1])
        if (px !== null && px >= 24 && px <= 48) treffer.push(`${name}: ${m[1]}`)
      }
    }
    expect(treffer.sort()).toEqual([
      'components/agents/WorkflowList.tsx: h-7',
      'components/chat/avatar-slot.ts: h-6',
    ])
  })

  it('die Tokens werden wirklich aufgerufen, und zwar oft', () => {
    const n = (CODE.match(/--control-h-(sm|md|lg)/g) ?? []).length
    expect(n).toBeGreaterThanOrEqual(42)
  })
})

// ── D-T08 (Fortsetzung): die 5px sind entschieden ──────────────────────

describe('die 5px bekommen keine Stufe, sondern ein Ziel', () => {
  it('die Leiter hat keine Sprosse zwischen 4 und 6', () => {
    // Drei Stufen in zwei Pixeln waeren bei --ui-scale 1,15 rund ein
    // Geraetepixel auseinander — dieselbe Aufloesung, in der D-T04 die
    // vierzehn Schriftgroessen als Rauschen verworfen hat.
    const leiter = effektiveLeiter()
    const zwischen = [...leiter.values()].filter((v) => v > 4 && v < 6)
    expect(zwischen).toEqual([])
    expect(hausRadien().has('5')).toBe(false)
  })

  it('und in diesen Verzeichnissen steht keine rohe Pixel-Ecke mehr', () => {
    // Was bleibt, ist `rounded-[calc(var(--radius-control)+2px)]` in
    // chat/ChatInput.tsx: die Aussenecke des Composers, die aus der
    // Innenecke ABGELEITET ist (konzentrische Radien). Das ist keine
    // zweite Zahl, das ist dieselbe Zahl plus die Randstaerke.
    const treffer: string[] = []
    for (const [name, src] of DATEIEN) {
      if (!MEIN(name)) continue
      for (const m of nurCode(src).matchAll(/(?<![\w-])(?:[a-z-]+:)*rounded(?:-[a-z]+)?-\[([^\]]+)\]/g)) {
        if (/^\d/.test(m[1])) treffer.push(`${name}: ${m[0]}`)
      }
    }
    expect(treffer).toEqual([])
  })

  it('die 20 unerreichbaren 5px sind gedeckelt, nicht uebersehen', () => {
    // components/layout/Sidebar.tsx gehoert in diesem Durchgang einem
    // anderen Agenten. Die Entscheidung, wohin sie gehen (`rounded-md`,
    // 6px), steht im D-T08-Kommentar von index.css; hier steht nur, dass
    // die Zahl nicht wachsen darf.
    const orte = DATEIEN
      .filter(([, s]) => s.includes('rounded-[5px]'))
      .map(([n]) => n)
      .sort()
    expect(orte).toEqual(['components/layout/Sidebar.tsx'])
    const n = (ALL.match(/rounded-\[5px\]/g) ?? []).length
    expect(n).toBeLessThanOrEqual(20)
    // Und die Entscheidung steht wirklich da, statt nur hier behauptet zu sein.
    expect(CSS).toContain('5px bekommt KEINE Stufe')
  })
})

// ── D-T09 (Fortsetzung): EIN Aufrufer fuer „dieses Blatt schwebt" ──────

describe('das Schwebeblatt kommt aus einem Rezept, nicht aus einer Kette', () => {
  /** Jede Schattenstufe, die die App im CODE schreibt. */
  const STUFEN = (() => {
    const m = new Map<string, number>()
    for (const [, src] of DATEIEN) {
      for (const t of nurCode(src).matchAll(/(?<![\w-])(?:[a-z-]+:)*shadow-(2xs|xs|sm|md|lg|xl|2xl|none)(?![\w-])/g)) {
        m.set(t[1], (m.get(t[1]) ?? 0) + 1)
      }
    }
    return m
  })()

  it('die App schreibt hoechstens vier der sieben Tailwind-Stufen', () => {
    expect([...STUFEN.keys()].sort()).toEqual(['2xl', 'lg', 'sm', 'xl'])
  })

  it('und keine Stufe, die dem Haus nicht gehoert', () => {
    // `shadow-md`/`xs`/`2xs` sind Werkseinstellung: wer sie schriebe,
    // bekaeme ohne Vorwarnung Tailwinds Hellmodus-Wert auf einer dunklen
    // Flaeche. Genau dieser stille Halbbesitz ist der Befund.
    for (const werk of ['md', 'xs', '2xs']) {
      expect(STUFEN.has(werk), `shadow-${werk} ist Werkseinstellung und hat eine Call-Site`).toBe(false)
    }
    // Umgekehrt: jede Stufe, die geschrieben wird, ist im @theme-Block
    // ueberschrieben — bis auf `sm`, das die Hausregel `.dark .shadow-sm`
    // im Dunkeln abschaltet statt es zu ueberschreiben.
    for (const stufe of STUFEN.keys()) {
      if (stufe === 'sm') continue
      expect(CSS_CODE, `--shadow-${stufe} wird geschrieben, aber nicht ueberschrieben`)
        .toMatch(new RegExp(`--shadow-${stufe}:`))
    }
  })

  it('`.lu-elevated` ist wirklich in Gebrauch und bringt Flaeche, Kante UND Schatten mit', () => {
    const regel = CSS_CODE.match(/\.lu-elevated\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(regel, 'es gibt keine .lu-elevated-Regel').not.toBe('')
    expect(regel).toContain('var(--color-lu-overlay)')
    expect(regel).toContain('border:')
    expect(regel).toContain('var(--shadow-xl)')
    expect(CSS_CODE).toMatch(/\.light\s+\.lu-elevated/)
    const n = (CODE.match(/(?<![\w-])lu-elevated(?![\w-])/g) ?? []).length
    expect(n).toBeGreaterThanOrEqual(15)
  })

  it('kein Schwebeblatt dieser Verzeichnisse schreibt sich noch seine eigene Kette', () => {
    // Der Befund in einer Zahl: zehn Blaetter, sechs Flaechen, drei
    // Schatten, zwei Kanten. Jetzt: ein Rezept. Was uebrig bleibt, ist der
    // Warn-Aufklapper mit eigener roter Kante — die Regel wuerde sie
    // ueberschreiben, deshalb nimmt er nur das Flaechentoken.
    const rest: string[] = []
    for (const [name, src] of DATEIEN) {
      if (!MEIN(name)) continue
      for (const m of nurCode(src).matchAll(/(?<![\w-])(?:[a-z-]+:)*shadow-(xl|2xl)(?![\w-])/g)) {
        rest.push(`${name}: ${m[0]}`)
      }
    }
    expect(rest).toEqual(['components/chat/ContextDropdown.tsx: shadow-xl'])
  })

  it('und keine Call-Site laesst neben dem Rezept eine wirkungslose Klasse stehen', () => {
    // `.lu-elevated` ist ungeschichtet und schlaegt jede Utility. Ein
    // `bg-white` oder `shadow-xl` daneben waere eine Klasse ohne Wirkung —
    // und beim naechsten Leser eine Falschaussage darueber, was die
    // Flaeche traegt.
    const tot: string[] = []
    for (const [name, src] of DATEIEN) {
      for (const zeile of nurCode(src).split('\n')) {
        if (!/(?<![\w-])lu-elevated(?![\w-])/.test(zeile)) continue
        for (const m of zeile.matchAll(/(?<![\w-])(?:dark:)?(bg-white(?![\w/-])|shadow-(?:sm|md|lg|xl|2xl))(?![\w-])/g)) {
          tot.push(`${name}: ${m[0]}`)
        }
      }
    }
    expect(tot).toEqual([])
  })
})
