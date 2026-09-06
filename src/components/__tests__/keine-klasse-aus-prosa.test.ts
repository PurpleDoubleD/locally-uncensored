/**
 * Keine Klasse aus Prosa — was im Bundle steht, muss jemand aufrufen.
 *
 * ── Der Befund vom 01.09.2026 ──
 *
 * Tailwind 4 hat keine Klassenliste; es liest Dateien als TEXT und macht aus
 * jedem Wort, das wie eine Klasse aussieht, eine Regel. Ohne Einschraenkung
 * ist "jede Datei" woertlich gemeint: Markdown im Wurzelverzeichnis, die
 * Marketing-Website unter docs/, die Kommentare des Rust-Backends unter
 * src-tauri/, das Stylesheet selbst, jede Testdatei.
 *
 * Gemessen wurde das an echten Builds, im A/B/A-Muster gegen denselben
 * Quellstand:
 *
 *   ausserhalb von src/     9 Klassen, 10 Regeln,  755 Bytes roh / 143 gzip
 *   aus src/**\/__tests__  20 Klassen, 21 Regeln, 1199 Bytes roh / 211 gzip
 *
 * Keine einzige davon hatte eine Call-Site. `active:scale-[0.97]` entstand
 * aus einer Zeile in einer Audit-Tabelle, `max-w-[760px]` aus der
 * Beschreibung ihrer eigenen Entfernung, `[hhhh:hhhh]` aus einem Kommentar
 * ueber GPU-IDs, `isolate` aus dem englischen Fliesstext eines Blogeintrags.
 * Aus den Platzhaltern `bg-[#...]` und `text-[…]` in Testkommentaren wurden
 * Regeln mit buchstaeblich `#...` und `…` als CSS-Wert.
 *
 * Das Gewicht ist klein. Der Grund ist es nicht, und er hatte Folgen: die
 * Utility `.active\:scale-\[0\.97\]:active` endet auf dieselben achtzehn
 * Zeichen wie die Press-Hausregel und stand im Bundle VOR ihr. Der Test, der
 * die Kaskade prueft, hat vier Monate lang die Utility gemessen und die
 * Hausregel gemeldet (siehe fokusring-und-press.test.ts).
 *
 * ── Was dieser Test bewacht ──
 *
 * Der Scan-Bereich am Kopf von index.css ist die Reparatur. Dieser Test ist
 * das, was sie festhaelt — und er leitet seine Frage NICHT aus den
 * `@source`-Zeilen ab, sonst wuerde er jede Erweiterung des Scans
 * mitunterschreiben. Er hat seine eigene Definition davon, was eine
 * Call-Site ist:
 *
 *     index.html + alles unter src/, ausser __tests__ und index.css.
 *
 * Genauso zaehlt dieses Haus schon: `componentFiles()` in
 * fokusring-und-press.test.ts ueberspringt `__tests__`, wenn es Call-Sites
 * sucht, und index.css ist die Regel-Seite, nicht die Aufruf-Seite. index.css
 * steht hier auch dann im Heuhaufen NICHT, wenn Tailwind sie ohnehin nie
 * scannt — sollte sich das eines Tages aendern, faellt dieser Test um statt
 * die neuen Klassen durchzuwinken.
 *
 * Und er prueft in BEIDE Richtungen. Zu weit gescannt heisst Prosa im
 * Bundle; zu eng gescannt heisst, dass Klassen still fehlen und die
 * Oberflaeche unformatiert bricht. Das zweite waere der schlimmere Fehler,
 * deshalb steht er hier mit.
 *
 * ── Was er NICHT kann ──
 *
 * Ein Textscanner kann Code nicht von Kommentar unterscheiden. Klassen, die
 * nur in einem Kommentar EINER GESCANNTEN Datei stehen, kommen weiter ins
 * Bundle. Am 01.09.2026 waren das acht (unten namentlich). Sie sind kein
 * Fehlalarm und kein Freibrief: sie stehen in einem eigenen Topf, werden
 * gezaehlt, ausgegeben — und die Liste darf nicht wachsen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..')
const SRC = resolve(ROOT, 'src')
const DIST = resolve(ROOT, 'dist', 'assets')
const BAUBEFEHL = 'rm -rf dist && npx vite build'

// ── Das gebaute CSS, oder der Grund, warum es hier keins gibt ──────────
//
// „Veraltet" zaehlt als „keins": ein Lauf gegen ein dist/, das aelter ist als
// die Scan-Regel in index.css, meldet gruen fuer einen Zustand, den die
// Quelle nicht mehr hat. Genau darauf ist beim Nachpruefen dieses Befundes
// schon jemand hereingefallen.
//
// Gemessen wird gegen index.css, weil dort die Regel steht, die hier
// geprueft wird. Gegen JEDE Quelldatei zu messen waere strenger und in
// diesem Arbeitsbaum unbrauchbar — es genuegt ein fremder Edit an einer
// .tsx, und der Block schaltete sich ab. Wie viele Quellen neuer sind als
// das Bundle, sagt der Waechter unten trotzdem.
const gebaut: { css: string | null; datei: string; grund: string } = (() => {
  if (!existsSync(DIST)) return { css: null, datei: '', grund: `es gibt kein ${DIST}` }
  const f = readdirSync(DIST).find((n) => n.startsWith('index-') && n.endsWith('.css'))
  if (!f) return { css: null, datei: '', grund: `in ${DIST} liegt kein index-*.css` }
  const pfad = resolve(DIST, f)
  const gebautAm = statSync(pfad).mtimeMs
  const regelAm = statSync(resolve(SRC, 'index.css')).mtimeMs
  if (gebautAm < regelAm) {
    return {
      css: null,
      datei: f,
      grund: `${f} ist ${Math.round((regelAm - gebautAm) / 1000)}s AELTER als src/index.css — das Bundle kennt die Scan-Regel nicht, die hier geprueft wird`,
    }
  }
  return { css: readFileSync(pfad, 'utf8'), datei: f, grund: '' }
})()

/** Quelldateien, die spaeter geschrieben wurden als das Bundle. */
function neuerAlsBundle(): string[] {
  if (gebaut.css === null) return []
  const bundleAm = statSync(resolve(DIST, gebaut.datei)).mtimeMs
  return quellDateien()
    .filter((p) => statSync(p).mtimeMs > bundleAm)
    .map((p) => p.slice(ROOT.length + 1))
}

// ── Was als Call-Site zaehlt ───────────────────────────────────────────

/** index.html + alles unter src/, ausser __tests__ und index.css. */
function quellDateien(dir = SRC): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__') continue
    const p = resolve(dir, e.name)
    if (e.isDirectory()) out.push(...quellDateien(p))
    else if (/\.(ts|tsx|svg)$/.test(e.name)) out.push(p)
  }
  return out
}

const QUELLEN = [...quellDateien(), resolve(ROOT, 'index.html')]
const VOLLTEXT = QUELLEN.map((p) => readFileSync(p, 'utf8')).join('\n')

/**
 * Derselbe Schnitt wie in fokusring-und-press.test.ts: `/* *\/` und `//`
 * raus, `://` in URLs geschont. Damit laesst sich sagen, ob eine Klasse im
 * Code steht oder nur in einer Notiz darueber.
 */
const nurCode = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const CODETEXT = QUELLEN.map((p) => nurCode(readFileSync(p, 'utf8'))).join('\n')

/**
 * index.css als Volltext, und ihre At-Regeln als eigene Liste.
 *
 * Zwei Anlaeufe, zwei Fallen — beide dieselbe Sorte wie der Befund selbst:
 *
 * 1. `.slice(0, 4000)`. Eine Zeichengrenze, damit die Pruefung auf `@source`
 *    nicht ein Zitat aus dem Kommentar findet statt der Zeile. Der
 *    Scan-Kommentar wuchs beim Aufschreiben ueber die Grenze, und drei
 *    Pruefungen fanden schlagartig gar nichts mehr — gruen, weil sie ins
 *    Leere sahen.
 * 2. Kommentare mit `/* … *\/` wegschneiden. Der Glob `"./**\/__tests__/**"`
 *    ENTHAELT die Zeichenfolge Schraegstrich-Stern-Stern-Schraegstrich, also
 *    einen leeren CSS-Kommentar. Der Schnitt frass ausgerechnet die Zeile,
 *    die er beweisen sollte.
 *
 * Deshalb hier keine Heuristik: die At-Regeln sind die Zeilen, die ohne
 * Einrueckung mit `@` beginnen. Im Scan-Kommentar ist jede Zeile eingerueckt,
 * ein Zitat kann also nicht als Direktive durchgehen.
 */
const REGEL_TEXT = readFileSync(resolve(SRC, 'index.css'), 'utf8')
const REGEL_CODE = REGEL_TEXT.split('\n').filter((z) => /^@/.test(z)).join('\n')

// ── Die Utilities des Bundles ──────────────────────────────────────────

/** Ende des `@layer utilities`-Blocks; -1, wenn es ihn nicht gibt. */
function utilitiesSpanne(css: string): [number, number] {
  const start = css.indexOf('@layer utilities{')
  if (start < 0) return [-1, -1]
  let depth = 0
  for (let i = start + '@layer utilities'.length; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return [start, i]
  }
  return [start, -1]
}

/**
 * Alle Klassennamen aus dem utilities-Layer, entschaerft.
 *
 * `.active\:scale-\[0\.97\]:active` -> `active:scale-[0.97]`. Ein
 * Backslash nimmt das naechste Zeichen woertlich; ein UNescaptes Zeichen aus
 * der Stopp-Menge beendet den Namen. Ohne diese Unterscheidung zerfaellt
 * jede arbitraere Klasse in Bruchstuecke — der erste Anlauf dieser Messung
 * meldete deshalb `97` als Klassennamen.
 */
function utilityKlassen(css: string): Set<string> {
  const [s, e] = utilitiesSpanne(css)
  const out = new Set<string>()
  if (s < 0 || e < 0) return out
  const body = css.slice(s, e + 1)
  const STOPP = new Set('.:,{ \t\n>+~[]()#*"\'=|^$!')
  let i = 0
  while (i < body.length) {
    const naechstes = body[i + 1] ?? ''
    if (body[i] === '.' && (/[a-zA-Z]/.test(naechstes) || naechstes === '-' || naechstes === '_' || naechstes === '\\')) {
      let j = i + 1
      const buf: string[] = []
      while (j < body.length) {
        const c = body[j]
        if (c === '\\' && j + 1 < body.length) { buf.push(body[j + 1]); j += 2; continue }
        if (STOPP.has(c)) break
        buf.push(c); j++
      }
      if (buf.length > 0) out.add(buf.join(''))
      i = j
    } else i++
  }
  return out
}

// ── Der bekannte Rest: Klassen, die nur in einem Kommentar stehen ──────
//
// Ein Textscanner kann das nicht trennen, also stehen sie hier — jede mit
// dem Ort, an dem sie erklaert wird. Wer eine dazubekommt, hat eine Klasse
// ausgeliefert, die niemand aufruft: entweder die Notiz umschreiben (Backticks
// helfen nicht, der Scanner liest sie mit) oder, wenn sie doch gebraucht wird,
// eine echte Call-Site daraus machen. Die Liste darf schrumpfen, nicht wachsen.
const NUR_IN_EINER_NOTIZ: Record<string, string> = {
  'bg-red-400/80': 'Farbnotiz in einer Komponente',
  'border-blue-500/40': 'Farbnotiz in einer Komponente',
  'lowercase': 'Wort in einem Kommentar, zufaellig auch eine Tailwind-Utility',
  'max-h-36': 'Massnotiz in einem Kommentar',
  'max-h-[52vh]': 'Massnotiz in einem Kommentar',
  'max-w-[150px]': 'Massnotiz in einem Kommentar',
  'max-w-[520px]': 'Massnotiz in einem Kommentar',
  'opacity-20': 'Wert in einem Kommentar',
}

describe('der Beweis am gebauten CSS findet ueberhaupt statt', () => {
  it('es liegt ein frisch gebautes index-*.css bereit — sonst steht hier, warum nicht', (ctx) => {
    if (gebaut.css !== null) {
      expect(gebaut.css.length, 'das gebaute CSS ist verdaechtig kurz').toBeGreaterThan(1000)
      const veraltet = neuerAlsBundle()
      if (veraltet.length > 0) {
        // Kein Fehlschlag: an diesem Baum arbeitet mehr als einer. Aber
        // sichtbar, denn diese Dateien sind im gemessenen Bundle nicht drin.
        process.stderr.write(
          `\n  HINWEIS ${veraltet.length} Quelldatei(en) sind neuer als ${gebaut.datei}:\n` +
          `    ${veraltet.slice(0, 8).join('\n    ')}${veraltet.length > 8 ? `\n    … und ${veraltet.length - 8} weitere` : ''}\n` +
          `  Ihre Klassen sind in dieser Messung NICHT enthalten. Dagegen: ${BAUBEFEHL}\n`,
        )
      }
      return
    }
    const meldung =
      `\n  UEBERSPRUNGEN: alle Pruefungen in keine-klasse-aus-prosa.test.ts\n` +
      `  Grund: ${gebaut.grund}\n` +
      `  Was damit UNGEPRUEFT bleibt: ob Tailwind wieder Klassen aus Prosa ins\n` +
      `  ausgelieferte CSS schreibt, und ob der Scan noch alle App-Quellen sieht.\n` +
      `  Dagegen: ${BAUBEFEHL}\n`
    process.stderr.write(meldung)
    ctx.skip(gebaut.grund)
  })
})

describe.skipIf(gebaut.css === null)('jede Utility im Bundle gehoert jemandem', () => {
  const css = gebaut.css ?? ''
  const klassen = [...utilityKlassen(css)]

  /** Jede Klasse landet in genau einem benannten Topf. Kein stilles Weiter. */
  const toepfe = (() => {
    const imCode: string[] = []
    const nurNotiz: string[] = []
    const heimatlos: string[] = []
    for (const k of klassen) {
      if (CODETEXT.includes(k)) imCode.push(k)
      else if (VOLLTEXT.includes(k)) nurNotiz.push(k)
      else heimatlos.push(k)
    }
    return { imCode, nurNotiz: nurNotiz.sort(), heimatlos: heimatlos.sort() }
  })()

  it('die Buchhaltung geht auf — jede Klasse in genau einem Topf', () => {
    const summe = toepfe.imCode.length + toepfe.nurNotiz.length + toepfe.heimatlos.length
    process.stderr.write(
      `\n  [Prosa-Waechter] ${gebaut.datei}: ${klassen.length} Utility-Klassen`
      + ` · im Code ${toepfe.imCode.length}`
      + ` · nur in einer Notiz ${toepfe.nurNotiz.length}`
      + ` · ohne Fundstelle ${toepfe.heimatlos.length}\n`,
    )
    for (const k of toepfe.nurNotiz) {
      process.stderr.write(`  [Prosa-Waechter] nur in einer Notiz: ${k}\n`)
    }
    expect(summe, 'faellt eine Klasse durch alle Toepfe, ist genau das wieder ein stiller Uebersprung').toBe(klassen.length)
    // Hat die Messung ueberhaupt stattgefunden? Gruen, weil der Layer nicht
    // gefunden wurde, waere schlimmer als rot.
    expect(klassen.length, 'im gebauten CSS steht praktisch kein @layer utilities — die Messung sagt nichts').toBeGreaterThan(800)
  })

  it('keine Utility ohne jede Fundstelle in den App-Quellen', () => {
    expect(
      toepfe.heimatlos,
      `Diese Klassen stehen im ausgelieferten CSS, aber in keiner App-Quelle:\n`
      + toepfe.heimatlos.map((k) => `  .${k}`).join('\n')
      + `\n\nSie kommen aus einer Datei, die die App nicht ist — Markdown, docs/,`
      + ` src-tauri/, ein Test — und Tailwind hat sie als Text gelesen.`
      + ` Der Scan-Bereich am Kopf von src/index.css ist zu weit.`,
    ).toEqual([])
  })

  it('die Liste der Klassen, die nur in einer Notiz stehen, waechst nicht', () => {
    const neu = toepfe.nurNotiz.filter((k) => !(k in NUR_IN_EINER_NOTIZ))
    expect(
      neu,
      `Neu im Bundle, ohne Call-Site, nur in einem Kommentar erwaehnt:\n`
      + neu.map((k) => `  .${k}`).join('\n')
      + `\n\nEntweder die Notiz umschreiben, sodass der Scanner nichts findet`
      + ` (Backticks helfen nicht — er liest sie mit), oder eine echte`
      + ` Call-Site daraus machen. Wer sie hier eintraegt, muss sagen, warum`
      + ` sie bleiben darf.`,
    ).toEqual([])
    // Schrumpfen ist ausdruecklich erlaubt und wird nur angesagt.
    const weg = Object.keys(NUR_IN_EINER_NOTIZ).filter((k) => !toepfe.nurNotiz.includes(k))
    if (weg.length > 0) {
      process.stderr.write(`\n  [Prosa-Waechter] aufgeraeumt, darf aus NUR_IN_EINER_NOTIZ raus: ${weg.join(', ')}\n`)
    }
  })
})

describe.skipIf(gebaut.css === null)('der Scan ist nicht zu eng geworden', () => {
  const css = gebaut.css ?? ''

  it('die Klassen aus index.html sind im Bundle', () => {
    // `dark` ist der Schalter des Variants (`@custom-variant dark`), keine
    // Utility — er erzeugt keine eigene Regel und ist deshalb ausgenommen.
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8')
    const genannt = [...html.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter((k) => k.length > 0 && k !== 'dark')
    // Heute traegt index.html keine Utility. Sobald jemand eine hineinschreibt,
    // prueft dieser Test sie echt — und faellt um, wenn `@source
    // "../index.html"` verschwindet.
    if (genannt.length === 0) {
      process.stderr.write(
        `\n  [Prosa-Waechter] index.html traegt ausser \`dark\` keine Klasse.`
        + ` Dass sie gescannt wird, kann dieser Test daher nicht beweisen —`
        + ` nachgemessen wurde es am 01.09.2026 von Hand (eine Klasse`
        + ` eingesetzt, gebaut, im Bundle wiedergefunden, zurueckgebaut).\n`,
      )
    }
    for (const k of genannt) {
      const escaped = k.replace(/[.:/[\]()#%,!]/g, (c) => `\\${c}`)
      expect(css, `\`${k}\` steht in index.html, aber nicht im Bundle — wird index.html noch gescannt?`)
        .toContain(`.${escaped}`)
    }
  })

  it('die Grundformen aus den Bauteilen sind da', () => {
    // Wenn `@source "./"` verschwaende, waere das Bundle nicht leer (die
    // Rezepte in index.css bleiben) — es fehlten die Utilities. Diese sechs
    // stehen in dreistelliger Zahl in den Komponenten; sie koennen nicht
    // ausserplanmaessig verschwinden.
    for (const k of ['flex', 'items-center', 'text-xs', 'rounded-md', 'w-full', 'gap-2']) {
      expect(css, `\`${k}\` fehlt im Bundle — sieht der Scan die Bauteile unter src/ noch?`)
        .toContain(`.${k}{`)
    }
  })

  it('kein Bauteil-Verzeichnis ist stillschweigend aus dem Scan gefallen', () => {
    // Eine Stichprobe pro Ecke, aus dem Quelltext gezogen statt abgeschrieben:
    // die erste Klasse der Form `text-[NNpx]`/`w-[NNpx]`/`max-w-[NNpx]` in
    // einem className-Literal. Waere ein Verzeichnis nicht mehr gescannt,
    // fehlte seine Klasse im Bundle.
    const ecken = ['chat', 'layout', 'settings', 'ui']
    const geprueft: string[] = []
    for (const ecke of ecken) {
      const dir = resolve(SRC, 'components', ecke)
      if (!existsSync(dir)) continue
      const dateien = quellDateien(dir).filter((p) => p.endsWith('.tsx'))
      let gefunden: string | null = null
      for (const p of dateien) {
        const code = nurCode(readFileSync(p, 'utf8'))
        for (const m of code.matchAll(/className="([^"]*)"/g)) {
          const treffer = m[1].split(/\s+/).find((k) => /^(?:text|w|max-w|h|min-w)-\[\d+px\]$/.test(k))
          if (treffer) { gefunden = treffer; break }
        }
        if (gefunden) break
      }
      if (!gefunden) continue
      const escaped = gefunden.replace(/[[\]]/g, (c) => `\\${c}`)
      expect(css, `\`${gefunden}\` steht in src/components/${ecke}/, fehlt aber im Bundle`)
        .toContain(`.${escaped}`)
      geprueft.push(`${ecke}:${gefunden}`)
    }
    expect(geprueft.length, `keine einzige Ecke lieferte eine pruefbare Klasse (${ecken.join(', ')})`).toBeGreaterThan(0)
    process.stderr.write(`\n  [Prosa-Waechter] Ecken belegt: ${geprueft.join(' · ')}\n`)
  })

  it('der Scan-Bereich in index.css sagt, was er sieht — und was nicht', () => {
    // Die Regel selbst ist eine Quelle wie jede andere: sie darf nicht
    // stillschweigend verschwinden. `source(none)` ohne ein einziges
    // `@source` waere ein Bundle ganz ohne Utilities.
    expect(REGEL_CODE, 'die Scan-Einschraenkung fehlt — Tailwind liest wieder das ganze Projektverzeichnis')
      .toContain('@import "tailwindcss" source(none)')
    expect(REGEL_CODE, 'ohne diese Zeile werden die Bauteile unter src/ nicht mehr gescannt')
      .toMatch(/@source\s+"\.\/"/)
    expect(REGEL_CODE, 'ohne diese Zeile werden die Klassen in index.html nicht mehr gescannt')
      .toMatch(/@source\s+"\.\.\/index\.html"/)
  })
})

describe('was dieser Test ueber sich selbst weiss', () => {
  it('er liegt in __tests__ und wird deshalb selbst nicht gescannt', () => {
    // Der Grund, warum oben ueber `active:scale-[0.97]` und `bg-[#...]`
    // geschrieben werden darf, ohne sie zu erzeugen. Faellt der Ausschluss
    // weg, erzeugt ausgerechnet dieser Test die Klassen, gegen die er
    // gerichtet ist. Nachgemessen am 01.09.2026: ohne die Zeile standen
    // `.max-w-[NNpx]`, `.text-[NNpx]` und `.w-[NNpx]` im Bundle — die
    // Platzhalter aus dem Kommentar der Ecken-Stichprobe weiter oben.
    expect(__dirname.split(sep)).toContain('__tests__')
    expect(REGEL_CODE).toMatch(/@source\s+not\s+"\.\/\*\*\/__tests__\/\*\*"/)
  })

  it('index.css braucht keinen Ausschluss — Tailwind scannt sein eigenes Stylesheet nicht', () => {
    // Nachgemessen, nicht angenommen: mit `@source not "./index.css"` war das
    // Bundle byte-identisch. Die Klassen, die im Scan-Kommentar dort oben als
    // Beispiele stehen, sind der laufende Beleg — stuenden sie im Bundle,
    // waere index.css doch eine Quelle und der Kommentar eine Falle.
    const css = gebaut.css
    if (css === null) return // der Waechter oben hat den Grund schon gesagt
    for (const beispiel of ['max-w-[760px]', 'hhhh:hhhh', 'text-[…]']) {
      expect(REGEL_TEXT, `das Beispiel \`${beispiel}\` steht nicht mehr im Scan-Kommentar — dieser Beleg laeuft ins Leere`)
        .toContain(beispiel)
      const escaped = beispiel.replace(/[.:/[\]()#%,!…]/g, (c) => `\\${c}`)
      expect(css, `\`${beispiel}\` steht nur im Kommentar von index.css, ist aber im Bundle — index.css wird also doch gescannt`)
        .not.toContain(`.${escaped}`)
    }
  })
})
