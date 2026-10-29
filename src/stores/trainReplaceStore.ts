// C8 (funde-C.md): "Train new" with the trigger word of a character that is
// already on this machine wrote the new LoRA over the old one at the end of
// the run (char_<trigger>_zimage.safetensors, same path), with no question
// and nothing in the Trash. The run now asks first.
//
// The same promise bridge as codexConfirmStore: runCharacterTraining awaits
// an answer, the store parks the resolver, the dialog in the Character panel
// resolves it on click. With no dialog on screen (nothing mounted to answer)
// the ask answers 'rename' at once, so a run can never hang on a question
// nobody sees, and never overwrites without one.

import { create } from 'zustand'

export type TrainReplaceAnswer = 'replace' | 'rename'

interface TrainReplaceState {
  /** The name of the character the dialog asks about, null when closed. */
  pending: string | null
  resolve: ((a: TrainReplaceAnswer) => void) | null
  /** How many dialogs are mounted to answer. */
  listeners: number
  ask: (name: string) => Promise<TrainReplaceAnswer>
  answer: (a: TrainReplaceAnswer) => void
  mount: () => () => void
}

export const useTrainReplaceStore = create<TrainReplaceState>((set, get) => ({
  pending: null,
  resolve: null,
  listeners: 0,
  ask: (name) => {
    if (get().listeners === 0) return Promise.resolve('rename')
    // A question still open is answered "rename" by the new one: one card.
    get().resolve?.('rename')
    return new Promise<TrainReplaceAnswer>((resolve) => set({ pending: name, resolve }))
  },
  answer: (a) => {
    const r = get().resolve
    set({ pending: null, resolve: null })
    r?.(a)
  },
  mount: () => {
    set((s) => ({ listeners: s.listeners + 1 }))
    return () => {
      set((s) => ({ listeners: Math.max(0, s.listeners - 1) }))
      if (get().listeners === 0) get().answer('rename')
    }
  },
}))

/** The existing character a new run with `trigger` would overwrite, or null.
 *  Case does not count: the Mac's file system treats char_Luxfox and
 *  char_luxfox as one file. */
export function characterThisWouldReplace(trigger: string, existing: { triggerWord: string }[]): string | null {
  const t = trigger.toLowerCase()
  return existing.find((c) => c.triggerWord.toLowerCase() === t)?.triggerWord ?? null
}
