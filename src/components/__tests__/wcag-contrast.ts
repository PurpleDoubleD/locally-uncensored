/**
 * WCAG-2.1-Kontrastrechnung fuer die Design-Tests. EINE Implementierung.
 *
 * Sie stand bis hierher als lokale Kopie in `primary-recipe.test.ts`
 * (f336b91e). Als der Hellmodus-Posten weitere Farben bekam, war der
 * naheliegende Weg eine zweite Kopie — und zwei Kopien einer Rechnung sind
 * genau der Zustand, in dem eine davon still falsch wird. Deshalb hier,
 * einmal, importiert von beiden.
 *
 * Die Referenzwerte der Spec (Schwarz/Weiss = 21, Weiss/Weiss = 1,
 * Symmetrie) werden in `primary-recipe.test.ts` gegen DIESE Funktionen
 * geprueft, nicht gegen eine dritte Kopie.
 *
 * Keine Testdatei: `vitest.config.ts` sammelt nur `**\/__tests__\/**\/*.test.ts`.
 */

/** WCAG 2.1 relative Luminanz eines #rrggbb-Werts. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const channel = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG 2.1 Kontrastverhaeltnis zweier #rrggbb-Werte, immer >= 1. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * `rgb(31 41 55)` / `rgb(31, 41, 55)` → `#1f2937`. Der Rescue-Layer in
 * index.css schreibt seine Farben in dieser Notation; ohne Umrechnung
 * liesse sich nicht nachrechnen, was er im Hellmodus tatsaechlich anrichtet.
 */
export function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)/)
  if (!m) throw new Error(`Kein rgb()-Wert: ${rgb}`)
  return `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Deckt eine halbdurchsichtige Vordergrundfarbe ueber einen deckenden
 * Hintergrund und gibt die tatsaechlich gesehene Farbe zurueck. Ohne das
 * laesst sich `text-emerald-400/70` oder `bg-white/10` nicht ausrechnen —
 * und genau solche Werte stehen in den Dateien, um die es geht.
 * `alpha` ist 0..1, gerechnet wird linear im sRGB-Byte-Raum, wie der
 * Compositor es tut.
 */
export function over(fg: string, bg: string, alpha: number): string {
  const f = fg.replace('#', '')
  const b = bg.replace('#', '')
  const mix = (i: number) => {
    const a = parseInt(f.slice(i, i + 2), 16)
    const c = parseInt(b.slice(i, i + 2), 16)
    return Math.round(a * alpha + c * (1 - alpha))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${mix(0)}${mix(2)}${mix(4)}`
}
