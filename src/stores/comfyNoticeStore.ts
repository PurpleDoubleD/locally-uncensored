import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { PENDING_SIGNATURE } from '../lib/comfy-cors-notice'

/**
 * Was der Nutzer an ComfyUI-Hinweisen im Create-Tab schon weggeklickt hat.
 *
 * Eigener Store und nicht createStore, aus einem Grund: createStore ist der
 * Arbeitszustand einer Sitzung und laesst genau diese Felder bewusst nicht in
 * die Persistenz (siehe partialize dort, `comfyCorsBlocked` steht in der
 * Ausschlussliste). Ein Wegklick ist aber kein Arbeitszustand, sondern eine
 * Entscheidung des Nutzers, und die haelt laenger als ein Fenster.
 *
 * R18 Befund 1 (2026-08-30, Windows Box, ComfyUI 0.33.0): die Cross-Origin
 * Leiste kam nach jedem Render zurueck, weil das X nur den fluechtigen Wert
 * umlegte, den das naechste Vorschaubild sofort wieder setzte. Die Begruendung
 * der Regel steht in lib/comfy-cors-notice.ts.
 *
 * `lu_comfy_notice` steht in fatal-error.ts (zuruecksetzbar, es sind
 * Einstellungen und keine Inhalte) und in store-backup.ts (ueberlebt ein
 * Update, sonst waere der Wegklick nach jeder Version wieder weg, genau der
 * Fehler, den `lu_cloud_notice` einmal hatte).
 */
interface ComfyNoticeState {
  /** Ursachensignatur, fuer die die Cross-Origin-Leiste weggeklickt wurde. */
  corsNoticeDismissedFor: string | null
  /** Wegklicken. Ohne bekannte Signatur wird der Platzhalter gesetzt. */
  dismissCorsNotice: (signature: string | null) => void
  /**
   * Den Platzhalter durch die echte Signatur ersetzen, sobald sie da ist.
   *
   * Wirkt NUR auf den Platzhalter. Eine bereits echte Signatur zu ueber
   * schreiben wuerde den Wegklick auf eine neue Ursache mituebertragen, und
   * damit die eine Lage verschweigen, in der die Leiste wieder etwas Neues zu
   * sagen haette.
   */
  adoptCorsSignature: (signature: string) => void
}

export const useComfyNoticeStore = create<ComfyNoticeState>()(
  persist(
    (set) => ({
      corsNoticeDismissedFor: null,
      dismissCorsNotice: (signature) =>
        set({ corsNoticeDismissedFor: signature ?? PENDING_SIGNATURE }),
      adoptCorsSignature: (signature) =>
        set((s) =>
          s.corsNoticeDismissedFor === PENDING_SIGNATURE
            ? { corsNoticeDismissedFor: signature }
            : s,
        ),
    }),
    {
      name: 'lu_comfy_notice',
      storage: safeJSONStorage(),
    },
  ),
)
