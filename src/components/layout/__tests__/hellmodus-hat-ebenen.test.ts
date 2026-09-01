/**
 * Der Hellmodus hat Ebenen — D-S42.
 *
 * Befund: „Keine Ebenen: Sidebar, Chat-Pane und Composer sind alle weiss,
 * getrennt nur durch 1px gray-200, waehrend Dark drei Stufen hat."
 *
 * Beim Nachmessen war der Befund im Ergebnis richtig und in der Begruendung
 * daneben — und das ist der Grund, warum dieser Test rechnet statt zu zitieren.
 * Der STUFENABSTAND war naemlich in beiden Modi fast derselbe:
 *
 *   dunkel  #141414 → #1e1e1e   = 1,105:1
 *   hell    #f3f4f6 → #ffffff   = 1,100:1
 *
 * Was fehlte, war die KANTE. Beide Panes tragen einen 1px-Ring, und der ist
 * hell praktisch nicht vorhanden:
 *
 *   dunkel  ring-white/[0.05] auf #1e1e1e = #292929 gegen #141414 = 1,271:1
 *   hell    ring-black/[0.04] auf #ffffff = #f5f5f5 gegen #f3f4f6 = 1,008:1
 *
 * Eine Pane ohne spuerbare Stufe UND ohne Kante liegt nicht auf der Leinwand,
 * sie IST die Leinwand. Geaendert ist deshalb genau ein Wert: die Leinwand
 * geht auf gray-200. Damit traegt die Stufe allein, und der unangetastete Ring
 * gewinnt mit.
 *
 * Alle Zahlen unten sind hier gerechnet, nicht abgeschrieben; sie wurden
 * ausserdem am laufenden Fenster (localhost:5273, Canvas-Pixel aus den
 * berechneten Stilen) gegengeprueft.
 *
 * Run: npx vitest run src/components/layout/__tests__/hellmodus-hat-ebenen.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LAYOUT = resolve(__dirname, '..')
const SHELL = readFileSync(resolve(LAYOUT, 'AppShell.tsx'), 'utf-8')
const HEADER = readFileSync(resolve(LAYOUT, 'Header.tsx'), 'utf-8')
const TITLEBAR = readFileSync(resolve(LAYOUT, 'Titlebar.tsx'), 'utf-8')
const CSS = readFileSync(resolve(LAYOUT, '..', '..', 'index.css'), 'utf-8')

/** '#141414' -> [20, 20, 20]. Damit die Farbe des Tokens hier nachgerechnet
 *  und nicht abgeschrieben wird. */
const hex = (s: string): readonly [number, number, number] => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
]

/* ── WCAG 2.1, relative Luminanz und Kontrastverhaeltnis ─────────────────── */
type RGB = readonly [number, number, number]
const lum = ([r, g, b]: RGB) => {
  const f = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const kontrast = (a: RGB, b: RGB) => {
  const [la, lb] = [lum(a), lum(b)]
  return +(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05))).toFixed(3)
}
/** Deckt `over` mit `alpha` ueber `under` — ein 1px-Ring ist genau das. */
const ueber = (over: RGB, under: RGB, alpha: number): RGB =>
  [0, 1, 2].map((i) => over[i] * alpha + under[i] * (1 - alpha)) as unknown as RGB

// Tailwind v4 liefert seine Graustufen als oklch; die sRGB-Entsprechungen sind
// am laufenden Fenster ueber ein 1x1-Canvas ausgelesen worden.
const WHITE: RGB = [255, 255, 255]
const GRAY_100: RGB = [243, 244, 246]   // oklch(0.967 0.003 264.542)
const GRAY_200: RGB = [229, 231, 235]   // oklch(0.928 0.006 264.531)
const DARK_CANVAS: RGB = [20, 20, 20]   // #141414
const DARK_PANE: RGB = [30, 30, 30]     // #1e1e1e

describe('so stand es vorher — der Befund, nachgerechnet', () => {
  it('hell und dunkel hatten fast denselben Stufenabstand', () => {
    expect(kontrast(WHITE, GRAY_100)).toBe(1.101)
    expect(kontrast(DARK_PANE, DARK_CANVAS)).toBe(1.105)
  })

  it('aber die helle Kante war 34-mal schwaecher als die dunkle', () => {
    const dunkleKante = ueber(WHITE, DARK_PANE, 0.05)   // ring-white/[0.05]
    const helleKante = ueber([0, 0, 0], WHITE, 0.04)    // ring-black/[0.04]
    const dunkel = kontrast(dunkleKante, DARK_CANVAS)
    const hell = kontrast(helleKante, GRAY_100)
    expect(dunkel).toBe(1.271)
    expect(hell).toBe(1.008)
    // Abstand ueber 1,0 gemessen — das ist die Groesse, die zaehlt.
    expect(Math.round((dunkel - 1) / (hell - 1))).toBe(34)
  })
})

describe('so steht es jetzt', () => {
  it('die Pane hebt sich hell staerker ab als dunkel', () => {
    const hell = kontrast(WHITE, GRAY_200)
    expect(hell).toBe(1.238)
    expect(hell).toBeGreaterThan(kontrast(DARK_PANE, DARK_CANVAS))
  })

  it('und die unangetastete Kante gewinnt mit', () => {
    const helleKante = ueber([0, 0, 0], WHITE, 0.04)
    expect(kontrast(helleKante, GRAY_200)).toBe(1.134)
  })

  it('der Wert steht wirklich an der Leinwand', () => {
    // Die dunkle Haelfte heisst seit D-T06 `dark:bg-lu-canvas` statt
    // `dark:bg-[#141414]`. Der WERT ist derselbe — das Token ist in
    // index.css auf #141414 definiert und wird dort gegengeprueft
    // (components/__tests__/zwei-akzente-und-eine-leinwand.test.ts). Die
    // helle Haelfte, um die es in diesem Befund geht, ist unangetastet.
    expect(SHELL).toMatch(/className="h-screen w-screen overflow-hidden bg-gray-200 dark:bg-lu-canvas/)
    expect(DARK_CANVAS).toEqual(hex('#141414'))
    expect(CSS).toMatch(/--color-lu-canvas:\s*#141414/)
  })

  it('die Pane und der Ring sind NICHT angefasst', () => {
    // Der Ring sitzt auch auf der Sidebar; ihn nur hier zu schaerfen haette
    // zwei Raender einer Familie auseinanderlaufen lassen.
    expect(SHELL).toMatch(/rounded-xl bg-white dark:bg-\[#1e1e1e\] ring-1 ring-black\/\[0\.04\] dark:ring-white\/\[0\.05\]/)
  })
})

describe('Kopfzeile und Fensterbalken gehoeren zur Leinwand, in beiden Modi', () => {
  it('dunkel teilen sie sich seit jeher #141414 — jetzt unter einem Namen', () => {
    // Vorher stand die Zahl dreimal da und niemand konnte sagen, ob die drei
    // Vorkommen zusammengehoeren. Jetzt sagt der Name es.
    expect(SHELL).toContain('dark:bg-lu-canvas')
    expect(HEADER).toContain('dark:bg-lu-canvas')
    expect(TITLEBAR).toContain('dark:bg-lu-canvas')
    for (const src of [SHELL, HEADER, TITLEBAR]) expect(src).not.toContain('dark:bg-[#141414]')
  })

  it('hell tun sie es jetzt auch', () => {
    // Vorher: Leinwand gray-100, Kopfzeile gray-100 — gleich, aber beide zu
    // hell. Jetzt beide gray-200, also weiterhin eine Familie, nur tiefer.
    expect(HEADER).toMatch(/bg-gray-200 dark:bg-lu-canvas/)
    expect([...TITLEBAR.matchAll(/bg-gray-200 dark:bg-lu-canvas/g)]).toHaveLength(2)
  })

  it('und der aktive Reiter ist dadurch hell ueberhaupt erst eine Flaeche', () => {
    // Am laufenden Fenster gemessen: die aktive Pille war `bg-gray-100` auf
    // einer `bg-gray-100`-Leiste, Kontrast 1,000:1. Der aktive View war hell
    // nur an der Textfarbe erkennbar — genau das, was D-A6 abstellen wollte.
    expect(HEADER).toMatch(/const NAV_ACTIVE = 'bg-white dark:bg-white\/\[0\.08\]/)
    expect(kontrast(GRAY_100, GRAY_100)).toBe(1)
    expect(kontrast(WHITE, GRAY_200)).toBe(1.238)
    // Dunkel: white/[0.08] ueber #141414.
    expect(kontrast(ueber(WHITE, DARK_CANVAS, 0.08), DARK_CANVAS)).toBe(1.230)
  })

  it('kein Hover in der Leiste ist dadurch unsichtbar geworden', () => {
    // `hover:bg-gray-200` auf einer gray-200-Leiste waere 1,000:1 — genau der
    // Fehler, den die aktive Pille vorher hatte. Der Burger trug ihn.
    const zeilen = HEADER.split('\n').filter((l) => l.includes('hover:bg-gray-'))
    expect(zeilen.length).toBeGreaterThan(0)
    for (const z of zeilen) {
      expect(z, `unsichtbarer Hover: ${z.trim()}`).not.toContain('hover:bg-gray-200')
    }
  })
})
