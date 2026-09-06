/**
 * Die Wache fuer KF-33 — die Bildroute des Remote-Servers und ihre Datei.
 *
 * ## Was da war
 *
 * `public/LU-monogram-white.png` (3.219 B, 512x512, byteidentisch mit
 * `LU-monogram-bw.png`) wurde ueber genau einen Weg ausgeliefert:
 *
 *     remote.rs:3256   .route("/LU-monogram-white.png", get(mobile_monogram))
 *     remote.rs:3276   const MONOGRAM: &[u8] = include_bytes!("../../../public/LU-monogram-white.png");
 *     remote.rs:287    //   • /LU-monogram-white.png         — the single branding asset
 *
 * Beide Aufrufer sind vor dieser Wache weggefallen: `0b9c0f66` hat die
 * Desktop-App auf `public/LU-monogram.svg` umgestellt, `b133160b` den
 * Mobile-Client auf ein <symbol>/<use> mit denselben Pfaddaten. Danach
 * blieben eine ausgelieferte Datei und ein HTTP-Endpunkt, die nichts mehr
 * bedienen — kein Fehler, aber Ballast, den niemand mehr anfassen wird.
 *
 * ## Was diese Datei prueft
 *
 * Nicht, dass die Zeilen weg sind (das waere ein Pin auf Bytes), sondern dass
 * der Remote-Server keine Raster-Marke mehr AUSLIEFERT: keine Bildroute im
 * Router, kein `include_bytes!` aus `public/`, und die Datei selbst nicht
 * mehr im Baum. Kommentare zaehlen nicht mit — ueber die Geschichte darf
 * geschrieben werden, ausgeliefert werden soll sie nicht.
 *
 * Die Gegenprobe steht mit dabei: der Vektor, von dem die Seite ihr Zeichen
 * nimmt, muss weiter da sein. Sonst waere „nichts mehr da" auch dadurch zu
 * erfuellen, dass man die Marke ganz entfernt.
 *
 * Lauf: npx vitest run src/api/__tests__/keine-bildroute-ohne-aufrufer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..')
const REMOTE_RS = resolve(ROOT, 'src-tauri', 'src', 'commands', 'remote.rs')

/**
 * Rust-Quelltext ohne Zeilenkommentare. Blockkommentare kommen in dieser
 * Datei nicht vor; `//` mitten in einer Zeichenkette (etwa `"http://…"`)
 * wuerde hier zu viel wegschneiden, deshalb wird nur ab einem `//` gekuerzt,
 * vor dem in derselben Zeile kein Anfuehrungszeichen steht.
 */
function codeOnly(rust: string): string {
  return rust
    .split('\n')
    .map((zeile) => {
      const idx = zeile.indexOf('//')
      if (idx < 0) return zeile
      if (zeile.slice(0, idx).includes('"')) return zeile
      return zeile.slice(0, idx)
    })
    .join('\n')
}

const REMOTE_CODE = codeOnly(readFileSync(REMOTE_RS, 'utf8'))

/** Dieselbe Musterform wie in der Desktop-Wache: Name egal, Endung zaehlt. */
const RASTER_MARKE = /[\w@-]*(?:monogram|logo|brand|wordmark)[\w@-]*\.(?:png|jpe?g|webp|gif|bmp|ico|avif)/i

describe('der Remote-Server liefert keine Raster-Marke mehr aus', () => {
  it('die Datei ist aus public/ verschwunden', () => {
    expect(existsSync(resolve(ROOT, 'public', 'LU-monogram-white.png'))).toBe(false)
  })

  it('remote.rs bettet keine Datei aus public/ mehr ein', () => {
    expect(REMOTE_CODE).not.toMatch(/include_bytes!\s*\(\s*"[^"]*public\//)
  })

  it('im Router steht keine Bildroute mehr — auch nicht unter anderem Namen', () => {
    const bildrouten = REMOTE_CODE.match(/\.route\(\s*"[^"]*\.(?:png|jpe?g|webp|gif|bmp|ico|avif|svg)"/gi)
    expect(bildrouten ?? []).toEqual([])
  })

  it('und der Name des Handlers ist mit ihr gegangen', () => {
    expect(REMOTE_CODE).not.toContain('mobile_monogram')
  })

  it('ueberhaupt kein Raster-Markenpfad mehr im Code', () => {
    const treffer = REMOTE_CODE.match(new RegExp(RASTER_MARKE, 'gi'))
    expect(treffer ?? []).toEqual([])
  })
})

describe('die Gegenprobe: das Zeichen selbst ist nicht verschwunden', () => {
  it('der Vektor, aus dem beide Seiten ihre Marke nehmen, liegt weiter in public/', () => {
    const svg = resolve(ROOT, 'public', 'LU-monogram.svg')
    expect(existsSync(svg)).toBe(true)
    expect(readFileSync(svg, 'utf8')).toContain('<path')
  })
})
