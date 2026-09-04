import { useEffect, useState } from 'react'
import { Hinweis } from '../ui/Hinweis'

/**
 * §20: one-time, non-spammy notice shown when a localStorage write was
 * dropped because the browser's storage quota is full (after conversation +
 * memory pruning already failed to make room). Listens for the
 * `lu:storage-quota-exceeded` CustomEvent that createSafeStorage dispatches.
 *
 * Debounced so a burst of failing writes (zustand persists fire on every
 * mutation) surfaces a single notice, not one per write. Stays mounted at the
 * top of AppShell with zero cost until the event fires, since it renders null
 * until then. The user dismisses it manually; we don't auto-hide because a
 * full store is a sticky condition they should act on.
 *
 * Bauform: `<Hinweis>` im Ton `ruhig`, siehe `lib/hinweis.ts`. Bis zum
 * 04.09.2026 war das ein gelbes Band mit Fuellflaeche, Kante und fetter
 * Ueberschrift. Der Satz sagt aber gerade, dass NICHTS Wichtiges verloren
 * ist: Chats und Erinnerungen liegen woanders, nur eine Einstellung kam
 * nicht durch. Ein Band in Alarmfarbe hat das Gegenteil behauptet.
 */
export function StorageQuotaToast() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Debounce: collapse a flurry of quota events into one visible notice.
    let timer: ReturnType<typeof setTimeout> | null = null
    const onQuota = () => {
      if (timer) return
      timer = setTimeout(() => {
        setVisible(true)
        timer = null
      }, 300)
    }
    window.addEventListener('lu:storage-quota-exceeded', onQuota as EventListener)
    return () => {
      window.removeEventListener('lu:storage-quota-exceeded', onQuota as EventListener)
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!visible) return null

  return (
    <Hinweis className="px-3 py-1" onDismiss={() => setVisible(false)}>
      App storage limit reached, so that setting wasn't saved. This is the browser's small
      per-app store, not your disk space. Your chats and memories live in a separate, much
      larger local database and are unaffected.
    </Hinweis>
  )
}
