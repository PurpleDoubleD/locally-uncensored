/**
 * Voice over remote (GitHub #212): the pure parts of remote/remoteVoice.ts and
 * that the page in the phone's browser (mobile-client/client.js) keeps to the
 * same numbers and the same routes.
 *
 * Run: npx vitest run src/mobile/remote/__tests__/remoteVoice.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  END_QUIET_MS,
  GIVE_UP_MS,
  HOLD_MS,
  MIN_TAKE_MS,
  nextTurn,
  pressKind,
  QUIET_LEVEL,
  readComputerVoice,
  SPEECH_LEVEL,
  SPEECH_MIN_MS,
  speakableText,
  speechPieces,
  startTurn,
  voiceErrorOf,
  VOICE_PATHS,
  type TurnState,
} from '../remoteVoice'

const ROOT = join(__dirname, '..', '..', '..', '..')

/** Feed levels every 90 ms like the meter does and collect the events with their time. The caller stops at 'end' or 'give-up', so does this. */
function feed(levels: Array<[number, number]>): Array<[number, string]> {
  let state: TurnState = startTurn(0)
  let t = 0
  const out: Array<[number, string]> = []
  for (const [level, ms] of levels) {
    const until = t + ms
    for (; t < until; t += 90) {
      const step = nextTurn(state, level, t)
      state = step.state
      if (step.event) out.push([t, step.event])
      if (step.event === 'end' || step.event === 'give-up') return out
    }
  }
  return out
}

describe('the status of the computer', () => {
  it('reads what is there and counts anything missing as cannot', () => {
    expect(readComputerVoice({ listen: true, speak: false, max_take_bytes: 1000, max_take_ms: 5000, max_speak_chars: 200, why: null })).toEqual({
      listen: true, speak: false, maxTakeBytes: 1000, maxTakeMs: 5000, maxSpeakChars: 200, why: null,
    })
    const none = readComputerVoice('nonsense')
    expect(none.listen).toBe(false)
    expect(none.speak).toBe(false)
    expect(none.maxSpeakChars).toBe(1500)
    expect(readComputerVoice({ listen: false, why: '  Install   speech to text. ' }).why).toBe('Install speech to text.')
  })

  it('turns an answer that is not 2xx into what to tell the user', () => {
    expect(voiceErrorOf(404, null).code).toBe('too-old')
    expect(voiceErrorOf(413, { error: 'too_long', message: 'Too long.' }).message).toBe('Too long.')
    expect(voiceErrorOf(409, { error: 'no_listen', message: 'Set it up.' })).toMatchObject({ code: 'no-listen', message: 'Set it up.' })
    expect(voiceErrorOf(502, { error: 'failed', message: 'Whisper not available' })).toMatchObject({ code: 'failed', message: 'Whisper not available' })
    expect(voiceErrorOf(500, null).code).toBe('protocol')
  })
})

describe('what of an answer is read aloud', () => {
  it('leaves out code, thoughts, links and the marks of Markdown', () => {
    const md = '<think>plan it</think>## Result\n\nThe **answer** is `42`, see [the docs](https://x.y/z).\n\n```js\nconsole.log(1)\n```\n- one\n- two\n> quoted'
    expect(speakableText(md)).toBe('Result The answer is 42, see the docs. one two quoted')
  })

  it('cuts long text after a sentence, never in the middle of a word', () => {
    const text = 'One sentence here. ' + 'Another one that goes on. '.repeat(10)
    const pieces = speechPieces(text, 60)
    expect(pieces.every((p) => p.length <= 60)).toBe(true)
    expect(pieces.join(' ')).toBe(text.trim())
    expect(pieces[0].endsWith('.')).toBe(true)
    expect(speechPieces('short', 60)).toEqual(['short'])
    expect(speechPieces('', 60)).toEqual([])
  })
})

describe('hands free hears the end of a sentence', () => {
  it('a sentence and a pause end the take once', () => {
    const events = feed([[0, 1000], [0.4, 1500], [0.01, 2000]])
    expect(events.map((e) => e[1])).toEqual(['speech', 'end'])
    const [speechAt, endAt] = events.map((e) => e[0])
    expect(speechAt).toBeGreaterThanOrEqual(1000 + SPEECH_MIN_MS)
    expect(endAt - 2500).toBeGreaterThanOrEqual(END_QUIET_MS - 90)
    expect(endAt - 2500).toBeLessThan(END_QUIET_MS + 200)
  })

  it('a click or a cough does not start a take', () => {
    expect(feed([[0.5, 150], [0, 2000]])).toEqual([])
  })

  it('a short breath between words does not end it', () => {
    const events = feed([[0.4, 800], [0.02, 600], [0.4, 800], [0.02, 1500]])
    expect(events.filter((e) => e[1] === 'end')).toHaveLength(1)
    expect(events.find((e) => e[1] === 'end')![0]).toBeGreaterThan(2200)
  })

  it('a fading word between the two levels keeps the take open', () => {
    expect(QUIET_LEVEL).toBeLessThan(SPEECH_LEVEL)
    const events = feed([[0.4, 800], [(QUIET_LEVEL + SPEECH_LEVEL) / 2, 3000]])
    expect(events.map((e) => e[1])).toEqual(['speech'])
  })

  it('a long silence gives up', () => {
    const events = feed([[0, GIVE_UP_MS + 500]])
    expect(events[0][1]).toBe('give-up')
    expect(events[0][0]).toBeGreaterThanOrEqual(GIVE_UP_MS)
  })
})

describe('the press on the microphone', () => {
  it('short is a tap, long is push to talk', () => {
    expect(pressKind(1000, 1000 + HOLD_MS - 1)).toBe('tap')
    expect(pressKind(1000, 1000 + HOLD_MS)).toBe('hold')
    expect(MIN_TAKE_MS).toBeGreaterThan(HOLD_MS)
  })
})

describe('the page in the phone browser keeps to the same', () => {
  const client = readFileSync(join(ROOT, 'mobile-client', 'client.js'), 'utf8')
  const page = readFileSync(join(ROOT, 'mobile-client', 'index.html'), 'utf8')
  const num = (name: string) => Number(client.match(new RegExp(`var ${name} = ([0-9.]+);`))?.[1])

  it('the same levels and times', () => {
    expect(num('VOICE_SPEECH_LEVEL')).toBe(SPEECH_LEVEL)
    expect(num('VOICE_QUIET_LEVEL')).toBe(QUIET_LEVEL)
    expect(num('VOICE_SPEECH_MIN_MS')).toBe(SPEECH_MIN_MS)
    expect(num('VOICE_END_QUIET_MS')).toBe(END_QUIET_MS)
    expect(num('VOICE_GIVE_UP_MS')).toBe(GIVE_UP_MS)
    expect(num('VOICE_HOLD_MS')).toBe(HOLD_MS)
    expect(num('VOICE_MIN_TAKE_MS')).toBe(MIN_TAKE_MS)
  })

  it('the same routes, and the answer is read when the chat or the agent finishes', () => {
    for (const path of Object.values(VOICE_PATHS)) expect(client).toContain(`'${path}'`)
    const finishStream = client.slice(client.indexOf('function finishStream(){'))
    expect(finishStream.slice(0, finishStream.indexOf('\n  }'))).toContain('voiceAnswerDone();')
    expect(client).toMatch(/postChatEvent\('assistant', finalText\);\s*syncCurrentChat\(\);\s*voiceAnswerDone\(\);/)
  })

  it('may play the voice of the computer (a blob: URL) under its CSP, and nothing from elsewhere', () => {
    expect(page).toMatch(/media-src 'self' blob:;/)
    expect(page).toMatch(/connect-src 'self';/)
  })

  it('says why the microphone does not open over the plain Wi-Fi address', () => {
    expect(client).toMatch(/window\.isSecureContext/)
    expect(client).toMatch(/insecure: '[^']*secure page[^']*LU app[^']*'/)
  })
})
