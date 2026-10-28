import { useEffect, useMemo, useState } from 'react'
import { Layers } from 'lucide-react'
import { compactCuts, layerItems, type CompactCut, type LayerItem } from '../../lib/compact-layers'
import { formatContextWindow } from '../../lib/formatters'
import { useRunActivityStore } from '../../stores/runActivityStore'
import type { Conversation } from '../../types/chat'

export interface CompactLayerView {
  cuts: CompactCut[]
  /** The layer on screen, null for the current one. */
  layer: number | null
  setLayer: (layer: number | null) => void
  items: LayerItem[]
  /** A summary for this chat is being written right now. */
  compacting: boolean
}

/**
 * The layer state of one transcript, shared by Chat/Agent (MessageList) and
 * Code (CodexView). A layer is a reading position, not chat data: it is not
 * stored, starts at the current view for every chat opened, and goes back
 * there when the user sends (`resumeKey`, the newest user message).
 */
export function useCompactLayers(conversation: Conversation | undefined, resumeKey: unknown): CompactLayerView {
  const messages = conversation?.messages
  const compactions = conversation?.compactions
  const cuts = useMemo(() => compactCuts(messages ?? [], compactions), [messages, compactions])

  const [state, setState] = useState<{ id: string | undefined; key: unknown; layer: number | null }>({
    id: conversation?.id, key: resumeKey, layer: null,
  })
  // Another chat, or a new message from the user: back to the current view.
  // React's "adjust state when a prop changes" shape, as MessageList's gate.
  if (state.id !== conversation?.id || state.key !== resumeKey) {
    setState({ id: conversation?.id, key: resumeKey, layer: null })
  }
  const layer = state.layer !== null && state.layer < cuts.length ? state.layer : null

  const items = useMemo(() => layerItems(messages ?? [], cuts, layer), [messages, cuts, layer])
  const compacting = useRunActivityStore((s) =>
    conversation ? s.activity[conversation.id]?.kind === 'compacting' : false,
  )

  return {
    cuts,
    layer,
    setLayer: (next) => setState((s) => ({ ...s, layer: next })),
    items,
    compacting,
  }
}

function when(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function layerTitle(cut: CompactCut, index: number): string {
  return `Before compaction ${index + 1} · ${formatContextWindow(Math.round(cut.before))} → ${formatContextWindow(Math.round(cut.after))} · ${when(cut.at)}`
}

/**
 * The layers, left of the transcript and vertically centred, as in the Claude
 * Code desktop app: one bar per compaction plus the current view at the
 * bottom. A bar opens the transcript as it stood right before that compaction,
 * read only; the bottom bar, the icon or Esc go back.
 */
export function CompactLayerRail({ view }: { view: CompactLayerView }) {
  const { cuts, layer, setLayer } = view

  useEffect(() => {
    if (layer === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLayer(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer, setLayer])

  if (cuts.length === 0) return null

  const bar = (active: boolean) =>
    `block h-[3px] rounded-full transition-[width,background-color] ${
      active
        ? 'w-4 bg-gray-700 dark:bg-gray-200'
        : 'w-2.5 bg-gray-300 dark:bg-white/20 group-hover:w-3.5 group-hover:bg-gray-500 dark:group-hover:bg-white/50'
    }`

  return (
    <nav
      aria-label="Compact layers"
      data-testid="compact-layers"
      className="absolute left-1.5 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1"
    >
      <button
        type="button"
        onClick={() => setLayer(layer === null ? cuts.length - 1 : null)}
        title={layer === null ? 'Show the conversation before the last compaction' : 'Back to the current conversation'}
        aria-label={layer === null ? 'Show the conversation before the last compaction' : 'Back to the current conversation'}
        className={`p-1 rounded transition-colors ${
          layer === null
            ? 'text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200'
            : 'text-gray-800 dark:text-gray-100'
        }`}
      >
        <Layers size={13} />
      </button>
      {cuts.map((cut, i) => (
        <button
          key={cut.key}
          type="button"
          onClick={() => setLayer(i)}
          title={layerTitle(cut, i)}
          aria-label={layerTitle(cut, i)}
          aria-current={layer === i ? 'true' : undefined}
          data-testid="compact-layer"
          className="group px-1 py-[3px] flex justify-center"
        >
          <span className={bar(layer === i)} />
        </button>
      ))}
      <button
        type="button"
        onClick={() => setLayer(null)}
        title="Current conversation"
        aria-label="Current conversation"
        aria-current={layer === null ? 'true' : undefined}
        data-testid="compact-layer-current"
        className="group px-1 py-[3px] flex justify-center"
      >
        <span className={bar(layer === null)} />
      </button>
    </nav>
  )
}

/** Above a transcript showing an earlier layer: which one, and the way back.
 *  Outside the scroll area, so it stays put and the top fade does not eat it. */
export function CompactLayerBanner({ view }: { view: CompactLayerView }) {
  const { cuts, layer, setLayer } = view
  if (layer === null) return null
  const cut = cuts[layer]
  return (
    <div
      data-testid="compact-layer-banner"
      className="shrink-0 mx-auto mt-2 mb-1 w-[calc(100%-1.5rem)] max-w-xl flex items-center gap-2 rounded border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.04] px-2.5 py-1"
    >
      <Layers size={11} className="text-gray-500 shrink-0" />
      <span className="t-micro text-gray-600 dark:text-gray-300 min-w-0 truncate">
        Before compaction {layer + 1} of {cuts.length}
        {cut ? ` · ${formatContextWindow(Math.round(cut.before))} · ${when(cut.at)}` : ''} · read only
      </span>
      <button
        type="button"
        onClick={() => setLayer(null)}
        className="ml-auto t-micro text-gray-700 dark:text-gray-200 underline underline-offset-2 hover:opacity-80 shrink-0"
      >
        Back to current
      </button>
    </div>
  )
}
