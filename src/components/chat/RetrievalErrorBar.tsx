/**
 * "Your documents were not searched for that message."
 *
 * Review S4: retrieval failures were logged and nothing else. The user kept a
 * green Docs badge, got an answer, and had no way to know the answer had never
 * seen the PDF. This is the composer-side half of the statement; the RAG panel
 * carries the same sentence for whoever has it open.
 */
import { AlertTriangle, X } from 'lucide-react'
import { useRAGStore } from '../../stores/ragStore'

export function RetrievalErrorBar() {
  const message = useRAGStore((s) => s.retrievalError)
  if (!message) return null
  return (
    <div
      data-testid="retrieval-error-bar"
      className="mx-3 mb-1.5 flex items-start gap-2 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-[0.62rem] text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
      <span className="flex-1 leading-snug">{message}</span>
      <button
        onClick={() => useRAGStore.getState().setRetrievalError(null)}
        className="shrink-0 text-amber-600/70 hover:text-amber-700 dark:text-amber-400/70 dark:hover:text-amber-300"
        aria-label="Dismiss"
      >
        <X size={11} />
      </button>
    </div>
  )
}
