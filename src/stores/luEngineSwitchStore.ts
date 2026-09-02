/**
 * "Switched your chat provider to the LU Engine for this model."
 *
 * A14 review, point 2: the sentence was written into the model picker's own
 * dropdown, and the pick closes that dropdown. So on the one path where it
 * mattered, the success path, the line was drawn and unmounted in the same
 * frame and nobody ever read it. On the failure path it was suppressed by the
 * error beside it, although a failed start is exactly when the user most needs
 * to know his chat backend has already moved.
 *
 * It lives outside the dropdown now, in the standing status row above the
 * composer, next to the other lines that survive an action (RetrievalErrorBar,
 * LoopBar, GoalBar). Announced BEFORE the engine start is attempted, so it
 * stands whether the start succeeds or fails, and in the failure case it
 * stands beside the error rather than instead of it.
 */

import { create } from 'zustand'

/** How long the line stays before it clears itself. Long enough to read twice,
 *  short enough that it is gone by the time the user sends his next message. */
export const LU_ENGINE_SWITCH_NOTE_MS = 12_000

interface LuEngineSwitchState {
  note: string | null
  /** Bumped on every announcement, so a timer belonging to an older one cannot
   *  clear a newer line. Same reason the slot-eviction timer keeps one. */
  generation: number
  announce: (note: string) => void
  dismiss: () => void
}

export const useLuEngineSwitchStore = create<LuEngineSwitchState>((set, get) => ({
  note: null,
  generation: 0,
  announce: (note) => {
    const generation = get().generation + 1
    set({ note, generation })
    setTimeout(() => {
      if (get().generation === generation) set({ note: null })
    }, LU_ENGINE_SWITCH_NOTE_MS)
  },
  dismiss: () => set({ note: null, generation: get().generation + 1 }),
}))
