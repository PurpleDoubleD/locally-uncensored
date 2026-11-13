import { useState } from 'react'
import { RotateCw, Maximize2, X, Globe } from 'lucide-react'
import type { Viewport } from '../../lib/html-preview'
import { HtmlPreviewFrame, ViewportSwitcher } from './HtmlPreviewFrame'
import { usePreviewSource } from './usePreviewSource'

interface Props {
  code: string
  language?: string
  /** Inline under the code block, or filling the modal. */
  variant: 'inline' | 'modal'
  onClose: () => void
  onExpand?: () => void
}

const ICON_BTN =
  'p-1 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-white transition-colors'

/**
 * A page the model wrote, shown like an artifact (B29). It only exists after
 * the user pressed Preview. The page runs its own scripts in a sandbox with an
 * opaque origin and no network; the globe switch opens https for this one page
 * after a second, explicit yes, and closing the preview forgets it.
 */
export function HtmlPreviewPanel({ code, language, variant, onClose, onExpand }: Props) {
  const [viewport, setViewport] = useState<Viewport>('desktop')
  const [reloadKey, setReloadKey] = useState(0)
  const [allowNetwork, setAllowNetwork] = useState(false)
  const [askingNetwork, setAskingNetwork] = useState(false)
  const state = usePreviewSource(code, language, allowNetwork, reloadKey)

  const toggleNetwork = () => {
    if (allowNetwork) setAllowNetwork(false)
    else setAskingNetwork(true)
  }

  return (
    <div className="flex flex-col min-h-0 h-full font-sans" data-testid="html-preview-panel" data-network={allowNetwork ? 'on' : 'off'}>
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-white/[0.03]">
        <ViewportSwitcher viewport={viewport} onChange={setViewport} compact={variant === 'inline'} />
        <div className="flex items-center gap-0.5">
          <button
            onClick={toggleNetwork}
            className={`${ICON_BTN} flex items-center gap-1 t-micro ${allowNetwork ? 'text-emerald-500 dark:text-emerald-400' : ''}`}
            aria-pressed={allowNetwork}
            title={allowNetwork ? 'This page may load from the internet (https). Click to turn off.' : 'This page cannot reach the internet. Click to allow it.'}
            data-testid="html-preview-network"
          >
            <Globe size={12} />
            {allowNetwork ? 'Online' : 'Offline'}
          </button>
          <button onClick={() => setReloadKey((k) => k + 1)} className={ICON_BTN} aria-label="Reload preview" title="Reload preview">
            <RotateCw size={12} />
          </button>
          {onExpand && (
            <button onClick={onExpand} className={ICON_BTN} aria-label="Open large" title="Open large">
              <Maximize2 size={12} />
            </button>
          )}
          <button onClick={onClose} className={ICON_BTN} aria-label="Close preview" title={variant === 'modal' ? 'Close (Esc)' : 'Close preview'}>
            <X size={12} />
          </button>
        </div>
      </div>
      {askingNetwork && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 t-control whitespace-normal text-gray-600 dark:text-gray-300 bg-gray-50 dark:bg-white/[0.04] border-b border-gray-200 dark:border-white/10" data-testid="html-preview-network-ask">
          <span className="flex-1 min-w-[12rem] break-words">
            Let this page load from the internet? It can then fetch scripts and pictures over https and send what it contains to any website. Your computer, LU and local servers stay closed to it.
          </span>
          <button className="px-2 py-0.5 rounded-md border border-gray-300 dark:border-white/15 hover:bg-gray-100 dark:hover:bg-white/10" onClick={() => { setAllowNetwork(true); setAskingNetwork(false) }}>
            Allow for this page
          </button>
          <button className="px-2 py-0.5 rounded-md hover:bg-gray-100 dark:hover:bg-white/10" onClick={() => setAskingNetwork(false)}>
            Keep offline
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-gray-100 dark:bg-black/20 p-2">
        {state.status === 'ready' ? (
          <HtmlPreviewFrame
            src={state.source.kind === 'src' ? state.source.src : undefined}
            doc={state.source.kind === 'doc' ? state.source.doc : undefined}
            viewport={viewport}
            allowScripts
            reloadKey={reloadKey}
          />
        ) : state.status === 'error' ? (
          <p className="t-control text-red-500">The preview could not start: {state.message}</p>
        ) : (
          <p className="t-control text-gray-400">Starting preview…</p>
        )}
      </div>
    </div>
  )
}
