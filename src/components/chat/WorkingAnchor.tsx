import { useEffect, useRef, useState } from 'react'
import { formatElapsed } from '../../lib/format-elapsed'

interface Props {
  isRunning: boolean
  /** What the run is actually doing right now. Defaults to "Working"; pass
   * something specific ("Waiting for your approval", "Generating image")
   * whenever the surface knows better, because a wait that looks like work
   * is how a nine minute approval stall got mistaken for progress (G15b). */
  label?: string
}

/**
 * THE bottom-of-run status line (G14-6, David 2026-08-07): the word "Working"
 * carrying the same shimmer as a live tool name, with the elapsed clock
 * beside it. It replaces the three bouncing dots AND the floating
 * bottom-right counter on every surface (Chat, Agent, Code), so a run has
 * exactly one anchor that says the app is alive, what it is doing, and for
 * how long. Reference is the Claude desktop app.
 */
export function WorkingAnchor({ isRunning, label }: Props) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    if (!isRunning) { setElapsed(0); return }
    startRef.current = Date.now()
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 250)
    return () => clearInterval(interval)
  }, [isRunning])

  if (!isRunning) return null

  return (
    <div className="flex items-center gap-2 pl-11 pr-3 py-1.5" data-testid="working-anchor">
      <span className="lu-tool-shimmer text-[0.7rem] font-medium">{label ?? 'Working'}</span>
      {elapsed >= 1 && (
        <span className="text-[0.6rem] text-gray-500 dark:text-gray-500 font-mono tabular-nums">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  )
}
