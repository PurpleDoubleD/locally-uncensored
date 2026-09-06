/**
 * Review S3: the boot resume repeats a failed start up to three times, and a
 * repeat is only right for a start that DIED. The messages here are the ones
 * `start_failure_message` in src-tauri/src/commands/engine.rs really produces;
 * a Rust test holds up the other end of that contract.
 *
 * Run: npx vitest run src/lib/__tests__/engine-start-failure.test.ts
 */
import { describe, it, expect } from 'vitest'
import { engineStartFailureText, engineStartIsWorthRetrying } from '../engine-start-failure'

describe('engineStartIsWorthRetrying', () => {
  it('repeats a start that died, which is what the ticket needed', () => {
    // The whole reason the retry exists: a start that lost a race at login.
    expect(
      engineStartIsWorthRetrying(
        new Error(
          'The built-in engine started and exited again before it could serve on port 8127. It was tried twice. This looks like a graphics-card problem.',
        ),
      ),
    ).toBe(true)
    expect(engineStartIsWorthRetrying(new Error('Engine start task failed to run: panic'))).toBe(
      true,
    )
  })

  // The finding itself: a slow load is not a failure, and repeating it spends
  // the whole health budget again, up to ten minutes on a big GGUF, plus a
  // ComfyUI cache drop and an Ollama eviction per attempt.
  it('never repeats a health-budget timeout', () => {
    expect(
      engineStartIsWorthRetrying(
        new Error(
          'The built-in engine did not become healthy on port 8127 within 220s (the budget scales with model size, and huge GGUFs can take minutes on a cold first load).',
        ),
      ),
    ).toBe(false)
  })

  it('never repeats a fact about the machine that 1.5 seconds cannot change', () => {
    for (const msg of [
      'The built-in engine could not open a local port. Every port it may use between 8127 and 8148 is taken or blocked on this machine.',
      'The built-in engine program (lu-llama-server.exe) is missing from this installation. Reinstall Locally Uncensored.',
      'Model file not found: C:\\models\\gone.gguf',
      'The built-in engine has no model file named "Cydonia-24B-v4.1-Q4_K_M".',
    ]) {
      expect(engineStartIsWorthRetrying(new Error(msg))).toBe(false)
    }
  })

  it('reads a plain string, which is what Tauri actually throws', () => {
    expect(engineStartIsWorthRetrying('did not become healthy on port 8127')).toBe(false)
    expect(engineStartIsWorthRetrying('exited again before it could serve')).toBe(true)
  })

  // Negative control: silence is not evidence of hopelessness, and treating it
  // as such would put the resume back to a single attempt.
  it('repeats when there is no message at all', () => {
    expect(engineStartIsWorthRetrying(undefined)).toBe(true)
    expect(engineStartIsWorthRetrying(null)).toBe(true)
    expect(engineStartIsWorthRetrying(new Error(''))).toBe(true)
  })
})

describe('engineStartFailureText', () => {
  it('unwraps the three shapes a Tauri failure arrives in', () => {
    expect(engineStartFailureText(new Error('boom'))).toBe('boom')
    expect(engineStartFailureText('boom')).toBe('boom')
    expect(engineStartFailureText(undefined)).toBe('')
  })
})
