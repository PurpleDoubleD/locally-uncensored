import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { HtmlPreviewPanel } from './HtmlPreviewPanel'
import { MOTION_S } from '../ui/motion'

interface Props {
  code: string
  language?: string
  onClose: () => void
}

/**
 * The large view of a snippet the MODEL produced (B29). The page and its
 * rules are the inline panel's (HtmlPreviewPanel): scripts run, never with
 * `allow-same-origin`, on the `luprev` scheme with its own closed policy.
 *
 * The old "open in browser" button is gone: it handed a data: URL to
 * openExternal, which refuses data: URLs, so it never did anything.
 */
export function HtmlPreviewModal({ code, language, onClose }: Props) {
  // Esc closes, matching every other overlay in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[200] flex items-center justify-center lu-dialog-scrim p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: MOTION_S.base }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <motion.div
          className="lu-dialog rounded-lg flex flex-col overflow-hidden w-full max-w-[95vw] h-[calc(90vh/var(--ui-scale))] max-h-[900px]"
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ duration: MOTION_S.base }}
          role="dialog"
          aria-label={`HTML preview (${language || 'html'})`}
        >
          <HtmlPreviewPanel code={code} language={language} variant="modal" onClose={onClose} />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
