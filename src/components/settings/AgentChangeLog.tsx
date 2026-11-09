import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useSettingsAuditStore, type SettingsAuditRow } from '../../stores/settingsAuditStore'
import { findEntry } from '../../lib/settings-catalog'
import { readEntry, writeEntry } from '../../lib/settings-stores'
import { sameValue } from '../../lib/settings-catalog'

const OUTCOME: Record<SettingsAuditRow['outcome'], string> = {
  applied: 'changed', declined: 'declined', timeout: 'no answer', refused: 'refused', undone: 'undone', failed: 'failed',
}

const btn = 'flex items-center gap-1 px-2 py-0.5 rounded t-micro text-gray-700 dark:text-gray-300 bg-gray-500/10 hover:bg-gray-500/15 border border-gray-500/20 transition-colors'

function when(at: number): string {
  const d = new Date(at)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * C60 (3.1.0): every change the agent asked for in LU itself, what the user
 * answered, and Undo for a setting that still has the value the agent set.
 * Newest first. Names and shown values only, never a key or token.
 */
export function AgentChangeLog() {
  const rows = useSettingsAuditStore((s) => s.rows)
  const clear = useSettingsAuditStore((s) => s.clear)
  const markUndone = useSettingsAuditStore((s) => s.markUndone)
  const [limit, setLimit] = useState(20)
  if (rows.length === 0) {
    return <p className="t-micro text-gray-500 dark:text-gray-400" data-testid="agent-change-log-empty">The agent has not asked to change anything yet.</p>
  }
  return (
    <div data-testid="agent-change-log" className="space-y-1">
      <ul className="space-y-0.5">
        {rows.slice(0, limit).map((r) => {
          const entry = r.kind === 'setting' ? findEntry(r.key) : undefined
          let canUndo = false
          if (entry && r.outcome === 'applied' && 'rawTo' in r) {
            try { canUndo = sameValue(readEntry(entry), r.rawTo) } catch { canUndo = false }
          }
          return (
            <li key={r.id} data-testid="agent-change-row" data-outcome={r.outcome}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 t-micro text-gray-700 dark:text-gray-300">
              <span className="text-gray-500 dark:text-gray-500 tabular-nums">{when(r.at)}</span>
              <span className="font-medium">{r.label}</span>
              {r.kind === 'setting' && r.from !== '' && <span>{r.from} → {r.to}</span>}
              <span className={r.outcome === 'applied' ? 'text-emerald-600 dark:text-emerald-400' : r.outcome === 'refused' || r.outcome === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-500'}>
                {OUTCOME[r.outcome]}{r.why ? ` (${r.why})` : ''}
              </span>
              {r.tainted && <span className="text-red-600 dark:text-red-400">after reading {r.tainted}</span>}
              {r.model && <span className="text-gray-400 dark:text-gray-500">{r.model}</span>}
              {canUndo && entry && (
                <button type="button" className={btn} data-testid="agent-change-undo"
                  onClick={() => { writeEntry(entry, r.rawFrom); markUndone(r.id) }}>
                  <RotateCcw size={9} /> Undo
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-2 pt-1">
        {rows.length > limit && <button type="button" className={btn} onClick={() => setLimit((l) => l + 50)}>Show more</button>}
        <button type="button" className={btn} onClick={() => clear()}>Clear the list</button>
      </div>
    </div>
  )
}
