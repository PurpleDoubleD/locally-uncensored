/**
 * @vitest-environment jsdom
 *
 * A14 second review, the heavy one: a click on an LU Engine card under
 * Installed did half the job, and the half it skipped was the point.
 *
 * The guard on the activation path asked "is the openai slot already ours".
 * With Ollama in front the answer is no, so a click wrote openai::<gguf> into
 * the store, unloaded the Ollama model to make room for a model nobody was
 * starting, and then switched nothing and started nothing. The user was left
 * on a model that answers from nowhere, with his Ollama model evicted, and no
 * line on screen saying anything had happened.
 *
 * The Use button on Discover and the composer's picker both did the whole job
 * already. This drives the third door, the Installed card, through the same
 * route: hand the slot over, announce it, then start the engine.
 *
 * Run: npx vitest run src/hooks/__tests__/installed-card-click-switches-the-backend.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const activateBuiltinModel = vi.fn(async () => true)
const unloadModel = vi.fn(async () => undefined)

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => true,
  isWindows: () => false,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))
vi.mock('../../api/comfyui', () => ({
  getInstalledImageModels: vi.fn(async () => []),
  getInstalledVideoModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => false),
  readModelDiskSizes: vi.fn(async () => new Map()),
}))
vi.mock('../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  unloadModel: (...a: unknown[]) => unloadModel(...(a as [])),
  pullModel: vi.fn(),
  pullModelTauri: vi.fn(),
  deleteModel: vi.fn(),
  showModel: vi.fn(),
}))
vi.mock('../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../api/providers')>('../../api/providers')
  return { ...actual, getEnabledProviders: () => [] }
})
vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listBundledModels: vi.fn(async () => []),
    isManagedBuiltinActive: () => false,
    bundledEngineStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8127 })),
    bundledEmbedStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8128 })),
    startBundledEmbed: vi.fn(),
    activateBuiltinModel: (...a: unknown[]) => activateBuiltinModel(...(a as [])),
  }
})

const { useModels } = await import('../useModels')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')
const { useLuEngineSwitchStore } = await import('../../stores/luEngineSwitchStore')

const GGUF = 'openai::Qwen2.5-0.5B-Instruct-Q8_0'
const OLLAMA = 'llama3.2:3b'

/** The Installed list as David's Mac draws it: an Ollama model in front, one
 *  GGUF from the LU Engine folder beside it. */
function installedList() {
  return [
    { name: OLLAMA, model: OLLAMA, size: 1, type: 'text', provider: 'ollama', providerName: 'Ollama' },
    { name: GGUF, model: 'Qwen2.5-0.5B-Instruct-Q8_0', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
  ] as never
}

/** The click ModelManager's card makes. */
async function clickCard(name: string) {
  const { result } = renderHook(() => useModels())
  await act(async () => { result.current.setActiveModel(name) })
  return result
}

beforeEach(() => {
  activateBuiltinModel.mockClear()
  unloadModel.mockClear()
  useLuEngineSwitchStore.setState({ note: null, generation: 0 })
  useProviderStore.getState().resetProvidersToDefaults()
  // Ollama in front, the openai slot parked, which is what onboarding leaves
  // behind when the user picks Ollama.
  useProviderStore.getState().setProviderConfig('ollama', { enabled: true })
  useProviderStore.getState().setProviderConfig('openai', { enabled: false, managed: false })
  useModelStore.setState({ models: installedList(), activeModel: OLLAMA })
})

describe('clicking an LU Engine card while Ollama holds the chat', () => {
  it('hands the chat slot to the LU Engine', async () => {
    await clickCard(GGUF)
    const slot = useProviderStore.getState().providers.openai
    expect(slot.enabled, 'the slot has to be on for anything to route there').toBe(true)
    expect(slot.managed, 'and it has to be OUR engine in it').toBe(true)
    expect(slot.name).toBe('LU Engine')
  })

  it('starts the engine on that GGUF', async () => {
    await clickCard(GGUF)
    expect(activateBuiltinModel).toHaveBeenCalledWith(GGUF)
  })

  it('says on screen that the chat backend moved', async () => {
    await clickCard(GGUF)
    expect(useLuEngineSwitchStore.getState().note)
      .toBe('Switched your chat provider to the LU Engine for this model.')
  })

  it('and the model really is the active one afterwards', async () => {
    await clickCard(GGUF)
    expect(useModelStore.getState().activeModel).toBe(GGUF)
  })

  // NEGATIVE CONTROL: a click on the Ollama card is untouched by all of this.
  // It must not move the slot, must not start the engine, and must not print a
  // line about a switch that never happened.
  it('leaves an Ollama card alone', async () => {
    useModelStore.setState({ activeModel: GGUF })
    await clickCard(OLLAMA)
    expect(useProviderStore.getState().providers.openai.managed).not.toBe(true)
    expect(activateBuiltinModel).not.toHaveBeenCalled()
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  // NEGATIVE CONTROL: with the LU Engine already in front there is no switch,
  // so no line, but the GGUF swap still has to happen.
  it('swaps without announcing when the engine already held the chat', async () => {
    useProviderStore.getState().setProviderConfig('openai', { enabled: true, managed: true, name: 'LU Engine' })
    await clickCard(GGUF)
    expect(activateBuiltinModel).toHaveBeenCalledWith(GGUF)
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  // NEGATIVE CONTROL: an LM Studio row shares provider id 'openai' with ours.
  // Clicking it must not hand the slot to our engine and evict LM Studio.
  it('never mistakes an LM Studio row for one of ours', async () => {
    const LMS = 'openai::qwen2.5-0.5b-instruct'
    useModelStore.setState({
      models: [{ name: LMS, model: 'qwen2.5-0.5b-instruct', size: 1, type: 'text', provider: 'openai', providerName: 'LM Studio' }] as never,
      activeModel: null,
    })
    useProviderStore.getState().setProviderConfig('openai', { enabled: true, managed: false, name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' })
    await clickCard(LMS)
    expect(useProviderStore.getState().providers.openai.name).toBe('LM Studio')
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })
})
