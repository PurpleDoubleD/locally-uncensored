/**
 * Was die LU Engine gerade wirklich tut, live.
 *
 * Bis 04.09.2026 stand diese Schleife nur im Einstellungsfenster, und die
 * Models-Seite hatte davon nichts. Persona P2 hat gemessen, was das kostet:
 * nach `Stop-Process` auf den Engine-Prozess meldete das Einstellungsfenster
 * binnen 2 Sekunden "Engine not running", waehrend die Kachel des Modells,
 * das gerade lief, 40 bzw. 90 Sekunden lang unveraendert ACTIVE zeigte und
 * ihren Use-Knopf verloren hatte. Nach einem Absturz war ausgerechnet das
 * zuletzt benutzte Modell das einzige, das man von der Models-Seite aus nicht
 * neu starten konnte.
 *
 * Also fragen beide dieselbe Stelle. Der schnelle Weg ist das Ereignis, das
 * Rust schickt, sobald seine Wache den toten Griff einsammelt; der Takt
 * darunter ist der Guertel fuer ein Ereignis, das in einem Neuladen verloren
 * geht.
 */
import { useEffect, useRef, useState } from 'react'
import { bundledEngineStatus, type EngineStatus } from '../api/engine'
import { isTauri } from '../api/backend'

/** Rust meldet den eingesammelten toten Griff hierunter. */
export const SIDECAR_GONE_EVENT = 'lu-sidecar-gone'

/**
 * Der Rueckfall-Takt, fuer den Fall, dass das Ereignis nie ankommt.
 *
 * Drei Sekunden haelt den schlechtesten Fall innerhalb der fuenf, die die
 * Anforderung nennt, und der Aufruf dahinter ist derselbe Statusabruf, den
 * beide Seiten beim Aufbauen ohnehin machen.
 */
export const ENGINE_STATUS_POLL_MS = 3_000

export interface EngineStatusView {
  status: EngineStatus | null
  /** Ob ueberhaupt schon einmal eine Antwort da war. Vorher ist `status`
   *  null, weil nichts gefragt wurde, und nicht, weil nichts laeuft. */
  geantwortet: boolean
  setStatus: (s: EngineStatus | null) => void
}

/**
 * @param pausiert Solange das wahr ist, wird nicht gefragt. Das
 * Einstellungsfenster startet die Engine selbst neu und liest danach selbst;
 * ein Takt mitten hinein zeigte die Luecke als "not running".
 */
export function useBuiltinEngineStatus(pausiert?: () => boolean): EngineStatusView {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [geantwortet, setGeantwortet] = useState(false)
  const pausiertRef = useRef(pausiert)
  pausiertRef.current = pausiert

  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    const read = () => {
      if (pausiertRef.current?.()) return
      bundledEngineStatus()
        .then((s) => { if (alive) { setStatus(s); setGeantwortet(true) } })
        .catch(() => { if (alive) { setStatus(null); setGeantwortet(true) } })
    }
    read()
    const timer = setInterval(read, ENGINE_STATUS_POLL_MS)
    let unlisten: (() => void) | null = null
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen(SIDECAR_GONE_EVENT, () => read()))
      .then((off) => { if (alive) unlisten = off; else off() })
      .catch(() => {})
    return () => {
      alive = false
      clearInterval(timer)
      unlisten?.()
    }
  }, [])

  return { status, geantwortet, setStatus }
}

/**
 * Bedient die Engine dieses Modell gerade NICHT.
 *
 * Vor der ersten Antwort falsch: dass noch niemand gefragt hat, ist kein
 * Beweis, dass nichts laeuft, und ein Use-Knopf, der eine halbe Sekunde lang
 * aufblitzt, ist ein Flackern.
 */
export function engineIsIdle(view: EngineStatusView): boolean {
  if (!view.geantwortet) return false
  return !view.status?.running
}
