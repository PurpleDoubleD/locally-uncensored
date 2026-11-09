// The user's hand on the LU browser (P-L, 3.1.0): under a browser tool call,
// Take over / Hand back / Close, and the screenshot a browser_screenshot took.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Hand, RotateCcw, X } from 'lucide-react'
import { browserControl, browserShotFor, onBrowserShot } from '../../lib/browser-tools'

const btn = 'flex items-center gap-1 px-2 py-0.5 rounded t-micro font-medium text-gray-700 dark:text-gray-300 bg-gray-500/10 hover:bg-gray-500/15 border border-gray-500/20 transition-colors'

export function BrowserControls({ live }: { live: boolean }) {
  const [state, setState] = useState<{ open: boolean; userHasControl?: boolean } | null>(null)
  useEffect(() => {
    let alive = true
    browserControl('status').then((s) => { if (alive) setState(s) }).catch(() => {})
    return () => { alive = false }
  }, [live])
  if (!state?.open) return null
  const act = (a: 'take_over' | 'hand_back' | 'close') => (e: React.MouseEvent) => {
    e.stopPropagation()
    browserControl(a).then(setState).catch(() => {})
  }
  return (
    <div data-testid="browser-controls" className="mt-1 mb-1 flex flex-wrap items-center gap-1.5">
      <span className="t-micro text-gray-500 dark:text-gray-400">
        {state.userHasControl ? 'You have the LU browser.' : 'The agent is reading in the LU browser.'}
      </span>
      {state.userHasControl
        ? <button type="button" data-testid="browser-hand-back" className={btn} onClick={act('hand_back')}><RotateCcw size={10} /> Hand back</button>
        : <button type="button" data-testid="browser-take-over" className={btn} onClick={act('take_over')}><Hand size={10} /> Take over</button>}
      <button type="button" data-testid="browser-close" className={btn} onClick={act('close')}><X size={10} /> Close browser</button>
    </div>
  )
}

export function BrowserShot({ toolCallId }: { toolCallId: string }) {
  const src = useSyncExternalStore(onBrowserShot, () => browserShotFor(toolCallId))
  if (!src) return null
  return (
    <img
      data-testid="browser-shot"
      src={src}
      alt="Screenshot of the LU browser"
      className="mt-1 mb-1.5 max-w-xl w-full rounded-lg border border-gray-200 dark:border-white/[0.1]"
    />
  )
}
