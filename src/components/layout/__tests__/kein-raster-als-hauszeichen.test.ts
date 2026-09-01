/**
 * Die Wache gegen den Rueckfall — D-A9 / D-W3-7.
 *
 * ## Warum es diese Datei zusaetzlich zu `das-zeichen-ist-vektor.test.ts` gibt
 *
 * Die Wache von `b3f0f786` sucht in `src/components/**` nach der Zeichenkette
 * `LU-monogram-bw.png`. Sie hat damit zehn Einbindungen dichtgemacht und eine
 * uebersehen: `create/experimental/Stage.tsx` zeigte auf 56px
 * `/LU-monogram-white.png` — eine BYTEIDENTISCHE Kopie derselben 512x512-
 * Bitmap (beide MD5 `bfc4322611...`, beide 3.219 Byte). Ein zweiter Dateiname
 * fuer dasselbe Bild, und die Wache war blind dafuer.
 *
 * Daraus die Regel dieser Datei: **nicht nach einem Namen suchen, sondern nach
 * dem Muster.** Jede Zeichenkette, die einen Marken-Dateinamen (`monogram`,
 * `logo`, `brand`, `wordmark`) mit einer Rasterendung verbindet, faellt durch —
 * egal wie die Datei heisst und egal, ob sie heute schon existiert.
 *
 * ## Was AUSDRUECKLICH kein Befund ist
 *
 * Das Symbol, das das BETRIEBSSYSTEM zeichnet — Dock, Taskleiste, Alt-Tab,
 * Installer, Browser-Tab — muss ein Rasterbild in mehreren festen Aufloesungen
 * sein. `.icns`, `.ico` und PNG-Leitern sind dort die Anforderung der
 * Plattform, kein Versaeumnis. Der letzte Block unten haelt das fest, damit
 * niemand diesen Test als Auftrag missversteht, `src-tauri/icons/` zu
 * „vektorisieren".
 *
 * ## Was ausserhalb der Reichweite liegt, und warum
 *
 * `mobile-client/client.js` zeigt die Marke an vier Stellen (64/22/18/82px)
 * weiterhin als 512px-PNG. Das ist eine ANDERE Oberflaeche — die Seite, die
 * das Telefon per HTTP bekommt — und sie ist von
 * `src/api/__tests__/mobile-html-content.test.ts` auf genau diesen Pfad
 * festgenagelt. Diese Wache umfasst deshalb `src/` und `index.html`, nicht
 * `mobile-client/`. Der Befund dort steht im Bericht, nicht hier: ihn zu
 * schliessen hiesse, einen fremden Test rot zu machen.
 *
 * Run: npx vitest run src/components/layout/__tests__/kein-raster-als-hauszeichen.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const SRC = resolve(ROOT, 'src')

/**
 * Ein Marken-Dateiname mit Rasterendung. Bewusst breit: `LU-monogram-bw.png`,
 * `LU-monogram-white.png`, `logo-bw-2k.png`, `brand@2x.webp` — alle drin.
 * `favicon.png` bewusst NICHT: das ist ein Plattformsymbol (siehe unten).
 */
const RASTER_MARKE = /[\w@-]*(?:monogram|logo|brand|wordmark)[\w@-]*\.(?:png|jpe?g|webp|gif|bmp|ico|avif)/i

/** Kommentare raus — die Begruendungen NENNEN die alten Pfade. */
function nurCode(quelle: string): string {
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
}

/** Jede .ts/.tsx unter src/, Tests ausgenommen. */
function quelldateien(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__tests__') continue
      quelldateien(full, out)
      continue
    }
    if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

const DATEIEN = quelldateien(SRC).map((f) => [f.slice(ROOT.length + 1), nurCode(readFileSync(f, 'utf-8'))] as const)
const INDEX_HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf-8')

describe('das Hauszeichen ist nirgends mehr ein Rasterbild', () => {
  it('kein Marken-Rastername irgendwo in src/ — gesucht, nicht abgehakt', () => {
    const treffer = DATEIEN
      .filter(([, code]) => RASTER_MARKE.test(code))
      .map(([rel, code]) => `${rel} → ${code.match(RASTER_MARKE)![0]}`)
    expect(treffer, `Rasterfassung der Marke: ${treffer.join(', ')}`).toEqual([])
  })

  it('auch nicht im Splash von index.html — der ist die erste Marke, die jemand sieht', () => {
    const code = nurCode(INDEX_HTML)
    expect(code).not.toMatch(RASTER_MARKE)
    // Und positiv: der Splash zeigt wirklich die Vektorfassung.
    expect(code).toMatch(/<img src="\/LU-monogram\.svg"/)
  })

  it('der Pfad steht GENAU einmal im ganzen Projekt-Quelltext: in brand.ts', () => {
    const literale = DATEIEN
      .filter(([rel]) => rel !== 'src/components/layout/brand.ts')
      .filter(([, code]) => code.includes("'/LU-monogram"))
      .map(([rel]) => rel)
    expect(literale, `zweite Kopie des Pfads: ${literale.join(', ')}`).toEqual([])

    const brand = readFileSync(resolve(SRC, 'components', 'layout', 'brand.ts'), 'utf-8')
    expect(brand).toMatch(/export const MONOGRAM = '\/LU-monogram\.svg'/)
  })

  it('jedes <img>, das die Marke zeigt, zieht die Konstante statt eines Pfads', () => {
    const falsch: string[] = []
    for (const [rel, code] of DATEIEN) {
      // src={…} oder src="…" bzw. logoSrc={…} / logoSrc="…"
      for (const m of code.matchAll(/\b(?:logoSrc|src)=(?:\{([^}]*)\}|"([^"]*)")/g)) {
        const wert = m[1] ?? m[2] ?? ''
        if (/monogram/i.test(wert) && wert.trim() !== 'MONOGRAM') falsch.push(`${rel} → ${wert.trim()}`)
      }
    }
    expect(falsch, `Marke ohne die Konstante: ${falsch.join(', ')}`).toEqual([])
  })
})

describe('und das Zeichen funktioniert in beiden Themes', () => {
  const brand = readFileSync(resolve(SRC, 'components', 'layout', 'brand.ts'), 'utf-8')
  const svg = readFileSync(resolve(ROOT, 'public', 'LU-monogram.svg'), 'utf-8')

  it('das SVG ist weiss gezeichnet — eine Farbe, an einer Stelle', () => {
    const fuellungen = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1])
    expect(fuellungen).toEqual(['#ffffff'])
  })

  it('deshalb liegt das Umschaltrezept in genau einer Konstante, nicht pro Call-Site', () => {
    expect(brand).toMatch(/export const MONOGRAM_INVERT = 'dark:invert-0 invert'/)
    const handgeschrieben = DATEIEN
      .filter(([rel]) => rel !== 'src/components/layout/brand.ts')
      .filter(([, code]) => /dark:invert-0 invert/.test(code))
      .map(([rel]) => rel)
    expect(handgeschrieben, `Rezept von Hand: ${handgeschrieben.join(', ')}`).toEqual([])
  })

  it('die Stelle, die auf weisser Flaeche sass, hat es jetzt auch', () => {
    // `create/` ist dunkel-zuerst portiert und sitzt in `<main>` auf
    // `bg-white dark:bg-[#1e1e1e]`. Die weisse Marke stand dort im Hellmodus
    // unsichtbar auf Weiss — der Text daneben nicht, den faengt
    // `index.css:863-868` (`.light .text-gray-200 → gray-800`) ab.
    const stage = readFileSync(resolve(SRC, 'components', 'create', 'experimental', 'Stage.tsx'), 'utf-8')
    expect(nurCode(stage)).toContain('logoSrc={MONOGRAM} logoClassName={MONOGRAM_INVERT}')
  })
})

describe('die Plattformsymbole sind KEIN Befund — sie muessen Raster sein', () => {
  it('das Bundle-Symbol bleibt eine Rasterleiter plus .icns/.ico', () => {
    const conf = JSON.parse(readFileSync(resolve(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf-8'))
    const icons: string[] = conf.bundle.icon
    expect(icons.length).toBeGreaterThan(0)
    // Dock, Taskleiste, Alt-Tab und die Installer lesen feste Aufloesungen.
    // Ein SVG waere hier ein Fehler, kein Fortschritt.
    for (const i of icons) expect(i, `${i} ist kein Plattformformat`).toMatch(/\.(png|ico|icns)$/)
    expect(icons.some((i) => i.endsWith('.icns'))).toBe(true)
    expect(icons.some((i) => i.endsWith('.ico'))).toBe(true)
  })

  it('und der Browser-Tab behaelt sein 32px-PNG — nativ gezeichnet, nicht heruntergerechnet', () => {
    expect(INDEX_HTML).toMatch(/<link rel="icon" type="image\/png" href="\/favicon\.png" \/>/)
    const png = readFileSync(resolve(ROOT, 'public', 'favicon.png'))
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([32, 32])
  })
})
