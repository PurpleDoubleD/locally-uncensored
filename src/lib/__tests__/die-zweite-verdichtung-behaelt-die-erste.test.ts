/**
 * Was nach der ZWEITEN Verdichtung noch beim Modell ankommt.
 *
 * Der Fall, den 2.6.8 zu schliessen behauptet: ein Chat wird verdichtet, laeuft
 * weiter, wird ein zweites Mal verdichtet. Der Nutzer sieht zwei
 * Verdichtungslinien und nimmt an, dass beide Zusammenfassungen zaehlen.
 *
 * Sie tun es nicht. Die Kette, jede Stelle nachgelesen:
 *
 *   1. `newestCompaction` gab AUSSCHLIESSLICH den letzten Datensatz zurueck
 *      (run-compact-command.ts:153-157, `compactions[compactions.length - 1]`).
 *   2. `useChat.ts:729-731` baute die Nutzlast genau daraus.
 *   3. `applyStoredCompaction` sucht den Anker DIESES Datensatzes und ruft
 *      `spliceSummary(messages, cut + 1, record.summary)` (compact-summary.ts:594-598).
 *   4. `spliceSummary` verwirft alles vor dem Anker (`body.slice(dropLeading)`,
 *      compact-summary.ts:539) und haengt genau die EINE uebergebene
 *      Zusammenfassung an.
 *   5. Der zweite Datensatz deckt aber nur `visible.slice(prevIdx + 1, cutAt)`
 *      ab (run-compact-command.ts:105-113). Das ist Absicht und im Code
 *      begruendet: „Do not re-summarise material an earlier summary already
 *      covers: that is the summary-of-a-summary decay this feature is designed
 *      to avoid."
 *
 * Punkt 5 ist fuer sich richtig. Zusammen mit Punkt 1 ergibt er aber, dass
 * das Material des ersten Abschnitts nirgends mehr steht: nicht als Nachricht,
 * weil Punkt 4 es wegschneidet, und nicht als Zusammenfassung, weil Punkt 1 nur
 * die zweite mitnimmt.
 *
 * Die vorhandenen Faelle pruefen den SCHNITT. Keiner prueft das UEBERLEBEN von
 * Material aus dem ersten Abschnitt. Genau deshalb ist der Fehler unbemerkt
 * geblieben.
 *
 * BEHOBEN am 05.09.2026: `applyStoredCompaction` nimmt jetzt die ganze Kette
 * statt eines einzelnen Datensatzes und schickt jede Zusammenfassung bis zum
 * Schnitt mit. Dieser Fall war vor dem Fix rot und ist die Wache dagegen.
 *
 * Run: npx vitest run src/lib/__tests__/die-zweite-verdichtung-behaelt-die-erste.test.ts
 */
import { describe, it, expect } from 'vitest'
import { applyStoredCompaction } from '../compact-summary'
import type { CompactionRecord } from '../../types/chat'

/** Eine Nachricht in der Form, die `applyStoredCompaction` braucht. */
const n = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content })

/** Ein Datensatz, wie ihn ein echter Verdichtungslauf hinterlaesst. */
const satz = (id: string, summary: string, upToMessageId: string, replaced: number): CompactionRecord => ({
  id, summary, upToMessageId, replaced,
  atMessageCount: 0, tokensBefore: 0, tokensAfter: 0, trigger: 'manual', at: 0,
})

describe('zwei Verdichtungen hintereinander', () => {
  // Der Fakt steht NUR im ersten Abschnitt. Wenn er die zweite Verdichtung
  // ueberlebt, dann ausschliesslich ueber die erste Zusammenfassung.
  const FAKT = 'the deploy key lives in the vault under lu/PROD'

  const verlauf = [
    n('m1', 'user', `Remember this: ${FAKT}`),
    n('m2', 'assistant', 'Noted.'),
    n('m3', 'user', 'Now something else entirely.'),
    n('m4', 'assistant', 'Sure.'),
    n('m5', 'user', 'And a third topic.'),
    n('m6', 'assistant', 'Understood.'),
    n('m7', 'user', 'What was the deploy key again?'),
  ]

  // Erste Verdichtung deckt m1 bis m2 ab und traegt den Fakt.
  const erste = satz('c1', `Earlier: ${FAKT}`, 'm2', 2)
  // Zweite deckt m3 bis m4 ab. Sie kennt den Fakt nicht, und das ist Absicht:
  // run-compact-command.ts schneidet ab prevIdx + 1, um Zusammenfassungen von
  // Zusammenfassungen zu vermeiden.
  const zweite = satz('c2', 'Earlier: two unrelated topics were discussed.', 'm4', 2)

  it('nach EINER Verdichtung steht der Fakt in der Nutzlast', () => {
    // POSITIVKONTROLLE. Ohne sie wuerde der Fall unten auch auf einer Fassung
    // rot, die gar nichts anwendet.
    const raus = applyStoredCompaction(verlauf, [erste])
    const text = raus.messages.map((m) => m.content).join('\n')
    expect(text, 'schon die erste Verdichtung verliert den Fakt').toContain(FAKT)
  })

  it('nach der ZWEITEN Verdichtung steht er immer noch da', () => {
    // DER FALL. Der Nutzer fragt in m7 nach dem Fakt. Das Modell bekommt die
    // Nutzlast, die hier herauskommt, und nichts sonst.
    const raus = applyStoredCompaction(verlauf, [erste, zweite])
    const text = raus.messages.map((m) => m.content).join('\n')
    expect(
      text,
      'das Material des ersten Abschnitts ist weg: die zweite Zusammenfassung deckt es '
      + 'nicht ab, und die erste wird nicht mitgeschickt',
    ).toContain(FAKT)
  })

  it('und die zweite Zusammenfassung ist ueberhaupt angekommen', () => {
    // Trennt „nichts angewendet" von „das Falsche angewendet". Wird dieser Fall
    // gruen und der obige rot, ist genau der beschriebene Verlust bewiesen.
    const raus = applyStoredCompaction(verlauf, [erste, zweite])
    const text = raus.messages.map((m) => m.content).join('\n')
    expect(text, 'die zweite Zusammenfassung fehlt auch').toContain('two unrelated topics')
  })
})
