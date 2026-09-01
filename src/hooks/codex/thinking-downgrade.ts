import { httpStatusOf } from '../../lib/http-status'
import { errorText } from '../../types/json-guards'

/**
 * "Dieses Modell kann nicht denken" — die eine Frage, DREIMAL gestellt.
 *
 * Der Schnitt folgt dem, WAS DREI UNABHAENGIGE BRAUCHEN. In useCodex.ts stand
 * derselbe Test in allen drei Transportzweigen, und in drei verschiedenen
 * Schreibweisen:
 *
 *   Ollama:  httpStatusOf(e) === 400 || errorText(e).includes('does not support thinking')
 *   OpenAI:  errorText(e).includes('does not support thinking') || httpStatusOf(e) === 400
 *   Hermes:  opts.thinking !== undefined && (errorText(e).includes(…) || httpStatusOf(e) === 400)
 *
 * Die ersten beiden unterscheiden sich NUR in der Reihenfolge der beiden
 * Operanden. Beide Operanden sind rein (`httpStatusOf` und `errorText` lesen
 * nur), also ist das Ergebnis identisch — es sind zwei Kopien einer Regel, von
 * denen jede fuer sich weiterentwickelt werden konnte.
 *
 * WOZU DER ABSTIEG DA IST: ein aelterer Ollama-Bau oder ein Endpunkt, der den
 * Schalter nicht kennt, antwortet mit 400. Der Lauf muss das ueberleben statt
 * daran zu enden.
 *
 * `errorText` und `httpStatusOf` sind Grenzwaechter, also ueberlebt diese
 * Frage auch ein `throw null` — das ist der Grund, warum sie hier so und nicht
 * ueber `(e as Error).message` gestellt wird.
 *
 * ── DIE ZUSATZBEDINGUNG: FEHLER IN DEN ANDEREN BEIDEN, NICHT HERMES-EIGENART ─
 *
 * Der erste Schnitt hat nur die FEHLERFORM hierher geholt und die dritte
 * Bedingung an ihrer Aufrufstelle stehen lassen — mit der Begruendung, sie
 * koenne Verhalten sein. Nachgemessen ist sie das nicht. Drei Belege, alle im
 * Code, keiner davon Geschmack:
 *
 *  1. Aus der Sache selbst. Der Abstieg besteht DARIN, `thinking` fallen zu
 *     lassen. War `thinking` schon `undefined`, ist die Wiederholung Byte fuer
 *     Byte die Anfrage, die eben gescheitert ist: eine zweite Absage, auf dem
 *     Wolkenpfad eine zweite Abrechnung, fuer den Nutzer eine zweite Wartezeit.
 *     Sie kann per Konstruktion nicht helfen.
 *  2. useChat.ts fragt seit jeher `useThinking !== undefined &&` vor genau
 *     diesem Abstieg (heute Zeile 734).
 *  3. useAgentChat.ts hat die Bedingung nach der Durchsicht vom 2026-08-14 in
 *     ALLE drei Zweige nachgetragen, mit ebendieser Begruendung im Kommentar
 *     ("resent a byte-identical request and charged the user for a 400 twice");
 *     hooks/__tests__/agent-think-downgrade.test.ts haelt sie dort fest.
 *
 * Also: keine Besonderheit von Hermes, sondern eine Luecke im Ollama- und im
 * OpenAI-Zweig von useCodex.ts. Sie wird beim Zusammenziehen NICHT
 * stillschweigend eingeebnet — sie wird zum Parameter und gilt damit fuer alle
 * drei. `shouldDowngradeThinking` ist die eine Stelle, an der die Frage
 * "muss der Denkmodus herabgestuft werden?" beantwortet wird.
 */
export function isThinkingUnsupportedError(err: unknown): boolean {
  return httpStatusOf(err) === 400 || errorText(err).includes('does not support thinking')
}

/**
 * Die ganze Frage, an EINER Stelle: lohnt die Wiederholung ohne Denkmodus?
 *
 * `requestedThinking` ist der Wert, den dieser Zug ANGEFRAGT hat — genau der,
 * den die Wiederholung fallen liesse. Ist er `undefined`, gaebe es nichts
 * fallen zu lassen, und die Wiederholung waere die gescheiterte Anfrage
 * unveraendert; siehe den Modulkopf. Der Typ nennt `undefined` ausdruecklich,
 * denn die Aufrufer fuehren das Feld als `boolean` (ein `as unknown as boolean`
 * beim Bauen der Optionen), obwohl zur Laufzeit alle drei Zustaende vorkommen —
 * ein, aus, "der Server entscheidet".
 */
export function shouldDowngradeThinking(
  requestedThinking: boolean | undefined,
  err: unknown,
): boolean {
  return requestedThinking !== undefined && isThinkingUnsupportedError(err)
}
