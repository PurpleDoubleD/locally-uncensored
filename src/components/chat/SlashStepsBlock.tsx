import { useState, useRef, useEffect, type ReactNode } from 'react'
import { Terminal, Loader2, ChevronDown, Check } from 'lucide-react'

interface Props {
  /** Command word without the leading slash, e.g. "review". */
  command: string
  /** Number of tool-call steps in this run (shown in the header). */
  stepCount: number
  /** True while this run is still streaming (latest message + loop running). */
  running: boolean
  /** The fully-rendered step transcript (reflection + tool calls + answers). */
  children: ReactNode
}

/**
 * Coding-Agent slash-command transcript wrapped in a collapsible, tool-call-style
 * window (David 2026-06-12: "Slash-Steps in einem tool-artigen Call-Fenster,
 * standardmäßig zugeklappt aber trotzdem streaming bis kein Platz mehr").
 *
 *  - Default COLLAPSED — the user sees just the header (command + step count).
 *  - While RUNNING and collapsed, a bounded, auto-scrolling preview shows the
 *    live stream: newest content sits at the bottom, older steps fade out the top
 *    once there's no more room ("bis kein Platz mehr") — progress is visible
 *    without expanding.
 *  - Click the header to expand the full transcript; click again to collapse.
 */
export function SlashStepsBlock({ command, stepCount, running, children }: Props) {
  const [open, setOpen] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)

  // Keep the live preview pinned to the newest content while running + collapsed.
  // No dep array: the children re-render as blocks stream in, so this runs each
  // render and the preview tracks the bottom — that's the intended "stream until
  // there's no more space, then scroll" behaviour.
  useEffect(() => {
    if (running && !open && previewRef.current) {
      previewRef.current.scrollTop = previewRef.current.scrollHeight
    }
  })

  return (
    <div className="rounded border border-gray-200 dark:border-white/10 bg-gray-50/50 dark:bg-white/[0.02] overflow-hidden">
      {/* Header — tool-call styling: icon + command + step count + status. */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 w-full px-2 py-1 text-left hover:bg-gray-100/60 dark:hover:bg-white/[0.03] transition-colors"
      >
        <Terminal size={10} className="text-gray-500 shrink-0" />
        <span className="t-micro font-mono text-gray-600 dark:text-gray-300">/{command}</span>
        <span className="text-[0.5rem] text-gray-400 dark:text-gray-600">
          {stepCount} {stepCount === 1 ? 'step' : 'steps'}
        </span>
        {running ? (
          <Loader2 size={9} className="animate-spin text-gray-500 shrink-0" />
        ) : (
          <Check size={9} className="text-gray-400 dark:text-gray-500 shrink-0" />
        )}
        <div className="flex-1" />
        <span className="text-[0.5rem] text-gray-400 dark:text-gray-600">
          {open ? 'hide' : running ? 'live' : 'show'}
        </span>
        <ChevronDown
          size={11}
          className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        // Expanded — the full transcript.
        <div className="px-2 pb-1.5 pt-0.5 border-t border-gray-100 dark:border-white/[0.05]">
          {children}
        </div>
      ) : running ? (
        // Collapsed + running — bounded auto-scrolling live peek. The top fades so
        // streamed steps look like they scroll up out of view. pointer-events-none
        // lets clicks fall through to the header toggle above.
        <div
          ref={previewRef}
          className="px-2 pb-1.5 pt-1 max-h-[140px] overflow-hidden opacity-70 pointer-events-none border-t border-gray-100 dark:border-white/[0.05] [mask-image:linear-gradient(to_bottom,transparent,#000_28px)]"
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}
