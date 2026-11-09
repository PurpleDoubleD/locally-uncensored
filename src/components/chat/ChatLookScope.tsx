import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useChatLookStore } from '../../stores/chatLookStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { highlightPlain } from '../../lib/chat-highlight'
import { keyZoom, lookVars, pickBackground, wheelZoom, widthFactor, DEFAULT_LOOK } from '../../lib/chat-look'
import { sanitizeChatCss } from '../../lib/chat-css-sanitize'
import { readAttachment } from '../../lib/chat-attachments'
import { log } from '../../lib/logger'

/**
 * The transcript's look (3.1.0, C58) and reading zoom (C42), in one place.
 *
 * `variant="chat"` (Chat and Agent, MessageList) carries everything: colours,
 * highlighting, font, width, layout, the background picture and the user's
 * custom CSS. `variant="code"` (CodexView) carries the zoom only: the Code
 * transcript is diffs and logs, colouring quotes there would help nobody.
 *
 * The zoom is the one place outside the app root that uses CSS `zoom`
 * (index.css `.lu-chat-zoom`). It is the user's own reading size, like a
 * browser's Ctrl/Cmd + wheel, and it is applied to the column of messages
 * only: the header, the prompt box and the side panels keep their size.
 * Popovers inside the column measure the chain of zooms
 * (hooks/usePopoverPlatz.ts massstab), so a context menu still opens at the
 * pointer.
 */

interface HighlightFlags { quotes: boolean; actions: boolean }
const HighlightContext = createContext<HighlightFlags>({ quotes: false, actions: false })

/** Whether markdown under this scope wraps quoted speech (MarkdownRenderer). */
export function useChatHighlight(): HighlightFlags {
  return useContext(HighlightContext)
}

/** A user's message, plain text, with quotes and *actions* coloured when the
 *  look asks for it. Without highlighting it is the text itself, unchanged. */
export function UserText({ text }: { text: string }) {
  const flags = useChatHighlight()
  if (!flags.quotes && !flags.actions) return <>{text}</>
  return (
    <>
      {highlightPlain(text, flags.quotes, flags.actions).map((p, i) =>
        p.kind === 'text' ? p.text
          : <span key={i} className={p.kind === 'quote' ? 'lu-quote' : 'lu-action'}>{p.text}</span>,
      )}
    </>
  )
}

/** The background picture's data URL, read from the attachment store. */
function useBackgroundUrl(ref: string | null): string | null {
  const [url, setUrl] = useState<{ ref: string; url: string } | null>(null)
  useEffect(() => {
    if (!ref) return
    let alive = true
    readAttachment(ref).then(
      (data) => { if (alive && data.startsWith('data:image/')) setUrl({ ref, url: data }) },
      (err: unknown) => log.warn('[chat-look] background picture did not load', { error: err }),
    )
    return () => { alive = false }
  }, [ref])
  return ref && url?.ref === ref ? url.url : null
}

/** On screen. A `display: contents` scope has no box of its own, so its
 *  parent answers for it. */
function visible(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false
  return el.getClientRects().length > 0 || (el.parentElement?.getClientRects().length ?? 0) > 0
}

interface ScopeProps {
  variant: 'chat' | 'code'
  className: string
  children: ReactNode
}

export function ChatLookScope({ variant, className, children }: ScopeProps) {
  const zoom = useChatLookStore((s) => s.zoom)
  const setZoom = useChatLookStore((s) => s.setZoom)
  const look = useChatLookStore((s) => (variant === 'chat' ? s.look : DEFAULT_LOOK))
  const backgrounds = useChatLookStore((s) => s.backgrounds)
  const theme = useSettingsStore((s) => s.settings.theme)
  const mode = theme === 'light' ? 'light' : 'dark'
  const conversationId = useChatStore((s) => s.activeConversationId)
  const personaId = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId)?.personaId)
  const rootRef = useRef<HTMLDivElement>(null)
  const [badge, setBadge] = useState(0)

  const bg = variant === 'chat' ? pickBackground(backgrounds, conversationId, personaId) : null
  const bgUrl = useBackgroundUrl(bg?.bg.ref ?? null)

  // Ctrl/Cmd + wheel over the transcript, and a trackpad pinch (which macOS
  // sends as ctrl + wheel). Native and not passive: React's onWheel cannot
  // preventDefault, and WebView2 would otherwise scroll as well.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const now = useChatLookStore.getState().zoom
      const next = wheelZoom(now, e.deltaY, e.deltaMode)
      if (next !== now) setZoom(next)
      setBadge(Date.now())
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoom])

  // Ctrl/Cmd with + - 0, while this transcript is on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !visible(rootRef.current)) return
      const next = keyZoom(useChatLookStore.getState().zoom, e.key)
      if (next === null) return
      e.preventDefault()
      setZoom(next)
      setBadge(Date.now())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setZoom])

  useEffect(() => {
    if (!badge) return
    const t = setTimeout(() => setBadge(0), 1400)
    return () => clearTimeout(t)
  }, [badge])

  const custom = useMemo(
    () => (variant === 'chat' && look.customCssOn ? sanitizeChatCss(look.customCss).css : ''),
    [variant, look.customCssOn, look.customCss],
  )

  const vars = useMemo(() => (variant === 'chat' ? lookVars(look, mode) : {}), [variant, look, mode])
  const style = { ...vars, '--lu-chat-zoom': String(zoom) } as CSSProperties
  const factor = widthFactor(look.width)
  // "Full" is a factor no window reaches, so the column is as wide as the pane.
  if (factor !== 1) (style as Record<string, string>)['--lu-chat-width'] = factor === null ? '100' : String(factor)

  const classes = [
    className,
    'lu-look',
    variant === 'chat' ? 'lu-chat-custom' : '',
    vars['--lu-look-model-text'] ? 'lu-look-model-color' : '',
    vars['--lu-look-user-text'] ? 'lu-look-user-color' : '',
    vars['--lu-look-user-bubble'] ? 'lu-look-user-bubble' : '',
    vars['--lu-look-quote'] ? 'lu-look-quotes' : '',
    vars['--lu-look-action'] ? 'lu-look-actions' : '',
    vars['--lu-look-font'] ? 'lu-look-font' : '',
    variant === 'chat' && look.lineHeight !== DEFAULT_LOOK.lineHeight ? 'lu-look-leading' : '',
    variant === 'chat' && look.layout !== 'default' ? `lu-look-${look.layout}` : '',
    bgUrl ? 'lu-look-has-bg' : '',
  ].filter(Boolean).join(' ')

  const flags = useMemo(
    () => ({ quotes: !!vars['--lu-look-quote'], actions: !!vars['--lu-look-action'] }),
    [vars],
  )

  return (
    <HighlightContext.Provider value={flags}>
      <div ref={rootRef} className={classes} style={style} data-mode={mode} data-testid={`chat-look-${variant}`}>
        {bgUrl && bg && (
          <div aria-hidden className="lu-chat-bg pointer-events-none absolute inset-0 overflow-hidden" data-testid="chat-background">
            <img
              src={bgUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
              // The blur would show a soft pale rim at the edges; the picture
              // reaches past them by twice the radius instead.
              style={bg.bg.blur ? { filter: `blur(${bg.bg.blur}px)`, inset: `-${bg.bg.blur * 2}px`, width: 'auto', height: 'auto' } : undefined}
            />
            <div className="lu-chat-scrim absolute inset-0" style={{ opacity: bg.bg.scrim }} />
          </div>
        )}
        {custom && <style data-testid="chat-custom-css">{custom}</style>}
        {children}
        {badge > 0 && (
          <button
            type="button"
            onClick={() => { setZoom(1); setBadge(Date.now()) }}
            className="absolute right-3 top-2 z-20 rounded-full lu-elevated px-2 py-0.5 t-micro text-gray-700 dark:text-gray-200"
            title="Reset the text size (Ctrl/Cmd + 0)"
            data-testid="chat-zoom-badge"
          >
            {Math.round(zoom * 100)}%{zoom !== 1 ? ' · Reset' : ''}
          </button>
        )}
      </div>
    </HighlightContext.Provider>
  )
}
