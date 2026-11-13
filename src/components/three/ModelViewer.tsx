// The 3D view on the Stage, in the large view and on the phone (C3D-PLAN 1.3).
// A thin React shell around lib/three/mesh-viewer.ts. Loaded on demand
// (LazyModelViewer.tsx), so three never weighs on the start of the app.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Download, Maximize2, Moon, RefreshCw, RotateCcw, Sun } from 'lucide-react'
import type { GalleryItem } from '../../stores/createStore'
import { createMeshViewer, webglAvailable, type MeshBackdrop, type MeshLook, type MeshViewer } from '../../lib/three/mesh-viewer'
import { factsLine, isHeavyFile } from '../../lib/three/mesh-facts'
import { exportMesh, MESH_FORMATS, type MeshFormat } from '../../lib/three/mesh-export'
import { readPoster, writePoster } from '../../lib/three/mesh-poster'
import { HEAVY_TRIANGLES } from '../../lib/three/mesh-facts'
import { MeshLoadError } from '../../lib/three/mesh-load'
import { fetchGalleryItemBlob, markGalleryItemAvailable } from '../create/experimental/galleryUrl'
import { saveBytes } from '../create/experimental/galleryDownload'
import { cn } from '../create/ui/cn'

export const VIEWER_TEXT = {
  hint: 'Drag to turn. Scroll to zoom.',
  hintTouch: 'Drag to turn. Pinch to zoom.',
  turn: 'Turn by itself',
  looks: { color: 'Color', clay: 'Clay', wireframe: 'Wireframe' } as Record<MeshLook, string>,
  backdrop: 'Light or dark background',
  reset: 'Reset view',
  fullscreen: 'Full screen',
  download: 'Download',
  loading: 'Opening your model…',
  heavy: 'This model is too heavy to show here. You can still download it.',
  showAnyway: 'Show it anyway',
  noWebgl: 'The 3D view needs graphics acceleration, and it is off on this device. You can still download the model.',
  saveFailed: 'This format could not be made from this model. The GLB download still works.',
}

const LOOKS: MeshLook[] = ['color', 'clay', 'wireframe']

type Phase = 'loading' | 'heavy' | 'ready' | 'error' | 'no-webgl'

export interface ModelViewerProps {
  item: GalleryItem
  className?: string
  /** Opens the large view. Left out where the viewer already is that view. */
  onFullscreen?: () => void
  /** Touch wording (the phone). */
  touch?: boolean
}

export default function ModelViewer({ item, className, onFullscreen, touch }: ModelViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<MeshViewer | null>(null)
  const bytesRef = useRef<Uint8Array | null>(null)
  // Asked once: a device does not gain or lose WebGL while the view is open.
  const [webgl] = useState(webglAvailable)
  const [phase, setPhase] = useState<Phase>(webgl ? 'loading' : 'no-webgl')
  const [message, setMessage] = useState('')
  const [facts, setFacts] = useState('')
  const [look, setLook] = useState<MeshLook>('color')
  const [backdrop, setBackdrop] = useState<MeshBackdrop>('dark')
  const [turning, setTurning] = useState(true)
  const [menu, setMenu] = useState(false)
  const [force, setForce] = useState(false)

  useEffect(() => {
    if (!webgl) return
    const canvas = canvasRef.current
    if (!canvas) return
    let alive = true
    const viewer = createMeshViewer(canvas, { onUserTouch: () => setTurning(false) })
    viewerRef.current = viewer
    void (async () => {
      try {
        const blob = await fetchGalleryItemBlob(item)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (!alive) return
        bytesRef.current = bytes
        if (isHeavyFile(bytes.byteLength) && !force) {
          setPhase('heavy')
          return
        }
        const loaded = await viewer.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
        if (!alive) return
        if (loaded.triangles > HEAVY_TRIANGLES && !force) {
          setPhase('heavy')
          return
        }
        markGalleryItemAvailable(item)
        setFacts(factsLine(loaded.triangles, bytes.byteLength))
        setTurning(true)
        setPhase('ready')
        // The gallery tile gets its still from the first good view.
        if (!(await readPoster(item.id))) {
          requestAnimationFrame(() => {
            const still = viewer.poster()
            if (still) void writePoster(item.id, still)
          })
        }
      } catch (err) {
        if (!alive) return
        setMessage(err instanceof MeshLoadError || err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    return () => {
      alive = false
      viewer.dispose()
      viewerRef.current = null
    }
  }, [item, force, webgl])

  useEffect(() => viewerRef.current?.setLook(look), [look])
  useEffect(() => viewerRef.current?.setBackdrop(backdrop), [backdrop])
  useEffect(() => viewerRef.current?.setAutoTurn(turning), [turning])

  const save = useCallback(async (format: MeshFormat) => {
    setMenu(false)
    const original = bytesRef.current
    const root = viewerRef.current?.model()
    if (!original) return
    try {
      const bytes = format === 'glb' || !root ? original : await exportMesh(format, root, original)
      await saveBytes(bytes, `lu-${item.id}.${format}`, format)
    } catch {
      setMessage(VIEWER_TEXT.saveFailed)
    }
  }, [item.id])

  const canExport = phase === 'ready'
  return (
    <div
      className={cn('relative flex flex-col w-full h-full min-h-[280px] rounded-[var(--radius-panel)] overflow-hidden border border-white/[0.06]', className)}
      data-testid="model-viewer"
      data-phase={phase}
    >
      <canvas ref={canvasRef} className={cn('w-full flex-1 min-h-0 block touch-none', phase !== 'ready' && 'opacity-0')} data-testid="model-viewer-canvas" />
      {phase !== 'ready' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-black/40">
          <Box size={28} className={cn('text-gray-400', phase === 'loading' && 'animate-pulse')} />
          <p className="t-body text-gray-300 max-w-[360px]" data-testid="model-viewer-state">
            {phase === 'loading' ? VIEWER_TEXT.loading
              : phase === 'heavy' ? VIEWER_TEXT.heavy
              : phase === 'no-webgl' ? VIEWER_TEXT.noWebgl
              : message}
          </p>
          {phase === 'heavy' && (
            <button type="button" className="t-control underline underline-offset-2 text-gray-200" onClick={() => { setPhase('loading'); setForce(true) }}>
              {VIEWER_TEXT.showAnyway}
            </button>
          )}
        </div>
      )}
      <div className="absolute top-2 right-2 flex gap-1" data-testid="model-viewer-bar">
        {phase === 'ready' && (
          <>
            <Btn title={VIEWER_TEXT.turn} pressed={turning} onClick={() => setTurning((t) => !t)} testid="mv-turn"><RefreshCw size={14} /></Btn>
            <div className="flex rounded-lg bg-black/50 backdrop-blur overflow-hidden" role="group" aria-label="Look">
              {LOOKS.map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={look === l}
                  data-testid={`mv-look-${l}`}
                  onClick={() => setLook(l)}
                  className={cn('lu-on-dark px-2 h-7 t-control', look === l ? 'text-white bg-white/10' : 'text-gray-300 hover:text-white')}
                >
                  {VIEWER_TEXT.looks[l]}
                </button>
              ))}
            </div>
            <Btn title={VIEWER_TEXT.backdrop} onClick={() => setBackdrop((b) => (b === 'dark' ? 'light' : 'dark'))} testid="mv-backdrop">
              {backdrop === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </Btn>
            <Btn title={VIEWER_TEXT.reset} onClick={() => viewerRef.current?.reset()} testid="mv-reset"><RotateCcw size={14} /></Btn>
          </>
        )}
        {onFullscreen && <Btn title={VIEWER_TEXT.fullscreen} onClick={onFullscreen} testid="mv-fullscreen"><Maximize2 size={14} /></Btn>}
        <div className="relative">
          <Btn title={VIEWER_TEXT.download} onClick={() => (canExport ? setMenu((m) => !m) : void save('glb'))} testid="mv-download"><Download size={14} /></Btn>
          {menu && (
            <div className="absolute right-0 top-8 z-10 min-w-[230px] rounded-lg bg-[var(--lu-surface,#1c1d22)] border border-white/10 shadow-xl py-1" role="menu">
              {MESH_FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitem"
                  data-testid={`mv-save-${f.id}`}
                  onClick={() => void save(f.id)}
                  className="lu-on-dark w-full text-left px-3 py-1.5 t-control text-gray-200 hover:bg-white/5"
                >
                  {f.label} <span className="text-gray-500">· {f.note}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {phase === 'ready' && (
        <div className="absolute bottom-2 left-3 right-3 flex justify-between gap-3 t-mono text-gray-400 pointer-events-none">
          <span data-testid="model-viewer-facts">{facts}</span>
          <span className="hidden sm:inline">{touch ? VIEWER_TEXT.hintTouch : VIEWER_TEXT.hint}</span>
        </div>
      )}
      {phase === 'ready' && message && (
        <div className="absolute bottom-8 left-3 t-mono text-red-300" data-testid="model-viewer-note">{message}</div>
      )}
    </div>
  )
}

function Btn({ children, title, onClick, pressed, testid }: { children: React.ReactNode; title: string; onClick: () => void; pressed?: boolean; testid: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testid}
      className={cn(
        'lu-on-dark w-7 h-7 flex items-center justify-center rounded-lg bg-black/50 backdrop-blur transition-colors',
        pressed ? 'text-white bg-white/15' : 'text-gray-200 hover:text-white hover:bg-black/70',
      )}
    >
      {children}
    </button>
  )
}
