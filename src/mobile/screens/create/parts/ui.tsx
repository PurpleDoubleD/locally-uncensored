/**
 * Small building blocks only Create uses.
 *
 * ADAPTER, see mobile-docs/geruest-wuensche/create.md point 2: a media tile
 * that signs its address again and the row of result actions are wishes to
 * ui/. Until they are there, they live here. The button that costs credits is
 * the Button of the kit with risk="paid".
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  Eraser, FastForward, Film, Image as ImageIcon, Maximize2, Mic, Music, PersonStanding, RefreshCw, Scissors,
  TimerOff, UserRound, Video, Wand2, X,
} from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'
import { galleryLabelShort } from '../../../../lib/render/gallery-label'
import { nav, useSheet } from '../../../nav'
import { Icon, type IconType } from '../../../ui'
import { useHeldScreenShape } from '../../../ui/screen-shape'
import { CREATE_STRINGS as T } from '../../../strings/create'
import { itemUrl, resignItem } from './adapters/result-url'
import { isComputerItem } from './computer-media'
import { CheckerBoard, useChecker } from './checker'
import type { ScreenShape } from './layout'
import type { ToolId } from './tools'
import './create.css'

export const TOOL_ICON: Record<ToolId, IconType> = {
  image: ImageIcon,
  edit: Wand2,
  removebg: Scissors,
  upscale: Maximize2,
  eraser: Eraser,
  video: Video,
  animate: Film,
  character: UserRound,
  lipsync: Mic,
  music: Music,
  extend: FastForward,
  motion: PersonStanding,
}

/** The small round X on a thumbnail. Its target is 44 px, the mark is 22 px. */
export function RemoveX({ label, onPress, testid, el }: { label: string; onPress: () => void; testid: string; el?: string }) {
  return (
    <button type="button" className="m-k-x" aria-label={label} data-testid={testid} data-el={el} onClick={onPress}>
      <span aria-hidden="true">
        <X />
      </span>
    </button>
  )
}

/** True once the element came near the screen. Media of far away tiles is not requested before. */
export function useNearViewport(ref: RefObject<Element | null>, margin = '300px'): boolean {
  // Where the browser cannot tell, everything counts as near.
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || near) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: margin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, near, margin])
  return near
}

export function useGalleryItem(id: string | null | undefined): GalleryItem | null {
  return useCreateStore((s) => (id ? s.gallery.find((g) => g.id === id) ?? null : null))
}

export type MediaState = 'ok' | 'refreshing' | 'expired' | 'failed'

/**
 * The address of a result and what to do when it does not load: ask the
 * cloud for a fresh one once, then say "expired" or offer to try again.
 */
export function useItemMedia(item: GalleryItem): { url: string | null; state: MediaState; onError: () => void; retry: () => void } {
  const [state, setState] = useState<'ok' | 'refreshing' | 'failed'>('ok')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const url = itemUrl(item)
  const ask = (force: boolean) => {
    setState('refreshing')
    void resignItem(item, force).then((result) => {
      if (!alive.current) return
      setState(result === 'fresh' ? 'ok' : result === 'gone' ? 'ok' : 'failed')
    })
  }
  useEffect(() => {
    // A result without any address (restored from an older list) asks for one right away.
    // A result of the computer comes back from the phone's own storage (computer-media.ts).
    if (!url && !item.unavailable && (item.jobId || isComputerItem(item))) ask(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])
  return {
    url,
    state: item.unavailable ? 'expired' : state,
    onError: () => {
      if (state === 'refreshing' || item.unavailable) return
      ask(false)
    },
    retry: () => ask(true),
  }
}

/** What a tile or the stage shows instead of media that is being signed again, is gone, or did not load. */
export function MediaStateBox({ state, onRetry, compact }: { state: Exclude<MediaState, 'ok'>; onRetry?: () => void; compact?: boolean }) {
  if (state === 'refreshing') {
    return (
      <span className="m-k-media-state" role="status" data-state="refreshing">
        <span className="m-ring" aria-hidden="true" />
        {T.gal.refreshing}
      </span>
    )
  }
  if (state === 'expired') {
    return (
      <span className="m-k-media-state" data-state="expired">
        <Icon icon={TimerOff} small />
        {T.gal.expired}
      </span>
    )
  }
  return (
    <span className="m-k-media-state" data-state="failed">
      <Icon icon={RefreshCw} small />
      {T.gal.loadFailed}
      {!compact && onRetry ? (
        <button type="button" className="m-btn m-btn--compact" data-testid="m-create-media-retry" onClick={onRetry}>
          {T.gal.retry}
        </button>
      ) : null}
    </span>
  )
}

/** The label of a result for names of buttons. */
export function itemName(item: GalleryItem, max = 48): string {
  return galleryLabelShort(item, max)
}

function layoutHeight(): number {
  return window.innerHeight
}

/**
 * The arrangement that fits the screen right now. Follows rotation and the text size, not the keyboard:
 * the composer of Create moves between the arrangements, and a move while typing closed the keyboard on
 * Android (ui/screen-shape.ts nextShapeState). The size text is drawn at counts: on Android the root stays
 * at 16 px and the WebView enlarges every letter (ui/text-zoom.ts).
 */
export function useScreenShape(): ScreenShape {
  return useHeldScreenShape(layoutHeight)
}

/**
 * Close the sheet this component lives in, and only that one.
 *
 * `close` of useSheet closes whatever sheet is on top. After a wait (a photo
 * that is decoded, a request to the cloud) that may be another sheet: the
 * user swiped this one away and opened the settings meanwhile. Then nothing
 * is closed.
 */
export function useCloseOwnSheet(): () => void {
  const { key, close } = useSheet()
  return useCallback(() => {
    const { overlays } = nav.getState()
    if (overlays[overlays.length - 1]?.key === key) close()
  }, [key, close])
}


/**
 * The media of a result on the stage: an image opens the result view, a
 * video and a track play right here. Shared by LU Cloud and "My computer"
 * (A17), so a track from the computer plays like one from the cloud.
 */
export function ResultMediaView({ item, openTestid, el }: { item: GalleryItem; openTestid: string; el?: string }) {
  const media = useItemMedia(item)
  const picture = useRef<HTMLImageElement>(null)
  const checker = useChecker(picture)
  const open = () => nav.push('/create/item/:id', { id: item.id })
  if (media.state !== 'ok' || !media.url) {
    return (
      <div className="m-k-media">
        <MediaStateBox state={media.state === 'ok' ? 'refreshing' : media.state} onRetry={media.retry} />
      </div>
    )
  }
  if (item.type === 'image') {
    return (
      <button type="button" className="m-k-media" aria-label={T.openResult} data-testid={openTestid} data-el={el} onClick={open}>
        <CheckerBoard rect={checker.rect} />
        <img ref={picture} className="m-k-see-through" src={media.url} alt={itemName(item, 80)} onLoad={checker.onLoad} onError={media.onError} />
      </button>
    )
  }
  if (item.type === 'video') {
    return (
      <div className="m-k-media">
        <video src={media.url} controls playsInline preload="metadata" aria-label={itemName(item, 80)} onError={media.onError} />
      </div>
    )
  }
  return (
    <div className="m-k-media">
      <audio src={media.url} controls preload="metadata" aria-label={itemName(item, 80)} onError={media.onError} />
    </div>
  )
}
