/**
 * The ear and the voice of a Voice session, when they are not the voice
 * loop's own Whisper and Pocket TTS (N1, Liquid LFM3 Audio).
 *
 * The same choice as dictation and read-aloud in Settings, Voice: External
 * HTTP (Ollama with lfm3-audio or lfm3-omni) or the LU Engine with one of
 * them loaded. The voice loop talks to the service itself, so the LU Engine's
 * key travels along, handed out by the Rust side for an engine address only
 * (engine_key.rs), as for the model that answers (voice-brain.ts).
 */
import { backendCall } from './backend'
import { useProviderStore } from '../stores/providerStore'
import { useVoiceStore } from '../stores/voiceStore'
import { sttRoute, ttsRoute, type SpeechRoute } from '../lib/speech-route'

export interface SessionSpeechEndpoint {
  url: string
  model: string
  voice?: string
  api_key?: string
}

function engineBaseUrl(): string | null {
  const slot = useProviderStore.getState().providers.openai
  return slot?.enabled && slot.managed === true ? slot.baseUrl : null
}

async function endpoint(route: SpeechRoute | null): Promise<SessionSpeechEndpoint | undefined> {
  if (!route) return undefined
  const out: SessionSpeechEndpoint = { url: route.url, model: route.model || 'default' }
  if (route.voice) out.voice = route.voice
  if (route.engine) {
    const key = await backendCall<string | null>('engine_key_for', { url: route.url }).catch(() => null)
    if (key) out.api_key = key
  }
  return out
}

/** `stt` and `tts` for the POST /session body; absent keys keep the loop's own models. */
export async function voiceSessionSpeech(): Promise<{ stt?: SessionSpeechEndpoint; tts?: SessionSpeechEndpoint }> {
  const s = useVoiceStore.getState()
  const base = engineBaseUrl()
  const [stt, tts] = await Promise.all([endpoint(sttRoute(s, base)), endpoint(ttsRoute(s, base))])
  return { ...(stt ? { stt } : {}), ...(tts ? { tts } : {}) }
}
