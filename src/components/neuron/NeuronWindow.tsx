// The Neurons window (3.1.0): one floating window over Chat, Code and Agent,
// opened from the Neurons row under Plugins. It can be dragged by its title
// bar, folded to that bar while one chats, and closed; closing hides the
// window only, the sliders keep steering until the plugin is switched off.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { NeuronPanel } from './NeuronPanel'
import {
  NEURON_WINDOW_GAP, NEURON_WINDOW_MAX_H, NEURON_WINDOW_W, clampWindowPos, defaultWindowPos, useNeuronWindow,
} from '../../stores/neuronWindowStore'

/** The `zoom` the app shell sits under (1.15, the UI scale), read up the
 *  chain. A fixed element inside it takes its left/top/width in the zoomed
 *  units, so the screen is innerWidth / zoom wide in those units, and a
 *  pointer moved by n pixels moves the window by n / zoom. */
export function zoomAbove(el: Element | null): number {
  let z = 1
  for (let e = el; e; e = e.parentElement) {
    const v = parseFloat(getComputedStyle(e).zoom)
    if (Number.isFinite(v) && v > 0) z *= v
  }
  return z
}

function viewport(zoom: number): { vw: number; vh: number } {
  return { vw: window.innerWidth / zoom, vh: window.innerHeight / zoom }
}

export function NeuronWindow() {
  const open = useNeuronWindow((s) => s.open)
  const collapsed = useNeuronWindow((s) => s.collapsed)
  const saved = useNeuronWindow((s) => s.pos)
  const hide = useNeuronWindow((s) => s.hide)
  const setCollapsed = useNeuronWindow((s) => s.setCollapsed)
  const setPos = useNeuronWindow((s) => s.setPos)
  const reduced = useReducedMotion()

  const anchor = useRef<HTMLSpanElement>(null)
  const [zoom, setZoom] = useState(1)
  const [{ vw, vh }, setView] = useState(() => viewport(1))
  useLayoutEffect(() => {
    const on = () => {
      const z = zoomAbove(anchor.current?.parentElement ?? null)
      setZoom(z)
      setView(viewport(z))
    }
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [open])

  const width = Math.min(NEURON_WINDOW_W, vw - 2 * NEURON_WINDOW_GAP)
  const pos = clampWindowPos(saved ?? defaultWindowPos(vw), vw, vh)
  const height = Math.min(NEURON_WINDOW_MAX_H, vh - pos.y - NEURON_WINDOW_GAP)

  // Drag by the title bar. The position follows the pointer while it moves
  // and is saved once, on release.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const onDragStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    start.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    const move = (ev: PointerEvent) => {
      const s = start.current
      if (!s) return
      setDrag(clampWindowPos({ x: s.x + (ev.clientX - s.px) / zoom, y: s.y + (ev.clientY - s.py) / zoom }, window.innerWidth / zoom, window.innerHeight / zoom))
    }
    const up = (ev: PointerEvent) => {
      const s = start.current
      start.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (s && (Math.abs(ev.clientX - s.px) > 2 || Math.abs(ev.clientY - s.py) > 2)) {
        setPos(clampWindowPos({ x: s.x + (ev.clientX - s.px) / zoom, y: s.y + (ev.clientY - s.py) / zoom }, window.innerWidth / zoom, window.innerHeight / zoom))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [pos.x, pos.y, setPos, zoom])

  if (!open) return <span ref={anchor} hidden />
  const at = drag ?? pos
  return (
    <>
    <span ref={anchor} hidden />
    <motion.div
      role="dialog"
      aria-label="Neurons"
      data-testid="neuron-window"
      data-collapsed={collapsed || undefined}
      initial={reduced ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      style={{ left: at.x, top: at.y, width, height: collapsed ? 'auto' : height }}
      className="fixed z-[45] lu-elevated rounded-xl overflow-hidden flex flex-col"
    >
      <NeuronPanel chrome={{ onDragStart, collapsed, onCollapse: setCollapsed, onClose: hide }} />
    </motion.div>
    </>
  )
}
