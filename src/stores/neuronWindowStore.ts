import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

/**
 * The Neurons window (3.1.0): Neurons is a plugin now, not a page. Its
 * window floats over Chat, Code and Agent, so the sliders sit next to the
 * conversation they change. Whether it is open is not saved (a start of LU
 * opens nothing by itself); where it stood and whether it was folded are.
 */
export interface NeuronWindowPos {
  x: number
  y: number
}

interface NeuronWindowState {
  open: boolean
  /** Folded to its title bar, so the chat under it is free. */
  collapsed: boolean
  /** Top-left corner in CSS pixels; null = the default place (right side). */
  pos: NeuronWindowPos | null
  show: () => void
  hide: () => void
  toggle: () => void
  setCollapsed: (collapsed: boolean) => void
  setPos: (pos: NeuronWindowPos | null) => void
}

export const useNeuronWindow = create<NeuronWindowState>()(
  persist(
    (set) => ({
      open: false,
      collapsed: false,
      pos: null,
      show: () => set({ open: true, collapsed: false }),
      hide: () => set({ open: false }),
      toggle: () => set((s) => ({ open: !s.open, collapsed: false })),
      setCollapsed: (collapsed) => set({ collapsed }),
      setPos: (pos) => set({ pos }),
    }),
    {
      name: 'lu-neuron-window',
      storage: safeJSONStorage(),
      partialize: (s) => ({ collapsed: s.collapsed, pos: s.pos }),
    },
  ),
)

/** Window size: fixed width, as tall as fits. */
export const NEURON_WINDOW_W = 440
export const NEURON_WINDOW_MAX_H = 760
/** Room kept free around the window. */
export const NEURON_WINDOW_GAP = 12

/** Keeps the window's corner on screen, title bar always reachable. */
export function clampWindowPos(pos: NeuronWindowPos, vw: number, vh: number, w = NEURON_WINDOW_W): NeuronWindowPos {
  const width = Math.min(w, vw - 2 * NEURON_WINDOW_GAP)
  const maxX = Math.max(NEURON_WINDOW_GAP, vw - width - NEURON_WINDOW_GAP)
  const maxY = Math.max(NEURON_WINDOW_GAP, vh - 48 - NEURON_WINDOW_GAP)
  return {
    x: Math.round(Math.min(maxX, Math.max(NEURON_WINDOW_GAP, pos.x))),
    y: Math.round(Math.min(maxY, Math.max(NEURON_WINDOW_GAP, pos.y))),
  }
}

/** The default place: right side, under the header. */
export function defaultWindowPos(vw: number, w = NEURON_WINDOW_W): NeuronWindowPos {
  const width = Math.min(w, vw - 2 * NEURON_WINDOW_GAP)
  return { x: Math.max(NEURON_WINDOW_GAP, vw - width - 16), y: 64 }
}
