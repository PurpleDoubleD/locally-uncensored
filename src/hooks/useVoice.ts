import { useCallback, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import {
  isSpeechRecognitionSupported,
  isSpeechSynthesisSupported,
  speak,
  speakStreaming,
  stopSpeaking as stopSpeakingApi,
  getVoicesAsync,
  createAudioRecorder,
  transcribeAudio,
  type AudioRecorder,
} from "../api/voice";

export function useVoice() {
  const store = useVoiceStore();
  const recorderRef = useRef<AudioRecorder | null>(null);

  const sttSupported = isSpeechRecognitionSupported();
  const ttsSupported = isSpeechSynthesisSupported();

  const startRecording = useCallback(async () => {
    if (recorderRef.current?.isRecording()) return;

    const recorder = createAudioRecorder();
    recorderRef.current = recorder;

    try {
      await recorder.start();
      store.setRecording(true);
      store.setTranscript("");
    } catch (err) {
      console.error("Failed to start recording:", err);
      recorderRef.current = null;
    }
  }, [store]);

  const stopRecording = useCallback(async (): Promise<string> => {
    if (!recorderRef.current) return "";

    try {
      // Stop recording and get the audio blob
      const blob = await recorderRef.current.stop();
      store.setRecording(false);
      recorderRef.current = null;

      if (blob.size === 0) return "";

      // Transcribe locally via Whisper
      store.setTranscribing(true);
      try {
        const transcript = await transcribeAudio(blob);
        store.setTranscript(transcript);
        return transcript;
      } catch (err) {
        console.error("Whisper transcription error:", err);
        return "";
      } finally {
        store.setTranscribing(false);
      }
    } catch (err) {
      console.error("Failed to stop recording:", err);
      store.setRecording(false);
      store.setTranscribing(false);
      recorderRef.current = null;
      return "";
    }
  }, [store]);

  const speakText = useCallback(
    async (text: string) => {
      if (!ttsSupported || !store.ttsEnabled) return;

      store.setSpeaking(true);

      try {
        let voice: SpeechSynthesisVoice | undefined;
        if (store.ttsVoice) {
          const voices = await getVoicesAsync();
          voice = voices.find((v) => v.name === store.ttsVoice);
        }

        await speak(text, voice, store.ttsRate, store.ttsPitch);
      } catch (err) {
        console.error("Speech synthesis error:", err);
      } finally {
        store.setSpeaking(false);
      }
    },
    [store, ttsSupported]
  );

  const speakTextStreaming = useCallback(
    async (text: string) => {
      if (!ttsSupported || !store.ttsEnabled) return;

      store.setSpeaking(true);

      try {
        let voice: SpeechSynthesisVoice | undefined;
        if (store.ttsVoice) {
          const voices = await getVoicesAsync();
          voice = voices.find((v) => v.name === store.ttsVoice);
        }

        await speakStreaming(text, voice, store.ttsRate, store.ttsPitch);
      } catch (err) {
        console.error("Speech synthesis streaming error:", err);
      } finally {
        store.setSpeaking(false);
      }
    },
    [store, ttsSupported]
  );

  const stopSpeaking = useCallback(() => {
    stopSpeakingApi();
    store.setSpeaking(false);
  }, [store]);

  return {
    isRecording: store.isRecording,
    isTranscribing: store.isTranscribing,
    isSpeaking: store.isSpeaking,
    transcript: store.transcript,
    sttSupported,
    ttsSupported,
    startRecording,
    stopRecording,
    speakText,
    speakTextStreaming,
    stopSpeaking,
  };
}
