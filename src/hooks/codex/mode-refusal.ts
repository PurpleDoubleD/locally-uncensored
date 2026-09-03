import { CODEX_MODE_LABELS, type CodexMode } from '../../lib/codex-mode'

/**
 * Ein Schraegstrich-Befehl, der in diesem Modus nichts ausrichten kann.
 *
 * Der Schnitt folgt dem, WAS ZWEI UNABHAENGIGE BRAUCHEN. In useCodex.ts standen
 * zwei fast gleiche Bloecke 14 Zeilen auseinander — einer fuer den
 * Code-Review-Modus, einer fuer den Plan-Modus —, und beide nannten dieselbe
 * Ausweichliste WOERTLICH:
 *
 *     "use a read-only command such as /review, /plan, /diff or /explain"
 *
 * Zwei Kopien einer Liste, die nur gemeinsam stimmen kann: waechst ein
 * schreibfreier Befehl dazu, muss er in BEIDEN Saetzen stehen. Das ist genau
 * der Fall, den ZB-7 nach nebenan legt, statt ihn in einem der beiden zu
 * lassen.
 *
 * DIE RANGFOLGE IST DIE ZWEITE ZUSICHERUNG. Der Review-Modus gewinnt vor dem
 * Plan-Modus, weil er die staerkere Sperre ist: er tauscht den ganzen
 * Systemprompt gegen den schreibfreien Vertrag. Bisher ergab sich diese
 * Rangfolge nur daraus, dass das eine `if` VOR dem anderen stand — sie hing an
 * der Reihenfolge zweier Bloecke in einer 2642-Zeilen-Datei und war nirgends
 * pruefbar.
 *
 * WOZU DIE SAETZE UEBERHAUPT DA SIND: ein Befehl, dessen ganze Aufgabe das
 * Aendern ist, liefe sonst bis zum Ende durch und ERZAEHLTE Arbeit, die er
 * nicht tun konnte — ohne dass auf dem Bildschirm stuende, warum. Also sagen
 * und aufhoeren.
 */

export interface ModeRefusalInput {
  /** `settings.codexReviewMode` — unveraendert, auch `undefined`. */
  reviewMode: boolean | undefined
  codexMode: CodexMode
  /** Der erkannte Befehl, oder `null` bei einer normalen Anweisung. */
  slash: { command: { name: string; readOnly?: boolean } } | null
}

/**
 * Der Satz fuer den Nutzer, oder `null`, wenn der Zug laufen darf.
 */
export function codexModeRefusal({ reviewMode, codexMode, slash }: ModeRefusalInput): string | null {
  if (reviewMode && slash && !slash.command.readOnly) {
    return `Review Mode is on, so I cannot write files or run commands, and /${slash.command.name} needs both. Turn Review Mode off in Settings, or use a read-only command such as /review, /plan, /diff or /explain.`
  }
  if (codexMode === 'plan' && slash && !slash.command.readOnly) {
    return `Plan mode is read-only, and /${slash.command.name} needs to write files or run commands. Switch the mode dropdown to "${CODEX_MODE_LABELS.ask}" first, or use a read-only command such as /review, /plan, /diff or /explain.`
  }
  return null
}
