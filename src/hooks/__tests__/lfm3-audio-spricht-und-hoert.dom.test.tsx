// @vitest-environment jsdom
/**
 * N1, 30.10.2026: Liquid AI LFM3 Audio als Stimme und als Ohr von LU.
 *
 * Ollama 0.40.13 bietet fuer lfm3-audio (und lfm3-omni) zwei
 * OpenAI-kompatible Wege: /v1/audio/speech (Vorlesen) und
 * /v1/audio/transcriptions (Diktat). Vorher schickte LU beim externen
 * Vorlesen immer `model: "tts-1"` und `voice: "alloy"`, beides beantwortet
 * Ollama mit 400. Ein externes Diktat gab es gar nicht, das Mikrofon kannte
 * nur faster-whisper.
 *
 * Run: npx vitest run src/hooks/__tests__/lfm3-audio-spricht-und-hoert.dom.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { standOn } from '../../test-support/devices'

const backend = vi.hoisted(() => ({ backendCall: vi.fn(), tauri: { on: true } }))
vi.mock('../../api/backend', async (orig) => ({ ...((await orig()) as object), backendCall: backend.backendCall, isTauri: () => backend.tauri.on }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../../lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../stores/cloudAuthStore', async (orig) => ({ ...((await orig()) as object), deriveCloudAvailable: () => false }))

import { useVoice, transcribeTake, externalStt, stopSpeechPlayback } from '../useVoice'
import { useVoiceStore } from '../../stores/voiceStore'
import { ollamaSpeechUrls, OLLAMA_SPEECH_MODEL } from '../../api/voice'
import { SpeechSettings } from '../../components/settings/SpeechSettings'
import { setOllamaBase } from '../../api/backend'

const wav = () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' })

beforeEach(() => {
  standOn('mac')
  backend.tauri.on = true
  backend.backendCall.mockReset()
  useVoiceStore.getState().resetVoiceDefaults()
  useVoiceStore.setState({ sttAvailable: false, sttError: null, transcript: '' })
})
afterEach(() => {
  cleanup()
  stopSpeechPlayback()
})

describe('Diktat ueber Ollama (LFM3 Audio)', () => {
  it('geht an transcribe_external mit Adresse und Modell, nicht an faster-whisper', async () => {
    backend.backendCall.mockResolvedValue({ transcript: 'Hello from LFM3.' })
    useVoiceStore.getState().updateVoiceSettings({
      sttMode: 'external', externalSttUrl: 'http://localhost:11434/v1/audio/transcriptions', externalSttModel: 'lfm3-audio:2b',
    })
    const text = await transcribeTake(wav(), false)
    expect(text).toBe('Hello from LFM3.')
    expect(backend.backendCall).toHaveBeenCalledTimes(1)
    const [cmd, args] = backend.backendCall.mock.calls[0]
    expect(cmd).toBe('transcribe_external')
    expect(args).toMatchObject({ url: 'http://localhost:11434/v1/audio/transcriptions', model: 'lfm3-audio:2b', contentType: 'audio/wav' })
    expect(typeof (args as { audioBase64: string }).audioBase64).toBe('string')
  })

  it('halb ausgefuellt bleibt es bei faster-whisper', () => {
    expect(externalStt({ sttMode: 'external', externalSttUrl: 'http://x/v1/audio/transcriptions', externalSttModel: ' ' })).toBeNull()
    expect(externalStt({ sttMode: 'whisper', externalSttUrl: 'http://x', externalSttModel: 'm' })).toBeNull()
  })

  it('der Mikrofonknopf gilt als bereit, ohne dass faster-whisper installiert ist', () => {
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'external', externalSttUrl: 'http://localhost:11434/v1/audio/transcriptions', externalSttModel: 'lfm3-audio:2b' })
    const { result } = renderHook(() => useVoice())
    expect(result.current.sttSupported).toBe(true)
  })

  it('ein Fehler von Ollama landet als Satz im Diktat, nicht als Stille', async () => {
    backend.backendCall.mockRejectedValue('speech-to-text HTTP 404 from lfm3-audio:2b: model not found')
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'external', externalSttUrl: 'http://localhost:11434/v1/audio/transcriptions', externalSttModel: 'lfm3-audio:2b' })
    expect(await transcribeTake(wav(), false)).toBe('')
    expect(useVoiceStore.getState().sttError).toContain('model not found')
  })
})

describe('Vorlesen ueber Ollama (LFM3 Audio)', () => {
  it('schickt das eingetragene Modell mit', async () => {
    backend.backendCall.mockResolvedValue({ audio_base64: 'UklGRg==', mime: 'audio/wav' })
    useVoiceStore.setState({ ttsEnabled: true })
    useVoiceStore.getState().updateVoiceSettings({ ttsMode: 'external', externalTtsUrl: 'http://localhost:11434/v1/audio/speech', externalTtsModel: 'lfm3-audio:2b', externalTtsVoice: '' })
    const { result } = renderHook(() => useVoice())
    await act(async () => { await result.current.speakText('Hello there.').catch(() => {}) })
    const call = backend.backendCall.mock.calls.find(([c]) => c === 'synthesize_external')
    expect(call?.[1]).toMatchObject({ url: 'http://localhost:11434/v1/audio/speech', model: 'lfm3-audio:2b' })
  })

  it('die Einstellungen bleiben ueber einen Neustart', () => {
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'external', externalSttUrl: 'u', externalSttModel: 'm', externalTtsModel: 't' })
    const saved = JSON.parse(localStorage.getItem('locally-uncensored-voice') ?? '{}').state
    expect(saved).toMatchObject({ sttMode: 'external', externalSttUrl: 'u', externalSttModel: 'm', externalTtsModel: 't' })
  })
})

describe('Einstellungen: ein Klick traegt LFM3 Audio in Ollama ein', () => {
  it('die Adressen folgen dem eingestellten Ollama', () => {
    expect(ollamaSpeechUrls('http://192.168.1.5:11434/')).toEqual({
      stt: 'http://192.168.1.5:11434/v1/audio/transcriptions',
      tts: 'http://192.168.1.5:11434/v1/audio/speech',
    })
    expect(OLLAMA_SPEECH_MODEL).toBe('lfm3-audio:2b')
  })

  it('Diktat und Vorlesen bekommen Adresse und Modell, die Stimme wird geleert', async () => {
    backend.tauri.on = false
    backend.backendCall.mockImplementation(async (cmd: string) => (cmd === 'installed_piper_voices' ? [] : { available: false }))
    setOllamaBase('http://localhost:11434')
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'external', ttsMode: 'external', externalTtsVoice: 'alloy' })
    render(createElement(SpeechSettings))
    const knoepfe = screen.getAllByRole('button', { name: 'Use LFM3 Audio in Ollama' })
    expect(knoepfe).toHaveLength(2)
    for (const k of knoepfe) await act(async () => { fireEvent.click(k) })
    expect(useVoiceStore.getState()).toMatchObject({
      externalSttUrl: 'http://localhost:11434/v1/audio/transcriptions',
      externalSttModel: 'lfm3-audio:2b',
      externalTtsUrl: 'http://localhost:11434/v1/audio/speech',
      externalTtsModel: 'lfm3-audio:2b',
      externalTtsVoice: '',
    })
  })

  it('Diktat und Vorlesen bieten die LU Engine an und sagen, welches Modell sie dort braucht', async () => {
    backend.tauri.on = false
    backend.backendCall.mockImplementation(async (cmd: string) => (cmd === 'installed_piper_voices' ? [] : { available: false }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: false, backend: null }), { status: 200 })))
    render(createElement(SpeechSettings))
    const engine = screen.getAllByRole('button', { name: 'LU Engine' })
    expect(engine).toHaveLength(2)
    for (const b of engine) await act(async () => { fireEvent.click(b) })
    expect(useVoiceStore.getState()).toMatchObject({ sttMode: 'engine', ttsMode: 'engine' })
    expect(screen.getAllByText(/LFM3 Audio or LFM3 Omni/).length).toBe(2)
    expect(screen.queryByText(/Required for the microphone/)).toBeNull()
    vi.unstubAllGlobals()
  })

  it('mit externem Diktat sagt die Seite nicht mehr, faster-whisper sei noetig', async () => {
    backend.tauri.on = false
    backend.backendCall.mockImplementation(async (cmd: string) => (cmd === 'installed_piper_voices' ? [] : { available: false }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ available: false, backend: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'whisper' })
    const { unmount } = render(createElement(SpeechSettings))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.queryByText(/Required for the microphone/)).not.toBeNull()
    unmount()
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'external' })
    render(createElement(SpeechSettings))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.queryByText(/Required for the microphone/)).toBeNull()
    vi.unstubAllGlobals()
  })
})
