import { useEffect, useRef, useState } from 'react'
import { LEVEL_INTERVAL_MS, voiceLevel } from '../../hooks/useVoice'
import {
  HEARD_LEVEL, NO_SOUND_TEXT, barHeight, emptyHistory, formatClock, isQuiet, pushLevel,
} from '../../lib/mic-level'

export interface MicActivity {
  /** The last readings, oldest first, 0 to 1. */
  history: number[]
  /** Nothing above room noise for a few seconds. */
  quiet: boolean
  /** Running time of the take, "0:07". */
  clock: string
}

/**
 * The microphone's activity since `since` (ms epoch). One reading per meter
 * tick, also in silence, so the trace runs on as a flat line instead of
 * standing still. Only the component that draws it repaints.
 */
export function useMicActivity(since: number): MicActivity {
  const [state, setState] = useState<MicActivity>(() => ({
    history: emptyHistory(), quiet: false, clock: formatClock(0),
  }))
  const lastHeardRef = useRef(since)

  useEffect(() => {
    lastHeardRef.current = since
    const tick = () => {
      const now = Date.now()
      const level = voiceLevel()
      if (level >= HEARD_LEVEL) lastHeardRef.current = now
      setState((prev) => ({
        history: pushLevel(prev.history, level),
        quiet: isQuiet(lastHeardRef.current, now),
        clock: formatClock(now - since),
      }))
    }
    const timer = window.setInterval(tick, LEVEL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [since])

  return state
}

/**
 * The live trace while a dictation records: a slim waveform from the real
 * microphone level, the running time, and "No sound from mic" when nothing
 * has arrived for a few seconds. Neutral grey; the bars take `currentColor`,
 * so the host decides the tone. Shared by the desktop composer and the web
 * composer; the phone draws the same `useMicActivity` numbers.
 */
export function MicLevelTrace({ since, className = '' }: { since: number; className?: string }) {
  const { history, quiet, clock } = useMicActivity(since)
  return (
    <div
      data-testid="mic-level-trace"
      data-quiet={quiet ? '' : undefined}
      className={`flex min-w-0 items-center gap-2 t-micro tabular-nums text-gray-500 dark:text-gray-400 ${className}`}
    >
      <span
        aria-hidden="true"
        data-testid="mic-level-bars"
        className="flex h-4 shrink-0 items-center gap-[2px] text-gray-600 dark:text-gray-300"
      >
        {history.map((level, i) => (
          <i
            key={i}
            className="block h-full w-[2px] rounded-full bg-current transition-transform duration-75"
            style={{ transform: `scaleY(${barHeight(level).toFixed(2)})`, opacity: quiet ? 0.45 : 1 }}
          />
        ))}
      </span>
      <span data-testid="mic-level-clock">{clock}</span>
      {quiet && (
        <span role="status" data-testid="mic-level-quiet" className="truncate">{NO_SOUND_TEXT}</span>
      )}
    </div>
  )
}
