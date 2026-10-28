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

const skippers = new Map<string, () => void>()

/** The round of `convId` has moved on to `live.speaker`; `skip` ends that turn only. */
export function groupTurnStarted(convId: string, live: GroupRoundLive, skip: () => void): void {
  skippers.set(convId, skip)
  useGroupRoundStore.setState((s) => ({ live: { ...s.live, [convId]: live } }))
}

/** The round of `convId` is over. */
export function groupRoundEnded(convId: string): void {
  skippers.delete(convId)
  useGroupRoundStore.setState((s) => {
    if (!(convId in s.live)) return s
    const { [convId]: _gone, ...rest } = s.live
    void _gone
    return { live: rest }
  })
}

/** "Skip speaker": end the turn that runs and go on with the next speaker.
 *  False when no round of this chat is running. */
export function skipGroupSpeaker(convId: string): boolean {
  const skip = skippers.get(convId)
  if (!skip) return false
  skip()
  return true
}
