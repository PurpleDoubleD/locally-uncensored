import type { SttMode, TtsMode } from "../lib/speech-route";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeJSONStorage } from "../lib/storage-quota"
import { VOICE_WORK_DEFAULTS } from "../lib/voice/work-scope"
import type { VoiceWorkScope } from "../lib/voice/work-scope"
import type { AgentWorkspace } from "../types/agent-workspace"

interface VoiceState {
  // Transient state (not persisted)
  isRecording: boolean;
  isTranscribing: boolean;
  isSpeaking: boolean;
  transcript: string;
  // Whether local Whisper STT is actually available. Probed at startup and
  // after the in-app install — transient (re-probed every launch) so a stale
  // "available" can never light up the mic on a machine where Whisper is gone,
  // and a fresh install lights it up without a restart.
  sttAvailable: boolean;
  // Whether local neural TTS (Piper) is installed + a voice model is present.
  // Same transient/probe model as sttAvailable.
  ttsAvailable: boolean;
  /** #77: why the last read-aloud fell back to the system voice
   *  although Piper is installed + selected. Transient, shown in Settings —
   *  the silent fallback made this class of failure undiagnosable. */
  ttsFallbackReason: string | null;
  /** Last dictation/transcription failure (human-readable, e.g. the cloud
   *  route's 429 "monthly credit budget exhausted") — shown by VoiceButton
   *  instead of silently dropping the take. Transient. */
  sttError: string | null;
  /** A dictation take whose transcription failed is kept for another try
   *  (lib/dictation-retry.ts). Only ever true on a phone. Transient. */
  retryTakeReady: boolean;

  // Persisted settings
  /** UNUSED, kept only so a persisted store from an older build still parses.
   *  Nothing reads it and Settings offers no switch for it: the microphone is
   *  gated on `sttAvailable` (a fresh probe of what is installed) plus cloud
   *  voice. Do not write user-facing copy against this flag. The mic tooltip
   *  used to say "Speech-to-text off. Enable it in Settings" and named exactly
   *  this dead flag as the cause, while the real cause was a missing
   *  faster-whisper (Gegenprobe 2026-08-30). Whether it gets removed or grown
   *  into a real switch is open (design question to the owner). */
  sttEnabled: boolean;
  ttsEnabled: boolean;
  /** Read each finished response aloud automatically (#77). Opt-in,
   *  default OFF — TTS on only surfaces the manual per-message Speaker button;
   *  this additionally auto-reads when the turn completes. */
  autoReadAloud: boolean;
  /** Selected Piper neural voice id (e.g. "en_US-lessac-medium"). */
  piperVoice: string;
  /** Browser SpeechSynthesis voice — only the fallback when neural is off. */
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  /** TTS engine: bundled Piper (local) or a user-configured external HTTP
   *  endpoint (OpenAI-compatible, e.g. Kokoro-FastAPI) — GitHub #58. */
  ttsMode: TtsMode;
  /** External TTS endpoint URL, e.g. http://localhost:8880/v1/audio/speech. */
  externalTtsUrl: string;
  /** Voice name passed to the external engine (e.g. "af_bella" / "alloy"). */
  externalTtsVoice: string;
  /** Model name for the external TTS engine; empty sends OpenAI's "tts-1".
   *  Ollama needs its own name here, e.g. "lfm3-audio:2b" (N1). */
  externalTtsModel: string;
  /** Speech-to-text engine for dictation: the local faster-whisper, an
   *  OpenAI-compatible /v1/audio/transcriptions endpoint such as Ollama
   *  serving LFM3 Audio, or the LU Engine with LFM3 Audio/Omni loaded (N1,
   *  lib/speech-route.ts). */
  sttMode: SttMode;
  /** External STT endpoint, e.g. http://localhost:11434/v1/audio/transcriptions. */
  externalSttUrl: string;
  /** Model the external STT endpoint transcribes with, e.g. "lfm3-audio:2b". */
  externalSttModel: string;
  /** MiniMax voice for the cloud TTS endpoint (appMode 'cloud'). */
  cloudTtsVoice: string;
  /** The microphone for dictation and Voice, empty for the system default. */
  micId: string;
  /** The name of that microphone, to show it and to find it again while it is unplugged or under a new id. */
  micLabel: string;
  /** Voice surface: a session starts with the microphone muted. */
  loopStartMuted: boolean;
  /** Voice surface: a short quiet sound says that a session is listening. */
  loopStartSound: boolean;
  /** Voice surface: the model may use the agent tools. Off, it talks and searches the web (GitHub #187). */
  loopAgent: boolean;
  /** Voice surface: where the tools may work. */
  loopScope: VoiceWorkScope;
  /** Voice surface: the folder picked there, null for the default folder or the session's own. */
  loopWorkspace: AgentWorkspace | null;
  /** Voice surface: the user confirmed once what "Whole computer" means. */
  loopComputerConfirmed: boolean;
  /** Voice surface: the model may think before it answers, and the thought is shown. */
  loopThinking: boolean;
  /** Voice surface: how long a thought may get, in tokens. */
  loopThinkingBudget: number;

  // Actions
  setRecording: (recording: boolean) => void;
  setTranscribing: (transcribing: boolean) => void;
  setSpeaking: (speaking: boolean) => void;
  setTranscript: (transcript: string) => void;
  setSttAvailable: (available: boolean) => void;
  setTtsAvailable: (available: boolean) => void;
  setTtsFallbackReason: (reason: string | null) => void;
  setSttError: (error: string | null) => void;
  setRetryTakeReady: (ready: boolean) => void;
  setPiperVoice: (voice: string) => void;
  updateVoiceSettings: (
    settings: Partial<{
      sttEnabled: boolean;
      ttsEnabled: boolean;
      autoReadAloud: boolean;
      ttsVoice: string;
      ttsRate: number;
      ttsPitch: number;
      ttsMode: TtsMode;
      externalTtsUrl: string;
      externalTtsVoice: string;
      externalTtsModel: string;
      sttMode: SttMode;
      externalSttUrl: string;
      externalSttModel: string;
      cloudTtsVoice: string;
      micId: string;
      micLabel: string;
      loopStartMuted: boolean;
      loopStartSound: boolean;
      loopAgent: boolean;
      loopScope: VoiceWorkScope;
      loopWorkspace: AgentWorkspace | null;
      loopComputerConfirmed: boolean;
      loopThinking: boolean;
      loopThinkingBudget: number;
    }>
  ) => void;
  resetTransient: () => void;
  /** GitHub #59 — restore the persisted voice settings to factory defaults.
   *  Transient probe state (sttAvailable/ttsAvailable) is left alone: it
   *  reflects what is installed on disk, not a preference. */
  resetVoiceDefaults: () => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
      // Transient state
      isRecording: false,
      isTranscribing: false,
      isSpeaking: false,
      transcript: "",
      sttAvailable: false,
      ttsAvailable: false,
      ttsFallbackReason: null,
      sttError: null,
      retryTakeReady: false,

      // Persisted settings — voice OFF by default (2026-06-07:
      // "tts und stt standardmäßig AUS und nicht immer automatisch vorlesen").
      // STT and TTS are opt-in. TTS on surfaces the per-message read-aloud
      // Speaker button; auto-reading is a SEPARATE opt-in (autoReadAloud, default
      // OFF) so "always read aloud" stays off unless the user asks for it (#77).
      sttEnabled: false,
      ttsEnabled: false,
      autoReadAloud: false,
      piperVoice: "en_US-lessac-medium",
      ttsVoice: "",
      ttsRate: 1.0,
      ttsPitch: 1.0,
      ttsMode: "piper",
      externalTtsUrl: "",
      externalTtsVoice: "",
      externalTtsModel: "",
      sttMode: "whisper",
      externalSttUrl: "",
      externalSttModel: "",
      cloudTtsVoice: "Wise_Woman",
      micId: "",
      micLabel: "",
      loopStartMuted: false,
      loopStartSound: true,
      ...VOICE_WORK_DEFAULTS,

      // Actions
      setRecording: (recording) => set({ isRecording: recording }),
      setTranscribing: (transcribing) => set({ isTranscribing: transcribing }),
      setSpeaking: (speaking) => set({ isSpeaking: speaking }),
      setTranscript: (transcript) => set({ transcript }),
      setSttAvailable: (available) => set({ sttAvailable: available }),
      setTtsAvailable: (available) => set({ ttsAvailable: available }),
      setTtsFallbackReason: (reason) => set({ ttsFallbackReason: reason }),
      setSttError: (error) => set({ sttError: error }),
      setRetryTakeReady: (ready) => set({ retryTakeReady: ready }),
      setPiperVoice: (voice) => set({ piperVoice: voice }),

      // A fallback reason belongs to the engine that failed: switching the
      // engine drops it, so a Piper reason never shows under External (B11).
      updateVoiceSettings: (settings) => set((state) => ({
        ...state,
        ...settings,
        ...(settings.ttsMode !== undefined && settings.ttsMode !== state.ttsMode ? { ttsFallbackReason: null } : {}),
      })),

      resetTransient: () =>
        set({
          isRecording: false,
          isTranscribing: false,
          isSpeaking: false,
          transcript: "",
          sttError: null,
        }),

      resetVoiceDefaults: () =>
        set({
          sttEnabled: false,
          ttsEnabled: false,
          autoReadAloud: false,
          piperVoice: "en_US-lessac-medium",
          ttsVoice: "",
          ttsRate: 1.0,
          ttsPitch: 1.0,
          ttsMode: "piper",
          externalTtsUrl: "",
          externalTtsVoice: "",
          externalTtsModel: "",
          sttMode: "whisper",
          externalSttUrl: "",
          externalSttModel: "",
          cloudTtsVoice: "Wise_Woman",
          micId: "",
      micLabel: "",
          loopStartMuted: false,
          loopStartSound: true,
          ...VOICE_WORK_DEFAULTS,
        }),
    }),
    {
      name: "locally-uncensored-voice",
      storage: safeJSONStorage(),
      partialize: (state) => ({
        sttEnabled: state.sttEnabled,
        ttsEnabled: state.ttsEnabled,
        autoReadAloud: state.autoReadAloud,
        piperVoice: state.piperVoice,
        ttsVoice: state.ttsVoice,
        ttsRate: state.ttsRate,
        ttsPitch: state.ttsPitch,
        // GitHub #58 — persist the engine choice + external endpoint. Without
        // these the store reverts to ttsMode:"piper" with an empty URL on the
        // next launch, so picking "External HTTP" never sticks and the output
        // stays Piper (a user-batshon: "after saving it still shows Piper").
        ttsMode: state.ttsMode,
        externalTtsUrl: state.externalTtsUrl,
        cloudTtsVoice: state.cloudTtsVoice,
        externalTtsVoice: state.externalTtsVoice,
        externalTtsModel: state.externalTtsModel,
        sttMode: state.sttMode,
        externalSttUrl: state.externalSttUrl,
        externalSttModel: state.externalSttModel,
        micId: state.micId,
        micLabel: state.micLabel,
        loopStartMuted: state.loopStartMuted,
        loopStartSound: state.loopStartSound,
        loopAgent: state.loopAgent,
        loopScope: state.loopScope,
        loopWorkspace: state.loopWorkspace,
        loopComputerConfirmed: state.loopComputerConfirmed,
        loopThinking: state.loopThinking,
        loopThinkingBudget: state.loopThinkingBudget,
      }),
    }
  )
);
