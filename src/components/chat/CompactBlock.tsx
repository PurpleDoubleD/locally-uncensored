import { useState } from 'react'
import { ChevronDown, FoldVertical } from 'lucide-react'
import { summarySections } from '../../lib/compact-summary'
import { formatContextWindow } from '../../lib/formatters'
import type { CompactCut } from '../../lib/compact-layers'

interface Props {
  /** The compaction, or nothing while it is still being written. */
  cut?: CompactCut
}

/** Tokens the way the context counter writes them: 28.9K. */
function tokens(n: number): string {
  return n > 0 ? formatContextWindow(Math.round(n)) : '0'
}

/**
 * One compaction in the transcript, as one quiet line (3.0.9).
 *
 * Built like a tool-call row and not like a banner: a compaction is a step
 * the app took, not news. While the summary is written it reads
 * "Compacting conversation…" with the same shimmer as a running tool, after
 * that "Compacted, 28.9K → 17.9K", the payload before and after in the
 * counter's own units. Up to 3.0.8 it was a pill between two rules plus a
 * sentence of its own, and in a long Agent run nobody saw either (David,
 * REA-Test 27.10.: 28.9K/32K, then 17.9K, and nothing in the chat).
 *
 * Nothing is deleted or hidden for good: the messages before the line are
 * one layer down (CompactLayerRail). Where the summary is stored (per turn,
 * not in the middle of a run) the line opens to show what was kept, which is
 * the question a compaction really raises.
 */
export function CompactBlock({ cut }: Props) {
  const [open, setOpen] = useState(false)
  const running = !cut
  const sections = cut?.summary ? summarySections(cut.summary) : []
  const canOpen = sections.length > 0

  const label = running
    ? 'Compacting conversation…'
    : `Compacted, ${tokens(cut.before)} → ${tokens(cut.after)}`

  return (
    <div className="px-3 py-1" data-testid={running ? 'compact-running' : 'compact-line'}>
      <button
        type="button"
        onClick={() => canOpen && setOpen((o) => !o)}
        aria-expanded={canOpen ? open : undefined}
        disabled={!canOpen}
        className="flex items-center gap-1.5 py-0.5 text-left enabled:hover:opacity-80 transition-opacity min-w-0"
      >
        <FoldVertical size={10} className="text-gray-500 dark:text-gray-500 shrink-0" />
        <span className={`t-micro italic pr-0.5 ${running ? 'lu-tool-shimmer' : 'text-gray-600 dark:text-gray-400'}`}>
          {label}
        </span>
        {canOpen && (
          <ChevronDown
            size={10}
            className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {open && canOpen && (
        <div className="ml-4 mt-1 pl-2 border-l border-gray-200 dark:border-white/10 space-y-2">
          {sections.map((s) => (
            <div key={s.heading}>
              <div className="t-label text-gray-400 dark:text-gray-600">{s.heading}</div>
              {/* whitespace-pre-wrap: die Zusammenfassung ist Klartext mit
                  eigenen Zeilen und Aufzaehlungen. Sie durch den
                  Markdown-Renderer zu schicken waere falsch — sie kommt
                  aus einem Modell, das gerade NICHT auf Format geprueft
                  wurde, und ein halboffener Codeblock darin wuerde den
                  Rest des Verlaufs mitreissen. */}
              <div className="t-micro whitespace-pre-wrap text-gray-600 dark:text-gray-300 leading-relaxed">
                {s.body}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
