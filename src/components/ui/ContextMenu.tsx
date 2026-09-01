/**
 * Das Kontextmenü dieses Hauses.
 *
 * Vor Welle 3 gab es genau eins (`layout/Sidebar.tsx:690`), fest in die
 * Sidebar eingebaut. Aufbau und Rollen von dort sind übernommen — ein
 * Vollflächen-Overlay fängt Klick und Rechtsklick ab, darin ein
 * `role="menu"` mit `role="menuitem"`-Knöpfen, Escape schließt. Ergänzt sind
 * die drei Dinge, die dort fehlen und ohne die ein Menü mit der Tastatur
 * nicht bedienbar ist:
 *
 *  1. Pfeiltasten/Home/End über `nextFocusIndex` — dieselbe zyklische
 *     Rechnung, die die Fokusfalle der Modals benutzt.
 *  2. Fokusrückgabe an das Element, das beim Öffnen den Fokus hatte.
 *  3. Der Escape-Stapel aus `dialog-a11y`: liegt das Menü über einem Dialog,
 *     schließt Escape NUR das Menü, nicht beides auf einmal.
 *
 * Was hier NICHT drin ist: die Einträge. Die kommen als `MenuAction[]` von
 * `menu-actions.ts` und tragen die Funktionen des Aufrufers — dieselben, die
 * auch am sichtbaren Knopf hängen.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { clampMenuPosition, type MenuAction } from './menu-actions'
import { closeDialog, isTopDialog, nextFocusIndex, openDialog } from './dialog-a11y'

export interface ContextMenuProps {
  readonly items: readonly MenuAction[]
  /** Zeigerposition des Rechtsklicks (`clientX`/`clientY`). */
  readonly x: number
  readonly y: number
  /** `aria-label` des Menüs — es hat keine sichtbare Überschrift. */
  readonly label: string
  readonly onClose: () => void
}

/** Schätzmaße für den ERSTEN Anstrich, bevor gemessen werden kann. Der
 *  Layout-Effekt unten korrigiert sie noch vor dem Zeichnen, es blitzt also
 *  nichts. */
const EST_WIDTH = 176
const EST_ROW = 28
const EST_PAD = 8

/**
 * Wer hatte den Fokus, bevor der Rechtsklick kam?
 *
 * `document.activeElement` beim Mounten des Menüs zu lesen — der naheliegende
 * Weg, den `ui/Modal` benutzen darf — kann den Auslöser NICHT mehr finden. Das
 * Verschieben des Fokus ist die Default-Aktion von `mousedown` und läuft erst,
 * nachdem alle Listener durch sind. Am laufenden Fenster gemessen
 * (2026-09-01, Rechtsklick auf eine Nachricht bei fokussiertem Kopieren-Knopf):
 *
 *   mousedown   → activeElement = Knopf „Copy message"
 *   focusout    → weg vom Knopf
 *   contextmenu → activeElement = <body>
 *
 * `mousedown` ist also der letzte Moment, in dem der alte Fokus noch steht.
 * Beim Öffnen per Tastatur (Kontextmenü-Taste) gibt es kein `mousedown`, dort
 * stimmt `document.activeElement` weiterhin — deshalb hat es unten Vorrang.
 */
let lastFocusedBeforePointer: HTMLElement | null = null

if (typeof document !== 'undefined') {
  document.addEventListener(
    'mousedown',
    () => {
      const el = document.activeElement
      lastFocusedBeforePointer = el instanceof HTMLElement && el !== document.body ? el : null
    },
    true,
  )
}

export function ContextMenu({ items, x, y, label, onClose }: ContextMenuProps) {
  const dialogId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** Wohin der Fokus beim Schließen zurückkehrt. */
  const restoreRef = useRef<HTMLElement | null>(null)

  const [active, setActive] = useState(0)
  const [pos, setPos] = useState(() =>
    clampMenuPosition(x, y, { width: EST_WIDTH, height: items.length * EST_ROW + EST_PAD }, viewport()),
  )

  // (1) Stapel-Anmeldung, vor den Tastatur-Effekten — wie in ui/Modal.
  useEffect(() => {
    openDialog(dialogId)
    return () => closeDialog(dialogId)
  }, [dialogId])

  // (2) Echte Maße statt Schätzung. `useLayoutEffect`, damit die Korrektur
  //     vor dem Zeichnen sitzt.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const next = clampMenuPosition(x, y, { width: r.width, height: r.height }, viewport())
    setPos(prev => (prev.left === next.left && prev.top === next.top ? prev : next))
  }, [x, y, items.length])

  // (3) Fokus hinein und beim Schließen zurück. Ohne die Rückgabe landet der
  //     Fokus auf <body> und die nächste Tab-Taste fängt oben in der App an.
  useEffect(() => {
    const live = document.activeElement
    restoreRef.current =
      live instanceof HTMLElement && live !== document.body ? live : lastFocusedBeforePointer
    itemRefs.current[0]?.focus()
    return () => {
      const target = restoreRef.current
      restoreRef.current = null
      if (target && target.isConnected) target.focus()
    }
  }, [])

  // (4) Fokus dem ausgewählten Eintrag nachführen.
  useEffect(() => {
    itemRefs.current[active]?.focus()
  }, [active])

  // (5) Ein gescrolltes oder verkleinertes Fenster lässt das Menü neben seinem
  //     Anker stehen. Native Menüs schließen dann; das ist auch hier das
  //     ehrlichste Verhalten.
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Liegen mehrere Ebenen übereinander, reagiert nur die oberste.
    if (!isTopDialog(dialogId)) return

    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        setActive(i => Math.max(0, nextFocusIndex(items.length, i, e.key === 'ArrowUp')))
        return
      case 'Home':
        e.preventDefault()
        setActive(0)
        return
      case 'End':
        e.preventDefault()
        setActive(items.length - 1)
        return
      case 'Tab':
        // Ein Menü fängt Tab nicht ein — es macht zu und gibt den Fokus
        // zurück, so wie die Menüs des Betriebssystems.
        e.preventDefault()
        onClose()
        return
      default:
    }
  }

  return (
    <div
      data-lu-dialog
      className="fixed inset-0 z-[110]"
      onClick={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose() }}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        className="absolute min-w-[9rem] py-1 rounded-md bg-white dark:bg-[#141414] border border-gray-200 dark:border-white/10 shadow-lg text-[0.7rem]"
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {items.map((item, i) => (
          <button
            key={item.id}
            ref={(el) => { itemRefs.current[i] = el }}
            role="menuitem"
            type="button"
            tabIndex={i === active ? 0 : -1}
            onMouseEnter={() => setActive(i)}
            onClick={() => { onClose(); item.run() }}
            className={
              'w-full flex items-center gap-2 px-3 py-1.5 text-left ' +
              (item.destructive
                ? 'text-red-600 dark:text-red-500 hover:bg-red-500/10'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/[0.06]')
            }
          >
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}
