/**
 * Der Fokusring und das Press-Feedback — Audit Welle 3, Punkte 2 und 4.
 *
 * Beide fassen dasselbe Gebiet an (jeden Knopf der App), und beide sind
 * deshalb EINE Regel in index.css statt 489 Call-Sites. Was hier geprueft
 * wird, ist dreierlei:
 *
 *   1. dass die Regeln da sind und die richtige Form haben,
 *   2. dass die Farben den WCAG-Kontrast auf JEDER Flaeche schaffen, auf der
 *      der Ring auftauchen kann — ausgerechnet, nicht abgeschrieben,
 *   3. dass die Ausnahme (`.lu-primary`) an der Regel steht und nicht mit
 *      mehr Spezifitaet dagegenhaelt — die Falle, die in diesem Haus schon
 *      einmal zugeschlagen hat.
 *
 * Warum als Textpruefung des CSS: die Testumgebung ist `environment: 'node'`
 * ohne DOM (vitest.config.ts), es gibt also nichts zu rendern. Der Kontrast
 * dagegen ist eine Rechnung und braucht kein Fenster — sie laeuft hier gegen
 * die echten Tokens aus index.css.
 *
 * Was NICHT geprueft werden kann und im Fenster nachgesehen gehoert: ob der
 * Ring irgendwo an einem `overflow: hidden` abgeschnitten wird, und ob der
 * 3%-Druck an einem sehr breiten Knopf stoert.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { contrast, over } from './wcag-contrast'

const ROOT = resolve(__dirname, '..', '..', '..')
const SRC = resolve(ROOT, 'src')
const CSS = readFileSync(resolve(SRC, 'index.css'), 'utf8')
/**
 * index.css ohne Kommentare. Die Kommentare dieser Datei ZITIEREN die alten
 * Werte (der 1px-Ring in Fremdblau steht dort als Begruendung), und ein Test,
 * der „ist das weg" fragt, wuerde sonst die Begruendung finden statt der
 * Regel. Jede Struktur- und jede Negativpruefung unten liest deshalb CODE.
 */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** Liest einen `--color-*: #rrggbb;`-Token aus index.css. */
function token(name: string): string {
  const m = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))
  if (!m) throw new Error(`Token --${name} fehlt in index.css`)
  return m[1]
}

/** Alle .tsx unter src/components, rekursiv, ohne __tests__. */
function componentFiles(dir = resolve(SRC, 'components')): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__') continue
    const p = resolve(dir, e.name)
    if (e.isDirectory()) out.push(...componentFiles(p))
    else if (e.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/**
 * Dieselbe Vorsicht wie bei CODE oben, eine Ebene weiter: die Notizen an den
 * fuenf umgestellten Knoepfen ERKLAEREN, warum dort kein `whileTap` mehr
 * steht — und nennen das Wort dabei. Ein Test, der „ist das weg" fragt,
 * faende sonst die Erklaerung. Dasselbe Vorgehen wie in
 * streaming-does-not-repaint-the-app.test.ts.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const COMPONENT_SRC = componentFiles().map((f) => codeOnly(readFileSync(f, 'utf8')))
const ALL_COMPONENTS = COMPONENT_SRC.join('\n')

/** Der Selektor der Hausregel, einmal, damit die Tests ihn nicht abschreiben. */
const HOUSE = String.raw`:focus-visible:not\(\[tabindex='-1'\]\):not\(\.lu-primary\)`

// ── Die Flaechen, auf denen der Ring wirklich landet ────────────────────
// `outline-offset: 2px` heisst: der Ring liegt NEBEN dem Control, auf dem
// Grund dahinter. Gerechnet wird deshalb gegen diese Flaechen, nicht gegen
// das Control. Die Werte stammen aus index.css (@theme) und aus den
// Layout-Literalen von AppShell/ChatInput, nicht aus der Luft.
const COMPOSER_DARK = over('#ffffff', '#1e1e1e', 0.03) // bg-white/[0.03] ueber der Chat-Flaeche
const DARK_SURFACES: Array<[string, string]> = [
  ['App-Grund #1e1e1e', '#1e1e1e'],
  ['Fenster/Titlebar #141414', '#141414'],
  ['Composer-Leiste', COMPOSER_DARK],
  ['Panel', '#262626'],
  ['Karte/Hover', '#2d2d2d'],
  ['Overlay/Dropdown', '#363636'],
]
const LIGHT_SURFACES: Array<[string, string]> = [
  ['Blatt/Overlay #ffffff', '#ffffff'],
  ['Composer-Leiste #f9fafb', '#f9fafb'],
  ['Fenstergrund #f3f4f6', '#f3f4f6'],
]

describe('Punkt 4 — der Fokusring existiert, ist 2px und nimmt Tokens', () => {
  it('es gibt genau eine Hausregel, und sie ist 2px mit 2px Abstand', () => {
    const rules = CODE.match(new RegExp(`^${HOUSE}\\s*\\{[^}]*\\}`, 'gm')) ?? []
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatch(/outline:\s*2px solid var\(--color-lu-accent\)/)
    expect(rules[0]).toMatch(/outline-offset:\s*2px/)
    // Keine Farbe als Literal — sonst laeuft der Ring vom Akzent weg.
    expect(rules[0]).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/)
  })

  it('der Hellmodus nimmt die Kante, nicht den Akzent', () => {
    const light = CODE.match(new RegExp(`^\\.light ${HOUSE}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? ''
    expect(light).toMatch(/outline-color:\s*var\(--color-lu-accent-edge\)/)
  })

  it('der alte 1px-Ring in Fremdblau ist restlos weg', () => {
    // Er stand dreimal in dieser Datei: global fuer button/a, als
    // `.lu-focus-ring`-Kopie und als `outline: none` fuer Eingabefelder.
    expect(CODE).not.toMatch(/rgba\(96,\s*165,\s*250/)
    expect(CODE).not.toMatch(/outline:\s*1px/)
  })

  it('Eingabefelder sind nicht mehr ausgenommen', () => {
    expect(CODE).not.toMatch(/:is\(input,\s*textarea,\s*select\):focus-visible/)
    // Und die Hausregel haengt an `:focus-visible` selbst, nicht an einer
    // Elementliste, die das naechste role-basierte Control wieder vergisst.
    expect(CODE).toMatch(new RegExp(`^${HOUSE}`, 'm'))
  })

  it('`.lu-focus-ring` ist gestrichen — Regel und alle neun Call-Sites', () => {
    expect(CODE).not.toMatch(/^\.lu-focus-ring/m)
    const users = COMPONENT_SRC.filter((s) => /className[^\n]*lu-focus-ring/.test(s))
    expect(users).toHaveLength(0)
  })
})

describe('Punkt 4 — der Ring erreicht 3:1 auf jeder Flaeche (WCAG 1.4.11)', () => {
  it.each(DARK_SURFACES)('dunkel: Akzent auf %s', (_name, bg) => {
    expect(contrast(token('color-lu-accent'), bg)).toBeGreaterThanOrEqual(3)
  })

  it.each(LIGHT_SURFACES)('hell: Kante auf %s', (_name, bg) => {
    expect(contrast(token('color-lu-accent-edge'), bg)).toBeGreaterThanOrEqual(3)
  })

  it('der Akzent selbst faellt im Hellmodus durch — das ist der Grund fuer die Kante', () => {
    // Waere das eines Tages nicht mehr so, gehoert die Aufteilung neu
    // entschieden statt dieser Test gestrichen.
    for (const [, bg] of LIGHT_SURFACES) {
      expect(contrast(token('color-lu-accent'), bg)).toBeLessThan(3)
    }
  })

  it('der alte Ring haette es nicht geschafft — hier steht, wie weit daneben', () => {
    // rgba(96,165,250,.6) ueber der Flaeche, also die Farbe, die man
    // tatsaechlich gesehen haette. Kein Nachruf: diese Zeile ist der Beleg
    // dafuer, dass die Aenderung Barrierefreiheit war, nicht Geschmack.
    const alt = (bg: string) => contrast(over('#60a5fa', bg, 0.6), bg)
    for (const [, bg] of LIGHT_SURFACES) expect(alt(bg)).toBeLessThan(2)
    expect(alt('#363636')).toBeLessThan(3)
    expect(alt('#2d2d2d')).toBeLessThan(3)
  })

  it('der halbdurchsichtige Ring-Token waere auf der Composer-Flaeche zu schwach', () => {
    // `--color-lu-accent-ring` trug bis Welle 3 den Fokus von `.lu-control`.
    expect(contrast(over(token('color-lu-accent'), COMPOSER_DARK, 0.55), COMPOSER_DARK)).toBeLessThan(3)
    expect(contrast(over(token('color-lu-accent'), '#f9fafb', 0.55), '#f9fafb')).toBeLessThan(3)
  })
})

describe('Punkt 4 — die Ausnahme steht AN der Regel, nicht gegen sie', () => {
  it('.lu-primary behaelt seinen umgekehrten Ring und erreicht damit weit ueber 3:1', () => {
    const dark = contrast('#ffffff', '#1e1e1e')
    const light = contrast(token('color-lu-on-accent'), '#ffffff')
    expect(dark).toBeGreaterThanOrEqual(3)
    expect(light).toBeGreaterThanOrEqual(3)
    // Und der Grund, warum es NICHT der Akzentring sein darf:
    expect(contrast(token('color-lu-accent'), token('color-lu-accent'))).toBeCloseTo(1, 5)
  })

  it('beide Hausregeln klammern .lu-primary aus — sonst schluege 0,3,0 die 0,2,0', () => {
    // DIE Spezifitaetsfalle dieses Hauses: `.light :focus-visible:not(...)`
    // ist 0,3,0 und wuerde `.lu-primary:focus-visible` (0,2,0) ueberschreiben.
    // Ohne die Klammer haette der Senden-Knopf im Hellmodus still den
    // violetten statt des dunklen Rings getragen — sichtbar erst im
    // gebauten CSS, nicht in der Quelle.
    const focusRules = [...CODE.matchAll(/^(\.light )?:focus-visible[^{\n]*\{/gm)].map((m) => m[0])
    expect(focusRules.length).toBeGreaterThanOrEqual(2)
    for (const r of focusRules) expect(r).toContain(':not(.lu-primary)')
  })

  it('das Rezept der Composer-Leiste hat keinen eigenen, schwaecheren Ring mehr', () => {
    expect(CODE).not.toMatch(/\.lu-control(?!--|__)[^{\n]*:focus-visible[^{\n]*\{/)
  })
})

describe('Punkt 2 — das Press-Feedback ist eine Regel, keine 489 Call-Sites', () => {
  const press =
    CODE.match(/^:is\(button, \[role='button'\]\)[^{\n]*:active\s*\{[^}]*\}/m)?.[0] ?? ''

  it('es gibt sie, sie benutzt `scale` und den Wert aus dem Audit', () => {
    expect(press).not.toBe('')
    expect(press).toMatch(/scale:\s*0\.97/)
    // `transform` wuerde `translate-*`/`rotate-*` an derselben Stelle
    // ueberschreiben — Tailwind v4 benutzt die Einzel-Properties.
    expect(press).not.toMatch(/transform:/)
  })

  it('ein Knopf, der nicht reagiert, tut auch nicht so', () => {
    expect(press).toContain(':not(:disabled)')
    expect(press).toContain(":not([aria-disabled='true'])")
  })

  it('keine einzige Call-Site schreibt `active:scale` dazu', () => {
    expect(ALL_COMPONENTS).not.toMatch(/active:scale/)
  })

  it('und keine schreibt mehr `whileTap` — der Druck ist CSS, kein JS', () => {
    // Vorher waren es die sechs, die der Audit als „6 von 462" zaehlt.
    // framer-motion schreibt dafuer ein inline-`transform` pro Druck, also
    // einen Renderpfad fuer etwas, das der Compositor allein kann — und es
    // multiplizierte sich mit der CSS-Regel (0,96 x 0,97 = 0,93).
    expect(ALL_COMPONENTS).not.toMatch(/whileTap/)
  })

  it('die Groessenordnung, um die es geht, steht hier als Zahl', () => {
    // Die eine Regel deckt jeden dieser Knoepfe. Faellt die Zahl deutlich,
    // ist die Zaehlung im Kommentar von index.css veraltet.
    const buttons = (ALL_COMPONENTS.match(/<(?:motion\.)?button\b/g) ?? []).length
    expect(buttons).toBeGreaterThan(450)
  })

  it('das Rezept, dem seine `transition` gehoert, laesst den Druck weich auslaufen', () => {
    const base = CODE.match(/^\.lu-control\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(base).toMatch(/scale var\(--motion-fast\) var\(--motion-ease\)/)
    // Keine fuenfte Dauer: dieselbe Stufe wie Hover und Farbe.
    expect(base).not.toMatch(/\d+m?s/)
  })
})

// ── Das GEBAUTE CSS ────────────────────────────────────────────────────
// Die Quelle allein beweist die Kaskade nicht: entscheidend ist, dass beide
// Regeln UNGESCHICHTET landen und damit jede Tailwind-Utility aus
// `@layer utilities` schlagen — auch die 67 `outline-none`-Fundstellen, die
// den Ring bisher einzeln abgeschaltet haben. Genau hier ist die
// Spezifitaetsfalle beim letzten Mal aufgefallen.
//
// ── 01.09.2026: WARUM DIESER BLOCK VIER MONATE LANG NICHTS GESAGT HAT ──
//
// Zwei Fehler, die einzeln harmlos aussehen und zusammen unsichtbar waren.
//
// 1. `describe.skipIf(builtCss === null)`. Ohne `dist/` verschwand der ganze
//    Block lautlos aus dem Lauf — und `npx vitest run` BAUT NICHT. Wer nicht
//    vorher `vite build` fuhr, bekam gruen fuer vier Pruefungen, die nie
//    stattgefunden haben. Ein `skipIf`, das niemand sieht, ist kein
//    Ueberspringen, es ist eine falsche Zusage. Jetzt sagt ein Waechter, der
//    IMMER laeuft, warum der Block ausfaellt — derselbe Weg wie
//    `gguf::a_real_gguf_parses_or_the_run_says_why_it_could_not` und die
//    benannten Toepfe in `bundle-size-drift.live.test.ts`.
//
// 2. Die Nadel `':active{scale:.97}'` war zu kurz. Diese Zeichenfolge stand
//    ZWEIMAL im Bundle: als Ende der Tailwind-Utility
//    `.active\:scale-\[0\.97\]:active` INNERHALB des utilities-Layers, und
//    als Ende der Hausregel dahinter. `indexOf` fand die erste, und der Test
//    meldete "die Hausregel liegt im Utilities-Layer" ueber eine Regel, die
//    richtig stand. Die Utility hatte nicht einmal eine Call-Site — sie
//    entstand aus einer Zeile Fliesstext in AUDIT-COVERAGE.md, weil Tailwind
//    das ganze Projektverzeichnis als Text las (siehe der Scan-Bereich am
//    Kopf von index.css und `keine-klasse-aus-prosa.test.ts`).
//
// Dagegen zweierlei: die Press-Nadel traegt jetzt den ganzen Selektorkopf,
// und JEDE Nadel wird gegen ALLE ihre Treffer geprueft statt gegen den
// ersten. Eine Nadel, die zwei verschiedene Regeln nicht unterscheiden kann,
// faellt damit auf, statt stillschweigend die falsche zu messen.
const DIST = resolve(ROOT, 'dist', 'assets')
const BAUBEFEHL = 'rm -rf dist && npx vite build'

/**
 * Das gebaute CSS — oder der Grund, warum es hier keins gibt.
 *
 * Auch „veraltet" zaehlt als „keins": ein Lauf gegen ein `dist/`, das aelter
 * ist als `index.css`, meldet gruen fuer einen Zustand, den die Quelle nicht
 * mehr hat. Genau darauf ist beim Nachpruefen dieses Befundes schon jemand
 * hereingefallen.
 */
const gebaut: { css: string | null; grund: string } = (() => {
  if (!existsSync(DIST)) return { css: null, grund: `es gibt kein ${DIST}` }
  const f = readdirSync(DIST).find((n) => n.startsWith('index-') && n.endsWith('.css'))
  if (!f) return { css: null, grund: `in ${DIST} liegt kein index-*.css` }
  const datei = resolve(DIST, f)
  const gebautAm = statSync(datei).mtimeMs
  const quelleAm = statSync(resolve(SRC, 'index.css')).mtimeMs
  if (gebautAm < quelleAm) {
    const sekunden = Math.round((quelleAm - gebautAm) / 1000)
    return { css: null, grund: `${f} ist ${sekunden}s AELTER als src/index.css — das Bundle kennt die Quelle nicht, die hier geprueft werden soll` }
  }
  return { css: readFileSync(datei, 'utf8'), grund: '' }
})()

describe('der Beweis am gebauten CSS findet ueberhaupt statt', () => {
  it('es liegt ein frisch gebautes index-*.css bereit — sonst steht hier, warum nicht', (ctx) => {
    if (gebaut.css !== null) {
      // Nicht bloss „nicht null": ein leeres Bundle waere derselbe stille
      // Ausfall in gruen.
      expect(gebaut.css.length, 'das gebaute CSS ist verdaechtig kurz').toBeGreaterThan(1000)
      return
    }
    const meldung =
      `\n  UEBERSPRUNGEN: die vier Pruefungen am gebauten CSS in fokusring-und-press.test.ts\n` +
      `  Grund: ${gebaut.grund}\n` +
      `  Was damit UNGEPRUEFT bleibt: ob Fokusring und Press-Regel im ausgelieferten\n` +
      `  Bundle wirklich ausserhalb von @layer utilities landen. Die Quelle allein\n` +
      `  beweist das nicht.\n` +
      `  Dagegen: ${BAUBEFEHL}\n`
    // Zwei Wege, damit es keiner uebersieht: der Report zeigt den Grund am
    // uebersprungenen Test, `stderr` zeigt ihn im Terminal.
    process.stderr.write(meldung)
    ctx.skip(gebaut.grund)
  })
})

describe.skipIf(gebaut.css === null)('im gebauten CSS, nicht nur in der Quelle', () => {
  const css = gebaut.css ?? ''

  /** Ende des `@layer utilities`-Blocks: alles danach ist ungeschichtet. */
  const utilitiesEnd = (() => {
    const start = css.indexOf('@layer utilities{')
    if (start < 0) return -1
    let depth = 0
    for (let i = start + '@layer utilities'.length; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) return i
    }
    return -1
  })()

  it('der Utilities-Layer ist ueberhaupt gefunden worden', () => {
    expect(utilitiesEnd).toBeGreaterThan(0)
  })

  /** Jede Stelle, an der die Nadel im Bundle steht — nicht nur die erste. */
  const alleTreffer = (nadel: RegExp): number[] =>
    [...css.matchAll(new RegExp(nadel.source, nadel.flags.includes('g') ? nadel.flags : nadel.flags + 'g'))].map((m) => m.index)

  /**
   * Der Selektorkopf der Press-Hausregel, so wie er WIRKLICH im Bundle steht.
   *
   * Die Anfuehrungszeichen um `button` und `true` wirft der Minifier weg
   * (gemessen am gebauten CSS, nicht geraten) — sie sind hier optional, damit
   * der Test nicht die eine oder die andere Schreibweise raet. Was NICHT
   * optional ist, ist der Kopf selbst: er ist der einzige Unterschied
   * zwischen der Hausregel und einer Utility, die auf dieselben achtzehn
   * Zeichen endet.
   */
  const PRESS = /:is\(button,\s*\[role=['"]?button['"]?\]\):not\(:disabled\):not\(\[aria-disabled=['"]?true['"]?\]\):active\{scale:\.97\}/
  const FOKUSRING = /:focus-visible:not\(\[tabindex="-1"\]\):not\(\.lu-primary\)/

  it('Fokusring und Press-Regel stehen ausserhalb jedes @layer — an JEDER Fundstelle', () => {
    for (const [name, nadel] of [['Fokusring', FOKUSRING], ['Press-Regel', PRESS]] as const) {
      const treffer = alleTreffer(nadel)
      expect(treffer.length, `${name} (${nadel.source}) fehlt im gebauten CSS`).toBeGreaterThan(0)
      // Alle, nicht der erste. Genau hier hat der Test bisher danebengegriffen.
      for (const at of treffer) {
        expect(at, `${name}: eine Fundstelle liegt im Utilities-Layer (${at} < ${utilitiesEnd})`).toBeGreaterThan(utilitiesEnd)
      }
    }
  })

  it('die Press-Nadel trifft die Hausregel und sonst nichts', () => {
    // Der eigentliche Lehrsatz des Befundes vom 01.09.2026: eine Nadel, die
    // Hausregel und Utility nicht auseinanderhalten kann, misst frueher oder
    // spaeter die falsche. Es gibt genau EINE Press-Hausregel in index.css —
    // also darf es genau EINEN Treffer geben.
    expect(alleTreffer(PRESS)).toHaveLength(1)
  })

  it('keine Utility endet auf dieselben Zeichen wie die Press-Hausregel', () => {
    // Die kurze Nadel von frueher, bewusst behalten: sie darf im ganzen
    // Bundle nur noch da stehen, wo auch die Hausregel steht. Taucht sie
    // oefter auf, hat wieder jemand `active:scale-[0.97]` erzeugt — durch
    // eine Call-Site (dann gehoert sie geloescht, die Hausregel deckt es ab)
    // oder durch Prosa im Scan-Bereich (siehe keine-klasse-aus-prosa.test.ts).
    const kurz = alleTreffer(/:active\{scale:\.97\}/)
    expect(
      kurz,
      `':active{scale:.97}' steht ${kurz.length}x im Bundle @ ${kurz.join(', ')} — erwartet: nur die Hausregel`,
    ).toHaveLength(1)
    expect(kurz[0]).toBeGreaterThan(utilitiesEnd)
  })

  it('die Ausnahme des Primaer-Rezepts steht nach der Hausregel und ist ungeschichtet', () => {
    const house = css.indexOf(':focus-visible:not([tabindex="-1"]):not(.lu-primary){outline:2px')
    const primary = css.indexOf('.lu-primary:focus-visible{')
    expect(house).toBeGreaterThan(utilitiesEnd)
    expect(primary).toBeGreaterThan(house)
  })

  it('kein `outline:none` einer Utility steht mehr NACH der Hausregel', () => {
    // Ungeschichtet schlaegt geschichtet unabhaengig von der Reihenfolge —
    // aber wenn eine ungeschichtete `outline:none`-Regel dazukaeme, waere
    // genau das die naechste stille Regression.
    const house = css.indexOf(':focus-visible:not([tabindex="-1"]):not(.lu-primary){outline:2px')
    const tail = css.slice(house)
    expect(tail).not.toMatch(/[^-]outline:none/)
  })
})
