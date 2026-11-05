import { create } from 'zustand'
import type { HfModelLink } from '../lib/hf-link'

/**
 * The Hugging Face link the user is being asked about (lib/hf-link.ts). Never
 * persisted: a link is one click, and a restart must not bring back a
 * download question nobody remembers asking.
 */
interface HfLinkState {
  /** A checked link waiting for the dialog in Models, Discover. */
  pending: HfModelLink | null
  /** A link that failed the check, with the sentence that says why. */
  rejected: string | null
  /** In cloud mode Models does not exist: the question is to switch first. */
  needsLocal: boolean
  offer: (link: HfModelLink, needsLocal: boolean) => void
  reject: (reason: string) => void
  setNeedsLocal: (needsLocal: boolean) => void
  clear: () => void
}

export const useHfLinkStore = create<HfLinkState>((set) => ({
  pending: null,
  rejected: null,
  needsLocal: false,
  offer: (link, needsLocal) => set({ pending: link, rejected: null, needsLocal }),
  reject: (reason) => set({ pending: null, rejected: reason, needsLocal: false }),
  setNeedsLocal: (needsLocal) => set({ needsLocal }),
  clear: () => set({ pending: null, rejected: null, needsLocal: false }),
}))
