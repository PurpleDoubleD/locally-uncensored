import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Search, Globe, FileText, FileEdit, Terminal, Image, Loader2, Check, X, Clock, AlertCircle, FolderOpen, Cpu, Monitor, GitBranch, Database } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent-mode'

interface Props {
  toolCall: AgentToolCall
  onApprove?: () => void
  onReject?: () => void
}

const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  web_fetch: Globe,
  file_read: FileText,
  file_write: FileEdit,
  file_list: FolderOpen,
  file_search: Search,
  code_execute: Terminal,
  shell_execute: Terminal,
  system_info: Cpu,
  process_list: Cpu,
  screenshot: Monitor,
  image_generate: Image,
  run_workflow: GitBranch,
}

const STATUS_ICONS = {
  pending_approval: Clock,
  running: Loader2,
  completed: Check,
  failed: AlertCircle,
  rejected: X,
  // Phase 6 (v2.4.0): cached result from in-turn cache, no re-execution.
  cached: Database,
}

export function ToolCallBlock({ toolCall, onApprove, onReject }: Props) {
  // Default: collapsed (closed)
  const [open, setOpen] = useState(toolCall.status === 'pending_approval')

  const ToolIcon = TOOL_ICONS[toolCall.toolName] || Terminal
  const StatusIcon = STATUS_ICONS[toolCall.status]
  const isRunning = toolCall.status === 'running'
  const isPending = toolCall.status === 'pending_approval'
  const isFailed = toolCall.status === 'failed' || toolCall.status === 'rejected'

  return (
    <div className="mb-0.5">
      {/* Header line — monochrome, only status icon has subtle color */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity w-full"
      >
        <ToolIcon size={10} className="text-gray-500 dark:text-gray-500 shrink-0" />
        <span className="text-[0.65rem] text-gray-600 dark:text-gray-400">{toolCall.toolName}</span>
        <StatusIcon size={9} className={`shrink-0 ${
          toolCall.status === 'completed' ? 'text-gray-400 dark:text-gray-500' :
          isFailed ? 'text-red-400/60' :
          isPending ? 'text-amber-400/60' :
          'text-gray-500'
        } ${isRunning ? 'animate-spin' : ''}`} />
        {toolCall.duration != null && (
          <span className="text-[0.5rem] text-gray-500 dark:text-gray-600">
            {toolCall.duration < 1000 ? `${toolCall.duration}ms` : `${(toolCall.duration / 1000).toFixed(1)}s`}
          </span>
        )}
      </button>

      {/* Expandable details */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pl-5 pb-1.5 space-y-1">
              {/* Arguments */}
              <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-x-auto scrollbar-thin">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>

              {/* Result */}
              {toolCall.result && (
                <pre className="text-[0.55rem] leading-relaxed text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-auto scrollbar-thin max-h-[300px]">
                  {toolCall.result}
                </pre>
              )}

              {/* Error */}
              {toolCall.error && (
                <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1">
                  {toolCall.error}
                </pre>
              )}

              {/* Approval buttons — subtle green / red as the user
                  asked for ("approve grün, reject rot, sauber, keine
                  Neonfarben"). Sits inline in the pending tool block
                  instead of a popup over the input. Enter / Esc still
                  trigger the head-of-queue approval (handled in
                  ChatView). */}
              {isPending && onApprove && onReject && (
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onApprove() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 dark:bg-emerald-500/10 hover:bg-emerald-500/15 dark:hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors"
                  >
                    <Check size={10} /> Approve
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onReject() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-red-700 dark:text-red-300 bg-red-500/10 dark:bg-red-500/10 hover:bg-red-500/15 dark:hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors"
                  >
                    <X size={10} /> Reject
                  </button>
                  <span className="ml-1 text-[0.5rem] text-gray-400 dark:text-gray-600 font-mono">⏎ / Esc</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
