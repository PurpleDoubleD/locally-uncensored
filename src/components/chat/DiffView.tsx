import { parseUnifiedDiff, displayPath } from '../../lib/diff'
import { DIFF_TONE, DIFF_LINE_NO, DIFF_ADDED_COUNT, DIFF_REMOVED_COUNT, DIFF_SURFACE, DIFF_HUNK_HEAD } from './diff-tones'

interface Props {
  /** Raw unified-diff string as produced by `computeUnifiedDiff`. */
  diff: string
  /**
   * Cap on rendered lines. Long agent-driven refactors can produce a
   * 2000-line diff that murders chat-scroll perf. Lines past the cap
   * collapse into a "+N more" line.
   */
  maxLines?: number
  /** False where the surrounding card already names the file and shows the
   *  counts (StagedChangesPanel); the path row is then left out. */
  showPath?: boolean
}

/**
 * Tiny syntax-free unified-diff renderer. Designed for the chat surface,
 * not a full code editor — we colour add/remove/context lines and
 * surface the per-hunk header so the user can see where edits landed.
 */
export function DiffView({ diff, maxLines = 200, showPath = true }: Props) {
  if (!diff) return null
  // The ---/+++ lines only repeat the path the row above already shows.
  const parsed = parseUnifiedDiff(diff)
  parsed.lines = parsed.lines.filter((l) => l.kind !== 'header')
  const truncated = parsed.lines.length > maxLines
  const lines = truncated ? parsed.lines.slice(0, maxLines) : parsed.lines
  const hiddenCount = parsed.lines.length - lines.length

  // Light and dark from one palette (diff-tones.ts); it was dark only and
  // grey on grey in the light theme.
  return (
    <div className={`rounded border ${DIFF_SURFACE} overflow-hidden`}>
      {showPath && (parsed.added > 0 || parsed.removed > 0) && (
        <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100 dark:border-white/5 t-mono">
          <span className="text-gray-600 dark:text-gray-400 truncate">{displayPath(parsed.path) || 'diff'}</span>
          <span className="flex gap-2 shrink-0">
            {parsed.added > 0 && <span className={DIFF_ADDED_COUNT}>+{parsed.added}</span>}
            {parsed.removed > 0 && <span className={DIFF_REMOVED_COUNT}>-{parsed.removed}</span>}
          </span>
        </div>
      )}
      <div className="t-mono leading-5 overflow-auto scrollbar-thin max-h-[300px] [font-variant-ligatures:none]">
        <div className="min-w-max">
          {lines.map((l, i) => {
            if (l.kind === 'hunk') {
              return (
                <div key={i} className={`px-2 t-micro border-y border-gray-100 dark:border-white/5 ${DIFF_HUNK_HEAD}`}>
                  {l.text}
                </div>
              )
            }
            const kind = l.kind === 'add' || l.kind === 'remove' ? l.kind : 'context'
            const no = kind === 'remove' ? l.oldLine : l.newLine
            const sign = kind === 'add' ? '+' : kind === 'remove' ? '-' : ' '
            return (
              <div key={i} className={`flex pr-3 ${DIFF_TONE[kind].row}`}>
                <span className={`w-9 shrink-0 select-none pr-2 text-right ${DIFF_LINE_NO}`}>{no}</span>
                <span className={`w-3 shrink-0 select-none ${DIFF_TONE[kind].sign}`}>{sign}</span>
                <span className="whitespace-pre">{l.text || ' '}</span>
              </div>
            )
          })}
          {truncated && (
            <div className="px-2 py-1 t-micro text-gray-500 italic">
              … {hiddenCount} more lines
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
