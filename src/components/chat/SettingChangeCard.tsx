import { useState } from 'react'
import { AlertTriangle, Check, RotateCcw, ShieldAlert, SlidersHorizontal, X, Zap } from 'lucide-react'
import { useSettingsConfirmStore, type SettingChangeRequest } from '../../stores/settingsConfirmStore'
import type { SettingChange } from '../../api/mcp/settings-tools'
import type { SelfControlAction } from '../../api/mcp/self-control-defs'
import { findEntry } from '../../lib/settings-catalog'
import { redoSettingChange, settingChangeState, undoSettingChange, useAnyEntryStore } from '../../lib/settings-stores'
import { useModelStore } from '../../stores/modelStore'

const box = 'mt-1 mb-1.5 max-w-xl rounded-lg border border-gray-200 dark:border-white/[0.1] bg-gray-50 dark:bg-white/[0.03]'
// C60: the strong card (local API, phone remote, a download by link) is red.
const boxStrong = 'mt-1 mb-1.5 max-w-xl rounded-lg border border-red-500/40 dark:border-red-400/40 bg-red-500/[0.04] dark:bg-red-400/[0.05]'
const btnYes = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors'
const btnYesStrong = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-red-700 dark:text-red-300 bg-red-500/10 hover:bg-red-500/15 border border-red-500/30 transition-colors'
const btnNo = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-gray-700 dark:text-gray-300 bg-gray-500/10 hover:bg-gray-500/15 border border-gray-500/20 transition-colors'

function FromTo({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <span className="t-body text-gray-900 dark:text-gray-100">
      {label}: <span className="text-gray-500 dark:text-gray-400">{from}</span> → <span className="font-medium">{to}</span>
    </span>
  )
}

/** The line that says the agent read foreign content before it asked (C60 S3). */
function TaintNote({ by }: { by: string }) {
  return (
    <p data-testid="setting-change-taint" className="mt-1 flex items-start gap-1 t-micro text-red-700 dark:text-red-300">
      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
      <span>The agent read {by} before it asked. Only accept if you asked for this yourself.</span>
    </p>
  )
}

/** A11 / C60: the question in front of a change LU makes to itself. Only a
 *  click applies it, also in Bypass. Drawn from the structured request, never
 *  from text the model wrote. */
export function SettingChangeAsk({ req }: { req: SettingChangeRequest }) {
  const answer = useSettingsConfirmStore((s) => s.answer)
  const items = req.items ?? null
  const [ticked, setTicked] = useState<string[]>(() => (items ?? []).map((i) => i.key))
  const strong = req.risk === 'strong'
  const Icon = strong ? ShieldAlert : req.action ? Zap : SlidersHorizontal
  const title = req.action
    ? req.action.title
    : items ? (items.length === 1 ? 'Change this setting?' : `Change these ${items.length} settings?`) : 'Change this setting?'
  return (
    <div role="group" aria-label={req.action ? 'Confirm an action of LU' : 'Change an app setting'} data-testid="setting-change-ask"
      data-risk={strong ? 'strong' : 'card'} className={`${strong ? boxStrong : box} px-3 py-2.5`}>
      <div className="flex items-center gap-1.5">
        <Icon size={13} className={`shrink-0 ${strong ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`} />
        <p className="t-body font-medium text-gray-900 dark:text-gray-100">{req.action ? `${title}?` : title}</p>
      </div>
      {req.action && (
        <ul className="mt-1 space-y-0.5" data-testid="setting-change-details">
          {req.action.details.map((d) => <li key={d} className="t-micro text-gray-600 dark:text-gray-400">{d}</li>)}
        </ul>
      )}
      {!req.action && !items && (
        <>
          <p className="mt-1" data-testid="setting-change-fromto"><FromTo label={req.label} from={req.from} to={req.to} /></p>
          {req.note && <p className="mt-0.5 t-micro text-gray-600 dark:text-gray-400">{req.note}</p>}
        </>
      )}
      {items && (
        <ul className="mt-1 space-y-1" data-testid="setting-change-items">
          {items.map((i) => (
            <li key={i.key}>
              <label className="flex items-start gap-1.5 cursor-pointer">
                <input type="checkbox" className="mt-1" data-testid={`setting-change-item-${i.key}`} checked={ticked.includes(i.key)}
                  onChange={(e) => setTicked((t) => (e.target.checked ? [...t, i.key] : t.filter((k) => k !== i.key)))} />
                <span>
                  <FromTo label={i.label} from={i.from} to={i.to} />
                  {i.note && <span className="block t-micro text-gray-600 dark:text-gray-400">{i.note}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {strong && req.riskNote && <p className="mt-1 t-micro font-medium text-red-700 dark:text-red-300">{req.riskNote}</p>}
      {req.taintedBy && <TaintNote by={req.taintedBy} />}
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" data-testid="setting-change-accept" className={strong ? btnYesStrong : btnYes}
          disabled={!!items && ticked.length === 0}
          onClick={(e) => { e.stopPropagation(); answer(req.id, true, items ? ticked : undefined) }}>
          <Check size={10} /> {items ? `Accept (${ticked.length})` : 'Accept'}
        </button>
        <button type="button" data-testid="setting-change-decline" className={btnNo}
          onClick={(e) => { e.stopPropagation(); answer(req.id, false) }}>
          <X size={10} /> Decline
        </button>
      </div>
    </div>
  )
}

/** After the yes: the change stays visible with Undo. The state is read from
 *  the setting itself, so the row is right after a restart and after a
 *  change by hand. */
export function SettingChangeDone({ change }: { change: SettingChange }) {
  // Re-render when any store a setting lives in moves.
  useAnyEntryStore()
  const [confirmMoved, setConfirmMoved] = useState(false)
  const entry = findEntry(change.key)
  if (!entry) return null
  const state = settingChangeState(change)
  const from = entry.show(change.from)
  const to = entry.show(change.to)
  return (
    <div data-testid="setting-change-done" data-state={state} className={`${box} px-3 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1`}>
      <SlidersHorizontal size={11} className="shrink-0 text-gray-500 dark:text-gray-400" />
      <FromTo label={entry.label} from={from} to={to} />
      {state === 'applied' && (
        <button type="button" data-testid="setting-change-undo" className={btnNo}
          onClick={(e) => { e.stopPropagation(); undoSettingChange(change) }}>
          <RotateCcw size={10} /> Undo
        </button>
      )}
      {state === 'undone' && (
        <>
          <span className="t-micro text-gray-500 dark:text-gray-400">Undone</span>
          <button type="button" data-testid="setting-change-redo" className={btnNo}
            onClick={(e) => { e.stopPropagation(); redoSettingChange(change) }}>
            Apply again
          </button>
        </>
      )}
      {state === 'moved' && (
        confirmMoved ? (
          <button type="button" data-testid="setting-change-undo-anyway" className={btnNo}
            onClick={(e) => { e.stopPropagation(); undoSettingChange(change); setConfirmMoved(false) }}>
            <RotateCcw size={10} /> Set back to {from} anyway
          </button>
        ) : (
          <>
            <span className="t-micro text-gray-500 dark:text-gray-400">Changed since</span>
            <button type="button" data-testid="setting-change-undo" className={btnNo}
              onClick={(e) => { e.stopPropagation(); setConfirmMoved(true) }}>
              <RotateCcw size={10} /> Undo
            </button>
          </>
        )
      )}
    </div>
  )
}

/** After the yes on an action: what was done, and for a model switch Undo. */
export function SelfControlDone({ action }: { action: SelfControlAction }) {
  const active = useModelStore((s) => s.activeModel)
  const undoable = action.kind === 'model' && !!action.from && active === action.to
  return (
    <div data-testid="self-control-done" className={`${box} px-3 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1`}>
      <Zap size={11} className="shrink-0 text-gray-500 dark:text-gray-400" />
      <span className="t-body text-gray-900 dark:text-gray-100">{action.title}</span>
      {undoable && (
        <button type="button" data-testid="self-control-undo" className={btnNo}
          onClick={(e) => { e.stopPropagation(); if (action.from) useModelStore.getState().setActiveModel(action.from) }}>
          <RotateCcw size={10} /> Back to {action.from}
        </button>
      )}
    </div>
  )
}
