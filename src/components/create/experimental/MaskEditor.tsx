import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Brush, Eraser, Undo2, Redo2, FlipHorizontal2, Trash2, ZoomIn, ZoomOut, Maximize,
  X, Check, Hand,
} from 'lucide-react'
import { useCreateStore, type ImageRef } from '../../../stores/createStore'
import { uploadImage } from '../../../api/comfyui'
import { MaskCanvasEngine, defaultBrushSize, type Tool } from '../canvas/MaskCanvasEngine'
import { Slider } from '../ui/Slider'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

export function MaskEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const source = useCreateStore((s) => s.source)
  // Opened without a source, nothing mounts below — and onClose only exists
  // inside the never-mounted Inner, so `open` would latch true and pop the
  // editor uninvited the moment a source appears later. Reset immediately.
  useEffect(() => {
    if (open && !source) onClose()
  }, [open, source, onClose])
  return (
    <AnimatePresence>
      {open && source && <MaskEditorInner key={source.filename} onClose={onClose} />}
    </AnimatePresence>
  )
}

function MaskEditorInner({ onClose }: { onClose: () => void }) {
  const source = useCreateStore((s) => s.source)!
  const setMask = useCreateStore((s) => s.setMask)

  const viewportRef = useRef<HTMLDivElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<MaskCanvasEngine | null>(null)

  const [tool, setTool] = useState<Tool>('brush')
  // Seeded from the same pure formula the engine's constructor uses, so the
  // slider is right on the very first paint. It used to start at 0 and be
  // corrected from the init effect by reading the fresh engine back (React 19
  // `set-state-in-effect`).
  const [brushSize, setBrushSize] = useState(() => defaultBrushSize(source.width, source.height))
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })

  // What the toolbar needs to know about the engine, mirrored into state at the
  // moments that change it. This used to be a forced re-render (`force`) plus a
  // read of engineRef.current straight from the render body — a ref read while
  // rendering (React 19 `refs`), and one that can tear: the ref is free to hold
  // a different engine than the tree currently being rendered.
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const syncHistory = useCallback(() => {
    const e = engineRef.current
    setHistory({ canUndo: !!e?.canUndo(), canRedo: !!e?.canRedo() })
  }, [])

  // A swapped source means the init effect below builds a NEW engine: default
  // brush, empty undo/redo. Both are settled here, while rendering, so the
  // toolbar never paints the previous image's brush size or a live Undo button
  // for history that no longer exists. This is the same reset the effect used
  // to do afterwards, one paint earlier.
  const [renderedFor, setRenderedFor] = useState(source)
  if (renderedFor !== source) {
    setRenderedFor(source)
    setBrushSize(defaultBrushSize(source.width, source.height))
    setHistory({ canUndo: false, canRedo: false })
  }

  const painting = useRef(false)
  const spaceDown = useRef(false)
  const panning = useRef(false)
  const panStart = useRef({ x: 0, y: 0, vx: 0, vy: 0 })
  const touched = useRef(false)

  // `panning` and `spaceDown` stay refs — a pointer stream must not wait for a
  // re-render to know whether it is panning — but the cursor they decide IS
  // rendered, so it is mirrored into state at the four events that move them.
  // Reading the refs from the render body was wrong twice over: a render-time
  // ref read (React 19 `refs`), and holding Space re-renders nothing by itself,
  // so the grab cursor only ever appeared on the next unrelated render.
  const [grabCursor, setGrabCursor] = useState(false)
  const syncCursor = useCallback(() => setGrabCursor(panning.current || spaceDown.current), [])

  const maxBrush = Math.round(Math.max(source.width, source.height) * 0.4)

  const renderOverlay = useCallback(() => {
    const e = engineRef.current, octx = overlayRef.current?.getContext('2d')
    if (e && octx) e.renderOverlay(octx)
  }, [])

  // ── init engine + draw source ──
  useEffect(() => {
    const e = new MaskCanvasEngine(source.width, source.height)
    engineRef.current = e

    const img = new Image()
    img.onload = () => {
      const ictx = imageRef.current?.getContext('2d')
      if (ictx) ictx.drawImage(img, 0, 0, source.width, source.height)
    }
    img.src = source.url
    renderOverlay()
    // No history sync here any more: a brand-new engine has empty stacks, which
    // is exactly what the state above already says for this source.
    return () => { engineRef.current = null }
  }, [source, renderOverlay])

  // ── fit view to viewport ──
  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const fit = Math.min((vp.clientWidth - 48) / source.width, (vp.clientHeight - 48) / source.height)
    setView({ scale: Math.max(0.05, fit), x: 0, y: 0 })
  }, [source])

  // ── pointer → source coords ──
  const toSource = useCallback((clientX: number, clientY: number) => {
    const rect = overlayRef.current!.getBoundingClientRect()
    return {
      x: ((clientX - rect.left) / rect.width) * source.width,
      y: ((clientY - rect.top) / rect.height) * source.height,
    }
  }, [source])

  const drawCursor = useCallback((sx: number, sy: number) => {
    const cctx = cursorRef.current?.getContext('2d')
    const e = engineRef.current
    if (!cctx || !e) return
    cctx.clearRect(0, 0, source.width, source.height)
    cctx.beginPath()
    cctx.arc(sx, sy, e.brushSize / 2, 0, Math.PI * 2)
    cctx.strokeStyle = tool === 'eraser' ? 'rgba(255,120,120,0.9)' : 'rgba(255,255,255,0.9)'
    cctx.lineWidth = Math.max(1, 2 / view.scale)
    cctx.stroke()
  }, [source, tool, view.scale])

  // Show the brush ring at canvas center on open so the tool reads as ready
  // immediately (until the user first moves the pointer).
  useEffect(() => {
    if (!touched.current) drawCursor(source.width / 2, source.height / 2)
  }, [source, drawCursor])

  const onPointerDown = (e: React.PointerEvent) => {
    const eng = engineRef.current!
    if (spaceDown.current || e.button === 1) {
      panning.current = true
      syncCursor()
      panStart.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* synthetic / unsupported */ }
      return
    }
    if (e.button !== 0) return
    const { x, y } = toSource(e.clientX, e.clientY)
    eng.beginStroke(x, y)
    painting.current = true
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* synthetic / unsupported */ }
    renderOverlay()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (panning.current) {
      setView((v) => ({ ...v, x: panStart.current.vx + (e.clientX - panStart.current.x), y: panStart.current.vy + (e.clientY - panStart.current.y) }))
      return
    }
    touched.current = true
    const { x, y } = toSource(e.clientX, e.clientY)
    drawCursor(x, y)
    if (painting.current) {
      engineRef.current!.strokeTo(x, y)
      renderOverlay()
    }
  }

  const endInteraction = () => {
    if (painting.current) { engineRef.current!.endStroke(); painting.current = false; syncHistory() }
    panning.current = false
    syncCursor()
  }

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    setView((v) => ({ ...v, scale: Math.min(8, Math.max(0.05, v.scale * factor)) }))
  }

  const fitView = useCallback(() => {
    const vp = viewportRef.current
    if (!vp) return
    const fit = Math.min((vp.clientWidth - 48) / source.width, (vp.clientHeight - 48) / source.height)
    setView({ scale: Math.max(0.05, fit), x: 0, y: 0 })
  }, [source])

  // ── keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === ' ') { spaceDown.current = true; syncCursor(); return }
      const eng = engineRef.current
      if (!eng) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) eng.redo(); else eng.undo(); renderOverlay(); syncHistory(); return }
      if (e.key === 'y') { eng.redo(); renderOverlay(); syncHistory(); return }
      if (e.key === '[') { setBrush(eng, Math.max(4, eng.brushSize - 8)) }
      if (e.key === ']') { setBrush(eng, Math.min(maxBrush, eng.brushSize + 8)) }
      if (e.key.toLowerCase() === 'b') { eng.tool = 'brush'; setTool('brush') }
      if (e.key.toLowerCase() === 'e') { eng.tool = 'eraser'; setTool('eraser') }
      if (e.key.toLowerCase() === 'i') { eng.invert(); renderOverlay(); syncHistory() }
    }
    const onUp = (e: KeyboardEvent) => { if (e.key === ' ') { spaceDown.current = false; syncCursor() } }
    const setBrush = (eng: MaskCanvasEngine, n: number) => { eng.brushSize = n; setBrushSize(n) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onUp) }
  }, [onClose, renderOverlay, syncHistory, syncCursor, maxBrush])

  const apply = async () => {
    const eng = engineRef.current!
    if (!eng.hasPaint()) { setMask(null); onClose(); return }
    const blob = await eng.exportMaskBlob()
    // ImageRef.url must be a DATA url, never a blob: url. The cloud submit
    // stages the mask through dataUrlToBlob() (no fetch — the app CSP blocks
    // connect-src for blob:/data:), which turns a blob: url into a text blob
    // and 415s the upload ("unsupported image format"). A data url round-trips.
    const url = await blobToDataUrl(blob)
    // Cloud sessions may have no ComfyUI to stage into — the cloud path
    // re-uploads from the data url at submit time (filename stays '').
    const filename =
      useCreateStore.getState().backend === 'cloud'
        ? ''
        : await uploadImage(new File([blob], 'mask.png', { type: 'image/png' }))
    const ref: ImageRef = { filename, url, width: source.width, height: source.height }
    setMask(ref)
    onClose()
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      role="dialog" aria-modal="true" aria-labelledby="mask-editor-title"
      className="fixed inset-0 z-[90] bg-white dark:bg-[#141414] flex flex-col"
    >
      {/* top bar */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2">
          <Brush size={15} className="text-gray-300" />
          <span id="mask-editor-title" className="t-title text-gray-200">Mask editor</span>
          <span className="t-mono text-gray-600 ml-2">{source.width}×{source.height}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon={X} onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={Check} onClick={apply}>Apply mask</Button>
        </div>
      </div>

      {/* toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/[0.05] shrink-0 flex-wrap">
        <div className="inline-flex gap-0.5 p-0.5 rounded-[var(--radius-control)] bg-white/[0.04] border border-white/[0.06]">
          <ToolBtn active={tool === 'brush'} icon={Brush} label="Brush (B)" onClick={() => { const e = engineRef.current; if (e) e.tool = 'brush'; setTool('brush') }} />
          <ToolBtn active={tool === 'eraser'} icon={Eraser} label="Eraser (E)" onClick={() => { const e = engineRef.current; if (e) e.tool = 'eraser'; setTool('eraser') }} />
        </div>
        <div className="w-40"><Slider label="Size" min={4} max={maxBrush} step={1} value={brushSize} onChange={(v) => { const e = engineRef.current; if (e) e.brushSize = v; setBrushSize(v) }} unit="px" /></div>
        <Divider />
        <Button variant="ghost" size="sm" icon={Undo2} iconOnly title="Undo (⌘Z)" disabled={!history.canUndo} onClick={() => { engineRef.current?.undo(); renderOverlay(); syncHistory() }} />
        <Button variant="ghost" size="sm" icon={Redo2} iconOnly title="Redo (⇧⌘Z)" disabled={!history.canRedo} onClick={() => { engineRef.current?.redo(); renderOverlay(); syncHistory() }} />
        <Button variant="ghost" size="sm" icon={FlipHorizontal2} iconOnly title="Invert (I)" onClick={() => { engineRef.current?.invert(); renderOverlay(); syncHistory() }} />
        <Button variant="ghost" size="sm" icon={Trash2} iconOnly title="Clear" onClick={() => { engineRef.current?.clear(); renderOverlay(); syncHistory() }} />
        <Divider />
        <Button variant="ghost" size="sm" icon={ZoomOut} iconOnly title="Zoom out" onClick={() => setView((v) => ({ ...v, scale: Math.max(0.05, v.scale / 1.2) }))} />
        <Button variant="ghost" size="sm" icon={ZoomIn} iconOnly title="Zoom in" onClick={() => setView((v) => ({ ...v, scale: Math.min(8, v.scale * 1.2) }))} />
        <Button variant="ghost" size="sm" icon={Maximize} iconOnly title="Fit" onClick={fitView} />
        <span className="t-mono text-gray-600">{Math.round(view.scale * 100)}%</span>
        <div className="flex-1" />
        <span className="inline-flex items-center gap-1.5 t-control text-gray-500"><Hand size={13} /> hold Space to pan · scroll to zoom</span>
      </div>

      {/* canvas viewport */}
      <div
        ref={viewportRef}
        onWheel={onWheel}
        className="flex-1 min-h-0 min-w-0 overflow-hidden relative flex items-center justify-center"
        style={{ cursor: grabCursor ? 'grab' : 'none' }}
      >
        <div
          ref={stackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endInteraction}
          onPointerLeave={() => { const cctx = cursorRef.current?.getContext('2d'); cctx?.clearRect(0, 0, source.width, source.height); endInteraction() }}
          style={{
            width: source.width,
            height: source.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            touchAction: 'none',
          }}
          className="relative shrink-0"
        >
          <canvas ref={imageRef} width={source.width} height={source.height} className="absolute inset-0 rounded-sm" style={{ width: source.width, height: source.height }} />
          <canvas ref={overlayRef} width={source.width} height={source.height} className="absolute inset-0 pointer-events-none" style={{ width: source.width, height: source.height }} />
          <canvas ref={cursorRef} width={source.width} height={source.height} className="absolute inset-0 pointer-events-none" style={{ width: source.width, height: source.height }} />
        </div>
      </div>

      {/* polarity caption */}
      <div className="flex items-center justify-center gap-2 py-2.5 border-t border-white/[0.06] shrink-0">
        <span className="w-3 h-3 rounded-sm" style={{ background: 'rgba(239,68,68,0.6)' }} />
        <span className="t-body text-gray-400">Red = will be regenerated. Paint over what you want the AI to change.</span>
      </div>
    </motion.div>
  )
}

function ToolBtn({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Brush; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn('h-[var(--control-h-md)] aspect-square inline-flex items-center justify-center rounded-[6px] transition-colors lu-focus-ring', active ? 'bg-white/[0.16] text-white border border-white/30 shadow-sm' : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.04]')}
    >
      <Icon size={15} />
    </button>
  )
}

function Divider() { return <span className="w-px h-5 bg-white/[0.08] mx-0.5" /> }
