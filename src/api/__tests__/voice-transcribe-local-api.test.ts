/**
 * GitHub #115 (graysoncooper), browser voice recording always failed.
 *
 * Two halves:
 *  1. The /local-api security middleware enforced application/json on EVERY
 *     POST body and 415'd the transcribe POST, whose body IS the recorded
 *     audio, before the whisper handler ever saw it.
 *  2. The client called res.json() on whatever came back. The gates answer
 *     text/plain, so the refusal died in the JSON parser and the user was
 *     told to check the microphone while the real reason was thrown away.
 *
 * These tests drive the REAL client (transcribeAudio, checkWhisperAvailable)
 * against a stub of the REAL middleware, built from the same local-api-guard
 * module vite.config.ts uses, so the whole browser path from the recorded WAV
 * to the transcript is exercised in one place.
 *
 * Run: npx vitest run src/api/__tests__/voice-transcribe-local-api.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { transcribeAudio, checkWhisperAvailable, LocalSttError } from '../voice'
import { postContentTypeAllowed, postContentTypeError } from '../../lib/local-api-guard'
import { sttErrorMessage } from '../../hooks/useVoice'

/** What createAudioRecorder() hands transcribeAudio in browser mode: a 16 kHz
 *  mono WAV blob, so Content-Type goes out as audio/wav. */
function recordedTake(): Blob {
  return new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])], { type: 'audio/wav' })
}

type Verdict = (url: string, contentType: string) => boolean

interface Seen {
  method: string
  contentType: string | null
  csrf: string | null
}

const seen: Seen[] = []

/** The /local-api middleware as vite.config.ts runs it: content-type gate,
 *  then the CSRF header, then the whisper handler. `verdict` is swappable so
 *  a test can put the pre-fix JSON-only rule back and watch the 415 return. */
function installLocalApi(opts: {
  verdict?: Verdict
  handler?: () => Response
} = {}) {
  const verdict = opts.verdict ?? postContentTypeAllowed
  const handler = opts.handler ?? (() => new Response(
    JSON.stringify({ transcript: 'hello from the microphone', language: 'en' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))

  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = String(input).replace('/local-api', '')
    const headers = new Headers(init?.headers as HeadersInit)
    const method = (init?.method || 'GET').toUpperCase()
    seen.push({
      method,
      contentType: headers.get('content-type'),
      csrf: headers.get('x-locally-uncensored'),
    })

    if (method === 'POST' && !verdict(path, headers.get('content-type') || '')) {
      return new Response(postContentTypeError(path), {
        status: 415,
        headers: { 'content-type': 'text/plain' },
      })
    }
    if (headers.get('x-locally-uncensored') !== 'true') {
      return new Response('Forbidden: Missing x-locally-uncensored header (CSRF Protection)', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      })
    }
    if (path === '/transcribe-status') {
      return new Response(JSON.stringify({ available: true, backend: 'faster-whisper' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return handler()
  })
}

beforeEach(() => { seen.length = 0 })
afterEach(() => { vi.unstubAllGlobals() })

describe('#115: the recorded take reaches whisper in browser mode', () => {
  it('transcribes instead of being refused, and sends both things the gates want', async () => {
    installLocalApi()
    await expect(transcribeAudio(recordedTake())).resolves.toBe('hello from the microphone')
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe('POST')
    // The clip's real type, which is exactly what the old JSON-only rule 415'd.
    expect(seen[0].contentType).toBe('audio/wav')
    expect(seen[0].csrf).toBe('true')
  })

  it('sends the CSRF header on the availability probe too, so the mic can light up', async () => {
    installLocalApi()
    await expect(checkWhisperAvailable()).resolves.toMatchObject({ available: true })
    expect(seen[0].csrf).toBe('true')
  })
})

describe("#115 NEGATIVE CONTROL: the pre-fix JSON-only rule brings the bug back", () => {
  /** The middleware exactly as it read before the carve-out. */
  const jsonOnly: Verdict = (_url, contentType) => contentType.includes('application/json')

  it('refuses the audio POST with 415, and the client reports it in English', async () => {
    installLocalApi({ verdict: jsonOnly })
    const err = await transcribeAudio(recordedTake()).then(
      () => null,
      (e: unknown) => e,
    )
    // The reporter's exact failure: the take never reaches whisper.
    expect(err).toBeInstanceOf(LocalSttError)
    expect((err as LocalSttError).status).toBe(415)
    // And it no longer dies in the JSON parser with the reason thrown away.
    expect((err as Error).message).toContain('HTTP 415')
    expect((err as Error).message).toContain('Unsupported Media Type')
    expect((err as Error).name).not.toBe('SyntaxError')
  })
})

describe('#115 second half: a refusal keeps its reason all the way to the bubble', () => {
  it('a 403 on the missing CSRF header is reported as a 403, not as a parse error', async () => {
    // Middleware installed, but this request goes out bare like the old client did.
    installLocalApi()
    const bare = await fetch('/local-api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: recordedTake(),
    })
    expect(bare.status).toBe(403)
    // And through the client, the same refusal keeps its wording.
    vi.stubGlobal('fetch', async () => new Response('Forbidden: Missing x-locally-uncensored header (CSRF Protection)', {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    }))
    const err = await transcribeAudio(recordedTake()).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toContain('HTTP 403')
    expect((err as Error).message).toContain('Forbidden')
  })

  it('the handler answering 200 with an error keeps its own English wording', async () => {
    installLocalApi({
      handler: () => new Response(
        JSON.stringify({ error: 'Whisper model is still loading, please wait...', transcript: '' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    })
    const err = await transcribeAudio(recordedTake()).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe('Whisper model is still loading, please wait...')
  })

  it('an empty take is reported as empty audio, not as raw JSON in the user message', async () => {
    installLocalApi({
      handler: () => new Response(
        JSON.stringify({ error: 'Empty audio data', transcript: '' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    })
    const err = await transcribeAudio(recordedTake()).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe('Transcription request refused (HTTP 400): Empty audio data')
    expect((err as Error).message).not.toContain('{')
  })

  it('a refused availability probe says why instead of leaving the mic silently dead', async () => {
    vi.stubGlobal('fetch', async () => new Response('Forbidden: Invalid Origin (CSRF Protection)', {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    }))
    const status = await checkWhisperAvailable()
    expect(status.available).toBe(false)
    expect(status.error).toContain('HTTP 403')
    expect(status.error).toContain('Invalid Origin')
  })
})

describe('#115 second half: useVoice shows the reason instead of the microphone hint', () => {
  it('passes a local STT failure through verbatim', () => {
    const msg = sttErrorMessage(new LocalSttError('Transcription request refused (HTTP 415): Unsupported Media Type: Must be an audio body', 415))
    expect(msg).toBe('Transcription request refused (HTTP 415): Unsupported Media Type: Must be an audio body')
  })

  it('NEGATIVE CONTROL: a plain Error still gets the generic hint, nothing else changed', () => {
    expect(sttErrorMessage(new Error('TypeError: fetch failed'))).toBe(
      'Transcription failed, check the microphone and try again',
    )
  })
})
