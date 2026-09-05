/**
 * Was ein Kunde von 2.6.7 nach dem Update auf 2.6.8 sieht.
 *
 * GEMESSEN, nicht hergeleitet. Am 05.09.2026 auf der Windows-Box: 2.6.6
 * installiert, gestartet, auf 2.6.8 aktualisiert, danach das Feld
 * `sidebarOpen` aus dem gespeicherten Zustand entfernt, weil genau so der
 * Zustand eines echten 2.6.7-Kunden aussieht. Nach dem Neuladen:
 *
 *     sichtbare Gespraechszeilen : 0
 *     Loeschknoepfe              : 0
 *     "Expand sidebar" vorhanden : ja
 *
 * Seine 109 Unterhaltungen lagen vollstaendig in der Datenbank. Er sah keine.
 *
 * Der Mechanismus, in beiden Baeumen nachgelesen:
 *   2.6.7 (`v2.6.7`, uiStore.ts:85): `sidebarOpen: true`, und `partialize`
 *         speicherte nur `explorerWidth` und `explorerCollapsed`. Der Wert
 *         wurde also nie abgelegt.
 *   2.6.8 (uiStore.ts): `sidebarOpen: false`, und `partialize` speichert ihn.
 * Wer keinen abgelegten Wert hat, bekommt den neuen Startwert.
 *
 * Run: npx vitest run src/stores/__tests__/der-bestandskunde-behaelt-seine-liste.test.ts
 */
import { describe, it, expect } from 'vitest'
import { migriereUiZustand } from '../uiStore'

describe('der Sprung von 2.6.7 auf 2.6.8', () => {
  /** Genau das, was 2.6.7 abgelegt hat: zwei Felder, kein sidebarOpen. */
  const wie267 = { explorerWidth: 280, explorerCollapsed: false }

  it('ein 2.6.7-Zustand bekommt die Liste zurueck', () => {
    // DER FALL. Ohne die Wanderung faellt er auf den neuen Startwert `false`
    // und der Kunde sieht seine Chats nicht mehr.
    const raus = migriereUiZustand(wie267, 0) as Record<string, unknown>
    expect(raus.sidebarOpen, 'der Bestandskunde startet zugeklappt').toBe(true)
    expect(raus.explorerWidth, 'die Wanderung hat andere Felder verloren').toBe(280)
    expect(raus.explorerCollapsed).toBe(false)
  })

  it('wer sie selbst zugeklappt hat, behaelt sie zugeklappt', () => {
    // DIE ABGRENZUNG, und sie ist der Grund fuer das `in` statt eines
    // Wahrheitstests: "nie abgelegt" und "auf false abgelegt" sehen bei
    // `!alt.sidebarOpen` gleich aus. Wer den Wert gesetzt hat, hat eine
    // Entscheidung getroffen, und die gehoert ihm.
    const raus = migriereUiZustand({ ...wie267, sidebarOpen: false }, 0) as Record<string, unknown>
    expect(raus.sidebarOpen, 'die Wanderung hat eine eigene Wahl ueberschrieben').toBe(false)
  })

  it('eine frische Installation laeuft hier gar nicht durch', () => {
    // Sie hat keinen gespeicherten Zustand. Die Produktentscheidung, dass ein
    // NEUER Nutzer schlank startet, bleibt damit unberuehrt.
    expect(migriereUiZustand(undefined, 0)).toBeUndefined()
    expect(migriereUiZustand(null, 0)).toBeNull()
  })

  it('ein schon gewanderter Zustand wird nicht noch einmal angefasst', () => {
    // Version 1 ist die Fassung NACH dieser Wanderung. Liefe sie erneut,
    // wuerde sie ein spaeteres Zuklappen wieder aufreissen.
    const raus = migriereUiZustand({ ...wie267, sidebarOpen: false }, 1) as Record<string, unknown>
    expect(raus.sidebarOpen).toBe(false)
    const ohne = migriereUiZustand(wie267, 1) as Record<string, unknown>
    expect(ohne.sidebarOpen, 'Version 1 ohne das Feld darf nichts erfinden').toBeUndefined()
  })
})
