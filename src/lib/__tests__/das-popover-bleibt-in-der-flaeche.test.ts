import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { platzFuerPopover } from '../popover-placement'

/**
 * Der Befund vom 07.09.2026: das Kontextfenster im Chat war abgeschnitten.
 *
 * Gemessen bei 1280x800 (`e2e/kontextfenster-wird-nicht-abgeschnitten.spec.ts`,
 * vor der Reparatur): die Liste stand von y=686 bis y=874, das Fenster endet
 * bei 800 und der `<main>`-Kasten mit `overflow-hidden` schon bei 790,8. Die
 * Zahlen unten sind genau diese Messung, nur in die CSS-Pixel der Liste
 * umgerechnet (die App liegt unter `zoom: var(--ui-scale)`).
 *
 * Was hier NICHT geprueft wird, ist das Messen selbst: dafuer braucht es ein
 * Layout, und die Testumgebung dieses Hauses ist `environment: 'node'`. Das
 * uebernimmt der e2e-Fall am laufenden Fenster. Hier steht die Entscheidung,
 * die aus vier Zahlen folgt.
 */

/** Der gemessene Fall aus dem Chat, in CSS-Pixeln. */
const CHAT = {
  ankerOben: 574,
  ankerUnten: 592,
  grenzeOben: 80,
  grenzeUnten: 687,
  inhaltHoehe: 162,
  abstand: 4,
  luft: 8,
}

describe('das Popover kippt, wenn unten kein Platz mehr ist', () => {
  it('der gemessene Chat-Fall geht nach oben auf', () => {
    // Unter dem Ausloeser: 687 - 592 - 12 = 83 Pixel fuer 162 Pixel Inhalt.
    // Darueber: 574 - 80 - 12 = 482. Genau das war der Fehler.
    const p = platzFuerPopover(CHAT)
    expect(p.nachOben).toBe(true)
    expect(p.maxHoehe).toBe(482)
  })

  it('und bleibt unten, solange es dort passt', () => {
    // Derselbe Ausloeser in einer Kopfzeile (so steht er im Code-Bereich):
    // unten ist Platz, also gibt es keinen Grund zu kippen.
    const p = platzFuerPopover({ ...CHAT, ankerOben: 100, ankerUnten: 118 })
    expect(p.nachOben).toBe(false)
    expect(p.maxHoehe).toBe(557)
  })

  it('NEGATIVKONTROLLE: gleich viel Platz kippt NICHT', () => {
    // Kippen ist die Ausnahme und braucht einen Grund. Bei Gleichstand bleibt
    // das Menue, wo Menues in dieser App aufgehen: unter ihrem Ausloeser.
    const p = platzFuerPopover({
      ...CHAT, grenzeOben: 0, ankerOben: 100, ankerUnten: 200, grenzeUnten: 300,
    })
    expect(p.nachOben).toBe(false)
  })
})

describe('die Hoehe ist gedeckelt, und der Deckel luegt nicht', () => {
  it('bei wenig Platz auf beiden Seiten gewinnt die groessere und wird gekuerzt', () => {
    // Das flache Fenster: unten 83, oben 40. Es passt nirgends, also nimmt es
    // die groessere Seite und scrollt darin.
    const p = platzFuerPopover({ ...CHAT, grenzeOben: 522 })
    expect(p.nachOben).toBe(false)
    expect(p.maxHoehe).toBe(83)
  })

  it('KEINE Mindesthoehe, denn eine Mindesthoehe ist die Zusage abzuschneiden', () => {
    // Der erste Anlauf hatte 96 Pixel als Untergrenze. Im 300 Pixel hohen
    // Fenster stand die Liste damit wieder im Geschnittenen, nur weniger weit.
    // Der Deckel ist deshalb NIE groesser als der Platz, den es wirklich gibt.
    const eng = platzFuerPopover({ ...CHAT, grenzeUnten: 620, grenzeOben: 560 })
    expect(eng.maxHoehe).toBeLessThanOrEqual(620 - 592 - 12)
  })

  it('und nie negativ, auch wenn der Anker schon ausserhalb steht', () => {
    const p = platzFuerPopover({ ...CHAT, grenzeUnten: 500, grenzeOben: 480 })
    expect(p.maxHoehe).toBeGreaterThanOrEqual(0)
  })
})

describe('der Kontextwaehler benutzt diese Rechnung wirklich', () => {
  const SRC = readFileSync(
    resolve(__dirname, '..', '..', 'components', 'chat', 'ContextDropdown.tsx'),
    'utf8',
  )

  it('die Richtung steht nicht mehr fest im Klassennamen', () => {
    // DER Fehler, buchstaeblich: `top-full` ohne Alternative. Steht er wieder
    // allein da, ist der Befund zurueck.
    expect(SRC).toContain('platzFuerPopover')
    expect(SRC).toMatch(/nachOben \? 'bottom-full mb-1' : 'top-full mt-1'/)
  })

  it('und die Liste darf scrollen, sonst nuetzt der Deckel nichts', () => {
    expect(SRC).toContain('overflow-y-auto')
    expect(SRC).toContain('maxHeight: platz.maxHoehe')
  })

  it('gemessen wird gegen die abschneidende Flaeche, nicht gegen das Fenster', () => {
    // `window.innerHeight` liegt in dieser App 9 px unter der Kante, die
    // wirklich schneidet (`<main>` mit overflow-hidden). Wer dagegen rechnet,
    // laesst genau diese 9 px durchgehen.
    expect(SRC).toContain('abschneidendeFlaeche')
    expect(SRC).toMatch(/overflowY !== 'visible'/)
  })
})
