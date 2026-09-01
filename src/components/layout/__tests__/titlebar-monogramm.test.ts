/**
 * Das Monogramm im Fensterbalken — Audit Welle 3, Punkt 5:
 * „Titlebar-Monogramm streichen, SVG statt 512px-PNG".
 *
 * Der Bullet hat zwei Haelften, und bis zum 01.09.2026 war nur die zweite
 * gegangen. Dieser Test haelt jetzt beide fest:
 *
 *   1. Der Balken zieht die Vektorfassung — und zwar aus `brand.ts`, nicht
 *      mehr aus einer eigenen Kopie der Konstante. (Bis hierher stand hier
 *      `expect(CODE).toMatch(/const MONOGRAM = '\/LU-monogram\.svg'/)`, was
 *      genau diese zweite Kopie festgenagelt hat. Die Zeile ist nicht
 *      weggefallen, sondern umgedreht: verlangt wird jetzt der Import UND
 *      die Abwesenheit jedes eigenen Pfadliterals. Das ist die schaerfere
 *      Bedingung — sie verbietet, was die alte erzwungen hat.)
 *
 *   2. „Streichen" ist auf mac ausgefuehrt und auf Windows/Linux begruendet
 *      NICHT ausgefuehrt. Der Test nagelt beide Seiten fest, damit die
 *      Entscheidung nicht als Zufall wieder umkippt: der mac-Streifen gibt
 *      ein leeres, selbstschliessendes Drag-Region-Div zurueck (die Hoehe
 *      muss bleiben, sonst rutscht der Inhalt unter die nativen Lichter),
 *      der Windows/Linux-Zweig behaelt genau ein 18px-Zeichen.
 *
 *   3. Er rechnet die BEHAUPTUNGEN nach, mit denen das begruendet wurde —
 *      inklusive der unbequemen. Die SVG-Datei ist GROESSER als das PNG, und
 *      der Boot-Chunk aendert sich dadurch um nichts, weil `public/` nie
 *      gebuendelt wird. Wer diese Begruendung eines Tages zu „spart Platz"
 *      verkuerzt, faellt hier durch.
 *
 * Die PNG-Masse werden aus dem IHDR der Datei gelesen, nicht abgeschrieben:
 * die „512x512"-Zahl des Audits ist damit hier verifiziert und nicht
 * uebernommen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const PUBLIC = resolve(ROOT, 'public')
const TITLEBAR = readFileSync(resolve(__dirname, '..', 'Titlebar.tsx'), 'utf8')
/** Ohne Kommentare — die Begruendung im Kopf der Datei NENNT den PNG-Pfad. */
const CODE = TITLEBAR.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Breite/Hoehe aus dem IHDR-Chunk eines PNG (Bytes 16..24, big endian). */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file)
  expect(b.subarray(1, 4).toString('ascii'), `${file} ist kein PNG`).toBe('PNG')
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

describe('der Fensterbalken zieht die Vektorfassung', () => {
  it('genau eine Quelle fuer den Pfad, und die ist `brand.ts`', () => {
    expect(CODE).toMatch(/import \{ MONOGRAM, MONOGRAM_INVERT \} from '\.\/brand'/)
    // Kein eigenes Pfadliteral mehr — weder als Konstante noch im JSX.
    expect(CODE).not.toMatch(/'\/LU-monogram/)
    expect(CODE).not.toMatch(/const MONOGRAM\s*=/)
  })

  it('und kein Rastername, unter keinem seiner Aliase', () => {
    expect(CODE).not.toContain('LU-monogram-bw.png')
    expect(CODE).not.toContain('LU-monogram-white.png')
    expect(CODE).not.toMatch(/\.(png|jpe?g|webp|gif|bmp)\b/)
  })

  it('auch das Invertierungsrezept kommt aus `brand.ts`, nicht von Hand', () => {
    expect(CODE).toContain('${MONOGRAM_INVERT}')
    expect(CODE).not.toMatch(/className="[^"]*dark:invert-0 invert/)
  })
})

describe('„streichen" — auf mac ausgefuehrt, auf Windows/Linux begruendet nicht', () => {
  it('der mac-Streifen zeigt gar kein Zeichen mehr', () => {
    // Ein leeres, selbstschliessendes Div: kein Kind, also auch kein <img>.
    expect(CODE).toMatch(/if \(isMacOS\(\)\) \{\s*return \(\s*<div[^>]*\/>\s*\)\s*\}/)
  })

  it('aber der Streifen selbst bleibt — er reserviert die Hoehe fuer die nativen Lichter', () => {
    const macBlock = CODE.slice(CODE.indexOf('if (isMacOS())'))
    const bis = macBlock.indexOf('/>')
    expect(bis).toBeGreaterThan(0)
    const div = macBlock.slice(0, bis)
    expect(div).toContain('data-tauri-drag-region')
    expect(div).toContain('h-8')
  })

  it('Windows/Linux behaelt genau EIN Zeichen — das Fenstersymbol des ersetzten Systembalkens', () => {
    const imgs = [...CODE.matchAll(/<img src=\{?([^ }]+)\}?/g)].map((m) => m[1])
    expect(imgs).toEqual(['MONOGRAM'])
  })

  it('und rendert es weiterhin auf 18px', () => {
    expect((CODE.match(/width=\{18\} height=\{18\}/g) ?? []).length).toBe(1)
  })

  it('die Begruendung fuer den Unterschied steht in der Datei, nicht nur im Bericht', () => {
    // Ohne sie ist die Ungleichbehandlung der beiden Zweige eine Schlamperei.
    expect(TITLEBAR).toMatch(/decorations: false/)
    expect(TITLEBAR).toMatch(/KEIN App-Symbol/)
  })
})

describe('die Begruendung stimmt noch — nachgerechnet, nicht abgeschrieben', () => {
  it('das PNG ist wirklich 512x512, also 28,4x zu gross fuer 18px', () => {
    const [w, h] = pngSize(resolve(PUBLIC, 'LU-monogram-bw.png'))
    expect([w, h]).toEqual([512, 512])
    // Jedes Zielpixel mittelt ueber rund (512/18)^2 Quellpixel.
    expect(Math.round((w / 18) ** 2)).toBeGreaterThan(800)
  })

  it('das SVG ist ein SVG mit viewBox — sonst skaliert es auch nicht', () => {
    const svg = readFileSync(resolve(PUBLIC, 'LU-monogram.svg'), 'utf8')
    expect(svg).toMatch(/<svg[^>]*viewBox="0 0 1024\.?\d* 1024\.?\d*"/)
  })

  it('die SVG-Datei ist GROESSER als das PNG — das ist kein Platzgewinn', () => {
    // Die unbequeme Haelfte der Begruendung. Faellt dieser Test, weil das
    // SVG kleiner geworden ist, gehoert der Kommentar in Titlebar.tsx
    // angepasst — nicht dieser Test gestrichen.
    const svg = statSync(resolve(PUBLIC, 'LU-monogram.svg')).size
    const png = statSync(resolve(PUBLIC, 'LU-monogram-bw.png')).size
    expect(svg).toBeGreaterThan(png)
  })

  it('der Kommentar sagt ausdruecklich, dass der Boot-Chunk davon nichts hat', () => {
    // `public/` wird von Vite kopiert, nie gebuendelt: im JS steht in beiden
    // Faellen nur der Pfad als String. Gemessen: 727.739 Byte mit dem PNG,
    // 727.736 mit dem SVG — die drei Byte sind der kuerzere Pfad.
    expect(TITLEBAR).toMatch(/Was das NICHT tut: den Boot-Chunk verkleinern/)
    expect(TITLEBAR).toMatch(/nie gebuendelt/)
  })
})
