import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

/**
 * The Neurons window (3.1.0): Neurons is a plugin now, not a page. Its
 * window floats over Chat, Code and Agent, so the sliders sit next to the
 * conversation they change. Whether it is open is not saved (a start of LU
 * opens nothing by itself); where it stood, its size and whether it was
 * folded are.
 */
export interface NeuronWindowPos {
  x: number
  y: number
}

export interface NeuronWindowSize {
  w: number
  h: number
}

export interface NeuronWindowRect extends NeuronWindowPos, NeuronWindowSize {}

/** The side or corner a resize pulls at. */
export type NeuronWindowEdge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

interface NeuronWindowState {
  open: boolean
  /** Folded to its title bar, so the chat under it is free. */
  collapsed: boolean
  /** Top-left corner in CSS pixels; null = the default place (right side). */
  pos: NeuronWindowPos | null
  /** Pulled to this size; null = the default size. */
  size: NeuronWindowSize | null
  show: () => void
  hide: () => void
  toggle: () => void
  setCollapsed: (collapsed: boolean) => void
  setPos: (pos: NeuronWindowPos | null) => void
  setRect: (rect: NeuronWindowRect) => void
}

export const useNeuronWindow = create<NeuronWindowState>()(
  persist(
    (set) => ({
      open: false,
      collapsed: false,
      pos: null,
      size: null,
      show: () => set({ open: true, collapsed: false }),
      hide: () => set({ open: false }),
      toggle: () => set((s) => ({ open: !s.open, collapsed: false })),
      setCollapsed: (collapsed) => set({ collapsed }),
      setPos: (pos) => set({ pos }),
      setRect: ({ x, y, w, h }) => set({ pos: { x, y }, size: { w, h } }),
    }),
    {
      name: 'lu-neuron-window',
      storage: safeJSONStorage(),
      partialize: (s) => ({ collapsed: s.collapsed, pos: s.pos, size: s.size }),
    },
  ),
)

/** The default size: this wide, as tall as fits. */
export const NEURON_WINDOW_W = 440
export const NEURON_WINDOW_MAX_H = 760
/** Below this the title bar and a slider row no longer fit. */
export const NEURON_WINDOW_MIN_W = 360
export const NEURON_WINDOW_MIN_H = 320
/** Room kept free around the window. */
export const NEURON_WINDOW_GAP = 12

const inRange = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The largest and smallest size this app window allows. A very small app
 *  window wins over the minimum: the window never reaches past it. */
function sizeLimits(vw: number, vh: number) {
  const maxW = Math.max(0, Math.floor(vw - 2 * NEURON_WINDOW_GAP))
  const maxH = Math.max(0, Math.floor(vh - 2 * NEURON_WINDOW_GAP))
  return { maxW, maxH, minW: Math.min(NEURON_WINDOW_MIN_W, maxW), minH: Math.min(NEURON_WINDOW_MIN_H, maxH) }
}

/** Keeps the window on screen. Without a height only the title bar is held
 *  in view (a folded window). */
export function clampWindowPos(pos: NeuronWindowPos, vw: number, vh: number, w = NEURON_WINDOW_W, h?: number): NeuronWindowPos {
  const width = Math.min(w, vw - 2 * NEURON_WINDOW_GAP)
  const maxX = Math.max(NEURON_WINDOW_GAP, vw - width - NEURON_WINDOW_GAP)
  const maxY = Math.max(NEURON_WINDOW_GAP, vh - (h ?? 48) - NEURON_WINDOW_GAP)
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

/**
 * Where the window stands and how big it is in this app window. Saved values
 * are only read here, never rewritten: a window squeezed by a small app window
 * returns to its size once the app window is large again. Values that are no
 * numbers (a damaged store) count as not saved.
 */
export function resolveWindowRect(
  pos: NeuronWindowPos | null,
  size: NeuronWindowSize | null,
  vw: number,
  vh: number,
  collapsed = false,
): NeuronWindowRect {
  const { maxW, maxH, minW, minH } = sizeLimits(vw, vh)
  const w = Math.round(inRange(finite(size?.w) ?? NEURON_WINDOW_W, minW, maxW))
  const px = finite(pos?.x)
  const py = finite(pos?.y)
  const wanted = px != null && py != null ? { x: px, y: py } : defaultWindowPos(vw, w)
  const h = Math.round(inRange(finite(size?.h) ?? Math.min(NEURON_WINDOW_MAX_H, vh - wanted.y - NEURON_WINDOW_GAP), minH, maxH))
  return { ...clampWindowPos(wanted, vw, vh, w, collapsed ? undefined : h), w, h }
}

/** The window after pulling one side or corner by (dx, dy). The opposite side
 *  stays where it is. */
export function resizeWindowRect(
  start: NeuronWindowRect,
  edge: NeuronWindowEdge,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): NeuronWindowRect {
  const { minW, minH } = sizeLimits(vw, vh)
  let left = start.x
  let right = start.x + start.w
  let top = start.y
  let bottom = start.y + start.h
  if (edge.includes('w')) left = inRange(left + dx, NEURON_WINDOW_GAP, right - minW)
  if (edge.includes('e')) right = inRange(right + dx, left + minW, vw - NEURON_WINDOW_GAP)
  if (edge.includes('n')) top = inRange(top + dy, NEURON_WINDOW_GAP, bottom - minH)
  if (edge.includes('s')) bottom = inRange(bottom + dy, top + minH, vh - NEURON_WINDOW_GAP)
  const x = Math.round(left)
  const y = Math.round(top)
  return { x, y, w: Math.round(right) - x, h: Math.round(bottom) - y }
}
