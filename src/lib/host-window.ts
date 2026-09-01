/**
 * In welchem Fenster läuft dieses Frontend?
 *
 * Seit das Onboarding ein eigenes Fenster hat (`src-tauri/src/onboarding_window.rs`),
 * lädt `index.html` in ZWEI Webviews: dem Hauptfenster `main` und dem kleinen
 * Fenster `onboarding`. Die Antwort kommt aus dem Fensterlabel, das Tauri jedem
 * Webview mitgibt (`getCurrentWebviewWindow().label`) — und sie steht genau
 * hier, einmal. Dieses Projekt hat schon mehrfach daran gekrankt, dass eine
 * Frage zwei Wege hatte, von denen einer gepflegt wurde; deshalb liest kein
 * anderes Modul das Label selbst.
 *
 * Was hier NICHT steht: ob wir überhaupt in Tauri laufen. Das Prädikat dafür
 * gibt es zweimal mit Absicht (`api/backend.ts` mit v1-Rückfall,
 * `onboarding-host.ts` streng v2), und dieses Modul braucht keines von beiden:
 * ohne Tauri wirft `getCurrentWebviewWindow()`, und der Fang darunter heißt
 * `browser`.
 */
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

export type HostWindow = 'main' | 'onboarding' | 'browser'

/** Das Label des Onboarding-Fensters — dasselbe Literal wie `ONBOARDING` in
 *  `onboarding_window.rs`; ein Rust-Test hält beide gleich. */
export const ONBOARDING_WINDOW_LABEL = 'onboarding'

/** Das Ereignis, mit dem Rust dem wartenden Hauptfenster sagt, dass der
 *  Marker geschrieben ist — `DONE_EVENT` drüben. */
export const ONBOARDING_DONE_EVENT = 'onboarding:done'

/**
 * Die reine Zuordnung, ohne Fenster: `null` heißt „kein Tauri-Webview". Jedes
 * andere Label als das Onboarding-Label ist das Hauptfenster — ein künftiges
 * drittes Fenster müsste hier ausdrücklich dazukommen, nicht stillschweigend
 * als Onboarding durchgehen.
 */
export function hostWindowFrom(label: string | null): HostWindow {
  if (label === null) return 'browser'
  return label === ONBOARDING_WINDOW_LABEL ? 'onboarding' : 'main'
}

function currentLabel(): string | null {
  try {
    return getCurrentWebviewWindow().label
  } catch {
    return null
  }
}

/** Einmal beim Laden ausgewertet: ein Webview wechselt sein Fenster nicht. */
export const hostWindow: HostWindow = hostWindowFrom(currentLabel())

/**
 * Das Hauptfenster beim Boot: läuft das Onboarding gerade im eigenen
 * Fenster, dann WARTEN — ohne einen Store zu laden. Die Stores hydrieren aus
 * localStorage, und genau dort schreibt der Assistent drüben gerade den
 * Provider, das Theme, den Abschluss. Ein Hauptfenster, das schon hydriert
 * hätte, würde beim nächsten `set` mit seinem alten Stand darüberschreiben.
 *
 * Löst auf, sobald der Marker gesetzt ist — per Ereignis, oder sofort, wenn
 * er beim Nachsehen schon da war (das Ereignis kann vor dem Hörer gefeuert
 * sein, wenn der Nutzer den Assistenten schneller durchklickt, als dieses
 * Fenster bootet). Ohne Stellvertreter-Fenster löst es sofort auf; das
 * Hauptfenster zeichnet den Assistenten dann selbst (`AppShell.tsx`).
 */
export async function awaitOnboardingHandover(): Promise<void> {
  if (hostWindow !== 'main') return
  const { invoke } = await import('@tauri-apps/api/core')
  const delegated = await invoke<boolean>('onboarding_window_open').catch(() => false)
  if (!delegated) return
  const { listen } = await import('@tauri-apps/api/event')
  await new Promise<void>((resolve) => {
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve()
    }
    listen(ONBOARDING_DONE_EVENT, settle)
      .then(() => invoke<boolean>('is_onboarding_done'))
      .then((done) => { if (done) settle() })
      // Kein Hörer, keine Antwort: lieber die App booten als ewig warten —
      // Rust zeigt das Hauptfenster nach HANDOVER_GRACE ohnehin von sich aus.
      .catch(settle)
  })
}
