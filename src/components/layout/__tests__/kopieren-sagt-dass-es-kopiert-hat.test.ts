/**
 * Vier Kopier-Knoepfe in der Sidebar sagten nichts.
 *
 * Audit Welle 3: „Copy-Feedback auf `Sidebar.tsx:364/387/705/724` nach dem
 * Muster aus `CodeBlock.tsx:46`". Bei der Re-Verifikation standen alle vier
 * woanders (423 / 446 / 758 / 776) — dieselben vier Knoepfe: Passcode und
 * Adresse, je einmal im schmalen Remote-Panel und einmal im grossen
 * QR-Modal. Alle vier schrieben in die Zwischenablage und sahen danach aus
 * wie davor. Wer nicht sicher war, klickte nochmal.
 *
 * Was hier festgehalten wird, ist nicht „irgendein Feedback", sondern DAS
 * VORHANDENE Rezept, ein zweites Mal benutzt statt neu erfunden:
 *
 *   CodeBlock.tsx   const [copied, setCopied] = useState(false)
 *                   setCopied(true); setTimeout(… , 2000)
 *                   {copied ? <Check/> : <Copy/>}
 *
 * Genau ein Unterschied, und der ist erzwungen: CodeBlock hat EINEN Knopf
 * und kommt mit einem Boolean aus, die Sidebar hat vier und muss sich
 * merken, WELCHER. Der Test prueft deshalb beides — dass die Bestandteile
 * des Rezepts da sind, und dass jeder der vier Knoepfe seinen eigenen
 * Schluessel fuehrt. Faellt einer davon weg, ist er hier rot.
 *
 * Run: npx vitest run src/components/layout/__tests__/kopieren-sagt-dass-es-kopiert-hat.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8')

/**
 * Kommentare raus, bevor gescannt wird: die Begruendung in Sidebar.tsx
 * BESCHREIBT das Rezept, und ein Scanner, der sie mitliest, wuerde die
 * Erklaerung fuer die Umsetzung halten.
 */
function ohneKommentare(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

const SIDEBAR = ohneKommentare(read('../Sidebar.tsx'))
const CODEBLOCK = ohneKommentare(read('../../chat/CodeBlock.tsx'))

/** Die vier Stellen, mit dem Schluessel, unter dem sie sich merken. */
const STELLEN = [
  ['Panel, Passcode', 'panel-passcode'],
  ['Panel, Adresse', 'panel-url'],
  ['QR-Modal, Passcode', 'modal-passcode'],
  ['QR-Modal, Adresse', 'modal-url'],
] as const

describe('das Muster, das kopiert wird, existiert ueberhaupt noch', () => {
  // Ohne diese Wache prueft der Rest gegen ein Vorbild, das sich
  // inzwischen geaendert hat — und meldet trotzdem gruen.
  it('CodeBlock fuehrt einen copied-Zustand', () => {
    expect(CODEBLOCK).toMatch(/const \[copied, setCopied\] = useState\(false\)/)
  })

  it('CodeBlock setzt ihn beim Kopieren und nimmt ihn nach 2000 ms zurueck', () => {
    expect(CODEBLOCK).toContain('navigator.clipboard.writeText')
    expect(CODEBLOCK).toContain('setCopied(true)')
    expect(CODEBLOCK).toMatch(/setTimeout\(\(\) => setCopied\(false\), 2000\)/)
  })

  it('CodeBlock tauscht das Glyph Copy → Check', () => {
    expect(CODEBLOCK).toMatch(/copied \? <Check size=\{11\} \/> : <Copy size=\{11\} \/>/)
  })
})

describe('die Sidebar benutzt DIESES Rezept, kein zweites', () => {
  it('fuehrt einen copied-Zustand', () => {
    expect(SIDEBAR).toMatch(/const \[copied, setCopied\] = useState<string \| null>\(null\)/)
  })

  it('setzt ihn beim Kopieren und nimmt ihn nach denselben 2000 ms zurueck', () => {
    expect(SIDEBAR).toContain('navigator.clipboard.writeText(text)')
    expect(SIDEBAR).toContain('setCopied(was)')
    expect(SIDEBAR).toMatch(/setTimeout\([\s\S]{0,80}?, 2000\)/)
  })

  it('der Timer raeumt nur seinen EIGENEN Klick weg', () => {
    // Vier Knoepfe teilen sich einen Zustand. Ein Timer, der stumpf auf
    // null setzt, loescht sonst die Rueckmeldung eines spaeteren Klicks
    // auf einen anderen Knopf, ein bis zwei Sekunden zu frueh.
    expect(SIDEBAR).toMatch(/setCopied\(\(c\) => \(c === was \? null : c\)\)/)
  })

  it('kopiert an keiner Stelle mehr stumm', () => {
    // Jeder Aufruf traegt einen zweiten Parameter — den Schluessel. Ein
    // einparametriger Aufruf waere ein Knopf ohne Rueckmeldung.
    const aufrufe = [...SIDEBAR.matchAll(/copyToClipboard\(/g)]
    // Genau die vier Aufrufe — die Definition schreibt sich
    // `const copyToClipboard = (text, was) =>` und faellt nicht darunter.
    expect(aufrufe).toHaveLength(4)
    for (const m of aufrufe) {
      expect(SIDEBAR.slice(m.index, m.index + 400)).toMatch(/,\s*'(panel|modal)-(passcode|url)'\)/)
    }
    expect(SIDEBAR).not.toMatch(/copyToClipboard\(passcode\)/)
  })
})

describe('alle vier Stellen, jede mit eigenem Schluessel', () => {
  it.each(STELLEN)('%s kopiert unter dem Schluessel %s', (_name, key) => {
    expect(SIDEBAR).toContain(`, '${key}')`)
  })

  it.each(STELLEN)('%s tauscht das Glyph, wenn ihr Schluessel dran ist', (name, key) => {
    const ternaer = new RegExp(`copied === '${key}'\\s*\\?\\s*<Check`)
    expect(SIDEBAR, `${name}: kein Copy → Check`).toMatch(ternaer)
  })

  it.each(STELLEN)('%s wechselt auch den zugaenglichen Namen', (name, key) => {
    // Die vier Knoepfe sind icon-only. Bei CodeBlock traegt das WORT
    // („Copy" → „Copied") die Rueckmeldung; hier gibt es kein Wort, also
    // muss das Label sie tragen — sonst haette eine Screenreader-Nutzerin
    // gar keine.
    const label = new RegExp(`aria-label=\\{copied === '${key}' \\? '[^']*[Cc]opied'`)
    expect(SIDEBAR, `${name}: aria-label sagt nichts`).toMatch(label)
  })

  it('die vier Schluessel sind wirklich vier verschiedene', () => {
    const keys = STELLEN.map(([, k]) => k)
    expect(new Set(keys).size).toBe(4)
  })
})
