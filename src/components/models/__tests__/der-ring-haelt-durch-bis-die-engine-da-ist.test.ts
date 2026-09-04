/**
 * Nachpruefung G3, 04.09.2026, zwei Laeufe am echten Build: der Knopftext
 * nennt das angeklickte Modell nach 15 bzw. 29 ms, die Engine liefert es nach
 * 16 734 bzw. 19 313 ms. Der Vorlauf ist gewollt, der Knopf nennt die Wahl,
 * und die Gegenrichtung (12,4 s hinterher) war der Befund davor.
 *
 * Was fehlte, war die Verlaesslichkeit des Ladehinweises daneben. Er hing an
 * `imWechselZu`, dem eigenen Zustand dieses Bauteils. Der kennt nur Kliks in
 * diesem Menue und stirbt mit dem Bauteil:
 *
 *   - Klick auf die Use-Kachel der Models-Seite: nie gesetzt.
 *   - Reiter wechseln, waehrend geladen wird: beim Zurueckkommen weg.
 *
 * In beiden Faellen stand ein blanker Name ueber einem Port, hinter dem noch
 * ein anderes Modell sass. Der Riegel um den Swap weiss es besser: er wird
 * genommen, bevor der Swap beginnt, gilt fuer jede Tuer und ueberlebt jedes
 * Neuzeichnen.
 *
 * Lauf: npx vitest run src/components/models/__tests__/der-ring-haelt-durch-bis-die-engine-da-ist.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(resolve(__dirname, '..', 'ModelSelector.tsx'), 'utf8')
const LOCK = readFileSync(resolve(__dirname, '..', '..', '..', 'api', 'lu-engine-swap-lock.ts'), 'utf8')

describe('der Ladehinweis am Waehlerknopf', () => {
  it('fragt den Riegel und nicht nur den eigenen Zustand', () => {
    const zeile = SRC.split('\n').find((l) => l.includes('const wechselLaeuft ='))
    expect(zeile).toBeDefined()
    const block = SRC.slice(SRC.indexOf('const wechselLaeuft ='), SRC.indexOf('const wechselLaeuft =') + 220)
    expect(block).toContain('imWechselZu')
    expect(block).toContain('swapLaeuft')
  })

  it('haengt den Ring und aria-busy an genau diesen Zustand', () => {
    expect(SRC).toContain('aria-busy={wechselLaeuft}')
    expect(SRC).toContain('{wechselLaeuft ? (')
  })

  it('gilt nur, solange der Knopf ein Modell unseres Steckplatzes nennt', () => {
    // Ein Swap auf der Models-Seite darf keinen Ring an einen Cloud-Namen
    // haengen, der mit ihm nichts zu tun hat.
    const block = SRC.slice(SRC.indexOf('const wechselLaeuft ='), SRC.indexOf('const wechselLaeuft =') + 220)
    expect(block).toContain("getProviderIdFromModel(gezeigtesModell ?? '') === 'openai'")
  })
})

describe('useLuEngineSwapRunning', () => {
  it('tastet ab, weil der Riegel kein Abonnement kennt', () => {
    expect(LOCK).toContain('export function useLuEngineSwapRunning')
    expect(LOCK).toContain('setInterval')
    expect(LOCK).toContain('clearInterval')
  })

  it('tastet deutlich haeufiger ab als ein Swap dauert', () => {
    const m = LOCK.match(/export const SWAP_WATCH_MS = (\d+)/)
    expect(m).not.toBeNull()
    const takt = Number(m![1])
    expect(takt).toBeGreaterThan(0)
    // Der kuerzeste gemessene Swap lag bei 16,7 s. Ein Takt, der davon mehr
    // als ein Zwanzigstel frisst, macht die Anzeige wieder unzuverlaessig.
    expect(takt).toBeLessThanOrEqual(16_700 / 20)
  })
})
