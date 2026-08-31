// The running /loop, above the composer, with the brake.
//
// A loop has no pass ceiling unless the user sets one, so it can genuinely run
// all night. That is only honest if it is visible the whole time and one click
// from stopping — an endless job you cannot see is not a feature, it is a bill.

import { useEffect, useState } from 'react'
import { RefreshCw, Square } from 'lucide-react'
import { useAgentLoopStore } from '../../stores/agentLoopStore'
import { useChatStore } from '../../stores/chatStore'

interface Props {
  /** Stops the run AND the pending pass. */
  onStop: () => void
}

export function LoopBar({ onStop }: Props) {
  const loop = useAgentLoopStore((s) => s.loop)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  // The clock the countdown divides by, read once a second in the interval
  // instead of on every render. Reading `Date.now()` down in the render body
  // was impure (React 19 `purity`) AND it made the countdown depend on
  // something re-rendering this bar, which is not what "counts down" means.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!loop) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [loop])

  if (!loop || loop.conversationId !== activeConversationId) return null

  const secs = Math.max(0, Math.ceil((loop.nextAt - now) / 1000))
  const passLabel = loop.cap > 0 ? `pass ${loop.pass} of ${loop.cap}` : `pass ${loop.pass}`

  return (
    <div className="w-full max-w-[var(--lu-measure)] mx-auto px-3 pb-1 flex justify-center">
      <div className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md border border-blue-500/25 bg-blue-500/[0.05]">
        <RefreshCw size={9} className="text-blue-400 shrink-0 animate-spin" style={{ animationDuration: '3s' }} />
        <span className="text-[0.55rem] uppercase tracking-wider text-gray-500 shrink-0">loop</span>
        <span className="text-[0.6rem] text-gray-700 dark:text-gray-300 shrink-0">{passLabel}</span>
        <span className="flex-1 min-w-0 truncate text-[0.6rem] text-gray-500" title={loop.task}>
          {loop.task}
        </span>
        <span className="text-[0.55rem] text-gray-500 shrink-0 tabular-nums">
          {secs > 0 ? `next in ${secs}s` : 'running'}
        </span>
        <button
          onClick={onStop}
          title="Stop the loop"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.55rem] text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-white/10 transition-colors shrink-0"
        >
          <Square size={7} /> stop
        </button>
      </div>
    </div>
  )
}
