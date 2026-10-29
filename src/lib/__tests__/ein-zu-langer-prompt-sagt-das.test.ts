// T1 Nacht-Durchtest 3.0.9 (Mac, Ollama, 16K-Fenster): ein Prompt von
// 204.062 Zeichen kam als HTTP 400 "request (42120 tokens) exceeds the
// available context size (16384 tokens)" zurueck, und die Blase sagte den
// allgemeinen 400-Satz: "Send the message again ... nothing was charged".
// Nochmal senden hilft nicht, und bei einem lokalen Modell wird nichts
// berechnet. Die Ursache stand nur im Detail darunter.
import { describe, expect, it } from 'vitest'
import { BAD_REQUEST_SENTENCE, CONTEXT_OVERFLOW_REFUSAL_SENTENCE, explainSendRefusal } from '../template-refusal'

const overflow = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 })

describe('a prompt longer than the context window', () => {
  it('says that the message is too long, not "send it again"', () => {
    const text = explainSendRefusal(overflow('request (42120 tokens) exceeds the available context size (16384 tokens), try increasing it'))!
    expect(text.startsWith(CONTEXT_OVERFLOW_REFUSAL_SENTENCE)).toBe(true)
    expect(text).not.toContain(BAD_REQUEST_SENTENCE)
    expect(text).toContain('16384 tokens')
  })

  it('names the way out the desktop has', () => {
    expect(CONTEXT_OVERFLOW_REFUSAL_SENTENCE).toMatch(/Context window/)
    expect(CONTEXT_OVERFLOW_REFUSAL_SENTENCE).not.toMatch(/charged|send the message again/i)
  })

  it('also for the wordings of other servers', () => {
    for (const m of ["This model's maximum context length is 8192 tokens", 'prompt is too long: 9000 tokens > 8192']) {
      expect(explainSendRefusal(overflow(m))!.startsWith(CONTEXT_OVERFLOW_REFUSAL_SENTENCE)).toBe(true)
    }
  })

  it('leaves any other 400 alone', () => {
    expect(explainSendRefusal(overflow('invalid request'))!.startsWith(BAD_REQUEST_SENTENCE)).toBe(true)
  })
})
