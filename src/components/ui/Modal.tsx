import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import {
  FOCUSABLE_SELECTOR,
  backgroundNodesToHide,
  closeDialog,
  isFocusable,
  isTopDialog,
  nextFocusIndex,
  openDialog,
  pickInitialFocusIndex,
} from './dialog-a11y'
import { SPRING_PANEL } from './motion'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Hide the default title/X header so the dialog can render its own
   *  centered hero layout (a floating close button is still provided). */
  hideHeader?: boolean
  /** Tailwind max-width of the panel. Default `max-w-lg`. */
  maxWidth?: string
  /** Panel corner radius (default `rounded-2xl`). Override for a more angular look. */
  panelRadius?: string
  /** Panel padding (default `p-6`). Override for a tighter dialog. */
  panelPad?: string
  /** Beschriftung für Screenreader, wenn KEIN sichtbarer Titel existiert
   *  (`title=""` oder `hideHeader`). Ohne sie fällt der Dialog auf `title`
   *  bzw. „Dialog" zurück. */
  ariaLabel?: string
}

// A modal is a real dialog, so it needs an OPAQUE, elevated surface — not the
// transparent `.glass-card` (which is `background: transparent` for inline
// panels). Without this the dialog read straight through to whatever tab was
// behind it and the white title vanished on a light surface.
//
// Bedienbarkeit (Audit Welle 2): das hier war optisch ein Dialog, für Tastatur
// und Screenreader aber keiner — kein Escape, keine Fokus-Falle, keine Rolle.
// Wer die Maus nicht benutzt, kam aus dem Ding nicht wieder heraus. Alles unten
// sitzt bewusst an DIESER einen Stelle, damit die zwölf Einbindungen es erben.
export function Modal({ open, onClose, title, children, hideHeader, maxWidth = 'max-w-lg', panelRadius = 'rounded-2xl', panelPad = 'p-6', ariaLabel }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** Wohin der Fokus beim Schließen zurückkehrt. */
  const restoreRef = useRef<HTMLElement | null>(null)

  const reactId = useId()
  const titleId = `${reactId}-title`
  const hasVisibleTitle = !hideHeader && title.trim().length > 0

  /** Fokussierbare Elemente im Panel, in DOM-Reihenfolge. */
  const focusables = useCallback((): HTMLElement[] => {
    const panel = panelRef.current
    if (!panel) return []
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable)
  }, [])

  // (1) Stapel-Anmeldung. Muss VOR den Tastatur-Effekten stehen, damit
  //     isTopDialog() bereits stimmt, wenn die Handler scharf werden.
  useEffect(() => {
    if (!open) return
    openDialog(reactId)
    return () => closeDialog(reactId)
  }, [open, reactId])

  // (2) Hintergrund inert. Reihenfolge ist wichtig: dieser Effekt wird VOR dem
  //     Fokus-Effekt deklariert, also läuft seine Aufräumfunktion auch zuerst.
  //     Sonst zeigte die Fokus-Rückgabe auf ein noch inertes Element und liefe
  //     ins Leere — `focus()` auf einen inerten Teilbaum ist ein No-op.
  useEffect(() => {
    if (!open) return
    const overlay = overlayRef.current
    if (!overlay) return

    // Nur Geschwister auf dem Pfad Overlay→<body>, nie ein Vorfahr: der Dialog
    // hängt im normalen Baum, `aria-hidden` auf #root würde ihn mitverstecken.
    //
    // Drei Ausnahmen:
    //  • bereits markierte Knoten (äußeres Modal) werden nicht erneut angefasst,
    //    sonst räumte das innere Modal beim Schließen dem äußeren die Sperre weg;
    //  • ein anderes Dialog-Overlay wird NIE markiert — zwei gleichzeitig
    //    geöffnete Modals sind Geschwister und würden sich sonst gegenseitig
    //    stilllegen, und zwar in Effekt-Reihenfolge, also auch das obere.
    const marked = backgroundNodesToHide<Element>(overlay, document.body).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        !el.hasAttribute('data-lu-dialog') &&
        !el.hasAttribute('inert') &&
        !el.hasAttribute('aria-hidden'),
    )
    for (const el of marked) {
      el.setAttribute('inert', '')
      el.setAttribute('aria-hidden', 'true')
    }
    return () => {
      for (const el of marked) {
        el.removeAttribute('inert')
        el.removeAttribute('aria-hidden')
      }
    }
  }, [open])

  // (3) Fokus hinein — und beim Schließen wieder dorthin zurück, wo er war.
  //     Das Zurückgeben ist der Teil, den man am deutlichsten merkt: ohne ihn
  //     landet der Fokus nach dem Schließen auf <body> und die nächste Tab-Taste
  //     fängt oben in der App wieder von vorn an.
  useEffect(() => {
    if (!open) return
    const active = document.activeElement
    restoreRef.current = active instanceof HTMLElement && active !== document.body ? active : null

    const items = focusables()
    const idx = pickInitialFocusIndex(items)
    if (idx >= 0) items[idx].focus()
    else panelRef.current?.focus()

    return () => {
      const target = restoreRef.current
      restoreRef.current = null
      if (target && target.isConnected) target.focus()
    }
  }, [open, focusables])

  // (4) Escape + Fokus-Falle. Der Listener hängt an `document`, weil der Fokus
  //     nach einem Klick auf nicht-fokussierbaren Text im Panel auf <body>
  //     landet und ein Handler am Panel dann nichts mehr sähe. Kindelemente, die
  //     Escape selbst brauchen (Inline-Umbenennen), stoppen die Propagation und
  //     kommen damit zuerst dran.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Liegen mehrere Dialoge übereinander, reagiert nur der oberste.
      if (!isTopDialog(reactId)) return

      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      const items = focusables()
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = nextFocusIndex(items.length, current, e.shiftKey)
      e.preventDefault()
      if (next >= 0) items[next].focus()
      else panel.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, reactId, onClose, focusables])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          data-lu-dialog
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            {...(hasVisibleTitle
              ? { 'aria-labelledby': titleId }
              : { 'aria-label': ariaLabel || title || 'Dialog' })}
            tabIndex={-1}
            className={
              `relative z-10 w-full outline-none ${panelRadius} ${panelPad} lu-elevated ` + maxWidth
            }
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={SPRING_PANEL}
          >
            {hideHeader ? (
              <button
                onClick={onClose}
                data-dialog-close
                className="absolute top-3 right-3 p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            ) : (
              <div className="flex items-center justify-between mb-4">
                <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
                <button
                  onClick={onClose}
                  data-dialog-close
                  className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
