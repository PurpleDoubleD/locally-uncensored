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
 * DIE DRITTE IST NICHT DIESELBE, und das bleibt hier sichtbar statt still
 * eingeebnet zu werden: der Hermes-Zweig steigt nur ab, wenn ueberhaupt ein
 * Denk-Schalter gesetzt war. Diese Zusatzbedingung bleibt an ihrer Aufrufstelle
 * stehen; sie ist Verhalten, keine Doppelung, und eine Umstrukturierung raeumt
 * kein Verhalten weg.
 *
 * WOZU DER ABSTIEG DA IST: ein aelterer Ollama-Bau oder ein Endpunkt, der den
 * Schalter nicht kennt, antwortet mit 400. Der Lauf muss das ueberleben statt
 * daran zu enden.
 *
 * `errorText` und `httpStatusOf` sind Grenzwaechter, also ueberlebt diese
 * Frage auch ein `throw null` — das ist der Grund, warum sie hier so und nicht
 * ueber `(e as Error).message` gestellt wird.
 */
export function isThinkingUnsupportedError(err: unknown): boolean {
  return httpStatusOf(err) === 400 || errorText(err).includes('does not support thinking')
}
