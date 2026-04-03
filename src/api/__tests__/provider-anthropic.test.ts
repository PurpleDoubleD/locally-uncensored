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

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
      expect(body.system).toBe('You are helpful.')
      expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }])
      expect(body.messages.find((m: any) => m.role === 'system')).toBeUndefined()
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

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
      expect(body.tools).toHaveLength(1)
      expect(body.tools[0].name).toBe('web_search')
      expect(body.tools[0].description).toBe('Search')
      expect(body.tools[0].input_schema).toBeDefined()
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
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('auth')
        expect(e.provider).toBe('anthropic')
      }
      vi.restoreAllMocks()
    })

    it('429 → rate_limit error', async () => {
      const provider = new AnthropicProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('', { status: 429 })
      )
      try {
        await provider.chatWithTools('claude-sonnet-4-20250514', [{ role: 'user', content: 'hi' }], [])
        expect.fail('Should throw')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('rate_limit')
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
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('overloaded')
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
})
