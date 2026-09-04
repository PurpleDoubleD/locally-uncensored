/**
 * In der Modellkarte standen zwei Erklaerungen zum title, die sich
 * widersprachen.
 *
 * Die eine, oben am Namen: "der volle bleibt im title, denn ein Fehlerbericht
 * braucht ihn." Die andere, 26 Zeilen tiefer: "Auch nicht im title. Da stand
 * er bis zur Nachpruefung G3 am 04.09.2026, mit der Begruendung, ein
 * Fehlerbericht brauche ihn." Die zweite beschreibt, was der Code tut, die
 * erste war von der Runde davor uebrig und nannte als Grund genau das, was
 * G3 verworfen hat. Wer die falsche liest, baut den Steckplatznamen wieder
 * ein.
 *
 * Ein Kommentar ist nicht ausfuehrbar, also haelt dieser Waechter ihn gegen
 * den Code daneben: das title-Feld traegt den Anzeigenamen, und die Datei
 * darf nichts anderes behaupten.
 *
 * Run: npx vitest run src/components/models/__tests__/die-karte-sagt-eine-sache-ueber-den-title.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const KARTE = readFileSync(resolve(__dirname, '..', 'ModelCard.tsx'), 'utf8')

describe('die Modellkarte und ihr title', () => {
  it('der title traegt den Anzeigenamen, nicht den vollen', () => {
    expect(KARTE).toContain('title={displayModelName(model.name)}')
  })

  it('und keine Zeile behauptet das Gegenteil', () => {
    expect(KARTE).not.toContain('bleibt im title')
  })

  it('die Erklaerung, die stimmt, steht noch da', () => {
    // Sonst waere der Widerspruch auch dadurch weg, dass die richtige
    // Begruendung geloescht wird und der Grund fuer den Verzicht verschwindet.
    expect(KARTE).toContain('Auch nicht im title.')
  })
})
