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

/** How long an INFO line stays before it clears itself. Long enough to read
 *  twice, short enough that it is gone by the time the user sends his next
 *  message. An error line is not on this clock, see announce(). */
export const LU_ENGINE_SWITCH_NOTE_MS = 12_000

/**
 * How the line is drawn. 'info' is the switch itself, which is not an alarm:
 * the user asked for it by picking the model. 'error' is a start that failed
 * after the slot had already been handed over, which is the one case where the
 * user has to act (A14 third review).
 */
export type LuEngineNoteTone = 'info' | 'error'

interface LuEngineSwitchState {
  note: string | null
  tone: LuEngineNoteTone
  /** Bumped on every announcement, so a timer belonging to an older one cannot
   *  clear a newer line. Same reason the slot-eviction timer keeps one. */
  generation: number
  announce: (note: string, tone?: LuEngineNoteTone, holdWhile?: () => boolean) => void
  dismiss: () => void
}

// The pending self-clear. The generation counter alone already stopped an old
// timer from clearing a new line, but the timer itself kept running: a session
// where the user picks his way through a handful of models left one live timer
// per pick, each holding the store closure until it fired. Cancelled outright
// now, and the generation counter stays as the belt to that pair of braces.
let pending: ReturnType<typeof setTimeout> | null = null

function cancelPending(): void {
  if (pending !== null) {
    clearTimeout(pending)
    pending = null
  }
}

export const useLuEngineSwitchStore = create<LuEngineSwitchState>((set, get) => ({
  note: null,
  tone: 'info',
  generation: 0,
  announce: (note, tone = 'info', holdWhile) => {
    cancelPending()
    const generation = get().generation + 1
    set({ note, tone, generation })
    // A14 fourth review: the self-clear was armed for both tones, so a failed
    // engine start faded out after twelve seconds exactly like the harmless
    // switch line. The two are not the same kind of sentence. The switch line
    // reports something the user asked for and can be forgotten; the error
    // reports a chat backend that has already changed hands with nothing
    // listening at the other end, and the way out of it is work the user has
    // to do (hand the slot back, unload the Ollama model that took the VRAM).
    // A message that asks for an action must not walk away before the action.
    // So an error stands until it is dismissed by hand or replaced by the next
    // announcement, and the bar carries a Dismiss button for exactly that.
    if (tone === 'error') return
    // A16 (A14-6): some info lines describe a condition rather than an event,
    // and "The LU Engine is still switching, one moment." is one of them. A
    // cold GGUF of a few gigabytes takes longer to load than the twelve
    // seconds this timer allows, so the sentence could walk off the screen
    // while the thing it describes was still going on, and the user who came
    // back to look found the same nothing that made him click twice in the
    // first place. `holdWhile` keeps such a line standing for as long as its
    // condition holds, and it then clears on the normal clock afterwards.
    const arm = () => {
      pending = setTimeout(() => {
        pending = null
        if (get().generation !== generation) return
        if (holdWhile?.()) { arm(); return }
        set({ note: null, tone: 'info' })
      }, LU_ENGINE_SWITCH_NOTE_MS)
    }
    arm()
  },
  dismiss: () => {
    cancelPending()
    set({ note: null, tone: 'info', generation: get().generation + 1 })
  },
}))
