/**
 * GH #118 (nayffy, 2026-08-27, Windows 11, v2.6.6): "Built in engine test fails
 * and console shows GET http://127.0.0.1:8127/v1/models net::ERR_CONNECTION_REFUSED".
 *
 * Since 2.6.8 the engine may take the next free port when 8127 is held, so the
 * slot that talks to it has to follow. These pin the two halves that could turn
 * that repair back into the bug: a slot that does not follow, and a slot that
 * follows something it has no business rewriting.
 *
 * Run: npx vitest run src/lib/__tests__/engine-port.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  baseUrlNeedingEnginePort,
  enginePortFromBaseUrl,
  withEnginePort,
} from '../engine-port'

describe('enginePortFromBaseUrl', () => {
  it('reads the port off the shipped built-in slot', () => {
    expect(enginePortFromBaseUrl('http://127.0.0.1:8127/v1')).toBe(8127)
    expect(enginePortFromBaseUrl('http://localhost:1234/v1')).toBe(1234)
    expect(enginePortFromBaseUrl('http://[::1]:8127/v1')).toBe(8127)
  })

  it('answers null when there is no port to read', () => {
    expect(enginePortFromBaseUrl('http://127.0.0.1/v1')).toBeNull()
    expect(enginePortFromBaseUrl('https://api.anthropic.com')).toBeNull()
    expect(enginePortFromBaseUrl('')).toBeNull()
    expect(enginePortFromBaseUrl('not a url')).toBeNull()
  })
})

describe('withEnginePort', () => {
  it('swaps the port and keeps scheme, host and path', () => {
    expect(withEnginePort('http://127.0.0.1:8127/v1', 8137)).toBe('http://127.0.0.1:8137/v1')
    expect(withEnginePort('http://[::1]:8127/v1', 8137)).toBe('http://[::1]:8137/v1')
  })

  it('adds a port to a URL that had none', () => {
    expect(withEnginePort('http://127.0.0.1/v1', 8137)).toBe('http://127.0.0.1:8137/v1')
  })

  it('returns junk unchanged instead of mangling it', () => {
    expect(withEnginePort('not a url', 8137)).toBe('not a url')
    expect(withEnginePort('http://127.0.0.1:8127/v1', 0)).toBe('http://127.0.0.1:8127/v1')
    expect(withEnginePort('http://127.0.0.1:8127/v1', 70000)).toBe('http://127.0.0.1:8127/v1')
  })
})

describe('baseUrlNeedingEnginePort: the slot follows the engine, and only the engine', () => {
  it('rewrites the built-in slot when the engine moved off 8127', () => {
    // The whole ticket in one line: healthy engine, wrong port in the slot.
    expect(baseUrlNeedingEnginePort('http://127.0.0.1:8127/v1', 8137)).toBe(
      'http://127.0.0.1:8137/v1',
    )
  })

  it('writes nothing when the slot already points at the engine', () => {
    expect(baseUrlNeedingEnginePort('http://127.0.0.1:8127/v1', 8127)).toBeNull()
  })

  // Negative control, and the reason this function exists rather than a plain
  // string replace: the same openai slot can hold a remote OpenAI-compatible
  // server. Repointing that at a loopback port would be a far worse bug than
  // the one being fixed.
  it('never touches a host that is not this machine', () => {
    expect(baseUrlNeedingEnginePort('https://api.together.xyz/v1', 8137)).toBeNull()
    expect(baseUrlNeedingEnginePort('http://192.168.0.54:1234/v1', 8137)).toBeNull()
    expect(baseUrlNeedingEnginePort('http://box.local:8127/v1', 8137)).toBeNull()
  })

  it('accepts localhost and the IPv6 loopback as this machine', () => {
    expect(baseUrlNeedingEnginePort('http://localhost:8127/v1', 8137)).toBe(
      'http://localhost:8137/v1',
    )
    expect(baseUrlNeedingEnginePort('http://[::1]:8127/v1', 8137)).toBe('http://[::1]:8137/v1')
  })

  // Negative control: a status call on a stopped engine can carry all sorts of
  // non-answers, and none of them may move the slot.
  it('ignores anything that is not a port number', () => {
    for (const bad of [undefined, null, '8137', 0, -1, 70000, 1.5, NaN]) {
      expect(baseUrlNeedingEnginePort('http://127.0.0.1:8127/v1', bad)).toBeNull()
    }
  })
})
