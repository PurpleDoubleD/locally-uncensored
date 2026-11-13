/**
 * Point 8 of the mobile groundwork: voice on a phone.
 *
 *  - cloud voice does not hang on the app mode (a phone in local mode had a
 *    dead microphone)
 *  - no local fallback and no local probe: no Whisper, no Piper, no external
 *    engine process exists there
 *  - an empty wallet (429 credits_exhausted) opens the credits dialog
 *  - a take whose transcription failed is kept for another try
 *  - leaving the screen ends recording and playback, the take so far is kept
 *  - the sentences name things a phone has
 *
 * Every phone assertion has a desktop twin that pins the old behaviour.
 *
 * Run: npx vitest run src/hooks/__tests__/mobile-voice.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DESKTOPS, HANDHELDS, standOn } from '../../test-support/devices'

const voice = vi.hoisted(() => ({
  transcribeAudioCloud: vi.fn(),
  transcribeAudio: vi.fn(),
  synthesizeCloud: vi.fn(),
  synthesizeNeural: vi.fn(),
  synthesizeExternal: vi.fn(),
  recheckTtsAvailable: vi.fn(),
  recheckWhisperAvailable: vi.fn(),
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

import {
  cloudVoiceActive, haltRecorderForBackground, signalVoiceOutOfCredits, speakOnPhone, sttErrorMessage,
  stopSpeechPlayback, transcribeTake,
} from '../useVoice'
import { CloudJobError } from '../../api/cloud/client'
import { useVoiceStore } from '../../stores/voiceStore'
import { discardFailedTake, failedTake } from '../../lib/dictation-retry'
import { MOBILE_TEXT } from '../../lib/platform-text'
import { DICTATION_TEXT } from '../../lib/dictation-errors'
import { CREDITS_EXHAUSTED_EVENT } from '../../lib/credits-exhausted'
import type { AudioRecorder } from '../../api/voice'

const here = dirname(fileURLToPath(import.meta.url))
const hookSource = readFileSync(resolve(here, '../useVoice.ts'), 'utf8')

const take = () => new Blob([new Uint8Array(2048)], { type: 'audio/wav' })
const outOfCredits = () => new CloudJobError('monthly credit budget exhausted', 429, { code: 'credits_exhausted' })

let creditsDialog: ReturnType<typeof vi.fn<(e: Event) => void>>

function stand(device: Parameters<typeof standOn>[0]) {
  standOn(device)
  creditsDialog = vi.fn<(e: Event) => void>()
  const win = new EventTarget()
  win.addEventListener(CREDITS_EXHAUSTED_EVENT, creditsDialog)
  vi.stubGlobal('window', win)
}

beforeEach(() => {
  for (const fn of Object.values(voice)) fn.mockClear()
  voice.transcribeAudioCloud.mockReset()
  voice.transcribeAudio.mockReset()
  voice.synthesizeCloud.mockReset()
  voice.isSpeechSynthesisSupported.mockReturnValue(true)
  useVoiceStore.setState({
    isRecording: false, isTranscribing: false, isSpeaking: false, transcript: '', sttError: null,
    ttsFallbackReason: null, retryTakeReady: false, ttsEnabled: true, ttsVoice: '', ttsMode: 'piper',
    externalTtsUrl: '', ttsAvailable: false,
  })
})
afterEach(() => {
  stand('iphone')
  discardFailedTake()
  stopSpeechPlayback()
  vi.unstubAllGlobals()
})

describe('where voice goes through LU Cloud', () => {
  for (const device of HANDHELDS) {
    it(`${device}: whenever the account can use it, whatever the app mode says`, () => {
      stand(device)
      expect(cloudVoiceActive('local', true)).toBe(true)
      expect(cloudVoiceActive('cloud', true)).toBe(true)
      expect(cloudVoiceActive('local', false)).toBe(false)
      expect(cloudVoiceActive('cloud', false)).toBe(false)
    })
  }
  for (const device of DESKTOPS) {
    it(`DESKTOP UNCHANGED ${device}: only in cloud mode`, () => {
      stand(device)
      expect(cloudVoiceActive('local', true)).toBe(false)
      expect(cloudVoiceActive('cloud', true)).toBe(true)
      expect(cloudVoiceActive('cloud', false)).toBe(false)
    })
  }
  it('the hook asks exactly this function', () => {
    expect(hookSource).toMatch(/const cloudVoice = cloudVoiceActive\(appMode, cloudUsable\);/)
  })
})

describe('a take that could not be transcribed', () => {
  it('phone: is kept, and a retry sends the same take again', async () => {
    stand('iphone')
    const blob = take()
    voice.transcribeAudioCloud.mockRejectedValueOnce(new CloudJobError('bad gateway', 502))
    expect(await transcribeTake(blob, true)).toBe('')
    expect(useVoiceStore.getState().retryTakeReady).toBe(true)
    expect(failedTake()).toBe(blob)
    expect(useVoiceStore.getState().sttError).toBe('LU Cloud transcription is unavailable right now. Your recording is kept, tap retry in a moment.')
    expect(useVoiceStore.getState().isTranscribing).toBe(false)

    voice.transcribeAudioCloud.mockResolvedValueOnce('buy oat milk')
    expect(await transcribeTake(failedTake()!, true)).toBe('buy oat milk')
    expect(voice.transcribeAudioCloud).toHaveBeenLastCalledWith(blob)
    expect(useVoiceStore.getState().retryTakeReady).toBe(false)
    expect(failedTake()).toBeNull()
  })

  it('phone: a dead line keeps it too', async () => {
    stand('android')
    voice.transcribeAudioCloud.mockRejectedValueOnce(new CloudJobError('Could not reach the LU Cloud server.', 0))
    await transcribeTake(take(), true)
    expect(useVoiceStore.getState().retryTakeReady).toBe(true)
    expect(useVoiceStore.getState().sttError).toBe('Could not reach the LU Cloud server.')
  })

  it('phone: a take the server calls too long is not kept, no retry changes that', async () => {
    stand('iphone')
    voice.transcribeAudioCloud.mockRejectedValueOnce(new CloudJobError('payload too large', 413))
    await transcribeTake(take(), true)
    expect(useVoiceStore.getState().retryTakeReady).toBe(false)
    expect(failedTake()).toBeNull()
    // r44: a phone sentence, not the desktop one (mobile-dictation-errors.test.ts).
    expect(useVoiceStore.getState().sttError).toBe(DICTATION_TEXT.tooLong)
  })

  it('phone: without cloud voice the local Whisper is never called, and the take waits for the sign-in', async () => {
    stand('iphone')
    const blob = take()
    expect(await transcribeTake(blob, false)).toBe('')
    expect(voice.transcribeAudio).not.toHaveBeenCalled()
    expect(voice.transcribeAudioCloud).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().sttError).toBe(MOBILE_TEXT.dictationNeedsCloud)
    expect(failedTake()).toBe(blob)
  })

  for (const device of DESKTOPS) {
    it(`DESKTOP UNCHANGED ${device}: the take is dropped and the sentence is the old one`, async () => {
      stand(device)
      voice.transcribeAudioCloud.mockRejectedValueOnce(new CloudJobError('bad gateway', 502))
      expect(await transcribeTake(take(), true)).toBe('')
      expect(useVoiceStore.getState().retryTakeReady).toBe(false)
      expect(failedTake()).toBeNull()
      expect(useVoiceStore.getState().sttError).toBe('Cloud transcription is unavailable right now, try again')
    })

    it(`DESKTOP UNCHANGED ${device}: local mode transcribes with the local Whisper`, async () => {
      stand(device)
      voice.transcribeAudio.mockResolvedValueOnce('hello')
      expect(await transcribeTake(take(), false)).toBe('hello')
      expect(voice.transcribeAudioCloud).not.toHaveBeenCalled()
      expect(useVoiceStore.getState().transcript).toBe('hello')
      expect(useVoiceStore.getState().sttError).toBeNull()
    })
  }

  it('a silent take says so on both', async () => {
    for (const device of ['iphone', 'windows'] as const) {
      stand(device)
      voice.transcribeAudioCloud.mockResolvedValueOnce('  ')
      await transcribeTake(take(), true)
      expect(useVoiceStore.getState().sttError).toBe('No speech detected, try again')
      expect(useVoiceStore.getState().retryTakeReady).toBe(false)
    }
  })
})

describe('an empty wallet', () => {
  it('phone: dictation opens the credits dialog and keeps the take', async () => {
    stand('iphone')
    voice.transcribeAudioCloud.mockRejectedValueOnce(outOfCredits())
    await transcribeTake(take(), true)
    expect(creditsDialog).toHaveBeenCalledTimes(1)
    expect((creditsDialog.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: 'credits' })
    expect(useVoiceStore.getState().retryTakeReady).toBe(true)
    expect(useVoiceStore.getState().sttError).toBe(DICTATION_TEXT.outOfCredits)
  })

  it('phone: a plain "too fast" 429 opens nothing', async () => {
    stand('iphone')
    voice.transcribeAudioCloud.mockRejectedValueOnce(new CloudJobError('slow down', 429, { code: 'rate_limited' }))
    await transcribeTake(take(), true)
    expect(creditsDialog).not.toHaveBeenCalled()
    expect(signalVoiceOutOfCredits(new CloudJobError('slow down', 429))).toBe(false)
    expect(signalVoiceOutOfCredits(new Error('credits_exhausted'))).toBe(false)
  })

  it('phone: read-aloud opens the dialog and does not switch to a second voice', async () => {
    stand('android')
    voice.synthesizeCloud.mockRejectedValueOnce(outOfCredits())
    await speakOnPhone('Hello there.', true, true)
    expect(creditsDialog).toHaveBeenCalledTimes(1)
    expect(voice.speakStreaming).not.toHaveBeenCalled()
    expect(voice.speak).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().ttsFallbackReason).toBe(MOBILE_TEXT.readAloudOutOfCredits)
    expect(useVoiceStore.getState().isSpeaking).toBe(false)
  })

  for (const device of DESKTOPS) {
    it(`DESKTOP UNCHANGED ${device}: the same answer stays a line under the microphone`, async () => {
      stand(device)
      voice.transcribeAudioCloud.mockRejectedValueOnce(outOfCredits())
      await transcribeTake(take(), true)
      expect(creditsDialog).not.toHaveBeenCalled()
      expect(signalVoiceOutOfCredits(outOfCredits())).toBe(false)
      expect(useVoiceStore.getState().sttError).toBe('monthly credit budget exhausted')
    })
  }
})

describe('read-aloud on a phone', () => {
  const noLocalEngine = () => {
    expect(voice.recheckTtsAvailable).not.toHaveBeenCalled()
    expect(voice.synthesizeNeural).not.toHaveBeenCalled()
    expect(voice.synthesizeExternal).not.toHaveBeenCalled()
  }

  it('LU Cloud speaks, chunk after chunk, and no local engine is asked', async () => {
    stand('iphone')
    voice.synthesizeCloud.mockResolvedValue('blob:clip')
    await speakOnPhone('Hello there.', true, true)
    expect(voice.synthesizeCloud).toHaveBeenCalledTimes(1)
    expect(voice.playNeuralAudio).toHaveBeenCalledWith('blob:clip')
    expect(voice.speakStreaming).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().ttsFallbackReason).toBeNull()
    expect(useVoiceStore.getState().isSpeaking).toBe(false)
    noLocalEngine()
  })

  it('a cloud failure goes straight to the system voice and says so, never to Piper', async () => {
    stand('iphone')
    // An external engine configured on another device must not be tried either.
    useVoiceStore.setState({ ttsMode: 'external', externalTtsUrl: 'http://localhost:8880/v1/audio/speech', ttsAvailable: true })
    voice.synthesizeCloud.mockRejectedValueOnce(new CloudJobError('bad gateway', 502))
    await speakOnPhone('Hello there.', true, true)
    expect(voice.speakStreaming).toHaveBeenCalledTimes(1)
    expect(voice.speakStreaming.mock.calls[0][0]).toBe('Hello there.')
    expect(useVoiceStore.getState().ttsFallbackReason).toBe(MOBILE_TEXT.readAloudCloudFailedSystemVoice)
    noLocalEngine()
  })

  it('a cloud failure without a system voice says what to do', async () => {
    stand('android')
    voice.isSpeechSynthesisSupported.mockReturnValue(false)
    voice.synthesizeCloud.mockRejectedValueOnce(new CloudJobError('bad gateway', 502))
    await speakOnPhone('Hello there.', false, true)
    expect(voice.speak).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().ttsFallbackReason).toBe(MOBILE_TEXT.readAloudCloudFailed)
    noLocalEngine()
  })

  it('without cloud voice the system voice reads, without a word about Piper', async () => {
    stand('iphone')
    await speakOnPhone('Hello there.', false, false)
    expect(voice.synthesizeCloud).not.toHaveBeenCalled()
    expect(voice.speak).toHaveBeenCalledTimes(1)
    expect(useVoiceStore.getState().ttsFallbackReason).toBeNull()
    noLocalEngine()
  })

  it('without cloud voice and without a system voice it names the sign-in', async () => {
    stand('android')
    voice.isSpeechSynthesisSupported.mockReturnValue(false)
    await speakOnPhone('Hello there.', false, false)
    expect(useVoiceStore.getState().ttsFallbackReason).toBe(MOBILE_TEXT.readAloudNeedsCloud)
    expect(useVoiceStore.getState().isSpeaking).toBe(false)
  })

  it('read-aloud switched off reads nothing', async () => {
    stand('iphone')
    useVoiceStore.setState({ ttsEnabled: false })
    await speakOnPhone('Hello there.', true, true)
    expect(voice.synthesizeCloud).not.toHaveBeenCalled()
    expect(voice.speakStreaming).not.toHaveBeenCalled()
  })

  it('Stop during the cloud synthesis aborts it, and nothing is spoken afterwards', async () => {
    stand('iphone')
    let signal: AbortSignal | undefined
    voice.synthesizeCloud.mockImplementation((_t: string, _v: unknown, s: AbortSignal) => {
      signal = s
      return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    const speaking = speakOnPhone('Hello there.', true, true)
    await vi.waitFor(() => expect(voice.synthesizeCloud).toHaveBeenCalled())
    stopSpeechPlayback()
    await speaking
    expect(signal!.aborted).toBe(true)
    expect(voice.speakStreaming).not.toHaveBeenCalled()
    expect(voice.playNeuralAudio).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().ttsFallbackReason).toBeNull()
  })

  it('the hook takes this road on a phone before anything else, and the desktop road is behind it', () => {
    const speak = hookSource.slice(hookSource.indexOf('const speakInternal = useCallback('))
    expect(speak).toMatch(/async \(text: string, streaming: boolean\) => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(!hasLocalVoice\(\)\) return speakOnPhone\(text, streaming, cloudVoice\);\s*if \(!store\.ttsEnabled\) return;/)
    // The desktop road still knows its three engines.
    // N1: the external road resolves its address first (External HTTP or LU Engine).
    expect(speak).toContain('synthesizeExternal(text, ttsExt!.url')
    expect(speak).toContain('piperReady = await recheckTtsAvailable(store.piperVoice);')
    expect(speak).toContain('"Piper is installed but not responding, so read-aloud used the system voice instead."')
  })
})

describe('leaving the screen', () => {
  function recorder(blob: Blob): AudioRecorder & { stop: ReturnType<typeof vi.fn> } {
    let on = true
    return {
      start: async () => {},
      stop: vi.fn(async () => { on = false; return blob }),
      snapshot: () => blob,
      isRecording: () => on,
    } as never
  }

  it('phone: the recording ends, what was said is kept, and the user is told why', async () => {
    stand('iphone')
    const blob = take()
    const rec = recorder(blob)
    useVoiceStore.setState({ isRecording: true })
    await haltRecorderForBackground(rec)
    expect(rec.stop).toHaveBeenCalledTimes(1)
    expect(useVoiceStore.getState().isRecording).toBe(false)
    expect(failedTake()).toBe(blob)
    expect(useVoiceStore.getState().retryTakeReady).toBe(true)
    expect(useVoiceStore.getState().sttError).toBe(MOBILE_TEXT.dictationStoppedInBackground)
  })

  it('phone: an empty take leaves nothing to retry and no message', async () => {
    stand('iphone')
    await haltRecorderForBackground(recorder(new Blob([], { type: 'audio/wav' })))
    expect(useVoiceStore.getState().retryTakeReady).toBe(false)
    expect(useVoiceStore.getState().sttError).toBeNull()
  })

  it('nothing recording, nothing to do', async () => {
    stand('iphone')
    await haltRecorderForBackground(null)
    expect(useVoiceStore.getState().sttError).toBeNull()
  })

  it('playback stops through the same call any Stop button uses', () => {
    stand('iphone')
    useVoiceStore.setState({ isSpeaking: true })
    stopSpeechPlayback()
    expect(voice.stopNeuralAudio).toHaveBeenCalled()
    expect(voice.stopSpeaking).toHaveBeenCalled()
    expect(useVoiceStore.getState().isSpeaking).toBe(false)
  })

  it('the hook hangs both on the lifecycle seam, on a phone only', () => {
    const effect = hookSource.slice(hookSource.indexOf('// Phone only: leaving the screen ends read-aloud and dictation.'))
    expect(effect).toMatch(/useEffect\(\(\) => \{\s*if \(!isMobile\(\)\) return;\s*return onAppBackground\(\(\) => \{\s*stopSpeechPlayback\(\);/)
    expect(effect).toMatch(/void haltRecorderForBackground\(rec\);/)
  })

  it('DESKTOP UNCHANGED: close-to-tray still stops through app:hidden', () => {
    expect(hookSource).toMatch(/const stop = await listen\("app:hidden", \(\) => \{\s*stopSpeechPlayback\(\);/)
  })
})

describe('the sentences', () => {
  it('DESKTOP UNCHANGED: word for word', () => {
    stand('windows')
    expect(sttErrorMessage(new CloudJobError('x', 401))).toBe('Signed out, sign in again to use cloud dictation')
    expect(sttErrorMessage(new CloudJobError('x', 413))).toBe('Recording too long, try a shorter take')
    expect(sttErrorMessage(new CloudJobError('x', 503))).toBe('Cloud transcription is unavailable right now, try again')
    expect(sttErrorMessage(new CloudJobError('your plan does not include cloud voice', 403))).toBe('your plan does not include cloud voice')
    expect(sttErrorMessage(new Error('boom'))).toBe('Transcription failed, check the microphone and try again')
    expect(sttErrorMessage('Speech-to-text needs faster-whisper')).toBe('Speech-to-text needs faster-whisper')
    expect(hookSource).toContain('store.setSttError(platformText("micUnavailable"));')
  })

  it('phone: each one names the next step and nothing a phone lacks', () => {
    stand('iphone')
    const said = [
      sttErrorMessage(new CloudJobError('x', 401)),
      sttErrorMessage(new CloudJobError('x', 503)),
      sttErrorMessage(new Error('boom')),
      ...Object.values(MOBILE_TEXT),
    ]
    expect(said[0]).toBe('Signed out. Sign in to your LU Cloud account again, then tap retry. Your recording is kept.')
    expect(said[2]).toBe('Transcription failed. Your recording is kept, check the connection and tap retry.')
    for (const s of said) {
      expect(s).not.toMatch(/System Settings|Piper|faster-whisper|Settings →|click|this computer|[\u2013\u2014]/i)
      expect(s.endsWith('.')).toBe(true)
    }
  })
})
