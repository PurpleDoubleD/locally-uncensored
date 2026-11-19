import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useContextBreakdownStore } from '../../stores/contextBreakdownStore'
import { estimateNextStep, layoutBreakdown, withNewerMessages } from '../../lib/context-breakdown'
import { resolveCompactThreshold } from '../../lib/compact-trigger'
import { formatContextWindow } from '../../lib/formatters'

/** A token count in the window's own notation, where 0 is a count, not Auto. */
function tokensText(n: number): string {
  return n > 0 ? formatContextWindow(n) : '0'
}

/**
 * What fills the context window, like Claude Code's /context (U5).
 *
 * Rendered only while the context list is open, so its subscription to the
 * conversation costs nothing while the user types or a run streams.
 *
 * The numbers come from the request the last agent step built
 * (contextBreakdownStore). Without a step, the conversation as stored is
 * estimated and the header says "about". Rows an estimate cannot see (the
 * agent's system prompt, its tools, project files, memory) say so instead of
 * showing a made-up number.
 */
export function ContextBreakdownPanel({
  window,
  modelWindow,
  agent,
}: {
  /** The meter's denominator: what one step may send. */
  window: number
  /** The model's own window, for the auto-compact 32K rule. */
  modelWindow: number
  /** Code tab or Agent mode. */
  agent: boolean
}) {
  const convId = useChatStore((s) => s.activeConversationId)
  const conv = useChatStore((s) => s.conversations.find((c) => c.id === s.activeConversationId))
  const stored = useContextBreakdownStore((s) => (convId ? s.byConv[convId] : undefined))
  // W48 (GitHub #257): the system prompt the last request really carried.
  const sentSystem = useContextBreakdownStore((s) => (convId ? s.systemByConv[convId] : undefined))
  const [showSystem, setShowSystem] = useState(false)
  const autoCompact = useSettingsStore((s) => s.settings.autoCompact)
  const autoCompactThreshold = useSettingsStore((s) => s.settings.autoCompactThreshold)

  if (!(window > 0)) return null

  const breakdown = stored
    ? withNewerMessages(stored, conv?.messages ?? [])
    : { ...estimateNextStep(conv?.messages ?? [], { systemPrompt: conv?.systemPrompt, agent }), since: 0 }
  const threshold = resolveCompactThreshold(
    { autoCompact, autoCompactThreshold },
    window,
    modelWindow > 0 ? modelWindow : window,
  )
  const lay = layoutBreakdown(breakdown, window, threshold)
  const about = breakdown.kind === 'estimate'
  const anyUnknown = breakdown.rows.some((r) => r.unknown)
  const over = breakdown.total > window

  return (
    <section
      data-testid="context-breakdown"
      aria-label="What fills the context window"
      className={`${showSystem ? "w-[22rem]" : "w-60"} max-w-full px-2 pt-1 pb-1.5 flex flex-col gap-1`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="t-label text-gray-400">Context use</span>
        <span data-testid="context-breakdown-total" className="t-micro lu-hud-num text-gray-600 dark:text-gray-300">
          {about ? 'about ' : ''}{tokensText(breakdown.total)} of {formatContextWindow(window)}
        </span>
      </div>

      <div className="relative h-1.5 rounded-full bg-gray-100 dark:bg-white/[0.07] overflow-hidden">
        <div
          className={`h-full rounded-full ${over ? 'bg-red-400' : 'bg-gray-400 dark:bg-gray-400'}`}
          style={{ width: `${lay.usedShare * 100}%` }}
        />
        {lay.thresholdShare !== null && (
          <span
            aria-hidden
            data-testid="context-breakdown-threshold"
            className="absolute top-0 bottom-0 w-px bg-gray-700 dark:bg-gray-200 opacity-60"
            style={{ left: `${lay.thresholdShare * 100}%` }}
          />
        )}
      </div>

      <ul className="flex flex-col gap-0.5 mt-0.5">
        {breakdown.rows.map((r) => (
          <li key={r.key} data-testid={`context-row-${r.key}`} className="grid grid-cols-[1fr_3rem_3.25rem] items-center gap-2 t-micro">
            {r.key === 'system' && sentSystem ? (
              <button
                type="button"
                data-testid="context-system-toggle"
                aria-expanded={showSystem}
                onClick={() => setShowSystem((v) => !v)}
                title={showSystem ? 'Hide the system prompt' : 'Show the system prompt the last request sent'}
                className="flex min-w-0 items-center gap-0.5 text-left text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
              >
                {showSystem ? <ChevronDown size={10} className="shrink-0" /> : <ChevronRight size={10} className="shrink-0" />}
                <span className="truncate">{r.label}</span>
              </button>
            ) : (
              <span className="text-gray-600 dark:text-gray-300 truncate">{r.label}</span>
            )}
            <span className="h-1 rounded-full bg-gray-100 dark:bg-white/[0.07] overflow-hidden">
              <span
                className="block h-full rounded-full bg-gray-400 dark:bg-gray-500"
                style={{ width: r.tokens > 0 ? `max(2px, ${lay.share[r.key] * 100}%)` : '0' }}
              />
            </span>
            <span className={`text-right lu-hud-num ${r.unknown ? 'text-gray-400' : 'text-gray-600 dark:text-gray-300'}`}>
              {r.unknown ? 'not yet' : tokensText(r.tokens)}
            </span>
          </li>
        ))}
        {showSystem && sentSystem && (
          <li data-testid="context-system-text" className="t-micro">
            <span className="block text-gray-400 mb-0.5">
              Sent {new Date(sentSystem.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, exactly as the model got it
            </span>
            {sentSystem.text.trim() ? (
              <pre className="max-h-48 overflow-y-auto scrollbar-thin whitespace-pre-wrap wrap-anywhere select-text font-mono text-[0.55rem] leading-relaxed text-gray-600 dark:text-gray-300">{sentSystem.text}</pre>
            ) : (
              <span className="block text-gray-500">The last request had no system prompt.</span>
            )}
          </li>
        )}
        <li data-testid="context-row-free" className="grid grid-cols-[1fr_3rem_3.25rem] items-center gap-2 t-micro">
          <span className="text-gray-400">Free</span>
          <span className="h-1 rounded-full bg-gray-100 dark:bg-white/[0.07] overflow-hidden">
            <span
              className="block h-full rounded-full bg-gray-200 dark:bg-white/20"
              style={{ width: `${(lay.free / window) * 100}%` }}
            />
          </span>
          <span className="text-right lu-hud-num text-gray-400">{tokensText(lay.free)}</span>
        </li>
      </ul>

      <p className="t-micro text-gray-400 leading-snug">
        {lay.thresholdTokens !== null
          ? `Compacts by itself near ${formatContextWindow(lay.thresholdTokens)}. `
          : ''}
        {about
          ? anyUnknown
            ? 'Estimated from this chat. The rest shows after the first step.'
            : 'Estimated from this chat.'
          : breakdown.since > 0
            ? 'From the last step that was sent, plus the chat since.'
            : 'From the last step that was sent.'}
      </p>
    </section>
  )
}
