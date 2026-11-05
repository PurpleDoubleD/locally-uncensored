/**
 * N1: the Voice surface hears and speaks through the same choice as
 * dictation and read-aloud. Before, the session body carried no speech
 * settings and the voice loop always used its own Whisper and Pocket TTS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const backend = vi.hoisted(() => ({ backendCall: vi.fn() }))
vi.mock('../backend', async (orig) => ({ ...((await orig()) as object), backendCall: backend.backendCall }))

import { voiceSessionSpeech } from '../voice-speech'
import { useVoiceStore } from '../../stores/voiceStore'
import { useProviderStore } from '../../stores/providerStore'

beforeEach(() => {
  backend.backendCall.mockReset()
  useVoiceStore.getState().resetVoiceDefaults()
})

describe('Voice-Sitzung und Spracheinstellung', () => {
  it('ohne Wahl behaelt die Sitzung ihre eigenen Modelle', async () => {
    expect(await voiceSessionSpeech()).toEqual({})
  })

  it('Ollama: Adresse und Modell, ohne Schluessel', async () => {
    useVoiceStore.getState().updateVoiceSettings({
      sttMode: 'external', externalSttUrl: 'http://localhost:11434/v1/audio/transcriptions', externalSttModel: 'lfm3-audio:2b',
      ttsMode: 'external', externalTtsUrl: 'http://localhost:11434/v1/audio/speech', externalTtsModel: 'lfm3-audio:2b',
    })
    expect(await voiceSessionSpeech()).toEqual({
      stt: { url: 'http://localhost:11434/v1/audio/transcriptions', model: 'lfm3-audio:2b' },
      tts: { url: 'http://localhost:11434/v1/audio/speech', model: 'lfm3-audio:2b' },
    })
    expect(backend.backendCall).not.toHaveBeenCalled()
  })

  it('LU Engine: aktueller Port aus dem Slot und der Engine-Schluessel', async () => {
    const p = useProviderStore.getState()
    p.setProviderConfig('openai', { enabled: true, managed: true, baseUrl: 'http://127.0.0.1:8129/v1' })
    backend.backendCall.mockImplementation(async (cmd: string, args: { url: string }) => (cmd === 'engine_key_for' && args.url.startsWith('http://127.0.0.1:8129/') ? 'k'.repeat(64) : null))
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'engine', ttsMode: 'engine' })
    const speech = await voiceSessionSpeech()
    expect(speech.stt).toEqual({ url: 'http://127.0.0.1:8129/v1/audio/transcriptions', model: 'lu-engine', api_key: 'k'.repeat(64) })
    expect(speech.tts).toEqual({ url: 'http://127.0.0.1:8129/tts', model: 'lu-engine', api_key: 'k'.repeat(64) })
  })
})
