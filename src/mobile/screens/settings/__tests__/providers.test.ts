/** Own providers: the list, the address rule, and how a failed test reads. */
import { describe, expect, it } from 'vitest'
import { cleanBaseUrl, findOwnProvider, looksLikeKey, ownProviders, testFailure } from '../parts/providers'

describe('ownProviders', () => {
  it('lists the hosted providers of the design, then Anthropic and the custom endpoint', () => {
    expect(ownProviders('Custom endpoint').map((p) => p.id)).toEqual(['openrouter', 'groq', 'together', 'deepseek', 'mistral', 'minimax', 'openai', 'anthropic', 'custom'])
  })

  it('takes names and addresses from the presets of the logic layer', () => {
    const groq = findOwnProvider('groq', 'Custom endpoint')
    expect(groq?.name).toBe('Groq')
    expect(groq?.baseUrl).toBe('https://api.groq.com/openai/v1')
    expect(groq?.kind).toBe('compat')
    expect(findOwnProvider('anthropic', 'x')?.kind).toBe('anthropic')
  })

  it('names no desktop program', () => {
    const names = ownProviders('Custom endpoint').map((p) => p.name).join(' ')
    expect(names).not.toMatch(/Ollama|LM Studio|ComfyUI/)
  })

  it('knows nothing else', () => {
    expect(findOwnProvider('lmstudio', 'x')).toBeNull()
    expect(findOwnProvider(undefined, 'x')).toBeNull()
    expect(findOwnProvider('custom', 'My endpoint')?.name).toBe('My endpoint')
  })
})

describe('cleanBaseUrl', () => {
  it('takes https anywhere', () => {
    expect(cleanBaseUrl(' https://example.com/v1/ ')).toBe('https://example.com/v1')
  })

  it('takes plain http only for a device on the own network', () => {
    expect(cleanBaseUrl('http://192.168.1.20:8080/v1')).toBe('http://192.168.1.20:8080/v1')
    expect(cleanBaseUrl('http://10.0.0.5/v1')).toBe('http://10.0.0.5/v1')
    expect(cleanBaseUrl('http://studio.local:1234/v1')).toBe('http://studio.local:1234/v1')
    expect(cleanBaseUrl('http://100.101.102.103/v1')).toBe('http://100.101.102.103/v1')
    expect(cleanBaseUrl('http://example.com/v1')).toBeNull()
    expect(cleanBaseUrl('http://8.8.8.8/v1')).toBeNull()
  })

  it('refuses what is not an address, and an address that carries a password', () => {
    expect(cleanBaseUrl('')).toBeNull()
    expect(cleanBaseUrl('example.com')).toBeNull()
    expect(cleanBaseUrl('ftp://example.com')).toBeNull()
    expect(cleanBaseUrl('https://user:pw@example.com/v1')).toBeNull()
  })
})

describe('testFailure', () => {
  it('reads a refused key', () => {
    expect(testFailure({ code: 'auth' }, true)).toBe('bad-key')
    expect(testFailure({ status: 401 }, true)).toBe('bad-key')
    expect(testFailure({ status: 403 }, true)).toBe('bad-key')
  })

  it('reads everything else as not reachable, and no network as offline', () => {
    expect(testFailure(new Error('boom'), true)).toBe('unreachable')
    expect(testFailure({ status: 500 }, true)).toBe('unreachable')
    expect(testFailure({ status: 401 }, false)).toBe('offline')
  })
})

describe('looksLikeKey', () => {
  it('wants at least 8 characters without spaces', () => {
    expect(looksLikeKey('gsk_abcdefgh')).toBe(true)
    expect(looksLikeKey('short')).toBe(false)
    expect(looksLikeKey('has a space in it')).toBe(false)
    expect(looksLikeKey('  gsk_abcdefgh  ')).toBe(true)
  })
})
