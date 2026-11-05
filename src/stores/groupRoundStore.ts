// Who is speaking in a running group round, and the one lever to move on
// to the next speaker (3.0.9, GH #200).
//
// Before 3.0.7 a Stop during the first speaker started the second, which
// people used to pick who answers. Since 3.0.7 Stop ends the round. Both are
// wanted, so they are two actions now: "Skip speaker" ends only the turn that
// runs, "Stop round" ends the round as Stop always has.
//
// Not persisted: a round lives as long as the app runs it.
import { create } from 'zustand'

export interface GroupRoundLive {
  /** The model speaking now. */
  speaker: string
  /** Its place in this round, 0-based, and how many speak in it. */
  index: number
  total: number
}

export const useGroupRoundStore = create<{ live: Record<string, GroupRoundLive> }>(() => ({ live: {} }))

const skippers = new Map<string, { index: number; skip: () => void }>()
/** When the last skip of a chat's round went through. */
const lastSkip = new Map<string, number>()

/** A second "Skip speaker" this soon after one is the same click twice. A
 *  double click used to skip the next speaker too, before a word of it showed
 *  (T1 2026-10-29, A8). */
export const SKIP_REPEAT_MS = 600

/** The round of `convId` has moved on to `live.speaker`; `skip` ends that turn only. */
export function groupTurnStarted(convId: string, live: GroupRoundLive, skip: () => void): void {
  skippers.set(convId, { index: live.index, skip })
  useGroupRoundStore.setState((s) => ({ live: { ...s.live, [convId]: live } }))
}

/** The round of `convId` is over. */
export function groupRoundEnded(convId: string): void {
  skippers.delete(convId)
  lastSkip.delete(convId)
  useGroupRoundStore.setState((s) => {
    if (!(convId in s.live)) return s
    const { [convId]: _gone, ...rest } = s.live
    void _gone
    return { live: rest }
  })
}

/** "Skip speaker": end the turn that runs and go on with the next speaker.
 *  `index` is the place the button showed when it was clicked: a click meant
 *  for a speaker who is already gone ends nobody else's turn. False when no
 *  round of this chat is running, or the click was not taken. */
export function skipGroupSpeaker(convId: string, index?: number, now: number = Date.now()): boolean {
  const turn = skippers.get(convId)
  if (!turn) return false
  if (index !== undefined && index !== turn.index) return false
  if (now - (lastSkip.get(convId) ?? -Infinity) < SKIP_REPEAT_MS) return false
  lastSkip.set(convId, now)
  turn.skip()
  return true
}
