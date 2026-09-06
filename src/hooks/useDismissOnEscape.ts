import { useEffect } from 'react'

/**
 * Escape schliesst eine aufgeklappte Flaeche.
 *
 * `Modal` bringt das seit Audit-Welle 2 selbst mit („kein Escape, keine
 * Fokus-Falle, keine Rolle — wer die Maus nicht benutzt, kam aus dem Ding
 * nicht wieder heraus"). Die Aufklapplisten daneben haben es nie bekommen,
 * und das war teurer als es klingt: die Modellauswahl liegt ueber dem
 * Eingabefeld. Wer sie mit Escape geschlossen zu haben glaubt, tippt danach
 * gegen ein voll deckendes Panel und sieht ein Feld, das auf nichts reagiert
 * — zwei Testleser haben daraus unabhaengig „Enter sendet nicht" und „mein
 * Tippversuch ging verloren" gemacht.
 *
 * Der Listener haengt an `document`, aus demselben Grund wie in `Modal`: nach
 * einem Klick auf nicht-fokussierbaren Text landet der Fokus auf <body>, und
 * ein Handler am Panel saehe dann nichts mehr. Kindelemente, die Escape selbst
 * brauchen (Inline-Umbenennen, Suchfeld leeren), stoppen die Weitergabe und
 * kommen damit zuerst dran.
 */
export function useDismissOnEscape(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return
    const auf = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', auf)
    return () => document.removeEventListener('keydown', auf)
  }, [open, onClose])
}
