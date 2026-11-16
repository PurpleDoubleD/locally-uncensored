// What the Character area tells the prompt window (David, 16.11.2026: the
// window is the same Composer in every tab of Create, 660 wide, at the same
// place; the area above it only says what its text field and its button do).
//
// Two writers, each with its own slot: the stage (the character on it, the
// states in which nothing can be made yet) and the one click swap (its total,
// its steps, the question of the first frame). The Composer reads `swap`
// before `stage`. Pure state: no React, nothing is started here.

import { create } from 'zustand'

export interface HubRun {
  /** The button's word: "Create", "Continue", "Continue in Edit". */
  label: string
  /** A price behind the word: "Create · 62k". */
  price?: string | null
  ready: boolean
  /** Why the button waits, as the note above the window and its title. */
  hint?: string
  run: () => void
  /** A run is going: the button is Cancel. */
  running?: boolean
  cancel?: () => void
  cancelDisabled?: boolean
  /** A text of its own in the field (the first frame: "What's wrong?"). */
  field?: { value: string; onChange: (v: string) => void; placeholder: string }
}

export interface HubStageSlot {
  /** The field's line while the action takes a prompt. */
  placeholder?: string
  run?: HubRun
}

interface HubRunState {
  stage: HubStageSlot | null
  swap: HubRun | null
  /** What the window takes on the picked action, said by the Composer for
   *  the settings (HubSettings): a prompt at all, and a negative one. */
  window: { prompt: boolean; negative: boolean }
  setWindow: (prompt: boolean, negative: boolean) => void
  setStage: (stage: HubStageSlot | null) => void
  setSwap: (swap: HubRun | null) => void
}

export const useHubRun = create<HubRunState>((set) => ({
  stage: null,
  swap: null,
  window: { prompt: false, negative: false },
  setWindow: (prompt, negative) => set((s) => (s.window.prompt === prompt && s.window.negative === negative ? s : { window: { prompt, negative } })),
  setStage: (stage) => set({ stage }),
  setSwap: (swap) => set({ swap }),
}))
