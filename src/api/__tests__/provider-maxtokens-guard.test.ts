/**
 * A negative Max Tokens must never reach a provider (2026-07-28)
 *
 * The Settings field wrote `parseInt(value) || 0` with no clamp — the HTML
 * `min={0}` does not bind what React puts in the store, so a typed or pasted
 * "-500" was persisted as-is. Anthropic then sent `max_tokens: -500` (a
 * negative is truthy, so `|| 4096` never fired) and the API rejected every
 * request; Ollama forwarded it as num_predict, where negatives mean
 * "unlimited"/"fill context" rather than a budget.
 *
 * Run: npx vitest run src/api/__tests__/provider-maxtokens-guard.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
const localFetchStream = vi.fn()
vi.mock('../backend', () => ({
  localFetch: vi.fn(),
  localFetchStream: (...a: any[]) => localFetchStream(...(a as [])),
  ollamaUrl: (path: string) => `http://localhost:11434/api${path}`,
  // Honest transport answers: api.anthropic.com is a public host the CSP
  // allows, so the Anthropic provider takes its direct fetch and the stubbed
  // global fetch below is what it hits. Blanket-true `isPrivateOrLanHost` used
  // to be harmless because the provider never asked; now it does.
  isPrivateOrLanHost: () => false,
  isDirectFetchAllowed: () => true,
  hostnameOf: (u: string) => { try { return new URL(u).hostname } catch { return '' } },
  ensureProxyAllowsHost: async () => {},
  isTauri: () => false,
}))

import { AnthropicProvider } from '../providers/anthropic-provider'
import { OllamaProvider } from '../providers/ollama-provider'
import type { ProviderConfig } from '../providers/types'

function anthropicConfig(): ProviderConfig {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    isLocal: false,
  } as ProviderConfig
}

function sse(events: string[]): Response {
  return new Response(events.map(e => `data: ${e}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function bodyOf(mock: ReturnType<typeof vi.fn>): any {
  const init = mock.mock.calls[0]?.[1]
  return JSON.parse(String(init?.body ?? '{}'))
}

afterEach(() => {
  vi.restoreAllMocks()
  localFetchStream.mockReset()
})

describe('max_tokens guard', () => {
  it('anthropic falls back to its default instead of sending a negative', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse(['{"type":"message_stop"}']))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new AnthropicProvider(anthropicConfig())
    for await (const _ of provider.chatStream('claude-x', [{ role: 'user', content: 'hi' }], { maxTokens: -500 })) {
      // drain
    }
    expect(bodyOf(fetchMock).max_tokens).toBe(4096)
  })

  it('anthropic still honours a real budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse(['{"type":"message_stop"}']))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new AnthropicProvider(anthropicConfig())
    for await (const _ of provider.chatStream('claude-x', [{ role: 'user', content: 'hi' }], { maxTokens: 1234 })) {
      // drain
    }
    expect(bodyOf(fetchMock).max_tokens).toBe(1234)
  })

  it('ollama leaves num_predict unset for a negative budget', async () => {
    const provider = new OllamaProvider({
      id: 'ollama', name: 'Ollama', enabled: true,
      baseUrl: 'http://localhost:11434', isLocal: true,
    } as ProviderConfig)
    localFetchStream.mockResolvedValue(
      new Response('{"done":true}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
    )
    for await (const _ of provider.chatStream('llama3', [{ role: 'user', content: 'hi' }], { maxTokens: -500 })) {
      // drain
    }
    const sent = JSON.parse(String(localFetchStream.mock.calls[0][1].body))
    expect(sent.options?.num_predict).toBeUndefined()
  })

  it('ollama forwards a real budget as num_predict', async () => {
    const provider = new OllamaProvider({
      id: 'ollama', name: 'Ollama', enabled: true,
      baseUrl: 'http://localhost:11434', isLocal: true,
    } as ProviderConfig)
    localFetchStream.mockResolvedValue(
      new Response('{"done":true}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
    )
    for await (const _ of provider.chatStream('llama3', [{ role: 'user', content: 'hi' }], { maxTokens: 256 })) {
      // drain
    }
    const sent = JSON.parse(String(localFetchStream.mock.calls[0][1].body))
    expect(sent.options.num_predict).toBe(256)
  })
})
