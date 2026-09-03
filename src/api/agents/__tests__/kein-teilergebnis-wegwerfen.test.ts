import { describe, it, expect } from 'vitest'
import { gesammeltesMaterial } from '../sub-agent'

/**
 * Was ein Unteragent gefunden hat, gehoert dem Auftraggeber — auch wenn ihm
 * die Schritte ausgehen.
 *
 * Ein Persona-Lauf am 03.09.2026 bekam dreimal genau das zurueck:
 *
 *   [Agent halted: ReAct loop iteration cap reached (5 / 5) …] (no partial answer)
 *
 * nach 45, 65 und 78 Sekunden. Bei einem lokalen Modell ist das die teuerste
 * Sekunde im ganzen Ablauf, und sie wurde verworfen. Dabei lag die Arbeit da:
 * `finalContent` sammelt nur die PROSA-Zuege, aber jedes Werkzeugergebnis
 * steht als `role: 'tool'` in `messages`. Wer alle Schritte in Werkzeuge
 * steckt — also genau der Fall, der die Kappe reisst —, hat am Ende viel
 * gefunden und nichts gesagt.
 *
 * Zurueck geht deshalb Rohmaterial, ausdruecklich als solches benannt. Es ist
 * keine Antwort, und es darf nicht wie eine aussehen: der Hauptagent soll
 * damit weiterarbeiten, nicht sie abschreiben.
 */

const tool = (content: string) => ({ role: 'tool' as const, content })

describe('gesammeltesMaterial', () => {
  it('gibt zurueck, was die Werkzeuge geliefert haben', () => {
    const m = gesammeltesMaterial([
      { role: 'user', content: 'egal' },
      tool('1. HmbTG\n   https://transparenz.hamburg.de\n   Das Gesetz regelt…'),
      { role: 'assistant', content: '' },
      tool('Antwortfrist betraegt einen Monat, § 13 Abs. 1.'),
    ] as never)
    expect(m).toContain('transparenz.hamburg.de')
    expect(m).toContain('§ 13 Abs. 1')
  })

  it('benennt es als Rohmaterial, nicht als Antwort', () => {
    const m = gesammeltesMaterial([tool('irgendein Treffer')] as never)
    expect(m).toMatch(/gathered|material/i)
    // Es darf nirgends so klingen, als sei die Aufgabe erledigt.
    expect(m).not.toMatch(/\banswer:|conclusion|summary of findings/i)
  })

  it('zaehlt fehlgeschlagene Werkzeuge, statt sie als Material auszugeben', () => {
    // „Web search failed" ist kein Fund. Als Material waere es Rauschen, als
    // Zahl ist es die wichtigste Auskunft ueberhaupt: es wurde nichts gefunden.
    const m = gesammeltesMaterial([
      tool('Web search failed: All search tiers failed'),
      tool('Web search failed: All search tiers failed'),
      tool('Ein echter Treffer'),
    ] as never)
    expect(m).toContain('Ein echter Treffer')
    expect(m).not.toContain('All search tiers failed')
    expect(m).toMatch(/2 .*fail/i)
  })

  it('gibt leer zurueck, wenn wirklich nichts da ist', () => {
    expect(gesammeltesMaterial([{ role: 'user', content: 'x' }] as never)).toBe('')
    expect(gesammeltesMaterial([tool('Error: No URL provided')] as never)).toMatch(/1 .*fail/i)
  })

  it('kappt, damit ein Abbruch nicht das Fenster des Auftraggebers sprengt', () => {
    const riesig = 'x'.repeat(50_000)
    const m = gesammeltesMaterial([tool(riesig), tool(riesig), tool(riesig)] as never)
    expect(m.length).toBeLessThan(4000)
  })
})
