/**
 * Anthropic Provider Tests
 *
 * Tests message conversion, tool calling format, and error handling.
 * Run: npx vitest run src/api/__tests__/provider-anthropic.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { AnthropicProvider } from '../providers/anthropic-provider'
import { ProviderError } from '../providers/types'
import type { ProviderConfig } from '../providers/types'
import type { MessagesBody } from '../providers/anthropic-provider'
import { asProviderError, sentJson } from './provider-test-support'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    isLocal: false,
    ...overrides,
  }
}

describe('AnthropicProvider', () => {
  describe('constructor', () => {
    it('has correct id', () => {
      const provider = new AnthropicProvider(makeConfig())
      expect(provider.id).toBe('anthropic')
    })
  })

  describe('listModels', () => {
    it('returns hardcoded Claude models', async () => {
      const provider = new AnthropicProvider(makeConfig())
      const models = await provider.listModels()
      expect(models.length).toBeGreaterThanOrEqual(3)
      expect(models.every(m => m.provider === 'anthropic')).toBe(true)
      expect(models.every(m => m.providerName === 'Anthropic')).toBe(true)
      expect(models.every(m => m.supportsTools === true)).toBe(true)
      expect(models.every(m => m.supportsVision === true)).toBe(true)
    })

    it('includes Opus, Sonnet, and Haiku', async () => {
      const provider = new AnthropicProvider(makeConfig())
      const models = await provider.listModels()
      const names = models.map(m => m.name)
      expect(names.some(n => n.includes('Opus'))).toBe(true)
      expect(names.some(n => n.includes('Sonnet'))).toBe(true)
      expect(names.some(n => n.includes('Haiku'))).toBe(true)
    })

    it('all models have 200K context', async () => {
      const provider = new AnthropicProvider(makeConfig())
      const models = await provider.listModels()
      for (const m of models) {
        expect(m.contextLength).toBe(200000)
      }
    })
  })

  describe('getContextLength', () => {
    it('returns 200000 for Claude models', async () => {
      const provider = new AnthropicProvider(makeConfig())
      expect(await provider.getContextLength('claude-sonnet-4-20250514')).toBe(200000)
    })

    it('returns 200000 for unknown Anthropic models', async () => {
      const provider = new AnthropicProvider(makeConfig())
      expect(await provider.getContextLength('claude-future-model')).toBe(200000)
    })
  })

  describe('checkConnection', () => {
    it('returns false without API key', async () => {
      const provider = new AnthropicProvider(makeConfig({ apiKey: '' }))
      expect(await provider.checkConnection()).toBe(false)
    })

    it('returns false on network error', async () => {
      const provider = new AnthropicProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network'))
      expect(await provider.checkConnection()).toBe(false)
      vi.restoreAllMocks()
    })

    it('returns true on 200 response', async () => {
      const provider = new AnthropicProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 })
      )
      expect(await provider.checkConnection()).toBe(true)
      vi.restoreAllMocks()
    })

    it('returns false on 401', async () => {
      const provider = new AnthropicProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('', { status: 401 })
      )
      expect(await provider.checkConnection()).toBe(false)
      vi.restoreAllMocks()
    })
  })

  describe('chatWithTools', () => {
    it('sends correct Anthropic format (system separate)', async () => {
      const provider = new AnthropicProvider(makeConfig())
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          content: [{ type: 'text', text: 'Hello' }],
          stop_reason: 'end_turn',
        }), { status: 200 })
      )

      await provider.chatWithTools(
        'claude-sonnet-4-20250514',
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi' },
        ],
        [],
      )

      // Als MessagesBody gelesen, nicht als `any`: benennt der Provider ein
      // Feld um, hoert die Zusicherung auf zu kompilieren, statt still gegen
      // `undefined` zu vergleichen.
      const body = sentJson<MessagesBody>(fetchSpy.mock.calls)
      // 2.6.6 A8: the system prompt now rides in a block array so it can carry
      // a cache_control breakpoint. Placement itself is pinned in
      // providers/__tests__/anthropic-cache-control.test.ts.
      expect(body.system).toEqual([
        { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
      ])
      expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }])
      // Und ausdruecklich: keine system-Rolle im Array — genau dieser Regress
      // (der System-Turn bleibt in `messages` stehen) ist der Grund fuer den
      // Test. `String(...)` liest den LAUFZEIT-Wert; der Typ sagt schon
      // `'user' | 'assistant'`, und ein Vergleich damit waere nur eine
      // Wiederholung der Deklaration.
      expect(body.messages.map((m) => String(m.role))).not.toContain('system')
      vi.restoreAllMocks()
    })

    it('converts tools to Anthropic format', async () => {
      const provider = new AnthropicProvider(makeConfig())
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          content: [{ type: 'text', text: '' }],
        }), { status: 200 })
      )

      await provider.chatWithTools(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'search' }],
        [{
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search',
            parameters: { type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: ['q'] },
          },
        }],
      )

      const body = sentJson<MessagesBody>(fetchSpy.mock.calls)
      expect(body.tools).toHaveLength(1)
      expect(body.tools?.[0].name).toBe('web_search')
      expect(body.tools?.[0].description).toBe('Search')
      expect(body.tools?.[0].input_schema).toBeDefined()
      vi.restoreAllMocks()
    })

    it('parses tool_use response blocks', async () => {
      const provider = new AnthropicProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          content: [
            { type: 'text', text: 'Let me search.' },
            { type: 'tool_use', id: 'toolu_123', name: 'web_search', input: { query: 'test' } },
          ],
          stop_reason: 'tool_use',
        }), { status: 200 })
      )

      const result = await provider.chatWithTools(
        'claude-sonnet-4-20250514',
        [{ role: 'user', content: 'search test' }],
        [],
      )

      expect(result.content).toBe('Let me search.')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].id).toBe('toolu_123')
      expect(result.toolCalls[0].function.name).toBe('web_search')
      expect(result.toolCalls[0].function.arguments).toEqual({ query: 'test' })
      vi.restoreAllMocks()
    })
  })

  describe('error handling', () => {
    it('401 → auth error', async () => {
      const provider = new AnthropicProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 })
      )
      try {
        await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
        expect.fail('Should throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError)
        const err = asProviderError(e)
        expect(err.code).toBe('auth')
        expect(err.provider).toBe('anthropic')
      }
      vi.restoreAllMocks()
    })

    it('429 → rate_limit error', async () => {
      const provider = new AnthropicProvider(makeConfig())
      // Every attempt, not just the first: a throttle is now retried with
      // backoff (providers/retry.ts), so a single mocked answer would let the
      // second attempt escape to the real network. The assertion is on what
      // the user finally sees once the retries are spent.
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () => new Response('', { status: 429 })
      )
      try {
        await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
        expect.fail('Should throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError)
        const err = asProviderError(e)
        expect(err.code).toBe('rate_limit')
      }
      vi.restoreAllMocks()
    })

    it('529 → overloaded error', async () => {
      const provider = new AnthropicProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('', { status: 529 })
      )
      try {
        await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
        expect.fail('Should throw')
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError)
        const err = asProviderError(e)
        expect(err.code).toBe('overloaded')
      }
      vi.restoreAllMocks()
    })
  })

  describe('headers', () => {
    it('sends correct Anthropic headers', async () => {
      const provider = new AnthropicProvider(makeConfig({ apiKey: 'sk-ant-test-key' }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [] }), { status: 200 })
      )

      await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])

      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
      expect(headers['x-api-key']).toBe('sk-ant-test-key')
      expect(headers['anthropic-version']).toBe('2023-06-01')
      expect(headers['Content-Type']).toBe('application/json')
      vi.restoreAllMocks()
    })
  })

  // ── Bug O (v2.4.7) — messages URL construction across custom proxies ──
  //
  // 0yagizz reported Custom-Anthropic "not working" on v2.4.5. Most proxies
  // (claude-relay-server, LiteLLM, opencode-zen) document baseUrls in two
  // shapes: either `https://proxy.example` (canonical Anthropic style) or
  // `https://proxy.example/v1` (where the operator already pinned the API
  // version). Pre-v2.4.7 we always appended `/v1/messages`, breaking the
  // second shape with a `/v1/v1/messages` 404. Pin both shapes here.

  describe('messages URL construction (Bug O)', () => {
    it('default api.anthropic.com produces /v1/messages', async () => {
      const provider = new AnthropicProvider(makeConfig({ baseUrl: 'https://api.anthropic.com' }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
      )
      await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
      vi.restoreAllMocks()
    })

    it('proxy with /v1 suffix does not double up', async () => {
      const provider = new AnthropicProvider(makeConfig({ baseUrl: 'https://proxy.example/v1' }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
      )
      await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
      // Pre-v2.4.7: https://proxy.example/v1/v1/messages → 404
      // Post-v2.4.7: https://proxy.example/v1/messages
      expect(fetchSpy.mock.calls[0][0]).toBe('https://proxy.example/v1/messages')
      vi.restoreAllMocks()
    })

    it('proxy with trailing slash on /v1 still resolves correctly', async () => {
      const provider = new AnthropicProvider(makeConfig({ baseUrl: 'https://proxy.example/v1/' }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
      )
      await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
      // baseUrl getter strips trailing slashes, so this behaves like the
      // previous test.
      expect(fetchSpy.mock.calls[0][0]).toBe('https://proxy.example/v1/messages')
      vi.restoreAllMocks()
    })

    it('proxy with no /v1 prefix gets the standard /v1/messages path', async () => {
      const provider = new AnthropicProvider(makeConfig({ baseUrl: 'https://proxy.example' }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
      )
      await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
      expect(fetchSpy.mock.calls[0][0]).toBe('https://proxy.example/v1/messages')
      vi.restoreAllMocks()
    })

    it('preserves nested paths that happen to contain "v1" but not as suffix', async () => {
      // Defensive: a proxy that's deployed at a versioned sub-path like
      // `/api-v1` should still get the standard `/v1/messages` append.
      const provider = new AnthropicProvider(makeConfig({ baseUrl: 'https://proxy.example/api-v1' }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
      )
      await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
      // /api-v1 doesn't end in /v1, so we add /v1/messages
      expect(fetchSpy.mock.calls[0][0]).toBe('https://proxy.example/api-v1/v1/messages')
      vi.restoreAllMocks()
    })
  })
})
