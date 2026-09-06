/**
 * The one line that says a model pick moved the chat backend.
 *
 * Same shape and same place as RetrievalErrorBar: above the composer, where
 * standing statements live, so it survives the dropdown closing under it. Not
 * an alarm colour, because nothing went wrong: the user asked for this by
 * picking an LU Engine model, he just has to be told what it cost him.
 *
 * A14 third review added the second tone. A start that dies AFTER the slot has
 * been handed over is the one thing that reaches this bar and is not the
 * user's own doing, and the Installed card used to swallow it whole.
 */
import { X } from 'lucide-react'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'

export function LuEngineSwitchBar() {
  const note = useLuEngineSwitchStore((s) => s.note)
  const tone = useLuEngineSwitchStore((s) => s.tone)
  // A failed start after the slot has already been handed over is the one
  // thing here the user has to act on, so it does not get the quiet grey the
  // switch itself gets.
  // Nur noch Kante und Schrift. Die Flaeche kommt aus `lu-elevated`, damit die
  // Zeile in beiden Modi dicht ist und nichts durchscheint.
  const skin = tone === 'error'
    ? 'border-red-500/40 text-red-700 dark:text-red-300'
    : 'text-gray-600 dark:text-gray-300'
  // The live region stays MOUNTED and its text changes, which is the only
  // shape a screen reader actually announces: a region that appears at the
  // same moment as its content is usually read as page furniture and skipped.
  // Polite, not assertive, because nothing went wrong and the user is in the
  // middle of picking a model.
  // `relative z-[60]` und die eigene volle Flaeche darunter, weil der offene
  // Modellwaehler `z-50` traegt und nach oben aufklappt. Nachpruefung G3,
  // 04.09.2026: das Menue lag ueber 45,8 Prozent dieser Zeile, gemessen mit
  // getBoundingClientRect. Der Klick, der den Fehler ausloest, schliesst das
  // Menue laengst von selbst (das war der Fix davor), aber wer es wieder
  // aufmacht, um ein anderes Modell zu suchen, hat den Grund unter dem Menue
  // liegen. Jetzt liegt die Zeile oben, und sie deckt vom Menue nur ihre
  // eigenen 47 Pixel ab, die sich wegrollen lassen.
  //
  // Die Flaeche muss dicht sein. Mit der alten, zu zehn Prozent gedeckten
  // Tinte schien die Modelliste durch den Text hindurch, und lesbar waere die
  // Zeile dann auch im Vordergrund nicht.
  return (
    <div role="status" aria-live="polite" className="relative z-[60]">
      {note && (
        <div
          data-testid="lu-engine-switch-note"
          data-tone={tone}
          className={`lu-elevated mx-3 mb-1.5 flex items-start gap-2 px-2 py-1 rounded-md t-micro ${skin}`}
        >
          <span className="flex-1 leading-snug">{note}</span>
          <button
            onClick={() => useLuEngineSwitchStore.getState().dismiss()}
            className="shrink-0 text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Dismiss"
          >
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  )
}
