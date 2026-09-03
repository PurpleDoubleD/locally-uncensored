// Ein Unterauftrag, der nur ankuendigt, hat nicht geantwortet.
//
// Persona-Lauf vom 03.09.2026 (B2, Tomas Reinholt). Drei delegierte Agenten,
// 251 Sekunden Rechenzeit, und das kam zurueck:
//
//   Hamburg → „Ich recherchiere das Hamburger Transparenzgesetz fuer Sie.
//              Beginne mit einer Suche nach den offiziellen Informationen."
//   Rheinland-Pfalz → „Ich recherchiere Informationen zum rheinland-
//              pfaelzischen Transparenzgesetz."
//   Sachsen → (sub-agent produced no final answer)
//
// Sein Urteil: „Zwei Ankuendigungen und ein Leerlauf." Der Grund steckt in
// einer Zeile der Schleife: ein Zug OHNE Werkzeugaufrufe beendet den
// Unterauftrag, und sein Text wird zur Antwort. Ein kleines Modell, das
// erstmal hoeflich ansagt, was es gleich tun wird, faellt genau da hinaus —
// bevor es einen einzigen Handgriff getan hat.
//
// Diese Datei ist die Erkennung dafuer, allein und damit pruefbar. Die
// Schleife nutzt sie fuer GENAU EINEN Anstoss: hat der Unterauftrag noch kein
// Werkzeug benutzt und sagt nur an, bekommt er einen Satz zurueck und einen
// zweiten Versuch. Kein zweiter Anstoss — sonst wird aus einer Hilfe eine
// Schleife.

/** Was nach einer Absichtserklaerung klingt, in beiden Sprachen. */
const ANKUENDIGUNG_RE = new RegExp(
  [
    // Deutsch: Praesens der Absicht, oft mit „fuer Sie".
    'ich (werde|recherchiere|suche|schaue|pruefe|prüfe|beginne|starte|fange|lese|hole)\\b',
    'lass(en)? (sie )?mich\\b',
    '(beginne|starte|fange) (ich )?(jetzt |zunaechst |zunächst |erst )?mit\\b',
    'als (erstes|naechstes|nächstes)\\b',
    'zunaechst (werde|suche|schaue|pruefe)',
    // Englisch.
    "i('| a)?m going to\\b",
    "i(')?ll\\b",
    'i will\\b',
    'let me\\b',
    'let\'s (start|begin)\\b',
    '(i am|i\'m) (now )?(searching|looking|checking|starting|researching)\\b',
    '(first|to start|starting)[, ]+(i|let)\\b',
  ].join('|'),
  'i',
)

/**
 * Ein Ergebnis, das kein Ergebnis ist.
 *
 * Zwei Bedingungen, und beide muessen halten:
 *
 *  - KURZ. Eine echte Antwort, die mit „Let me summarise" anfaengt und dann
 *    zweitausend Zeichen Befunde bringt, ist eine Antwort. Die Laenge ist der
 *    Schutz gegen den Fehlalarm, nicht das Muster.
 *  - ABSICHT, nicht Vollzug. „Ich habe recherchiert" ist Vergangenheit und
 *    faellt nicht darunter; „Ich recherchiere" ist Ansage.
 */
export function istNurAnkuendigung(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (t.length > 400) return false
  return ANKUENDIGUNG_RE.test(t)
}

/** Der eine Satz, den der Unterauftrag statt seiner Ankuendigung zurueckbekommt. */
export const ANKUENDIGUNG_STEER =
  'That is a plan, not an answer, and nobody sees it — you are a sub-agent, your reply IS the deliverable. ' +
  'You have not called a single tool yet. Do the work now: call the tool you just described, then answer with what it returned.'
