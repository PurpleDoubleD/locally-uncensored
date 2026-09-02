/**
 * The one line that says a model pick moved the chat backend.
 *
 * Same shape and same place as RetrievalErrorBar: above the composer, where
 * standing statements live, so it survives the dropdown closing under it. Not
 * an alarm colour, because nothing went wrong: the user asked for this by
 * picking an LU Engine model, he just has to be told what it cost him.
 */
import { X } from 'lucide-react'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'

export function LuEngineSwitchBar() {
  const note = useLuEngineSwitchStore((s) => s.note)
  if (!note) return null
  return (
    <div
      data-testid="lu-engine-switch-note"
      className="mx-3 mb-1.5 flex items-start gap-2 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[0.62rem] text-gray-600 dark:text-gray-300"
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
  )
}
