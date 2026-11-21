// The Neurons window (3.1.0): one floating window over Chat, Code and Agent,
// opened from the Neurons row under Plugins. It can be dragged by its title
// bar, pulled larger or smaller at its sides and corners, folded to that bar
// while one chats, and closed; closing hides the window only, the sliders keep
// steering until the plugin is switched off.

import { useLayoutEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { NeuronPanel } from './NeuronPanel'
import {
  resizeWindowRect, resolveWindowRect, useNeuronWindow,
  type NeuronWindowEdge, type NeuronWindowRect,
} from '../../stores/neuronWindowStore'

/** The invisible grips. They straddle the border, 4px outside and 3px inside,
 *  so they cover neither the scrollbar nor the title bar's buttons. Corners
 *  come last and lie on top of the sides. */
const GRIPS: ReadonlyArray<{ edge: NeuronWindowEdge; className: string }> = [
  { edge: 'n', className: '-top-1 left-1.5 right-1.5 h-[7px] cursor-ns-resize' },
  { edge: 's', className: '-bottom-1 left-1.5 right-1.5 h-[7px] cursor-ns-resize' },
  { edge: 'w', className: '-left-1 top-1.5 bottom-1.5 w-[7px] cursor-ew-resize' },
  { edge: 'e', className: '-right-1 top-1.5 bottom-1.5 w-[7px] cursor-ew-resize' },
  { edge: 'nw', className: '-top-1 -left-1 w-2.5 h-2.5 cursor-nwse-resize' },
  { edge: 'ne', className: '-top-1 -right-1 w-2.5 h-2.5 cursor-nesw-resize' },
  { edge: 'sw', className: '-bottom-1 -left-1 w-2.5 h-2.5 cursor-nesw-resize' },
  { edge: 'se', className: '-bottom-1 -right-1 w-2.5 h-2.5 cursor-nwse-resize' },
]

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
  const savedPos = useNeuronWindow((s) => s.pos)
  const savedSize = useNeuronWindow((s) => s.size)
  const hide = useNeuronWindow((s) => s.hide)
  const setCollapsed = useNeuronWindow((s) => s.setCollapsed)
  const setPos = useNeuronWindow((s) => s.setPos)
  const setRect = useNeuronWindow((s) => s.setRect)
  const reduced = useReducedMotion()

  const anchor = useRef<HTMLSpanElement>(null)
  const frame = useRef<HTMLDivElement>(null)
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

  const rect = resolveWindowRect(savedPos, savedSize, vw, vh, collapsed)

  // While a pointer holds the window its frame is written straight to the
  // element, once per animation frame: the panel with all its sliders does not
  // render again for every pixel. The store gets the result once, on release.
  const paint = (r: NeuronWindowRect) => {
    const el = frame.current
    if (!el) return
    el.style.left = `${r.x}px`
    el.style.top = `${r.y}px`
    el.style.width = `${r.w}px`
    if (!collapsed) el.style.height = `${r.h}px`
  }

  const hold = (
    e: React.PointerEvent,
    next: (dx: number, dy: number, vw: number, vh: number) => NeuronWindowRect,
    commit: (r: NeuronWindowRect) => void,
  ) => {
    if (e.button !== 0) return
    const target = e.currentTarget as HTMLElement
    const id = e.pointerId
    const px = e.clientX
    const py = e.clientY
    // Captured, so the pull goes on outside the window and over a webview.
    target.setPointerCapture?.(id)
    const read = (ev: PointerEvent) => next(
      (ev.clientX - px) / zoom, (ev.clientY - py) / zoom, window.innerWidth / zoom, window.innerHeight / zoom,
    )
    let last: NeuronWindowRect | null = null
    let raf = 0
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      last = read(ev)
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (last) paint(last) })
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      stop()
      if (Math.abs(ev.clientX - px) > 2 || Math.abs(ev.clientY - py) > 2) {
        const r = read(ev)
        paint(r)
        commit(r)
      } else paint(rect)
    }
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return
      stop()
      paint(rect)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const onDragStart = (e: React.PointerEvent) => hold(
    e,
    (dx, dy, w, h) => resolveWindowRect({ x: rect.x + dx, y: rect.y + dy }, savedSize, w, h, collapsed),
    ({ x, y }) => setPos({ x, y }),
  )
  const onResizeStart = (edge: NeuronWindowEdge) => (e: React.PointerEvent) => hold(
    e,
    (dx, dy, w, h) => resizeWindowRect(rect, edge, dx, dy, w, h),
    setRect,
  )

  if (!open) return <span ref={anchor} hidden />
  // Folded there is only the bar: it can get wider or narrower, not taller.
  const grips = collapsed ? GRIPS.filter((g) => g.edge === 'e' || g.edge === 'w') : GRIPS
  return (
    <>
    <span ref={anchor} hidden />
    <div
      ref={frame}
      role="dialog"
      aria-label="Neurons"
      data-testid="neuron-window"
      data-collapsed={collapsed || undefined}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: collapsed ? 'auto' : rect.h }}
      className="fixed z-[45]"
    >
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="h-full lu-elevated rounded-xl overflow-hidden flex flex-col"
      >
        <NeuronPanel chrome={{ onDragStart, collapsed, onCollapse: setCollapsed, onClose: hide }} />
      </motion.div>
      {grips.map((g) => (
        <div
          key={g.edge}
          aria-hidden="true"
          data-testid={`neuron-resize-${g.edge}`}
          onPointerDown={onResizeStart(g.edge)}
          className={`absolute z-20 touch-none select-none ${g.className}`}
        />
      ))}
    </div>
    </>
  )
}
