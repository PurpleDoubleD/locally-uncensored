/**
 * Ollamas Adresse aus Rust holen, einmal pro Fenster.
 *
 * Rust loest die Adresse auf (config.json > OLLAMA_HOST > Default) und gibt
 * sie ueber `get_ollama_host` heraus. Das Hauptfenster zieht sie in
 * `AppShell.tsx` (Issue #31, pullAndArm). Das Assistentenfenster ("onboarding",
 * `OnboardingWindow.tsx`) faehrt AppShell mit Absicht nicht hoch und hatte
 * deshalb nie eine Adresse ausser dem Default `localhost:11434`: der
 * Backend-Schritt klopfte dort an, und "Models you already have" listete die
 * Modelle eines anderen Ollama, wenn OLLAMA_HOST woanders hin zeigte.
 *
 * Dieselbe Regel wie AppShell beim Kaltstart: Rust gewinnt, danach steht der
 * Wert im providerStore und in `backend.ts` (`setOllamaBase`). Kein Rust da
 * oder Rust stumm: der providerStore gilt, wie dort auch.
 *
 * Das Versprechen wird gemerkt, damit Assistent und Erkenner nur einmal
 * fragen. Ausserhalb von Tauri passiert nichts und es wird nichts gemerkt:
 * der Tauri-Global kommt asynchron, ein frueher Aufruf darf den spaeteren
 * nicht vergiften.
 */
import { backendCall, getOllamaBase, isTauri, setOllamaBase } from '../api/backend'

let pending: Promise<void> | null = null

async function pull(): Promise<void> {
  const { useProviderStore } = await import('../stores/providerStore')

  // Erst nach der Hydrierung schreiben, sonst spielt `persist` den alten
  // baseUrl aus localStorage darueber (siehe AppShell, Schritt 2).
  const persist = useProviderStore.persist
  if (persist && !persist.hasHydrated?.()) {
    await new Promise<void>((resolve) => {
      const unsub = persist.onFinishHydration?.(() => { unsub?.(); resolve() })
      if (!unsub || persist.hasHydrated?.()) resolve()
    })
  }

  try {
    const res = await backendCall<{ base?: string }>('get_ollama_host')
    if (res?.base) {
      setOllamaBase(res.base)
      const current = useProviderStore.getState().providers.ollama?.baseUrl
      if (current !== res.base) {
        useProviderStore.getState().setProviderConfig('ollama', { baseUrl: res.base })
      }
    }
  } catch { /* Rust nicht bereit: der providerStore gilt */ }

  const current = useProviderStore.getState().providers.ollama?.baseUrl
  if (current) setOllamaBase(current)
}

export function syncOllamaBaseFromRust(): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  return (pending ??= pull().catch(() => {}))
}

/**
 * Die Adresse, an der der Backend-Scan Ollama sucht und die er meldet.
 *
 * Nach dem Abgleich ist das Rusts Adresse, so wie der providerStore sie dann
 * traegt. Der Store steht vorn und nicht `getOllamaBase()`, weil der Scan im
 * Hauptfenster das Ergebnis als baseUrl zurueckschreibt (AppShell,
 * `detected-backends-side-by-side.ts`) und das ueber die Subscription bis in
 * config.json geht: kam der Scan ohne Abgleich durch (Tauri-Global noch nicht
 * da), stand dort sonst der Default 11434 statt der eingestellten Adresse.
 */
export async function ollamaProbeBase(): Promise<string> {
  await syncOllamaBaseFromRust()
  try {
    const { useProviderStore } = await import('../stores/providerStore')
    const configured = useProviderStore.getState().providers.ollama?.baseUrl?.trim()
    if (configured) return configured.replace(/\/+$/, '')
  } catch { /* Store nicht ladbar: die Adresse aus backend.ts */ }
  return getOllamaBase()
}

/** Nur fuer Tests: das gemerkte Versprechen vergessen. */
export function resetOllamaBaseSyncForTests(): void {
  pending = null
}
