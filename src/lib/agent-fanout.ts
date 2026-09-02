/**
 * „nutze 5 glm 5.2 agenten für das und das."
 *
 * Der Auftrag, wörtlich vom 02.09.2026: wenn im Prompt steht, wie viele
 * Agenten mit welchem Modell laufen sollen, dann soll genau das passieren —
 * auch wenn ein ganz anderes Modell aktiv ist.
 *
 * ── WARUM DAS ÜBERHAUPT EINE EIGENE ERKENNUNG BRAUCHT ─────────────────────
 * Der naheliegende Weg wäre, es dem Modell zu überlassen: `delegate_task`
 * bekommt einen `model`-Parameter, und das aktive Modell ruft es fünfmal auf.
 * Genau so macht es die Claude-Code-Desktop-App, und bei einem großen Modell
 * ist das auch richtig.
 *
 * Hier reicht es nicht. Am selben Tag gemessen: ein 4B-Modell, dem gesagt
 * wurde „call delegate_task with background true", hat mit Prosa geantwortet —
 * „Task ID: t12345, Status: Background task initiated" — und nie ein Werkzeug
 * gerufen. LU fährt Modelle von 0,5B bis 9B. Eine ausdrückliche Anweisung des
 * Nutzers darf nicht daran scheitern, dass ein kleines Modell sie zwar
 * versteht, aber nicht ausführen kann.
 *
 * Diese Datei erkennt die Anweisung deshalb DETERMINISTISCH aus dem Text und
 * gibt sie dem Lauf als ausdrückliche Weisung mit. Das Modell entscheidet
 * weiterhin, WAS die Agenten tun; es entscheidet nicht mehr, OB der Wunsch
 * des Nutzers gehört wurde.
 *
 * Kein React, kein Store, kein Netz — damit die Erkennung ohne Fenster
 * prüfbar ist.
 */

/**
 * Die Obergrenze für eine ausdrücklich angeforderte Fächerung.
 *
 * SUB_AGENT_MAX_PARALLEL (4) bleibt die Vorgabe für das, was ein MODELL von
 * sich aus fächern darf — sie bremst eine Fan-out-Schleife. Sagt der NUTZER
 * „nutze 5", ist die 4 aber keine Sicherheitsgrenze mehr, sondern eine
 * Bevormundung: er hat die Zahl genannt.
 *
 * 12 und nicht unbegrenzt, weil jeder Agent ein eigenes Modellgespräch führt
 * und auf einem Laptop dieselbe GPU teilt. Wer mehr will, sagt es zweimal.
 */
export const MAX_EXPLICIT_FANOUT = 12

export interface FanoutRequest {
  /** Wie viele Agenten der Nutzer genannt hat, geklemmt auf MAX_EXPLICIT_FANOUT. */
  count: number
  /** Der Modellname, so wie er im Text stand. Leer, wenn keiner genannt wurde. */
  modelPhrase: string
  /** Ob die Zahl gekappt wurde — der Aufrufer sagt das dann dem Nutzer. */
  clamped: boolean
}

/** Zahlwörter, die in beiden Sprachen wirklich vorkommen. */
const ZAHLWORT: Record<string, number> = {
  ein: 1, eine: 1, einen: 1, one: 1,
  zwei: 2, two: 2,
  drei: 3, three: 3,
  vier: 4, four: 4,
  fuenf: 5, 'fünf': 5, five: 5,
  sechs: 6, six: 6,
  sieben: 7, seven: 7,
  acht: 8, eight: 8,
  neun: 9, nine: 9,
  zehn: 10, ten: 10,
}

/**
 * Das Wort, an dem die Anweisung hängt. Es steht am ENDE der Wendung, und die
 * Zahl davor — „5 glm 5.2 agenten" — also wird von hinten gelesen.
 */
const AGENT_WORT = '(?:sub-?)?agent(?:en|s|:innen)?'

/**
 * Erkennt „nutze 5 glm 5.2 agenten" und seine Geschwister.
 *
 * Was ABSICHTLICH nicht erkannt wird: eine Zahl ohne das Wort Agent („nimm 5
 * dateien"), und eine Erwähnung ohne Zahl („nutze agenten dafür"). Die zweite
 * ist der interessantere Verzicht — sie klingt nach einem Wunsch, nennt aber
 * keine Menge, und eine geratene Menge wäre schlimmer als keine. Für diesen
 * Fall gibt es weiterhin das Schlüsselwort-Tor, das `delegate_task` überhaupt
 * erst in die Werkzeugliste holt; das Modell entscheidet dann selbst.
 */
export function parseFanoutRequest(text: string): FanoutRequest | null {
  if (typeof text !== 'string' || !text.trim()) return null

  // Zahl, dann höchstens ein paar Wörter Modellname, dann das Wort Agent.
  // Der Modellteil ist bewusst genügsam (`+?`) und darf keine Satzzeichen
  // enthalten — sonst zöge er sich über einen halben Satz.
  const re = new RegExp(
    `(\\d{1,3}|${Object.keys(ZAHLWORT).join('|')})\\s+((?:[\\w.\\-:/]+\\s+){0,4}?)${AGENT_WORT}\\b`,
    'i',
  )
  const m = text.match(re)
  if (!m) return null

  const roh = m[1].toLowerCase()
  const n = /^\d+$/.test(roh) ? parseInt(roh, 10) : ZAHLWORT[roh]
  if (!n || n < 1) return null

  const count = Math.min(n, MAX_EXPLICIT_FANOUT)
  return {
    count,
    modelPhrase: (m[2] || '').trim(),
    clamped: n > MAX_EXPLICIT_FANOUT,
  }
}

/**
 * Die Form, die zum Auflösen eines Modellnamens reicht.
 *
 * `name` und nicht `id`, und das ist kein Geschmack: die App spricht ein
 * Chatmodell über `AIModel.name` an — `setActiveModel(model.name)` in
 * ModelSelector und ModelManager, und `getProviderForModel` bekommt dieselbe
 * Zeichenkette. Ein `id`-Feld gibt es auf `OllamaModel` gar nicht.
 *
 * Die erste Fassung hier hieß `id`, weil sie von `resolveMlxModel`
 * abgeschrieben war — und dort stimmt es, weil MLX-BILDmodelle eine id haben.
 * Der Typprüfer hat das gefangen, bevor es lief; ohne ihn hätte die Auflösung
 * über `undefined` verglichen und immer null geliefert.
 */
export interface NamedModel {
  /** Der Bezeichner, unter dem die App das Modell anspricht. */
  name: string
  /** Der rohe Bezeichner des Backends, meist gleichlautend. */
  model?: string
  /** Freundlicher Anzeigename, wenn der Server einen liefert. */
  displayName?: string
}

/**
 * Findet das gemeinte Modell unter den installierten.
 *
 * Dieselbe nachsichtige Normalisierung wie `resolveMlxModel` in
 * mlx-model-match.ts — bewusst kopiert und nicht geteilt: dort geht es um
 * MLX-Bildmodelle auf einem Mac, hier um Chatmodelle aller vier Anbieter. Die
 * beiden Listen haben nichts miteinander zu tun, und eine gemeinsame Funktion
 * hätte nur die Illusion erzeugt, dass eine Änderung dort hier gefahrlos ist.
 *
 * Gibt `null` zurück, wenn nichts passt. Der Aufrufer MUSS das melden und darf
 * nicht stillschweigend auf das aktive Modell zurückfallen: „nutze glm 5.2"
 * mit qwen zu beantworten und nichts zu sagen ist die schlimmste der drei
 * möglichen Antworten.
 */
export function resolveRequestedModel<T extends NamedModel>(
  requested: string | undefined,
  installed: readonly T[],
): T | null {
  if (!requested || !installed.length) return null
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const r = norm(requested)
  if (!r) return null
  // Drei Felder, drei Schaerfegrade: genau, enthaelt, ist enthalten. Die
  // Reihenfolge ist die Regel — ein exakter Treffer auf einem beliebigen Feld
  // schlaegt jeden ungefaehren, sonst gewaenne bei „qwen" das erstbeste
  // qwen-Modell gegen ein Modell, das wirklich so heisst.
  const felder = (m: T) => [m.name, m.model ?? '', m.displayName ?? '']
  return (
    installed.find((m) => felder(m).some((f) => norm(f) === r)) ??
    installed.find((m) => felder(m).some((f) => f && norm(f).includes(r))) ??
    installed.find((m) => felder(m).some((f) => f && r.includes(norm(f)))) ??
    null
  )
}

/**
 * Die Weisung, die dem Lauf mitgegeben wird, wenn eine Fächerung erkannt wurde.
 *
 * Sie geht als NUTZER-Material in den Verlauf — dieselbe Regel wie bei der
 * Verdichtungsnotiz und bei der Meldung fertiger Aufgaben: eine
 * System-Nachricht an anderer Stelle als Index 0 weisen strenge
 * Jinja-Vorlagen ab, und eine Werkzeugantwort bräuchte eine echte
 * tool_call_id.
 *
 * Der Text nennt die Zahl und das AUFGELÖSTE Modell, nicht die Wendung des
 * Nutzers: das Modell soll den Bezeichner schreiben, der wirklich existiert.
 */
export function fanoutDirective(
  req: FanoutRequest,
  resolvedModelId: string | null,
  unresolvedNote?: string,
): string {
  const zeilen: string[] = []
  zeilen.push(
    `The user asked for exactly ${req.count} background ${req.count === 1 ? 'agent' : 'agents'}.`
    + ` Make ${req.count} separate delegate_task calls in ONE turn, each with background: true`
    + ` and a distinct, self-contained goal covering a different part of the work.`,
  )
  if (resolvedModelId) {
    zeilen.push(`Pass model: "${resolvedModelId}" on every one of those calls.`)
  } else if (unresolvedNote) {
    zeilen.push(unresolvedNote)
  }
  if (req.clamped) {
    zeilen.push(`They asked for more than ${MAX_EXPLICIT_FANOUT}; ${req.count} is the most that run at once here. Say so in your answer.`)
  }
  return zeilen.join(' ')
}

/**
 * Der Satz für den Fall, dass das genannte Modell nicht installiert ist.
 *
 * Er sagt dem Modell, es solle den Nutzer fragen — statt einfach das aktive zu
 * nehmen. Der Unterschied ist der ganze Zweck: eine Fächerung auf dem falschen
 * Modell sieht aus wie Erfolg.
 */
export function unresolvedModelNote(phrase: string, installedIds: readonly string[]): string {
  const beispiele = installedIds.slice(0, 6).join(', ')
  return `The model "${phrase}" is not installed here, so do NOT start the agents yet.`
    + ` Tell the user it is missing and name what is installed instead${beispiele ? ` (${beispiele})` : ''},`
    + ` then ask which one to use.`
}
