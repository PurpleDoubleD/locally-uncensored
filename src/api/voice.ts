import { backendCall, isTauri } from "./backend";
import { cloudFetch, jsonOrError, CloudJobError } from "./cloud/client";

/**
 * Voice API.
 * Local mode: STT = local Whisper (faster-whisper) via /local-api/transcribe,
 * TTS = Piper / external engine / browser SpeechSynthesis.
 * Cloud mode (appMode 'cloud'): STT = Whisper large-v3-turbo, TTS = MiniMax
 * Speech-02 — both via the metered lu-labs.ai endpoints (useVoice picks).
 */

let whisperChecked = false
let whisperAvailable = false

export function isSpeechRecognitionSupported(): boolean {
  return whisperAvailable
}

// Call once at startup to check if Whisper is actually running
export async function initWhisperCheck(): Promise<boolean> {
  if (whisperChecked) return whisperAvailable
  try {
    const result = await checkWhisperAvailable()
    whisperAvailable = result.available
  } catch {
    whisperAvailable = false
  }
  whisperChecked = true
  return whisperAvailable
}

// Force a fresh availability probe, bypassing the one-shot cache. Used after
// the in-app faster-whisper install finishes, and when the mic button mounts
// while STT shows unavailable — the persistent Whisper server can take a while
// to load its model after boot, so the first startup probe may have been early.
export async function recheckWhisperAvailable(): Promise<boolean> {
  whisperChecked = false
  return initWhisperCheck()
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
 * Speak `text` via the browser SpeechSynthesis fallback.
 *
 * Speaks the whole text as ONE utterance. It used to split into per-sentence
 * utterances and chain them, which hit the well-known Chromium/WebView2 bug
 * where speak() issued right after cancel() silently no-ops — so onend for the
 * 2nd sentence never fired and playback died after the FIRST sentence (#77c,
 * ElBiggus: only "What do you call a fake noodle?" was read, never the punch
 * line). One utterance removes the chaining entirely; stopSpeaking() (cancel)
 * still interrupts instantly. A periodic resume() counters Chromium pausing the
 * synthesizer after ~15 s on a long answer.
 */
export async function speakStreaming(
  text: string,
  voice?: SpeechSynthesisVoice,
  rate?: number,
  pitch?: number
): Promise<void> {
  if (!isSpeechSynthesisSupported()) return;
  stopSpeaking();

  const synth = window.speechSynthesis;
  const trimmed = text.trim();
  if (!trimmed || !synth) return;

  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(trimmed);
    if (voice) utterance.voice = voice;
    if (rate !== undefined) utterance.rate = rate;
    if (pitch !== undefined) utterance.pitch = pitch;

    const keepAlive = setInterval(() => {
      try { synth.resume(); } catch { /* engine gone — onend/onerror will settle */ }
    }, 10000);
    let settled = false;
    const cleanup = () => { if (settled) return; settled = true; clearInterval(keepAlive); };

    utterance.onend = () => { cleanup(); resolve(); };
    utterance.onerror = (event) => {
      cleanup();
      if (event.error === "canceled" || event.error === "interrupted") {
        resolve();
      } else {
        reject(new Error(`Speech synthesis error: ${event.error}`));
      }
    };

    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (isSpeechSynthesisSupported()) {
    window.speechSynthesis.cancel();
  }
}

// --- Local Whisper STT ---

/**
 * A dictation failure whose message is already written FOR THE USER, so
 * useVoice shows it verbatim instead of the generic microphone hint.
 *
 * GitHub #115 (graysoncooper) had a second half behind the 415: the browser
 * transcribe path called res.json() on every answer. The /local-api gates
 * reply in text/plain, so a refusal died in the JSON parser, the thrown
 * SyntaxError carried no reason, and the bubble told the user to check the
 * microphone while the truth was a refused request. The same happened to the
 * handler's own 200-with-error bodies ("Whisper not available", "Whisper
 * model is still loading, please wait..."), which are honest English already.
 */
export class LocalSttError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "LocalSttError";
    this.status = status;
  }
}

/** Turn a refused /local-api answer into an English, user-facing failure.
 *  The gates answer text/plain, the handler answers JSON, so read the body as
 *  text and lift `error` out of it when it happens to be JSON. */
async function localApiFailure(res: Response, what: string): Promise<LocalSttError> {
  const raw = (await res.text().catch(() => "")).trim();
  let detail = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) detail = parsed.error.trim();
    } catch {
      /* not JSON after all, keep the raw text */
    }
  }
  // Cut at CHARACTER boundaries. whisper.rs once panicked on exactly this
  // mistake (a byte index landing inside a multibyte character), and in JS the
  // same cut through a surrogate pair leaves half a character that renders as
  // a replacement box in the red bubble.
  detail = Array.from(detail).slice(0, 200).join("");
  return new LocalSttError(
    detail ? `${what} (HTTP ${res.status}): ${detail}` : `${what} (HTTP ${res.status})`,
    res.status,
  );
}

export async function checkWhisperAvailable(): Promise<{
  available: boolean;
  backend: string | null;
  loading?: boolean;
  error?: string;
}> {
  try {
    if (isTauri()) {
      return await backendCall("whisper_status");
    }
    // The /local-api middleware refuses any request without the CSRF header
    // (403). backendCall sends it on every dev-mode call; these two voice
    // fetches went out bare, so the browser path never reached whisper
    // (GitHub #115).
    const res = await fetch("/local-api/transcribe-status", {
      headers: { "x-locally-uncensored": "true" },
    });
    // A refused probe answers text/plain, which used to blow up in res.json()
    // and left the mic disabled with no reason anywhere (#115).
    if (!res.ok) {
      const err = await localApiFailure(res, "Speech-to-text probe refused");
      return { available: false, backend: null, error: err.message };
    }
    return res.json();
  } catch {
    return { available: false, backend: null, error: "Failed to reach transcribe-status endpoint" };
  }
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  if (isTauri()) {
    // Convert blob to base64 for Tauri invoke
    const buffer = await audioBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const audioBase64 = btoa(binary);
    // Tauri maps the Rust snake_case params (audio_base64, content_type) to
    // camelCase invoke keys — passing snake_case silently fails the command
    // ("missing required key audioBase64") → every transcription returned
    // nothing. THIS was the "mic records but no text" bug.
    const data = await backendCall("transcribe", {
      audioBase64,
      contentType: audioBlob.type || "audio/wav",
    });
    // The Rust side writes these for the user ("Speech-to-text needs
    // faster-whisper, which is not installed"), so keep them readable.
    if (data.error) throw new LocalSttError(String(data.error));
    return data.transcript || "";
  }

  const res = await fetch("/local-api/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": audioBlob.type || "audio/webm",
      // CSRF header the middleware demands on every /local-api call (#115).
      "x-locally-uncensored": "true",
    },
    body: audioBlob,
  });
  // Every refusal in front of the whisper handler (415 on the body type, 403
  // on the CSRF header or the origin, 405, a 404 from a dev server without
  // the plugin) answers in text/plain. Reading it as JSON threw a parse error
  // that hid the reason and pointed the user at the microphone (#115).
  if (!res.ok) throw await localApiFailure(res, "Transcription request refused");
  let data: { error?: string; transcript?: string };
  try {
    data = await res.json();
  } catch {
    throw new LocalSttError("Transcription returned a non-JSON response", res.status);
  }
  // The handler reports "Whisper not available" and "Whisper model is still
  // loading, please wait..." with HTTP 200, both are honest English already.
  if (data.error) throw new LocalSttError(String(data.error), res.status);
  return data.transcript || "";
}

// --- LU Cloud voice (appMode 'cloud') ---

/** Cloud STT: POST the recorded clip to /api/voice/transcribe (Whisper
 *  large-v3-turbo, flat-metered per request — so useVoice disables the
 *  interim-streaming cadence in cloud mode and only sends the final take). */
export async function transcribeAudioCloud(audioBlob: Blob): Promise<string> {
  const res = await cloudFetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "content-type": audioBlob.type || "audio/wav" },
    body: audioBlob,
  });
  const data = await jsonOrError<{ text?: string }>(res);
  return data.text || "";
}

// The cloud TTS route rejects text over 1500 chars (zod BodySchema) — a
// typical assistant answer is longer. Split into ≤1400-char pieces on sentence
// boundaries (hard-splitting any single oversized run) so long messages read
// aloud instead of 400ing and silently degrading to the local/browser voice.
const TTS_MAX_CHARS = 1400;
/** Last resort for a run with no sentence end in it: cut at `max`, but never
 *  through a surrogate pair (a split emoji becomes two lone surrogates, which
 *  is invalid in the JSON the cloud TTS request carries) and, where the text
 *  has spaces, never through a word. */
function hardSlice(s: string, max: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + max, s.length);
    if (end < s.length) {
      const lead = s.charCodeAt(end - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) end -= 1; // keep the pair together
      const ws = s.lastIndexOf(" ", end - 1);
      // Only back off to a space if it does not shrink the chunk drastically —
      // CJK has none, and a 60% floor keeps the clip count sane.
      if (ws > i + max * 0.6) end = ws + 1;
    }
    const piece = s.slice(i, end).trim();
    if (piece) out.push(piece);
    i = end;
  }
  return out;
}

export function chunkForTts(text: string, max = TTS_MAX_CHARS): string[] {
  const clean = text.trim();
  if (clean.length <= max) return clean ? [clean] : [];
  // Split AFTER a sentence terminator. This used to require whitespace to
  // FOLLOW it (`\s+`), which never fires for CJK — Chinese and Japanese put no
  // space after 。！？, so a long answer stayed a single part and fell into the
  // blind slicer below: measured, 200 Japanese sentences came out as one part
  // and the cut landed inside a word.
  // Parts stay VERBATIM — the separator (a space in Latin prose, nothing in
  // CJK) rides along at the head of the next part, so concatenating restores
  // the original exactly. Joining with a space instead would insert one into
  // Japanese where none belongs.
  const parts = clean.split(/(?<=[.!?。！？\n])/).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  for (const p of parts) {
    if (p.length > max) {
      flush();
      for (const piece of hardSlice(p, max)) chunks.push(piece);
      continue;
    }
    if (cur.length + p.length > max) flush();
    cur += p;
  }
  flush();
  return chunks;
}

/** Cloud TTS: /api/voice/tts streams back MP3 (MiniMax Speech-02). Returns an
 *  object URL for playNeuralAudio (which revokes it when the clip settles).
 *  `signal` aborts the in-flight synthesis — the server cancels un-metered. */
export async function synthesizeCloud(text: string, voice?: string, signal?: AbortSignal): Promise<string> {
  const res = await cloudFetch("/api/voice/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new CloudJobError(
      typeof body.error === "string" ? body.error : `cloud TTS failed (${res.status})`,
      res.status,
    );
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// --- Local neural TTS (Piper) ---
// Synthesizes via the bundled Piper voice through the Rust `synthesize` command
// (100% local, no cloud). The browser SpeechSynthesis path in useVoice handles
// the case where neural TTS isn't installed.

let ttsChecked = false;
let ttsAvailableFlag = false;
let ttsCheckedVoice: string | undefined;
/** The last full probe, not just its boolean. `tts_status` distinguishes "the
 *  piper package is missing" from "no complete voice on disk"; collapsing that
 *  to one flag is what made read-aloud tell a user with no Piper at all that
 *  Piper "is installed but not responding". */
let lastTtsStatus: { available: boolean; piper?: boolean; voice?: boolean } = { available: false };

export function getLastTtsStatus(): { available: boolean; piper?: boolean; voice?: boolean } {
  return lastTtsStatus;
}

/** Probe neural TTS. Pass the SELECTED voice — readiness is per voice: having
 *  some other voice on disk says nothing about the one that is about to speak. */
export async function checkTtsAvailable(voice?: string): Promise<{ available: boolean; piper?: boolean; voice?: boolean }> {
  try {
    if (isTauri()) return await backendCall("tts_status", { voice });
    return { available: false };
  } catch {
    return { available: false };
  }
}

export async function initTtsCheck(voice?: string): Promise<boolean> {
  // Cache only a POSITIVE result. A negative probe at boot is frequently a
  // race — resolve_lu_python / the ComfyUI venv may not be ready when App.tsx
  // fires this — and caching `false` would stick for the whole session, so
  // every read-aloud silently fell back to the Windows SAPI voice and Piper
  // never spoke at all (#77, ElBiggus). On a negative we leave ttsChecked
  // false so the next caller (the lazy re-probe in useVoice, or Settings)
  // gets a fresh probe instead of the stale miss.
  // The cache is per voice: a positive for the voice that was selected earlier
  // must not vouch for the one the user switched to.
  if (ttsChecked && ttsAvailableFlag && ttsCheckedVoice === voice) return ttsAvailableFlag;
  try {
    lastTtsStatus = await checkTtsAvailable(voice);
    ttsAvailableFlag = lastTtsStatus.available;
  } catch {
    lastTtsStatus = { available: false };
    ttsAvailableFlag = false;
  }
  ttsChecked = ttsAvailableFlag;
  ttsCheckedVoice = voice;
  return ttsAvailableFlag;
}

// Force a fresh probe (after the in-app install, or when a Speaker button mounts
// while neural TTS still shows unavailable).
export async function recheckTtsAvailable(voice?: string): Promise<boolean> {
  ttsChecked = false;
  return initTtsCheck(voice);
}

/** Decode a synthesis result into a blob: object URL. A data: URL is the
 *  obvious carrier but the CSP only allows media-src blob:, so on the strict
 *  Chromium of WebView2 every data:audio playback is silently blocked while
 *  the lax WKWebView plays it (GitHub #77, the reason "read aloud" worked on
 *  every Mac here and on no reporter's Windows). */
export function base64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** Synthesize text to a playable WAV blob URL via a local Piper voice. */
export async function synthesizeNeural(text: string, voice?: string): Promise<string> {
  const data = await backendCall<{ audio_base64?: string; mime?: string }>("synthesize", { text, voice });
  if (!data?.audio_base64) throw new Error("neural TTS returned no audio");
  return base64ToBlobUrl(data.audio_base64, data.mime || "audio/wav");
}

/**
 * Synthesize text via a user-configured external HTTP TTS engine (GitHub #58).
 * `url` is an OpenAI-compatible endpoint (e.g. Kokoro-FastAPI at
 * http://localhost:8880/v1/audio/speech); `voice` is that engine's voice name.
 * Returns a playable blob URL (the Rust side honors the returned audio type).
 */
export async function synthesizeExternal(text: string, url: string, voice?: string): Promise<string> {
  const data = await backendCall<{ audio_base64?: string; mime?: string }>("synthesize_external", { text, url, voice });
  if (!data?.audio_base64) throw new Error("external TTS returned no audio");
  return base64ToBlobUrl(data.audio_base64, data.mime || "audio/wav");
}

/** Download a Piper voice model on demand. Blocks until done (~63 MB). */
export async function downloadPiperVoice(voice: string): Promise<void> {
  await backendCall("download_voice", { voice });
}

/** Voice ids already present on disk — used to mark the Settings picker. */
export async function listInstalledPiperVoices(): Promise<string[]> {
  try {
    if (isTauri()) return (await backendCall<string[]>("installed_piper_voices")) || [];
    return [];
  } catch {
    return [];
  }
}

let neuralAudio: HTMLAudioElement | null = null;
let neuralAudioDone: (() => void) | null = null;
let webAudioPlayback: { source: AudioBufferSourceNode; done: () => void } | null = null;

/** Parse a PCM WAV (16-bit int or 32-bit float, the formats piper and every
 *  TTS wav here produce) into raw channel data. Pure byte-walking on the RIFF
 *  chunks, no platform decoder involved — that independence is the point (see
 *  playNeuralAudio). Returns null for anything that isn't such a wav. */
export function parseWavPcm(
  bytes: ArrayBuffer,
): { sampleRate: number; channels: Float32Array[] } | null {
  const view = new DataView(bytes);
  if (bytes.byteLength < 44) return null;
  if (view.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
  if (view.getUint32(8, false) !== 0x57415645) return null; // 'WAVE'

  let format = 0, channelCount = 0, sampleRate = 0, bitsPerSample = 0;
  let data: { offset: number; length: number } | null = null;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = view.getUint32(pos, false);
    const size = view.getUint32(pos + 4, true);
    if (id === 0x666d7420) { // 'fmt '
      format = view.getUint16(pos + 8, true);
      channelCount = view.getUint16(pos + 10, true);
      sampleRate = view.getUint32(pos + 12, true);
      bitsPerSample = view.getUint16(pos + 22, true);
    } else if (id === 0x64617461) { // 'data'
      data = { offset: pos + 8, length: Math.min(size, bytes.byteLength - pos - 8) };
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  const pcm16 = format === 1 && bitsPerSample === 16;
  const float32 = format === 3 && bitsPerSample === 32;
  if (!data || !channelCount || !sampleRate || (!pcm16 && !float32)) return null;

  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channelCount));
  if (frames === 0) return null;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channelCount; c++) {
      const at = data.offset + (f * channelCount + c) * bytesPerSample;
      channels[c][f] = pcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
    }
  }
  return { sampleRate, channels };
}

/** Codec-free playback path: hand-parsed PCM into Web Audio, with Chromium's
 *  bundled decodeAudioData for compressed formats. Used when the media element
 *  fails (ElBiggus GH #77: on a Windows N edition without the Media Feature
 *  Pack, `new Audio(wav)` errors even though piper wrote a perfect wav —
 *  HTMLAudioElement decodes through Media Foundation, Web Audio does not). */
async function playViaWebAudio(dataUrl: string): Promise<void> {
  const bytes = await (await fetch(dataUrl)).arrayBuffer();
  const ctx = new AudioContext();
  try {
    const pcm = parseWavPcm(bytes);
    let buffer: AudioBuffer;
    if (pcm) {
      buffer = ctx.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
      pcm.channels.forEach((ch, i) => buffer.copyToChannel(ch, i));
    } else {
      buffer = await ctx.decodeAudioData(bytes);
    }
    await ctx.resume().catch(() => { /* best effort */ });
    await new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      webAudioPlayback = { source, done: resolve };
      source.onended = () => {
        if (webAudioPlayback?.source === source) webAudioPlayback = null;
        resolve();
      };
      source.start();
    });
  } finally {
    void ctx.close().catch(() => { /* already closed */ });
  }
}

/** Play a WAV/MP3 blob URL; resolves when playback ends (or is stopped via
 *  stopNeuralAudio). Replaces any current clip. Object URLs are revoked once
 *  the clip settles so TTS blobs don't pin memory. */
export function playNeuralAudio(dataUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stopNeuralAudio();
    const audio = new Audio(dataUrl);
    const cleanup = () => {
      if (neuralAudio === audio) { neuralAudio = null; neuralAudioDone = null; }
      if (dataUrl.startsWith("blob:")) URL.revokeObjectURL(dataUrl);
    };
    // Media element failed — retry through Web Audio before giving up. The
    // blob: URL must stay alive until the fallback has fetched it, so this
    // path revokes late instead of via cleanup().
    const fallback = () => {
      if (neuralAudio === audio) { neuralAudio = null; neuralAudioDone = null; }
      playViaWebAudio(dataUrl)
        .then(resolve, () => reject(new Error("neural audio playback failed")))
        .finally(() => { if (dataUrl.startsWith("blob:")) URL.revokeObjectURL(dataUrl); });
    };
    neuralAudio = audio;
    neuralAudioDone = () => { cleanup(); resolve(); };
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = fallback;
    audio.play().catch(fallback);
  });
}

export function stopNeuralAudio(): void {
  if (neuralAudio) {
    try { neuralAudio.pause(); } catch { /* noop */ }
    // pause() never fires onended — settle the pending playNeuralAudio promise
    // explicitly (which also revokes a blob: URL) so callers' awaits don't
    // dangle forever after a Stop click.
    const done = neuralAudioDone;
    neuralAudio = null;
    neuralAudioDone = null;
    done?.();
  }
  if (webAudioPlayback) {
    // Same contract for the Web Audio fallback: stop() fires onended, but
    // settle explicitly in case the source never started.
    const { source, done } = webAudioPlayback;
    webAudioPlayback = null;
    try { source.stop(); } catch { /* never started */ }
    done();
  }
}

// --- Audio Recorder (Web Audio PCM → 16 kHz mono WAV) ---
//
// We deliberately do NOT use MediaRecorder here. MediaRecorder with a timeslice
// emits *fragmented* webm/opus chunks; concatenating them yields a blob whose
// header/cues are incomplete, which faster-whisper (PyAV/ffmpeg) often fails to
// decode → empty transcript (the "mic on but no text" bug). Capturing raw PCM
// via Web Audio and encoding a clean 16 kHz mono WAV is what faster-whisper
// expects natively, and it lets us take mid-recording WAV snapshots for live
// streaming transcription.

export interface AudioRecorder {
  start: () => Promise<void>;
  /** Final 16 kHz mono WAV of the whole take. */
  stop: () => Promise<Blob>;
  /** 16 kHz mono WAV of everything captured so far (for streaming interim STT). */
  snapshot: () => Blob | null;
  isRecording: () => boolean;
}

const STT_TARGET_RATE = 16000;

function floatTo16BitPCM(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Box-filter downsample to the target rate (Whisper wants 16 kHz). Averaging
// the source window is a cheap anti-alias that beats naive decimation.
function downsampleTo(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let j = start; j < end; j++) { sum += input[j]; n++; }
    out[i] = n ? sum / n : input[start] || 0;
  }
  return out;
}

/** Downsample to 16 kHz when the source is higher, then encode.
 *
 *  The header carries the rate the samples are ACTUALLY at. It used to be
 *  hard-coded to 16 kHz while downsampleTo returns its input untouched when the
 *  source is already at or below the target — so a mic running below 16 kHz
 *  produced a WAV whose header lied. A Bluetooth headset in HFP mode captures
 *  at 8 kHz, which is the common case on Windows the moment the headset's
 *  microphone is selected; whisper then read the take at double speed and the
 *  transcript came back wrong or empty ("mic on but no text"). faster-whisper
 *  resamples from whatever the header declares, so declaring it honestly is the
 *  whole fix.
 */
export function pcmToWav(samples: Float32Array, inputRate: number): Blob {
  const rate = Math.min(inputRate, STT_TARGET_RATE);
  const ds = downsampleTo(samples, inputRate, STT_TARGET_RATE);
  return encodeWav(floatTo16BitPCM(ds), rate);
}

function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) view.setInt16(off, samples[i], true);
  return new Blob([view], { type: "audio/wav" });
}

export function createAudioRecorder(): AudioRecorder {
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let mute: GainNode | null = null;
  let stream: MediaStream | null = null;
  let pcmChunks: Float32Array[] = [];
  let inputRate = 48000;
  let recording = false;

  const buildWav = (): Blob | null => {
    if (!pcmChunks.length) return null;
    let total = 0;
    for (const c of pcmChunks) total += c.length;
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let o = 0;
    for (const c of pcmChunks) { merged.set(c, o); o += c.length; }
    return pcmToWav(merged, inputRate);
  };

  return {
    start: async () => {
      pcmChunks = [];
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new Ctx();
      inputRate = audioCtx.sampleRate;
      source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but works reliably in WebView2 without the
      // AudioWorklet module-loading dance. 4096-frame buffer ≈ 85 ms at 48 kHz.
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (!recording) return;
        // Copy — the underlying buffer is reused by the audio thread.
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // Route through a zero-gain node so onaudioprocess fires WITHOUT echoing
      // the mic to the speakers.
      mute = audioCtx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(audioCtx.destination);
      // getUserMedia is awaited just above, which can drop the user-gesture
      // activation → the AudioContext may start "suspended" and never fire
      // onaudioprocess (= silent capture, empty WAV). Resume explicitly.
      if (audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch { /* noop */ }
      }
      recording = true;
    },

    stop: () => {
      return new Promise<Blob>((resolve) => {
        recording = false;
        const wav = buildWav() || new Blob([], { type: "audio/wav" });
        try { processor?.disconnect(); } catch { /* noop */ }
        try { source?.disconnect(); } catch { /* noop */ }
        try { mute?.disconnect(); } catch { /* noop */ }
        try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
        try { void audioCtx?.close(); } catch { /* noop */ }
        processor = null; source = null; mute = null; audioCtx = null; stream = null;
        resolve(wav);
      });
    },

    snapshot: () => buildWav(),

    isRecording: () => recording,
  };
}
