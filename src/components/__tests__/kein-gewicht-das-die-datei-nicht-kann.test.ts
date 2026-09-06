/**
 * Nachtrag zu D-T03: keine `@font-face`-Deklaration behauptet ein Gewicht,
 * das ihre Datei nicht tragen kann.
 *
 * ── Der Verdacht, und warum er nicht zutrifft ──
 *
 * Beim Nachpruefen von D-T03 fiel auf, dass Space Grotesk in
 * `public/fonts/lu-fonts.css` SECHS Deklarationen hat, aber nur DREI
 * physische Dateien — 500 und 700 zeigen paarweise auf dieselbe Datei, per
 * sha256 verglichen identisch:
 *
 *     500 → 534357209344.woff2 ( 6772 B)   700 → dieselbe Datei
 *     500 → e911c2d94a1e.woff2 (18924 B)   700 → dieselbe Datei
 *     500 → a57c9413b9ba.woff2 (22320 B)   700 → dieselbe Datei
 *
 * Der naheliegende Schluss waere: die CSS deklariert einen fetten Schnitt,
 * den die App nicht besitzt, und `font-bold` auf Displaytext waere still
 * wirkungslos — der Browser synthetisiert nicht, wenn eine `@font-face` das
 * Gewicht behauptet.
 *
 * Nachgemessen ist der Schluss falsch, und zwar aus zwei Richtungen.
 *
 * ERSTENS, aus der Datei. Alle drei Dateien tragen `fvar`, `gvar` und
 * `STAT`: es sind VARIABLE Schriften mit einer `wght`-Achse von 300 bis
 * 700. Eine Datei kann damit jedes Gewicht dieses Bereichs tragen; der
 * `font-weight`-Deskriptor einer `@font-face` stellt die Achse ein. Die drei
 * Dateien sind nicht drei Gewichte, sondern drei UNICODE-BEREICHE
 * (vietnamesisch / latin-ext / latin) — daher auch ihre sehr
 * unterschiedlichen Groessen.
 *
 * Und es ist kein Sonderfall dieser einen Familie: Inter deklariert sieben
 * Dateien fuer je 400/500/600 und JetBrains Mono sechs Dateien fuer je
 * 500/600 — auch dort ist jede Datei bei allen ihren Gewichten dieselbe.
 * Eine Regel „jede Deklaration braucht eine eigene Datei" wuerde deshalb
 * nicht drei, sondern ALLE 39 Deklarationen anschwaerzen.
 *
 * ZWEITENS, aus dem Fenster. Im Canvas gerendert und die Deckung summiert
 * (Chromium 149, „Handgloves 700" bei 100px, alpha-Summe / 255):
 *
 *     Space Grotesk   300/400/500 → 19688     600/700 → 23028   (+17,0 %)
 *     Inter           300/400 → 17994   500 → 20894   600/700 → 23730
 *     JetBrains Mono  300/400/500 → 20941      600/700 → 22238
 *     serif (Kontrolle) 400 → 13054              700 → 19315
 *
 * `font-bold` ist also nicht wirkungslos: es rendert 17 % mehr Deckung. Die
 * Stufen liegen genau dort, wo die CSS Deklarationen hat — 300 und 400
 * fallen auf den 500er-Schnitt, weil es darunter keine Deklaration gibt.
 * Das ist korrektes CSS-Font-Matching, kein Defekt.
 *
 * Nebenbei korrigiert das die BEGRUENDUNG einer frueheren Messung: in
 * `die-typo-leiter-und-ihre-umgehung.test.ts` steht, dass `font-weight: 600`
 * auf den 700er-Schnitt faellt, belegt an der Textbreite (1094,18 gegen
 * 1094,34). Die Breite war dafuer ein schwaches Indiz — Space Grotesk
 * stammt von Space Mono ab und aendert beim Fetten fast nur die
 * Strichstaerke, nicht die Vorbreite (771,52 → 772,50 px, +0,13 %). Der
 * Schluss stimmte, das Messmittel war unscharf; die Deckung oben ist das
 * scharfe.
 *
 * ── Was dieser Test also ist ──
 *
 * Keine Reparatur, sondern eine Wache: es gab nichts zu reparieren, aber
 * der Fehler, den der Verdacht beschreibt, WAERE echt, wenn jemand eine
 * statische Datei einbaut und ein Gewicht daraufschreibt, das sie nicht
 * hat. Die Regel steht deshalb als Regel ueber die DATEI da und nicht als
 * Aufzaehlung dieser drei Faelle: jede Deklaration muss ein Gewicht
 * behaupten, das ihre Datei tragen kann — variabel auf der Achse, statisch
 * als ihr einziger Schnitt.
 *
 * ── Was hier NICHT geprueft werden kann ──
 *
 *   • ob die Schrift gut aussieht.
 *   • ob 700 fett genug ist. Die 17 % stehen oben als Messwert; ob das
 *     reicht, ist eine Entscheidung.
 *   • ob der Browser die Achse wirklich einstellt. Das braucht ein Fenster;
 *     die Canvas-Messung oben ist der Beleg, dieser Test liest die Datei.
 *
 * Run: npx vitest run src/components/__tests__/kein-gewicht-das-die-datei-nicht-kann.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import {
  deklarationen,
  gewichtsLuegen,
  schnittvermoegen,
  type Schnittvermoegen,
} from './woff2-tabellen'

const ROOT = resolve(__dirname, '..', '..', '..')
const CSS_PFAD = resolve(ROOT, 'public', 'fonts', 'lu-fonts.css')
const CSS = readFileSync(CSS_PFAD, 'utf8')
const BASIS = dirname(CSS_PFAD)
const DEKLARATIONEN = deklarationen(CSS)

/** Die Datei einer Deklaration, einmal geoeffnet und dann gemerkt. */
const gemerkt = new Map<string, Schnittvermoegen>()
const echterAufloeser = (url: string): Schnittvermoegen => {
  let v = gemerkt.get(url)
  if (!v) {
    v = schnittvermoegen(resolve(BASIS, url))
    gemerkt.set(url, v)
  }
  return v
}

describe('die Wache: kein Gewicht, das die Datei nicht kann', () => {
  it('es gibt ueberhaupt Deklarationen zu pruefen', () => {
    // Ein Parser, der nichts findet, meldet fuer immer gruen.
    expect(DEKLARATIONEN.length).toBe(39)
    expect(new Set(DEKLARATIONEN.map((d) => d.familie))).toEqual(
      new Set(['Inter', 'JetBrains Mono', 'Space Grotesk']),
    )
  })

  it('jede referenzierte Schriftdatei liegt wirklich da', () => {
    for (const d of DEKLARATIONEN) {
      expect(existsSync(resolve(BASIS, d.url)), `fehlt: ${d.url}`).toBe(true)
    }
  })

  it('keine einzige Deklaration behauptet ein Gewicht, das ihre Datei nicht traegt', () => {
    expect(gewichtsLuegen(DEKLARATIONEN, echterAufloeser)).toEqual([])
  })

  it('und die Regel ist an allen drei Familien gruen, nicht nur an der verdaechtigen', () => {
    // Die Gegenprobe gegen Sproedigkeit: eine Regel, die Variable Fonts
    // nicht versteht, faellt hier ueber Inter und JetBrains Mono.
    for (const familie of ['Inter', 'JetBrains Mono', 'Space Grotesk']) {
      const nurDiese = DEKLARATIONEN.filter((d) => d.familie === familie)
      expect(nurDiese.length, familie).toBeGreaterThan(0)
      expect(gewichtsLuegen(nurDiese, echterAufloeser), familie).toEqual([])
    }
  })
})

describe('der Befund selbst, damit er nicht still verschwindet', () => {
  it('Space Grotesk hat sechs Deklarationen auf drei Dateien — und das ist in Ordnung', () => {
    const sg = DEKLARATIONEN.filter((d) => d.familie === 'Space Grotesk')
    expect(sg.length).toBe(6)
    const dateien = new Set(sg.map((d) => d.url))
    expect(dateien.size).toBe(3)
    // Paarweise wirklich dieselbe Datei, nicht nur derselbe Name.
    const hashes = new Map<string, string>()
    for (const url of dateien) {
      hashes.set(url, createHash('sha256').update(readFileSync(resolve(BASIS, url))).digest('hex'))
    }
    expect(new Set(hashes.values()).size).toBe(3)
    for (const gewicht of [500, 700]) {
      const fuerGewicht = sg.filter((d) => d.gewicht === gewicht).map((d) => d.url).sort()
      expect(fuerGewicht, `Gewicht ${gewicht}`).toEqual([...dateien].sort())
    }
  })

  it('weil es variable Schriften sind — DAS ist der Grund, nicht die Nachsicht', () => {
    for (const d of DEKLARATIONEN.filter((x) => x.familie === 'Space Grotesk')) {
      const v = echterAufloeser(d.url)
      expect(v.wghtAchse, `${d.url} ist nicht variabel`).not.toBeNull()
      expect(v.wghtAchse).toEqual([300, 700])
    }
  })

  it('alle drei Familien sind variabel, keine ist ein statischer Schnitt', () => {
    const achsen = new Map<string, string>()
    for (const d of DEKLARATIONEN) {
      const v = echterAufloeser(d.url)
      expect(v.wghtAchse, `${d.familie} / ${d.url}`).not.toBeNull()
      achsen.set(d.familie, `${v.wghtAchse?.[0]}–${v.wghtAchse?.[1]}`)
    }
    expect(Object.fromEntries(achsen)).toEqual({
      'Inter': '100–900',
      'JetBrains Mono': '400–800',
      'Space Grotesk': '300–700',
    })
  })

  it('die Displaystufe bleibt auf 500 — und 700 waere trotzdem echtes Fett', () => {
    // Der Grund fuer die 500 ist unveraendert: es gibt keine Deklaration
    // zwischen 500 und 700, also faellt `font-weight: 600` auf den 700er
    // Schnitt. Neu ist nur, dass 700 nachweislich fettet (17 % mehr
    // Deckung) statt still nichts zu tun.
    const css = readFileSync(resolve(ROOT, 'src', 'index.css'), 'utf8')
    expect(css).toMatch(/--text-display-fw:\s*500\s*;/)
    const sgGewichte = [...new Set(
      DEKLARATIONEN.filter((d) => d.familie === 'Space Grotesk').map((d) => d.gewicht),
    )].sort((a, b) => a - b)
    expect(sgGewichte).toEqual([500, 700])
    // Zwischen 500 und 700 liegt nichts — deshalb ist 600 kein eigener Wert.
    expect(sgGewichte.some((w) => w > 500 && w < 700)).toBe(false)
  })
})

describe('die Wache beisst wirklich', () => {
  // Erfundene Faelle statt echter Dateien: die Regel muss sich pruefen
  // lassen, ohne dass `public/fonts` angefasst wird.
  const variabel: Schnittvermoegen = { wghtAchse: [300, 700], usWeightClass: 300 }
  const statisch: Schnittvermoegen = { wghtAchse: null, usWeightClass: 500 }

  it('ein Gewicht ueber der Achse faellt auf', () => {
    const luegen = gewichtsLuegen(
      [{ familie: 'Space Grotesk', gewicht: 900, url: 'woff2/a57c9413b9ba.woff2' }],
      () => variabel,
    )
    expect(luegen).toHaveLength(1)
    expect(luegen[0]).toContain('behauptet 900')
    expect(luegen[0]).toContain('Achse 300–700')
  })

  it('ein Gewicht unter der Achse ebenso', () => {
    expect(gewichtsLuegen(
      [{ familie: 'Space Grotesk', gewicht: 100, url: 'x.woff2' }],
      () => variabel,
    )).toHaveLength(1)
  })

  it('und der Fall, um den es dem Verdacht ging: eine STATISCHE Datei mit fremdem Gewicht', () => {
    // Genau hier waere der Befund echt gewesen. Eine 500er-Datei, die als
    // 700 deklariert wird, kann nicht fetten — und der Browser
    // synthetisiert nichts, weil die Deklaration ihn beruhigt.
    const luegen = gewichtsLuegen(
      [
        { familie: 'Erfunden', gewicht: 500, url: 'a.woff2' },
        { familie: 'Erfunden', gewicht: 700, url: 'a.woff2' },
      ],
      () => statisch,
    )
    expect(luegen).toHaveLength(1)
    expect(luegen[0]).toContain('behauptet 700')
    expect(luegen[0]).toContain('nur 500')
  })

  it('die Achsengrenzen selbst gelten, nicht nur ihr Inneres', () => {
    for (const gewicht of [300, 700]) {
      expect(gewichtsLuegen([{ familie: 'x', gewicht, url: 'a.woff2' }], () => variabel)).toEqual([])
    }
  })
})
