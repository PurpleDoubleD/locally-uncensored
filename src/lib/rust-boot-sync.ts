/**
 * Was ein Fenster beim Boot nach Rust drückt, damit der nächste Kindprozess
 * und der nächste Download die gespeicherten Entscheidungen des Nutzers
 * kennen.
 *
 * Bis zum eigenen Onboarding-Fenster stand das in `App.tsx`, und der
 * Assistent lief unter `App` — also lief es auch für ihn. Jetzt bootet das
 * Onboarding-Fenster OHNE `App` (`OnboardingWindow.tsx`, der kleinste Baum,
 * der den Assistenten trägt), und beide Dinge braucht es trotzdem:
 *
 *   - den HuggingFace-Token: der Starter-Download geht sonst anonym und
 *     gedrosselt hinaus (nach „Onboarding zurücksetzen" liegt einer im
 *     Schlüsselbund; auf einer frischen Installation ist der Weg ein No-op).
 *   - die GPU-Auswahl (Bug BB v2.5.0): der ComfyUI-Schritt spawnt einen
 *     Prozess, der sie lesen muss.
 *
 * Einmal geschrieben, zweimal gerufen — sonst hätte der Assistent im eigenen
 * Fenster still weniger gekonnt als im Hauptfenster.
 */
import { useSettingsStore } from '../stores/settingsStore'

export async function pushPersistedChoicesToRust(): Promise<void> {
  const [{ invoke }, { applyHfToken, HF_TOKEN_ACCOUNT }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('../api/mlx-image'),
  ])

  // Persisted GPU selection → AppState, so the next Ollama / ComfyUI spawn
  // picks it up without the user having to open Settings first. Read
  // synchronously off the store (already hydrated by zustand persist).
  const s = useSettingsStore.getState().settings
  const selection = {
    vendor: s.gpuVendor || 'auto',
    indices: s.gpuIndices || [],
  }
  invoke('set_gpu_selection', { selection }).catch(() => {})

  // The keychain is the store of record for the HuggingFace token; Rust
  // holds it in memory only, so every boot pushes it down again. Without
  // this, only opening Settings would arm the token, and a model download
  // started from Create, the Model Manager or the wizard would still go out
  // anonymous and throttled. Every platform: since 2.6.8 the GGUF downloader
  // sends the token to huggingface.co too, not only the Mac media lane.
  const { secretGet } = await import('../api/backend')
  const stored = await secretGet(HF_TOKEN_ACCOUNT).catch(() => null)
  if (stored) await applyHfToken(stored).catch(() => {})
}
