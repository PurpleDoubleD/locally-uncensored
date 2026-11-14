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

      // The download speed limit sits in Rust and starts at none on every
      // launch (lib/download-limit.ts).
      void import('./lib/download-limit').then(({ startDownloadLimitSync }) => startDownloadLimitSync())

      // So does the idle unload of the LU Engine (lib/engine-idle-unload.ts).
      void import('./lib/engine-idle-unload').then(({ startEngineIdleUnloadSync }) => startEngineIdleUnloadSync())

      // C81: an engine that died on its own says how (lib/engine-exit-notice.ts).
      void import('./lib/engine-exit-notice').then(({ startEngineExitNotices }) => startEngineExitNotices())

      // The phone's tab name (GitHub #19) sits in Rust the same way
      // (lib/remote-page-title.ts).
      void import('./lib/remote-page-title').then(({ startRemotePageTitleSync }) => startRemotePageTitleSync())

      // The Local API comes up with LU when the user switched that on, so a
      // server that starts LU with its session keeps the API after a reboot.
      void import('./stores/localApiStore').then(({ startLocalApiAtLaunch }) => startLocalApiAtLaunch()).catch(() => {})
      // Create over the desktop: a paired phone's jobs arrive as an event and
      // run in this window (lib/remote-create-runner.ts).
      void import('./lib/remote-create-runner').then(({ startRemoteCreateRunner }) => startRemoteCreateRunner()).catch(() => {})
      // Shared chats: the phone's actions arrive as an event and run in this
      // window (lib/remote-chats-bridge.ts).
      void import('./lib/remote-chats-start').then(({ startRemoteChatsBridge }) => startRemoteChatsBridge()).catch(() => {})
      // Watchers: the clock in Rust says when, the run happens in this window
      // (lib/watchers/runner.ts).
      void import('./lib/watchers/runner').then(({ startWatcherRunner }) => startWatcherRunner()).catch(() => {})
      // Device tests only: a build with the Cargo feature `e2e-remote` and
      // its environment says so; every other build answers no.
      void import('./lib/remote-e2e').then(({ startRemoteForDeviceTests }) => startRemoteForDeviceTests()).catch(() => {})
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
