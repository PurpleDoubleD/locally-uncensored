import { useEffect, useState } from 'react'
import { useGenerationStore } from '../../stores/generationStore'
import { useRunActivityStore } from '../../stores/runActivityStore'
import { StatusChip } from '../status/StatusChip'
import { deriveRunStatus, type RunSignals } from '../status/run-status'
import { WorkingBeacon } from './WorkingBeacon'

interface Props {
  isRunning: boolean
  /** The conversation whose run this is. Its booked start (generationStore
   *  `runs[id].bookedAt`) drives the clock, so leaving the tab and coming
   *  back does not start the count again at 0. */
  conversationId?: string | null
  /** A call waits for the user. A wait that looks like work is how a nine
   *  minute approval stall got mistaken for progress (G15b). */
  awaitingApproval?: boolean
  /** A local model is loading and has not answered yet. */
  loadingModel?: boolean
  /** The assistant message the run is filling: its text, reasoning and tool calls say what the run is doing. */
  message?: RunSignals['message']
}

/**
 * When a conversation's approval wait began, so the clock next to "Waiting
 * for your approval" says how long the card has been waiting, not how long the
 * run has been going. Module scope, like the run's booked start, so a tab
 * switch does not start the wait at 0 again.
 */
const waitSince = new Map<string, number>()

/**
 * THE bottom-of-run status line: the LU mark showing what the run is doing,
 * the word for it, and the elapsed clock. One anchor per run on every surface
 * (Chat, Agent, Code), so a run always says that the app is alive, what it is
 * doing, and for how long.
 */
export function WorkingAnchor({ isRunning, conversationId, awaitingApproval, loadingModel, message }: Props) {
  const [elapsed, setElapsed] = useState(0)
  // The mounted status line, as state: the mark above the composer watches it.
  const [line, setLine] = useState<HTMLDivElement | null>(null)
  const bookedAt = useGenerationStore((s) => (conversationId ? s.runs[conversationId]?.bookedAt : undefined))
  const activity = useRunActivityStore((s) => (conversationId ? s.activity[conversationId] : undefined))
  const waiting = !!awaitingApproval

  // The clock resets in the render where the run or the wait flips, not in an
  // effect afterwards, so the old count never paints under the new word.
  const [wasRunning, setWasRunning] = useState(isRunning)
  const [wasWaiting, setWasWaiting] = useState(waiting)
  if (wasRunning !== isRunning || wasWaiting !== waiting) {
    setWasRunning(isRunning)
    setWasWaiting(waiting)
    setElapsed(0)
  }

  useEffect(() => {
    // A wait that is over gives its start up, so the next approval of this
    // conversation counts from its own start.
    if (conversationId && (!isRunning || !waiting)) waitSince.delete(conversationId)
    if (!isRunning) return
    let start: number
    if (waiting && conversationId) {
      if (!waitSince.has(conversationId)) waitSince.set(conversationId, Date.now())
      start = waitSince.get(conversationId)!
    } else if (waiting) {
      start = Date.now()
    } else {
      start = bookedAt ?? Date.now()
    }
    // One update per second, timed to the moment the shown second changes.
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const ms = Math.max(0, Date.now() - start)
      setElapsed(Math.floor(ms / 1000))
      timer = setTimeout(tick, 1000 - (ms % 1000))
    }
    tick()
    return () => clearTimeout(timer)
  }, [isRunning, bookedAt, waiting, conversationId])

  if (!isRunning) return null

  const status = deriveRunStatus({ awaitingApproval: waiting, loadingModel, activity, message })

  return (
    <>
      {/* The word is the announcement; the mark and the clock are hidden from
          assistive technology, otherwise a screen reader would speak every second. */}
      <div
        ref={setLine}
        className="flex items-center pl-11 pr-3 py-1.5"
        data-testid="working-anchor"
        data-status={status.kind}
        role="status"
        aria-live="polite"
      >
        <StatusChip kind={status.kind} word={status.word} detail={status.detail} seconds={elapsed} />
      </div>
      {/* B26: why the first wait lasts, while it is still the line shown, or
          while the chat's own "Loading model" stands in for it (a local model
          keeps that word until its first token, loaded or not). Outside the
          live region: the word is announced, the sentence is read. */}
      {activity?.hint && (status.word === activity.label || status.kind === 'loading') && (
        <p className="pl-11 pr-3 pb-1.5 text-xs text-gray-500 dark:text-gray-400" data-testid="working-anchor-hint">
          {activity.hint}
        </p>
      )}
      {/* Scrolled away from the line above, the run still shows: the mark alone, above the composer. */}
      <WorkingBeacon anchor={line} kind={status.kind} />
    </>
  )
}
