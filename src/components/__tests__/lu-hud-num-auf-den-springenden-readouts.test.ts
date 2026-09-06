/**
 * Zahlen, die hochzaehlen, duerfen dabei nicht wackeln.
 *
 * Audit Welle 3: „`.lu-hud-num` auf die 10 springenden Readouts
 * (`DownloadBadge`, `ABCompare`, `ModelBenchmark`, `TokenCounter`)", und im
 * Anhang, unter „ausdruecklich verworfen": „`.lu-hud-num` ist die richtige
 * Idee mit 2 Verwendungen." Beides stimmte bei der Re-Verifikation: das
 * Rezept stand in index.css und wurde von genau zwei Stellen benutzt
 * (`models/ModelCard.tsx`, `create/ui/NumberField.tsx`), waehrend jeder
 * Fortschritts-, Tempo- und Fuellstands-Readout der App mit proportionalen
 * Ziffern lief. Bei Proportionalziffern ist die „1" schmaler als die „8":
 * eine Sekunde 8,8 t/s, die naechste 1,1 t/s, und die Zeile ruckt seitlich.
 *
 * Was hier festgehalten wird:
 *   1. Das Rezept steht GENAU EINMAL in index.css und enthaelt wirklich,
 *      was es verspricht (Tabellenziffern + Monospace).
 *   2. Die vier Komponenten tragen es an ihren zaehlenden Readouts.
 *   3. Keine dieser vier Stellen buchstabiert das Rezept daneben noch
 *      einmal selbst aus (`font-mono` + `tabular-nums` an der Call-Site) —
 *      genau so entsteht das zweite Rezept, das spaeter auseinanderlaeuft.
 *
 * NICHT hier drin, und das ist Absicht: das Zaehler-Pill am
 * Download-Symbol (`{totalActive}`, meist einstellig, in einer runden
 * 14px-Flaeche zentriert) und die Rangnummer der Bestenliste (`{i + 1}.`).
 * Beide zaehlen nicht waehrend man hinsieht; Tabellenziffern aendern dort
 * nichts ausser der Schriftart.
 *
 * Run: npx vitest run src/components/__tests__/lu-hud-num-auf-den-springenden-readouts.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8')

function ohneKommentare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
}

const CSS = read('../../index.css')
const BADGE = ohneKommentare(read('../layout/DownloadBadge.tsx'))
const AB = ohneKommentare(read('../chat/ABCompare.tsx'))
const BENCH = ohneKommentare(read('../models/ModelBenchmark.tsx'))
const TOKENS = ohneKommentare(read('../chat/TokenCounter.tsx'))

/**
 * Die springenden Readouts, Datei fuer Datei, mit der Zahl der Stellen,
 * die das Rezept tragen muessen. Die Zahl steht hier, damit ein
 * hinzugefuegter Readout ohne Rezept auffaellt statt still durchzurutschen.
 */
const READOUTS: Array<[string, string, number]> = [
  // Textmodell-Bytes · Bundle-Bytes/Tempo · Datei-Prozent/Tempo · MLX-Bytes
  ['DownloadBadge', BADGE, 4],
  // Die Statistikzeile ueber Spalte A und ueber Spalte B
  ['ABCompare', AB, 2],
  // letzter Lauf · Schritt/Gesamt waehrend des Laufs · t/s je Rang ·
  // Kennzahlenzeile je Rang
  ['ModelBenchmark', BENCH, 4],
  // Fuellstand / Fenster
  ['TokenCounter', TOKENS, 1],
]

describe('das Rezept steht einmal, und es steht wirklich da', () => {
  it('.lu-hud-num hat genau eine Regel in index.css', () => {
    expect(CSS.match(/^\.lu-hud-num\s*\{/gm) ?? []).toHaveLength(1)
  })

  it('und diese Regel liefert Tabellenziffern in Monospace', () => {
    const block = CSS.match(/^\.lu-hud-num\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(block).toMatch(/font-variant-numeric:\s*tabular-nums/)
    expect(block).toMatch(/font-family:\s*ui-monospace/)
  })
})

describe('die vier Komponenten tragen es an ihren zaehlenden Stellen', () => {
  it.each(READOUTS)('%s traegt das Rezept an jeder zaehlenden Stelle', (name, src, erwartet) => {
    const treffer = [...src.matchAll(/lu-hud-num/g)]
    expect(treffer.length, `${name}: Readouts mit Rezept`).toBe(erwartet)
  })

  it('DownloadBadge: die Byte-Zeilen selbst, nicht irgendein Nachbar', () => {
    expect(BADGE).toMatch(/lu-hud-num">\s*\{formatBytes\(state\.progress\.completed \|\| 0\)\}/)
    expect(BADGE).toMatch(/lu-hud-num">\s*\{totalBytes > 0 \? `\$\{formatBytes\(doneBytes\)\}/)
    expect(BADGE).toMatch(/lu-hud-num">\s*\{formatBytes\(e\.progress\)\}/)
  })

  it('ABCompare: beide Spalten, nicht nur A', () => {
    expect(AB.match(/text-gray-500 lu-hud-num">\s*<span[^>]*><Zap/g) ?? []).toHaveLength(2)
  })

  it('ModelBenchmark: auch der Schrittzaehler waehrend des Laufs', () => {
    const at = BENCH.indexOf('title="Stop benchmark"')
    expect(at).toBeGreaterThan(-1)
    expect(BENCH.slice(at - 400, at)).toContain('lu-hud-num')
  })

  it('TokenCounter: der Fuellstand', () => {
    expect(TOKENS).toMatch(/lu-hud-num">\s*\{formatContextWindow\(usedTokens\)\}/)
  })
})

describe('keine zweite Ausgabe desselben Rezepts an der Call-Site', () => {
  it.each(READOUTS)('%s buchstabiert es nicht daneben aus', (name, src) => {
    // `font-mono tabular-nums` IST .lu-hud-num, nur von Hand und ohne den
    // Laufweitenausgleich. Zwei Schreibweisen desselben Gedankens sind
    // genau der Zustand, in dem eine davon spaeter still abweicht.
    const doppelt = [...src.matchAll(/className="[^"]*"/g)]
      .map((m) => m[0])
      .filter((c) => /\bfont-mono\b/.test(c) && /\btabular-nums\b/.test(c))
    expect(doppelt, `${name}: Rezept von Hand nachgebaut`).toEqual([])
  })

  it('TokenCounter hat sein handgeschriebenes Paar wirklich abgegeben', () => {
    // Es stand genau hier: `text-[0.55rem] font-mono tabular-nums`.
    expect(TOKENS).not.toContain('font-mono tabular-nums')
  })
})
