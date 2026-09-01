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
 * ── DER ZWEITE SCHNITT: useAgentChat.ts UND useChat.ts (KF-21b) ─────────────
 *
 * Ausserhalb von useCodex.ts standen noch vier weitere Kopien: drei woertlich
 * gleiche in useAgentChat.ts (Ollama-, Provider- und Hermes-Zweig, alle drei
 * mit der Zusatzbedingung, nachgetragen 2026-08-14) und eine in useChat.ts,
 * die als EINZIGE auch auf 422 prueft. Beide Dateien rufen jetzt hierher.
 *
 * ── DIE 422-FRAGE: ANBIETER-EIGENART, NICHT TRANSPORT-EIGENART ──────────────
 *
 * Der 422 war die gefaehrliche Stelle beim Zusammenziehen: eine Bedingung, die
 * nur EINE Kopie trug. Wer nur zaehlt, ebnet sie ein und verliert sie still.
 * Nachgemessen ist sie kein Sonderfall von useChat.ts:
 *
 *  1. WOHER er kommt. 422 ist DeepInfras Status fuer einen schlechten
 *     Parameter; der LU-Cloud-Proxy reicht 400 UND 422 absichtlich durch,
 *     damit der Abstieg drinnen ueberhaupt greifen kann. Genau so steht es an
 *     der Quelle: api/providers/openai-provider.ts, `sendChat` — dort
 *     behandelt `refused()` beide Nummern als EINE Klasse.
 *  2. WEN er erreicht. Der 422 verlaesst diesen Anbieter ueber
 *     `provider.chatStream` — und das ist derselbe eine Aufruf, den useChat.ts
 *     direkt macht und den `streamProviderTurn` (lib/provider-stream.ts) fuer
 *     den Provider- und den Hermes-Zweig von useAgentChat.ts und useCodex.ts
 *     macht. Es ist kein anderer Transport, es ist DERSELBE.
 *  3. WAS er kostet, wo er nicht vorkommt. Die reinen Ollama-Zweige rufen
 *     `streamOllamaChatWithTools`; Ollama antwortet 400, nie 422. Die Nummer
 *     dazuzunehmen aendert dort also nichts.
 *
 * Also gehoert der 422 in die gemeinsame Fehlerform und gilt ab jetzt fuer
 * alle: die drei Zweige von useCodex.ts und die drei von useAgentChat.ts haben
 * ihn dazugewonnen, useChat.ts behaelt ihn. Die umgekehrte Wahl — 422 als
 * lokale Eigenheit in useChat.ts stehen lassen — waere gegen den Befund:
 * derselbe Anbieter haette auf dem Agentenpfad weiter den ganzen Lauf beendet,
 * wo er im Chat nur eine Wiederholung kostet.
 *
 * Zur Trennschaerfe: 422 ist so breit wie 400 ("schlechte Anfrage"), kann also
 * auch etwas anderes meinen als den Denk-Schalter. Der Preis dafuer ist genau
 * eine zusaetzliche Anfrage — derselbe Preis, den 400 hier seit jeher hat —,
 * und die Zusatzbedingung unten deckelt ihn: ohne angefragten Denkmodus wird
 * gar nicht erst wiederholt.
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
 *  2. useChat.ts fragte seit jeher `useThinking !== undefined &&` vor genau
 *     diesem Abstieg — heute reicht es denselben Wert als `requestedThinking`
 *     hierher (useChat.ts:740).
 *  3. useAgentChat.ts hat die Bedingung nach der Durchsicht vom 2026-08-14 in
 *     ALLE drei Zweige nachgetragen, mit ebendieser Begruendung im Kommentar
 *     ("resent a byte-identical request and charged the user for a 400 twice");
 *     hooks/__tests__/agent-think-downgrade.test.ts haelt sie dort fest — heute
 *     an den drei Aufrufen mit uebergebener Option.
 *
 * Also: keine Besonderheit von Hermes, sondern eine Luecke im Ollama- und im
 * OpenAI-Zweig von useCodex.ts. Sie wird beim Zusammenziehen NICHT
 * stillschweigend eingeebnet — sie wird zum Parameter und gilt damit fuer alle
 * drei. `shouldDowngradeThinking` ist die eine Stelle, an der die Frage
 * "muss der Denkmodus herabgestuft werden?" beantwortet wird.
 */
export function isThinkingUnsupportedError(err: unknown): boolean {
  const status = httpStatusOf(err)
  // 400 und 422 sind hier EINE Klasse — siehe den Modulkopf, Abschnitt
  // "DIE 422-FRAGE". Dieselbe Paarung steht an der Quelle des 422, in
  // openai-provider.ts `sendChat`.
  return status === 400 || status === 422 || errorText(err).includes('does not support thinking')
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
