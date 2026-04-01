import { create } from "zustand";
import { persist } from "zustand/middleware";

interface VoiceState {
  // Transient state (not persisted)
  isRecording: boolean;
  isTranscribing: boolean;
  isSpeaking: boolean;
  transcript: string;

  // Persisted settings
  sttEnabled: boolean;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
  autoSendOnTranscribe: boolean;

  // Actions
  setRecording: (recording: boolean) => void;
  setTranscribing: (transcribing: boolean) => void;
  setSpeaking: (speaking: boolean) => void;
  setTranscript: (transcript: string) => void;
  updateVoiceSettings: (
    settings: Partial<{
      sttEnabled: boolean;
      ttsEnabled: boolean;
      ttsVoice: string;
      ttsRate: number;
      ttsPitch: number;
      autoSendOnTranscribe: boolean;
    }>
  ) => void;
  resetTransient: () => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
      // Transient state
      isRecording: false,
      isTranscribing: false,
      isSpeaking: false,
      transcript: "",

      // Persisted settings
      sttEnabled: true,
      ttsEnabled: false,
      ttsVoice: "",
      ttsRate: 1.0,
      ttsPitch: 1.0,
      autoSendOnTranscribe: true,

      // Actions
      setRecording: (recording) => set({ isRecording: recording }),
      setTranscribing: (transcribing) => set({ isTranscribing: transcribing }),
      setSpeaking: (speaking) => set({ isSpeaking: speaking }),
      setTranscript: (transcript) => set({ transcript }),

      updateVoiceSettings: (settings) => set((state) => ({ ...state, ...settings })),

      resetTransient: () =>
        set({
          isRecording: false,
          isTranscribing: false,
          isSpeaking: false,
          transcript: "",
        }),
    }),
    {
      name: "locally-uncensored-voice",
      partialize: (state) => ({
        sttEnabled: state.sttEnabled,
        ttsEnabled: state.ttsEnabled,
        ttsVoice: state.ttsVoice,
        ttsRate: state.ttsRate,
        ttsPitch: state.ttsPitch,
        autoSendOnTranscribe: state.autoSendOnTranscribe,
      }),
    }
  )
);
