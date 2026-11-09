import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleHelp, ExternalLink, Maximize2, Minimize2, Play, X } from 'lucide-react'
import { HOWTO, howtoGuideUrl, howtoLineAt, howtoVideoUrl } from '../../lib/howto'
import { openExternal } from '../../api/backend'
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape'

interface Props {
  /** Key into HOWTO: a Create intent id, 'code' or 'agent'. */
  topic: string
  /** `line` is the quiet text line of an empty Create stage, `mark` the bare
   *  circled question mark of a toolbar. */
  variant: 'line' | 'mark'
  /** Where the card opens relative to its trigger. */
  placement?: 'above' | 'below-end' | 'above-start'
  /** Icon size of the `mark` variant, to sit level with its toolbar. */
  markSize?: number
}

const GAP = 8
const EDGE = 8

/** Where the card stands for a trigger: on the wanted side if it fits there,
 *  on the other one if not, and never outside the window. */
export function howtoCardPlace(
  trigger: { left: number; right: number; top: number; bottom: number },
  card: { width: number; height: number },
  win: { width: number; height: number },
  placement: NonNullable<Props['placement']>,
): { left: number; top: number } {
  const above = trigger.top - GAP - card.height
  const below = trigger.bottom + GAP
  const wantsAbove = placement !== 'below-end'
  const fitsAbove = above >= EDGE
  const fitsBelow = below + card.height <= win.height - EDGE
  const top = wantsAbove ? (fitsAbove || !fitsBelow ? above : below) : (fitsBelow || !fitsAbove ? below : above)
  const left = placement === 'above'
    ? (trigger.left + trigger.right) / 2 - card.width / 2
    : placement === 'below-end' ? trigger.right - card.width : trigger.left
  const clamp = (v: number, max: number) => Math.max(EDGE, Math.min(v, max))
  return { left: clamp(left, win.width - EDGE - card.width), top: clamp(top, win.height - EDGE - card.height) }
}

/**
 * The entry to "How it works" and the card it opens: a short silent film and
 * ONE line under it that follows the scene. Nothing is loaded until the card
 * is opened; without a connection the card shows its lines as a list instead.
 *
 * C26 (3.1.0, Discord: "so small they are unwatchable"): the 340 px card is a
 * preview. The enlarge button, or a double click on the film, opens it over
 * the whole window, with the film as large as the window allows and the same
 * line under it, at the second it was at. Escape or a click beside it goes
 * back to the card. It is an in-app view, not the Fullscreen API: WKWebView
 * and WebKitGTK only allow element fullscreen when the host switches it on.
 */
export function HowItWorks({ topic, variant, placement = 'above', markSize = 11 }: Props) {
  const entry = HOWTO[topic]
  const [open, setOpen] = useState(false)
  const [filmIndex, setFilmIndex] = useState(0)
  const [line, setLine] = useState('')
  const [failed, setFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const [large, setLarge] = useState(false)
  const largeRef = useRef<HTMLDivElement>(null)
  /** Where the film was when it changed size, so it goes on from there. */
  const resumeAt = useRef(0)
  useDismissOnEscape(open, () => { if (large) setLarge(false); else setOpen(false) })

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      const t = e.target as Node
      // The large view's own backdrop shrinks it back (its onClick), it does
      // not close the whole thing.
      if (largeRef.current?.contains(t)) return
      if (!rootRef.current?.contains(t) && !cardRef.current?.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  // The card is drawn on the body, so no stage or toolbar can clip it, and
  // placed again whenever its own size changes (film loaded, list shown).
  useLayoutEffect(() => {
    if (!open || large) return
    const card = cardRef.current
    const root = rootRef.current
    if (!card || !root) return
    // The app root is zoomed (--ui-scale): rectangles come back in window
    // pixels, `left` and `top` are read in the card's own, so the place is
    // worked out in window pixels and handed over divided by that ratio.
    const put = () => {
      const box = card.getBoundingClientRect()
      const ratio = card.offsetWidth > 0 ? box.width / card.offsetWidth : 1
      const at = howtoCardPlace(
        root.getBoundingClientRect(),
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
        placement,
      )
      setPlace({ left: at.left / ratio, top: at.top / ratio })
    }
    put()
    const seen = new ResizeObserver(put)
    seen.observe(card)
    window.addEventListener('resize', put)
    return () => { seen.disconnect(); window.removeEventListener('resize', put) }
  }, [open, placement, large])

  if (!entry) return null
  const film = entry.films[Math.min(filmIndex, entry.films.length - 1)]

  const pick = (i: number) => {
    setFilmIndex(i)
    setFailed(false)
    setLine(entry.films[i].steps[0]?.text ?? '')
  }
  const toggle = () => {
    if (!open) { pick(filmIndex); setLarge(false); resumeAt.current = 0 }
    setOpen((o) => !o)
  }
  const resize = (to: boolean, from: HTMLVideoElement | null) => {
    resumeAt.current = from?.currentTime ?? 0
    setLarge(to)
  }

  const filmHeader = (closeLabel: string, onCloseClick: () => void, sizeButton: ReactNode) => (
    <div className="flex items-center gap-2 mb-2">
      <span className="t-control font-semibold text-gray-800 dark:text-gray-200">{entry.title}</span>
      {entry.films.length > 1 && entry.films.map((f, i) => (
        <button
          key={f.id}
          onClick={() => { resumeAt.current = 0; pick(i) }}
          aria-pressed={i === filmIndex}
          className={`t-control px-1.5 rounded transition-colors ${i === filmIndex
            ? 'text-gray-800 dark:text-gray-200 bg-gray-100 dark:bg-white/[0.06]'
            : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
        >
          {f.label}
        </button>
      ))}
      <div className="flex-1" />
      {sizeButton}
      <button
        onClick={onCloseClick}
        aria-label={closeLabel}
        className="p-0.5 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
      >
        <X size={12} />
      </button>
    </div>
  )

  const filmVideo = (big: boolean) => (
    <video
      key={`${film.id}-${big ? 'large' : 'card'}`}
      src={howtoVideoUrl(film)}
      autoPlay
      loop
      muted
      playsInline
      data-testid={big ? 'howto-video-large' : 'howto-video'}
      title={big ? undefined : 'Double-click to enlarge'}
      onLoadedMetadata={(e) => {
        const at = resumeAt.current
        if (at > 0 && at < e.currentTarget.duration) e.currentTarget.currentTime = at
      }}
      onDoubleClick={(e) => resize(!big, e.currentTarget)}
      onTimeUpdate={(e) => setLine(howtoLineAt(film.steps, e.currentTarget.currentTime))}
      onError={() => setFailed(true)}
      className={big
        ? 'block min-h-0 w-full flex-1 object-contain rounded-md bg-black'
        : 'block w-full rounded-md border border-gray-200 dark:border-white/[0.06] bg-gray-200 dark:bg-lu-canvas cursor-zoom-in'}
    />
  )

  // aria-haspopup: the trigger opens a card, it does not unfold a section.
  // Screen readers announce it that way, and the settings walk in
  // e2e/ui-language.spec.ts tells the two apart by it.
  return (
    <div ref={rootRef} className="relative inline-flex" data-testid={`howto-${topic}`}>
      {variant === 'line' ? (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="t-control inline-flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <Play size={10} /> {entry.title}
        </button>
      ) : (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={entry.title}
          title={entry.title}
          className="p-1 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors shrink-0"
        >
          <CircleHelp size={markSize} />
        </button>
      )}
      {open && createPortal(
        <div
          ref={cardRef}
          role="dialog"
          aria-label={entry.title}
          data-testid={`howto-card-${topic}`}
          style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}
          className="fixed z-50 w-[340px] max-w-[90vw] p-2.5 rounded-lg text-left lu-elevated"
        >
          {filmHeader('Close', () => setOpen(false), !failed && (
            <button
              onClick={() => resize(true, cardRef.current?.querySelector('video') ?? null)}
              aria-label="Enlarge video"
              title="Enlarge"
              data-testid="howto-enlarge"
              className="p-0.5 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              <Maximize2 size={12} />
            </button>
          ))}
          {failed ? (
            <ol className="t-control text-gray-600 dark:text-gray-400 space-y-1 list-decimal pl-4" data-testid="howto-lines">
              {film.steps.map((s) => <li key={s.from}>{s.text}</li>)}
            </ol>
          ) : (
            <>
              {large ? (
                <div className="flex aspect-video w-full items-center justify-center rounded-md border border-gray-200 dark:border-white/[0.06] bg-gray-200 dark:bg-lu-canvas t-control text-gray-500">
                  Playing enlarged
                </div>
              ) : filmVideo(false)}
              <p className="t-control mt-2 min-h-[2.6em] text-gray-600 dark:text-gray-400" data-testid="howto-line">{line}</p>
            </>
          )}
          {howtoGuideUrl(entry) && (
            <button
              onClick={() => { void openExternal(howtoGuideUrl(entry)!) }}
              data-testid="howto-guide"
              className="t-control mt-1.5 inline-flex items-center gap-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            >
              Read the full guide <ExternalLink size={10} />
            </button>
          )}
        </div>,
        document.body,
      )}
      {open && large && !failed && createPortal(
        <div
          ref={largeRef}
          className="fixed inset-0 z-[60] flex items-center justify-center p-6 lu-dialog-scrim"
          onClick={(e) => { if (e.target === e.currentTarget) setLarge(false) }}
          data-testid={`howto-large-${topic}`}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${entry.title}, enlarged`}
            className="flex max-h-full w-full max-w-[1280px] flex-col rounded-xl p-3 lu-dialog"
          >
            {filmHeader('Close enlarged video', () => setLarge(false), (
              <button
                onClick={() => resize(false, largeRef.current?.querySelector('video') ?? null)}
                aria-label="Shrink video"
                title="Shrink"
                className="p-0.5 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                <Minimize2 size={12} />
              </button>
            ))}
            {filmVideo(true)}
            <p className="t-body mt-2 min-h-[2.6em] text-center text-gray-700 dark:text-gray-300" data-testid="howto-line-large">{line}</p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
