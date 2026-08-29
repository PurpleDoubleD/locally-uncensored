/**
 * B4 Gegenprobe, 29.08. (Windows box, 2.6.7). Three side findings on the
 * dictation path, none of which the #115 tests could see.
 *
 *  1. The whisper process was killed mid-session and the red hint over the
 *     microphone read "stdin flush: Die Pipe wird gerade geschlossen.
 *     (os error 232)". German, in an app set to English, because Windows
 *     words its own errors in the language it was installed in.
 *  2. Nothing healed afterwards. Every later recording hit the same dead pipe
 *     until the app was restarted.
 *  3. A silent take came back with an empty transcript and the interface said
 *     nothing at all, so a silent room and a dead microphone looked the same.
 *
 * The first two live in Rust (src-tauri/src/commands/whisper.rs, covered by
 * cargo test); what is guarded here is the browser and hook side of the same
 * journey, plus the two python copies that write the `error` field the user
 * ends up reading.
 *
 * Run: npx vitest run src/api/__tests__/voice-dead-server-and-silence.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { noSpeechMessage, sttErrorMessage } from '../../hooks/useVoice'
import { LocalSttError } from '../voice'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repo = join(__dirname, '../../..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

describe('a take with no words in it says so', () => {
  it('answers a silent recording with an English hint', () => {
    expect(noSpeechMessage('')).toBe('No speech detected, try again')
  })

  it('treats whitespace-only as silence, which is what a blank transcript looks like', () => {
    expect(noSpeechMessage('   \n\t ')).toBe('No speech detected, try again')
  })

  it('NEGATIVE CONTROL: a take with words in it says nothing, so no bubble covers the text', () => {
    expect(noSpeechMessage('hello world this is a microphone test')).toBeNull()
    // A single word is still a word, including the one whisper invents on
    // silence. That is the model, and we cannot tell it from a real "You".
    expect(noSpeechMessage('You')).toBeNull()
    expect(noSpeechMessage(' ok ')).toBeNull()
  })

  it('is wired into stopRecording, so the hint actually reaches the bubble', () => {
    const src = read('src/hooks/useVoice.ts')
    expect(src).toContain('const nothingHeard = noSpeechMessage(transcript);')
    expect(src).toContain('if (nothingHeard) store.setSttError(nothingHeard);')
  })

  it('NEGATIVE CONTROL: the hint is not an error, so the transcript is still returned', () => {
    const src = read('src/hooks/useVoice.ts')
    const at = src.indexOf('const nothingHeard = noSpeechMessage(transcript);')
    expect(at).toBeGreaterThan(-1)
    // The very next thing after the hint is handing the transcript back, not
    // a throw or an early return that would break the normal path.
    expect(src.slice(at, at + 220)).toContain('return transcript;')
  })
})

describe('the message the user reads is English, whatever language the machine speaks', () => {
  it('the whisper pipe writes go through os_error, not the error own wording', () => {
    const src = read('src-tauri/src/commands/whisper.rs')
    for (const call of ['stdin write:', 'stdin newline:', 'stdin flush:']) {
      expect(src).toContain(`format!("${call} {}", os_error::english(&e))`)
    }
    // The exact shape that produced the German line on the box.
    expect(src).not.toContain('format!("stdin flush: {}", e)')
  })

  it('the drift guard now looks at pipe writes, so the next one is caught', () => {
    const src = read('src-tauri/src/os_error.rs')
    expect(src).toContain('".write_all(", ".flush()"')
    // And the code from the box has a name, so the number is not alone.
    expect(src).toContain('232 => "the pipe is closing"')
  })

  it('the python server reports an OS failure by number, not by the systems sentence', () => {
    for (const p of ['public/whisper_server.py', 'src-tauri/resources/whisper_server.py']) {
      const src = read(p)
      expect(src).toContain('def error_text(e: BaseException) -> str:')
      expect(src).toContain('respond({"error": error_text(e), "transcript": ""})')
      // strerror is the localised half of an OSError and must not be quoted.
      expect(src).not.toContain('e.strerror')
      // The old shape, which handed str(OSError) straight to the user.
      expect(src).not.toContain('respond({"error": str(e), "transcript": ""})')
    }
  })

  it('both copies of the python server stay identical, or the app ships the old one', () => {
    // The bundle reads src-tauri/resources, the dev server reads public. A fix
    // in one of them only is a fix the packaged app does not have.
    expect(read('public/whisper_server.py')).toBe(read('src-tauri/resources/whisper_server.py'))
  })
})

describe('a refusal is cut at character boundaries, not inside one', () => {
  /** The historical trap in this corner: whisper.rs panicked on a byte index
   *  that landed inside a multibyte character. The JS side has the same edge
   *  with surrogate pairs, and this is the half character it leaves behind. */
  const LONE_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/

  /** One ASCII character in front, so the 200th code unit lands INSIDE a
   *  surrogate pair rather than neatly between two of them. Without the odd
   *  offset the old cut looks correct by accident. */
  const awkward = 'a' + '𝄞'.repeat(400)

  it('a long reason full of multibyte characters survives the cut intact', async () => {
    const { transcribeAudio } = await import('../voice')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: awkward }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      const err = await transcribeAudio(new Blob(['x'], { type: 'audio/wav' })).then(
        () => null,
        (e: unknown) => e,
      )
      const msg = (err as Error).message
      expect(msg).not.toMatch(LONE_SURROGATE)
      expect(msg.includes('�')).toBe(false)
      // The cut still happened: 200 characters of reason, not 400.
      expect(Array.from(msg).length).toBeLessThan(260)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('NEGATIVE CONTROL: the code-unit cut this replaced does break a character', () => {
    // The line as it read before, on the same input.
    expect(awkward.slice(0, 200)).toMatch(LONE_SURROGATE)
    // And the line as it reads now does not.
    expect(Array.from(awkward).slice(0, 200).join('')).not.toMatch(LONE_SURROGATE)
  })

  it('NEGATIVE CONTROL: the cut still happens, a runaway body does not fill the bubble', () => {
    const src = read('src/api/voice.ts')
    expect(src).toContain('Array.from(detail).slice(0, 200).join("")')
  })
})

describe('the dead-server verdict does not depend on the systems language', () => {
  it('the Rust check keys on our own prefixes, never on the words after them', () => {
    const src = read('src-tauri/src/commands/whisper.rs')
    expect(src).toContain('"stdin write:"')
    expect(src).toContain('"No stdin connection"')
    // A timeout is a living server. Restarting under it would lose the take.
    expect(src).not.toContain('"Whisper transcription timed out",\n    ];')
  })

  it('a whisper failure still reaches the user verbatim instead of the mic hint', () => {
    const msg = sttErrorMessage(
      new LocalSttError('stdin flush: the pipe is closing (os error 232)'),
    )
    expect(msg).toBe('stdin flush: the pipe is closing (os error 232)')
  })

  it('NEGATIVE CONTROL: an unrelated JS failure keeps the generic hint', () => {
    expect(sttErrorMessage(new Error('boom'))).toBe(
      'Transcription failed, check the microphone and try again',
    )
  })
})
