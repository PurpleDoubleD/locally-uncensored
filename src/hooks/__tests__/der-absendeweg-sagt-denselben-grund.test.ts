/**
 * Ein Fehler aus dem Rust-Teil ist eine Zeichenkette, kein Error.
 *
 * Gegenprobe G1, 04.09.2026, echter Windows-Build: dieselbe kaputte GGUF-Datei
 * liefert ueber den Modellwaehler die vollstaendige Diagnose samt Rat und
 * stellt das alte Modell wieder her. Ueber das Absenden einer getippten Frage
 * liefert sie nach 16,9 s genau eine Zeile:
 *
 *     Error: Connection failed
 *
 * Keine Ursache, kein Rat. Der Grund lag nicht am Rust-Teil, der den ganzen
 * Text erzeugt und uebergibt, sondern an der Stelle, die ihn liest:
 * `tauri.invoke()` lehnt mit einer ZEICHENKETTE ab, und
 *
 *     const rawMessage = err instanceof Error ? err.message : ''
 *
 * ist bei einer Zeichenkette leer, also sprang der Notnagel ein. Der
 * Waehlerweg las denselben Wert seit jeher mit `reason instanceof Error ?
 * reason.message : String(reason)`, der Coding-Agent mit `errorText`. Nur der
 * Chat nicht.
 *
 * Der Test ist zweigeteilt: das Verhalten von `errorText` wird gefahren, die
 * Verdrahtung in den Hooks wird aus der Quelle gelesen. Hooks lassen sich in
 * dieser Umgebung nicht rendern (vitest laeuft unter `node`, es gibt kein
 * @testing-library/react im Projekt), das ist derselbe Grund und dieselbe
 * Bauart wie in useCodex-caught-value.test.ts.
 *
 * Run: npx vitest run src/hooks/__tests__/der-absendeweg-sagt-denselben-grund.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { errorText } from '../../types/json-guards'

/** Wort fuer Wort, was der Rust-Teil zu einer kaputten GGUF-Datei sagt. */
const RUST_TEXT =
  'The LU Engine started and exited again before it could serve on port 8127. ' +
  'It was tried twice. The engine could not read the model file. It may be ' +
  'damaged, cut short, or of a type this engine cannot run. Open Models, Get ' +
  'new and download it again, or pick another model.'

describe('der gefangene Wert', () => {
  it('eine abgelehnte invoke() ist eine Zeichenkette, und ihr Text kommt an', () => {
    expect(errorText(RUST_TEXT)).toBe(RUST_TEXT)
  })

  it('ein echter Error kommt weiterhin an', () => {
    expect(errorText(new Error(RUST_TEXT))).toBe(RUST_TEXT)
  })

  // Negativkontrolle: genau die alte Zeile, an genau diesem Wert.
  it('die alte Zeile haette den Text verschluckt', () => {
    const err: unknown = RUST_TEXT
    const alt = err instanceof Error ? err.message : ''
    expect(alt).toBe('')
    expect(`Error: ${alt || 'Connection failed'}`).toBe('Error: Connection failed')
  })
})

describe('niemand liest mehr .message von einem ungeprueften Wert', () => {
  const wurzel = resolve(__dirname, '..', '..')

  const dateien = (dir: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) {
        if (e === '__tests__' || e === 'node_modules') continue
        out.push(...dateien(p))
      } else if (/\.tsx?$/.test(e)) out.push(p)
    }
    return out
  }

  it('kein `(x as Error).message` in ausfuehrbarem Code', () => {
    const suender: string[] = []
    for (const f of dateien(wurzel)) {
      for (const [i, zeile] of readFileSync(f, 'utf8').split('\n').entries()) {
        const code = zeile.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
        if (/as Error\)\.message/.test(code)) suender.push(`${f.slice(wurzel.length + 1)}:${i + 1}`)
      }
    }
    expect(suender).toEqual([])
  })

  it('kein `instanceof Error ? x.message : \'\'` mit leerem Notnagel', () => {
    const suender: string[] = []
    for (const f of dateien(wurzel)) {
      for (const [i, zeile] of readFileSync(f, 'utf8').split('\n').entries()) {
        if (/instanceof Error \? \w+\.message : (''|"")/.test(zeile)) {
          suender.push(`${f.slice(wurzel.length + 1)}:${i + 1}`)
        }
      }
    }
    expect(suender).toEqual([])
  })

  it('die drei Chat-Wege bauen ihren Text aus errorText', () => {
    const chat = readFileSync(join(wurzel, 'hooks', 'useChat.ts'), 'utf8')
    const agent = readFileSync(join(wurzel, 'hooks', 'useAgentChat.ts'), 'utf8')
    expect(chat).toContain('const rawMessage = errorText(err)')
    expect(chat).toContain('${errorText(err) || \'Connection failed\'}')
    expect(agent).toContain("const errorMsg = errorText(err) || 'Connection failed'")
  })
})
