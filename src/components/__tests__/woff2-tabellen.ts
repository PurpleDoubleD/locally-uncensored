/**
 * Ein woff2 aufmachen, ohne etwas zu installieren.
 *
 * Gebraucht wird das fuer genau eine Frage: welche Schnittstaerken kann eine
 * Schriftdatei tatsaechlich tragen? Sie steht in der Datei (`fvar` bei
 * variablen Schriften, `OS/2` bei statischen) und NICHT im Dateinamen — die
 * Namen sind Hashes, und aus ihnen laesst sich nichts schliessen.
 *
 * Warum hier ein eigener Parser statt fontTools: fontTools ist zwar
 * installiert, braucht fuer woff2 aber die Brotli-Erweiterung, die es auf
 * dieser Maschine nicht gibt. Node bringt Brotli mit (`node:zlib`). Also
 * wird hier genau so viel woff2 gelesen, wie die Frage braucht, und nichts
 * nachinstalliert.
 *
 * Was gelesen wird und was nicht: das Tabellenverzeichnis am Kopf ist
 * UNkomprimiert und nennt fuer jede Tabelle ihre Laenge. Dahinter liegt ein
 * einziger Brotli-Strom, in dem die Tabellen in Verzeichnisreihenfolge
 * aneinanderhaengen. `fvar` und `OS/2` tragen in woff2 keine Transformation
 * (nur `glyf`, `loca` und `hmtx` koennen das), lassen sich also nach dem
 * Entpacken an ihrem aufsummierten Versatz direkt lesen. Umrissdaten werden
 * hier bewusst nicht rekonstruiert — dafuer waere dieser Parser zu wenig.
 *
 * Keine Testdatei: `vitest.config.ts` sammelt nur `*.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

/** Die 63 Tabellenkuerzel, die woff2 als Index statt als Text speichert. */
const BEKANNTE_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
]

/** woff2' Ganzzahlformat mit variabler Laenge (7 Nutzbits je Byte). */
function uintBase128(b: Buffer, start: number): [number, number] {
  let wert = 0
  let i = start
  for (let k = 0; k < 5; k++) {
    const d = b[i++]
    wert = (wert << 7) | (d & 0x7f)
    if (!(d & 0x80)) return [wert, i]
  }
  throw new Error('UIntBase128 laenger als fuenf Bytes')
}

/** Alle Tabellen einer woff2-Datei, entpackt, nach Kuerzel. */
export function woff2Tabellen(pfad: string): Map<string, Buffer> {
  const b = readFileSync(pfad)
  if (b.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`kein woff2: ${pfad}`)
  const anzahl = b.readUInt16BE(12)
  const komprimierteLaenge = b.readUInt32BE(20)

  let i = 48 // Kopf ist fest 48 Bytes
  const verzeichnis: Array<{ tag: string; laenge: number }> = []
  for (let t = 0; t < anzahl; t++) {
    const flags = b[i++]
    const index = flags & 0x3f
    let tag: string
    if (index === 0x3f) {
      tag = b.toString('latin1', i, i + 4)
      i += 4
    } else {
      tag = BEKANNTE_TAGS[index]
    }
    let laenge: number
    ;[laenge, i] = uintBase128(b, i)
    // Bei glyf/loca bedeutet Version 0 „transformiert", bei allen anderen
    // Tabellen bedeutet Version 1 das. Nur dann folgt eine zweite Laenge,
    // und nur die zaehlt fuer den Versatz im entpackten Strom.
    const version = (flags >> 6) & 0x3
    const transformiert = (tag === 'glyf' || tag === 'loca') ? version === 0 : version === 1
    if (transformiert) [laenge, i] = uintBase128(b, i)
    verzeichnis.push({ tag, laenge })
  }

  const roh = brotliDecompressSync(b.subarray(i, i + komprimierteLaenge))
  const tabellen = new Map<string, Buffer>()
  let versatz = 0
  for (const { tag, laenge } of verzeichnis) {
    tabellen.set(tag, roh.subarray(versatz, versatz + laenge))
    versatz += laenge
  }
  return tabellen
}

/** Was eine Schriftdatei an Schnittstaerken hergibt. */
export type Schnittvermoegen = {
  /** [min, max] der `wght`-Achse, oder null bei einer statischen Datei. */
  wghtAchse: [number, number] | null
  /** Der einzige Schnitt einer statischen Datei — bei variablen die Voreinstellung. */
  usWeightClass: number | null
}

/** 16.16-Festkomma, wie fvar es benutzt. */
const fixed = (b: Buffer, o: number) => b.readInt32BE(o) / 65536

export function schnittvermoegen(pfad: string): Schnittvermoegen {
  const t = woff2Tabellen(pfad)
  const os2 = t.get('OS/2')
  const fvar = t.get('fvar')
  let wghtAchse: [number, number] | null = null
  if (fvar) {
    const achsenVersatz = fvar.readUInt16BE(4)
    const achsenZahl = fvar.readUInt16BE(8)
    const achsenGroesse = fvar.readUInt16BE(10)
    for (let a = 0; a < achsenZahl; a++) {
      const o = achsenVersatz + a * achsenGroesse
      if (fvar.toString('latin1', o, o + 4) === 'wght') {
        wghtAchse = [fixed(fvar, o + 4), fixed(fvar, o + 12)]
      }
    }
  }
  return { wghtAchse, usWeightClass: os2 ? os2.readUInt16BE(4) : null }
}

/** Eine `@font-face`-Deklaration, so weit sie hier interessiert. */
export type Deklaration = { familie: string; gewicht: number; url: string }

/** Jede `@font-face`-Regel eines Stylesheets. */
export function deklarationen(css: string): Deklaration[] {
  const out: Deklaration[] = []
  for (const block of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const b = block[1]
    const familie = /font-family:\s*'([^']+)'/.exec(b)?.[1]
    const gewicht = /font-weight:\s*(\d+)/.exec(b)?.[1]
    const url = /url\(([^)]+)\)/.exec(b)?.[1]
    if (familie && gewicht && url) out.push({ familie, gewicht: Number(gewicht), url })
  }
  return out
}

/**
 * DIE REGEL, als Funktion und nicht als Aufzaehlung:
 *
 *   Eine `@font-face`-Deklaration darf nur ein Gewicht behaupten, das die
 *   referenzierte Datei auch tragen kann.
 *
 * Variabel: das Gewicht muss auf der `wght`-Achse der Datei liegen.
 * Statisch: es muss genau ihr `OS/2.usWeightClass` sein.
 *
 * Der Aufloeser ist ein Parameter, damit die Regel gegen erfundene Faelle
 * geprueft werden kann, ohne eine Schriftdatei anzufassen.
 */
export function gewichtsLuegen(
  liste: Deklaration[],
  aufloesen: (url: string) => Schnittvermoegen,
): string[] {
  const luegen: string[] = []
  for (const d of liste) {
    const v = aufloesen(d.url)
    const traegt = v.wghtAchse
      ? d.gewicht >= v.wghtAchse[0] && d.gewicht <= v.wghtAchse[1]
      : v.usWeightClass === d.gewicht
    if (!traegt) {
      const kann = v.wghtAchse ? `Achse ${v.wghtAchse[0]}–${v.wghtAchse[1]}` : `nur ${v.usWeightClass}`
      luegen.push(`${d.familie} behauptet ${d.gewicht} fuer ${d.url}, die Datei kann ${kann}`)
    }
  }
  return luegen
}
