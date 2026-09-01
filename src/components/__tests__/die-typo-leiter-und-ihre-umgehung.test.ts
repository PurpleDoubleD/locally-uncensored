/**
 * Die Typo-Leiter, ihre Umgehung und die Anzeigeschrift — Design-Audit §5,
 * D-T04 und D-T03.
 *
 * ── Der Befund, am 01.09.2026 nachgezaehlt ──
 *
 * `src/` (ohne `__tests__`) enthielt 1026 Fundstellen einer arbitraeren
 * Schriftgroesse `text-[…]` gegen 143 Nutzungen der `.t-*`-Klassen. Das
 * System existiert und wird umgangen.
 *
 * Interessant ist nicht die Zahl der Fundstellen, sondern die Zahl der
 * WERTE: 30 (28 Groessen + 2 Farben). Und ihre Verteilung:
 *
 *     947 von 1026 (92,3 %)  liegen zwischen 8 und 11,99 px, also UNTER
 *                            --text-body (13)
 *      65 von 1026 ( 6,3 %)  sitzen exakt auf einer Stufe
 *
 * Unter 13px hatte die Leiter drei Stufen und keine davon war schlichter
 * Text: --text-label (10) erzwingt uppercase und Laufweite, --text-mono
 * (11) wechselt die Schriftfamilie, --text-control (12) setzt
 * line-height 1. Von den 947 Bandstellen tragen 38 uppercase/tracking; die
 * anderen 909 wollten schlichten Kleintext, und dafuer gab es keinen Namen.
 *
 * Die Luecke war also keine fehlende ZAHL — der haeufigste Umgehungswert
 * (0.6rem = 9,6px) und der gewichtete Mittelwert des Bandes (9,75px) liegen
 * beide einen Viertelpixel neben der 10, die schon da war. Deshalb bekommt
 * `.t-micro` keine eigene Zahl, sondern `var(--text-label)`.
 *
 * ── Was dieser Test ist ──
 *
 * Eine Sperrklinke nach dem Vorbild von `icon-leiter.test.ts`: die Schranken
 * stehen auf dem GEMESSENEN Ist-Wert nach dieser Aenderung, nicht auf einem
 * Wunschwert. Sie duerfen sinken, nicht steigen. Eine Schranke, die sofort
 * rot ist, waere kein Gate.
 *
 * ── Was hier NICHT geprueft werden kann ──
 *
 *   • ob 10px die richtige Groesse ist. Das ist eine Entscheidung und steht
 *     als solche im `.t-micro`-Kommentar von index.css.
 *   • wie Space Grotesk aussieht. Geprueft wird, dass die Datei da ist, dass
 *     sie referenziert wird und dass die Gewichte stimmen — nicht, ob die
 *     Buchstaben gefallen.
 *   • ob die Schrift im Fenster wirklich laedt. Das braucht ein Fenster;
 *     die Messung steht im Kommentar bei --font-display (document.fonts,
 *     Chromium 149, inklusive Breitenvergleich gegen den Rueckfall).
 *
 * Run: npx vitest run src/components/__tests__/die-typo-leiter-und-ihre-umgehung.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { quelldateien, quelltext } from './quelldateien'

const ROOT = resolve(__dirname, '..', '..', '..')
const SRC = resolve(ROOT, 'src')
const CSS = readFileSync(resolve(SRC, 'index.css'), 'utf8')

/** Kommentare raus — sonst zaehlt jede Erklaerung als Fundstelle. */
const nurCode = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const CSS_CODE = nurCode(CSS)

/** Alle .ts/.tsx unter src/, rekursiv, ohne __tests__. Die App, nicht die Pruefung. */
const DATEIEN = quelldateien(SRC)

/** Jede arbitraere Schriftgroesse, mit ihrer Fundstellenzahl. */
function arbitraereGroessen(): Map<string, number> {
  const m = new Map<string, number>()
  for (const [, src] of DATEIEN) {
    for (const t of src.matchAll(/(?<![\w-])(?:[a-z-]+:)*text-\[([^\]]+)\]/g)) {
      m.set(t[1], (m.get(t[1]) ?? 0) + 1)
    }
  }
  return m
}
const WERTE = arbitraereGroessen()
const FUNDSTELLEN = [...WERTE.values()].reduce((a, b) => a + b, 0)

// ── Die Sperrklinke ────────────────────────────────────────────────────
//
// Ist-Werte, gemessen mit genau dem Zaehler oben:
//
//   Welle 1 (Klasse gebaut)    30 Werte / 1026 Fundstellen
//                              25 Werte / 1009 Fundstellen
//   Welle 2 (Klasse gezogen)   23 Werte /  826 Fundstellen
//
// Welle 1 hat `#7c3aed`/`#a78bfa` (jetzt Tokens), `8px` (identisch zu
// 0.5rem), `0.75rem` (identisch zu 12px) und `0.63rem` abgebaut.
//
// Welle 2 hat 181 Fundstellen in chat/ models/ ui/ agents/ import/ auf
// `.t-micro` gezogen und dabei zwei weitere Werte ganz beseitigt:
// `0.58rem` (9,28px — im Band) und `0.4rem` (6,4px, 3 Fundstellen, 0,8px
// neben `0.45rem`, das dieselbe Rolle traegt).
//
// Die Grenze ist eine Rechnung, keine Ermuedung: `.t-micro` nimmt das
// Band, das auf ihre 10px rundet, ± 1 CSS-Pixel. Was ausserhalb liegt,
// bleibt stehen — mit Grund, nachzulesen im `.t-micro`-Kommentar von
// index.css. Der groesste Rest ist `0.55rem` (8,8px) und `0.5rem` (8px):
// dorthin zu ziehen waere +14 bzw. +25 %, also ein Entwurf und keine
// Zusammenfuehrung.
const SCHRANKE_WERTE = 23
const SCHRANKE_FUNDSTELLEN = 826

describe('die Umgehung ist gedeckelt und darf nur schrumpfen', () => {
  it(`hoechstens ${SCHRANKE_WERTE} verschiedene arbitraere Schriftgroessen`, () => {
    // Wer eine SECHSUNDZWANZIGSTE erfindet, faellt hier durch und nimmt
    // eine Stufe. Wer eine abbaut, senkt die Zahl hier mit.
    expect(WERTE.size).toBeLessThanOrEqual(SCHRANKE_WERTE)
  })

  it(`hoechstens ${SCHRANKE_FUNDSTELLEN} Fundstellen`, () => {
    expect(FUNDSTELLEN).toBeLessThanOrEqual(SCHRANKE_FUNDSTELLEN)
  })

  it('die sieben abgebauten Werte sind wirklich weg', () => {
    for (const weg of ['text-[8px]', 'text-[0.75rem]', 'text-[0.63rem]', 'text-[#7c3aed]', 'text-[#a78bfa]', 'text-[0.58rem]', 'text-[0.4rem]']) {
      const treffer = DATEIEN.filter(([, s]) => s.includes(weg)).map(([n]) => n)
      expect(treffer, weg).toEqual([])
    }
  })

  it('die zweite Umgehung — lokal umdefinierte Tokens — ist mitgezaehlt', () => {
    // `text-[…]` ist nicht der einzige Weg an der Leiter vorbei. Zwei
    // Create-Call-Sites setzen die Tokens SELBST neu (auf 9px, 8px, 7px,
    // 18px, 6px). Diese Dateien gehoeren in diesem Durchgang einem anderen
    // Agenten, also wird hier nur gedeckelt, nicht geaendert.
    const orte: string[] = []
    for (const [name, src] of DATEIEN) {
      for (const t of src.matchAll(/\[--(?:text|control-h|radius)-[a-z-]+:[^\]]+\]/g)) {
        orte.push(`${name}: ${t[0]}`)
      }
    }
    expect(orte.length).toBeLessThanOrEqual(5)
  })
})

describe('die neue Stufe ist keine neue Zahl', () => {
  it('--text-micro ist var(--text-label), nicht 10px noch einmal', () => {
    expect(CSS_CODE).toMatch(/--text-micro:\s*var\(--text-label\)\s*;/)
    // Und die Leiter selbst hat keine siebte Zahl bekommen.
    const stufen = [...CSS_CODE.matchAll(/--text-(display|title|body|control|label|mono):\s*(\d+)px/g)]
    expect(stufen.map((m) => Number(m[2])).sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 15, 20])
  })

  it('`.t-micro` setzt GENAU EINE Eigenschaft', () => {
    // Der Grund steht im Kommentar daneben und ist im Browser gemessen: die
    // sechs alten `.t-*` stehen ungeschichtet und fressen jedes
    // `font-semibold`/`leading-*` der Call-Site. Ein Rezept, das die
    // Entscheidungen des Aufrufers ueberschreibt, ist selbst ein Grund zur
    // Umgehung. Deshalb hier nur die Groesse — und deshalb ist der Tausch
    // gegen `text-[10px]` beweisbar folgenlos.
    const regel = CSS_CODE.match(/\.t-micro\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(regel, 'es gibt keine .t-micro-Regel').not.toBe('')
    const deklarationen = regel.split(';').map((s) => s.trim()).filter(Boolean)
    expect(deklarationen).toEqual(['font-size: var(--text-micro)'])
  })

  it('und sie wird wirklich benutzt, nicht nur definiert', () => {
    // Welle 1 hat sie gebaut und auf 9 Call-Sites gebracht; Welle 2 hat die
    // 179 Fundstellen des Bandes daraufgezogen. Diese Schranke ist die
    // GEGENRICHTUNG zu den beiden oben: dort darf die Umgehung nur sinken,
    // hier darf der Gebrauch der Leiter nur steigen. Ohne diese Haelfte
    // waere ein Ersatz von `text-[0.6rem]` durch gar nichts auch gruen.
    const n = DATEIEN.reduce(
      (a, [, s]) => a + (s.match(/(?<![\w-])t-micro(?![\w-])/g) ?? []).length,
      0,
    )
    expect(n).toBeGreaterThanOrEqual(190)
  })

  it('das Band, das `.t-micro` nimmt, ist in MEINEN Verzeichnissen wirklich leer', () => {
    // Die Regel ausgeschrieben: alles, was auf 10px ± 1 CSS-Pixel rundet,
    // heisst `.t-micro`. In chat/ models/ ui/ agents/ import/ ist das
    // vollstaendig durchgezogen; anderswo steht es noch, dort arbeiten
    // andere.
    const MEIN = (n: string) =>
      /^components\/(chat\/|models\/|ui\/|agents\/|import\/)/.test(n)
      && n !== 'components/chat/ChatView.tsx'
    const band = (roh: string): number | null => {
      const rem = roh.match(/^([\d.]+)rem$/)
      if (rem) return parseFloat(rem[1]) * 16
      const px = roh.match(/^([\d.]+)px$/)
      return px ? parseFloat(px[1]) : null
    }
    const treffer: string[] = []
    for (const [name, src] of DATEIEN) {
      if (!MEIN(name)) continue
      for (const m of src.matchAll(/(?<![\w-])(?:[a-z-]+:)*text-\[([^\]]+)\]/g)) {
        const px = band(m[1])
        if (px !== null && px >= 9 && px <= 11) treffer.push(`${name}: ${m[0]}`)
      }
    }
    expect(treffer, 'im t-micro-Band und trotzdem in eckigen Klammern').toEqual([])
  })

  it('die drei alten Kleinstufen sind wirklich keine schlichten Stufen', () => {
    // Das ist der BEFUND, nicht der Fix: er darf sich nicht heimlich
    // aufloesen, sonst waere `.t-micro` doppelt.
    const t = (n: string) => CSS_CODE.match(new RegExp(`\\.${n}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(t('t-label')).toContain('text-transform: uppercase')
    expect(t('t-label')).toContain('letter-spacing')
    expect(t('t-mono')).toContain('font-family')
    expect(t('t-control')).toContain('var(--text-control-lh)')
    expect(CSS_CODE).toMatch(/--text-control-lh:\s*1\s*;/)
  })
})

// ── D-T03: die Anzeigeschrift war die ganze Zeit im Haus ───────────────

const FONT_CSS_PFAD = resolve(ROOT, 'public', 'fonts', 'lu-fonts.css')

describe('die Displaystufe traegt die Markenschrift, die schon ausgeliefert wird', () => {
  const fontCss = readFileSync(FONT_CSS_PFAD, 'utf8')

  it('lu-fonts.css enthaelt Space Grotesk — der Audit sagte, sie enthalte nur Inter', () => {
    const familien = new Map<string, number>()
    for (const m of fontCss.matchAll(/font-family:\s*'([^']+)'/g)) {
      familien.set(m[1], (familien.get(m[1]) ?? 0) + 1)
    }
    expect([...familien.keys()].sort()).toEqual(['Inter', 'JetBrains Mono', 'Space Grotesk'])
    expect(familien.get('Space Grotesk')).toBe(6)
  })

  it('und die Schriftdateien liegen wirklich da — keine tote Referenz', () => {
    const bloecke = fontCss.split('@font-face').filter((b) => /Space Grotesk/.test(b))
    expect(bloecke.length).toBe(6)
    const dateien = new Set<string>()
    for (const b of bloecke) {
      const u = b.match(/url\(([^)]+)\)/)?.[1]
      expect(u, 'Block ohne url()').toBeTruthy()
      dateien.add(u as string)
    }
    for (const d of dateien) {
      expect(existsSync(resolve(dirname(FONT_CSS_PFAD), d)), `fehlt: ${d}`).toBe(true)
    }
    // Drei Dateien fuer sechs Bloecke: 500 und 700 teilen sich je
    // latin / latin-ext / vietnamese.
    expect(dateien.size).toBe(3)
  })

  it('genau die Gewichte, die es gibt: 500 und 700', () => {
    const gewichte = new Set<string>()
    for (const b of fontCss.split('@font-face').filter((x) => /Space Grotesk/.test(x))) {
      const w = b.match(/font-weight:\s*(\d+)/)?.[1]
      if (w) gewichte.add(w)
    }
    expect([...gewichte].sort()).toEqual(['500', '700'])
  })

  it('index.html laedt die Datei — nichts wird nachgeladen', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8')
    expect(html).toContain('/fonts/lu-fonts.css')
  })

  it('--font-display nennt Space Grotesk zuerst und hat einen echten Rueckfall', () => {
    const wert = CSS_CODE.match(/--font-display:\s*([^;]+);/)?.[1] ?? ''
    expect(wert).not.toBe('')
    const stack = wert.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(stack[0]).toBe('Space Grotesk')
    expect(stack).toContain('Inter')
    expect(stack[stack.length - 1]).toBe('sans-serif')
  })

  it('`.t-display` nimmt das Token — und keine zweite Schriftliste', () => {
    const regel = CSS_CODE.match(/\.t-display\s*\{([^}]*)\}/)?.[1] ?? ''
    // Genau eine Schriftangabe, und sie zeigt aufs Token statt eine zweite
    // Liste zu fuehren.
    const familien = regel.match(/font-family:[^;]*/g) ?? []
    expect(familien).toEqual(['font-family: var(--font-display)'])
  })

  it('das Displaygewicht ist 500 — ein Schnitt, den die Datei wirklich hat', () => {
    // Bei 600 waehlt Chromium nach der CSS-Font-Matching-Regel den
    // naechsthoeheren echten Schnitt, also 700; im Fenster nachgemessen an
    // der Textbreite (600 ergab exakt den 700er-Wert). Die Displaystufe
    // haette still fett gerendert.
    expect(CSS_CODE).toMatch(/--text-display-fw:\s*500\s*;/)
    const gewichte = new Set<string>()
    for (const b of fontCss.split('@font-face').filter((x) => /Space Grotesk/.test(x))) {
      const w = b.match(/font-weight:\s*(\d+)/)?.[1]
      if (w) gewichte.add(w)
    }
    expect(gewichte.has('500')).toBe(true)
  })

  it('die eine Call-Site der Displaystufe steht noch', () => {
    const view = quelltext(DATEIEN, 'components/chat/ChatView.tsx')
    expect(view).toMatch(/className="t-display/)
  })
})
