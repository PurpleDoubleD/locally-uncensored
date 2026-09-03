/**
 * GitHub #115 (graysoncooper): browser voice recording always failed, the
 * /local-api middleware 415'd the transcribe POST because it enforced
 * application/json on every body, and the transcribe body IS the recorded
 * audio. On top, both voice fetches went out without the CSRF header every
 * backendCall sends, so even a passing body would have met a 403.
 *
 * These tests lock the carve-out to exactly one endpoint (negative controls:
 * JSON on transcribe is still refused, audio anywhere else is still refused)
 * and pin the wiring in vite.config.ts and voice.ts.
 *
 * Run: npx vitest run src/lib/__tests__/local-api-guard.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { isTranscribePath, postContentTypeAllowed, postContentTypeError } from '../local-api-guard'

describe('isTranscribePath', () => {
  it('matches the transcribe endpoint, with and without a query', () => {
    expect(isTranscribePath('/transcribe')).toBe(true)
    expect(isTranscribePath('/transcribe?lang=de')).toBe(true)
  })

  it('does not match its neighbours or an absent url (negative control)', () => {
    expect(isTranscribePath('/transcribe-status')).toBe(false)
    expect(isTranscribePath('/download-model')).toBe(false)
    expect(isTranscribePath(undefined)).toBe(false)
  })
})

describe('postContentTypeAllowed', () => {
  it('lets every real recorder body through on /transcribe', () => {
    expect(postContentTypeAllowed('/transcribe', 'audio/webm;codecs=opus')).toBe(true)
    expect(postContentTypeAllowed('/transcribe', 'audio/mp4')).toBe(true)
    expect(postContentTypeAllowed('/transcribe', 'audio/wav')).toBe(true)
    expect(postContentTypeAllowed('/transcribe', 'video/webm')).toBe(true)
    expect(postContentTypeAllowed('/transcribe', 'application/octet-stream')).toBe(true)
    expect(postContentTypeAllowed('/transcribe', 'AUDIO/WEBM')).toBe(true)
  })

  it('NEGATIVE CONTROL: the carve-out is not a free pass, JSON and text on /transcribe stay refused', () => {
    expect(postContentTypeAllowed('/transcribe', 'application/json')).toBe(false)
    expect(postContentTypeAllowed('/transcribe', 'text/plain')).toBe(false)
    expect(postContentTypeAllowed('/transcribe', '')).toBe(false)
  })

  it('every other endpoint keeps the strict JSON rule', () => {
    expect(postContentTypeAllowed('/download-model', 'application/json')).toBe(true)
    expect(postContentTypeAllowed('/download-model', 'application/json; charset=utf-8')).toBe(true)
    expect(postContentTypeAllowed(undefined, 'application/json')).toBe(true)
  })

  it('NEGATIVE CONTROL: the audio exception does not leak to other endpoints', () => {
    expect(postContentTypeAllowed('/download-model', 'audio/webm')).toBe(false)
    expect(postContentTypeAllowed('/shell-execute', 'application/octet-stream')).toBe(false)
    expect(postContentTypeAllowed('/transcribe-status', 'audio/webm')).toBe(false)
  })
})

describe('postContentTypeError', () => {
  it('names the audio requirement on /transcribe', () => {
    expect(postContentTypeError('/transcribe')).toContain('audio')
  })

  it('keeps the exact old wording everywhere else, nothing changes for JSON endpoints', () => {
    expect(postContentTypeError('/download-model')).toBe('Unsupported Media Type: Must be application/json')
  })
})

describe('wiring (source guards)', () => {
  const lf = (p: string) => readFileSync(join(__dirname, p), 'utf8').replace(/\r\n/g, '\n')
  // ZB-7: die Middleware stand bis dahin in vite.config.ts. Sie liegt jetzt in
  // dev-server/guard.ts — derselbe Code, andere Datei. Ihr VERHALTEN (die
  // Ausnahme greift genau auf /transcribe, JSON dort wird weiter abgelehnt)
  // steht seither zusätzlich an echten Anfragen in
  // dev-server/__tests__/waechter-und-port.test.ts; diese Zusicherung hier
  // bleibt die Klammer „der Wächter fragt den geteilten Entscheider, statt
  // application/json selbst hinzuschreiben".
  const guardSrc = lf('../../../dev-server/guard.ts')
  const voiceSrc = lf('../../api/voice.ts')

  it('the middleware asks the shared guard instead of hard-coding JSON', () => {
    expect(guardSrc).toContain("import { postContentTypeAllowed, postContentTypeError } from '../src/lib/local-api-guard'")
    expect(guardSrc).toContain('if (!postContentTypeAllowed(req.url, contentType))')
    expect(guardSrc).toContain('res.end(postContentTypeError(req.url))')
  })

  it('both voice fetches carry the CSRF header the middleware demands', () => {
    const hits = voiceSrc.split('"x-locally-uncensored": "true"').length - 1
    expect(hits).toBeGreaterThanOrEqual(2)
  })

  it('the transcribe POST still declares the real audio type of the clip', () => {
    expect(voiceSrc).toContain('"Content-Type": audioBlob.type || "audio/webm"')
  })
})
