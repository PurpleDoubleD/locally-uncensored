import { useCallback, useEffect, useReducer, useState } from 'react'
import { Check, Download, Loader2, Mic, Volume2, X } from 'lucide-react'
import { withInstallerOutput } from '../../lib/error-text'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { backendCall } from '../../api/backend'
import { useSettingsStore } from '../../stores/settingsStore'
import { useVoiceStore } from '../../stores/voiceStore'
import { checkWhisperAvailable, checkTtsAvailable, downloadPiperVoice, listInstalledPiperVoices } from '../../api/voice'
import { InlineToggle } from './InlineToggle'
import { initialProbe, makeProbeReducer, needsInstall, showsHint } from './probe-install'

/**
 * Der Abschnitt „Speech" der Einstellungen — Diktat (faster-whisper) und
 * Vorlesen (Piper), inklusive ihrer In-App-Installer.
 *
 * ── Warum diese Datei existiert (AS-09) ───────────────────────────────────
 *
 * Elf der dreizehn `useState` von `SettingsPage()` gehoerten diesem einen
 * Abschnitt, dazu drei `useCallback`, ein Mount-Effekt und drei Handler.
 * Zwei Dinge sind dabei schiefgelaufen, und beide werden hier geradegezogen:
 *
 *  1. Acht der elf waren ZWEIMAL DASSELBE — Probe, Ladeflagge,
 *     Installationsflagge, Installationsfehler, einmal fuer STT und einmal
 *     fuer TTS. Das steht jetzt in ./probe-install.ts, einmal.
 *
 *  2. Die drei Proben liefen im Mount-Effekt der SEITE. Wer die
 *     Einstellungen auf „General" oeffnete, loeste drei Backend-Aufrufe fuer
 *     einen Abschnitt aus, der gar nicht gerendert wurde. Als eigene
 *     Komponente laeuft der Abschnitt, wenn er da ist — der Tab-Wechsel
 *     montiert und demontiert ihn.
 *
 * Was NICHT verlorengeht: die Proben schreiben weiterhin `sttAvailable` /
 * `ttsAvailable` in den Voice-Store, damit Mikrofon- und Vorlesen-Knopf nach
 * einer In-App-Installation ohne Neustart aufwachen. Der Erststart probt
 * ohnehin schon in `App.tsx` — die Probe hier ist die Auffrischung nach der
 * Installation, und die passiert genau in diesem Abschnitt.
 */

interface WhisperProbe { available: boolean; backend: string | null; error?: string }
interface TtsProbe { available: boolean }

const whisperReducer = makeProbeReducer<WhisperProbe>()
const ttsReducer = makeProbeReducer<TtsProbe>()

// MiniMax Speech-02 system voices for the hosted cloud TTS. The server route
// (/api/voice/tts) forwards the id verbatim as voice_id and only validates the
// character set; default is Wise_Woman.
const CLOUD_TTS_VOICES: { id: string; label: string }[] = [
  { id: 'Wise_Woman', label: 'Wise Woman, default' },
  { id: 'Calm_Woman', label: 'Calm Woman' },
  { id: 'Lively_Girl', label: 'Lively Girl' },
  { id: 'Lovely_Girl', label: 'Lovely Girl' },
  { id: 'Sweet_Girl_2', label: 'Sweet Girl' },
  { id: 'Friendly_Person', label: 'Friendly Person' },
  { id: 'Deep_Voice_Man', label: 'Deep Voice Man' },
  { id: 'Casual_Guy', label: 'Casual Guy' },
  { id: 'Patient_Man', label: 'Patient Man' },
  { id: 'Determined_Man', label: 'Determined Man' },
  { id: 'Elegant_Man', label: 'Elegant Man' },
  { id: 'Young_Knight', label: 'Young Knight' },
]

// Curated local neural (Piper) voices the user can pick. Selecting one not yet
// on disk downloads it (~63 MB). Ids match rhasspy/piper-voices.
const PIPER_VOICES: { id: string; label: string }[] = [
  { id: 'en_US-lessac-medium', label: 'Lessac, US, neutral' },
  { id: 'en_US-amy-medium', label: 'Amy, US, female' },
  { id: 'en_US-ryan-high', label: 'Ryan, US, male (high)' },
  { id: 'en_US-hfc_female-medium', label: 'HFC, US, female' },
  { id: 'en_GB-alba-medium', label: 'Alba, UK, female' },
  { id: 'en_GB-northern_english_male-medium', label: 'Northern, UK, male' },
]

export function SpeechSettings() {
  const appMode = useSettingsStore((s) => s.settings.appMode)
  const voiceSettings = useVoiceStore()

  const [whisper, whisperDo] = useReducer(whisperReducer, initialProbe<WhisperProbe>())
  const [tts, ttsDo] = useReducer(ttsReducer, initialProbe<TtsProbe>())
  const [installedVoices, setInstalledVoices] = useState<string[]>([])
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  // The three probes are stabilised with useCallback ON PURPOSE, not for
  // speed: the mount effect below has to list them as dependencies, and a
  // function rebuilt on every render would re-run the effect on every render.
  // `voiceSettings` is `useVoiceStore()` — the WHOLE store, so it changes on
  // every store write, including the writes these probes make themselves.
  // Reaching for the actions through selectors instead keeps the closures
  // pinned to values that never change: zustand defines its actions once in
  // create(), so setSttAvailable/setTtsAvailable are the same references for
  // the life of the store.
  const setSttAvailable = useVoiceStore((s) => s.setSttAvailable)
  const setTtsAvailable = useVoiceStore((s) => s.setTtsAvailable)

  const refreshWhisper = useCallback(() => {
    whisperDo({ type: 'probing' })
    return checkWhisperAvailable()
      .then((s) => {
        whisperDo({ type: 'probed', probe: s })
        // Drive the mic button's availability from the same probe so it lights
        // up immediately after the in-app install — no restart needed.
        setSttAvailable(!!s.available)
      })
      .catch(() => whisperDo({ type: 'probeFailed' }))
  }, [setSttAvailable])

  const refreshTts = useCallback(() => {
    ttsDo({ type: 'probing' })
    // Read the voice at call time rather than closing over it. It is what
    // every caller already means — handlePickVoice sets the new voice and
    // then asks "is TTS available now?", which is a question about the NEW
    // voice — and it keeps this callback free of a dependency that changes.
    return checkTtsAvailable(useVoiceStore.getState().piperVoice)
      .then((s) => {
        ttsDo({ type: 'probed', probe: s })
        // Same as STT: drive the read-aloud button availability from this probe
        // so it lights up right after the in-app install.
        setTtsAvailable(!!s.available)
      })
      .catch(() => ttsDo({ type: 'probeFailed' }))
  }, [setTtsAvailable])

  const refreshVoices = useCallback(
    () =>
      listInstalledPiperVoices()
        .then(setInstalledVoices)
        // Level (a): silent on purpose. This only fills the voice DROPDOWN. If
        // the list cannot be read the dropdown stays on its last contents and
        // every real action here — picking a voice, downloading one — reports
        // its own failure through setVoiceError below. A second message for
        // "the list did not refresh" would be noise on a screen that already
        // says what went wrong.
        .catch(() => {}),
    [],
  )

  useEffect(() => {
    void refreshWhisper()
    void refreshTts()
    void refreshVoices()
  }, [refreshWhisper, refreshTts, refreshVoices])

  // §24.9 — kick off the faster-whisper install, poll its status, then
  // re-check availability so the badge flips ✗ → ✓ without a restart.
  const handleInstallWhisper = async () => {
    if (whisper.installing) return
    whisperDo({ type: 'installStart' })
    try {
      await backendCall('install_whisper')
      // Poll install status until it leaves "installing" (cap ~10 min — a
      // model download on a slow link can be lengthy; pip itself is quick).
      const start = Date.now()
      // Endlosschleife mit Ausstiegen im Rumpf (complete / error / 10-min-Kappe).
      // Hier stand eine Unterdrueckung von `no-constant-condition`. Die Regel
      // laeuft in diesem Baum mit `checkLoops: 'allExceptWhileTrue'` und hat
      // genau diese Form nie beanstandet — die Zeile unterdrueckte nichts.
      while (true) {
        await new Promise((r) => setTimeout(r, 2000))
        let s: { status?: string; error?: string } = {}
        try {
          s = await backendCall<{ status?: string; error?: string }>('install_whisper_status')
        } catch { /* transient — keep polling */ }
        if (s.status === 'complete') break
        if (s.status === 'error') {
          whisperDo({ type: 'installFailed', error: withInstallerOutput('Installing speech to text did not finish.', s.error) })
          break
        }
        if (Date.now() - start > 600_000) {
          whisperDo({ type: 'installFailed', error: 'Install is taking unusually long, check the logs / try again.' })
          break
        }
      }
    } catch (e) {
      whisperDo({ type: 'installFailed', error: e instanceof Error ? e.message : String(e) })
    } finally {
      whisperDo({ type: 'installDone' })
      await refreshWhisper()
    }
  }

  // Install Piper neural TTS (pip + voice download) the same end-user way as
  // whisper, polling install_tts_status until done, then re-checking the badge.
  const handleInstallTts = async () => {
    if (tts.installing) return
    ttsDo({ type: 'installStart' })
    try {
      await backendCall('install_tts')
      const start = Date.now()
      // Endlosschleife mit Ausstiegen im Rumpf (complete / error / 10-min-Kappe).
      // Hier stand eine Unterdrueckung von `no-constant-condition`. Die Regel
      // laeuft in diesem Baum mit `checkLoops: 'allExceptWhileTrue'` und hat
      // genau diese Form nie beanstandet — die Zeile unterdrueckte nichts.
      while (true) {
        await new Promise((r) => setTimeout(r, 2000))
        let s: { status?: string; error?: string } = {}
        try {
          s = await backendCall<{ status?: string; error?: string }>('install_tts_status')
        } catch { /* transient — keep polling */ }
        if (s.status === 'complete') break
        if (s.status === 'error') {
          ttsDo({ type: 'installFailed', error: withInstallerOutput('Installing read aloud did not finish.', s.error) })
          break
        }
        if (Date.now() - start > 600_000) {
          ttsDo({ type: 'installFailed', error: 'Install is taking unusually long, check the logs / try again.' })
          break
        }
      }
    } catch (e) {
      ttsDo({ type: 'installFailed', error: e instanceof Error ? e.message : String(e) })
    } finally {
      ttsDo({ type: 'installDone' })
      await refreshTts()
    }
  }

  // Pick a Piper voice. If it isn't on disk yet, download it (~63 MB), then
  // re-check the installed list + TTS availability. The selection is applied
  // optimistically (so the dropdown reflects the pick) but REVERTED if the
  // download fails — otherwise piperVoice pointed at a missing model and every
  // read fell back to the Windows SAPI voice (#77, ElBiggus).
  const handlePickVoice = async (id: string) => {
    setVoiceError(null)
    const prev = voiceSettings.piperVoice
    voiceSettings.setPiperVoice(id)
    if (installedVoices.includes(id)) return
    setVoiceBusy(true)
    try {
      await downloadPiperVoice(id)
      await refreshVoices()
      await refreshTts()
    } catch (e) {
      voiceSettings.setPiperVoice(prev)
      setVoiceError(e instanceof Error ? e.message : String(e))
    } finally {
      setVoiceBusy(false)
    }
  }

  if (appMode === 'cloud') {
    return (<>
      {/* Cloud mode: dictation + read-aloud are hosted on lu-labs.ai —
          honest copy (audio leaves the machine, metered), no local
          install buttons, and a picker for the hosted MiniMax voice. */}
      <p className="text-[0.55rem] text-gray-500 leading-snug">
        Cloud mode: dictation and read-aloud run on lu-labs.ai (hosted Whisper speech-to-text + MiniMax text-to-speech) and are metered against your credits. No local installs needed.
      </p>
      <InlineToggle label="Enable read-aloud" enabled={voiceSettings.ttsEnabled} onChange={() => voiceSettings.updateVoiceSettings({ ttsEnabled: !voiceSettings.ttsEnabled })} icon={<Volume2 size={11} className="text-gray-500" />} />
      {voiceSettings.ttsEnabled && (
        <InlineToggle label="Auto-read new responses" enabled={voiceSettings.autoReadAloud} onChange={() => voiceSettings.updateVoiceSettings({ autoReadAloud: !voiceSettings.autoReadAloud })} icon={<Volume2 size={11} className="text-gray-500" />} />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.7rem] text-gray-500">Voice</span>
        <select
          value={voiceSettings.cloudTtsVoice}
          onChange={(e) => voiceSettings.updateVoiceSettings({ cloudTtsVoice: e.target.value })}
          className="max-w-[210px] px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 focus:outline-none"
        >
          {CLOUD_TTS_VOICES.map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
        </select>
      </div>
    </>)
  }

  return (<>
    <p className="text-[0.55rem] text-gray-500 leading-snug">
      Voice runs 100% locally, no cloud. Each engine is a one-time local install.
    </p>

    {/* Speech-to-Text — faster-whisper (powers the microphone / dictation) */}
    <div className="flex items-center gap-2 text-[0.65rem]">
      <span className="flex items-center gap-1.5">
        {whisper.loading
          ? <Loader2 size={11} className="animate-spin text-gray-500" />
          : whisper.probe?.available ? <Check size={11} className="text-green-500" /> : <X size={11} className="text-red-500" />}
        <Mic size={11} className="text-gray-400" />
        <span className="text-gray-700 dark:text-gray-200 font-medium">Speech-to-Text</span>
        <span className="text-gray-500">faster-whisper</span>
      </span>
      {needsInstall(whisper) && (
        <button
          onClick={() => void handleInstallWhisper()}
          disabled={whisper.installing}
          className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
          title="Download + install faster-whisper so the microphone works"
        >
          {whisper.installing ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
          {whisper.installing ? 'Installing…' : 'Download & Install'}
        </button>
      )}
    </div>
    {whisper.installError && (
      <p className={`text-[0.55rem] leading-snug ${HINWEIS_TEXT.fehler}`}>{whisper.installError}</p>
    )}
    {showsHint(whisper) && (
      <p className="text-[0.55rem] text-gray-500 leading-snug">
        Required for the microphone. Installs faster-whisper into LU's Python; first run also downloads a small model.
      </p>
    )}

    {/* Text-to-Speech, Piper neural (read responses aloud) */}
    <div className="flex items-center gap-2 text-[0.65rem] pt-1">
      <span className="flex items-center gap-1.5">
        {tts.loading
          ? <Loader2 size={11} className="animate-spin text-gray-500" />
          : tts.probe?.available ? <Check size={11} className="text-green-500" /> : <X size={11} className="text-red-500" />}
        <Volume2 size={11} className="text-gray-400" />
        <span className="text-gray-700 dark:text-gray-200 font-medium">Text-to-Speech</span>
        <span className="text-gray-500">Piper neural</span>
      </span>
      {needsInstall(tts) && (
        <button
          onClick={() => void handleInstallTts()}
          disabled={tts.installing}
          className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
          title="Download + install Piper neural TTS + a voice (~63 MB)"
        >
          {tts.installing ? <Loader2 size={9} className="animate-spin" /> : <Download size={9} />}
          {tts.installing ? 'Installing…' : 'Download & Install'}
        </button>
      )}
    </div>
    {tts.installError && (
      <p className={`text-[0.55rem] leading-snug ${HINWEIS_TEXT.fehler}`}>{tts.installError}</p>
    )}
    {/* #77: read-aloud silently fell back to the system voice while this
        row showed a healthy green check, so the recorded reason is said here.
        Rot und nicht mehr Gelb: die gewaehlte Stimme spricht nicht, das ist
        ein Fehler und keine Zwischenstufe. Die Zeile steht in derselben Form
        wie der Installationsfehler darueber (lib/hinweis.ts). */}
    {voiceSettings.ttsMode === 'piper' && voiceSettings.ttsFallbackReason && (
      <p className={`text-[0.55rem] leading-snug ${HINWEIS_TEXT.fehler}`}>
        {voiceSettings.ttsFallbackReason} If an antivirus quarantined Piper, whitelist it or reinstall the voice below.
      </p>
    )}
    {showsHint(tts) && (
      <p className="text-[0.55rem] text-gray-500 leading-snug">
        Required for read-aloud. Installs Piper + a neural voice locally (~63 MB).
      </p>
    )}

    <InlineToggle label="Enable read-aloud" enabled={voiceSettings.ttsEnabled} onChange={() => voiceSettings.updateVoiceSettings({ ttsEnabled: !voiceSettings.ttsEnabled })} icon={<Volume2 size={11} className="text-gray-500" />} />
    {/* Auto-read is a SEPARATE opt-in (default OFF). The toggle above only
        surfaces the per-message Speaker button; this one also reads each
        finished response aloud (#77, ElBiggus, the old single toggle was
        labelled "Read responses aloud" but never auto-read). */}
    {voiceSettings.ttsEnabled && (
      <InlineToggle label="Auto-read new responses" enabled={voiceSettings.autoReadAloud} onChange={() => voiceSettings.updateVoiceSettings({ autoReadAloud: !voiceSettings.autoReadAloud })} icon={<Volume2 size={11} className="text-gray-500" />} />
    )}
    {/* Neural voice picker (Piper), replaces the old Microsoft/browser
        voices (David 2026-06-06). Picking one not yet on disk downloads
        it (~63 MB). Browser-only rate/pitch knobs dropped, they didn't
        apply to Piper. */}
    <div className="flex items-center justify-between gap-2">
      <span className="text-[0.7rem] text-gray-500 flex items-center gap-1">
        Voice {voiceBusy && <Loader2 size={10} className="animate-spin text-gray-500" />}
      </span>
      <select
        value={voiceSettings.piperVoice}
        onChange={(e) => void handlePickVoice(e.target.value)}
        disabled={voiceBusy}
        className="max-w-[210px] px-1.5 py-0.5 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 focus:outline-none disabled:opacity-50"
      >
        {PIPER_VOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}{installedVoices.includes(v.id) ? '' : ', download'}
          </option>
        ))}
      </select>
    </div>
    {voiceBusy && <p className="text-[0.55rem] text-gray-500 leading-snug">Downloading voice (~63 MB)…</p>}
    {voiceError && <p className={`text-[0.55rem] leading-snug ${HINWEIS_TEXT.fehler}`}>{voiceError}</p>}

    {/* TTS engine — bundled Piper, or an external OpenAI-compatible HTTP
        endpoint like Kokoro-FastAPI (GitHub #58). */}
    <div className="flex items-center justify-between gap-2 pt-1">
      <span className="text-[0.7rem] text-gray-500">Engine</span>
      <div className="flex items-center gap-1 text-[0.6rem]">
        {(['piper', 'external'] as const).map((m) => (
          <button
            key={m}
            onClick={() => voiceSettings.updateVoiceSettings({ ttsMode: m })}
            aria-pressed={voiceSettings.ttsMode === m}
            className={
              // D-S30: der gewaehlte Motor ist ein ZUSTAND und trug bisher
              // dieselbe graue Flaeche wie jede Aktion auf dem Bildschirm.
              // Dieselbe Akzentsprache wie der aktive Tab und der gewaehlte
              // Theme-Knopf.
              'px-2 py-0.5 rounded border transition-colors ' +
              (voiceSettings.ttsMode === m
                ? 'bg-lu-accent-soft text-gray-900 dark:text-white border-lu-accent-edge dark:border-lu-accent'
                : 'text-gray-500 border-white/8 hover:text-gray-300')
            }
          >
            {m === 'piper' ? 'Piper neural' : 'External HTTP'}
          </button>
        ))}
      </div>
    </div>
    {voiceSettings.ttsMode === 'external' && (
      <div className="space-y-1.5">
        <input
          value={voiceSettings.externalTtsUrl}
          onChange={(e) => voiceSettings.updateVoiceSettings({ externalTtsUrl: e.target.value })}
          placeholder="http://localhost:8880/v1/audio/speech"
          spellCheck={false}
          className="w-full px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/20"
        />
        <input
          value={voiceSettings.externalTtsVoice}
          onChange={(e) => voiceSettings.updateVoiceSettings({ externalTtsVoice: e.target.value })}
          placeholder="voice name (e.g. af_bella, alloy)"
          spellCheck={false}
          className="w-full px-2 py-1 rounded bg-transparent border border-white/8 text-[0.65rem] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-white/20"
        />
        <p className="text-[0.55rem] text-gray-500 leading-snug">
          Any OpenAI-compatible TTS endpoint (e.g. Kokoro-FastAPI). Used for read-aloud instead of Piper. Stays on your machine when the endpoint is local.
        </p>
      </div>
    )}
  </>)
}
