/**
 * What the user can do about a run that ended on an error (CA U7): try the
 * same instruction again, or pick another model. Shown under the newest
 * failed answer only, and never while a run is going.
 */
import { RotateCcw, Cpu } from 'lucide-react'
import type { MessageError } from '../../types/chat'
import { useUIStore } from '../../stores/uiStore'

/** Kinds no retry fixes on its own. */
const NO_RETRY: ReadonlySet<MessageError['kind']> = new Set(['credits', 'session'])

export function RunErrorActions({ error, onRetry }: { error: MessageError; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1.5" data-testid="run-error-actions">
      {onRetry && !NO_RETRY.has(error.kind) && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md t-control text-gray-800 dark:text-gray-100 border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
        >
          <RotateCcw size={12} /> Try again
        </button>
      )}
      <button
        type="button"
        onClick={() => useUIStore.getState().askForModel()}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md t-control text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors"
      >
        <Cpu size={12} /> Choose another model
      </button>
    </div>
  )
}
