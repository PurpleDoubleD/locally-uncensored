import { computeUnifiedDiff } from '../../lib/diff'
import { applyUniqueEdit } from '../../lib/surgical-edit'
import type { ToolArgs } from '../../api/mcp/types'

/**
 * Was der Nutzer von einem fertigen Werkzeugaufruf zu sehen bekommt.
 *
 * Der Schnitt folgt dem geteilten Zustand `acDiff`/`acPath`: in useCodex.ts
 * berechnete ein Block beide, und ZWEI Verbraucher lasen sie danach — der
 * Werkzeug-Block in der Chat-Blase und der `file_change`-Eintrag im
 * Codex-Ereignisprotokoll. Beide muessen denselben Unterschied zeigen; die
 * Rechnung gehoert deshalb an EINE Stelle und nicht in einen der beiden.
 *
 * WARUM DAS HEIKEL IST: der angezeigte Unterschied ist NACHGEBAUT, nicht
 * beobachtet. Das Werkzeug schreibt auf die Platte und meldet Text zurueck; was
 * hier gezeichnet wird, entsteht aus der Vorlese-Runde plus dem, was das Modell
 * in den Aufruf geschrieben hat. Bei `file_edit` bekam das Werkzeug ueberhaupt
 * nur old_string/new_string — der neue Inhalt wird aus dem Vorgelesenen und der
 * eindeutigen Ersetzung REKONSTRUIERT. Diese Stelle ist damit die eine, an der
 * die Anzeige ueber die Aenderung luegen kann, und sie hatte bis hierher keinen
 * eigenen Test, weil sie mitten in der Ergebnisschleife stand.
 *
 * Beide Funktionen sind rein.
 */

export interface ToolDiffInput {
  toolName: string
  /** Der geprueft gelesene Pfad aus dem Aufruf (`asString`), sonst undefined. */
  path: string | undefined
  /** Was die Vorlese-Runde auf der Platte fand; fehlende Datei = ''. */
  oldText: string
  /** Die Argumente, die tatsaechlich an das Werkzeug gingen. */
  args: ToolArgs
}

/**
 * Der Unterschied fuer die beiden Schreibwerkzeuge. `undefined` heisst
 * "nichts anzeigen": kein Schreibwerkzeug, ein leerer Unterschied, oder eine
 * Bearbeitung, die nicht eindeutig angewandt werden konnte (dann hat der
 * Ausfuehrer bereits einen Fehler gemeldet).
 */
export function codexToolDiff({ toolName, path, oldText, args }: ToolDiffInput): string | undefined {
  if (toolName === 'file_write') {
    // Pre-read above captured the on-disk version; a missing file
    // yields an all-add hunk. Empty diff → omit.
    const newText =
      typeof args.content === 'string'
        ? args.content
        : ''
    return computeUnifiedDiff(path ?? '', oldText, newText) || undefined
  }
  if (toolName === 'file_edit') {
    // Surgical edit — the tool only received old_string/new_string, so
    // reconstruct the new content from the pre-read + the unique
    // replacement to attach a real diff. If the edit did not apply
    // uniquely the executor already returned an error; skip the diff.
    const applied = applyUniqueEdit(
      oldText,
      typeof args.old_string === 'string' ? args.old_string : '',
      typeof args.new_string === 'string' ? args.new_string : '',
    )
    return applied.ok
      ? computeUnifiedDiff(path ?? '', oldText, applied.content ?? '') || undefined
      : undefined
  }
  return undefined
}

/**
 * In welchen Eintrag des Codex-Ereignisprotokolls ein fertiger Aufruf faellt.
 * `null` heisst: kein Eintrag.
 *
 * Die Reihenfolge ist Teil der Regel — ein FEHLGESCHLAGENES `file_write`
 * bleibt ein `file_change` und wird NICHT zum `error`, weil der Zweig fuer die
 * Schreibwerkzeuge vor dem Fehlerzweig steht.
 */
export function codexEventKind(
  toolName: string,
  isError: boolean,
): 'terminal_output' | 'file_change' | 'error' | null {
  if (toolName === 'shell_execute' || toolName === 'code_execute') return 'terminal_output'
  if (toolName === 'file_write' || toolName === 'file_edit') return 'file_change'
  if (isError) return 'error'
  return null
}
