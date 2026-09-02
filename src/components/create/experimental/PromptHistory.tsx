import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { History, Trash2, X } from 'lucide-react'
import { useCreateStore } from '../../../stores/createStore'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { useClickAway } from '../ui/useClickAway'

/**
 * The clock button next to the prompt field and the list it opens.
 *
 * Until 2.6.8 the list could only be read from: there was no way to forget a
 * prompt, neither one entry nor the lot, and the store had no action for it
 * either. Two people asked for the missing "Clear" in Discord and were pointed
 * at a button that did not exist on the desktop app. So: a Clear all control at
 * the TOP of the list, where the answer in the channel says it is, and a
 * permanently visible X on every row (no hover, no right click).
 *
 * Clearing is not undoable, so Clear all arms first and only wipes on the
 * second click. That is the same two step delete the workflow list and the
 * agent workflows use; a raw window.confirm blocks the whole webview.
 */
export function PromptHistory({ onPick }: { onPick: (p: string) => void }) {
  const history = useCreateStore((s) => s.promptHistory)
  const clearPromptHistory = useCreateStore((s) => s.clearPromptHistory)
  const removeFromPromptHistory = useCreateStore((s) => s.removeFromPromptHistory)
  const [open, setOpen] = useState(false)
  const [armed, setArmed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarm = () => {
    if (armTimer.current) { clearTimeout(armTimer.current); armTimer.current = null }
    setArmed(false)
  }
  const close = () => { setOpen(false); disarm() }
  useClickAway(ref, close, open)
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current) }, [])

  const clearAll = () => {
    if (!armed) {
      setArmed(true)
      armTimer.current = setTimeout(() => { armTimer.current = null; setArmed(false) }, 4000)
      return
    }
    disarm()
    clearPromptHistory()
    setOpen(false)
  }

  if (history.length === 0) return null

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="sm"
        icon={History}
        iconOnly
        title="Prompt history"
        onClick={() => (open ? close() : setOpen(true))}
      />
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12 }}
            className="lu-elevated absolute bottom-full mb-1.5 left-0 z-50 w-72 rounded-lg p-1"
          >
            <div className="flex items-center justify-between gap-2 px-1.5 pb-1 mb-1 border-b border-white/[0.06]">
              <span className="t-label text-gray-500">Prompt history</span>
              <button
                type="button"
                onClick={clearAll}
                title="Delete every remembered prompt"
                className={cn(
                  't-control inline-flex items-center gap-1 px-1.5 py-1 rounded-md transition-colors',
                  armed
                    ? 'bg-red-500/15 text-red-500 dark:text-red-400'
                    : 'text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10',
                )}
              >
                <Trash2 size={12} />
                {armed ? 'Click again to clear' : 'Clear all'}
              </button>
            </div>
            <div className="max-h-56 overflow-y-auto scrollbar-thin">
              {history.map((h, i) => (
                <div key={`${i}-${h}`} className="flex items-center gap-1 rounded-md hover:bg-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => { onPick(h); close() }}
                    className="flex-1 min-w-0 text-left t-control text-gray-300 px-2.5 py-1.5 truncate"
                  >
                    {h}
                  </button>
                  <button
                    type="button"
                    title="Remove this prompt"
                    aria-label={`Remove prompt: ${h}`}
                    onClick={() => removeFromPromptHistory(h)}
                    className="shrink-0 mr-1 p-1 rounded text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
