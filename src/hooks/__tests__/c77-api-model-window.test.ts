// @vitest-environment jsdom
/**
 * C77 (Discord, 11.11.2026): an API model on an OpenAI-compatible
 * endpoint got a context window of 8192 because the API names none, and
 * nothing could change it ("Context window (Ollama)" is Ollama's, and the
 * picker of a paid model sets only the send window).
 *
 * Now the user's value for that model is used, and where the number comes
 * from is said.
 *
 * Run: npx vitest run src/hooks/__tests__/c77-api-model-window.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seen: { url: string; body?: Record<string, unknown> }[] = []

vi.mock('../../api/backend', async () => {
  const lan = (host: string) => /^(127\.|localhost$|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  const answer = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === 'http://192.168.1.20:5001/api/extra/true_max_context_length') {
      return new Response(JSON.stringify({ value: 32768 }))
    }
    if (url === 'http://192.168.1.21:8080/props') {
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }))
    }
    if (url.endsWith('/chat/completions')) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }
    return new Response('{}', { status: 404 })
  }
  return {
    localFetch: vi.fn(answer),
    localFetchStream: vi.fn(answer),
    isPrivateOrLanHost: lan,
    hostnameOf: (url: string) => { try { return new URL(url).hostname } catch { return '' } },
    isDirectFetchAllowed: () => false,
    ensureProxyAllowsHost: vi.fn(async () => {}),
    backendCall: vi.fn(async () => { throw new Error('no backend in this test') }),
    isTauri: () => false,
    isOllamaLocal: () => true,
    secretGet: vi.fn(async () => { throw new Error('no keychain here') }),
    secretSet: vi.fn(async () => { throw new Error('no keychain here') }),
    secretDelete: vi.fn(async () => { throw new Error('no keychain here') }),
    secretParkGet: vi.fn(async () => { throw new Error('no keychain here') }),
    secretParkSet: vi.fn(async () => { throw new Error('no keychain here') }),
    secretParkDelete: vi.fn(async () => { throw new Error('no keychain here') }),
  }
})
// This machine's LM Studio has a model of the same name, loaded small.
vi.mock('../../api/lmstudio', async () => {
  const actual = await vi.importActual<typeof import('../../api/lmstudio')>('../../api/lmstudio')
  return { ...actual, getLmStudioModelContext: vi.fn(async () => ({ loaded: 4096, max: 4096, state: 'loaded' })) }
})
// The LU Engine runs with -c 8192.
vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return { ...actual, bundledEngineStatus: vi.fn(async () => ({ running: true, healthy: true, ctx: 8192 })), bundledCtxTrain: () => 0 }
})

import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { clearProviderCache, getProviderForModel } from '../../api/providers/registry'
import { resolveModelContext, currentContextKnobs } from '../useActiveContextWindow'
import { getChatWindowTokens } from '../../lib/context-compaction'
import { withStoredWindow } from '../../lib/context-source'

const API = 'https://api.example-llm.test/v1'
let entry = ''
const model = () => `openai:${entry}::vendor/brand-new-model-x`

beforeEach(() => {
  const st = useProviderStore.getState()
  useProviderStore.setState({
    providers: { ...st.providers, ollama: { ...st.providers.ollama, enabled: false } },
    openaiEntries: [],
  })
  entry = useProviderStore.getState().addOpenAIEntry({ name: 'Some API', baseUrl: API, isLocal: false })
  useSettingsStore.getState().updateSettings({ contextDecay: true, contextWindowByModel: {} })
  clearProviderCache()
  seen.length = 0
})

describe('C77: the window of an API model whose server names none', () => {
  it('without a value: the guess, said as such, and the user may set it', async () => {
    const ctx = await resolveModelContext(model(), 'chat', currentContextKnobs())
    expect(ctx.provider).toBe('cloud')
    expect(ctx.modelWindow).toBe(8192)
    expect(ctx.modelWindowSource).toBe('guess')
    expect(ctx.modelWindowSettable).toBe(true)
    expect(ctx.modelWindowKey).toContain('brand-new-model-x')
    expect(ctx.adjustable).toBe(true)
    // A hosted API is asked nothing about its window (LAN rule).
    expect(seen.filter((s) => s.url.startsWith(API))).toEqual([])
  })

  it('the user\'s value is the window: counter, send window, request budget, chat budget', async () => {
    const first = await resolveModelContext(model(), 'chat', currentContextKnobs())
    useSettingsStore.getState().updateSettings({
      contextWindowByModel: withStoredWindow(useSettingsStore.getState().settings.contextWindowByModel, first.modelWindowKey!, 131072),
    })
    const ctx = await resolveModelContext(model(), 'chat', currentContextKnobs())
    expect(ctx.modelWindow).toBe(131072)
    expect(ctx.contextWindow).toBe(131072)
    expect(ctx.modelWindowSource).toBe('user')
    // Still a paid model: what one step sends stays under the send cap.
    expect(ctx.sendWindow).toBe(32768)
    const { provider, modelId } = getProviderForModel(model())
    expect(await provider.getContextLength!(modelId)).toBe(131072)
    expect(await getChatWindowTokens(model())).toBeGreaterThan(8192)
  })

  it('without the send cap the button stays, for the model window alone', async () => {
    useSettingsStore.getState().updateSettings({ contextDecay: false })
    const ctx = await resolveModelContext(model(), 'chat', currentContextKnobs())
    expect(ctx.sendAdjustable).toBe(false)
    expect(ctx.adjustable).toBe(true)
    expect(ctx.modelWindowSettable).toBe(true)
  })
})
