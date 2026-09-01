/**
 * Das Monogramm im Fensterbalken — Audit Welle 3, Punkt 5:
 * „Titlebar-Monogramm streichen, SVG statt 512px-PNG".
 *
 * Der Test tut zwei Dinge, und das zweite ist das wichtigere:
 *
 *   1. Er nagelt fest, dass der Balken die Vektorfassung zieht.
 *   2. Er rechnet die BEHAUPTUNGEN nach, mit denen das begruendet wurde —
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
  it('genau ein Pfad, und der zeigt auf das SVG', () => {
    expect(CODE).toMatch(/const MONOGRAM = '\/LU-monogram\.svg'/)
    expect(CODE).not.toContain('LU-monogram-bw.png')
    expect(CODE).not.toContain('LU-monogram-white.png')
  })

  it('beide Fassungen des Balkens (mac und Windows/Linux) nehmen denselben Pfad', () => {
    // Der Balken existiert zweimal: mac zeichnet keine eigenen Fensterknoepfe
    // und schiebt die Marke nach rechts. Vorher stand der Pfad zweimal als
    // Literal da und konnte einzeln veralten.
    const imgs = [...CODE.matchAll(/<img src=\{?([^ }]+)\}?/g)].map((m) => m[1])
    expect(imgs).toHaveLength(2)
    expect(new Set(imgs)).toEqual(new Set(['MONOGRAM']))
  })

  it('und rendert es weiterhin auf 18px', () => {
    expect((CODE.match(/width=\{18\} height=\{18\}/g) ?? []).length).toBe(2)
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
