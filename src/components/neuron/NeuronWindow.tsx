// The Neurons window (3.1.0): one floating window over Chat, Code and Agent,
// opened from the Neurons row under Plugins. It can be dragged by its title
// bar, folded to that bar while one chats, and closed; closing hides the
// window only, the sliders keep steering until the plugin is switched off.

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { NeuronPanel } from './NeuronPanel'
import {
  NEURON_WINDOW_GAP, NEURON_WINDOW_MAX_H, NEURON_WINDOW_W, clampWindowPos, defaultWindowPos, useNeuronWindow,
} from '../../stores/neuronWindowStore'

function viewport(): { vw: number; vh: number } {
  return { vw: window.innerWidth, vh: window.innerHeight }
}

export function NeuronWindow() {
  const open = useNeuronWindow((s) => s.open)
  const collapsed = useNeuronWindow((s) => s.collapsed)
  const saved = useNeuronWindow((s) => s.pos)
  const hide = useNeuronWindow((s) => s.hide)
  const setCollapsed = useNeuronWindow((s) => s.setCollapsed)
  const setPos = useNeuronWindow((s) => s.setPos)
  const reduced = useReducedMotion()

  const [{ vw, vh }, setView] = useState(viewport)
  useEffect(() => {
    const on = () => setView(viewport())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

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
      setDrag(clampWindowPos({ x: s.x + ev.clientX - s.px, y: s.y + ev.clientY - s.py }, window.innerWidth, window.innerHeight))
    }
    const up = (ev: PointerEvent) => {
      const s = start.current
      start.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (s && (Math.abs(ev.clientX - s.px) > 2 || Math.abs(ev.clientY - s.py) > 2)) {
        setPos(clampWindowPos({ x: s.x + ev.clientX - s.px, y: s.y + ev.clientY - s.py }, window.innerWidth, window.innerHeight))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [pos.x, pos.y, setPos])

  if (!open) return null
  const at = drag ?? pos
  return (
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
  )
}
