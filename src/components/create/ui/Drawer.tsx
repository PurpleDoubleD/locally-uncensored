
import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from './cn'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  width?: number
  children: React.ReactNode
  footer?: React.ReactNode
}

// Right slide-over. Soft scrim (no hard backdrop) so params stay in context of
// the result; full-height on the right edge of the stage.
export function Drawer({ open, onClose, title, width = 320, children, footer }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const prevFocus = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  // Move focus into the drawer on open, restore it on close — but ONLY on the
  // actual open↔close transition, never on unrelated parent re-renders (which
  // would otherwise steal focus while the drawer is closed).
  useEffect(() => {
    if (open && !wasOpen.current) {
      prevFocus.current = document.activeElement as HTMLElement
      closeRef.current?.focus()
    } else if (!open && wasOpen.current) {
      prevFocus.current?.focus?.()
    }
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="absolute inset-0 z-40 bg-black/20"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            style={{ width }}
            className={cn(
              'absolute top-0 right-0 bottom-0 z-50 flex flex-col',
              'bg-white dark:bg-[#1e1e1e] border-l border-white/[0.08] shadow-[var(--shadow-xl)]',
            )}
          >
            <div className="flex items-center justify-between px-4 h-12 border-b border-white/[0.06] shrink-0">
              <span className="t-title text-gray-200">{title}</span>
              <button ref={closeRef} onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-white p-1 rounded-md hover:bg-white/8 transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin px-4">{children}</div>
            {footer && <div className="px-4 py-3 border-t border-white/[0.06] shrink-0">{footer}</div>}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}