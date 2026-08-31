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

    it('clamps max_tokens to the model context window (Bug 5)', async () => {
      const provider = new OpenAIProvider(makeConfig())
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }), { status: 200 })
      )
      // gpt-4o context = 128000; an absurd budget must be clamped into the window.
      await provider.chatWithTools('gpt-4o', [{ role: 'user', content: 'hi' }], [], { maxTokens: 999999 })
      const sent = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
      expect(sent.max_tokens).toBeGreaterThan(0)
      expect(sent.max_tokens).toBeLessThanOrEqual(128000)
      vi.restoreAllMocks()
    })

    it('sends a bounded max_tokens even when the budget is unset (Bug 5)', async () => {
      const provider = new OpenAIProvider(makeConfig())
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }), { status: 200 })
      )
      // No options → previously omitted max_tokens, so DeepInfra over-defaulted the
      // completion and 400'd. Now it must send a positive, in-window budget.
      await provider.chatWithTools('gpt-4o', [{ role: 'user', content: 'hi' }], [])
      const sent = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
      expect(sent.max_tokens).toBeGreaterThan(0)
      expect(sent.max_tokens).toBeLessThanOrEqual(128000)
      vi.restoreAllMocks()
    })

    // ── Audit CS-1: a base64 attachment must not eat the completion budget ──
    //
    // applyMaxTokens estimated the prompt with
    // `JSON.stringify(body.messages).length / 4`, and body.messages carries the
    // full `data:<mime>;base64,...` URL by then. A 100 KB screenshot is ~137 KB
    // of base64 → ~34 000 phantom tokens, which is more than the whole window of
    // every model at or below 32k (built-in engine, LM Studio, llama.cpp, vLLM,
    // KoboldCpp). ctxLen - promptTokens - RESERVE went negative, the 256 floor
    // won, and every answer with an image attached was cut off at 256 tokens.
    //
    // Base64 chars for a `kb`-KB source image: 4 chars per 3 bytes.
    const base64Payload = (kb: number) => 'A'.repeat(Math.round((kb * 1024 * 4) / 3))

    async function maxTokensFor(
      model: string,
      messages: any[],
      options?: any,
    ): Promise<number> {
      const provider = new OpenAIProvider(makeConfig())
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }), { status: 200 })
      )
      await provider.chatWithTools(model, messages, [], options)
      const sent = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
      vi.restoreAllMocks()
      return sent.max_tokens
    }

    it('does not starve max_tokens to the 256 floor because of an image (CS-1)', async () => {
      // mixtral-8x7b-32768 → 32768 ctx, the exact class of model that broke.
      const maxTokens = await maxTokensFor('mixtral-8x7b-32768', [{
        role: 'user',
        content: 'what is in this screenshot?',
        images: [{ data: base64Payload(100), mimeType: 'image/png' }],
      }])
      // Before the fix this was exactly 256.
      expect(maxTokens).toBeGreaterThan(25000)
      expect(maxTokens).toBeLessThanOrEqual(32768)
    })

    it('charges the flat image rate once per image (CS-1)', async () => {
      const one = await maxTokensFor('mixtral-8x7b-32768', [{
        role: 'user',
        content: 'compare these',
        images: [{ data: base64Payload(80), mimeType: 'image/png' }],
      }])
      const three = await maxTokensFor('mixtral-8x7b-32768', [{
        role: 'user',
        content: 'compare these',
        images: [
          { data: base64Payload(80), mimeType: 'image/png' },
          { data: base64Payload(120), mimeType: 'image/jpeg' },
          { data: base64Payload(40), mimeType: 'image/webp' },
        ],
      }])
      // Two extra images = two extra flat allowances (1500 each), plus a few
      // tokens for the placeholder parts themselves — NOT a size-driven blowup.
      const delta = one - three
      expect(delta).toBeGreaterThanOrEqual(3000)
      expect(delta).toBeLessThan(3100)
    })

    it('counts images that ride along in the history, not just the last turn (CS-1)', async () => {
      const maxTokens = await maxTokensFor('mixtral-8x7b-32768', [
        { role: 'user', content: 'turn 1', images: [{ data: base64Payload(150), mimeType: 'image/png' }] },
        { role: 'assistant', content: 'a screenshot' },
        { role: 'user', content: 'turn 2', images: [{ data: base64Payload(150), mimeType: 'image/png' }] },
        { role: 'assistant', content: 'another one' },
        { role: 'user', content: 'and now?' },
      ])
      expect(maxTokens).toBeGreaterThan(25000)
      expect(maxTokens).toBeLessThanOrEqual(32768)
    })

    it('still sends the full base64 image on the wire and does not mutate the messages (CS-1)', async () => {
      const provider = new OpenAIProvider(makeConfig())
      const data = base64Payload(20)
      const messages: any[] = [{
        role: 'user',
        content: 'look',
        images: [{ data, mimeType: 'image/png' }],
      }]
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }), { status: 200 })
      )
      await provider.chatWithTools('mixtral-8x7b-32768', messages, [])
      const sent = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
      const part = sent.messages.at(-1).content.find((p: any) => p.type === 'image_url')
      expect(part.image_url.url).toBe(`data:image/png;base64,${data}`)
      // The estimator must be read-only.
      expect(messages[0].images[0].data).toBe(data)
      vi.restoreAllMocks()
    })

    it('leaves the text-only clamp untouched — a huge TEXT prompt still hits the floor (CS-1)', async () => {
      // Same character count as the 100 KB image above, but real text. Text
      // costs tokens, so the guard must still starve the budget here.
      const maxTokens = await maxTokensFor('mixtral-8x7b-32768', [
        { role: 'user', content: 'x'.repeat(Math.round((100 * 1024 * 4) / 3)) },
      ])
      expect(maxTokens).toBe(256)
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

  // Audit finding 17/36: the canned auth/rate-limit texts must be FALLBACKS —
  // LU Cloud sends honest 403/429 bodies ("closed beta", "monthly credit
  // budget exhausted") that were being overwritten with dead-end guidance
  // ("Check Settings > Providers" — lu-cloud has no key field).
  describe('parseError server-message precedence', () => {
    it('surfaces a 403 bare-string body verbatim (LU Cloud plan gate)', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LU Cloud' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'LU Cloud is in closed beta (Max plan only)' }), { status: 403 })
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('auth')
        expect(e.message).toBe('LU Cloud is in closed beta (Max plan only)')
      }
      vi.restoreAllMocks()
    })

    it('surfaces a 429 body verbatim (monthly credit budget)', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LU Cloud' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'monthly credit budget exhausted' }), { status: 429 })
      )
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('rate_limit')
        expect(e.message).toBe('monthly credit budget exhausted')
      }
      vi.restoreAllMocks()
    })

    it('falls back to the canned texts when the body carries no message', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 401 }))
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('auth')
        expect(e.message).toMatch(/Invalid API key/)
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 429 }))
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('rate_limit')
        expect(e.message).toMatch(/Rate limited/)
      }
      vi.restoreAllMocks()
    })
  })

  // Audit finding 10: DeepInfra (LU Cloud) reasoning models stream thinking as
  // delta.reasoning_content / delta.reasoning — dropping it left the chat in
  // dead air for the whole reasoning phase.
  describe('native reasoning channel', () => {
    it('chatStream yields delta.reasoning_content as thinking', async () => {
      const provider = new OpenAIProvider(makeConfig())
      const sse = [
        'data: {"choices":[{"delta":{"reasoning_content":"pondering"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"Hi"}}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(sse, { status: 200 }))
      const chunks = []
      for await (const c of provider.chatStream('m', [{ role: 'user', content: 'hi' }])) chunks.push(c)
      expect(chunks.some(c => c.thinking === 'pondering')).toBe(true)
      expect(chunks.some(c => c.content === 'Hi')).toBe(true)
      vi.restoreAllMocks()
    })

    it('chatStream yields the delta.reasoning variant too', async () => {
      const provider = new OpenAIProvider(makeConfig())
      const sse = 'data: {"choices":[{"delta":{"reasoning":"hmm"}}]}\n\ndata: [DONE]\n\n'
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(sse, { status: 200 }))
      const chunks = []
      for await (const c of provider.chatStream('m', [{ role: 'user', content: 'hi' }])) chunks.push(c)
      expect(chunks.some(c => c.thinking === 'hmm')).toBe(true)
      vi.restoreAllMocks()
    })

    it('chatWithTools maps message.reasoning_content to thinking', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          choices: [{ message: { content: 'answer', reasoning_content: 'thought' } }],
        }), { status: 200 })
      )
      const result = await provider.chatWithTools('m', [{ role: 'user', content: 'hi' }], [])
      expect(result.content).toBe('answer')
      expect(result.thinking).toBe('thought')
      vi.restoreAllMocks()
    })
  })

  // Audit finding P0: the LU Cloud proxy passes upstream 400 AND 422 through
  // so the retry-without-the-knob path can engage; the retry only checked 400.
  describe('retry without reasoning knob', () => {
    it('retries a 422 without reasoning_effort', async () => {
      const provider = new OpenAIProvider(makeConfig())
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'inference upstream error' }), { status: 422 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }))
      const result = await provider.chatWithTools('m', [{ role: 'user', content: 'hi' }], [], { thinking: true })
      expect(result.content).toBe('ok')
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
      expect(firstBody.reasoning_effort).toBe('high')
      const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string)
      expect('reasoning_effort' in secondBody).toBe(false)
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
      expect(headers['HTTP-Referer']).toBe('https://lu-labs.ai')
      expect(headers['X-Title']).toBe('LU')
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

  // 2.5.8 — a model without function calling that gets a tool-augmented request
  // makes DeepInfra / LU Cloud answer 405 (some servers 400/422 with a
  // tool/function message). parseError must tag that 'tools_unsupported' so the
  // chat layer shows a clean note instead of a raw status error / AbortError.
  describe('tools_unsupported (model without function calling)', () => {
    const toolDef = [{
      type: 'function' as const,
      function: { name: 'web_search', description: 'x', parameters: { type: 'object', properties: {} } },
    }]

    it('tags a 405 on a tool request as tools_unsupported', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LU Cloud' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 405 }))
      try {
        await provider.chatWithTools('some-model', [{ role: 'user', content: 'hi' }], toolDef)
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e).toBeInstanceOf(ProviderError)
        expect(e.code).toBe('tools_unsupported')
        expect(e.message).toMatch(/tool/i)
      }
      vi.restoreAllMocks()
    })

    it('keeps an honest server message but still tags tools_unsupported', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LU Cloud' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Function calling is not supported for this model' } }), { status: 400 })
      )
      try {
        await provider.chatWithTools('some-model', [{ role: 'user', content: 'hi' }], toolDef)
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('tools_unsupported')
        expect(e.message).toMatch(/Function calling is not supported/)
      }
      vi.restoreAllMocks()
    })

    it('does NOT tag a 405 when no tools were sent', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 405 }))
      try {
        await provider.listModels()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).not.toBe('tools_unsupported')
      }
      vi.restoreAllMocks()
    })

    it('does NOT tag an unrelated 400 that happens to carry tools', async () => {
      const provider = new OpenAIProvider(makeConfig())
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'context length exceeded' } }), { status: 400 })
      )
      try {
        await provider.chatWithTools('some-model', [{ role: 'user', content: 'hi' }], toolDef)
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).not.toBe('tools_unsupported')
      }
      vi.restoreAllMocks()
    })

    // LU Cloud proxy (2.5.8 server): 400 with a structured top-level `code` and
    // an honest `error` line. The proxy answers 400 now (was 502). The message
    // ("... can't run tools ...") has no standalone "tool" word for the regex,
    // so the structured code is what must tag it.
    it('tags the structured model_no_tools 400 body as tools_unsupported', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LU Cloud' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "Hermes 3 70B can't run tools or Agent/Code mode. Switch to a tool-capable model like Qwen3 30B.",
          code: 'model_no_tools',
          model: 'hermes-3-70b',
        }), { status: 400 })
      )
      try {
        await provider.chatWithTools('hermes-3-70b', [{ role: 'user', content: 'hi' }], toolDef)
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('tools_unsupported')
        expect(e.message).toMatch(/can't run tools/)
      }
      vi.restoreAllMocks()
    })

    it('tags the structured model_no_vision 400 body as vision_unsupported', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LU Cloud' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "MythoMax L2 13B can't read images. Switch to a vision model.",
          code: 'model_no_vision',
          model: 'mythomax-l2-13b',
        }), { status: 400 })
      )
      try {
        await provider.chatWithTools('mythomax-l2-13b', [{ role: 'user', content: 'hi' }], toolDef)
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.code).toBe('vision_unsupported')
        expect(e.message).toMatch(/can't read images/)
      }
      vi.restoreAllMocks()
    })
  })

  // 2.5.8 — the /models list now declares per-model tool capability. Parsing it
  // is what lets Agent/Code gate the 6 tool-less cloud models up front.
  describe('listModels supports_tools', () => {
    it('parses supports_tools:false and defaults missing to true', async () => {
      const provider = new OpenAIProvider(makeConfig({ name: 'LU Cloud' }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [
            { id: 'qwen3-30b', object: 'model', supports_tools: true },
            { id: 'hermes-3-70b', object: 'model', supports_tools: false },
            { id: 'legacy-no-field', object: 'model' },
          ],
        }), { status: 200 })
      )
      const models = await provider.listModels()
      expect(models.find(m => m.id === 'qwen3-30b')?.supportsTools).toBe(true)
      expect(models.find(m => m.id === 'hermes-3-70b')?.supportsTools).toBe(false)
      expect(models.find(m => m.id === 'legacy-no-field')?.supportsTools).toBe(true)
      vi.restoreAllMocks()
    })
  })
})
