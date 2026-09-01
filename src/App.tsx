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

      // HuggingFace token + persisted GPU selection → Rust. Shared with the
      // onboarding window, which boots without App (lib/rust-boot-sync.ts).
      void pushPersistedChoicesToRust().catch(() => {})
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
