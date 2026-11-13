import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { networkHint, runErrorKind } from '../run-error'

describe('a failed coding run, in words (CA U7)', () => {
  it('names the backend the run used instead of always Ollama', () => {
    expect(networkHint({ providerId: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434', local: true })).toBe("LU can't reach Ollama at localhost:11434. Is it running?")
    expect(networkHint({ providerId: 'openai', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', local: true })).toBe("LU can't reach LM Studio at 127.0.0.1:1234. Is it running?")
    expect(networkHint({ providerId: 'lu-cloud', local: false })).toMatch(/LU Cloud.*internet/)
    expect(networkHint({ providerId: 'anthropic', name: 'Anthropic', local: false })).toMatch(/^No connection to Anthropic/)
  })

  it('sorts the error into the kinds the transcript knows', () => {
    expect(runErrorKind({ message: 'TypeError: Failed to fetch' })).toBe('network')
    expect(runErrorKind({ message: 'x', status: 429 })).toBe('limit')
    expect(runErrorKind({ message: 'x', status: 401 })).toBe('session')
    expect(runErrorKind({ message: 'x', code: 'credits_exhausted' })).toBe('credits')
    expect(runErrorKind({ message: 'x', status: 502 })).toBe('engine')
    expect(runErrorKind({ message: 'x', status: 400 })).toBe('generic')
  })

  it('the Code tab records the error as a field and no longer blames Ollama for every backend', () => {
    const src = readFileSync(resolve(__dirname, '../../../hooks/useCodex.ts'), 'utf8')
    expect(src).not.toContain('Is `ollama serve` running on localhost:11434?')
    expect(src).toMatch(/updateMessageError\(convId, assistantMsg\.id, \{\s*kind: runErrorKind/)
  })
})
