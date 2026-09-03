/**
 * Das Promptfenster und die drei Leisten darueber sind GENAU gleich breit.
 *
 * David, 03.09.2026, am echten Windows-Build: das Fenster im Chat und im
 * Coding-Bereich war ihm zu gross und soll so breit sein wie im Create-Tab,
 * eventuell minimal groesser, "so dass jedes UI Button platz dafuer hat".
 *
 * Gemessen waren es 1258 px gegen 760 px in Create, weil hier `max-w-[70%]`
 * stand. Die Zahl liegt jetzt in `composer-width.ts`, und dieser Test haelt
 * sie dort: LoopBar, GoalBar und GroupCostHint kleben direkt UEBER dem
 * Fenster. Wer eine der vier Stellen wieder mit einer eigenen Zahl versieht,
 * bekommt Leisten, die breiter sind als das Fenster darunter.
 *
 * Run: npx vitest run src/components/chat/__tests__/das-promptfenster-ist-so-breit-wie-create.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { COMPOSER_MAX_W } from '../composer-width'

const CHAT = resolve(__dirname, '..')
const CREATE_COMPOSER = resolve(__dirname, '../../create/experimental/Composer.tsx')

/** Die vier Stellen, die zusammen das Promptfenster und seine Leisten sind. */
const STELLEN = ['ChatInput.tsx', 'LoopBar.tsx', 'GoalBar.tsx', 'GroupCostHint.tsx']

describe('das Promptfenster ist so breit wie im Create-Tab', () => {
  it('keine der vier Stellen traegt eine eigene Breite', () => {
    for (const datei of STELLEN) {
      const src = readFileSync(resolve(CHAT, datei), 'utf8')
      // NEGATIVKONTROLLE des alten Zustands: genau dieser Ausdruck stand in
      // allen vier Dateien und ist der Grund fuer 1258 px.
      expect(src, `${datei} ist wieder auf einen Prozentwert zurueckgefallen`)
        .not.toMatch(/max-w-\[70%\]/)
      // Und auch keine andere eigene Zahl, egal welche.
      expect(src, `${datei} setzt seine Breite selbst statt COMPOSER_MAX_W zu nehmen`)
        .not.toMatch(/max-w-\[[^\]]+\]/)
      expect(src, `${datei} liest die Breite nicht aus composer-width`)
        .toMatch(/COMPOSER_MAX_W/)
    }
  })

  it('die Breite ist Creates Breite plus etwas, und nicht weniger', () => {
    const create = readFileSync(CREATE_COMPOSER, 'utf8')
    const treffer = create.match(/max-w-\[(\d+)px\]/)
    expect(treffer, 'im Create-Composer steht keine Breite mehr, an der man sich messen kann').not.toBeNull()
    const createBreite = Number(treffer![1])

    const eigene = COMPOSER_MAX_W.match(/^max-w-\[(\d+)px\]$/)
    expect(eigene, `COMPOSER_MAX_W ist keine feste Pixelzahl: ${COMPOSER_MAX_W}`).not.toBeNull()
    const breite = Number(eigene![1])

    // "so gross wie im create tab, eventuell minimal groesser": nicht
    // schmaler, und nicht mehr als 120 px darueber, sonst ist es nicht mehr
    // minimal und der Wunsch ist wieder verfehlt.
    expect(breite).toBeGreaterThanOrEqual(createBreite)
    expect(breite).toBeLessThanOrEqual(createBreite + 120)
  })

  it('die Leiste bricht nicht um: die Breite deckt die gemessene Mindestbreite mit Luft', () => {
    // Am laufenden Release-Build gemessen, 03.09.2026: die Aktionsleiste im
    // Chat brauchte im Ruhezustand 532 px (feste Teile 486, Abstaende 28,
    // Innenrand 18). Waehrend eines Laufs kommen der Effort-Regler und der
    // Stop-Knopf dazu, und ein langer Modellname wiegt schwerer als der
    // gemessene. Deshalb ist hier Luft eingefordert und nicht nur Deckung.
    const GEMESSENE_MINDESTBREITE = 532
    const breite = Number(COMPOSER_MAX_W.match(/(\d+)/)![1])
    expect(breite).toBeGreaterThan(GEMESSENE_MINDESTBREITE + 200)
  })
})
