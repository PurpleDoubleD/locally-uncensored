import { useEffect } from 'react'
import { MotionConfig } from 'framer-motion'
import { AppShell } from './components/layout/AppShell'
import { useVoiceStore } from './stores/voiceStore'
import { pushPersistedChoicesToRust } from './lib/rust-boot-sync'

function App() {
  useEffect(() => {
    // In Tauri: show the window once React has rendered (window starts hidden).
    // Rust decides whether it may — while the onboarding runs in its own
    // window, the main window stays hidden (onboarding_window.rs).
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('show_window').catch(() => {})
      })

      // HuggingFace token + persisted GPU selection nach Rust. Geteilt mit dem
      // Onboarding-Fenster, das ohne App bootet (lib/rust-boot-sync.ts). Der
      // Schluesselbund bleibt die fuehrende Kopie des Tokens, Rust haelt ihn
      // nur im Speicher, also drueckt ihn jeder Boot erneut hinunter.
      void pushPersistedChoicesToRust().catch(() => {})

      // Same store of record for the CivitAI key, on every platform that has a
      // vault. This also moves an existing plaintext key out of localStorage,
      // once, on the first boot after the update.
      import('./stores/workflowStore').then(({ hydrateCivitaiApiKey }) => {
        hydrateCivitaiApiKey().catch(() => {})
      })

      // Hand the user's own model folder to ComfyUI at boot. It used to happen
      // only while the AI Backends settings tab was mounted, so a user who set
      // the folder in an older build and never opened that tab again would have
      // started ComfyUI without it forever.
      void (async () => {
        const { syncCustomModelDir } = await import('./lib/custom-model-dir')
        const { useSettingsStore: store } = await import('./stores/settingsStore')
        await syncCustomModelDir(store.getState().settings.hfDownloadPathOverride)
      })()
    }

    // Probe local Whisper (STT) once at boot and push the result into the voice
    // store so the mic button reflects real availability. initWhisperCheck() was
    // previously never called anywhere → isSpeechRecognitionSupported() stayed
    // false forever → the mic was permanently disabled even with faster-whisper
    // installed and running. Fire-and-forget; never blocks first render.
    import('./api/voice').then(({ initWhisperCheck, initTtsCheck }) => {
      initWhisperCheck()
        .then((ok) => useVoiceStore.getState().setSttAvailable(ok))
        .catch(() => {})
      // Same one-shot probe for local neural TTS (Piper) so the speaker
      // buttons reflect real availability and light up after the install.
      initTtsCheck()
        .then((ok) => useVoiceStore.getState().setTtsAvailable(ok))
        .catch(() => {})
    })
  }, [])

  // „Bewegung reduzieren" respektieren (Audit Welle 2). Die CSS-Regel in
  // index.css erreicht framer-motion NICHT — das schreibt Transforms per JS
  // direkt ins style-Attribut, an der Kaskade vorbei. `reducedMotion="user"`
  // liest dieselbe Systemeinstellung und ersetzt Transform-/Layout-Animationen
  // durch eine reine Opacity-Blende: die Fläche wandert nicht mehr, der
  // Zustandswechsel bleibt aber sichtbar (siehe Begründung in index.css).
  return (
    <MotionConfig reducedMotion="user">
      <AppShell />
    </MotionConfig>
  )
}

export default App
