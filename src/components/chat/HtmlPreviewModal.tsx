import { useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ExternalLink, RotateCw } from 'lucide-react'
import { openExternal } from '../../api/backend'
import { buildDocument, type Viewport } from '../../lib/html-preview'
import { HtmlPreviewFrame, ViewportSwitcher } from './HtmlPreviewFrame'
import { MOTION_S } from '../ui/motion'

interface Props {
  code: string
  language?: string
  onClose: () => void
}

/**
 * Preview for a snippet the MODEL produced. It keeps `allow-scripts` on (the
 * user asked for that code to exist, and a generated page without its script
 * is not a preview); the Explorer panel's file preview deliberately does not,
 * see file-preview.ts. Neither ever gets `allow-same-origin`, so the markup
 * lives in an opaque origin and cannot reach the app.
 *
 * The document shell lives in lib/html-preview.ts, shared with the panel.
 */
export function HtmlPreviewModal({ code, language, onClose }: Props) {
  const [viewport, setViewport] = useState<Viewport>('desktop')
  const [reloadKey, setReloadKey] = useState(0)
  const doc = useMemo(() => buildDocument(code, language), [code, language])

  // Esc closes, matching every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openInBrowser = () => {
    // Hand the data URL to the host browser. data: URLs work in modern
    // browsers; users can then save / share / inspect with full devtools.
    const dataUrl = `data:text/html;charset=utf-8;base64,${btoa(unescape(encodeURIComponent(doc)))}`
    openExternal(dataUrl)
  }

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: MOTION_S.base }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <motion.div
          className="lu-elevated rounded-lg flex flex-col overflow-hidden w-full max-w-[95vw] h-[90vh] max-h-[900px]"
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ duration: MOTION_S.base }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold tracking-wider uppercase text-gray-500 dark:text-gray-400">
                HTML Preview
              </span>
              <span className="t-micro text-gray-400 dark:text-gray-500 font-mono">
                {language || 'html'}
              </span>
            </div>

            <ViewportSwitcher viewport={viewport} onChange={setViewport} />

            <div className="flex items-center gap-1">
              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Reload preview"
                title="Reload preview"
              >
                <RotateCw size={14} />
              </button>
              <button
                onClick={openInBrowser}
                className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Open in browser"
                title="Open in browser"
              >
                <ExternalLink size={14} />
              </button>
              <button
                onClick={onClose}
                className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.06] hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Close"
                title="Close (Esc)"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Frame area, checkered background to make the rendered surface obvious */}
          <div className="flex-1 overflow-auto bg-[length:24px_24px] bg-[linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%),linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%)] bg-[position:0_0,12px_12px] dark:bg-[length:24px_24px] dark:bg-[linear-gradient(45deg,rgba(255,255,255,0.03)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.03)_75%),linear-gradient(45deg,rgba(255,255,255,0.03)_25%,transparent_25%,transparent_75%,rgba(255,255,255,0.03)_75%)] flex items-center justify-center p-4">
            <HtmlPreviewFrame doc={doc} viewport={viewport} allowScripts reloadKey={reloadKey} />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
