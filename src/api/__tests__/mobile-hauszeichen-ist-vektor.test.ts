/**
 * Die Wache fuer das Hauszeichen auf dem Telefon.
 *
 * ## Was war
 *
 * `mobile-client/client.js` zog an vier Stellen — Anmeldung 64px, Kopfzeile
 * 22px, Schublade 18px, Willkommensbild 82px — `/LU-monogram-white.png`,
 * dieselbe 512x512-Bitmap, viermal heruntergerechnet. Die Desktop-App war zu
 * dem Zeitpunkt seit `0b9c0f66` komplett auf `public/LU-monogram.svg` und von
 * `src/components/layout/__tests__/kein-raster-als-hauszeichen.test.ts`
 * verriegelt; jene Wache nimmt `mobile-client/` ausdruecklich aus, weil
 * `mobile-html-content.test.ts` den PNG-Pfad woertlich forderte. Der
 * Mobile-Client war damit die letzte Rasterstelle im Baum, und der Test, der
 * ihn hielt, war der Grund, warum niemand ihn anfasste.
 *
 * ## Warum <symbol> + <use> und nicht `<img src="/LU-monogram.svg">`
 *
 * Gemessen, nicht vermutet: der Remote-Server liefert KEINE Datei aus
 * `mobile-client/` aus. `src-tauri/src/mobile_page.rs` baut aus den sechs
 * Quelldateien EINE HTML-Seite und `build.rs` bettet sie ein. Als das hier
 * geschrieben wurde, kannte der Router in `src-tauri/src/commands/remote.rs`
 * genau EINE Bildroute (`/LU-monogram-white.png` →
 * `include_bytes!("../../../public/…")`); seit KF-33 kennt er KEINE mehr —
 * mit dem Vektor im Dokument hatte sie keinen Aufrufer mehr und ist samt
 * Datei gegangen (Wache: `keine-bildroute-ohne-aufrufer.test.ts`). Es gibt
 * kein `ServeDir`, keinen statischen Zweig, und der Fallback ist ein 302 auf
 * `/mobile`. Ein `<img src="/LU-monogram.svg">` haette also nichts geladen,
 * sondern die Anmeldeseite als Bild angefordert — und wuerde es heute erst
 * recht nicht.
 *
 * Der Vektor liegt deshalb IM Dokument. Das kostet die Seite die Pfaddaten
 * einmal und spart ihr dafuer eine HTTP-Anfrage; die vier Anzeigestellen
 * teilen sich das eine `<symbol>`.
 *
 * ## Wovor diese Datei schuetzt
 *
 * Eine Kopie driftet. Die Pfaddaten im Sprite muessen Zeichen fuer Zeichen die
 * aus `public/LU-monogram.svg` sein — dieselbe Datei, die die Desktop-Wache
 * prueft. Wer das SVG neu exportiert und den Mobile-Client vergisst, wird
 * hier rot.
 *
 * Lauf: npx vitest run src/api/__tests__/mobile-hauszeichen-ist-vektor.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { codeOnly } from './mobile-client-shell'

const ROOT = resolve(__dirname, '..', '..', '..')
const read = (...teile: string[]) => readFileSync(resolve(ROOT, ...teile), 'utf8')

const HTML = read('mobile-client', 'index.html')
const JS = read('mobile-client', 'client.js')
const CSS = read('mobile-client', 'styles.css')
const VEKTOR = read('public', 'LU-monogram.svg')

/** Die eine Zeichengruppe einer dieser Dateien — der eigentliche Inhalt. */
function zeichengruppe(quelle: string): string {
  const treffer = quelle.match(/<g [\s\S]*<\/g>/)
  expect(treffer, 'keine <g>-Gruppe gefunden').not.toBeNull()
  return treffer![0]
}

describe('das Hauszeichen auf dem Telefon ist der Vektor aus public/', () => {
  it('die Pfaddaten im Sprite sind Zeichen fuer Zeichen die der Vektordatei', () => {
    expect(zeichengruppe(HTML)).toBe(zeichengruppe(VEKTOR))
  })

  it('und es sind wirklich Pfade, nicht ein eingebettetes Raster', () => {
    // Ein exportiertes SVG kann eine PNG als <image href="data:…"> enthalten.
    // Das waere derselbe Befund in neuer Verpackung.
    expect(HTML).not.toMatch(/<image\b/)
    expect(HTML).not.toContain('data:image/')
    expect([...zeichengruppe(HTML).matchAll(/<path d="/g)]).toHaveLength(3)
  })

  it('das viewBox kommt mit — sonst zeichnet <use> ins Leere', () => {
    const symbol = HTML.match(/<symbol id="lu-monogram"[^>]*>/)?.[0] ?? ''
    const wurzel = VEKTOR.match(/<svg[^>]*>/)?.[0] ?? ''
    const viewBox = (s: string) => s.match(/viewBox="([^"]+)"/)?.[1]
    expect(viewBox(symbol)).toBe(viewBox(wurzel))
    expect(viewBox(symbol)).toBeTruthy()
  })

  it('eine Farbe, an einer Stelle — dieselbe Zusicherung wie auf dem Desktop', () => {
    const fuellungen = [...zeichengruppe(HTML).matchAll(/fill="([^"]+)"/g)].map((m) => m[1])
    expect(fuellungen).toEqual(['#ffffff'])
  })
})

describe('und die Seite holt sich kein Bild mehr ueber HTTP', () => {
  it('kein <img> zeigt auf einen Markenpfad — es gaebe keine Route dafuer', () => {
    // Ohne Kommentare: die Begruendungen NENNEN beide Pfade.
    for (const [name, quelle] of [
      ['index.html', codeOnly(HTML)],
      ['client.js', codeOnly(JS)],
      ['styles.css', codeOnly(CSS)],
    ] as const) {
      const treffer = [...quelle.matchAll(/(?:src|href|url\()\s*=?\s*["']?(\/LU-[^"')\s]+)/g)].map(
        (m) => m[1],
      )
      expect(treffer, `${name} laedt ${treffer.join(', ')} — der Server routet das nicht`).toEqual([])
    }
  })

  it('die vier Anzeigestellen teilen sich das eine Symbol', () => {
    expect(codeOnly(JS).match(/<use href="#lu-monogram"\/>/g)).toHaveLength(1)
    expect(codeOnly(JS).match(/monogram\('/g)).toHaveLength(4)
    expect(codeOnly(HTML).match(/id="lu-monogram"/g)).toHaveLength(1)
  })

  it('der Sprite-Traeger ist unsichtbar, ohne display:none zu benutzen', () => {
    // display:none auf dem Sprite laesst <use> in mehreren Engines leer
    // rendern. Die Regel muss die Null-Groessen-Form sein.
    const regel = CSS.match(/\.svg-sprite\{([^}]*)\}/)?.[1] ?? ''
    expect(regel).toContain('position:absolute')
    expect(regel).toContain('width:0')
    expect(regel).not.toContain('display:none')
  })
})
