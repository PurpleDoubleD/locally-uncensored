// The sources of a web tool under its call, and the question in front of an
// address the model made up (P-L, 3.1.0). Both come from the tool, never from
// what the model writes (lib/web-evidence.ts, lib/web-url-provenance.ts).

import { AlertTriangle, Check, ExternalLink, Link2, X } from 'lucide-react'
import { openExternal } from '../../api/backend'
import type { SourceCard } from '../../lib/web-evidence'
import { useWebUrlConfirmStore, type WebUrlRequest } from '../../stores/webUrlConfirmStore'

const box = 'mt-1 mb-1.5 max-w-xl rounded-lg border border-gray-200 dark:border-white/[0.1] bg-gray-50 dark:bg-white/[0.03]'
const btnYes = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors'
const btnNo = 'flex items-center gap-1 px-2.5 py-1 rounded t-micro font-medium text-gray-700 dark:text-gray-300 bg-gray-500/10 hover:bg-gray-500/15 border border-gray-500/20 transition-colors'

const VIA_WORD: Record<string, string> = {
  local: 'read',
  'exa-reader': 'read via Exa',
  browser: 'browser',
  'search-snippet': 'snippet only',
}

export function WebSourceCards({ cards }: { cards: SourceCard[] }) {
  if (cards.length === 0) return null
  return (
    <ol data-testid="web-source-cards" aria-label="Sources" className="mt-1 mb-1.5 flex flex-wrap gap-1.5 max-w-2xl">
      {cards.map((c) => (
        <li key={`${c.n}-${c.url}`}>
          <button
            type="button"
            data-testid="web-source-card"
            title={c.url}
            onClick={(e) => { e.stopPropagation(); void openExternal(c.url) }}
            className="group flex items-center gap-1.5 max-w-[16rem] px-2 py-1 rounded-md border border-gray-200 dark:border-white/[0.1] bg-white dark:bg-white/[0.03] hover:border-gray-300 dark:hover:border-white/20 text-left transition-colors"
          >
            <span className="shrink-0 t-micro font-semibold text-gray-500 dark:text-gray-400 tabular-nums">[{c.n}]</span>
            <span className="min-w-0">
              <span className="block truncate t-micro font-medium text-gray-800 dark:text-gray-200">{c.title}</span>
              <span className="block truncate t-micro text-gray-500 dark:text-gray-400">
                {c.domain}{c.via !== 'local' ? ` · ${VIA_WORD[c.via] ?? c.via}` : ''}
              </span>
            </span>
            {c.suspect
              ? <AlertTriangle size={11} className="shrink-0 text-red-500" aria-label="This page contains text addressed to an AI" />
              : <ExternalLink size={10} className="shrink-0 text-gray-400 opacity-0 group-hover:opacity-100" />}
          </button>
        </li>
      ))}
    </ol>
  )
}

export function WebUrlAsk({ req }: { req: WebUrlRequest }) {
  const answer = useWebUrlConfirmStore((s) => s.answer)
  return (
    <div role="group" aria-label="Open a web address" data-testid="web-url-ask" className={`${box} px-3 py-2.5`}>
      <div className="flex items-center gap-1.5">
        <Link2 size={13} className="shrink-0 text-gray-500 dark:text-gray-400" />
        <p className="t-body font-medium text-gray-900 dark:text-gray-100">Open this address?</p>
      </div>
      <p className="mt-1 t-body break-all text-gray-900 dark:text-gray-100" data-testid="web-url-ask-url">{req.url}</p>
      <p className="mt-0.5 t-micro text-gray-600 dark:text-gray-400">{req.reason}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <button type="button" data-testid="web-url-allow" className={btnYes}
          onClick={(e) => { e.stopPropagation(); answer(req.id, true) }}>
          <Check size={10} /> Open
        </button>
        <button type="button" data-testid="web-url-deny" className={btnNo}
          onClick={(e) => { e.stopPropagation(); answer(req.id, false) }}>
          <X size={10} /> Don't open
        </button>
      </div>
    </div>
  )
}
