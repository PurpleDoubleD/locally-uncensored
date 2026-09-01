import { motion } from 'framer-motion'
import { Loader2, Check, X } from 'lucide-react'
import { GlowButton } from '../ui/GlowButton'
import type { ToolCall } from '../../types/agents'
import type { ToolArgs } from '../../api/mcp/types'
import { MOTION_S } from '../ui/motion'

interface Props {
  toolCall: ToolCall
  onApprove?: () => void
  onReject?: () => void
}

// Der einzige Aufrufer uebergibt `toolCall.args`, und das IST `ToolArgs`
// (types/agents.ts:45). Die Funktion serialisiert nur — sie greift auf keinen
// einzigen Schluessel zu, `unknown` kostet hier also nichts.
function formatArgs(args: ToolArgs): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

export function ToolCallCard({ toolCall, onApprove, onReject }: Props) {
  const isPending = toolCall.status === 'pending'
  const isRunning = toolCall.status === 'running' || toolCall.status === 'approved'
  const isCompleted = toolCall.status === 'completed'
  const isFailed = toolCall.status === 'failed' || toolCall.status === 'rejected'

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: MOTION_S.base }}
      className="glass-card rounded-lg p-3 dark:bg-lu-overlay border border-white/5"
    >
      {/* Tool Name */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[0.8rem] font-bold text-white">
          {toolCall.tool}
        </span>
        {isRunning && (
          <Loader2 size={14} className="text-blue-400 animate-spin" />
        )}
        {isCompleted && (
          <span className="t-micro text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded-full">
            completed
          </span>
        )}
        {isFailed && (
          <span className="t-micro text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded-full">
            {toolCall.status === 'rejected' ? 'rejected' : 'failed'}
          </span>
        )}
        {isPending && (
          <span className="t-micro text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full">
            awaiting approval
          </span>
        )}
      </div>

      {/* Arguments */}
      {Object.keys(toolCall.args).length > 0 && (
        <pre className="text-[0.7rem] font-mono bg-black/30 rounded-md p-2 mb-2 overflow-x-auto text-gray-300 whitespace-pre-wrap break-words max-h-[120px] overflow-y-auto scrollbar-thin">
          {formatArgs(toolCall.args)}
        </pre>
      )}

      {/* Result (completed) */}
      {isCompleted && toolCall.result && (
        <pre className="text-[0.7rem] font-mono bg-green-500/5 border border-green-500/10 rounded-md p-2 overflow-x-auto text-green-300 whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto scrollbar-thin">
          {toolCall.result}
        </pre>
      )}

      {/* Error (failed) */}
      {isFailed && toolCall.error && (
        <pre className="text-[0.7rem] font-mono bg-red-500/5 border border-red-500/10 rounded-md p-2 overflow-x-auto text-red-300 whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto scrollbar-thin">
          {toolCall.error}
        </pre>
      )}

      {/* Duration */}
      {toolCall.duration !== undefined && (
        <div className="t-micro text-gray-500 mt-1">
          {(toolCall.duration / 1000).toFixed(1)}s
        </div>
      )}

      {/* Approval Buttons */}
      {isPending && onApprove && onReject && (
        <div className="flex gap-2 mt-2">
          <GlowButton onClick={onApprove} className="text-[0.7rem] py-1 px-3 bg-green-500/10 border-green-500/30 text-green-300 hover:bg-green-500/20">
            <Check size={12} className="inline mr-1" />
            Approve
          </GlowButton>
          <GlowButton variant="danger" onClick={onReject} className="text-[0.7rem] py-1 px-3">
            <X size={12} className="inline mr-1" />
            Reject
          </GlowButton>
        </div>
      )}
    </motion.div>
  )
}
