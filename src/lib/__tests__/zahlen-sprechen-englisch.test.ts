/**
 * Zahlen in der Oberflaeche folgen der Sprache der Oberflaeche, nicht der des
 * Betriebssystems.
 *
 * Persona P2, 04.09.2026, auf der deutschen Windows-Box: die Statuszeile der
 * Engine lautete "Engine running · Phi-4-mini-instruct-Q4_K_M · ctx 8.192".
 * Gemeint sind 8192 Token. In einer englischen Oberflaeche liest sich "8.192"
 * als eine Zahl kleiner als neun, und zwei Zeilen tiefer stand dieselbe Zahl
 * im Eingabefeld richtig als 8192. Auch die CivitAI-Treffer waren betroffen,
 * "9.766 downloads" und "14.143 downloads".
 *
 * Hausregel: keine lokalisierten Systemtexte durchreichen.
 *
 * Run: npx vitest run src/lib/__tests__/zahlen-sprechen-englisch.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { formatCount } from '../formatters'

describe('formatCount', () => {
  it('trennt Tausender mit Komma, egal welche Sprache der Rechner spricht', () => {
    expect(formatCount(8192)).toBe('8,192')
    expect(formatCount(9766)).toBe('9,766')
    expect(formatCount(14143)).toBe('14,143')
  })

  it('kleine Zahlen bleiben, wie sie sind', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
  })

  // Negativkontrolle: genau das war der Fehler. Auf einer deutschen Maschine
  // liefert die sprachlose Fassung "8.192".
  it('die sprachlose Fassung waere von der Maschine abhaengig', () => {
    expect((8192).toLocaleString('de-DE')).toBe('8.192')
    expect(formatCount(8192)).not.toBe((8192).toLocaleString('de-DE'))
  })
})

describe('niemand ruft mehr die sprachlose Fassung', () => {
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

  it('kein toLocaleString() ohne Sprache auf einer Zahl', () => {
    const suender: string[] = []
    for (const f of dateien(wurzel)) {
      const text = readFileSync(f, 'utf8')
      for (const [i, zeile] of text.split('\n').entries()) {
        // Datumsangaben bleiben ausgenommen: ein Datum ist keine Zahl, die
        // sich beim Lesen um drei Zehnerpotenzen vertut.
        if (/\.toLocaleString\(\)/.test(zeile) && !/Date\(/.test(zeile)) {
          suender.push(`${f.slice(wurzel.length + 1)}:${i + 1}`)
        }
      }
    }
    expect(suender).toEqual([])
  })
})
