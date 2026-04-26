import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, MessageSquare } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'

interface Props {
  content: string
}

/**
 * Renders narration the model emitted between tool calls — the
 * "I'll create an index, then write the file" prose that previously
 * vanished the moment the next iteration's tool call landed (#29 follow-up).
 *
 * Collapsible (closed by default) so the chat doesn't get noisy on long
 * agent runs. Expanded view is plain markdown, no bubble, no border —
 * matches the agent-block visual language of ToolCallBlock.
 */
export function ReflectionBlock({ content }: Props) {
  const [open, setOpen] = useState(false)
  const trimmed = content.trim()
  if (!trimmed) return null

  const firstLine = trimmed.split('\n', 1)[0]
  const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity w-full"
      >
        <MessageSquare size={10} className="text-gray-500 dark:text-gray-500 shrink-0" />
        <span className="text-[0.65rem] text-gray-600 dark:text-gray-400">notes</span>
        <span className="text-[0.55rem] text-gray-500 dark:text-gray-600 truncate flex-1">{preview}</span>
        <ChevronDown
          size={9}
          className={'text-gray-500 transition-transform shrink-0 ' + (open ? 'rotate-180' : '')}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pl-5 pb-1.5 pr-1 text-[0.7rem] leading-relaxed text-gray-600 dark:text-gray-400">
              <MarkdownRenderer content={trimmed} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
