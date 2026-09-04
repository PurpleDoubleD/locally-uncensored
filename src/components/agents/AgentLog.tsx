import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ScrollText } from 'lucide-react'
import { ToolCallCard } from './ToolCallCard'
import type { AgentLogEntry } from '../../types/agents'
import { MOTION_S } from '../ui/motion'

// Fuenf Eintragsarten, fuenf Farben. Nur eine davon ist eine Aussage ueber den
// Zustand: `error` ist rot. Die anderen vier sortieren, sie bewerten nicht.
//
// `action` war gelb, und Gelb neben Rot liest sich wie „fast kaputt", dabei ist
// eine Aktion der Normalfall dieses Protokolls. Fuchsia, weil es sich von den
// vier Nachbarn am weitesten unterscheidet: Gedanke und Aktion wechseln sich
// hier im Sekundentakt ab, und genau die zwei muessen beim Scrollen ohne Lesen
// auseinanderfallen. Indigo und Fuchsia tun das, Indigo und Violett nicht.
const typeStyles: Record<AgentLogEntry['type'], { badge: string; bg: string; text: string }> = {
  thought:     { badge: 'bg-indigo-500/20 text-indigo-300',   bg: 'border-l-indigo-500/40',  text: 'text-indigo-200' },
  action:      { badge: 'bg-fuchsia-500/20 text-fuchsia-300', bg: 'border-l-fuchsia-500/40', text: 'text-fuchsia-200' },
  observation: { badge: 'bg-green-500/20 text-green-300',     bg: 'border-l-green-500/40',   text: 'text-green-200' },
  error:       { badge: 'bg-red-500/20 text-red-300',         bg: 'border-l-red-500/40',     text: 'text-red-200' },
  user_input:  { badge: 'bg-blue-500/20 text-blue-300',       bg: 'border-l-blue-500/40',    text: 'text-blue-200' },
}

const typeLabels: Record<AgentLogEntry['type'], string> = {
  thought: 'Thought',
  action: 'Action',
  observation: 'Result',
  error: 'Error',
  user_input: 'Goal',
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface Props {
  entries: AgentLogEntry[]
  onApprove?: (toolCallId: string) => void
  onReject?: (toolCallId: string) => void
}

export function AgentLog({ entries, onApprove, onReject }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1.5 text-[12px] text-gray-400 mb-2 font-medium flex-shrink-0">
        <ScrollText size={13} />
        Agent Log ({entries.length})
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-1.5 min-h-0 scrollbar-thin pr-1">
        <AnimatePresence initial={false}>
          {entries.map((entry) => {
            const style = typeStyles[entry.type]
            return (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: MOTION_S.base }}
                className={`border-l-2 ${style.bg} pl-3 py-1.5`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`t-micro px-1.5 py-0.5 rounded-full font-medium ${style.badge}`}>
                    {typeLabels[entry.type]}
                  </span>
                  <span className="t-micro text-gray-500">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                </div>
                <div
                  className={`text-[0.8rem] leading-relaxed whitespace-pre-wrap break-words ${
                    entry.type === 'observation' ? 'font-mono text-[12px]' : ''
                  } ${style.text}`}
                >
                  {entry.content}
                </div>
                {entry.toolCall && entry.toolCall.status === 'pending' && onApprove && onReject && (
                  <div className="mt-1.5">
                    <ToolCallCard
                      toolCall={entry.toolCall}
                      onApprove={() => onApprove(entry.toolCall!.id)}
                      onReject={() => onReject(entry.toolCall!.id)}
                    />
                  </div>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
        <div ref={endRef} />
      </div>
    </div>
  )
}
