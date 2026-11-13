/**
 * Messages the user writes while a run is going (CA U2).
 *
 * Claude Code, Codex and Cursor let the user keep typing while the agent
 * works: the message waits and is read after the current tool step, inside the
 * same run. In LU an Enter during a run did nothing and the text sat in the
 * composer. Not persisted: a queued message belongs to the run that is going.
 */
import { create } from 'zustand'

export interface QueuedSteer {
  id: string
  text: string
  at: number
}

interface SteerState {
  queue: Record<string, QueuedSteer[]>
  add: (convId: string, text: string) => void
  remove: (convId: string, id: string) => void
  /** Takes every waiting message of this chat, oldest first. */
  take: (convId: string) => QueuedSteer[]
}

let seq = 0

export const useSteerStore = create<SteerState>((set, get) => ({
  queue: {},
  add: (convId, text) => {
    const t = text.trim()
    if (!convId || !t) return
    const item = { id: `steer-${Date.now()}-${++seq}`, text: t, at: Date.now() }
    set((s) => ({ queue: { ...s.queue, [convId]: [...(s.queue[convId] ?? []), item] } }))
  },
  remove: (convId, id) =>
    set((s) => ({ queue: { ...s.queue, [convId]: (s.queue[convId] ?? []).filter((m) => m.id !== id) } })),
  take: (convId) => {
    const items = get().queue[convId] ?? []
    if (items.length) set((s) => ({ queue: { ...s.queue, [convId]: [] } }))
    return items
  },
}))
