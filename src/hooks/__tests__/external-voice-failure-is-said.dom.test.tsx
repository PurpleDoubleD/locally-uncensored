// @vitest-environment jsdom
/**
 * Jaeger B, B11: with Voice engine "External HTTP" and an endpoint that does
 * not deliver audio, read-aloud switched to the system voice and said
 * nothing; ttsFallbackReason stayed null. Now the reason is recorded with
 * the error, and the Read aloud button that was pressed shows it.
 *
 * Run: npx vitest run src/hooks/__tests__/external-voice-failure-is-said.dom.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { standOn } from '../../test-support/devices'

const voice = vi.hoisted(() => ({
  synthesizeExternal: vi.fn(),
  playNeuralAudio: vi.fn(async () => {}),
  stopNeuralAudio: vi.fn(),
  stopSpeaking: vi.fn(),
  isSpeechSynthesisSupported: vi.fn(() => true),
  speak: vi.fn(async () => {}),
  speakStreaming: vi.fn(async (_text: string, ..._rest: unknown[]) => {}),
  getVoicesAsync: vi.fn(async () => []),
}))
vi.mock('../../api/voice', async (orig) => ({ ...((await orig()) as object), ...voice }))
vi.mock('../../lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../stores/cloudAuthStore', async (orig) => ({ ...((await orig()) as object), deriveCloudAvailable: () => false }))

import { useVoice, stopSpeechPlayback } from '../useVoice'
import { useVoiceStore } from '../../stores/voiceStore'
import { SpeakerButton } from '../../components/chat/SpeakerButton'

beforeEach(() => {
  standOn('mac')
  for (const fn of Object.values(voice)) fn.mockClear()
  voice.synthesizeExternal.mockReset()
  voice.synthesizeExternal.mockRejectedValue(new Error('neural audio playback failed'))
  useVoiceStore.setState({
    isSpeaking: false, ttsFallbackReason: null, ttsEnabled: true, ttsAvailable: false,
    ttsMode: 'external', externalTtsUrl: 'http://127.0.0.1:18943/v1/audio/speech', externalTtsVoice: 'alloy',
  })
})
afterEach(() => {
  cleanup()
  stopSpeechPlayback()
  vi.unstubAllGlobals()
})

describe('B11: a failed external voice is said, not hidden', () => {
  it('records why the system voice spoke, with the error', async () => {
    const { result } = renderHook(() => useVoice())
    await act(async () => { await result.current.speakText('Hello there.') })
    expect(voice.synthesizeExternal).toHaveBeenCalledTimes(1)
    expect(voice.speak).toHaveBeenCalledTimes(1)
    const reason = useVoiceStore.getState().ttsFallbackReason
    expect(reason).toContain('external voice failed')
    expect(reason).toContain('neural audio playback failed')
    expect(reason).toContain('system voice')
  })

  it('a working external voice clears the reason', async () => {
    useVoiceStore.setState({ ttsFallbackReason: 'old' })
    voice.synthesizeExternal.mockResolvedValue('blob:ok')
    const { result } = renderHook(() => useVoice())
    await act(async () => { await result.current.speakText('Hello there.') })
    expect(useVoiceStore.getState().ttsFallbackReason).toBeNull()
    expect(voice.speak).not.toHaveBeenCalled()
  })

  it('the pressed Read aloud button shows the notice', async () => {
    render(createElement(SpeakerButton, { text: 'Hello there.' }))
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByLabelText('Read aloud')) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.getByRole('status').textContent).toContain('external voice failed')
  })

  it('switching the engine drops a reason of the other engine', () => {
    useVoiceStore.setState({ ttsMode: 'piper', ttsFallbackReason: 'Piper failed to speak (x).' })
    useVoiceStore.getState().updateVoiceSettings({ ttsMode: 'external' })
    expect(useVoiceStore.getState().ttsFallbackReason).toBeNull()
  })
})
