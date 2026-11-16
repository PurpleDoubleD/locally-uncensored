// The Neurons hint of 3.1.0 (David 16.11.2026): a small calm dot on the
// Plugins button until the user has opened Plugins AND turned Neurons on once,
// and the same dot on the Neurons row until it was on once. Kept on this
// computer only.
//
// remove in 3.1.1: set NEURONS_HINT_ON to false (or delete this file and the
// places that import it). Everything about the hint hangs on this one switch.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** remove in 3.1.1 */
export const NEURONS_HINT_ON = true
/** Its storage key names the release it belongs to (3.1.0; no version is
 *  typed into the interface, lib/app-version.ts is the one source). */
export const NEURONS_HINT_KEY = 'lu-neurons-hint-310'

export const NEURONS_HINT_LABEL = 'New: Neurons'

interface NeuronsHintState {
  /** Plugins was opened at least once. */
  menuOpened: boolean
  /** Neurons was switched on at least once. */
  neuronsOnce: boolean
  noteMenuOpened: () => void
  noteNeuronsOn: () => void
}

export const useNeuronsHint = create<NeuronsHintState>()(
  persist(
    (set, get) => ({
      menuOpened: false,
      neuronsOnce: false,
      noteMenuOpened: () => { if (!get().menuOpened) set({ menuOpened: true }) },
      noteNeuronsOn: () => { if (!get().neuronsOnce) set({ neuronsOnce: true }) },
    }),
    {
      name: NEURONS_HINT_KEY,
      partialize: (s) => ({ menuOpened: s.menuOpened, neuronsOnce: s.neuronsOnce }),
    },
  ),
)

/**
 * Which dots show. `available` is whether Neurons can be turned on here at
 * all (desktop app, not Cloud mode): a dot that points at a grey switch would
 * only nag. A Neurons that is on right now counts as on once.
 */
export function neuronsHintDots(
  state: { menuOpened: boolean; neuronsOnce: boolean },
  available: boolean,
  neuronsOnNow: boolean,
  hintOn: boolean = NEURONS_HINT_ON,
): { trigger: boolean; row: boolean } {
  if (!hintOn || !available) return { trigger: false, row: false }
  const once = state.neuronsOnce || neuronsOnNow
  return { trigger: !(state.menuOpened && once), row: !once }
}
