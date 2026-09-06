/**
 * Ein Maßstab statt vier — Audit Welle 2, Amateur-Signal 3.
 *
 * Der Befund war nicht „die Wurzel ist krumm", sondern: die App rechnete an
 * VIER Stellen gleichzeitig um. `html { font-size: 18.4px }` streckte alles
 * rem-Basierte um 15 %, `zoom: 1.25` auf der Sidebar streckte deren Teilbaum
 * noch einmal, `transform: scale(0.763)` auf der IntentBar und
 * `scale(0.7)` auf der Composer-Reglerzeile stauchten zwei weitere Teilbäume
 * zurück. Die Faktoren hoben sich nur ungefähr auf (0,763 ≈ 1/1,31, aber
 * 1,25 ≠ 1,15), und die px-geschriebene Hälfte der App (Iconmaße,
 * Controlhöhen, Radius-Tokens) bekam die 15 % nie.
 *
 * Dieser Test nagelt die EINE Eigenschaft fest, aus der alles andere folgt:
 * das Wurzelmaß ist das Raster (16px), der Regler ist ein Token
 * (`--ui-scale`), und der Regler wird genau einmal angewandt. Er liest dazu
 * die Quelle — es gibt keinen Weg, eine zweite Skalierungsschicht zu
 * erkennen, ohne nachzusehen, wo Skalierung überhaupt geschrieben steht.
 *
 * Was hier NICHT geprüft werden kann:
 *   • ob es gut aussieht. Die gemessenen Vorher/Nachher-Geometrien liegen im
 *     Bericht zur Änderung, nicht hier — vitest hat kein Fenster.
 *   • ob `zoom` die richtige Wahl war. Das ist im `--ui-scale`-Kommentar von
 *     `index.css` mit den Messwerten aus Chromium 149 begründet.
 *   • wie viele Zeichen in eine Zeile passen. Das hängt an der Schrift und
 *     an der Sprache, nicht an der Quelle; eine hier eingetragene Konstante
 *     wäre eine Behauptung, kein Messwert. Die gemessenen Werte stehen im
 *     --lu-measure-Kommentar von `index.css`.
 *   • ob JEDE Schriftgröße der App auf einem ganzen Pixel sitzt. Sie tut es
 *     nicht: die ~967 `text-[0.xx rem]`-Fundstellen außerhalb der drei
 *     umgebauten Teilbäume sind die zweite Hälfte des Audit-Punkts
 *     („sechs px-Stufen") und stehen noch aus. Geprüft wird hier nur die
 *     Token-Leiter, die dafür die Vorlage ist.
 *
 * Run: npx vitest run src/components/__tests__/ein-massstab.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '..', '..')
const CSS = readFileSync(resolve(SRC, 'index.css'), 'utf8')

/** Kommentare raus — sonst zählt jede Erklärung als Fundstelle. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const cssCode = stripComments(CSS)

/** Alle .tsx unter src/components, rekursiv, ohne __tests__. */
function componentFiles(dir = resolve(SRC, 'components')): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__') continue
    const p = resolve(dir, e.name)
    if (e.isDirectory()) out.push(...componentFiles(p))
    else if (e.name.endsWith('.tsx')) out.push([p.slice(SRC.length + 1), stripComments(readFileSync(p, 'utf8'))])
  }
  return out
}
const FILES = componentFiles()

/** Jede CSS-Regel als [Selektorliste, Rumpf] — flach, reicht für index.css. */
function rules(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) out.push([m[1].trim(), m[2]])
  return out
}
const RULES = rules(cssCode)

/** Der Wert von --ui-scale, aus der Quelle gelesen. */
function uiScale(): number {
  const m = /--ui-scale\s*:\s*([\d.]+)\s*;/.exec(cssCode)
  expect(m, '--ui-scale fehlt in index.css').not.toBeNull()
  return Number.parseFloat(m![1])
}

/** Jede `font-size` aus einer Regel, deren Selektorliste `html` enthält. */
function rootFontSizes(): string[] {
  return RULES
    .filter(([sel, body]) => sel.split(',').some((s) => s.trim() === 'html') && /font-size\s*:/.test(body))
    .map(([, body]) => /font-size\s*:\s*([^;]+)/.exec(body)![1].trim())
}

describe('das Wurzelmaß ist das Raster, nicht der Regler', () => {
  it('html steht auf 16px — nicht auf den 18,4px, die jeden rem-Wert krumm machten', () => {
    expect(rootFontSizes()).toEqual(['16px'])
  })

  it('16px × --ui-scale ist exakt das, was die 18,4px meinten — die App wird nicht kleiner', () => {
    expect(16 * uiScale()).toBeCloseTo(18.4, 10)
  })
})

describe('die 15 % sind ein Token und werden genau einmal angewandt', () => {
  it('--ui-scale ist genau einmal definiert und steht auf 1.15', () => {
    const defs = cssCode.match(/--ui-scale\s*:\s*[\d.]+\s*;/g) ?? []
    expect(defs).toHaveLength(1)
    expect(uiScale()).toBe(1.15)
  })

  it('es gibt genau EINE zoom-Deklaration, und sie liest das Token', () => {
    const withZoom = RULES.filter(([, body]) => /(^|[;\s])zoom\s*:/.test(body))
    expect(withZoom).toHaveLength(1)
    const [selector, body] = withZoom[0]
    expect(/zoom\s*:\s*var\(--ui-scale\)/.test(body)).toBe(true)

    // Die Selektorliste trägt #root selbst plus die Geschwister, in die
    // React portaliert (Tooltip / Select / MemoryDebugPanel gehen an
    // document.body). Beides sind WURZELN — nie Nachfahren voneinander,
    // also bekommt kein Element den Faktor zweimal.
    const selectors = selector.split(',').map((s) => s.trim())
    expect(selectors).toContain('#root')
    for (const s of selectors) {
      expect(
        s === '#root' || /^body\s*>\s*:not\(#root\)$/.test(s),
        `unerwarteter Selektor an der zoom-Regel: ${s}`,
      ).toBe(true)
    }
  })

  it('kein zweites Layout-Maß: keine feste zoom-/scale()-Schicht in einer Komponente', () => {
    // Erlaubt bleibt Bewegung (framer-motion `animate`, `hover:scale-*`,
    // @keyframes) — verboten ist eine STATISCHE Skalierung im style-Attribut,
    // denn genau die ist ein Maßstab, der nirgends als Größe steht.
    const offenders: string[] = []
    for (const [name, src] of FILES) {
      for (const m of src.matchAll(/style=\{\{[^}]*\}\}/g)) {
        if (/\bzoom\s*:/.test(m[0])) offenders.push(`${name}: ${m[0]}`)
        if (/transform\s*:\s*['"`]\s*scale\(/.test(m[0])) offenders.push(`${name}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('die drei gelöschten Schichten sind an ihren alten Fundstellen wirklich weg', () => {
    // Ohne Kommentare: die Erklärungen an den drei Stellen NENNEN die alten
    // Faktoren, und das sollen sie auch.
    const read = (p: string) => stripComments(readFileSync(resolve(SRC, p), 'utf8'))
    const sidebar = read('components/layout/Sidebar.tsx')
    const intentBar = read('components/create/experimental/IntentBar.tsx')
    const composer = read('components/create/experimental/Composer.tsx')
    expect(sidebar).not.toMatch(/zoom:\s*1\.25/)
    expect(intentBar).not.toMatch(/scale\(0\.763\)/)
    expect(composer).not.toMatch(/scale\(0\.7\)/)
  })
})

describe('was `zoom` nicht mitnimmt, ist ausgeglichen', () => {
  it('#root ist an das Fenster gebunden, nicht an 100vh', () => {
    // `100vh` misst im gezoomten Baum weiter das UNgezoomte Fenster und wird
    // danach mitskaliert — die Wurzel wäre um --ui-scale zu hoch.
    const root = RULES.filter(([sel]) => sel.split(',').some((s) => s.trim() === '#root'))
    const body = root.map(([, b]) => b).join(';')
    expect(body).toMatch(/height\s*:\s*100%/)
    expect(body).not.toMatch(/height\s*:\s*100vh/)
  })

  it('die Vollbild-Wurzel der App füllt #root — sonst überschießt sie um --ui-scale', () => {
    // AppShell/ViewSkeletons/Onboarding sind `h-screen w-screen`; ohne diese
    // Regel wären sie im 1440×900-Fenster 1656×1035 groß (gemessen).
    const rule = RULES.find(([sel]) => /^#root\s*>\s*\*$/.test(sel.trim()))
    expect(rule, 'Regel `#root > *` fehlt').toBeDefined()
    expect(rule![1]).toMatch(/width\s*:\s*100%/)
    expect(rule![1]).toMatch(/height\s*:\s*100%/)
  })
})

describe('die Lesespalte wird am gerenderten Wert festgehalten, nicht am Token', () => {
  /** Ein px-Token aus :root, als Zahl. */
  const tokenPx = (name: string): number => {
    const m = new RegExp(`--${name}\\s*:\\s*([\\d.]+)px\\s*;`).exec(cssCode)
    expect(m, `--${name} fehlt oder ist nicht in px`).not.toBeNull()
    return Number.parseFloat(m![1])
  }

  it('--lu-measure × --ui-scale ergibt ~760 gerenderte px', () => {
    // Absichtlich NICHT `--lu-measure === 660`: der Token allein sagt nichts
    // mehr, seit er mitskaliert wird. Bricht jemand später --ui-scale, soll
    // dieser Test fallen — sonst wandert die Lesespalte still mit.
    const gerendert = tokenPx('lu-measure') * uiScale()
    expect(gerendert).toBeGreaterThan(750)
    expect(gerendert).toBeLessThan(770)
  })

  // Hier stand eine zweite Prüfung auf „Zeichen pro Zeile bleibt im Band
  // 45–80". Sie ist gestrichen, und zwar nicht, weil sie unbequem war,
  // sondern weil sie NICHTS PRÜFEN KONNTE: mit einer fest eingetragenen
  // Zeichenbreite ist `gerenderte px / Konstante` nur der px-Test oben,
  // durch eine Zahl geteilt. Sie schlägt nie an, wo der px-Test nicht
  // schon anschlägt, und sie schlägt auch dann nicht an, wenn sich die
  // Zeichenbreite wirklich ändert (Schriftwechsel, andere Sprache) — denn
  // die Konstante misst ja nichts, sie steht da.
  //
  // Dazu kam, dass die erste Konstante (9,85px) am Kleinbuchstaben-
  // Alphabet gemessen war, nicht an Fliesstext. Der Test war damit grün
  // bei „77 Zeichen, im Band", während die Spalte real 86 Zeichen trägt.
  // Ein Test, der eine bequeme Fiktion festhält, ist schlechter als kein
  // Test. Die drei gemessenen Zeichenbreiten samt Messgrundlage stehen
  // jetzt im --lu-measure-Kommentar in index.css, wo sie hingehören:
  // als Beleg, nicht als Zusicherung.
})

describe('die Typo-Leiter liegt auf ganzen Pixeln des 16px-Rasters', () => {
  const STUFEN = ['display', 'title', 'body', 'control', 'label', 'mono'] as const

  it('sechs Stufen, alle in ganzen px', () => {
    const werte = STUFEN.map((n) => {
      const m = new RegExp(`--text-${n}\\s*:\\s*([^;]+);`).exec(cssCode)
      expect(m, `--text-${n} fehlt`).not.toBeNull()
      return m![1].trim()
    })
    expect(werte).toHaveLength(6)
    for (const w of werte) {
      expect(w, `Typo-Stufe nicht in ganzen px: ${w}`).toMatch(/^\d+px$/)
    }
  })
})
