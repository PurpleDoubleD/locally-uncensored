import { itemHasAlpha } from '../../../lib/transparent-image'
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles, UserRoundPlus, FolderInput, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { runCredits } from '../../../stores/cloudCatalogStore'
import { useCreateExp } from './CreateContext'
import { useComfyMedia } from './useComfyMedia'
import { PromptDetails } from './PromptDetails'
import { cn } from '../ui/cn'
import { MoveToFolderModal } from './GalleryFolders'
import { playsAsVideo } from './galleryUrl'
import { itemsInFolder } from '../../../lib/gallery-folders'

/** How far the mouse wheel zooms a picture in the large view, and the step per notch. */
const MAX_ZOOM = 5
const ZOOM_STEP = 1.2

/**
 * The entry before or after this one, in the order the gallery panel shows
 * them (the open folder, else all). Null at either end, and for an entry the
 * panel does not show.
 */
export function galleryNeighbor<T extends { id: string; folderId?: string }>(
  all: readonly T[],
  folderOpen: string | null,
  id: string,
  step: -1 | 1,
): T | null {
  const shown = itemsInFolder(all, folderOpen)
  const at = shown.findIndex((g) => g.id === id)
  if (at < 0) return null
  return shown[at + step] ?? null
}

export function Lightbox({ item, onClose, onSaveCharacter, onNavigate, promptOpen = false }: {
  item: GalleryItem | null
  onClose: () => void
  /** The prompt unfolded from the start: asked for by the Prompt word on the
   *  stage. Opened any other way the large view folds it. */
  promptOpen?: boolean
  /** Show another entry of the gallery: the arrows on screen and the arrow
   *  keys step through the entries in the order of the gallery panel. */
  onNavigate?: (item: GalleryItem) => void
  /** Take frames of this video for a character: a training set or a saved character. */
  onSaveCharacter?: (item: GalleryItem) => void
}) {
  const backend = useCreateStore((s) => s.backend)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const { enhanceVideo, quota } = useCreateExp()
  const { src: mediaUrl, onError: onMediaError } = useComfyMedia(item)
  // D3: "Move to folder" from the large view. Keyed by the entry, so the
  // dialog never comes back up for another one.
  const [movingId, setMovingId] = useState<string | null>(null)
  // Discord (20.10.): step through the gallery with the arrows
  // and zoom a picture with the mouse wheel, as a photo viewer does.
  const all = useCreateStore((s) => s.gallery)
  const folderOpen = useCreateStore((s) => s.galleryFolderOpen)
  const prev = item && onNavigate ? galleryNeighbor(all, folderOpen, item.id, -1) : null
  const next = item && onNavigate ? galleryNeighbor(all, folderOpen, item.id, 1) : null
  const [zoom, setZoom] = useState({ id: '', scale: 1, x: 50, y: 50, panX: 0, panY: 0 })
  const scale = item && zoom.id === item.id ? zoom.scale : 1
  const panX = scale > 1 ? zoom.panX : 0
  const panY = scale > 1 ? zoom.panY : 0
  // B47 (3.0.9, Discord boromirofgeo 30.10.2026): a zoomed picture is moved
  // with the mouse button held, as in a photo viewer. The drag goes on outside
  // the picture, and letting go there does not close the view.
  const [dragging, setDragging] = useState(false)
  const dragMoved = useRef(false)

  useEffect(() => {
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      // The folder dialog and a playing video keep their own keys.
      if (movingId || (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, video, [contenteditable="true"]'))) return
      if (e.key === 'ArrowLeft' && prev && onNavigate) { e.preventDefault(); onNavigate(prev) }
      if (e.key === 'ArrowRight' && next && onNavigate) { e.preventDefault(); onNavigate(next) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, onClose, prev, next, onNavigate, movingId])

  const onWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    if (!item) return
    const box = e.currentTarget.getBoundingClientRect()
    // Zoom toward the point under the pointer, as long as the picture is at
    // its fitted size; once zoomed in, that point stays where it is.
    const x = box.width > 0 ? ((e.clientX - box.left) / box.width) * 100 : 50
    const y = box.height > 0 ? ((e.clientY - box.top) / box.height) * 100 : 50
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    const nextScale = Math.min(MAX_ZOOM, Math.max(1, scale * factor))
    // Back at the fitted size the picture is centred again.
    const keep = nextScale > 1 ? { panX, panY } : { panX: 0, panY: 0 }
    setZoom({ id: item.id, scale: nextScale, x: scale === 1 ? x : zoom.x, y: scale === 1 ? y : zoom.y, ...keep })
  }

  const onPanStart = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!item || scale <= 1 || e.button !== 0) return
    // No ghost image of the browser's own drag.
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    // How far the picture may go: its own zoomed size beyond the fitted one,
    // so a part of it always stays in view.
    const limitX = (box.width / scale) * (scale - 1)
    const limitY = (box.height / scale) * (scale - 1)
    const start = { x: e.clientX, y: e.clientY, panX, panY }
    const id = item.id
    const zoomed = { scale, x: zoom.x, y: zoom.y }
    dragMoved.current = false
    setDragging(true)
    const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v))
    const onMove = (m: MouseEvent) => {
      const dx = m.clientX - start.x
      const dy = m.clientY - start.y
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved.current = true
      setZoom({ id, ...zoomed, panX: clamp(start.panX + dx, limitX), panY: clamp(start.panY + dy, limitY) })
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Video super-resolution: only for finished CLOUD renders (jobId = the
  // clip lives in the user's render storage, which the enhance op requires).
  const canEnhance = item?.type === 'video' && !!item.jobId && backend === 'cloud' && !isGenerating
  // Gate on the run's cost like the Composer does — Enhance is a paid action
  // too, and without the gate the only feedback was a server 429 after the
  // progress bar had already started. Clip length is unknown client-side, so
  // runCredits mirrors the server's 8 s default.
  const enhanceCredits =
    canEnhance && quota != null
      ? runCredits('video', 'upscale', item.model || '', undefined, quota.costs.video)
      : null
  const enhanceOk = enhanceCredits !== null && quota != null && quota.remaining.credits >= enhanceCredits

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => {
            // A drag of the zoomed picture that ended outside it is no click.
            if (dragMoved.current) { dragMoved.current = false; return }
            onClose()
          }}
          className="lu-on-dark fixed inset-0 z-[80] bg-black/85 flex flex-col items-center justify-center gap-3 p-8"
        >
          <button onClick={onClose} className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 text-gray-200 hover:bg-white/20">
            <X size={18} />
          </button>
          {canEnhance && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                if (!enhanceOk) return
                onClose()
                void enhanceVideo(item)
              }}
              disabled={!enhanceOk}
              title={
                enhanceOk
                  ? 'Upscale this clip to 1080p on the cloud fleet'
                  : 'Not enough credits left this billing period for a video enhance'
              }
              className={cn(
                'absolute top-4 right-16 h-9 px-3 flex items-center gap-1.5 rounded-lg text-[0.7rem] font-medium',
                enhanceOk ? 'bg-white/10 text-gray-200 hover:bg-white/20' : 'bg-white/5 text-gray-500 cursor-not-allowed',
              )}
            >
              <Sparkles size={13} /> Enhance
            </button>
          )}
          {onSaveCharacter && item.type === 'video' && !item.unavailable && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onClose()
                onSaveCharacter(item)
              }}
              title="Take frames of this video for a training set or a saved character"
              className={cn(
                'absolute top-4 h-9 px-3 flex items-center gap-1.5 rounded-lg t-control bg-white/10 text-gray-200 hover:bg-white/20',
                canEnhance ? 'right-[10.5rem]' : 'right-16',
              )}
            >
              <UserRoundPlus size={13} /> Use frames for a character
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setMovingId(item.id) }}
            title="Move to folder"
            className="absolute top-4 left-4 h-9 px-3 flex items-center gap-1.5 rounded-lg t-control bg-white/10 text-gray-200 hover:bg-white/20"
          >
            <FolderInput size={13} /> Move to folder
          </button>
          {prev && onNavigate && (
            <button
              onClick={(e) => { e.stopPropagation(); onNavigate(prev) }}
              title="Previous" aria-label="Previous"
              data-testid="lightbox-prev"
              className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 text-gray-200 hover:bg-white/20"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          {next && onNavigate && (
            <button
              onClick={(e) => { e.stopPropagation(); onNavigate(next) }}
              title="Next" aria-label="Next"
              data-testid="lightbox-next"
              className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-9 h-9 flex items-center justify-center rounded-lg bg-white/10 text-gray-200 hover:bg-white/20"
            >
              <ChevronRight size={18} />
            </button>
          )}
          {/* The dialog sits inside the large view, so a click in it must not
              reach the backdrop that closes the view. */}
          <div className="contents" onClick={(e) => e.stopPropagation()}>
            <MoveToFolderModal ids={movingId === item.id ? [item.id] : []} onClose={() => setMovingId(null)} />
          </div>
          {item.type === 'audio' ? (
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              onClick={(e) => e.stopPropagation()}
              className="w-[480px] max-w-[90vw] flex flex-col items-center gap-4 p-8 rounded-lg bg-white/[0.04] border border-white/[0.08]"
            >
              <audio src={mediaUrl} controls autoPlay onError={onMediaError} className="w-full" />
            </motion.div>
          ) : (
            // The media takes the room the prompt leaves: the box below never
            // lies on the picture.
            <div className="min-h-0 flex-1 w-full flex items-center justify-center overflow-hidden">
              {playsAsVideo(item) ? (
                <motion.video
                  initial={{ scale: 0.95 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.95 }}
                  src={mediaUrl}
                  controls
                  autoPlay
                  loop
                  onError={onMediaError}
                  onClick={(e) => e.stopPropagation()}
                  className="max-w-full max-h-full object-contain rounded-lg"
                />
              ) : (
                <motion.img
                  initial={{ scale: 0.95 }}
                  // The wheel zoom rides on the same scale the opening
                  // animation uses: a style scale next to it would be
                  // animated back to 1.
                  animate={{ scale, x: panX, y: panY }}
                  // While the mouse moves the picture it follows at once.
                  transition={dragging ? { duration: 0 } : undefined}
                  exit={{ scale: 0.95 }}
                  src={mediaUrl}
                  alt={item.prompt}
                  draggable={false}
                  onError={onMediaError}
                  onClick={(e) => { e.stopPropagation(); dragMoved.current = false }}
                  onWheel={onWheel}
                  onMouseDown={onPanStart}
                  onDoubleClick={(e) => { e.stopPropagation(); setZoom({ id: item.id, scale: 1, x: 50, y: 50, panX: 0, panY: 0 }) }}
                  data-testid="lightbox-image"
                  data-zoom={scale}
                  data-pan={`${Math.round(panX)},${Math.round(panY)}`}
                  style={{ originX: (scale > 1 ? zoom.x : 50) / 100, originY: (scale > 1 ? zoom.y : 50) / 100 }}
                  className={cn(
                    'max-w-full max-h-full object-contain rounded-lg',
                    scale > 1 && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
                    itemHasAlpha(item) && 'lu-checker',
                  )}
                />
              )}
            </div>
          )}
          {/* Folded, as under the stage of Create (Discord, 20.10.): the
              picture is what the large view is opened for. */}
          <PromptDetails item={item} open={promptOpen} className="shrink-0 max-h-[40vh] overflow-y-auto scrollbar-thin bg-black/70" />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
