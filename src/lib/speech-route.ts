/**
 * Where dictation and read-aloud go when they do not use LU's own engines
 * (faster-whisper, Piper, the voice loop's Whisper and Pocket TTS).
 *
 * N1, 30.10.2026, Liquid LFM3 Audio / Omni. Two kinds of service hear and
 * speak with them, and both answer the same two requests:
 *
 *   - "External HTTP": any OpenAI-compatible service the user named, e.g.
 *     Ollama 0.40.13+ at /v1/audio/transcriptions and /v1/audio/speech.
 *   - "LU Engine": llama-server b11960 with LFM3 Audio or Omni loaded. It
 *     transcribes at /v1/audio/transcriptions and speaks at /tts, a WAV for
 *     the same JSON body (measured on the Mac with E1's build). Its address is
 *     read at the moment of use from the managed engine slot, because the
 *     engine moves to the next free port when 8127 is taken.
 *
 * Pure on purpose: which address a take goes to is the part to get right.
 */

export type SttMode = 'whisper' | 'external' | 'engine'
export type TtsMode = 'piper' | 'external' | 'engine'

export interface SpeechRoute {
  url: string
  model: string
  /** Empty: the service speaks in the model's own voice. */
  voice?: string
  /** True for the LU Engine: the request needs the engine key. */
  engine: boolean
}

export interface SpeechSettings {
  sttMode: string
  externalSttUrl: string
  externalSttModel: string
  ttsMode: string
  externalTtsUrl: string
  externalTtsModel: string
  externalTtsVoice: string
}

/** llama-server answers any model name; this one names the slot in its log. */
export const ENGINE_SPEECH_MODEL = 'lu-engine'

/** The managed engine's `…/v1` base without the `/v1`. */
function engineRoot(engineBaseUrl: string | null | undefined): string | null {
  const b = (engineBaseUrl ?? '').trim().replace(/\/+$/, '')
  return b ? b.replace(/\/v1$/, '') : null
}

export function engineSpeechUrls(engineBaseUrl: string): { stt: string; tts: string } | null {
  const root = engineRoot(engineBaseUrl)
  return root ? { stt: `${root}/v1/audio/transcriptions`, tts: `${root}/tts` } : null
}

/** Dictation's route, or null for faster-whisper (also when half filled in). */
export function sttRoute(s: Pick<SpeechSettings, 'sttMode' | 'externalSttUrl' | 'externalSttModel'>, engineBaseUrl: string | null | undefined): SpeechRoute | null {
  if (s.sttMode === 'engine') {
    const urls = engineSpeechUrls(engineBaseUrl ?? '')
    return urls ? { url: urls.stt, model: ENGINE_SPEECH_MODEL, engine: true } : null
  }
  const url = s.externalSttUrl.trim()
  const model = s.externalSttModel.trim()
  return s.sttMode === 'external' && url && model ? { url, model, engine: false } : null
}

/** Read-aloud's route, or null for Piper. */
export function ttsRoute(s: Pick<SpeechSettings, 'ttsMode' | 'externalTtsUrl' | 'externalTtsModel' | 'externalTtsVoice'>, engineBaseUrl: string | null | undefined): SpeechRoute | null {
  if (s.ttsMode === 'engine') {
    const urls = engineSpeechUrls(engineBaseUrl ?? '')
    return urls ? { url: urls.tts, model: ENGINE_SPEECH_MODEL, engine: true } : null
  }
  const url = s.externalTtsUrl.trim()
  if (s.ttsMode !== 'external' || !url) return null
  return { url, model: s.externalTtsModel.trim(), voice: s.externalTtsVoice.trim() || undefined, engine: false }
}

/**
 * The sentence for a service that does not take sound. llama-server answers a
 * take with HTTP 400/500 when the loaded model has no audio encoder; Ollama
 * with "does not support audio". Said in LU's words, with the way out.
 */
export function speechRefusalText(message: string, route: SpeechRoute | null): string | null {
  const m = message.toLowerCase()
  const noAudio = /audio/.test(m) && /(not supported|does not support|no audio|unsupported|not enabled|multimodal)/.test(m)
  if (!noAudio) return null
  return route?.engine
    ? 'The model in the LU Engine takes no sound. Load LFM3 Audio or LFM3 Omni in the LU Engine, or use LFM3 Audio in Ollama (Settings, Voice).'
    : 'This model takes no sound. Pick LFM3 Audio or LFM3 Omni for speech (Settings, Voice).'
}
