// Watchers above the composer: one thin line, "◷ 18:00 · RTX 5090 prices" or
// "◷ 3 watchers · next 18:00". A click opens a plain list under it with Pause
// and Delete. No frame and no surface around it (David, 14.11.2026): it is a
// line of text in the composer's own column, like the hairlines of a run.
import { useEffect, useState } from 'react'
import { Clock3 } from 'lucide-react'
import { useWatcherStore } from '../../stores/watcherStore'
import { useChatStore } from '../../stores/chatStore'
import { useUIStore } from '../../stores/uiStore'
import { useCodexStore } from '../../stores/codexStore'
import { backendCall } from '../../api/backend'
import { repeatText, whenText } from '../../lib/watchers/schedule'
import type { Watcher, WatcherHint } from '../../lib/watchers/types'
import { COMPOSER_MAX_W } from './composer-width'

/** The collapsed line. Null when there is nothing to show. Pure. */
export function stripLine(watchers: readonly Watcher[], hints: readonly WatcherHint[], now: number): string | null {
  const running = watchers.find((w) => w.running_since)
  if (running) return watchers.length > 1 ? `running · ${running.name} · ${watchers.length} watchers` : `running · ${running.name}`
  const waiting = watchers.filter((w) => !w.paused && w.next_at).sort((a, b) => (a.next_at ?? 0) - (b.next_at ?? 0))
  if (watchers.length === 1 && waiting.length === 1) return `${whenText(waiting[0].next_at!, now)} · ${waiting[0].name}`
  if (waiting.length > 0) return `${watchers.length} watchers · next ${whenText(waiting[0].next_at!, now)}`
  if (watchers.length > 0) {
    const paused = watchers.filter((w) => w.paused).length
    return `${watchers.length === 1 ? watchers[0].name : `${watchers.length} watchers`} · ${paused === watchers.length ? 'paused' : 'nothing due'}`
  }
  if (hints.length > 0) return hints.length === 1 ? `${hints[0].name} ended when LU quit` : `${hints.length} watchers ended when LU quit`
  return null
}

/** The right-hand words of one row. Pure. */
export function rowState(w: Watcher, now: number): string {
  if (w.running_since) return 'running now'
  const last = w.runs[0]
  const lastText = last ? `last ${whenText(last.at, now)} ${last.status}` : 'not run yet'
  if (w.paused) return `paused · ${lastText}`
  if (!w.next_at) return lastText
  return `${repeatText(w.schedule)} · ${lastText}`
}

const act = 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors'

export function WatcherStrip() {
  const watchers = useWatcherStore((s) => s.watchers)
  const hints = useWatcherStore((s) => s.hints)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const busy = watchers.length > 0 || hints.length > 0
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [busy])
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(null), 3000)
    return () => clearTimeout(t)
  }, [confirming])

  const line = stripLine(watchers, hints, now)
  if (!line) return null

  const call = (cmd: string, args: Record<string, unknown>) => { void backendCall(cmd, args).catch(() => {}) }
  const openChat = (convId: string | null) => {
    if (!convId || !useChatStore.getState().conversations.some((c) => c.id === convId)) return
    useCodexStore.getState().setChatMode('lu')
    useChatStore.getState().setActiveConversation(convId)
    useUIStore.getState().setView('chat')
  }
  const sorted = [...watchers].sort((a, b) => (a.next_at ?? Number.MAX_SAFE_INTEGER) - (b.next_at ?? Number.MAX_SAFE_INTEGER))

  return (
    <div className={`w-full ${COMPOSER_MAX_W} mx-auto px-3 pb-1`} data-testid="watcher-strip">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? 'Hide the watchers' : 'Show the watchers'}
        className="flex items-center gap-1.5 px-1 py-0.5 t-micro text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors max-w-full"
      >
        <Clock3 size={10} className={`shrink-0 ${watchers.some((w) => w.running_since) ? 'text-blue-400' : ''}`} />
        <span className="truncate tabular-nums">{line}</span>
      </button>
      {open && (
        <div className="mt-0.5 mb-1 t-micro">
          {sorted.map((w) => (
            <div key={w.id} className="flex items-center gap-3 px-1 py-1 border-t border-gray-200 dark:border-white/[0.06]">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${w.running_since ? 'bg-blue-400' : w.paused || !w.next_at ? 'bg-gray-400/50' : w.runs[0]?.status === 'failed' ? 'bg-red-400' : 'bg-green-500'}`} />
              <span className="w-24 shrink-0 tabular-nums text-gray-700 dark:text-gray-300">{w.next_at && !w.paused ? whenText(w.next_at, now) : '—'}</span>
              <button type="button" onClick={() => openChat(w.conversation_id)} title={w.task} className="min-w-0 truncate text-left text-gray-800 dark:text-gray-200 hover:underline">
                {w.name}
              </button>
              <span className="flex-1 min-w-0 truncate text-gray-500" title={w.runs[0]?.summary || undefined}>{rowState(w, now)}</span>
              {w.next_at && !w.running_since && (
                <button type="button" className={act} onClick={() => call('watchers_update', { id: w.id, patch: { paused: !w.paused } })}>
                  {w.paused ? 'Resume' : 'Pause'}
                </button>
              )}
              <button
                type="button"
                className={confirming === w.id ? 'text-red-500' : act}
                onClick={() => { if (confirming === w.id) { setConfirming(null); call('watchers_delete', { id: w.id }) } else setConfirming(w.id) }}
              >
                {confirming === w.id ? 'Delete?' : 'Delete'}
              </button>
            </div>
          ))}
          {hints.map((h) => (
            <div key={`hint-${h.id}`} className="flex items-center gap-3 px-1 py-1 border-t border-gray-200 dark:border-white/[0.06] text-gray-500">
              <span className="w-1.5 h-1.5 shrink-0" />
              <span className="w-24 shrink-0 tabular-nums">{h.was_next ? whenText(h.was_next, now) : '—'}</span>
              <span className="min-w-0 truncate">{h.name}</span>
              <span className="flex-1 min-w-0 truncate">ended when LU quit, not caught up</span>
              <button type="button" className={act} onClick={() => call('watchers_dismiss_hint', { id: h.id })}>Dismiss</button>
            </div>
          ))}
          <div className="border-t border-gray-200 dark:border-white/[0.06]" />
        </div>
      )}
    </div>
  )
}
