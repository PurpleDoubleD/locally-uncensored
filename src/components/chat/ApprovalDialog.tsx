import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent-mode'

interface Props {
  toolCall: AgentToolCall
  onApprove: () => void
  onReject: () => void
}

/**
 * Inline tool-call approval strip rendered directly above the ChatInput.
 *
 * History: this used to be a centred modal with a colour-coded amber/green/red
 * palette and a dimmed backdrop. Per user feedback ("ohne Farben, kleiner,
 * sauberer, professioneller. eventuell in den chat einarbeiten") it is now a
 * compact monochrome row that sits inline in the chat instead of pulling
 * focus into a modal — readable at a glance, dismissible without breaking
 * flow.
 *
 * Keyboard shortcuts: Enter → approve, Escape → reject. Args expand inline
 * via the chevron button if the user wants to inspect what the agent is
 * about to run.
 */
export function ApprovalDialog({ toolCall, onApprove, onReject }: Props) {
  const [argsOpen, setArgsOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        onApprove()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onReject()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onApprove, onReject])

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={toolCall.id}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.12 }}
        className="mb-1.5 rounded-md border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.025] overflow-hidden"
      >
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <span className="text-[0.55rem] uppercase tracking-wider text-gray-500 dark:text-gray-500 font-medium">
            Approve
          </span>
          <code className="text-[0.65rem] text-gray-700 dark:text-gray-300 font-medium truncate flex-1 min-w-0">
            {toolCall.toolName}
          </code>
          <button
            onClick={() => setArgsOpen((v) => !v)}
            title={argsOpen ? 'Hide arguments' : 'Show arguments'}
            className="shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <ChevronDown
              size={11}
              className={'transition-transform ' + (argsOpen ? 'rotate-180' : '')}
            />
          </button>
          <div className="shrink-0 flex items-center gap-1 ml-1">
            <button
              onClick={onReject}
              className="px-2 py-0.5 rounded text-[0.6rem] text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 border border-gray-200 dark:border-white/10 transition-colors"
            >
              Reject
            </button>
            <button
              onClick={onApprove}
              autoFocus
              className="px-2 py-0.5 rounded text-[0.6rem] text-gray-800 dark:text-gray-100 bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 border border-gray-300 dark:border-white/15 transition-colors font-medium"
            >
              Approve
            </button>
          </div>
          <span className="hidden sm:inline shrink-0 text-[0.5rem] text-gray-400 dark:text-gray-600 font-mono ml-1">
            ⏎ / Esc
          </span>
        </div>

        <AnimatePresence>
          {argsOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden border-t border-gray-200 dark:border-white/[0.06]"
            >
              <pre className="text-[0.55rem] leading-relaxed text-gray-600 dark:text-gray-400 px-2.5 py-1.5 max-h-[180px] overflow-auto scrollbar-thin whitespace-pre-wrap break-words">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  )
}
