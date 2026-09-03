/**
 * Siehe den Kopf von `ankuendigung.ts` fuer den Persona-Lauf, aus dem diese
 * Regel kommt (zwei Ankuendigungen und ein Leerlauf fuer 251 Sekunden).
 *
 * Lauf: npx vitest run src/api/agents/__tests__/ankuendigung.test.ts
 */
import { describe, it, expect } from 'vitest'
import { istNurAnkuendigung } from '../ankuendigung'

describe('istNurAnkuendigung', () => {
  it('erkennt die beiden Rueckgaben aus dem Lauf woertlich', () => {
    expect(istNurAnkuendigung(
      'Ich recherchiere das Hamburger Transparenzgesetz für Sie. Beginne mit einer Suche nach den offiziellen Informationen.',
    )).toBe(true)
    expect(istNurAnkuendigung(
      'Ich recherchiere Informationen zum rheinland-pfälzischen Transparenzgesetz.',
    )).toBe(true)
  })

  it('erkennt die englischen Formen', () => {
    for (const t of [
      "Let me search for the current data first.",
      "I'll start by fetching the official page.",
      'I am going to look this up.',
      'First, I need to search the web.',
    ]) {
      expect(istNurAnkuendigung(t), t).toBe(true)
    }
  })

  it('eine echte Antwort ist keine Ankuendigung — auch wenn sie so anfaengt', () => {
    // Die Laenge ist der Schutz gegen den Fehlalarm. Eine Zusammenfassung, die
    // mit „Let me summarise" beginnt und dann liefert, darf nicht verworfen
    // werden — das waere teurer als der Fehler, den wir fangen wollen.
    const echt = 'Let me summarise what I found:\n\n' + 'Hamburg: Antwortfrist ein Monat nach § 13 HmbTG. '.repeat(20)
    expect(echt.length).toBeGreaterThan(400)
    expect(istNurAnkuendigung(echt)).toBe(false)
  })

  it('Vergangenheit ist Vollzug, nicht Absicht', () => {
    expect(istNurAnkuendigung('Ich habe recherchiert: die Frist betraegt einen Monat.')).toBe(false)
    expect(istNurAnkuendigung('I searched and found nothing on that page.')).toBe(false)
  })

  it('ein kurzes, echtes Ergebnis bleibt ein Ergebnis', () => {
    expect(istNurAnkuendigung('Die Antwortfrist betraegt einen Monat (§ 13 HmbTG).')).toBe(false)
    expect(istNurAnkuendigung('166,057')).toBe(false)
  })

  it('leer ist keine Ankuendigung, sondern nichts', () => {
    expect(istNurAnkuendigung('')).toBe(false)
    expect(istNurAnkuendigung('   ')).toBe(false)
  })
})
