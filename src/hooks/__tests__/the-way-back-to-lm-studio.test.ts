/**
 * @vitest-environment jsdom
 *
 * A16 (A14-3a), Windows counter-check 02.09.: "Wer LM Studio einmal verlaesst,
 * findet es im Picker nicht wieder." Start the LM Studio server from the
 * picker, pick an LM Studio model, then click an LU Engine tile. From there
 * the picker lists LU Engine models only, although LM Studio's server is still
 * up on 1234, and the card that offers to start it stays away, correctly,
 * because it IS running. The way back was Settings, AI Backends, Providers,
 * Enable on the standby card, and nothing in the picker said so. The way out
 * had been one click.
 *
 * It is symmetric now. The displaced backend's models stay listed under its own
 * name while it waits beside the slot, and picking one hands the slot back the
 * way the standby card's Enable does, with the same sentence in the same status
 * row the outward switch writes into.
 *
 * Run: npx vitest run src/hooks/__tests__/the-way-back-to-lm-studio.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const activateBuiltinModel = vi.fn(async () => true)
const listStandbyBackendModels = vi.fn()

vi.mock('../../api/backend', () => ({
  isTauri: () => true, isMacOS: () => false, isWindows: () => true, isLinux: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(), secretDelete: vi.fn(),
}))
vi.mock('../../api/comfyui', () => ({
  getInstalledImageModels: vi.fn(async () => []),
  getInstalledVideoModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => false),
  readModelDiskSizes: vi.fn(async () => new Map()),
}))
vi.mock('../../api/ollama', () => ({
  listModels: vi.fn(async () => []), unloadModel: vi.fn(async () => undefined),
  pullModel: vi.fn(), pullModelTauri: vi.fn(), deleteModel: vi.fn(), showModel: vi.fn(),
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
    isManagedBuiltinActive: () => true,
    bundledEngineStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8127 })),
    bundledEmbedStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8128 })),
    startBundledEmbed: vi.fn(),
    activateBuiltinModel: (...a: unknown[]) => activateBuiltinModel(...(a as [])),
  }
})
// Everything about the handback itself is the real thing; only the HTTP call
// to LM Studio's own server is stood in for.
vi.mock('../../api/lu-engine-switch', async () => {
  const actual = await vi.importActual<typeof import('../../api/lu-engine-switch')>('../../api/lu-engine-switch')
  return { ...actual, listStandbyBackendModels: (...a: unknown[]) => listStandbyBackendModels(...(a as [])) }
})

const { useModels } = await import('../useModels')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')
const { useLuEngineSwitchStore } = await import('../../stores/luEngineSwitchStore')
const { __resetLuEngineSwapLockForTests } = await import('../../api/lu-engine-swap-lock')

const LMS_ROW = 'openai::qwen2.5-0.5b-instruct@q4_k_m'
const LU_ROW = 'openai::Phi-4-mini-instruct-Q4_K_M'
const LMS_URL = 'http://localhost:1234/v1'

/** What LM Studio's own /v1/models answers while it waits on standby. */
function lmStudioAnswers() {
  listStandbyBackendModels.mockResolvedValue([
    { id: 'qwen2.5-0.5b-instruct@q4_k_m', name: 'qwen2.5-0.5b-instruct@q4_k_m', provider: 'openai', providerName: 'LM Studio' },
  ])
}

/** The state the counter-check was in: our engine in the slot, LM Studio
 *  pushed onto the standby card, its server still running. */
function luEngineTookTheSlotFromLmStudio() {
  useProviderStore.getState().setProviderConfig('openai', {
    enabled: true, managed: true, name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1',
    isLocal: true,
    displaced: { name: 'LM Studio', baseUrl: LMS_URL, isLocal: true },
  })
}

beforeEach(() => {
  activateBuiltinModel.mockReset()
  activateBuiltinModel.mockResolvedValue(true)
  listStandbyBackendModels.mockReset()
  lmStudioAnswers()
  useLuEngineSwitchStore.setState({ note: null, tone: 'info', generation: 0 })
  __resetLuEngineSwapLockForTests()
  useProviderStore.getState().resetProvidersToDefaults()
  luEngineTookTheSlotFromLmStudio()
  useModelStore.setState({ models: [] as never, activeModel: LU_ROW })
})
afterEach(() => { __resetLuEngineSwapLockForTests() })

describe('LM Studio while the LU Engine holds the chat slot', () => {
  it('keeps its models in the list under its own name', async () => {
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })

    const rows = useModelStore.getState().models
    const lms = rows.find((m) => m.name === LMS_ROW)
    expect(lms, 'LM Studio fell out of the list the moment the engine took the slot').toBeTruthy()
    expect((lms as { providerName?: string }).providerName).toBe('LM Studio')
    expect(listStandbyBackendModels).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LM Studio', baseUrl: LMS_URL }),
    )
  })

  it('gives the slot back when one of its models is picked, and says so', async () => {
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })
    await act(async () => { await result.current.setActiveModel(LMS_ROW) })

    const slot = useProviderStore.getState().providers.openai
    expect(slot.name, 'the slot never went back').toBe('LM Studio')
    expect(slot.baseUrl).toBe(LMS_URL)
    expect(slot.managed, 'our engine is still marked as the backend').not.toBe(true)
    expect(useLuEngineSwitchStore.getState().note)
      .toBe('Switched your chat provider to LM Studio for this model.')
    // And our engine did not try to load an LM Studio id as a GGUF on the way.
    expect(activateBuiltinModel).not.toHaveBeenCalled()
    expect(useModelStore.getState().activeModel).toBe(LMS_ROW)
  })

  it('leaves the LU Engine on the standby card, so the way out stays one click too', async () => {
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })
    await act(async () => { await result.current.setActiveModel(LMS_ROW) })
    const slot = useProviderStore.getState().providers.openai as { displaced?: { name: string } }
    expect(slot.displaced?.name, 'the engine vanished instead of waiting').toBe('LU Engine')
  })

  // NEGATIVE CONTROL: a machine with nothing on standby must not gain an HTTP
  // request on every model refresh.
  it('asks nobody when no backend was displaced', async () => {
    useProviderStore.getState().setProviderConfig('openai', {
      enabled: true, managed: true, name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1',
      isLocal: true, displaced: undefined,
    })
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })
    expect(listStandbyBackendModels).not.toHaveBeenCalled()
  })

  // NEGATIVE CONTROL: the server really having gone away is the old situation
  // and has to stay harmless. No rows, no throw, and the rest of the list is
  // still built.
  it('adds nothing when the standby server has gone away', async () => {
    listStandbyBackendModels.mockRejectedValue(new Error('connection refused'))
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })
    expect(useModelStore.getState().models.some((m) => m.name === LMS_ROW)).toBe(false)
    expect(useProviderStore.getState().providers.openai.managed).toBe(true)
  })

  // NEGATIVE CONTROL: picking one of OUR models must not hand the slot to
  // anybody. Without this the fix would give the slot away on every click.
  it('holds the slot when an LU Engine row is picked', async () => {
    useModelStore.setState({
      models: [
        { name: LU_ROW, model: 'Phi-4-mini-instruct-Q4_K_M', size: 1, type: 'text', provider: 'openai', providerName: 'LU Engine' },
      ] as never,
      activeModel: null,
    })
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.setActiveModel(LU_ROW) })
    expect(useProviderStore.getState().providers.openai.managed).toBe(true)
    expect(activateBuiltinModel).toHaveBeenCalledWith(LU_ROW)
  })

  // The picker has no render harness (model-selector-lms.test.ts), so its half
  // is pinned by reading the source: the handback has to be the FIRST thing
  // the pick does, before anything asks who holds the slot.
  it('and the composer picker hands back before it does anything else', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/models/ModelSelector.tsx'),
      'utf8',
    )
    const handback = src.indexOf('handBackChatProviderForRow(')
    expect(handback, 'the picker never hands the slot back').toBeGreaterThan(-1)
    expect(handback, 'it hands back after the auto-load branch, which is too late')
      .toBeLessThan(src.indexOf('shouldAutoLoadForSelect(model, lmsLoaded)'))
  })
})
