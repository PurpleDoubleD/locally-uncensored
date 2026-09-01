/**
 * Das Primaer-Rezept `.lu-primary` und die Hellmodus-Zusicherungen dazu.
 *
 * Warum als Test und nicht als Sichtpruefung: die Testumgebung ist
 * `environment: 'node'` ohne DOM, also kann hier nichts gerendert werden.
 * Was sich aber OHNE DOM pruefen laesst, ist die Eigenschaft, um die es
 * eigentlich geht — dass die Textfarbe auf der Akzentflaeche den
 * WCAG-Kontrast wirklich erreicht. Der Kontrast wird hier aus den echten
 * Tokens in index.css AUSGERECHNET, nicht als Zahl abgeschrieben: wer den
 * Akzent verschiebt, faellt hier durch statt still unlesbar zu werden.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Die Rechnung liegt seit dem Hellmodus-Nachzug in einem eigenen Modul,
// damit der zweite Test sie benutzt statt sie zu kopieren. Die
// Referenzwerte der Spec unten pruefen weiterhin genau diese Funktionen.
import { contrast } from './wcag-contrast'

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf-8')
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf-8')

/** Liest einen `--color-*: #rrggbb;`-Token aus dem @theme-Block. */
function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`))
  if (!m) throw new Error(`Token --${name} fehlt in index.css`)
  return m[1]
}

describe('Kontrastfunktion (Referenzwerte aus der WCAG-Spec)', () => {
  it('rechnet die bekannten Eckwerte richtig', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // Symmetrisch — die Reihenfolge der Argumente darf nichts aendern.
    expect(contrast('#a094f8', '#111827')).toBeCloseTo(contrast('#111827', '#a094f8'), 10)
  })
})

describe('Primaer-Rezept: Kontrast auf der Akzentflaeche', () => {
  const accent = () => token('color-lu-accent')
  const accentHover = () => token('color-lu-accent-hover')
  const onAccent = () => token('color-lu-on-accent')

  it('Text auf dem Akzent erreicht WCAG AA (4.5:1) — im Ruhezustand', () => {
    // Gemessen 2.6.7: #a094f8 gegen #111827 = 6.83:1
    expect(contrast(accent(), onAccent())).toBeGreaterThanOrEqual(4.5)
  })

  it('Text auf dem Akzent erreicht WCAG AA auch im Hover-Zustand', () => {
    // Gemessen 2.6.7: #b1a6ff gegen #111827 = 8.25:1
    expect(contrast(accentHover(), onAccent())).toBeGreaterThanOrEqual(4.5)
  })

  it('weisser Text auf dem Akzent wuerde durchfallen — deshalb dunkler Text', () => {
    // Das ist der Grund fuer --color-lu-on-accent. Faellt diese Zusicherung,
    // ist der Akzent so dunkel geworden, dass weisser Text wieder ginge —
    // dann gehoert die Textfarbe neu entschieden, nicht der Test gestrichen.
    expect(contrast(accent(), '#ffffff')).toBeLessThan(4.5)
  })

  it('die Hellmodus-Kante erreicht 3:1 gegen Weiss (WCAG 1.4.11)', () => {
    // Die Akzentflaeche selbst steht nur 2.6:1 gegen Weiss; die Kante traegt
    // die Buttongrenze im Hellmodus.
    expect(contrast(token('color-lu-accent-edge'), '#ffffff')).toBeGreaterThanOrEqual(3)
  })

  it('die Flaeche steht auf dem dunklen App-Grund fuer sich', () => {
    expect(contrast(accent(), '#1e1e1e')).toBeGreaterThanOrEqual(3)
  })
})

describe('Primaer-Rezept: genau einmal definiert', () => {
  it('.lu-primary hat genau eine Basisregel in index.css', () => {
    const base = css.match(/^\.lu-primary\s*\{/gm) ?? []
    expect(base).toHaveLength(1)
  })

  it('das Rezept nennt keine Farbe als Literal, nur Tokens', () => {
    const block = css.match(/^\.lu-primary\s*\{[^}]*\}/m)?.[0] ?? ''
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(block).toMatch(/var\(--color-lu-accent\)/)
    expect(block).toMatch(/var\(--color-lu-on-accent\)/)
  })

  it('deckt Hover, Fokus und disabled ab — nicht nur die Ruhefarbe', () => {
    expect(css).toMatch(/\.lu-primary:hover:not\(:disabled\)\s*\{/)
    expect(css).toMatch(/\.lu-primary:focus-visible\s*\{/)
    expect(css).toMatch(/\.lu-primary:disabled\s*\{/)
  })

  it('der Fokusring ist in beiden Modi gesetzt und liegt neben der Flaeche', () => {
    const focus = css.match(/\.lu-primary:focus-visible\s*\{[^}]*\}/)?.[0] ?? ''
    expect(focus).toMatch(/outline:\s*2px solid/)
    // Abstand > 0, damit der Ring auf dem Hintergrund liegt und nicht auf dem
    // Akzent selbst (dort haette er kaum Kontrast).
    expect(focus).toMatch(/outline-offset:\s*[1-9]/)
    // Dunkelmodus bekommt eine eigene, helle Ringfarbe.
    expect(css).toMatch(/\.dark \.lu-primary:focus-visible\s*\{[^}]*outline-color/)
  })

  it('disabled sieht nicht aus wie die aktive Variante', () => {
    const dis = css.match(/\.lu-primary:disabled\s*\{[^}]*\}/)?.[0] ?? ''
    // Entsaettigen UND dimmen — Dimmen allein liesse die Flaeche noch violett
    // und damit wie die aktive Primaeraktion aussehen.
    expect(dis).toMatch(/grayscale\(1\)/)
    expect(dis).toMatch(/opacity:\s*0?\.\d+/)
  })
})

describe('Primaer-Rezept: alle drei Bildschirme benutzen dasselbe', () => {
  const SITES: Array<[string, string]> = [
    ['Create (Generate)', '../create/ui/Button.tsx'],
    ['Account (Sign in)', '../auth/AccountPanel.tsx'],
    ['Chat (Send)', '../chat/ChatInput.tsx'],
  ]

  it.each(SITES)('%s traegt .lu-primary', (_name, rel) => {
    expect(read(rel)).toContain('lu-primary')
  })

  it.each(SITES)('%s schreibt kein eigenes Graustufen-Rezept mehr ab', (_name, rel) => {
    const src = read(rel)
    // Genau die drei Fuellungen, die das Audit als "drei graue Primaerbuttons"
    // gefunden hatte. Keine davon darf zurueckkehren.
    expect(src).not.toContain('bg-gray-900 text-white')
    expect(src).not.toContain('dark:bg-white/10 dark:text-white')
    expect(src).not.toContain('bg-white/8 text-gray-300')
  })
})

describe('Hellmodus: keine dark-only Flaeche ohne Gegenstueck', () => {
  // Die Dateien, die in dieser Welle re-verifiziert und bereinigt wurden.
  // Jedes `bg-[#...]` darin muss entweder ein `dark:`-Praefix tragen oder
  // eine Akzentfarbe sein, die in beiden Modi gilt.
  const FILES = [
    '../chat/ChatView.tsx',
    '../chat/ChatInput.tsx',
    '../create/experimental/CreateExperimental.tsx',
    '../create/ui/Button.tsx',
    '../auth/AccountPanel.tsx',
  ]

  it.each(FILES)('%s: jede Hex-Flaeche ist modus-bewusst', (rel) => {
    const src = read(rel)
    const offenders: string[] = []
    for (const m of src.matchAll(/(\S*?)bg-\[(#[0-9a-fA-F]{3,8})\]/g)) {
      const prefix = m[1]
      // `dark:bg-[#...]` ist in Ordnung; `bg-[#7c3aed]` ist der Cloud-Akzent,
      // der bewusst in beiden Modi dieselbe Farbe traegt.
      if (prefix.includes('dark:')) continue
      if (m[2].toLowerCase() === '#7c3aed') continue
      offenders.push(m[0])
    }
    expect(offenders).toEqual([])
  })

  it('die Create-Wurzel setzt ihre Textfarbe nicht mehr fuer beide Modi', () => {
    const src = read('../create/experimental/CreateExperimental.tsx')
    expect(src).toContain('text-gray-900 dark:text-gray-200')
  })
})
