/**
 * Der kleinste Baum, der den Assistenten trägt — für das eigene Fenster.
 *
 * NICHT `App` und nicht `AppShell`: die würden im kleinen Fenster die ganze
 * Anwendung hochfahren — Backup-Triade, Backend-Erkennung, Remote-Hörer,
 * Whisper-Probe, Modell-Gesundheitsscan — und beim Schließen des Fensters
 * stürbe das alles mittendrin. Hier steht nur, was der Assistent wirklich
 * braucht, und alles davon steht aus demselben Grund auch um ihn herum, wenn
 * er im Hauptfenster läuft (`AppShell.tsx`, `App.tsx`):
 *
 *   MotionConfig     „Bewegung reduzieren" für framer-motion, das die
 *                    CSS-Regel in index.css nicht erreicht.
 *   show_window      das Fenster ist unsichtbar gebaut (kein weißer Blitz)
 *                    und zeigt sich, sobald React steht — derselbe Weg wie
 *                    beim Hauptfenster.
 *   pushPersisted…   HF-Token und GPU-Wahl nach Rust, bevor der Assistent
 *                    lädt oder spawnt (siehe `lib/rust-boot-sync.ts`).
 *
 * Der LucideProvider (Strichstärke der Icon-Leiter) fehlt hier NICHT aus
 * Versehen: er liegt in `main.tsx` über beiden Bäumen, einmal.
 *
 * Was hier fehlt, fehlt mit Absicht: der Assistent selbst hydriert seine
 * Stores (Settings, Provider, Downloads, Release-Notes) aus localStorage,
 * das beide Webviews teilen. Das Hauptfenster wartet derweil, ohne einen
 * davon geladen zu haben (`main.tsx`), und liest nach dem Abschluss frisch.
 */
import { useEffect } from 'react'
import { MotionConfig } from 'framer-motion'
import { pushPersistedChoicesToRust } from '../../lib/rust-boot-sync'
import { Onboarding } from './Onboarding'

export function OnboardingWindow() {
  useEffect(() => {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('show_window').catch(() => {})
    })
    void pushPersistedChoicesToRust().catch(() => {})
  }, [])

  return (
    <MotionConfig reducedMotion="user">
      <Onboarding />
    </MotionConfig>
  )
}
