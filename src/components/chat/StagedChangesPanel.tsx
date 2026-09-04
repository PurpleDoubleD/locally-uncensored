import { useState } from 'react'
import { Check, X, ChevronDown, ChevronRight, FileText } from 'lucide-react'
import { useStagedChangesStore, type StagedChange } from '../../stores/stagedChangesStore'
import { applyStagedChange } from '../../lib/staged-apply'
import { DiffView } from './DiffView'
import { log } from '../../lib/logger'
import { HINWEIS_TEXT, HINWEIS_ZEILE } from '../../lib/hinweis'

interface Props {
  /** Active conversation id — the panel scopes itself to this chat. */
  chatId: string | null
}

/**
 * Right-sidebar panel that surfaces Codex's queued `file_write` calls when
 * Stage-and-Approve is on. Each change shows its diff and offers per-row
 * Apply/Reject; the footer offers Apply-all/Reject-all for big refactors.
 *
 * `Apply` calls the same `file_write` tool the executor would have called
 * inline — the bridge sees an identical request, so the diff the user
 * approved is exactly what lands on disk.
 */
// Module-scoped stable empty-array reference. Zustand selectors run on
// every store update; returning a fresh `[]` literal (or any new object)
// trips Object.is and re-renders forever. Reusing one frozen empty array
// keeps the selector output identity-stable when this chat has no
// staged changes yet.
const EMPTY_CHANGES: readonly StagedChange[] = Object.freeze([])

export function StagedChangesPanel({ chatId }: Props) {
  const changes = useStagedChangesStore((s) =>
    chatId ? s.byChat[chatId] ?? EMPTY_CHANGES : EMPTY_CHANGES,
  ) as StagedChange[]
  const remove = useStagedChangesStore((s) => s.remove)
  const clear = useStagedChangesStore((s) => s.clear)
  const [expanded, setExpanded] = useState(true)
  const [applying, setApplying] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

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
      // Shared trusted write path (lib/staged-apply) — the same call Codex
      // auto-apply uses, so the reviewed diff and the auto-applied diff can
      // never diverge.
      await applyStagedChange(chatId, change)
    } catch (e) {
      // Apply failures leave the entry in the queue so the user can retry — and
      // the reason has to reach the row, not just the log. The row simply
      // staying put looked like a dead button (and now that a stale-file apply
      // is REFUSED, the reason is the whole point).
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
      // Sequential on purpose, not an oversight: two changes can touch the same
      // file, and `applyOne` reads-modifies-writes. In parallel the later write
      // would be based on a snapshot taken before the earlier one landed.
      // (Hier stand eine Unterdrueckung der Regel `no-await-in-loop`. Die ist
      //  in KEINER Config dieses Baums eingeschaltet — die Zeile hat nie etwas
      //  unterdrueckt, sie hat nur behauptet, es gaebe ein Gate. Der Grund war
      //  richtig, die Form war eine Luege; der Grund bleibt.)
      await applyOne(change)
    }
  }

  function rejectOne(change: StagedChange) {
    if (!chatId) return
    remove(chatId, change.id)
  }

  function rejectAll() {
    if (!chatId) return
    clear(chatId)
  }

  return (
    // Die Kopfzeile war komplett in Gelb getaucht, Flaeche, Symbole und
    // Schrift. Wartende Aenderungen sind aber kein Zwischenfall, sondern eine
    // Liste, die auf einen Klick wartet: sie traegt jetzt dieselbe neutrale
    // Haut wie die uebrigen Abschnitte der Spalte, und die Zahl daneben ist
    // das Signal (`lib/hinweis.ts`).
    <div className="border-b border-gray-200 dark:border-white/[0.04]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-2 py-1.5 group hover:bg-gray-100/70 dark:hover:bg-white/[0.04] transition-colors"
        data-testid="staged-changes-header"
      >
        <span className="flex items-center gap-1.5">
          {expanded ? (
            <ChevronDown size={11} className="text-gray-500 dark:text-gray-400" />
          ) : (
            <ChevronRight size={11} className="text-gray-500 dark:text-gray-400" />
          )}
          <FileText size={10} className="text-gray-500 dark:text-gray-400" />
          <span className="t-micro font-semibold text-gray-800 dark:text-gray-200">
            Pending ({changes.length})
          </span>
        </span>
      </button>

      {expanded && (
        <div className="px-1.5 pb-2 space-y-1.5">
          {changes.map((change) => {
            const isApplying = applying.has(change.id)
            return (
              <div
                key={change.id}
                className="rounded border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-black/20"
                data-testid="staged-change"
              >
                <div className="flex items-center justify-between gap-1 px-1.5 py-1 border-b border-gray-100 dark:border-white/[0.04]">
                  <span
                    className="text-[0.55rem] font-mono truncate text-gray-700 dark:text-gray-300"
                    title={change.path}
                  >
                    {change.path}
                  </span>
                  <span className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={() => applyOne(change)}
                      disabled={isApplying}
                      title="Apply"
                      className="p-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-500/20 text-emerald-600 disabled:opacity-50"
                    >
                      <Check size={10} />
                    </button>
                    <button
                      onClick={() => rejectOne(change)}
                      disabled={isApplying}
                      title="Reject"
                      className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-500/20 text-red-500 disabled:opacity-50"
                    >
                      <X size={10} />
                    </button>
                  </span>
                </div>
                {errors[change.id] && (
                  // Eine Zeile Rot, keine rote Flaeche: der Grund muss lesbar
                  // sein, nicht laut. Die Farbe traegt die Dringlichkeit.
                  // Die Zeile baut sich hier selbst, statt <Hinweis> zu nehmen,
                  // weil sie ihre Testmarke behaelt und ins Kaestchen der
                  // Aenderung eingerueckt sitzt; die Klassen kommen trotzdem
                  // aus der einen Regel.
                  <div
                    role="alert"
                    className={`px-1.5 py-1 ${HINWEIS_ZEILE} ${HINWEIS_TEXT.fehler}`}
                    data-testid="staged-change-error"
                  >
                    {errors[change.id]}
                  </div>
                )}
                {change.diff && (
                  <div className="text-[0.5rem]">
                    <DiffView diff={change.diff} maxLines={40} />
                  </div>
                )}
              </div>
            )
          })}

          <div className="flex items-center gap-1 pt-0.5">
            <button
              onClick={applyAll}
              className="flex-1 px-1.5 py-1 rounded-md text-[0.55rem] font-medium bg-emerald-500 hover:bg-emerald-600 text-white transition-colors"
              data-testid="apply-all"
            >
              Apply all
            </button>
            <button
              onClick={rejectAll}
              className="flex-1 px-1.5 py-1 rounded-md text-[0.55rem] font-medium bg-gray-200 dark:bg-white/10 hover:bg-gray-300 dark:hover:bg-white/15 text-gray-800 dark:text-gray-200 transition-colors"
              data-testid="reject-all"
            >
              Reject all
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
