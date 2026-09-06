/**
 * Die Marke — D-A9, der Teil, der noch offen war.
 *
 * Der Audit: „Alle 9 Einbindungen laden `LU-monogram-bw.png` = 512x512px;
 * `public/LU-monogram.svg` hat 0 Verwendungen." Die Titlebar hat die
 * Vektorfassung mit `c77682a2` bekommen und ihren eigenen Test
 * (`titlebar-monogramm.test.ts`); die uebrigen standen weiter auf dem Raster.
 *
 * Dieser Test tut drei Dinge:
 *
 *   1. Er sucht das PNG in `src/components/**` und verlangt null Treffer —
 *      also nicht „die sieben, die ich kenne", sondern JEDE Einbindung, auch
 *      eine, die morgen dazukommt.
 *   2. Er nagelt fest, dass es EINE Konstante gibt statt sieben Literale.
 *   3. Er rechnet die Begruendung nach, mit der das gemacht wurde, samt der
 *      unbequemen Haelfte: das SVG ist GROESSER als das PNG. Wer diese
 *      Begruendung eines Tages zu „spart Platz" verkuerzt, faellt hier durch —
 *      dieselbe Wache, die `titlebar-monogramm.test.ts` fuer die Titlebar
 *      haelt.
 *
 * Run: npx vitest run src/components/layout/__tests__/das-zeichen-ist-vektor.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const PUBLIC = resolve(ROOT, 'public')
const COMPONENTS = resolve(ROOT, 'src', 'components')
const BRAND = readFileSync(resolve(__dirname, '..', 'brand.ts'), 'utf-8')

/** Jede .ts/.tsx unter src/components, Tests ausgenommen. */
function quelldateien(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__') continue
      quelldateien(full, out)
      continue
    }
    if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

const DATEIEN = quelldateien(COMPONENTS)

describe('keine Komponente laedt das 512px-PNG mehr', () => {
  it('null Treffer unter src/components — gesucht, nicht abgehakt', () => {
    const treffer = DATEIEN
      // brand.ts NENNT den alten Pfad in seiner Begruendung.
      .filter((f) => !f.endsWith('brand.ts'))
      .map((f) => [f, readFileSync(f, 'utf-8')] as const)
      .filter(([, src]) => src.includes('LU-monogram-bw.png'))
      .map(([f]) => f.slice(ROOT.length + 1))
    expect(treffer, `laden weiterhin das PNG: ${treffer.join(', ')}`).toEqual([])
  })

  it('und die Einbindungen, die der Audit einzeln nennt, ziehen die Konstante', () => {
    // Sieben Stellen, plus die Titlebar (eigener Test, eigene Konstante).
    const erwartet = [
      'layout/Header.tsx',
      'chat/ChatView.tsx',
      'chat/MessageBubble.tsx',
      'chat/CodexView.tsx',
      'chat/ChatInput.tsx',
      'auth/AccountPanel.tsx',
      'cloud/CloudSwitch.tsx',
      // Nicht in der Neunerliste des Audits — dieser Test hat ihn beim
      // Durchsuchen gefunden. Es waren zehn, nicht neun.
      'cloud/CloudGateModal.tsx',
    ]
    for (const rel of erwartet) {
      const src = readFileSync(resolve(COMPONENTS, rel), 'utf-8')
      expect(src, `${rel}: kein src={MONOGRAM}`).toContain('src={MONOGRAM}')
      expect(src, `${rel}: importiert die Konstante nicht`).toMatch(/from '\.\.?\/(?:\.\.\/)?layout\/brand'|from '\.\/brand'/)
    }
  })

  it('der Pfad steht einmal, nicht siebenmal', () => {
    const literale = DATEIEN
      .filter((f) => !f.endsWith('brand.ts') && !f.endsWith('Titlebar.tsx'))
      .map((f) => [f, readFileSync(f, 'utf-8')] as const)
      .filter(([, src]) => src.includes("'/LU-monogram"))
      .map(([f]) => f.slice(ROOT.length + 1))
    expect(literale, `Pfad als Literal: ${literale.join(', ')}`).toEqual([])
    expect(BRAND).toMatch(/export const MONOGRAM = '\/LU-monogram\.svg'/)
  })

  it('und das Invertierungsrezept ebenfalls', () => {
    // `dark:invert-0 invert` stand an jeder Einbindung von Hand daneben.
    expect(BRAND).toMatch(/export const MONOGRAM_INVERT = 'dark:invert-0 invert'/)
    const handgeschrieben = DATEIEN
      .filter((f) => !f.endsWith('brand.ts') && !f.endsWith('Titlebar.tsx'))
      .map((f) => [f, readFileSync(f, 'utf-8')] as const)
      .filter(([, src]) => /className="[^"]*dark:invert-0 invert/.test(src))
      .map(([f]) => f.slice(ROOT.length + 1))
    expect(handgeschrieben, `Rezept von Hand: ${handgeschrieben.join(', ')}`).toEqual([])
  })
})

describe('die Begruendung stimmt — nachgerechnet, nicht abgeschrieben', () => {
  /** Breite/Hoehe aus dem IHDR-Chunk eines PNG (Bytes 16..24, big endian). */
  function pngSize(file: string): [number, number] {
    const b = readFileSync(file)
    expect(b.subarray(1, 4).toString('ascii'), `${file} ist kein PNG`).toBe('PNG')
    return [b.readUInt32BE(16), b.readUInt32BE(20)]
  }

  it('das PNG ist wirklich 512x512', () => {
    expect(pngSize(resolve(PUBLIC, 'LU-monogram-bw.png'))).toEqual([512, 512])
  })

  it('die drei Rasterzahlen im Kopf von brand.ts stimmen', () => {
    // (512/n)^2 Quellpixel pro Zielpixel, fuer die drei Groessen, die die App
    // tatsaechlich zeichnet: 18px (Titlebar), 20px (Header), 24px (Avatar).
    expect(Math.round((512 / 18) ** 2)).toBe(809)
    expect(Math.round((512 / 20) ** 2)).toBe(655)
    expect(Math.round((512 / 24) ** 2)).toBe(455)
    expect(BRAND).toContain('≈ 809')
    expect(BRAND).toContain('≈ 655')
    expect(BRAND).toContain('≈ 455')
  })

  it('das SVG hat eine viewBox — ohne die skaliert es auch nicht', () => {
    const svg = readFileSync(resolve(PUBLIC, 'LU-monogram.svg'), 'utf-8')
    expect(svg).toMatch(/<svg[^>]*viewBox="0 0 1024\.?\d* 1024\.?\d*"/)
  })

  it('die SVG-Datei ist GROESSER als das PNG — das ist KEIN Platzgewinn', () => {
    const svg = statSync(resolve(PUBLIC, 'LU-monogram.svg')).size
    const png = statSync(resolve(PUBLIC, 'LU-monogram-bw.png')).size
    expect(svg).toBeGreaterThan(png)
    // Und die Datei sagt das auch, mit den echten Zahlen.
    expect(BRAND).toContain(`${svg.toLocaleString('de-DE')} Byte`)
    expect(BRAND).toContain(`${png.toLocaleString('de-DE')} Byte`)
  })

  it('und der Kommentar sagt ausdruecklich, dass der Boot-Chunk davon nichts hat', () => {
    // `public/` wird von Vite kopiert, nie gebuendelt: im JS steht in beiden
    // Faellen nur der Pfad als String. Gemessen wurden DREI Byte.
    expect(BRAND).toMatch(/NICHT tut: Platz sparen/)
    expect(BRAND).toMatch(/nie gebuendelt/)
    expect(BRAND).toMatch(/DREI Byte/)
    expect(BRAND).not.toMatch(/spart Platz(?!")/)
  })
})
