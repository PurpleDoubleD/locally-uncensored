import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useCloudAuthStore, deriveCloudAvailable } from "../stores/cloudAuthStore";
import {
  recheckWhisperAvailable,
  recheckTtsAvailable,
  synthesizeNeural,
  synthesizeExternal,
  synthesizeCloud,
  chunkForTts,
  playNeuralAudio,
  stopNeuralAudio,
  isSpeechSynthesisSupported,
  speak,
  speakStreaming,
  stopSpeaking as stopSpeakingApi,
  getVoicesAsync,
  createAudioRecorder,
  transcribeAudio,
  transcribeAudioCloud,
  getLastTtsStatus,
  LocalSttError,
  type AudioRecorder,
} from "../api/voice";
import { CloudJobError } from "../api/cloud/client";
import { requestLimitMessageOf } from "../lib/request-limit";
import { isTauri } from "../api/backend";
import { systemVoiceFallbackAllowed } from "../lib/mobile-prefs";
import { log } from "../lib/logger";
import { registerAutoSpeak } from "../lib/ttsBridge";
import { hasLocalVoice } from "../lib/capabilities";
import { isMobile } from "../lib/device-kind";
import { onAppBackground } from "../lib/app-lifecycle";
import { signalCreditsExhausted } from "../lib/credits-exhausted";
import { discardFailedTake, failedTake, keepFailedTake } from "../lib/dictation-retry";
import { MOBILE_TEXT, platformText } from "../lib/platform-text";
import { cloudContentAllowed, cloudContentConsented } from "../lib/cloud-content-gate";
import { DICTATION_TEXT, MIN_TAKE_MS, phoneDictationError, takeCannotSucceed, wavDurationMs } from "../lib/dictation-errors";

/**
 * Whether dictation and read-aloud go through LU Cloud.
 *
 * On the desktop that follows the app mode: a user in local mode has Whisper
 * and Piper and must not be billed for a sentence. A phone has neither, so
 * there the cloud voice is on whenever the account can use it, whatever the
 * app mode says. Tied to the mode, the microphone of a phone in local mode
 * (on-device chat) was simply dead.
 */
export function cloudVoiceActive(appMode: string, cloudUsable: boolean): boolean {
  return hasLocalVoice() ? appMode === "cloud" && cloudUsable : cloudUsable;
}

/** True for the cloud's "the wallet is empty" answer. */
function isOutOfCredits(err: unknown): boolean {
  return err instanceof CloudJobError && err.status === 429 && err.code === "credits_exhausted";
}

/**
 * On a phone an empty wallet opens the credits dialog, from dictation and from
 * read-aloud alike. It used to end as a red line under the microphone, and for
 * read-aloud as a silent switch to the system voice. Returns whether it fired.
 * The desktop keeps its line (the same gap exists there, see the final report).
 */
export function signalVoiceOutOfCredits(err: unknown): boolean {
  if (!isMobile() || !isOutOfCredits(err)) return false;
  signalCreditsExhausted("credits");
  return true;
}

// Honest, actionable copy for dictation failures. The cloud route's own error
// strings (403 "your plan does not include cloud voice", 429 "monthly credit
// budget exhausted") are already human-readable — pass those through.
export function sttErrorMessage(err: unknown): string {
  // A refused /local-api call, or the whisper handler's own report. Both
  // already say what went wrong in English (#115): "Transcription request
  // refused (HTTP 415): Unsupported Media Type...", "Whisper not available".
  // These used to arrive as a bare Error and were replaced by the microphone
  // hint, which sent people looking at their mic instead of the real cause.
  if (err instanceof LocalSttError && err.message.trim()) return err.message.trim();
  if (err instanceof CloudJobError) {
    // A phone names what the server answered (lib/dictation-errors.ts).
    if (isMobile()) {
      const said = phoneDictationError(err.status, err.message, err.code);
      if (said) return said;
    }
    if (err.status === 401) return platformText("sttSignedOut");
    if (err.status === 413) return "Recording too long, try a shorter take";
    if (err.status >= 500) return platformText("sttCloudDown");
    // A request limit: the server's sentence, or ours when it sent only the
    // status label. Nothing is booked before this guard on the server.
    if (err.status === 429) return requestLimitMessageOf(err, { nothingCharged: true, again: "try again" });
    return err.message;
  }
  // Local Whisper rejects with the Rust error STRING, and those are written for
  // the user ("Speech-to-text needs faster-whisper, which is not installed…").
  // Swallowing them behind the microphone hint sent people looking in entirely
  // the wrong place. A real JS Error keeps the generic line — its message is
  // for us, not for them.
  if (typeof err === "string" && err.trim()) return err.trim();
  return platformText("transcriptionFailed");
}

/**
 * Transcribe one finished take and report the outcome in the voice store.
 *
 * Module level, not inside the hook: the first try (stopRecording) and a
 * retry of a kept take (retryDictation) are the same work, and it can be
 * tested without mounting anything.
 *
 * On a phone a take that could not be transcribed is kept for another try,
 * unless the server's answer is one no retry changes (too long, empty,
 * unreadable, not in the plan; lib/dictation-errors.ts). An
 * empty wallet opens the credits dialog. Without cloud voice a phone has
 * nothing to transcribe with, so it says so instead of calling a local
 * Whisper that does not exist there.
 */
export async function transcribeTake(blob: Blob, cloudVoice: boolean): Promise<string> {
  const store = useVoiceStore.getState();
  if (!cloudVoice && !hasLocalVoice()) {
    keepFailedTake(blob);
    store.setSttError(MOBILE_TEXT.dictationNeedsCloud);
    store.setTranscribing(false);
    return "";
  }
  // Busy from the first step on, the length check included: a take that is
  // still on its way is never shown as "nothing going on" (mobile round 48,
  // the composer offered the microphone there, and its text then landed under
  // a tap meant for the microphone, on Send).
  store.setTranscribing(true);
  try {
    // A phone does not send a take too short to hold a word: it costs a request
    // and comes back empty or as an error (mobile round 44).
    if (isMobile()) {
      const ms = await wavDurationMs(blob);
      if (ms !== null && ms < MIN_TAKE_MS) {
        discardFailedTake();
        store.setSttError(DICTATION_TEXT.tooShort);
        return "";
      }
    }
    const transcript = cloudVoice ? await transcribeAudioCloud(blob) : await transcribeAudio(blob);
    discardFailedTake();
    store.setTranscript(transcript);
    // A silent take is not an error, but it must not be silence in the UI
    // too: the bubble says so and clears itself after six seconds.
    const nothingHeard = noSpeechMessage(transcript);
    if (nothingHeard) store.setSttError(nothingHeard);
    return transcript;
  } catch (err) {
    log.error("Whisper transcription error", { err });
    // Too long, empty, unreadable, not in the plan: no retry of this take
    // changes that, so it is not kept behind a retry button.
    const hopeless = err instanceof CloudJobError && takeCannotSucceed(err.status, err.message, err.code);
    if (hopeless) discardFailedTake();
    else keepFailedTake(blob);
    signalVoiceOutOfCredits(err);
    store.setSttError(sttErrorMessage(err));
    return "";
  } finally {
    store.setTranscribing(false);
  }
}

/**
 * The app left the screen while a dictation was running (phone only, wired
 * through lib/app-lifecycle.ts). The system suspends the microphone there, so
 * the take ends here. What was said so far is kept for a retry instead of
 * being thrown away, and the user is told why the recording stopped.
 */
export async function haltRecorderForBackground(rec: AudioRecorder | null): Promise<void> {
  if (!rec?.isRecording()) return;
  const store = useVoiceStore.getState();
  store.setRecording(false);
  try {
    const blob = await rec.stop();
    if (keepFailedTake(blob)) store.setSttError(MOBILE_TEXT.dictationStoppedInBackground);
  } catch {
    /* the take is lost, the flag is cleared, nothing else to do */
  }
}

// ── The system voice as a preference (mobile round 2, audit L11) ────────────
//
// The settings of the phone have a switch "Use the system voice when Cloud is
// off". Nobody read it: read-aloud fell back to the voice of the WebView
// whatever the switch said. The shell hands the answer in here, so this file
// keeps knowing nothing about the phone's own settings store. On a desktop
// the answer is never asked and nothing changes.
// The default reads the switch of the phone settings straight from storage
// (lib/mobile-prefs.ts): it holds before any screen has handed in a check of
// its own. On a desktop the key does not exist and the answer is yes.
let systemVoiceAllowed: () => boolean = systemVoiceFallbackAllowed;

/** Seam for the mobile shell: may read-aloud use the voice of the system.
 *  Pass null to go back to the saved switch. */
export function setSystemVoiceAllowed(check: (() => boolean) | null): void {
  systemVoiceAllowed = check ?? systemVoiceFallbackAllowed;
}

// ── The voice of the phone, behind one door (mobile round 3) ────────────────
//
// The Android System WebView has no `speechSynthesis`, so a phone may speak
// through its native layer instead. Which of the two a phone has is decided in
// ONE place of the shell (src/mobile/lib/speech.ts). This file does not import
// the shell; the shell hands its door in here, the same way it hands in the
// switch above. Without a door (desktop, tests, a shell that has not started)
// everything below behaves as it did: the WebView speaks or nothing does.

/** The door of the shell to the voice of the phone. */
export interface PhoneSpeechDoor {
  /** 'web' or 'native' when the phone has a voice, 'none' when it has none, null while that is not known yet. */
  source: () => "web" | "native" | "none" | null;
  /** Reads the text and resolves when it was read or stopped. `spoken: false`: there was no voice. */
  speak: (text: string, options: { voiceId?: string; rate?: number; pitch?: number }) => Promise<{ spoken: boolean }>;
  stop: () => void;
}

let phoneSpeech: PhoneSpeechDoor | null = null;

/** Seam for the mobile shell: the one door to the voice of the phone. Pass null to take it away. */
export function setPhoneSpeech(door: PhoneSpeechDoor | null): void {
  phoneSpeech = door;
}

/** Does this device have a voice of its own. On a phone the door answers, once it knows. */
function systemVoicePresent(): boolean {
  if (isMobile() && phoneSpeech) {
    try {
      const source = phoneSpeech.source();
      if (source !== null) return source !== "none";
    } catch {
      /* a door that fails is asked no further, the WebView answers */
    }
  }
  return isSpeechSynthesisSupported();
}

/** Is there a system voice, and may it be used. On a desktop the second half
 *  is always yes. Never throws: a check that fails counts as allowed. */
export function systemVoiceUsable(): boolean {
  if (!systemVoicePresent()) return false;
  if (!isMobile()) return true;
  try {
    return systemVoiceAllowed() !== false;
  } catch {
    return true;
  }
}

// ── The level of the microphone while a dictation records (audit L18) ───────
//
// A number from 0 to 1, a few times a second, so the recording line can show
// that the phone hears something. It lives outside the voice store on
// purpose: a store field would repaint every component that uses the hook
// ten times a second. `useVoiceLevel()` is for the one component that draws
// the meter, `useVoice().getLevel()` for anybody who wants to read it once.
//
// The recorder (api/voice.ts) does not hand out its stream, so the meter
// takes the stream at the moment the recorder asks the browser for it and
// listens to it through an analyser of its own. Measured only on a phone, so
// a desktop recording is exactly what it was. A meter that cannot be built
// never costs the take: the level then stays at 0.
let micLevel = 0;
const levelListeners = new Set<() => void>();

function setMicLevel(next: number): void {
  const value = Math.max(0, Math.min(1, Number.isFinite(next) ? next : 0));
  if (value === micLevel) return;
  if (Math.abs(value - micLevel) < 0.01 && value !== 0) return;
  micLevel = value;
  for (const notify of [...levelListeners]) notify();
}

/** The level right now, 0 while nothing records. */
export function voiceLevel(): number {
  return micLevel;
}

export function subscribeVoiceLevel(listener: () => void): () => void {
  levelListeners.add(listener);
  return () => {
    levelListeners.delete(listener);
  };
}

/** Live level of the microphone, 0 to 1. Repaints only the component that calls it. */
export function useVoiceLevel(): number {
  return useSyncExternalStore(subscribeVoiceLevel, voiceLevel, () => 0);
}

/**
 * Pure: the loudness of one block of 8 bit samples around 128, as a level
 * from 0 to 1. Quiet speech has a root mean square of a few percent of full
 * scale, so the value is stretched; the meter is for "does it hear me", not
 * for measuring.
 */
export function levelFromSamples(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return Math.max(0, Math.min(1, rms * 4));
}

export const LEVEL_INTERVAL_MS = 90;

export interface LevelMeter {
  stop: () => void;
}

/** Listen to a microphone stream and report its level. Null when this WebView cannot. */
export function startLevelMeter(stream: MediaStream): LevelMeter | null {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const samples = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      // Rises at once, falls slowly: a bar that drops to nothing between words reads as broken.
      const now = levelFromSamples(samples);
      setMicLevel(now >= micLevel ? now : micLevel * 0.6 + now * 0.4);
    }, LEVEL_INTERVAL_MS);
    return {
      stop: () => {
        clearInterval(timer);
        try { source.disconnect(); } catch { /* noop */ }
        try { void ctx.close(); } catch { /* noop */ }
        setMicLevel(0);
      },
    };
  } catch {
    return null;
  }
}

function dropMeter(ref: { current: LevelMeter | null }): void {
  const meter = ref.current;
  ref.current = null;
  try {
    meter?.stop();
  } catch {
    /* the meter is going away anyway */
  }
}

/**
 * Start the recorder and hand back the stream it took from the browser, or
 * null when the stream could not be seen. The recorder asks for the
 * microphone exactly once inside `start()`; for that one call the request
 * goes through here.
 */
export async function startRecorderWithStream(recorder: AudioRecorder): Promise<MediaStream | null> {
  const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  const original = devices?.getUserMedia;
  if (!devices || typeof original !== "function") {
    await recorder.start();
    return null;
  }
  let seen: MediaStream | null = null;
  let patched = false;
  const hadOwn = Object.prototype.hasOwnProperty.call(devices, "getUserMedia");
  try {
    devices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const stream = await original.call(devices, constraints);
      seen = stream;
      return stream;
    };
    patched = true;
  } catch {
    /* a WebView that does not let the function be replaced: record without a meter */
  }
  try {
    await recorder.start();
  } finally {
    if (patched) {
      try {
        // Put back exactly what was there: the method of the prototype, or an own one.
        if (hadOwn) devices.getUserMedia = original;
        else delete (devices as { getUserMedia?: unknown }).getUserMedia;
      } catch { /* noop */ }
    }
  }
  return seen;
}

/** What to tell the user when a take came back with no words in it.
 *
 * B4 Gegenprobe, 29.08.: a silent recording ended in nothing at all. No text,
 * no hint, the composer simply unchanged, and the user with no way to tell a
 * silent room from a broken microphone. Whisper answers a silent clip with an
 * empty transcript and a 200, which is not a failure, so nothing on the error
 * path ever fired.
 *
 * Returns null when there IS something to insert, so the caller can hand the
 * answer straight to setSttError.
 *
 * Whisper itself sometimes invents a word on silence, usually "You". That is
 * the model, not this code, and a transcript of "You" is indistinguishable
 * from someone actually saying it, so it is left alone.
 */
export function noSpeechMessage(transcript: string): string | null {
  return transcript.trim() ? null : "No speech detected, try again";
}

// Speak-generation counter + abort plumbing, module-scoped (NOT per hook
// instance) because playback is a process-wide singleton (one HTMLAudioElement
// in api/voice): every SpeakerButton mounts its own useVoice, and a Stop click
// from ANY bubble must invalidate the running cloud chunk loop. A per-instance
// counter let another button's Stop merely settle the current clip's await,
// after which the loop kept synthesizing — and billing — the next chunks.
// Same singleton pattern as useCloudCreate's activeJobId/activeAbort.
let speakGen = 0;
let speakAbort: AbortController | null = null;

// #77: the boot probe (App.tsx) can lose a cold-start race against
// resolve_lu_python and leave store.ttsAvailable stuck false, so read-aloud
// silently used the Windows SAPI voice and Piper never spoke. When we're about
// to concede to SAPI in local Piper mode, re-probe availability a bounded
// number of times per session (module-scoped so the whole app shares the
// budget across every SpeakerButton). A machine that really has Piper flips
// the store true on the first successful re-probe; a machine without it pays
// at most MAX_LAZY_TTS_REPROBES cheap find_spec spawns for the whole session.
let lazyTtsReprobes = 0;
const MAX_LAZY_TTS_REPROBES = 3;

export function stopSpeechPlayback(): void {
  // Invalidate the running speak generation (drops queued cloud chunks and any
  // synthesis that resolves late) and abort the in-flight cloud fetch — the
  // server cancels un-metered on a client abort.
  speakGen++;
  speakAbort?.abort();
  speakAbort = null;
  stopNeuralAudio();
  stopSpeakingApi();
  try {
    if (isMobile()) phoneSpeech?.stop();
  } catch {
    /* nothing was speaking */
  }
  useVoiceStore.getState().setSpeaking(false);
}

/** The notice when the external HTTP voice (#58) could not speak (B11). */
export function externalTtsFallbackReason(err: unknown, systemVoice: boolean): string {
  const detail = (err instanceof Error ? err.message : String(err)) || "no detail";
  return systemVoice
    ? `The external voice failed (${detail}). Read-aloud used the system voice instead.`
    : `The external voice failed (${detail}). No system voice is available, so nothing was read.`;
}

/**
 * Read-aloud on a phone.
 *
 * LU Cloud first, when the account can use it. If that fails, the system voice
 * (Web Speech) where the WebView has one, and a sentence that says so. No
 * Piper, no external engine, no probe of either: the commands behind them are
 * stubs on a phone, and their messages ("Piper is installed but not
 * responding") would send the user looking for a setting that does not exist.
 *
 * An empty wallet opens the credits dialog and reads nothing in a second
 * voice: a silent switch hid the reason, which is how it went unnoticed.
 *
 * Shares the generation counter and the abort of the desktop road, so Stop
 * from any bubble ends it.
 */
export async function speakOnPhone(text: string, streaming: boolean, cloudVoice: boolean): Promise<void> {
  const store = useVoiceStore.getState();
  if (!store.ttsEnabled) return;
  // The voice of the system, when there is one AND the user allows it
  // (setSystemVoiceAllowed). Switched off, read-aloud is cloud or nothing.
  const systemVoice = systemVoiceUsable();
  if (!cloudVoice && !systemVoice) {
    store.setTtsFallbackReason(MOBILE_TEXT.readAloudNeedsCloud);
    return;
  }
  // The text goes to LU Cloud only with the consent of the user (M1). A tap
  // on Read aloud asks; an answer that is read by itself (streaming) never
  // opens a sheet on its own, it stays with the system voice or says why.
  if (cloudVoice && !(streaming ? cloudContentConsented() : await cloudContentAllowed())) {
    if (!systemVoice) {
      store.setTtsFallbackReason(MOBILE_TEXT.readAloudNeedsConsent);
      return;
    }
    cloudVoice = false;
  }

  const gen = ++speakGen;
  speakAbort?.abort();
  const controller = new AbortController();
  speakAbort = controller;
  const stopped = () => gen !== speakGen;

  store.setSpeaking(true);
  try {
    if (cloudVoice) {
      const chunks = chunkForTts(text);
      let played = 0;
      try {
        for (const chunk of chunks) {
          if (stopped()) return;
          const url = await synthesizeCloud(chunk, store.cloudTtsVoice || undefined, controller.signal);
          if (stopped()) return;
          await playNeuralAudio(url);
          played++;
        }
        store.setTtsFallbackReason(null);
        return;
      } catch (err) {
        if (stopped()) return; // Stop aborted the fetch, nothing to fall back to
        log.error("Cloud TTS failed on a phone", { err });
        if (signalVoiceOutOfCredits(err)) {
          store.setTtsFallbackReason(MOBILE_TEXT.readAloudOutOfCredits);
          return;
        }
        if (!systemVoice) {
          store.setTtsFallbackReason(MOBILE_TEXT.readAloudCloudFailed);
          return;
        }
        store.setTtsFallbackReason(MOBILE_TEXT.readAloudCloudFailedSystemVoice);
        // The chunks already heard (and paid for) are not read a second time.
        if (played > 0) text = chunks.slice(played).join(" ");
      }
    }
    if (!systemVoice || stopped()) return;
    if (phoneSpeech) {
      // The door of the shell: the WebView where it has a voice, the native layer where it has not.
      const result = await phoneSpeech.speak(text, { voiceId: store.ttsVoice || undefined, rate: store.ttsRate, pitch: store.ttsPitch });
      if (!result.spoken && !stopped()) store.setTtsFallbackReason(MOBILE_TEXT.readAloudNeedsCloud);
      return;
    }
    let voice: SpeechSynthesisVoice | undefined;
    if (store.ttsVoice) {
      const voices = await getVoicesAsync();
      voice = voices.find((v) => v.name === store.ttsVoice);
    }
    if (stopped()) return;
    if (streaming) await speakStreaming(text, voice, store.ttsRate, store.ttsPitch);
    else await speak(text, voice, store.ttsRate, store.ttsPitch);
  } catch (err) {
    log.error("Speech synthesis error", { err });
  } finally {
    // A newer speak/stop already owns the flag, do not clobber it.
    if (!stopped()) useVoiceStore.getState().setSpeaking(false);
  }
}

// Cloud transcribe caps the request body at 12 MiB — about 6.5 minutes of the
// 16 kHz/16-bit mono WAV the recorder produces (32,000 B/s). Auto-stop just
// under the cap (~340 s ≈ 10.9 MB) so a long take is transcribed instead of
// being rejected 413 wholesale.
const CLOUD_DICTATION_LIMIT_MS = 340_000;

export function useVoice() {
  const store = useVoiceStore();
  const recorderRef = useRef<AudioRecorder | null>(null);
  // The level meter of the running take (phone only), see startLevelMeter.
  const meterRef = useRef<LevelMeter | null>(null);
  // Streaming-dictation plumbing: a polling timer that transcribes the
  // audio-so-far while recording, and a single-in-flight guard so slow
  // (CPU Whisper) transcriptions never pile up.
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interimBusyRef = useRef(false);

  // Unmount teardown (e.g. view switch mid-dictation): kill the interim
  // transcribe interval and stop the recorder — recorder.stop() releases the
  // mic tracks and closes the AudioContext. Without this the leaked interval
  // keeps POSTing WAV snapshots forever, the mic stays hot, and the stuck
  // store.isRecording can never be cleared.
  useEffect(
    () => () => {
      if (streamTimerRef.current) {
        clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      dropMeter(meterRef);
      const rec = recorderRef.current;
      recorderRef.current = null;
      if (rec?.isRecording()) {
        void rec.stop().catch(() => {});
        useVoiceStore.getState().setRecording(false);
      }
    },
    [],
  );

  // Close-to-tray teardown: lib.rs intercepts CloseRequested with hide(), so
  // the webview stays fully alive — without this, read-aloud keeps talking and
  // a running dictation keeps the mic hot (and the PCM take growing) behind a
  // window the user believes is closed. lib.rs emits `app:hidden` right
  // before hiding; stop global playback and this instance's recorder.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen("app:hidden", () => {
        stopSpeechPlayback();
        if (streamTimerRef.current) {
          clearInterval(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        interimBusyRef.current = false;
        dropMeter(meterRef);
        const rec = recorderRef.current;
        recorderRef.current = null;
        if (rec?.isRecording()) {
          void rec.stop().catch(() => {});
          useVoiceStore.getState().setRecording(false);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Cloud mode routes voice through the metered lu-labs.ai endpoints — no
  // local Whisper/Piper install needed, both buttons just work.
  const appMode = useSettingsStore((s) => s.settings.appMode);
  const cloudUsable = useCloudAuthStore(deriveCloudAvailable);
  const cloudVoice = cloudVoiceActive(appMode, cloudUsable);

  // Reactive: the source of truth is the store flag set by the startup probe
  // (App.tsx) and the in-app install (Settings). Reading a module-level boolean
  // here was the bug — it never re-rendered when Whisper came up.
  const sttSupported = cloudVoice || store.sttAvailable;
  const ttsSupported = systemVoiceUsable();

  // Reactive neural-TTS availability (Piper), same model as sttAvailable.
  const ttsAvailable = cloudVoice || store.ttsAvailable;

  // External HTTP TTS engine configured + selected (#58). Lets the read-aloud
  // button light up even on a machine without Piper or browser voices.
  const ttsExternalReady = store.ttsMode === "external" && !!store.externalTtsUrl.trim();

  // Re-probe Whisper on demand (mic mount / after install) and sync the store.
  const recheckStt = useCallback(async (): Promise<boolean> => {
    const ok = await recheckWhisperAvailable();
    store.setSttAvailable(ok);
    return ok;
  }, [store]);

  // Re-probe neural TTS on demand (after install) and sync the store.
  const recheckTts = useCallback(async (): Promise<boolean> => {
    const ok = await recheckTtsAvailable(store.piperVoice);
    store.setTtsAvailable(ok);
    return ok;
  }, [store]);

  /**
   * Start dictation. If `onInterim` is supplied, the audio captured so far is
   * transcribed on a ~1.4 s cadence and streamed back so the input grows live
   * (Whisper isn't truly real-time, so this is chunked, not word-by-word). A
   * single-in-flight guard skips ticks while a transcription is still running,
   * so slow CPU transcriptions never queue up.
   */
  const startRecording = useCallback(
    async (onInterim?: (text: string) => void): Promise<boolean> => {
      if (recorderRef.current?.isRecording()) return true;

      store.setSttError(null);
      // A phone without cloud voice has nothing to transcribe with. Saying so
      // before the microphone opens beats recording a take nobody can read.
      if (!cloudVoice && !hasLocalVoice()) {
        store.setSttError(MOBILE_TEXT.dictationNeedsCloud);
        return false;
      }
      // Asked before the microphone opens: a recording goes to LU Cloud only
      // with the consent of the user (M1). Always yes on a desktop.
      if (cloudVoice && !(await cloudContentAllowed())) {
        store.setSttError(MOBILE_TEXT.dictationNeedsConsent);
        return false;
      }
      // A new take replaces one that was kept for a retry (phone only).
      discardFailedTake();
      const recorder = createAudioRecorder();
      recorderRef.current = recorder;

      try {
        if (isMobile()) {
          // The same start, with the stream handed out for the level meter.
          const stream = await startRecorderWithStream(recorder);
          dropMeter(meterRef);
          meterRef.current = stream ? startLevelMeter(stream) : null;
        } else {
          await recorder.start();
        }
        store.setRecording(true);
        store.setTranscript("");

        // Cloud STT meters a FLAT rate per request — an interim tick every
        // 1.4 s would bill a full transcription each time. Cloud dictation
        // transcribes the final take only.
        if (onInterim && !cloudVoice) {
          streamTimerRef.current = setInterval(async () => {
            const rec = recorderRef.current;
            if (!rec?.isRecording() || interimBusyRef.current) return;
            const snap = rec.snapshot();
            // ~0.4 s of 16 kHz / 16-bit mono ≈ 12.8 KB — wait for a little audio.
            if (!snap || snap.size < 12000) return;
            interimBusyRef.current = true;
            try {
              const partial = await transcribeAudio(snap);
              if (recorderRef.current?.isRecording() && partial.trim()) {
                store.setTranscript(partial.trim());
                onInterim(partial.trim());
              }
            } catch {
              /* interim failures are non-fatal — the final transcribe still runs */
            } finally {
              interimBusyRef.current = false;
            }
          }, 1400);
        }
        return true;
      } catch (err) {
        log.error("Failed to start recording", { err });
        if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
        interimBusyRef.current = false;
        dropMeter(meterRef);
        recorderRef.current = null;
        store.setSttError(platformText("micUnavailable"));
        return false;
      }
    },
    [store, cloudVoice],
  );

  const stopRecording = useCallback(async (): Promise<string> => {
    if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
    interimBusyRef.current = false;
    dropMeter(meterRef);
    if (!recorderRef.current) {
      // A leaked take (recorder lost to an unmount) can leave the flag stuck —
      // clear it so the mic button doesn't stay red forever.
      store.setRecording(false);
      return "";
    }

    try {
      // Stop recording and get the final WAV of the whole take.
      const blob = await recorderRef.current.stop();
      // Recording hands over to transcribing in one step, never through a
      // moment with neither (transcribeTake clears it on every way out).
      if (blob.size > 0) store.setTranscribing(true);
      store.setRecording(false);
      recorderRef.current = null;

      if (blob.size === 0) {
        // Stopped before the microphone delivered anything. A phone says so
        // instead of going quiet.
        if (isMobile()) store.setSttError(DICTATION_TEXT.tooShort);
        return "";
      }

      // Final full-take transcription — more accurate than the interim chunks.
      return await transcribeTake(blob, cloudVoice);
    } catch (err) {
      log.error("Failed to stop recording", { err });
      store.setRecording(false);
      store.setTranscribing(false);
      recorderRef.current = null;
      store.setSttError("Recording failed, try again");
      return "";
    }
  }, [store, cloudVoice]);

  // Phone only: a take whose transcription failed is kept (see transcribeTake)
  // and can be sent again without speaking it again.
  const retryDictation = useCallback(async (): Promise<string> => {
    const blob = failedTake();
    if (!blob) return "";
    store.setSttError(null);
    return transcribeTake(blob, cloudVoice);
  }, [store, cloudVoice]);

  const discardDictation = useCallback(() => {
    discardFailedTake();
    store.setSttError(null);
  }, [store]);

  // Phone only: leaving the screen ends read-aloud and dictation. `app:hidden`
  // above never arrives on a phone; this is its counterpart, through the
  // lifecycle seam. Unlike the desktop, the take so far is kept for a retry.
  useEffect(() => {
    if (!isMobile()) return;
    return onAppBackground(() => {
      stopSpeechPlayback();
      if (streamTimerRef.current) {
        clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      interimBusyRef.current = false;
      dropMeter(meterRef);
      const rec = recorderRef.current;
      recorderRef.current = null;
      void haltRecorderForBackground(rec);
    });
  }, []);

  // Speak `text`. Prefers local neural TTS (Piper) when installed; otherwise
  // falls back to the browser's SpeechSynthesis voices. `streaming` only
  // affects the browser path (sentence-by-sentence so it starts sooner) —
  // neural always synthesizes the whole utterance in one local call.
  const speakInternal = useCallback(
    async (text: string, streaming: boolean) => {
      // A phone has no Piper and no external engine process: its own, shorter
      // road (LU Cloud, then the system voice, never a local probe).
      if (!hasLocalVoice()) return speakOnPhone(text, streaming, cloudVoice);
      if (!store.ttsEnabled) return;
      // An external HTTP engine (#58) needs a configured URL; Piper needs to be
      // installed; the browser path needs SpeechSynthesis; cloud mode brings
      // its own hosted engine. Bail only if none of them can speak.
      const externalReady = store.ttsMode === "external" && !!store.externalTtsUrl.trim();
      if (!cloudVoice && !externalReady && !store.ttsAvailable && !ttsSupported) return;

      const gen = ++speakGen;
      // A new read-aloud (from any bubble) supersedes a running one — abort
      // its in-flight synthesis un-metered instead of leapfrogging playback.
      speakAbort?.abort();
      const controller = new AbortController();
      speakAbort = controller;
      const stopped = () => gen !== speakGen;

      store.setSpeaking(true);
      try {
        // Cloud mode: hosted MiniMax TTS first; a failure (offline, 429)
        // falls through to whatever local engine exists. The server caps text
        // at 1500 chars, so long answers are chunked at sentence boundaries
        // and the MP3s played strictly sequentially — Stop cancels the whole
        // queue via the generation counter + the fetch abort.
        if (cloudVoice) {
          const chunks = chunkForTts(text);
          let played = 0;
          try {
            for (const chunk of chunks) {
              if (stopped()) return;
              const url = await synthesizeCloud(chunk, store.cloudTtsVoice || undefined, controller.signal);
              if (stopped()) return;
              await playNeuralAudio(url);
              played++;
            }
            return;
          } catch (err) {
            if (stopped()) return; // Stop click aborted the fetch — no fallback
            log.error("Cloud TTS failed, falling back to local engines", { err });
            // Resume from the failed chunk — the user already heard (and paid
            // for) the first `played` chunks; re-reading the whole text in a
            // different voice would double-play them.
            if (played > 0) text = chunks.slice(played).join(" ");
          }
        }
        // External HTTP TTS engine takes precedence when selected + configured.
        if (externalReady) {
          try {
            const url = await synthesizeExternal(text, store.externalTtsUrl.trim(), store.externalTtsVoice || undefined);
            if (stopped()) return;
            await playNeuralAudio(url);
            store.setTtsFallbackReason(null);
            return;
          } catch (err) {
            if (stopped()) return;
            log.error("External TTS failed, falling back to browser voices", { err });
            // Jaeger B, B11: the same silent switch as Piper had (#77). Who
            // set up an own voice heard another one and was told nothing.
            // The reason is shown at the Read aloud button and in Settings.
            store.setTtsFallbackReason(externalTtsFallbackReason(err, ttsSupported));
          }
        } else {
          // Local neural (Piper). Trust the cached availability flag, but if it
          // is false while we're in local Piper mode, re-probe (bounded) before
          // conceding to the browser SAPI fallback — a racy boot probe must not
          // permanently silence Piper (#77). A positive re-probe is
          // written back to the store so later reads skip straight to Piper.
          let piperReady = store.ttsAvailable;
          if (!piperReady && lazyTtsReprobes < MAX_LAZY_TTS_REPROBES && store.ttsMode !== "external") {
            lazyTtsReprobes++;
            piperReady = await recheckTtsAvailable(store.piperVoice);
            if (stopped()) return;
            if (piperReady) store.setTtsAvailable(true);
          }
          if (piperReady) {
            try {
              const url = await synthesizeNeural(text, store.piperVoice);
              if (stopped()) return;
              await playNeuralAudio(url);
              store.setTtsFallbackReason(null);
              return;
            } catch (err) {
              if (stopped()) return;
              log.error("Neural TTS failed, falling back to browser voices", { err });
              // #77: this fallback was invisible — Piper installed
              // AND selected, yet every read-aloud spoke the system voice and
              // nothing in the app said why. Record the reason for Settings.
              store.setTtsFallbackReason(
                `Piper failed to speak (${err instanceof Error ? err.message : String(err)}). Read-aloud used the system voice instead.`,
              );
            }
          } else if (store.ttsMode !== "external") {
            // Say which of the three things is actually missing. The old text
            // asserted "installed but not responding" for all of them, so a
            // user who had never set Piper up was sent looking for a fault
            // that did not exist.
            const st = getLastTtsStatus();
            store.setTtsFallbackReason(
              st.piper === false
                ? "Neural TTS (Piper) is not set up yet, so read-aloud used the system voice. Install it in Settings → Voice."
                : st.voice === false
                  ? "No Piper voice is fully downloaded yet, so read-aloud used the system voice. Pick one in Settings → Voice."
                  : "Piper is installed but not responding, so read-aloud used the system voice instead.",
            );
          }
        }
        if (!ttsSupported || stopped()) return;
        let voice: SpeechSynthesisVoice | undefined;
        if (store.ttsVoice) {
          const voices = await getVoicesAsync();
          voice = voices.find((v) => v.name === store.ttsVoice);
        }
        if (stopped()) return;
        if (streaming) {
          await speakStreaming(text, voice, store.ttsRate, store.ttsPitch);
        } else {
          await speak(text, voice, store.ttsRate, store.ttsPitch);
        }
      } catch (err) {
        log.error("Speech synthesis error", { err });
      } finally {
        // A newer speak/stop already owns the flag — don't clobber it.
        if (!stopped()) store.setSpeaking(false);
      }
    },
    [store, ttsSupported, cloudVoice]
  );

  const speakText = useCallback((text: string) => speakInternal(text, false), [speakInternal]);
  const speakTextStreaming = useCallback((text: string) => speakInternal(text, true), [speakInternal]);

  // Publish the current streaming-speak fn so useChat/useAgentChat can auto-read
  // finished responses (#77) without subscribing to this store. Re-runs whenever
  // the fn is re-memoized (i.e. voice settings changed), keeping it fresh.
  useEffect(() => {
    registerAutoSpeak(speakTextStreaming);
  }, [speakTextStreaming]);

  // Module-scoped singleton — any instance's Stop halts the global playback.
  const stopSpeaking = useCallback(() => stopSpeechPlayback(), []);

  const clearSttError = useCallback(() => store.setSttError(null), [store]);

  /**
   * End a take without transcribing it. The message it was dictated into has
   * been sent with what the field showed, so a final transcript would only
   * fill the emptied field again (and, in cloud mode, bill a transcription
   * nobody reads). An interim answer still on its way is dropped by the
   * `isRecording()` check in the stream tick.
   */
  const cancelRecording = useCallback(async (): Promise<void> => {
    if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
    interimBusyRef.current = false;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    store.setRecording(false);
    if (!recorder) return;
    try {
      await recorder.stop();
    } catch (err) {
      log.error("Failed to stop a cancelled recording", { err });
    }
  }, [store]);

  return {
    isRecording: store.isRecording,
    isTranscribing: store.isTranscribing,
    isSpeaking: store.isSpeaking,
    transcript: store.transcript,
    sttError: store.sttError,
    clearSttError,
    sttSupported,
    ttsSupported,
    ttsAvailable,
    ttsExternalReady,
    ttsEnabled: store.ttsEnabled,
    /** Client-side dictation cap (ms) — cloud transcribe 413s past ~6.5 min.
     *  Null in local mode (no server limit). VoiceButton auto-stops at this. */
    maxRecordingMs: cloudVoice ? CLOUD_DICTATION_LIMIT_MS : null,
    /** The level of the microphone right now, 0 to 1. For a live meter use `useVoiceLevel()`. */
    getLevel: voiceLevel,
    /** Phone only: a take whose transcription failed is kept. Always false on
     *  a desktop. */
    canRetryDictation: store.retryTakeReady,
    retryDictation,
    discardDictation,
    startRecording,
    stopRecording,
    cancelRecording,
    recheckStt,
    recheckTts,
    speakText,
    speakTextStreaming,
    stopSpeaking,
  };
}
