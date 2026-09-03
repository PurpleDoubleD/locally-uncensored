/**
 * A14 third review: the module that decides whether the backend ANSWERED did
 * not recognise the one refusal the app actually produces.
 *
 * `backendCall` outside the desktop build routes through the HTTP bridge's
 * endpoint table and throws `Unknown backend command: <name>` for anything not
 * in it. None of the fragments matched that, so every web and remote-bridge
 * refresh treated the refusal as "no answer" and asked the same dead question
 * again, forever. The two tests that were meant to cover this used invented
 * wordings and passed on strings nothing ever throws.
 *
 * So the literal from src/api/backend.ts is pinned here, from the source file
 * itself, and not retyped from memory.
 *
 * Run: npx vitest run src/lib/__tests__/engine-command-availability.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandIsUnavailable, commandFailureText } from '../engine-command-availability'

const backendSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../api/backend.ts'),
  'utf8',
)

describe('the refusal the HTTP bridge really throws', () => {
  it('is still worded the way this module expects', () => {
    // The source guard. If someone rewords the throw, this fails here rather
    // than in a web build six weeks later.
    expect(backendSrc).toContain('Unknown backend command: ${command}')
  })

  it('counts as an answer', () => {
    expect(commandIsUnavailable(new Error('Unknown backend command: list_bundled_models'))).toBe(true)
  })

  it('counts as an answer as a bare string too', () => {
    // Tauri hands rejections across as strings, not as Errors.
    expect(commandIsUnavailable('Unknown backend command: swap_bundled_model')).toBe(true)
    expect(commandFailureText('Unknown backend command: swap_bundled_model'))
      .toContain('Unknown backend command')
  })

  // NEGATIVE CONTROL: everything unrecognised must stay "no answer", because
  // the cost of retrying is one extra command and the cost of not retrying is
  // a dead engine for the rest of the session.
  it('and a call that never got through still counts as nothing learned', () => {
    for (const msg of [
      'invoke timed out after 5000ms',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource',
      'The backend command took too long',
    ]) {
      expect(commandIsUnavailable(new Error(msg)), msg).toBe(false)
    }
  })

  // NEGATIVE CONTROL: the older refusals are still recognised.
  it('keeps recognising the wordings it already knew', () => {
    for (const msg of [
      'command not_a_command not found',
      'Unknown command foo',
      'not running in Tauri',
      'not implemented',
    ]) {
      expect(commandIsUnavailable(new Error(msg)), msg).toBe(true)
    }
  })
})
