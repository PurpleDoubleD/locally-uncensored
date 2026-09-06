import { parseUnifiedDiff } from '../../lib/diff'

interface Props {
  /** Raw unified-diff string as produced by `computeUnifiedDiff`. */
  diff: string
  /**
   * Cap on rendered lines. Long agent-driven refactors can produce a
   * 2000-line diff that murders chat-scroll perf. Lines past the cap
   * collapse into a "+N more" line.
   */
  maxLines?: number
}

/**
 * Tiny syntax-free unified-diff renderer. Designed for the chat surface,
 * not a full code editor — we colour add/remove/context lines and
 * surface the per-hunk header so the user can see where edits landed.
 */
export function DiffView({ diff, maxLines = 200 }: Props) {
  if (!diff) return null
  const parsed = parseUnifiedDiff(diff)
  const truncated = parsed.lines.length > maxLines
  const lines = truncated ? parsed.lines.slice(0, maxLines) : parsed.lines
  const hiddenCount = parsed.lines.length - lines.length

  return (
    <div className="rounded border border-white/10 bg-black/30 overflow-hidden">
      {(parsed.added > 0 || parsed.removed > 0) && (
        <div className="flex items-center justify-between px-2 py-1 border-b border-white/5 text-[0.55rem] font-mono">
          <span className="text-gray-500 truncate">{parsed.path || 'diff'}</span>
          <span className="flex gap-2 shrink-0">
            {parsed.added > 0 && (
              <span className="text-emerald-400">+{parsed.added}</span>
            )}
            {parsed.removed > 0 && (
              <span className="text-red-400">-{parsed.removed}</span>
            )}
          </span>
        </div>
      )}
      <pre className="t-micro leading-relaxed font-mono overflow-auto scrollbar-thin max-h-[300px]">
        {lines.map((l, i) => {
          if (l.kind === 'header') {
            return (
              <div key={i} className="px-2 text-gray-600">
                {l.text}
              </div>
            )
          }
          if (l.kind === 'hunk') {
            return (
              <div
                key={i}
                className="px-2 bg-blue-500/5 text-blue-300/70 border-y border-white/5"
              >
                {l.text}
              </div>
            )
          }
          if (l.kind === 'add') {
            return (
              <div key={i} className="px-2 bg-emerald-500/10 text-emerald-200">
                {l.newLine !== undefined && (
                  <span className="inline-block w-8 text-right pr-2 text-emerald-500/50">
                    {l.newLine}
                  </span>
                )}
                <span>{`+${l.text}`}</span>
              </div>
            )
          }
          if (l.kind === 'remove') {
            return (
              <div key={i} className="px-2 bg-red-500/10 text-red-200">
                {l.oldLine !== undefined && (
                  <span className="inline-block w-8 text-right pr-2 text-red-500/50">
                    {l.oldLine}
                  </span>
                )}
                <span>{`-${l.text}`}</span>
              </div>
            )
          }
          // context
          return (
            <div key={i} className="px-2 text-gray-400">
              {l.newLine !== undefined && (
                <span className="inline-block w-8 text-right pr-2 text-gray-700">
                  {l.newLine}
                </span>
              )}
              <span>{` ${l.text}`}</span>
            </div>
          )
        })}
        {truncated && (
          <div className="px-2 py-1 text-gray-600 italic">
            … {hiddenCount} more lines
          </div>
        )}
      </pre>
    </div>
  )
}
