// @vitest-environment jsdom
/**
 * GitHub #233: Parakeet TDT as a second dictation engine next to
 * faster-whisper. The desktop runs it (commands/parakeet.rs); the frontend
 * only picks it, sends the take there, and gates the microphone on its
 * install.
 *
 * Run: npx vitest run src/hooks/__tests__/parakeet-dictation.dom.test.tsx
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

import { useVoice, transcribeTake, stopSpeechPlayback } from '../useVoice'
import { useVoiceStore } from '../../stores/voiceStore'
import { SpeechSettings } from '../../components/settings/SpeechSettings'
import { percentOf, sizeText } from '../../components/settings/ParakeetSetting'

const wav = () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' })

const status = (over: Record<string, unknown> = {}) => ({
  supported: true, reason: null, installed: false, running: false, download_bytes: 721_214_791,
  model: 'Parakeet TDT 0.6B v3', license: 'CC-BY-4.0', attribution: 'Parakeet TDT 0.6B v3 by NVIDIA, licensed under CC BY 4.0.',
  runtime: 'NeMo-Speech.cpp 0.3.0', runtime_license: 'Apache-2.0',
  job: { running: false, done_bytes: 0, total_bytes: 0, error: null },
  ...over,
})

beforeEach(() => {
  standOn('mac')
  backend.tauri.on = true
  backend.backendCall.mockReset()
  useVoiceStore.getState().resetVoiceDefaults()
  useVoiceStore.setState({ sttAvailable: false, parakeetReady: false, sttError: null, transcript: '' })
})
afterEach(() => {
  cleanup()
  stopSpeechPlayback()
})

describe('dictation through Parakeet', () => {
  it('sends the take to parakeet_transcribe and not to faster-whisper', async () => {
    backend.backendCall.mockResolvedValue({ transcript: 'Bitte schreib mir eine kurze Mail an Thomas.' })
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'parakeet' })
    expect(await transcribeTake(wav(), false)).toBe('Bitte schreib mir eine kurze Mail an Thomas.')
    expect(backend.backendCall).toHaveBeenCalledTimes(1)
    const [cmd, args] = backend.backendCall.mock.calls[0]
    expect(cmd).toBe('parakeet_transcribe')
    expect(typeof (args as { audioBase64: string }).audioBase64).toBe('string')
  })

  it('a refusal from the desktop reaches the user as a sentence', async () => {
    backend.backendCall.mockRejectedValue('Parakeet is not installed. Get it in Settings, Voice.')
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'parakeet' })
    expect(await transcribeTake(wav(), false)).toBe('')
    expect(useVoiceStore.getState().sttError).toContain('Parakeet is not installed')
  })

  it('the microphone is ready with Parakeet installed, without faster-whisper', () => {
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'parakeet' })
    const { result } = renderHook(() => useVoice())
    expect(result.current.sttSupported).toBe(false)
    act(() => { useVoiceStore.setState({ parakeetReady: true }) })
    expect(result.current.sttSupported).toBe(true)
  })

  it('an installed Parakeet does not open the microphone while another engine is chosen', () => {
    useVoiceStore.setState({ parakeetReady: true })
    const { result } = renderHook(() => useVoice())
    expect(result.current.sttSupported).toBe(false)
  })
})

describe('the Parakeet line in Settings, Voice', () => {
  const answer = (s: ReturnType<typeof status>) => backend.backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'parakeet_status') return s
    if (cmd === 'whisper_status') return { available: true, backend: 'faster-whisper' }
    if (cmd === 'tts_status') return { available: false }
    if (cmd === 'installed_piper_voices') return []
    return null
  })

  it('is a choice of the dictation switch on the desktop, with the download size', async () => {
    answer(status())
    render(createElement(SpeechSettings))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Parakeet' })) })
    expect(useVoiceStore.getState().sttMode).toBe('parakeet')
    expect(await screen.findByText('Parakeet TDT 0.6B v3')).toBeTruthy()
    const get = await screen.findByRole('button', { name: /Download 721 MB/ })
    await act(async () => { fireEvent.click(get) })
    expect(backend.backendCall).toHaveBeenCalledWith('parakeet_install')
  })

  it('says ready when it is installed and opens the microphone', async () => {
    answer(status({ installed: true }))
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'parakeet' })
    render(createElement(SpeechSettings))
    expect(await screen.findByText('Parakeet TDT 0.6B v3')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Download \d/ })).toBeNull()
    expect(useVoiceStore.getState().parakeetReady).toBe(true)
  })

  it('leaving Parakeet stops its server', async () => {
    answer(status({ installed: true }))
    useVoiceStore.getState().updateVoiceSettings({ sttMode: 'parakeet' })
    render(createElement(SpeechSettings))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'faster-whisper' })) })
    expect(backend.backendCall).toHaveBeenCalledWith('parakeet_stop')
    expect(useVoiceStore.getState().sttMode).toBe('whisper')
  })

  it('is not offered outside the desktop app', async () => {
    backend.tauri.on = false
    answer(status())
    render(createElement(SpeechSettings))
    expect(screen.queryByRole('button', { name: 'Parakeet' })).toBeNull()
  })

  it('shows the size and the progress in plain numbers', () => {
    expect(sizeText(721_214_791)).toBe('721 MB')
    expect(sizeText(1_500_000_000)).toBe('1.5 GB')
    expect(sizeText(7_239_335)).toBe('7 MB')
    expect(percentOf(0, 0)).toBe(0)
    expect(percentOf(360_000_000, 721_214_791)).toBe(49)
    expect(percentOf(800, 721)).toBe(100)
  })
})
