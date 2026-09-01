import type { ChatMessage } from '../../api/providers/types'

/**
 * Die versteckte Werkzeugkette, die der naechste Zug wiederbekommt.
 *
 * Der Schnitt trennt die REGEL vom Schreibvorgang. Was in useCodex.ts
 * uebrigbleibt, ist das Einfuegen in den Chat-Speicher; was hier steht, ist die
 * Auswahl — und die hat zwei Gruende, die einander bedingen:
 *
 *  1. DIE DECKELUNG (Pruefung E2). Ungedeckelt legte ein Lauf mit 200
 *     Durchlaeufen hunderte versteckte Nachrichten zu je bis zu 60k Zeichen an
 *     — zweistellige Megabytes in EINEM Gespraech, die jede spaetere
 *     Speicherung neu durchschreiben musste. Die juengste Kette ist das, was
 *     der naechste Zug wirklich braucht; aeltere Schritte stehen ohnehin im
 *     sichtbaren Verlauf.
 *
 *  2. DER WAISENSCHNITT. Die Deckelung allein WAERE EIN FEHLER: schneidet das
 *     Fenster mitten in ein Aufruf/Ergebnis-Paar, beginnt die behaltene Kette
 *     mit einem Ergebnis, dessen Aufruf draussen liegt. Ein strenger Anbieter
 *     (lu-cloud/DeepInfra) antwortet darauf mit 422 und der ganze
 *     Folgezug faellt aus. Deshalb gehoeren die beiden Schritte zusammen und
 *     nicht in zwei Zeilen quer durch einen `finally`-Block.
 *
 * Rein und damit pruefbar — inklusive des Grenzfalls, den man sonst nie sieht:
 * ein Fenster, das AUSSCHLIESSLICH aus Ergebnissen besteht, bleibt leer.
 */

/** Was der naechste Zug hoechstens an versteckter Kette wiederbekommt. */
export const HIDDEN_HISTORY_MAX = 60

export function capHiddenToolHistory(
  all: ChatMessage[],
  max: number = HIDDEN_HISTORY_MAX,
): ChatMessage[] {
  let toolHistory = all.slice(-max)
  // Never start the kept slice on an orphan tool result — strict
  // providers 422 a result whose call fell outside the window.
  while (toolHistory.length > 0 && toolHistory[0].role === 'tool') toolHistory = toolHistory.slice(1)
  return toolHistory
}
