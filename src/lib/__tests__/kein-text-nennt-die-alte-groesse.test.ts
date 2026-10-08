/**
 * Nachtrag zu Fund 5.
 *
 * Seit dem Fix rechnet die Oberflaeche jede MLX-Groesse ueber `formatBytes`,
 * also in 1024er-Schritten: die Karte von UnfilteredAI Gen v2 sagt "8.0 GB download",
 * die Downloads-Leiste sagt dasselbe. Der Katalog in Rust fuehrt dieselbe Datei
 * weiter als `size_gb: 8.6`, weil er dezimal zaehlt und das auch selbst so
 * umrechnet (`size_gb as f64 * 1e9`).
 *
 * Damit liegt in der Quelle eine Zahl, die niemand mehr zu sehen bekommt. Wer
 * eine Versionsmeldung oder ein Handbuchkapitel schreibt und die Groesse aus
 * dem Katalog abschreibt, setzt "8.6 GB" neben eine App, die "8.0 GB" zeigt,
 * und die Zweiteilung waere zurueck, nur eine Etage hoeher.
 *
 * Dieser Waechter haelt die neue Wahrheit: in den sichtbaren Texten darf neben
 * dem Namen eines MLX-Modells nicht dessen Dezimalzahl stehen. Die Zahl, die
 * dort hingehoert, steht in der Fehlermeldung.
 *
 * Beim Anlegen war der Lauf leer: kein sichtbarer Text nannte ueberhaupt eine
 * Downloadgroesse eines MLX-Modells. Der Waechter beweist sich deshalb an einer
 * gesetzten Zeile mit, sonst waere er eine Behauptung ueber nichts.
 *
 * Lauf: npx vitest run src/lib/__tests__/kein-text-nennt-die-alte-groesse.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatBytes, siGbToBytes } from '../formatters'

const WURZEL = resolve(__dirname, '../../..')

/** Ein Eintrag der beiden MLX-Kataloge, gelesen aus der Rust-Quelle. */
type Eintrag = { name: string; roh: string; dezimalGB: number }

function katalog(datei: string): Eintrag[] {
  const quelle = readFileSync(resolve(WURZEL, datei), 'utf8')
  const treffer = quelle.matchAll(/name:\s*"([^"]+)"[\s\S]{0,800}?size_gb:\s*([\d.]+)/g)
  return [...treffer].map((m) => ({ name: m[1], roh: m[2], dezimalGB: Number(m[2]) }))
}

const MLX_KATALOG = [
  ...katalog('src-tauri/src/commands/mlx.rs'),
  ...katalog('src-tauri/src/commands/video.rs'),
]

/**
 * Die Texte, die ein Leser zu sehen bekommt: Versionsmeldungen in der App,
 * Changelog, README, das Handbuch und die beiden Dateien fuer Maschinen.
 * Der Blog ist bewusst nicht dabei: dort steht neben den Modellnamen der
 * Speicher einer Grafikkarte ("10-16 GB VRAM"), nicht die Downloadgroesse, und
 * die Lanes dort sind die von ComfyUI, nicht die von MLX.
 */
const SICHTBARE_TEXTE = [
  'src/lib/release-notes.ts',
  'CHANGELOG.md',
  'README.md',
  'docs/index.html',
  'docs/llms.txt',
  'docs/llms-full.txt',
  'docs/guide/agent/index.html',
  'docs/guide/chat/index.html',
  'docs/guide/cloud/index.html',
  'docs/guide/code/index.html',
  'docs/guide/create/index.html',
  'docs/guide/faq-and-glossary/index.html',
  'docs/guide/first-start/index.html',
  'docs/guide/install/index.html',
  'docs/guide/settings-and-troubleshooting/index.html',
  'docs/guide/what-it-is/index.html',
]

function maskieren(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Die Schreibweisen, in denen die Dezimalzahl eines Eintrags in einen Text
 * geraten kann: so wie sie in Rust steht (`25.0`), so wie JavaScript sie
 * schreiben wuerde (`25`), und beide mit Komma, weil die deutschen Seiten so
 * schreiben. Ein Praefix aus Ziffern oder Trennern schliesst "125 GB" aus,
 * wenn "25 GB" gesucht ist.
 */
function dezimalMuster(e: Eintrag): RegExp {
  const varianten = new Set([e.roh, String(e.dezimalGB), e.roh.replace('.', ','), String(e.dezimalGB).replace('.', ',')])
  return new RegExp(`(?<![\\d.,])(${[...varianten].map(maskieren).join('|')})\\s*GB\\b`, 'i')
}

/** Jede Zeile, die einen Modellnamen UND dessen Dezimalzahl traegt. */
function dezimalfunde(zeilen: string[], quelle: string): string[] {
  const funde: string[] = []
  zeilen.forEach((zeile, i) => {
    for (const e of MLX_KATALOG) {
      if (!zeile.toLowerCase().includes(e.name.toLowerCase())) continue
      if (!dezimalMuster(e).test(zeile)) continue
      funde.push(
        `${quelle}:${i + 1} nennt ${e.name} mit ${e.roh} GB. Die App zeigt ` +
        `${formatBytes(siGbToBytes(e.dezimalGB))}, dieselbe Datei in der Zaehlweise der Oberflaeche.`,
      )
    }
  })
  return funde
}

describe('die Katalogzahl bleibt in der Quelle', () => {
  it('die beiden Kataloge sind gelesen, nicht geraten', () => {
    expect(MLX_KATALOG).toHaveLength(14)
    const nsfw = MLX_KATALOG.find((e) => e.name === 'UnfilteredAI Gen v2')
    expect(nsfw?.roh).toBe('8.6')
    // Die Zahl, um die es geht: derselbe Eintrag, zwei Zaehlweisen.
    expect(formatBytes(siGbToBytes(nsfw!.dezimalGB))).toBe('8.0 GB')
  })

  it('kein sichtbarer Text nennt ein MLX-Modell mit seiner Dezimalzahl', () => {
    const funde = SICHTBARE_TEXTE.flatMap((datei) =>
      dezimalfunde(readFileSync(resolve(WURZEL, datei), 'utf8').split('\n'), datei),
    )
    expect(funde).toEqual([])
  })

  it('und der Waechter wuerde eine solche Zeile finden', () => {
    // Positivkontrolle, sonst prueft der Lauf oben nur, dass die Texte die
    // Modelle gar nicht erwaehnen.
    const gesetzt = [
      'Local media on the Mac: UnfilteredAI Gen v2 is an 8.6 GB download.',
      'Z-Image Turbo braucht 25,0 GB Platz.',
    ]
    const funde = dezimalfunde(gesetzt, 'probe')
    expect(funde).toHaveLength(2)
    expect(funde[0]).toContain('8.0 GB')
    expect(funde[1]).toContain('23.3 GB')

    // Gegenprobe: die richtige Zahl und eine Speicherangabe gehen durch.
    expect(dezimalfunde([
      'Local media on the Mac: UnfilteredAI Gen v2 is an 8.0 GB download.',
      'Z-Image Turbo runs from 10-16 GB VRAM.',
      'Qwen-Image needs 155 GB on disk.',
    ], 'probe')).toEqual([])
  })
})
