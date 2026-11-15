/**
 * Two things the phone's voice lacked (mobile round 2, audit L11 and L18):
 *
 *  - the switch "Use the system voice when Cloud is off" had no reader:
 *    read-aloud fell back to the voice of the WebView whatever it said
 *  - the recording line showed a clock and no level: nothing told the user
 *    that the phone hears anything
 *
 * Every phone assertion has a desktop twin that pins the old behaviour.
 *
 * Run: npx vitest run src/hooks/__tests__/voice-pegel-und-systemstimme.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DESKTOPS, HANDHELDS, standOn, type DeviceName } from '../../test-support/devices'

const voice = vi.hoisted(() => ({
  synthesizeCloud: vi.fn(),
  playNeuralAudio: vi.fn(async () => {}),
  stopNeuralAudio: vi.fn(),
  stopSpeaking: vi.fn(),
  isSpeechSynthesisSupported: vi.fn(() => true),
  speak: vi.fn(async () => {}),
  speakStreaming: vi.fn(async (_text: string, ..._rest: unknown[]) => {}),
  getVoicesAsync: vi.fn(async () => [{ name: 'Samantha' }, { name: 'Daniel' }]),
}))
vi.mock('../../api/voice', async (orig) => ({ ...((await orig()) as object), ...voice }))
vi.mock('../../lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import {
  levelFromSamples, setPhoneSpeech, setSystemVoiceAllowed, speakOnPhone, startRecorderWithStream, stopSpeechPlayback,
  subscribeVoiceLevel, systemVoiceUsable, voiceLevel,
} from '../useVoice'
import { useVoiceStore } from '../../stores/voiceStore'
import { MOBILE_TEXT } from '../../lib/platform-text'
import type { AudioRecorder } from '../../api/voice'

const here = dirname(fileURLToPath(import.meta.url))
const hookSource = readFileSync(resolve(here, '../useVoice.ts'), 'utf8')

function stand(device: DeviceName, extra: Record<string, unknown> = {}) {
  standOn(device, extra as never)
  vi.stubGlobal('window', new EventTarget())
}

beforeEach(() => {
  for (const fn of Object.values(voice)) fn.mockClear()
  voice.synthesizeCloud.mockReset()
  voice.isSpeechSynthesisSupported.mockReturnValue(true)
  setSystemVoiceAllowed(null)
  useVoiceStore.setState({ isSpeaking: false, ttsFallbackReason: null, ttsEnabled: true, ttsVoice: '', ttsRate: 1, ttsPitch: 1 })
})
afterEach(() => {
  stand('iphone')
  stopSpeechPlayback()
  setSystemVoiceAllowed(null)
  vi.unstubAllGlobals()
})

describe('the system voice is a preference on a phone', () => {
  for (const device of HANDHELDS) {
    it(`${device}: allowed by default, and off when the shell says so`, () => {
      stand(device)
      expect(systemVoiceUsable()).toBe(true)
      setSystemVoiceAllowed(() => false)
      expect(systemVoiceUsable()).toBe(false)
      setSystemVoiceAllowed(() => true)
      expect(systemVoiceUsable()).toBe(true)
    })
  }
  it('a check that throws counts as allowed, and no voice at all is never usable', () => {
    stand('android')
    setSystemVoiceAllowed(() => {
      throw new Error('store not ready')
    })
    expect(systemVoiceUsable()).toBe(true)
    voice.isSpeechSynthesisSupported.mockReturnValue(false)
    expect(systemVoiceUsable()).toBe(false)
  })
  for (const device of DESKTOPS) {
    it(`DESKTOP UNCHANGED ${device}: the preference of the phone is never asked`, () => {
      stand(device)
      const check = vi.fn(() => false)
      setSystemVoiceAllowed(check)
      expect(systemVoiceUsable()).toBe(true)
      expect(check).not.toHaveBeenCalled()
    })
  }

  it('cloud off and the system voice switched off: nothing speaks, and the reason is said', async () => {
    stand('iphone')
    setSystemVoiceAllowed(() => false)
    await speakOnPhone('Hello there.', true, false)
    expect(voice.speakStreaming).not.toHaveBeenCalled()
    expect(voice.speak).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().ttsFallbackReason).toBe(MOBILE_TEXT.readAloudNeedsCloud)
    expect(useVoiceStore.getState().isSpeaking).toBe(false)
  })

  it('cloud off and the system voice allowed: it speaks with the voice, speed and pitch from the settings', async () => {
    stand('iphone')
    useVoiceStore.setState({ ttsVoice: 'Daniel', ttsRate: 1.4, ttsPitch: 0.8 })
    await speakOnPhone('Hello there.', true, false)
    expect(voice.speakStreaming).toHaveBeenCalledTimes(1)
    const [text, picked, rate, pitch] = voice.speakStreaming.mock.calls[0] as unknown as [string, { name: string }, number, number]
    expect(text).toBe('Hello there.')
    expect(picked).toEqual({ name: 'Daniel' })
    expect(rate).toBe(1.4)
    expect(pitch).toBe(0.8)
  })

  it('a cloud failure does not fall back to a system voice the user switched off', async () => {
    stand('android')
    setSystemVoiceAllowed(() => false)
    voice.synthesizeCloud.mockRejectedValueOnce(new Error('503'))
    await speakOnPhone('Hello there.', true, true)
    expect(voice.speakStreaming).not.toHaveBeenCalled()
    expect(useVoiceStore.getState().ttsFallbackReason).toBe(MOBILE_TEXT.readAloudCloudFailed)
  })

  it('with the door of the shell the phone speaks through it, also without speechSynthesis (Android)', async () => {
    stand('android')
    const spoken: Array<{ text: string; options: unknown }> = []
    let stops = 0
    setPhoneSpeech({
      source: () => 'native',
      speak: async (text, options) => {
        spoken.push({ text, options })
        return { spoken: true }
      },
      stop: () => void stops++,
    })
    try {
      expect(systemVoiceUsable()).toBe(true)
      useVoiceStore.setState({ ttsVoice: '', ttsRate: 1.2, ttsPitch: 1 })
      await speakOnPhone('Hello there.', true, false)
      expect(spoken).toEqual([{ text: 'Hello there.', options: { voiceId: undefined, rate: 1.2, pitch: 1 } }])
      expect(voice.speakStreaming).not.toHaveBeenCalled()
      stopSpeechPlayback()
      expect(stops).toBe(1)
    } finally {
      setPhoneSpeech(null)
    }
  })

  it('a door that knows the phone has no voice: nothing is usable, and the reason is said', async () => {
    stand('android')
    setPhoneSpeech({ source: () => 'none', speak: async () => ({ spoken: false }), stop: () => undefined })
    try {
      expect(systemVoiceUsable()).toBe(false)
      await speakOnPhone('Hello there.', true, false)
      expect(useVoiceStore.getState().ttsFallbackReason).toBe(MOBILE_TEXT.readAloudNeedsCloud)
    } finally {
      setPhoneSpeech(null)
    }
  })

  it('the hook reports the same answer as "is there a system voice"', () => {
    expect(hookSource).toMatch(/const ttsSupported = systemVoiceUsable\(\);/)
    expect(hookSource).toMatch(/const systemVoice = systemVoiceUsable\(\);/)
  })
})

describe('the level of the microphone', () => {
  it('silence is 0, a full swing is 1, speech is in between', () => {
    expect(levelFromSamples(new Uint8Array(256).fill(128))).toBe(0)
    expect(levelFromSamples([])).toBe(0)
    const loud = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 255 : 0))
    expect(levelFromSamples(loud)).toBe(1)
    const speech = Uint8Array.from({ length: 256 }, (_, i) => 128 + Math.round(Math.sin(i / 4) * 12))
    const level = levelFromSamples(speech)
    expect(level).toBeGreaterThan(0.15)
    expect(level).toBeLessThan(0.5)
  })

  it('is 0 while nothing records, and a listener can come and go', () => {
    expect(voiceLevel()).toBe(0)
    const off = subscribeVoiceLevel(() => {})
    expect(typeof off).toBe('function')
    off()
  })

  // 3.1.0: the live trace in every composer needs the level on desktop and
  // web too, so the meter starts on every device (it was phone only, L18).
  it('the hook hands the level out and starts the meter on every device', () => {
    expect(hookSource).toMatch(/getLevel: voiceLevel,/)
    expect(hookSource).toMatch(/const stream = await startRecorderWithStream\(recorder\);\s+dropMeter\(meterRef\);\s+meterRef\.current = stream \? startLevelMeter\(stream\) : null;/)
    expect(hookSource).not.toMatch(/if \(isMobile\(\)\) \{\s+\/\/[^\n]*\n\s+const stream = await startRecorderWithStream/)
    expect(hookSource).not.toMatch(/\} else \{\s+await recorder\.start\(\);\s+\}/)
  })

  it('every way a take ends also ends the meter', () => {
    // unmount, close to tray, a failed start, stop, leaving the screen
    expect(hookSource.match(/dropMeter\(meterRef\);/g)?.length).toBeGreaterThanOrEqual(6)
  })
})

describe('taking the stream of the recorder for the meter', () => {
  const recorderThatAsks = (): AudioRecorder => ({
    start: async () => {
      await navigator.mediaDevices.getUserMedia({ audio: true })
    },
    stop: async () => new Blob([]),
    snapshot: () => null,
    isRecording: () => true,
  })

  it('hands back the stream the recorder was given, and puts the request function back', async () => {
    const stream = { id: 'mic' } as unknown as MediaStream
    const proto = { getUserMedia: vi.fn(async () => stream) }
    const devices = Object.create(proto) as MediaDevices
    stand('android', { mediaDevices: devices })
    const seen = await startRecorderWithStream(recorderThatAsks())
    expect(seen).toBe(stream)
    expect(proto.getUserMedia).toHaveBeenCalledWith({ audio: true })
    // The method of the prototype is what answers again, not a leftover wrapper.
    expect(Object.prototype.hasOwnProperty.call(devices, 'getUserMedia')).toBe(false)
    expect(devices.getUserMedia).toBe(proto.getUserMedia)
  })

  it('a refused microphone is still the recorder\'s error, and the request function is put back', async () => {
    const denied = new Error('Permission denied')
    const proto = { getUserMedia: vi.fn(async () => { throw denied }) }
    const devices = Object.create(proto) as MediaDevices
    stand('android', { mediaDevices: devices })
    await expect(startRecorderWithStream(recorderThatAsks())).rejects.toBe(denied)
    expect(devices.getUserMedia).toBe(proto.getUserMedia)
  })

  it('without media devices the recorder starts as before and there is no stream', async () => {
    stand('android')
    const start = vi.fn(async () => {})
    const seen = await startRecorderWithStream({ start, stop: async () => new Blob([]), snapshot: () => null, isRecording: () => true })
    expect(start).toHaveBeenCalledTimes(1)
    expect(seen).toBeNull()
  })
})
