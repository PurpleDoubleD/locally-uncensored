/**
 * Ollama Provider Tests
 *
 * Tests the Ollama provider client (model listing, tool calls, error handling, context length).
 * Run: npx vitest run src/api/__tests__/provider-ollama.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderError } from '../providers/types'
import type { ProviderConfig } from '../providers/types'

// Mock the backend module — Ollama uses localFetch / localFetchStream instead of bare fetch
vi.mock('../backend', () => ({
  isTauri: () => false,
  localFetch: vi.fn(),
  localFetchStream: vi.fn(),
}))

import { OllamaProvider } from '../providers/ollama-provider'
import { localFetch, localFetchStream } from '../backend'

const mockLocalFetch = localFetch as ReturnType<typeof vi.fn>
const mockLocalFetchStream = localFetchStream as ReturnType<typeof vi.fn>

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'ollama',
    name: 'Ollama',
    enabled: true,
    baseUrl: 'http://localhost:11434',
    isLocal: true,
    ...overrides,
  }
}

describe('OllamaProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('has correct id', () => {
      const provider = new OllamaProvider(makeConfig())
      expect(provider.id).toBe('ollama')
    })
  })

  describe('listModels', () => {
    it('parses Ollama /api/tags format with details.parameter_size', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          models: [
            {
              name: 'llama3.1:8b',
              model: 'llama3.1:8b',
              size: 4661224676,
              digest: 'abc123',
              modified_at: '2024-01-01T00:00:00Z',
              details: {
                parent_model: '',
                format: 'gguf',
                family: 'llama',
                families: ['llama'],
                parameter_size: '8.0B',
                quantization_level: 'Q4_0',
              },
            },
            {
              name: 'mistral:7b',
              model: 'mistral:7b',
              size: 3825819519,
              digest: 'def456',
              modified_at: '2024-01-02T00:00:00Z',
              details: {
                parent_model: '',
                format: 'gguf',
                family: 'llama',
                families: ['llama'],
                parameter_size: '7.2B',
                quantization_level: 'Q4_0',
              },
            },
          ]
        }), { status: 200 })
      )

      const models = await provider.listModels()
      expect(models).toHaveLength(2)
      expect(models[0].id).toBe('llama3.1:8b')
      expect(models[0].name).toBe('llama3.1:8b')
      expect(models[0].provider).toBe('ollama')
      expect(models[0].providerName).toBe('Ollama')
      expect(models[1].id).toBe('mistral:7b')
      expect(models[1].provider).toBe('ollama')
    })

    it('handles empty model list', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [] }), { status: 200 })
      )
      const models = await provider.listModels()
      expect(models).toHaveLength(0)
    })

    it('handles missing models key', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      )
      const models = await provider.listModels()
      expect(models).toHaveLength(0)
    })

    it('throws ProviderError on non-ok response', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'server error' }), { status: 500 })
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.provider).toBe('ollama')
        expect(e.code).toBe('network')
        expect(e.status).toBe(500)
      }
    })
  })

  describe('checkConnection', () => {
    it('returns true on successful connection', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [] }), { status: 200 })
      )
      expect(await provider.checkConnection()).toBe(true)
    })

    it('returns false on network error', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      expect(await provider.checkConnection()).toBe(false)
    })

    it('returns false on non-ok response', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response('', { status: 500 })
      )
      expect(await provider.checkConnection()).toBe(false)
    })

    it('returns false on 404', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response('', { status: 404 })
      )
      expect(await provider.checkConnection()).toBe(false)
    })
  })

  describe('getContextLength', () => {
    it('returns context length from model_info', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          model_info: {
            'general.context_length': 131072,
          },
        }), { status: 200 })
      )
      expect(await provider.getContextLength('llama3.1:8b')).toBe(131072)
    })

    it('falls back to parameters.num_ctx', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          model_info: {},
          parameters: { num_ctx: 8192 },
        }), { status: 200 })
      )
      expect(await provider.getContextLength('mistral:7b')).toBe(8192)
    })

    it('returns default 4096 when no info available', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 })
      )
      expect(await provider.getContextLength('unknown-model')).toBe(4096)
    })

    it('returns default 4096 on network error', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockRejectedValueOnce(new Error('Network error'))
      expect(await provider.getContextLength('model')).toBe(4096)
    })

    it('returns default 4096 on non-ok response', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response('', { status: 404 })
      )
      expect(await provider.getContextLength('nonexistent')).toBe(4096)
    })

    it('sends POST to /api/show with model name', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ model_info: { 'general.context_length': 4096 } }), { status: 200 })
      )
      await provider.getContextLength('llama3.1:8b')

      expect(mockLocalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/show'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'llama3.1:8b' }),
        })
      )
    })
  })

  describe('chatWithTools', () => {
    it('parses tool calls from Ollama response', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              function: {
                name: 'web_search',
                arguments: { query: 'test query' },
              },
            }],
          },
          done: true,
        }), { status: 200 })
      )

      const result = await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'search for test' }],
        [{
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search the web',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'query' } },
              required: ['query'],
            },
          },
        }],
      )

      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].function.name).toBe('web_search')
      expect(result.toolCalls[0].function.arguments).toEqual({ query: 'test query' })
    })

    it('handles response with no tool calls', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: {
            role: 'assistant',
            content: 'Hello! How can I help you?',
          },
          done: true,
        }), { status: 200 })
      )

      const result = await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'hi' }],
        [],
      )

      expect(result.content).toBe('Hello! How can I help you?')
      expect(result.toolCalls).toHaveLength(0)
    })

    it('handles multiple tool calls', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'web_search', arguments: { query: 'weather' } } },
              { function: { name: 'web_search', arguments: { query: 'news' } } },
            ],
          },
          done: true,
        }), { status: 200 })
      )

      const result = await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'search weather and news' }],
        [],
      )

      expect(result.toolCalls).toHaveLength(2)
      expect(result.toolCalls[0].function.name).toBe('web_search')
      expect(result.toolCalls[0].function.arguments).toEqual({ query: 'weather' })
      expect(result.toolCalls[1].function.name).toBe('web_search')
      expect(result.toolCalls[1].function.arguments).toEqual({ query: 'news' })
    })

    it('sends stream: false for non-streaming tool calls', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }), { status: 200 })
      )

      await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'test' }],
        [],
      )

      const body = JSON.parse(mockLocalFetch.mock.calls[0][1]?.body as string)
      expect(body.stream).toBe(false)
      expect(body.model).toBe('llama3.1:8b')
    })

    it('sends tools in request body', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant', content: '' },
          done: true,
        }), { status: 200 })
      )

      const tools = [{
        type: 'function' as const,
        function: {
          name: 'calculator',
          description: 'Do math',
          parameters: {
            type: 'object',
            properties: { expression: { type: 'string', description: 'math expression' } },
            required: ['expression'],
          },
        },
      }]

      await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'calc 2+2' }],
        tools,
      )

      const body = JSON.parse(mockLocalFetch.mock.calls[0][1]?.body as string)
      expect(body.tools).toEqual(tools)
    })

    it('passes chat options to Ollama options', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }), { status: 200 })
      )

      await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'test' }],
        [],
        { temperature: 0.7, topP: 0.9, topK: 40, maxTokens: 1024 },
      )

      const body = JSON.parse(mockLocalFetch.mock.calls[0][1]?.body as string)
      expect(body.options.temperature).toBe(0.7)
      expect(body.options.top_p).toBe(0.9)
      expect(body.options.top_k).toBe(40)
      expect(body.options.num_predict).toBe(1024)
    })

    it('always includes options with num_gpu even when no chat options provided', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }), { status: 200 })
      )

      await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'test' }],
        [],
      )

      const body = JSON.parse(mockLocalFetch.mock.calls[0][1]?.body as string)
      expect(body.options).toEqual({ num_gpu: 99 })
    })

    it('handles empty message content', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant' },
          done: true,
        }), { status: 200 })
      )

      const result = await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'test' }],
        [],
      )

      expect(result.content).toBe('')
      expect(result.toolCalls).toHaveLength(0)
    })
  })

  describe('error handling', () => {
    it('throws ProviderError on chatWithTools failure', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'model not found' }), { status: 404 })
      )

      try {
        await provider.chatWithTools(
          'nonexistent-model',
          [{ role: 'user', content: 'hi' }],
          [],
        )
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.provider).toBe('ollama')
        expect(e.status).toBe(404)
      }
    })

    it('uses error message from response body', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'model "xyz" not found' }), { status: 404 })
      )

      try {
        await provider.chatWithTools(
          'xyz',
          [{ role: 'user', content: 'hi' }],
          [],
        )
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.message).toBe('model "xyz" not found')
      }
    })

    it('uses fallback message when response body is not JSON', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response('not json', { status: 500 })
      )

      try {
        await provider.chatWithTools(
          'model',
          [{ role: 'user', content: 'hi' }],
          [],
        )
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.message).toBe('Tool calling failed')
      }
    })

    it('throws ProviderError on listModels failure', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response('', { status: 503 })
      )

      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.provider).toBe('ollama')
        expect(e.status).toBe(503)
      }
    })
  })

  describe('URL construction', () => {
    it('constructs correct URLs for /api/tags', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [] }), { status: 200 })
      )
      await provider.listModels()

      // In non-Tauri mode, apiUrl returns /api/tags (dev proxy)
      expect(mockLocalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/tags'),
      )
    })

    it('constructs correct URLs for /api/chat', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }), { status: 200 })
      )
      await provider.chatWithTools(
        'llama3.1:8b',
        [{ role: 'user', content: 'test' }],
        [],
      )

      expect(mockLocalFetch).toHaveBeenCalledWith(
        expect.stringContaining('/chat'),
        expect.any(Object),
      )
    })
  })

  describe('message conversion', () => {
    it('converts messages to Ollama format with role and content', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }), { status: 200 })
      )

      await provider.chatWithTools(
        'llama3.1:8b',
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
        [],
      )

      const body = JSON.parse(mockLocalFetch.mock.calls[0][1]?.body as string)
      expect(body.messages).toHaveLength(4)
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
      expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' })
      expect(body.messages[2]).toEqual({ role: 'assistant', content: 'Hi there!' })
      expect(body.messages[3]).toEqual({ role: 'user', content: 'How are you?' })
    })

    it('passes tool_calls from messages when present', async () => {
      const provider = new OllamaProvider(makeConfig())
      mockLocalFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          message: { role: 'assistant', content: 'ok' },
          done: true,
        }), { status: 200 })
      )

      const toolCallMessage = {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ function: { name: 'test', arguments: { x: 1 } } }],
      }

      await provider.chatWithTools(
        'llama3.1:8b',
        [
          { role: 'user', content: 'test' },
          toolCallMessage,
        ],
        [],
      )

      const body = JSON.parse(mockLocalFetch.mock.calls[0][1]?.body as string)
      expect(body.messages[1].tool_calls).toBeDefined()
      expect(body.messages[1].tool_calls[0].function.name).toBe('test')
    })
  })
})
