/**
 * N1, 30.10.2026: dictation and read-aloud through LFM3 Audio, in Ollama or
 * in the LU Engine. Measured on the Mac with llama-server b11960 and
 * LFM3-Audio-2B: /v1/audio/transcriptions answers {"text": ...}, /tts answers
 * a WAV for the body read-aloud sends, /v1/audio/speech is 404 there. A model
 * without sound answers 501 "The current model does not support audio input."
 * and "this server does not support audio generation".
 */
import { describe, expect, it } from 'vitest'
import { engineSpeechUrls, speechRefusalText, sttRoute, ttsRoute } from '../speech-route'

const leer = { sttMode: 'whisper', externalSttUrl: '', externalSttModel: '', ttsMode: 'piper', externalTtsUrl: '', externalTtsModel: '', externalTtsVoice: '' }

describe('LU Engine', () => {
  it('hoert an /v1/audio/transcriptions und spricht an /tts, auf dem Port, auf dem die Engine gerade laeuft', () => {
    expect(engineSpeechUrls('http://127.0.0.1:8129/v1')).toEqual({
      stt: 'http://127.0.0.1:8129/v1/audio/transcriptions',
      tts: 'http://127.0.0.1:8129/tts',
    })
    expect(sttRoute({ ...leer, sttMode: 'engine' }, 'http://127.0.0.1:8127/v1/')).toMatchObject({ url: 'http://127.0.0.1:8127/v1/audio/transcriptions', engine: true })
    expect(ttsRoute({ ...leer, ttsMode: 'engine' }, 'http://127.0.0.1:8127/v1')).toMatchObject({ url: 'http://127.0.0.1:8127/tts', engine: true })
  })

  it('ohne LU Engine im Slot gibt es keinen Weg dorthin', () => {
    expect(sttRoute({ ...leer, sttMode: 'engine' }, null)).toBeNull()
    expect(ttsRoute({ ...leer, ttsMode: 'engine' }, '')).toBeNull()
  })
})

describe('External HTTP', () => {
  it('nimmt Adresse, Modell und Stimme, wie eingetragen', () => {
    expect(ttsRoute({ ...leer, ttsMode: 'external', externalTtsUrl: ' http://localhost:11434/v1/audio/speech ', externalTtsModel: 'lfm3-audio:2b' }, null))
      .toEqual({ url: 'http://localhost:11434/v1/audio/speech', model: 'lfm3-audio:2b', voice: undefined, engine: false })
    expect(sttRoute({ ...leer, sttMode: 'external', externalSttUrl: 'http://x/v1/audio/transcriptions', externalSttModel: '' }, null)).toBeNull()
  })

  it('Whisper und Piper bleiben Whisper und Piper', () => {
    expect(sttRoute(leer, 'http://127.0.0.1:8127/v1')).toBeNull()
    expect(ttsRoute(leer, 'http://127.0.0.1:8127/v1')).toBeNull()
  })
})

describe('ein Modell ohne Ton', () => {
  const engine = sttRoute({ ...leer, sttMode: 'engine' }, 'http://127.0.0.1:8127/v1')
  it('die echte Absage von llama-server wird zu einem Satz mit Ausweg', () => {
    const satz = speechRefusalText('speech-to-text HTTP 501 from lu-engine: {"error":{"code":501,"message":"The current model does not support audio input."}}', engine)
    expect(satz).toContain('LFM3 Audio or LFM3 Omni in the LU Engine')
    expect(speechRefusalText('external TTS HTTP 501: {"error":{"message":"this server does not support audio generation"}}', engine)).toContain('takes no sound')
  })
  it('andere Fehler bleiben, wie sie sind', () => {
    expect(speechRefusalText('speech-to-text HTTP 404 from lfm3-audio:2b: model not found', engine)).toBeNull()
  })
})
