/**
 * K7 Result view. Route /create/item/:id, full screen, strand 3 (Create).
 *
 * K7.1 Close, K7.2 More (opens K8), K7.3 Save, K7.4 Share, K7.5 zoom (two
 * fingers, double tap, or the zoom button), K7.6 swipe to the neighbour (or
 * the two arrow buttons), K7.7 playback of video and sound with the
 * system's time line, K7.8 Enhance video (cloud clips only), K7.9 Prompt
 * (opens the prompt, with Copy). Where the store rules ask for it there is
 * "Report".
 * The id "source" shows the current source image of K1 (K1.18).
 * A 3D model (3.1.0) shows the 3D view: drag turns it, two fingers zoom.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PointerEvent } from 'react'
import { ChevronLeft, ChevronRight, Download, Ellipsis, Flag, Share2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { modelLabel } from '../../../lib/render/preset-models'
import { ranPrompt } from '../../../lib/render/ran-prompt'
import { nav, useParams } from '../../nav'
import { CLOUD_RETENTION_DAYS } from '../../../stores/cloudNoticeStore'
import { CREATE_STRINGS as T } from '../../strings/create'
import { Button, IconButton } from '../../ui'
import { copyWithToast, saveWithToast, shareWithToast } from './parts/actions'
import { VIEW_START, clampView, pinchView, type Point, type Size, type View } from './parts/mask-strokes'
import { reportItem, shownCreateLabel, storePolicy } from './parts/policy'
import { LazyModelViewer } from '../../../components/three/LazyModelViewer'
import { MediaStateBox, itemName, useGalleryItem, useItemMedia } from './parts/ui'
import { CheckerBoard, useChecker } from './parts/checker'

/** One tap on the picture: it has the whole screen, the bars are gone. One more tap brings them back. */
const WholeScreen = createContext<() => void>(() => {})

/** An image that zooms with two fingers, a double tap or the button, and reports a sideways swipe at zoom 1. */
function ZoomImage({ src, alt, view, setView, onSwipe, onError }: { src: string; alt: string; view: View; setView: (v: View) => void; onSwipe: (dir: 1 | -1) => void; onError?: () => void }) {
  const frame = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{ kind: 'pinch'; a: Point; b: Point; ids: [number, number]; view: View } | { kind: 'drag'; from: Point; view: View; moved: boolean } | null>(null)
  const lastTap = useRef(0)
  const toggleWholeScreen = useContext(WholeScreen)
  const picture = useRef<HTMLImageElement>(null)
  const checker = useChecker(picture)

  const frameSize = (): Size => {
    const r = frame.current?.getBoundingClientRect()
    return { width: r?.width ?? 1, height: r?.height ?? 1 }
  }
  const local = (e: PointerEvent): Point => {
    const r = frame.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, local(e))
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      /* a pointer the system no longer knows */
    }
    const ids = [...pointers.current.keys()]
    if (ids.length === 2) {
      const [i, j] = ids as [number, number]
      gesture.current = { kind: 'pinch', a: pointers.current.get(i)!, b: pointers.current.get(j)!, ids: [i, j], view }
    } else if (ids.length === 1) {
      gesture.current = { kind: 'drag', from: local(e), view, moved: false }
    }
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, local(e))
    const g = gesture.current
    if (!g || !natural) return
    if (g.kind === 'pinch') {
      const a = pointers.current.get(g.ids[0])
      const b = pointers.current.get(g.ids[1])
      if (a && b) setView(pinchView(g.view, g.a, g.b, a, b, frameSize(), natural))
    } else {
      const p = local(e)
      const dx = p.x - g.from.x
      const dy = p.y - g.from.y
      if (Math.hypot(dx, dy) > 8) g.moved = true
      if (g.view.zoom > 1) setView(clampView({ zoom: g.view.zoom, x: g.view.x + dx, y: g.view.y + dy }, frameSize(), natural))
    }
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    const p = pointers.current.get(e.pointerId)
    pointers.current.delete(e.pointerId)
    if (!g) return
    if (g.kind === 'pinch') {
      if (pointers.current.size < 2) gesture.current = null
      return
    }
    gesture.current = null
    if (!p) return
    const dx = p.x - g.from.x
    const dy = p.y - g.from.y
    if (!g.moved) {
      const now = Date.now()
      if (now - lastTap.current < 300 && natural) setView(view.zoom > 1 ? VIEW_START : clampView({ zoom: 2.5, x: 0, y: 0 }, frameSize(), natural))
      lastTap.current = now
      // A tap has an effect of its own. The second tap of a double tap takes it back and zooms.
      toggleWholeScreen()
      return
    }
    if (g.view.zoom <= 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1)
  }
  return (
    <div
      ref={frame}
      className="m-viewer-stage"
      data-testid="m-create-item-stage"
      data-el="K7.5"
      data-m-zoom={view.zoom.toFixed(2)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <CheckerBoard rect={checker.rect} transform={`translate(${view.x}px, ${view.y}px) scale(${view.zoom})`} />
      <img
        ref={picture}
        className="m-k-zoomable m-k-see-through"
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        onLoad={(e) => {
          setNatural({ width: e.currentTarget.naturalWidth || 1, height: e.currentTarget.naturalHeight || 1 })
          checker.onLoad(e)
        }}
        onError={onError}
      />
    </div>
  )
}

/** `picture`: a picture that takes taps is on the stage. Only then can the bars go, because only it brings them back. */
function Chrome({ title, onClose, actions, children, state, picture }: { title: string; onClose: () => void; actions?: React.ReactNode; children: React.ReactNode; state: string; picture: boolean }) {
  const [whole, setWhole] = useState(false)
  const toggle = useCallback(() => setWhole((v) => !v), [])
  return (
    <section className="m-viewer" aria-label={title} data-testid="m-create-item-screen" data-state={state} data-m-whole={whole && picture ? '' : undefined}>
      <div className="m-viewer-bar">
        <IconButton icon={X} label={T.item.close} onPress={onClose} testid="m-create-item-close" el="K7.1" />
        <h1 className="m-viewer-title" tabIndex={-1} data-m-focus-title="">
          {title}
        </h1>
        {actions}
      </div>
      <WholeScreen.Provider value={toggle}>{children}</WholeScreen.Provider>
    </section>
  )
}

function SourceView() {
  const source = useCreateStore((s) => s.source)
  const [view, setView] = useState<View>(VIEW_START)
  const close = () => void nav.back()
  if (!source) {
    return (
      <Chrome title={T.sourceTitle} onClose={close} state="missing" picture={false}>
        <div className="m-viewer-stage">
          <div className="m-k-viewer-state">{T.mask.noSource}</div>
        </div>
      </Chrome>
    )
  }
  return (
    <Chrome
      title={T.sourceTitle}
      onClose={close}
      state="source"
      picture
      actions={<IconButton icon={view.zoom > 1 ? ZoomOut : ZoomIn} label={view.zoom > 1 ? T.item.zoomOut : T.item.zoomIn} onPress={() => setView(view.zoom > 1 ? VIEW_START : { zoom: 2.5, x: 0, y: 0 })} testid="m-create-item-zoom" el="K7.5" />}
    >
      <ZoomImage src={source.url} alt={T.sourceTitle} view={view} setView={setView} onSwipe={() => {}} />
    </Chrome>
  )
}

function ItemView({ item }: { item: GalleryItem }) {
  const gallery = useCreateStore((s) => s.gallery)
  const running = useCreateStore((s) => s.isGenerating)
  const media = useItemMedia(item)
  const [view, setView] = useState<View>(VIEW_START)
  const [showPrompt, setShowPrompt] = useState(false)
  const [working, setWorking] = useState<string | null>(null)

  useEffect(() => {
    // A new result starts unzoomed.
    setView(VIEW_START)
    setShowPrompt(false)
  }, [item.id])

  const index = gallery.findIndex((g) => g.id === item.id)
  const go = (dir: 1 | -1) => {
    const next = gallery[index + dir]
    if (next) nav.replace('/create/item/:id', { id: next.id })
  }
  const act = async (name: string, fn: () => Promise<unknown>) => {
    if (working) return
    setWorking(name)
    try {
      await fn()
    } finally {
      setWorking(null)
    }
  }
  const name = itemName(item, 60)
  // Only the text that ran. An entry from before 3.0.6 can hold the name of
  // its run in `prompt`, and a tool without a prompt field has none: both
  // read "no prompt" here and offer nothing to copy (lib/render/ran-prompt.ts).
  const prompt = ranPrompt(item)
  const state = media.state

  return (
    <Chrome
      title={T.gal.kind[item.type]}
      onClose={() => void nav.back()}
      state={state}
      picture={item.type === 'image' && state === 'ok' && !!media.url}
      actions={
        <>
          {item.type === 'image' && state === 'ok' ? (
            <IconButton icon={view.zoom > 1 ? ZoomOut : ZoomIn} label={view.zoom > 1 ? T.item.zoomOut : T.item.zoomIn} onPress={() => setView(view.zoom > 1 ? VIEW_START : { zoom: 2.5, x: 0, y: 0 })} testid="m-create-item-zoom" el="K7.5" />
          ) : null}
          <IconButton icon={Ellipsis} label={T.item.more} onPress={() => nav.openSheet('result', { id: item.id })} testid="m-create-item-more" el="K7.2" />
        </>
      }
    >
      {state !== 'ok' || !media.url ? (
        <div className="m-viewer-stage" data-testid="m-create-item-stage">
          <div className="m-k-viewer-state" data-testid="m-create-item-state">
            <MediaStateBox state={state === 'ok' ? 'refreshing' : state} onRetry={media.retry} />
            {state === 'expired' ? <span>{T.item.expiredText(CLOUD_RETENTION_DAYS)}</span> : null}
          </div>
        </div>
      ) : item.type === 'image' ? (
        <ZoomImage src={media.url} alt={name} view={view} setView={setView} onSwipe={go} onError={media.onError} />
      ) : item.type === '3d' ? (
        <div className="m-viewer-stage" data-testid="m-create-item-stage" data-el="K7.7" aria-label={name}>
          <div className="m-k-viewer-3d" data-testid="m-create-item-3d">
            <LazyModelViewer key={item.id} item={item} touch />
          </div>
        </div>
      ) : (
        <div className="m-viewer-stage" data-testid="m-create-item-stage" data-el="K7.7">
          {item.type === 'video' ? (
            <video key={media.url} src={media.url} controls playsInline preload="metadata" aria-label={name} onError={media.onError} className="m-k-viewer-media" data-testid="m-create-item-video" />
          ) : (
            <audio key={media.url} src={media.url} controls preload="metadata" aria-label={name} onError={media.onError} data-testid="m-create-item-audio" />
          )}
        </div>
      )}
      <div className="m-k-viewer-foot">
        <div className="m-k-viewer-nav" data-el="K7.6">
          <IconButton icon={ChevronLeft} label={T.item.previous} disabled={index <= 0} onPress={() => go(-1)} testid="m-create-item-prev" />
          <span data-testid="m-create-item-position">{index >= 0 ? T.item.position(index + 1, gallery.length) : ''}</span>
          <IconButton icon={ChevronRight} label={T.item.next} disabled={index < 0 || index >= gallery.length - 1} onPress={() => go(1)} testid="m-create-item-next" />
        </div>
        <div className="m-k-viewer-actions">
          <Button icon={Download} busy={working === 'save'} disabled={state === 'expired'} onPress={() => void act('save', () => saveWithToast(item))} risk="sensor" testid="m-create-item-save" el="K7.3">
            {T.item.save}
          </Button>
          <Button icon={Share2} busy={working === 'share'} disabled={state === 'expired'} onPress={() => void act('share', () => shareWithToast(item))} risk="leaves-app" testid="m-create-item-share" el="K7.4">
            {T.item.share}
          </Button>
          <Button onPress={() => setShowPrompt((v) => !v)} testid="m-create-item-prompt" el="K7.9">
            {showPrompt ? T.item.promptHide : T.item.prompt}
          </Button>
          {storePolicy().reportContent ? (
            <Button icon={Flag} label={T.policy.reportLabel(name)} onPress={() => reportItem(item)} testid="m-create-item-report">
              {T.policy.report}
            </Button>
          ) : null}
          {item.type === 'video' && item.jobId && state === 'ok' ? (
            <Button variant="cloud" disabled={running} onPress={() => nav.openSheet('create-enhance', { id: item.id })} testid="m-create-item-enhance" el="K7.8">
              {T.item.enhance}
            </Button>
          ) : null}
        </div>
        {showPrompt ? (
          <div className="m-k-viewer-prompt" data-testid="m-create-item-prompt-text">
            {item.promptOriginal ? (
              <>
                <span className="m-label">{T.item.youWrote}</span>
                <span data-testid="m-create-item-prompt-own">{item.promptOriginal}</span>
                <span className="m-label">{T.item.sentToModel}</span>
              </>
            ) : null}
            <span>{prompt || T.item.noPrompt}</span>
            {item.promptOriginal && item.rewrittenBy ? <span className="m-cap">{T.item.rewrittenBy(item.rewrittenBy)}</span> : null}
            {item.improveFailed ? (
              <span className="m-cap" data-testid="m-create-item-improve-failed">
                {T.item.improveFailed}
              </span>
            ) : null}
            <span className="m-mono">{`${T.item.model}: ${shownCreateLabel(modelLabel(item.model), item.model)}`}</span>
            {prompt ? (
              <Button compact onPress={() => void copyWithToast(prompt)} testid="m-create-item-prompt-copy">
                {T.item.copy}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Chrome>
  )
}

export default function ItemViewerPage() {
  const { id } = useParams<{ id: string }>()
  const item = useGalleryItem(id === 'source' ? null : id)
  if (id === 'source') return <SourceView />
  if (!item) {
    return (
      <Chrome picture={false} title={T.item.missing} onClose={() => void nav.back()} state="missing">
        <div className="m-viewer-stage">
          <div className="m-k-viewer-state" data-testid="m-create-item-missing">
            <span>{T.item.missingText}</span>
            <Button onPress={() => nav.replace('/create/gallery')} testid="m-create-item-to-gallery">
              {T.item.backToGallery}
            </Button>
          </div>
        </div>
      </Chrome>
    )
  }
  return <ItemView item={item} />
}
