import { motion, AnimatePresence } from 'framer-motion'
import { ShieldAlert, Check, X } from 'lucide-react'
import { useEffect } from 'react'
import type { AgentToolCall } from '../../types/agent-mode'
import { ToolCallBlock } from './ToolCallBlock'

interface Props {
  toolCall: AgentToolCall
  onApprove: () => void
  onReject: () => void
}

/**
 * Agent tool-call approval prompt. Before v2.4 this was a small inline
 * strip above the ChatInput and users missed it. It's now a centred modal
 * with a dimmed backdrop so the approval gate is impossible to overlook.
 *
 * Keyboard shortcuts: Enter → approve, Escape → reject.
 */
export function ApprovalDialog({ toolCall, onApprove, onReject }: Props) {
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
    <AnimatePresence>
      <motion.div
        key="backdrop"
        className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={onReject}
      >
        <motion.div
          key="dialog"
          className="w-full max-w-[480px] rounded-xl bg-white dark:bg-[#1a1a1a] border border-amber-500/30 shadow-2xl overflow-hidden"
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20">
            <ShieldAlert size={14} className="text-amber-400" />
            <span className="text-[0.75rem] text-amber-400 font-semibold">
              Tool approval required
            </span>
            <span className="ml-auto text-[0.5rem] text-amber-400/50 font-mono">
              Enter ✓ · Esc ✕
            </span>
          </div>

          {/* Tool details */}
          <div className="px-4 py-3">
            <ToolCallBlock toolCall={toolCall} />
          </div>

          {/* Prominent action row */}
          <div className="flex items-center gap-2 px-4 pb-3">
            <button
              onClick={onApprove}
              autoFocus
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-green-500/15 border border-green-500/40 text-green-400 hover:bg-green-500/25 hover:border-green-500/60 transition-all text-[0.7rem] font-medium"
            >
              <Check size={12} /> Approve
            </button>
            <button
              onClick={onReject}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 hover:border-red-500/50 transition-all text-[0.7rem] font-medium"
            >
              <X size={12} /> Reject
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
