// @vitest-environment jsdom
/**
 * Voice over remote (GitHub #212), the whole turn in a chat with the computer:
 * hold to talk sends one message and reads the answer; a tap is hands free,
 * which hears the end of a sentence, reads the answer and listens again until
 * End. The microphone, the voice of the phone and the computer are fakes; the
 * hook, the composer and the line in place of the field are the real ones.
 *
 * Run: npx vitest run src/mobile/screens/remote/__tests__/remote-voice-flow.dom.test.tsx
 */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const fake = vi.hoisted(() => ({
  level: 0,
  takes: 0,
  stops: 0,
  sentTakes: [] as number[],
  spoken: [] as string[],
  computer: { listen: true, speak: false, why: null as string | null },
  transcript: 'what time is it',
}))

vi.mock('../../../../api/voice', () => ({
  createAudioRecorder: () => ({
    start: async () => {},
    stop: async () => {
      fake.stops += 1
      return new Blob([new Uint8Array(2000)], { type: 'audio/wav' })
    },
  }),
  playNeuralAudio: async () => {},
  stopNeuralAudio: () => {},
}))
vi.mock('../../../../hooks/useVoice', () => ({
  startRecorderWithStream: async () => {
    fake.takes += 1
    return {} as MediaStream
  },
  startLevelMeter: () => ({ stop: () => {} }),
  voiceLevel: () => fake.level,
  useVoiceLevel: () => fake.level,
}))
vi.mock('../../../lib/speech', () => ({
  listPhoneVoices: async () => ({ source: 'web', voices: [] }),
  speakOnDevice: async (words: string) => {
    fake.spoken.push(words)
    return { source: 'web', spoken: true }
  },
  stopDeviceSpeech: async () => {},
}))
vi.mock('../../../remote/remoteVoice', async (orig) => {
  const real = await orig<typeof import('../../../remote/remoteVoice')>()
  return {
    ...real,
    getComputerVoice: async () => ({ ...fake.computer, maxTakeBytes: 4e6, maxTakeMs: 120000, maxSpeakChars: 1500 }),
    transcribeOnComputer: async (_ch: unknown, wav: Uint8Array) => {
      fake.sentTakes.push(wav.length)
      return fake.transcript
    },
  }
})

import { Composer } from '../../../ui'
import { RemoteVoiceLine, useRemoteVoice } from '../parts/RemoteVoice'
import { useMobilePrefs } from '../../settings/parts/prefs'

const channel = { address: 'http://lan', pin: { desktopId: 'd', x25519: 'k' }, invoke: async () => ({}), fetch: async () => new Response(), features: ['voice'] }

/** A chat that answers each message after `answerMs`. */
function Chat({ answerMs = 500 }: { answerMs?: number }) {
  const [messages, setMessages] = useState<Array<{ id: string; role: string; text: string }>>([])
  const [busy, setBusy] = useState(false)
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  const voice = useRemoteVoice({
    channel: () => channel as never,
    ready: true,
    send: (text) => {
      setMessages((m) => [...m, { id: `u${m.length}`, role: 'user', text }])
      setBusy(true)
      setTimeout(() => {
        setMessages((m) => [...m, { id: `a${m.length}`, role: 'assistant', text: `**It is** noon. (${text})` }])
        setBusy(false)
      }, answerMs)
      return true
    },
    busy,
    lastAnswer: last ? { id: last.id, text: last.text } : null,
  })
  return (
    <>
      <ol data-testid="msgs">{messages.map((m) => <li key={m.id}>{m.role}: {m.text}</li>)}</ol>
      <Composer value="" onChange={() => {}} onSend={() => {}} running={busy} onStop={() => {}} idPrefix="m-remote-chat" micHold={voice.micHold} dictation={voice.dictation} replaceField={voice.phase !== 'off' ? <RemoteVoiceLine voice={voice} /> : undefined} />
    </>
  )
}

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  Object.assign(fake, { level: 0, takes: 0, stops: 0, sentTakes: [], spoken: [], computer: { listen: true, speak: false, why: null }, transcript: 'what time is it' })
  useMobilePrefs.setState({ remoteVoiceReadAloud: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('push to talk', () => {
  it('hold, talk, let go: one message, the answer is read, then the field is back', async () => {
    render(<Chat />)
    const mic = screen.getByTestId('m-remote-chat-mic')
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    })
    await flush(10)
    expect(screen.getByTestId('m-remote-voice').getAttribute('data-state')).toBe('recording')
    // The finger is on the microphone: letting go ends the take, there is no End.
    expect(screen.queryByTestId('m-remote-voice-end')).toBeNull()
    fake.level = 0.4
    await flush(1200)
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId('m-remote-chat-mic'), { pointerId: 1 })
    })
    await flush(10)
    expect(fake.sentTakes).toHaveLength(1)
    expect(screen.getByTestId('msgs').textContent).toContain('user: what time is it')
    expect(screen.getByTestId('m-remote-voice').getAttribute('data-state')).toBe('waiting')
    await flush(600)
    expect(fake.spoken).toEqual(['It is noon. (what time is it)'])
    await flush(10)
    expect(screen.queryByTestId('m-remote-voice')).toBeNull()
    expect(screen.getByTestId('m-remote-chat-input')).toBeTruthy()
    expect(fake.takes).toBe(1)
  })

  it('a press too short to hold a word sends nothing', async () => {
    render(<Chat />)
    const mic = screen.getByTestId('m-remote-chat-mic')
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    })
    await flush(350)
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId('m-remote-chat-mic'), { pointerId: 1 })
    })
    await flush(10)
    expect(fake.sentTakes).toHaveLength(0)
    expect(screen.queryByTestId('m-remote-voice')).toBeNull()
  })

  it('with Read the answer aloud off, nothing is read', async () => {
    useMobilePrefs.setState({ remoteVoiceReadAloud: false })
    render(<Chat />)
    const mic = screen.getByTestId('m-remote-chat-mic')
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    })
    await flush(1000)
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId('m-remote-chat-mic'), { pointerId: 1 })
    })
    await flush(700)
    expect(fake.sentTakes).toHaveLength(1)
    expect(fake.spoken).toEqual([])
    expect(screen.queryByTestId('m-remote-voice')).toBeNull()
  })

  it('without speech recognition on the computer, the reason and no recording', async () => {
    fake.computer = { listen: false, speak: false, why: 'Install speech to text on the computer.' }
    render(<Chat />)
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('m-remote-chat-mic'), { button: 0, pointerId: 1 })
    })
    await flush(10)
    expect(fake.takes).toBe(0)
    expect(screen.queryByTestId('m-remote-voice')).toBeNull()
  })
})

describe('hands free', () => {
  it('a tap listens; a sentence and a pause send it, the answer is read, it listens again until End', async () => {
    render(<Chat />)
    const mic = screen.getByTestId('m-remote-chat-mic')
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
      fireEvent.pointerUp(mic, { pointerId: 1 })
    })
    await flush(10)
    const line = screen.getByTestId('m-remote-voice')
    expect(line.getAttribute('data-m-mode')).toBe('free')
    // Quiet before speaking: nothing is sent.
    await flush(2000)
    expect(fake.sentTakes).toHaveLength(0)
    fake.level = 0.4
    await flush(1500)
    fake.level = 0.01
    await flush(1400)
    expect(fake.sentTakes).toHaveLength(1)
    await flush(600)
    expect(fake.spoken).toHaveLength(1)
    await flush(20)
    // Listening again.
    expect(fake.takes).toBe(2)
    expect(screen.getByTestId('m-remote-voice').getAttribute('data-state')).toBe('recording')
    await act(async () => {
      fireEvent.click(screen.getByTestId('m-remote-voice-end'))
    })
    await flush(10)
    expect(screen.queryByTestId('m-remote-voice')).toBeNull()
    expect(fake.sentTakes).toHaveLength(1)
  })

  it('a long silence ends hands free', async () => {
    render(<Chat />)
    const mic = screen.getByTestId('m-remote-chat-mic')
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
      fireEvent.pointerUp(mic, { pointerId: 1 })
    })
    await flush(31_000)
    expect(screen.queryByTestId('m-remote-voice')).toBeNull()
    expect(fake.sentTakes).toHaveLength(0)
  })

  it('a press while the answer is read stops the reading and starts a new take', async () => {
    render(<Chat answerMs={100} />)
    let mic = screen.getByTestId('m-remote-chat-mic')
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    })
    await flush(900)
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId('m-remote-chat-mic'), { pointerId: 1 })
    })
    // The fake voice resolves at once; stop it in the speaking phase by holding it there.
    await flush(150)
    mic = screen.getByTestId('m-remote-chat-mic')
    await act(async () => {
      fireEvent.pointerDown(mic, { button: 0, pointerId: 2 })
    })
    await flush(10)
    expect(screen.getByTestId('m-remote-voice').getAttribute('data-state')).toBe('recording')
    expect(fake.takes).toBe(2)
  })
})
