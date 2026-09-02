/**
 * Wie ein fertiger Hintergrundagent den Hauptagenten erreicht.
 *
 * Eine Zeile für beide ReAct-Schleifen, damit die tragende Entscheidung an
 * EINER Stelle steht statt zweimal leicht verschieden:
 *
 * Die Meldung geht als NUTZER-Material in den Verlauf. Die beiden
 * naheliegenden Alternativen scheitern beide, und zwar nicht theoretisch:
 *
 *  - `role:'system'` an dieser Stelle weisen strenge Jinja-Vorlagen ab
 *    ("System message must be at the beginning"). Dieselbe Regel zwang schon
 *    die Verdichtungsnotiz auf Nutzer-Material (context-compaction.ts,
 *    attachNoteToUserMaterial).
 *  - `role:'tool'` braucht eine `tool_call_id`, die zu einem WIRKLICH
 *    gestellten Aufruf gehört. Eine erfundene lässt openai, anthropic und
 *    lu-cloud mit 400/422 abbrechen — sub-agent.ts hat sich genau das beim
 *    Zuordnen doppelter Aufrufe schon einmal eingefangen.
 *
 * Nutzer-Material ist der einzige Kanal, der auf allen drei Werkzeugschemata
 * (native, template_fix, hermes_xml) und allen vier Anbietern gleich gilt.
 *
 * WO die Zeile steht, ist die zweite Entscheidung: oben in der Iteration, VOR
 * dem Modellaufruf und NACH den Werkzeugantworten der vorigen Runde. Damit
 * gerät sie nie zwischen eine Assistenten-Nachricht mit `tool_calls` und deren
 * Antworten — die einzige Stelle im Verlauf, an der ein fremder Turn wirklich
 * einen Anbieterfehler auslöst.
 */

import { renderTaskReport, type AgentTask } from './agent-tasks'

/** Die Nachrichtenform, die beide Schleifen teilen. */
interface Turn {
  role: string
  content?: unknown
  tool_calls?: unknown
}

/**
 * Sicherheitsnetz für die Platzierungsregel oben.
 *
 * Wahr, wenn die letzte Nachricht Werkzeugaufrufe angekündigt hat, deren
 * Antworten noch fehlen. Dann darf hier NICHTS dazwischen — die Meldung
 * wartet eine Runde, was sie nichts kostet: sie ist ohnehin asynchron.
 */
export function awaitingToolResults(messages: readonly Turn[]): boolean {
  const letzte = messages[messages.length - 1]
  return !!letzte && letzte.role === 'assistant' && Array.isArray(letzte.tool_calls) && letzte.tool_calls.length > 0
}

/**
 * Hängt die Meldung über fertige Hintergrundaufgaben an und gibt zurück, wie
 * viele gemeldet wurden.
 *
 * `take` ist ABSICHTLICH eine Rückrufe und keine fertige Liste. Der Store
 * markiert beim Abholen als "gemeldet", damit dieselbe Antwort nicht zweimal
 * kommt — hätte diese Funktion die Liste als Parameter genommen, hätte der
 * Aufrufer sie VOR der Platzierungsprüfung abholen müssen, und in der Runde,
 * in der die Prüfung "warte" sagt, wären die Meldungen als gemeldet markiert
 * und nie ausgeliefert gewesen. Ein stiller Verlust, der genau dann zuschlägt,
 * wenn ein Agent gerade viele Werkzeuge fährt: also im vollsten Lauf.
 *
 * Mit dem Rückruf ist der Fehler nicht mehr baubar: abgeholt wird erst, wenn
 * feststeht, dass angehängt werden darf.
 */
export function appendTaskReport(
  messages: Turn[],
  take: () => AgentTask[],
  now: number,
): number {
  if (awaitingToolResults(messages)) return 0
  const fertige = take()
  if (!fertige.length) return 0
  const text = renderTaskReport(fertige, now)
  if (!text) return 0
  messages.push({ role: 'user', content: text })
  return fertige.length
}
