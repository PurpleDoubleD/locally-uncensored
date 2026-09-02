import { useEffect } from 'react'
import { AppShell } from './components/layout/AppShell'
import { useSettingsStore } from './stores/settingsStore'
import { useVoiceStore } from './stores/voiceStore'

function App() {
  useEffect(() => {
    // In Tauri: show the window once React has rendered (window starts hidden)
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('show_window').catch(() => {})
      })

      // The keychain is the store of record for the HuggingFace token; Rust
      // holds it in memory only, so every boot pushes it down again. Without
      // this, only opening Settings would arm the token, and a model download
      // started from Create or the Model Manager would still go out anonymous
      // and throttled.
      import('./api/mlx-image').then(async ({ isMlxImageHost, applyHfToken, HF_TOKEN_ACCOUNT }) => {
        if (!isMlxImageHost()) return
        const { secretGet } = await import('./api/backend')
        const stored = await secretGet(HF_TOKEN_ACCOUNT).catch(() => null)
        if (stored) await applyHfToken(stored).catch(() => {})
      })

      // Same store of record for the CivitAI key, on every platform that has a
      // vault. This also moves an existing plaintext key out of localStorage,
      // once, on the first boot after the update.
      import('./stores/workflowStore').then(({ hydrateCivitaiApiKey }) => {
        hydrateCivitaiApiKey().catch(() => {})
      })
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

    // Bug BB v2.5.0 — push persisted GPU selection from localStorage into
    // AppState at app boot so the next Ollama / ComfyUI spawn picks it up
    // without the user having to open Settings first. Read the setting
    // synchronously off the store (already hydrated from localStorage by
    // zustand persist middleware).
    if (window.__TAURI_INTERNALS__) {
      const s = useSettingsStore.getState().settings
      const selection = {
        vendor: s.gpuVendor || 'auto',
        indices: s.gpuIndices || [],
      }
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('set_gpu_selection', { selection }).catch(() => {})
      })
    }
  }, [])

  return <AppShell />
}

export default App
