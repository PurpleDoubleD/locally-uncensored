/**
 * A42 / GitHub Discussion #258 (and A35 on Discord): a model of an
 * additional OpenAI-compatible provider (LM Studio on :1234 next to the LU
 * Engine) was sent to the LU Engine by voice, because the voice brain read
 * the fixed OpenAI slot. Typed chat used the right entry. Voice now does too.
 *
 * Run: npx vitest run src/api/__tests__/a42-voice-uses-the-models-own-provider.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const strategy = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const engine = vi.hoisted(() => ({ woken: [] as string[], keyAsked: [] as unknown[] }))

vi.mock('../../lib/agent-strategy', () => ({ resolveToolCallingStrategy: vi.fn(async () => strategy.value) }))
vi.mock('../builtin-ensure', () => ({
  ensureBuiltinEngineAlive: vi.fn(async (m: string) => { engine.woken.push(m) }),
  ensureBuiltinAgentCtx: vi.fn(async () => {}),
}))
vi.mock('../backend', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  backendCall: vi.fn(async (_cmd: string, args: unknown) => { engine.keyAsked.push(args); return 'engine-key' }),
}))

import { useProviderStore } from '../../stores/providerStore'
import { resolveVoiceBrain } from '../voice-brain'

let entryId = ''

beforeEach(() => {
  engine.woken = []
  engine.keyAsked = []
  useProviderStore.getState().resetProvidersToDefaults?.()
  useProviderStore.setState({ openaiEntries: [] })
  // The fixed slot is the LU Engine, managed, as on a fresh install.
  useProviderStore.setState((s) => ({ providers: { ...s.providers, openai: { ...s.providers.openai, baseUrl: 'http://127.0.0.1:8127/v1', managed: true, isLocal: true } } }))
  entryId = useProviderStore.getState().addOpenAIEntry({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1/', isLocal: true })
  useProviderStore.getState().setOpenAIEntryApiKey?.(entryId, 'lm-key')
  strategy.value = { strategy: 'native', modelToUse: 'flash-next', modelId: 'flash-next', providerId: 'openai' }
})

describe('voice with a model of an additional OpenAI-compatible provider', () => {
  it('talks to that provider, not to the LU Engine', async () => {
    const brain = await resolveVoiceBrain(`openai:${entryId}::flash-next`)
    expect(brain.llm.base_url).toBe('http://localhost:1234/v1')
    expect(brain.llm.model).toBe('flash-next')
    expect(brain.local).toBe(true)
  })

  it('never wakes the LU Engine and never asks for its key', async () => {
    await resolveVoiceBrain(`openai:${entryId}::flash-next`)
    expect(engine.woken).toEqual([])
    expect(engine.keyAsked).toEqual([])
  })

  it('carries the key of that provider', async () => {
    const brain = await resolveVoiceBrain(`openai:${entryId}::flash-next`)
    expect(brain.llm.api_key).toBe('lm-key')
  })

  it('says so plainly when that provider was removed since the pick', async () => {
    await expect(resolveVoiceBrain('openai:gone-1234::flash-next')).rejects.toThrow(/removed/)
  })

  it('still wakes the LU Engine for a model of the fixed slot', async () => {
    strategy.value = { strategy: 'native', modelToUse: 'qwen-9b', modelId: 'qwen-9b', providerId: 'openai' }
    const brain = await resolveVoiceBrain('openai::qwen-9b')
    expect(engine.woken).toEqual(['qwen-9b'])
    expect(brain.llm.base_url).toBe('http://127.0.0.1:8127/v1')
  })
})
