/**
 * OpenAI Provider Tests
 *
 * Tests the OpenAI-compatible provider client (message conversion, error parsing, tool calls).
 * Run: npx vitest run src/api/__tests__/provider-openai.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIProvider } from '../providers/openai-provider'
import { ProviderError } from '../providers/types'
import type { ProviderConfig } from '../providers/types'

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    name: 'TestProvider',
    enabled: true,
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    isLocal: false,
    ...overrides,
  }
}

describe('OpenAIProvider', () => {
  describe('constructor and headers', () => {
    it('creates provider with correct id', () => {
      const provider = new OpenAIProvider(makeConfig())
      expect(provider.id).toBe('openai')
    })
  })

  describe('getContextLength', () => {
    it('returns known context length for GPT-4o', async () => {
      const provider = new OpenAIProvider(makeConfig())
      expect(await provider.getContextLength('gpt-4o')).toBe(128000)
    })

    it('returns known context length for GPT-4o-mini', async () => {
      const provider = new OpenAIProvider(makeConfig())
      expect(await provider.getContextLength('gpt-4o-mini')).toBe(128000)
    })

    it('returns default 8192 for fully unknown models (cloud, no probe)', async () => {
      const provider = new OpenAIProvider(makeConfig())
      expect(await provider.getContextLength('unknown-model')).toBe(8192)
    })

    // Bug K — Heuristik aus Modell-Namen darf 8192-Fallback ueberschreiben
    // sobald der Name eine bekannte Familie matched. Sonst zeigt LU 8K obwohl
    // qwen2.5:32b in Wirklichkeit 32K kann.
    it('guesses 131072 for llama-3.1 family from name (cloud)', async () => {
      const provider = new OpenAIProvider(makeConfig())
      expect(await provider.getContextLength('llama-3.1-70b')).toBe(131072)
    })

    it('guesses 32768 for qwen2.5 family from name (cloud)', async () => {
      const provider = new OpenAIProvider(makeConfig())
      expect(await provider.getContextLength('qwen2.5-32b-instruct')).toBe(32768)
    })

    it('guesses 64000 for deepseek-r1 family from name (cloud)', async () => {
      const provider = new OpenAIProvider(makeConfig())
      expect(await provider.getContextLength('deepseek-r1-distill-llama-70b')).toBe(64000)
    })
  })

  // Bug K — LM Studio Enhanced API probing. Wenn baseUrl lokal ist, soll
  // openai-provider /api/v0/models/<id> abfragen und max_context_length
  // bevorzugen (das echte Modell-Limit), nicht loaded_context_length (was
  // der User in LM Studio gerade geladen hat). Sonst zeigt LU 8K obwohl
  // das Modell 128K kann.
  //
  // Test-Setup: backend.ts/isTauri() pruefr `window.__TAURI_INTERNALS__`.
  // In Node-Vitest gibt es kein `window` — wir mocken ein leeres Object,
  // damit isTauri() false zurueckgibt und localFetch durch zu fetch
  // durchgreifen kann (dann mockable via globalThis.fetch).
  describe('Bug K — probeContextFromServer (LM Studio Enhanced API)', () => {
    beforeEach(() => {
      if (typeof (globalThis as any).window === 'undefined') {
        (globalThis as any).window = {}
      }
    })
    afterEach(() => {
      vi.restoreAllMocks()
      // Window leak ist OK fuer andere Tests — sie checken eh nicht window.
    })

    it('uses LM Studio max_context_length from /api/v0/models/<id> for local URL', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'http://localhost:1234/v1',
        isLocal: true,
      }))
      // Modell-Name darf KEIN Match in guessContextFromName ausloesen, damit
      // wir bewiesen kriegen dass der Probe-Pfad lief (sonst koennte 131072
      // auch aus der Heuristik kommen).
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const u = url.toString()
        if (u.includes('/api/v0/models/custom-undocumented-model')) {
          return new Response(JSON.stringify({
            id: 'custom-undocumented-model',
            max_context_length: 131072,
            loaded_context_length: 8192, // user has 8K loaded but model can do 128K
          }), { status: 200 })
        }
        return new Response('', { status: 404 })
      })
      // Should return 131072 (max from probe), not 8192 (heuristic fallback)
      expect(await provider.getContextLength('custom-undocumented-model')).toBe(131072)
    })

    it('falls back to generic /v1/models/<id> if LM Studio endpoint 404s', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'http://localhost:8000/v1',
        isLocal: true,
      }))
      // vLLM exposes max_model_len, not max_context_length
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const u = url.toString()
        if (u.includes('/api/v0/models/')) {
          return new Response('', { status: 404 })
        }
        if (u.includes('/v1/models/some-custom-model')) {
          return new Response(JSON.stringify({
            id: 'some-custom-model',
            max_model_len: 65536,
          }), { status: 200 })
        }
        return new Response('', { status: 404 })
      })
      expect(await provider.getContextLength('some-custom-model')).toBe(65536)
    })

    it('accepts n_ctx_train as fallback key (llama.cpp server style)', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'http://localhost:8080/v1',
        isLocal: true,
      }))
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const u = url.toString()
        if (u.includes('/api/v0/models/')) return new Response('', { status: 404 })
        if (u.includes('/v1/models/llama-server-model')) {
          return new Response(JSON.stringify({
            n_ctx_train: 32768,
          }), { status: 200 })
        }
        return new Response('', { status: 404 })
      })
      expect(await provider.getContextLength('llama-server-model')).toBe(32768)
    })

    it('cascades to name heuristic when probe returns nothing', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'http://localhost:1234/v1',
        isLocal: true,
      }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }))
      // 'mistral-large-stuff' is unknown to KNOWN_CONTEXT but heuristic
      // matches 'mistral-large' → 32768
      expect(await provider.getContextLength('mistral-large-stuff')).toBe(32768)
    })

    it('skips probe entirely for cloud providers (no N+1 risk)', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'https://api.openai.com/v1',
        isLocal: false,
      }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // gpt-4o is in KNOWN_CONTEXT, returns instantly without fetching
      expect(await provider.getContextLength('gpt-4o')).toBe(128000)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('listModels enriches contextLength via probe for local backends', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'http://localhost:1234/v1',
        isLocal: true,
      }))
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const u = url.toString()
        if (u.endsWith('/v1/models')) {
          return new Response(JSON.stringify({
            data: [{ id: 'custom-unknown-7b', object: 'model' }],
          }), { status: 200 })
        }
        if (u.includes('/api/v0/models/custom-unknown-7b')) {
          return new Response(JSON.stringify({
            max_context_length: 131072,
          }), { status: 200 })
        }
        return new Response('', { status: 404 })
      })
      const models = await provider.listModels()
      expect(models).toHaveLength(1)
      expect(models[0].contextLength).toBe(131072)
    })
  })

  describe('error parsing', () => {
    it('throws ProviderError on 401', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 })
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('auth')
      }
      vi.restoreAllMocks()
    })

    it('throws ProviderError on 429 rate limit', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 })
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('rate_limit')
        expect(e.provider).toBe('openai')
      }
      vi.restoreAllMocks()
    })

    it('throws ProviderError on 404', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 })
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('not_found')
      }
      vi.restoreAllMocks()
    })

    // Sweep #4 Bug (e): LM Studio's "model load failed because no inference
    // runtime is installed" surfaces as `data.error.message` — without a rewrite
    // the user just sees the raw API string and has no idea what to do. The
    // parser detects the signature and replaces it with actionable Plug-and-Play
    // guidance that points to LM Studio's GUI Runtimes tab. This test pins the
    // detection (substring match, case-insensitive) and verifies the error
    // gets the dedicated `lmstudio_runtime_missing` code so callers / UI can
    // branch on it later if needed.
    it('rewrites LM Studio "No LM Runtime found" into actionable guidance', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LM Studio', isLocal: true }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                'Failed to load model "qwen2.5-0.5b-instruct". Error: No LM Runtime found for model format \'gguf\'!',
            },
          }),
          { status: 400 },
        ),
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('lmstudio_runtime_missing')
        expect(e.message).toMatch(/runtime/i)
        expect(e.message).toMatch(/discover|runtimes/i)
        expect(e.message).toMatch(/llama\.cpp/i)
        // The raw API phrasing must NOT leak through unmodified.
        expect(e.message).not.toMatch(/No LM Runtime found/)
      }
      vi.restoreAllMocks()
    })

    it('matches the runtime-missing pattern case-insensitively', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LM Studio' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'NO LM RUNTIME FOUND for gguf' } }),
          { status: 400 },
        ),
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('lmstudio_runtime_missing')
      }
      vi.restoreAllMocks()
    })

    it('does not rewrite unrelated 400 errors', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LM Studio' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'Bad request: missing model' } }),
          { status: 400 },
        ),
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).not.toBe('lmstudio_runtime_missing')
        expect(e.message).toBe('Bad request: missing model')
      }
      vi.restoreAllMocks()
    })
  })

  describe('listModels', () => {
    it('parses OpenAI model list format', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'Groq' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: 'llama-3.1-8b', object: 'model' },
            { id: 'mixtral-8x7b', object: 'model' },
          ]
        }), { status: 200 })
      )
      const models = await provider.listModels()
      expect(models).toHaveLength(2)
      expect(models[0].id).toBe('llama-3.1-8b')
      expect(models[0].provider).toBe('openai')
      expect(models[0].providerName).toBe('Groq')
      expect(models[1].id).toBe('mixtral-8x7b')
      vi.restoreAllMocks()
    })

    it('handles empty model list', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      )
      const models = await provider.listModels()
      expect(models).toHaveLength(0)
      vi.restoreAllMocks()
    })
  })

  describe('checkConnection', () => {
    it('returns true on successful connection', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      )
      expect(await provider.checkConnection()).toBe(true)
      vi.restoreAllMocks()
    })

    it('returns false on failed connection', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'))
      expect(await provider.checkConnection()).toBe(false)
      vi.restoreAllMocks()
    })

    it('returns false on 401', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('', { status: 401 })
      )
      expect(await provider.checkConnection()).toBe(false)
      vi.restoreAllMocks()
    })
  })

  describe('chatWithTools', () => {
    it('parses tool calls from response', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_123',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"test"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), { status: 200 })
      )
      const result = await provider.chatWithTools(
        'gpt-4o',
        [{ role: 'user', content: 'search for test' }],
        [{
          type: 'function',
          function: {
            name: 'web_search',
            description: 'Search the web',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'query' } }, required: ['query'] },
          },
        }],
      )
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls[0].function.name).toBe('web_search')
      expect(result.toolCalls[0].function.arguments).toEqual({ query: 'test' })
      expect(result.toolCalls[0].id).toBe('call_123')
      vi.restoreAllMocks()
    })

    it('handles response with no tool calls', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{
            message: { content: 'Hello!' },
            finish_reason: 'stop',
          }],
        }), { status: 200 })
      )
      const result = await provider.chatWithTools(
        'gpt-4o',
        [{ role: 'user', content: 'hi' }],
        [],
      )
      expect(result.content).toBe('Hello!')
      expect(result.toolCalls).toHaveLength(0)
      vi.restoreAllMocks()
    })

    it('handles malformed tool call arguments', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'test', arguments: 'not-json' },
              }],
            },
          }],
        }), { status: 200 })
      )
      const result = await provider.chatWithTools(
        'gpt-4o',
        [{ role: 'user', content: 'test' }],
        [],
      )
      expect(result.toolCalls[0].function.arguments).toEqual({})
      vi.restoreAllMocks()
    })
  })

  describe('OpenRouter headers', () => {
    it('includes OpenRouter-specific headers', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'https://openrouter.ai/api/v1',
      }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      )
      await provider.listModels()
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
      expect(headers['HTTP-Referer']).toBe('https://locallyuncensored.com')
      expect(headers['X-Title']).toBe('Locally Uncensored')
      vi.restoreAllMocks()
    })

    it('does NOT include OpenRouter headers for other providers', async () => {
      const provider = new OpenAIProvider(makeConfig({
        baseUrl: 'https://api.groq.com/openai/v1',
      }))
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 })
      )
      await provider.listModels()
      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
      expect(headers['HTTP-Referer']).toBeUndefined()
      vi.restoreAllMocks()
    })
  })
})
