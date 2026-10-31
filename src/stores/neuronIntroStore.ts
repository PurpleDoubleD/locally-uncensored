import { create } from 'zustand'

/**
 * Asks the Neurons page to show its introduction again (N2, 3.0.9): from the
 * page's "How it works" button and from the command palette. Not saved;
 * only "seen" is (neuronStore).
 */
export const useNeuronIntroRequest = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}))
