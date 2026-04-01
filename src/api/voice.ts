/**
 * Voice API — 100% local
 * STT: Local Whisper (faster-whisper or openai-whisper) via /local-api/transcribe
 * TTS: Browser SpeechSynthesis (runs locally in the browser, no cloud)
 */

export function isSpeechRecognitionSupported(): boolean {
  // Always true — we use local Whisper, not browser SpeechRecognition API
  return true;
}

export function isSpeechSynthesisSupported(): boolean {
  return !!window.speechSynthesis;
}

export function getAvailableVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSynthesisSupported()) return [];

  let voices = window.speechSynthesis.getVoices();

  if (voices.length === 0) {
    // Voices may load asynchronously; trigger the load
    window.speechSynthesis.onvoiceschanged = () => {};
    voices = window.speechSynthesis.getVoices();
  }

  return voices;
}

export function getVoicesAsync(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isSpeechSynthesisSupported()) {
      resolve([]);
      return;
    }

    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve(voices);
      return;
    }

    window.speechSynthesis.onvoiceschanged = () => {
      resolve(window.speechSynthesis.getVoices());
    };

    // Fallback timeout in case onvoiceschanged never fires
    setTimeout(() => {
      resolve(window.speechSynthesis.getVoices());
    }, 1000);
  });
}

export function speak(
  text: string,
  voice?: SpeechSynthesisVoice,
  rate: number = 1.0,
  pitch: number = 1.0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isSpeechSynthesisSupported()) {
      reject(new Error("Speech synthesis not supported"));
      return;
    }

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.pitch = pitch;

    utterance.onend = () => resolve();
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") {
        resolve();
      } else {
        reject(new Error(`Speech synthesis error: ${event.error}`));
      }
    };

    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Speak text sentence by sentence for streaming-style playback.
 * Each sentence is spoken sequentially, allowing early interruption
 * via stopSpeaking() between sentences.
 */
export async function speakStreaming(
  text: string,
  voice?: SpeechSynthesisVoice,
  rate?: number,
  pitch?: number
): Promise<void> {
  if (!isSpeechSynthesisSupported()) return;
  stopSpeaking();

  // Split into sentences (keeping the punctuation)
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // Check if speech was cancelled between sentences
    if (!window.speechSynthesis) return;

    await new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(trimmed);
      if (voice) utterance.voice = voice;
      if (rate !== undefined) utterance.rate = rate;
      if (pitch !== undefined) utterance.pitch = pitch;

      utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        if (event.error === "canceled" || event.error === "interrupted") {
          resolve();
        } else {
          reject(new Error(`Speech synthesis error: ${event.error}`));
        }
      };

      window.speechSynthesis.speak(utterance);
    });
  }
}

export function stopSpeaking(): void {
  if (isSpeechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
}

// --- Local Whisper STT ---

export async function checkWhisperAvailable(): Promise<{
  available: boolean;
  backend: string | null;
  error?: string;
}> {
  try {
    const res = await fetch("/local-api/transcribe-status");
    return res.json();
  } catch {
    return { available: false, backend: null, error: "Failed to reach transcribe-status endpoint" };
  }
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const res = await fetch("/local-api/transcribe", {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.transcript || "";
}

// --- Audio Recorder (MediaRecorder only, NO SpeechRecognition) ---

export interface AudioRecorder {
  start: () => Promise<void>;
  stop: () => Promise<Blob>;
  isRecording: () => boolean;
}

export function createAudioRecorder(): AudioRecorder {
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let recording = false;

  return {
    start: async () => {
      audioChunks = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.start(250); // Collect data every 250ms
      recording = true;
    },

    stop: () => {
      return new Promise<Blob>((resolve) => {
        recording = false;

        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          mediaRecorder.onstop = () => {
            const blob = new Blob(audioChunks, {
              type: mediaRecorder?.mimeType || "audio/webm",
            });

            // Stop all tracks on the stream
            mediaRecorder?.stream.getTracks().forEach((track) => track.stop());
            mediaRecorder = null;

            resolve(blob);
          };

          mediaRecorder.stop();
        } else {
          resolve(new Blob([], { type: "audio/webm" }));
        }
      });
    },

    isRecording: () => recording,
  };
}
