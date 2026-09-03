import { Terminal, FileEdit, Brain, AlertCircle, CheckCircle, ChevronDown } from 'lucide-react'
import { useState, memo } from 'react'
import type { CodexEvent } from '../../types/codex'
import { DiffView } from './DiffView'

interface Props {
  event: CodexEvent
}

// memo (audit D2): events are append-only, so every existing block can skip
// re-rendering while the transcript streams.
export const CodexEventBlock = memo(CodexEventBlockImpl)

function CodexEventBlockImpl({ event }: Props) {
  const [open, setOpen] = useState(event.type === 'error')

  if (event.type === 'instruction' || event.type === 'done') return null

  const icons = {
    file_change: FileEdit,
    terminal_output: Terminal,
    reasoning: Brain,
    error: AlertCircle,
  }

  const colors = {
    file_change: 'text-amber-400',
    terminal_output: 'text-green-400',
    reasoning: 'text-blue-400',
    error: 'text-red-400',
  }

  const labels = {
    file_change: event.filePath || 'File changed',
    terminal_output: 'Terminal',
    reasoning: 'Thinking',
    error: 'Error',
  }

  const Icon = icons[event.type as keyof typeof icons] || CheckCircle
  const color = colors[event.type as keyof typeof colors] || 'text-gray-400'
  const label = labels[event.type as keyof typeof labels] || event.type
  const hasDiff = event.type === 'file_change' && Boolean(event.diff)

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity w-full"
      >
        <Icon size={10} className={color} />
        <span className={`t-micro ${color}`}>{label}</span>
        <ChevronDown size={8} className={`text-gray-600 ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="pl-4 pb-1">
          {hasDiff ? (
            <DiffView diff={event.diff!} />
          ) : (
            <pre className={`t-micro leading-relaxed rounded px-2 py-1 overflow-auto scrollbar-thin max-h-[250px] ${
              event.type === 'terminal_output'
                ? 'bg-black/20 text-green-300/70'
                : event.type === 'error'
                  ? 'bg-red-500/5 text-red-400/80'
                  : event.type === 'reasoning'
                    ? 'text-blue-200/40 italic'
                    : 'bg-white/[0.02] text-gray-400'
            }`}>
              {event.content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
