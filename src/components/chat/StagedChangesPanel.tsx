import { useMemo, useState } from 'react'
import { Check, X, ChevronDown, ChevronRight, FileText, Undo2 } from 'lucide-react'
import { useStagedChangesStore, type StagedChange } from '../../stores/stagedChangesStore'
import { applyStagedChange, rejectStagedChange, rejectAllStagedChanges } from '../../lib/staged-apply'
import { displayPath } from '../../lib/diff'
import { buildHunks, type Hunk, type HunkLine } from '../../lib/hunks'
import { log } from '../../lib/logger'
import { HINWEIS_TEXT, HINWEIS_ZEILE } from '../../lib/hinweis'
import { DIFF_TONE, DIFF_LINE_NO, DIFF_ADDED_COUNT, DIFF_REMOVED_COUNT, DIFF_SURFACE, DIFF_HUNK_HEAD } from './diff-tones'

interface Props {
  /** Active conversation id — the panel scopes itself to this chat. */
  chatId: string | null
}

/**
 * The review of Codex's staged `file_write` / `file_edit` calls (Ask mode),
 * at the top of the Code transcript.
 *
 * Review like an editor does it: every hunk of a file can be accepted or
 * rejected on its own, a file as a whole, or everything at once. Applying a
 * file writes the original with only the accepted hunks in (lib/hunks), and
 * the model hears at its next tool result what was left out
 * (hooks/codex/staged-writes.ts).
 *
 * `Apply` goes through the shared trusted write path (lib/staged-apply), the
 * same call Codex auto-apply uses, so the diff the user approved is what
 * lands on disk.
 */
// Module-scoped stable empty-array reference. Zustand selectors run on
// every store update; returning a fresh `[]` literal (or any new object)
// trips Object.is and re-renders forever. Reusing one frozen empty array
// keeps the selector output identity-stable when this chat has no
// staged changes yet.
const EMPTY_CHANGES: readonly StagedChange[] = Object.freeze([])

/** Lines drawn per file before "Show more". A 2000 line rewrite would
 *  otherwise stall the transcript. */
const MAX_LINES_PER_FILE = 160

/** A phone width starts closed: the open list would push the transcript
 *  off the screen (375 px shot, 3.1.0 review). */
function startsOpen(): boolean {
  try {
    return !(typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches)
  } catch {
    return true
  }
}

// The hunk buttons show on hover where there is hover and room; on touch and
// narrow screens there is no hover, so they stay visible.
const HOVER_ONLY =
  '[@media(hover:hover)_and_(min-width:640px)]:opacity-0 ' +
  '[@media(hover:hover)_and_(min-width:640px)]:group-hover/hunk:opacity-100 ' +
  '[@media(hover:hover)_and_(min-width:640px)]:group-focus-within/hunk:opacity-100'

export function StagedChangesPanel({ chatId }: Props) {
  const changes = useStagedChangesStore((s) =>
    chatId ? s.byChat[chatId] ?? EMPTY_CHANGES : EMPTY_CHANGES,
  ) as StagedChange[]
  const [expanded, setExpanded] = useState(startsOpen)
  const [applying, setApplying] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const totals = useMemo(() => {
    let added = 0
    let removed = 0
    for (const c of changes) {
      for (const h of buildHunks(c.oldContent ?? '', c.newContent).hunks) {
        added += h.added
        removed += h.removed
      }
    }
    return { added, removed }
  }, [changes])

  if (!chatId || changes.length === 0) return null

  async function applyOne(change: StagedChange) {
    if (!chatId) return
    setApplying((prev) => new Set(prev).add(change.id))
    setErrors((prev) => {
      if (!(change.id in prev)) return prev
      const { [change.id]: _gone, ...rest } = prev
      return rest
    })
    try {
      await applyStagedChange(chatId, change)
    } catch (e) {
      // Apply failures leave the entry in the queue so the user can retry, and
      // the reason has to reach the row, not just the log. A stale-file apply
      // is REFUSED, and the reason is the whole point.
      log.error('[StagedChangesPanel] apply failed', { err: e })
      const message = e instanceof Error ? e.message : String(e)
      setErrors((prev) => ({ ...prev, [change.id]: message }))
    } finally {
      setApplying((prev) => {
        const next = new Set(prev)
        next.delete(change.id)
        return next
      })
    }
  }

  async function applyAll() {
    if (!chatId) return
    for (const change of [...changes]) {
      // Sequential on purpose: two changes can touch the same file, and
      // `applyOne` reads-modifies-writes. In parallel the later write would be
      // based on a snapshot taken before the earlier one landed.
      await applyOne(change)
    }
  }

  function rejectOne(change: StagedChange) {
    if (!chatId) return
    rejectStagedChange(chatId, change)
  }

  function rejectAll() {
    if (!chatId) return
    rejectAllStagedChanges(chatId)
  }

  /** A hunk decided. Once every hunk of the file is, the file is done: all
   *  rejected drops it, anything accepted writes it with the rejects left out. */
  function decide(change: StagedChange, hunk: number, decision: 'accepted' | 'rejected' | null) {
    if (!chatId) return
    const store = useStagedChangesStore.getState()
    store.decideHunk(chatId, change.id, hunk, decision)
    if (!decision) return
    const latest = store.get(chatId, change.id)
    if (!latest) return
    const hunks = buildHunks(latest.oldContent ?? '', latest.newContent).hunks
    const d = latest.hunkDecisions ?? {}
    if (!hunks.every((h) => d[h.index])) return
    if (hunks.every((h) => d[h.index] === 'rejected')) rejectOne(latest)
    else void applyOne(latest)
  }

  const count = changes.length
  return (
    // Neutral skin like the other sections of the column; the count is the
    // signal (`lib/hinweis.ts`).
    <div className="shrink-0 border-b border-gray-200 dark:border-white/[0.04]" data-testid="staged-changes-panel">
      {/* One line, open or closed: what waits, Review, Reject all, Apply all.
          Apply all and Reject all live here and not under the list, so they
          never scroll away with the diffs (t14 on the box, 2026-09-06). */}
      <div className="flex items-center gap-1 px-2 py-1" data-testid="staged-changes-header">
        <button
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-0.5 text-left hover:bg-gray-100/70 dark:hover:bg-white/[0.04] transition-colors"
          data-testid="staged-changes-toggle"
        >
          {expanded ? (
            <ChevronDown size={12} className="shrink-0 hidden sm:block text-gray-500 dark:text-gray-400" />
          ) : (
            <ChevronRight size={12} className="shrink-0 hidden sm:block text-gray-500 dark:text-gray-400" />
          )}
          <FileText size={12} className="shrink-0 hidden sm:block text-gray-500 dark:text-gray-400" />
          <span className="t-micro font-semibold truncate text-gray-800 dark:text-gray-200">
            {count} {count === 1 ? 'change' : 'changes'} waiting
          </span>
          <span className="t-mono shrink-0 hidden sm:inline">
            {totals.added > 0 && <span className={DIFF_ADDED_COUNT}>+{totals.added}</span>}
            {totals.removed > 0 && <span className={`${DIFF_REMOVED_COUNT} pl-1`}>-{totals.removed}</span>}
          </span>
        </button>
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 px-1.5 py-1 rounded t-micro font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-white dark:hover:bg-white/[0.06] transition-colors"
          data-testid="staged-changes-review"
        >
          {expanded ? 'Hide' : 'Review'}
        </button>
        <button
          onClick={rejectAll}
          title="Reject all"
          aria-label="Reject all"
          // Closed on a phone the bar is "N changes waiting, Review, Apply all";
          // Reject all joins once the list is open.
          className={`shrink-0 items-center gap-1 px-1.5 py-1 rounded t-micro font-medium text-gray-600 ${expanded ? 'flex' : 'hidden sm:flex'} hover:text-red-700 hover:bg-red-50 dark:text-gray-300 dark:hover:text-red-300 dark:hover:bg-red-500/10 transition-colors`}
          data-testid="reject-all"
        >
          <X size={12} />
          <span className="hidden sm:inline">Reject all</span>
        </button>
        <button
          onClick={applyAll}
          className="shrink-0 px-2 py-1 rounded-md t-micro font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
          data-testid="apply-all"
        >
          Apply all
        </button>
      </div>

      {/* The list scrolls inside a cap. Without it two staged files with
          long diffs took the whole column and the shell approval card below
          sat behind the composer (t10 on the box, 2026-09-06). With the
          header line the panel stays under ~40 % of the window. */}
      {expanded && (
        <div className="px-1.5 pb-2 space-y-1.5 max-h-[30vh] sm:max-h-[36vh] overflow-y-auto scrollbar-thin" data-testid="staged-changes-list">
          {changes.map((change) => (
            <StagedFile
              key={change.id}
              change={change}
              busy={applying.has(change.id)}
              error={errors[change.id]}
              onAccept={() => applyOne(change)}
              onReject={() => rejectOne(change)}
              onDecide={(hunk, d) => decide(change, hunk, d)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function StagedFile({ change, busy, error, onAccept, onReject, onDecide }: {
  change: StagedChange
  busy: boolean
  error?: string
  onAccept: () => void
  onReject: () => void
  onDecide: (hunk: number, decision: 'accepted' | 'rejected' | null) => void
}) {
  const hunks = useMemo(() => buildHunks(change.oldContent ?? '', change.newContent).hunks, [change.oldContent, change.newContent])
  const [showAll, setShowAll] = useState(false)
  const decisions = change.hunkDecisions ?? {}
  const added = hunks.reduce((a, h) => a + h.added, 0)
  const removed = hunks.reduce((a, h) => a + h.removed, 0)
  const rejected = hunks.filter((h) => decisions[h.index] === 'rejected').length

  // Hunks up to the line cap; the rest behind "Show more".
  let budget = MAX_LINES_PER_FILE
  const visible: Hunk[] = []
  for (const h of hunks) {
    if (!showAll && visible.length > 0 && budget - h.lines.length < 0) break
    visible.push(h)
    budget -= h.lines.length
  }
  const hiddenParts = hunks.length - visible.length

  return (
    <div className={`rounded border ${DIFF_SURFACE} overflow-hidden`} data-testid="staged-change">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-gray-100 dark:border-white/[0.06]">
        <span className="t-mono min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200" title={change.path}>
          {displayPath(change.path)}
        </span>
        {/* On a phone the path needs the room; the header line has the totals. */}
        <span className="t-mono shrink-0 hidden sm:inline">
          {added > 0 && <span className={DIFF_ADDED_COUNT}>+{added}</span>}
          {removed > 0 && <span className={`${DIFF_REMOVED_COUNT} pl-1`}>-{removed}</span>}
        </span>
        {rejected > 0 && (
          <span className="t-micro shrink-0 hidden sm:inline text-gray-500 dark:text-gray-400" data-testid="staged-change-rejected-count">
            {rejected} of {hunks.length} rejected
          </span>
        )}
        <button
          onClick={onReject}
          disabled={busy}
          title="Reject file"
          aria-label={`Reject ${displayPath(change.path)}`}
          className="shrink-0 p-1 rounded text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/15 disabled:opacity-50"
          data-testid="staged-change-reject"
        >
          <X size={13} />
        </button>
        <button
          onClick={onAccept}
          disabled={busy}
          title={rejected > 0 ? 'Apply the rest' : 'Accept file'}
          aria-label={`Accept ${displayPath(change.path)}`}
          className="shrink-0 p-1 rounded text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/15 disabled:opacity-50"
          data-testid="staged-change-accept"
        >
          <Check size={13} />
        </button>
      </div>
      {error && (
        // One line of red, no red block: the reason must be readable, not loud.
        <div role="alert" className={`px-2 py-1 ${HINWEIS_ZEILE} ${HINWEIS_TEXT.fehler}`} data-testid="staged-change-error">
          {error}
        </div>
      )}
      {hunks.length === 0 && (
        <div className="px-2 py-1 t-micro text-gray-500 dark:text-gray-400">No visible change (line endings only).</div>
      )}
      {visible.map((h) => (
        <HunkBlock
          key={h.index}
          hunk={h}
          single={hunks.length === 1}
          decision={decisions[h.index]}
          busy={busy}
          onDecide={(d) => onDecide(h.index, d)}
        />
      ))}
      {hiddenParts > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full px-2 py-1 t-micro text-left text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 border-t border-gray-100 dark:border-white/[0.06]"
        >
          Show {hiddenParts} more {hiddenParts === 1 ? 'part' : 'parts'}
        </button>
      )}
    </div>
  )
}

function hunkLabel(h: Hunk): string {
  const [start, n] = h.newCount > 0 ? [h.newStart, h.newCount] : [h.oldStart, h.oldCount]
  return n <= 1 ? `Line ${start}` : `Lines ${start}-${start + n - 1}`
}

function HunkBlock({ hunk, single, decision, busy, onDecide }: {
  hunk: Hunk
  single: boolean
  decision?: 'accepted' | 'rejected'
  busy: boolean
  onDecide: (decision: 'accepted' | 'rejected' | null) => void
}) {
  return (
    <div
      className="group/hunk border-t first:border-t-0 border-gray-100 dark:border-white/[0.06]"
      data-testid="staged-hunk"
      data-decision={decision ?? 'open'}
    >
      <div className={`flex items-center gap-1 px-2 py-0.5 ${DIFF_HUNK_HEAD}`}>
        <span className="t-micro min-w-0 flex-1 truncate">{hunkLabel(hunk)}</span>
        {decision ? (
          <>
            <span className={`t-micro font-medium ${decision === 'rejected' ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
              {decision === 'rejected' ? 'Rejected' : 'Accepted'}
            </span>
            <button
              onClick={() => onDecide(null)}
              disabled={busy}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded t-micro text-gray-600 hover:bg-gray-200/70 dark:text-gray-300 dark:hover:bg-white/10 disabled:opacity-50"
              data-testid="hunk-undo"
            >
              <Undo2 size={11} /> Undo
            </button>
          </>
        ) : (
          <span className={`flex items-center gap-1 transition-opacity ${HOVER_ONLY}`}>
            <button
              onClick={() => onDecide('rejected')}
              disabled={busy}
              aria-label={single ? 'Reject this change' : `Reject ${hunkLabel(hunk).toLowerCase()}`}
              className="px-1.5 py-0.5 rounded t-micro font-medium text-red-700 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-500/15 disabled:opacity-50"
              data-testid="hunk-reject"
            >
              Reject
            </button>
            <button
              onClick={() => onDecide('accepted')}
              disabled={busy}
              aria-label={single ? 'Accept this change' : `Accept ${hunkLabel(hunk).toLowerCase()}`}
              className="px-1.5 py-0.5 rounded t-micro font-medium text-emerald-800 bg-emerald-100 hover:bg-emerald-200 dark:text-emerald-200 dark:bg-emerald-500/15 dark:hover:bg-emerald-500/25 disabled:opacity-50"
              data-testid="hunk-accept"
            >
              Accept
            </button>
          </span>
        )}
      </div>
      {/* A decided hunk folds to its line, so the list gets shorter as the
          review goes on. Undo opens it again. */}
      {!decision && (
        <div className="overflow-x-auto scrollbar-thin">
          {/* No ligatures: in a diff "=>" has to read as the two characters it is. */}
          <div className="t-mono leading-5 min-w-max py-0.5 [font-variant-ligatures:none]">
            {hunk.lines.map((l, i) => <DiffRow key={i} line={l} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function DiffRow({ line }: { line: HunkLine }) {
  const tone = DIFF_TONE[line.kind]
  const no = line.kind === 'remove' ? line.oldLine : line.newLine
  const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
  return (
    <div className={`flex pr-3 ${tone.row}`} data-kind={line.kind}>
      <span className={`w-9 shrink-0 select-none pr-2 text-right ${DIFF_LINE_NO}`}>{no}</span>
      <span className={`w-3 shrink-0 select-none ${tone.sign}`}>{sign}</span>
      <span className="whitespace-pre">
        {line.text || ' '}
        {line.noNewline && <span className={`pl-2 t-micro ${DIFF_LINE_NO}`}>no newline at end</span>}
      </span>
    </div>
  )
}
