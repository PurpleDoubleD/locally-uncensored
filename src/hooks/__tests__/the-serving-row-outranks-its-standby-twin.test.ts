/**
 * @vitest-environment jsdom
 *
 * A16 counter-check 02.09., the regression the standby listing brought with
 * it: the rows LM Studio reports while it waits beside the slot were pushed
 * into the same array that is then handed to `dropDuplicateLuEngineRows` as
 * "already listed". So a GGUF in the LU Engine folder was measured against a
 * backend that is not serving anything, and lost. The measured pair was
 * bundled `Qwen2.5-0.5B-Instruct-Q4_K_M` against standby
 * `qwen2.5-0.5b-instruct@q4_k_m`, and it left zero rows for that model.
 *
 * What stayed on screen was the worse of the two. The LU Engine was answering
 * the chat; the standby row's click hands the slot back and stops the engine,
 * which is the opposite of what someone clicking the model he is already
 * talking to expects.
 *
 * The rule in lib/lu-engine-rows has always been "precedence to the provider
 * that holds the slot". This pins it in the direction the standby listing
 * introduced.
 *
 * Run: npx vitest run src/hooks/__tests__/the-serving-row-outranks-its-standby-twin.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const listStandbyBackendModels = vi.fn()
const listBundledModels = vi.fn()

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
    listBundledModels: (...a: unknown[]) => listBundledModels(...(a as [])),
    isManagedBuiltinActive: () => true,
    bundledEngineStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8127 })),
    bundledEmbedStatus: vi.fn(async () => ({ running: true, healthy: true, port: 8128 })),
    startBundledEmbed: vi.fn(),
    activateBuiltinModel: vi.fn(async () => true),
    resumeBuiltinEngines: vi.fn(async () => undefined),
    resumeEmbedServer: vi.fn(async () => undefined),
  }
})
vi.mock('../../api/lu-engine-switch', async () => {
  const actual = await vi.importActual<typeof import('../../api/lu-engine-switch')>('../../api/lu-engine-switch')
  return { ...actual, listStandbyBackendModels: (...a: unknown[]) => listStandbyBackendModels(...(a as [])) }
})

const { useModels } = await import('../useModels')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')

/** Exactly the pair the counter-check measured. */
const LU_FILE = 'Qwen2.5-0.5B-Instruct-Q4_K_M'
const LU_ROW = `openai::${LU_FILE}`
const STANDBY_TWIN = 'openai::qwen2.5-0.5b-instruct@q4_k_m'
/** A second LM Studio model with no counterpart on disk. It has to survive. */
const STANDBY_OTHER = 'openai::phi-4-mini-instruct@q8_0'

function rows() {
  return useModelStore.getState().models as unknown as { name: string; providerName?: string }[]
}

beforeEach(() => {
  listBundledModels.mockReset()
  listBundledModels.mockResolvedValue([
    { name: LU_FILE, path: 'C:\\lu-e2e-models\\Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', size: 400_000_000, loaded: true },
  ])
  listStandbyBackendModels.mockReset()
  listStandbyBackendModels.mockResolvedValue([
    { id: 'qwen2.5-0.5b-instruct@q4_k_m', name: 'qwen2.5-0.5b-instruct@q4_k_m', provider: 'openai', providerName: 'LM Studio' },
    { id: 'phi-4-mini-instruct@q8_0', name: 'phi-4-mini-instruct@q8_0', provider: 'openai', providerName: 'LM Studio' },
  ])
  useProviderStore.getState().resetProvidersToDefaults()
  // The state the counter-check was in: our engine in the slot, LM Studio
  // pushed onto the standby card with its server still up on 1234.
  useProviderStore.getState().setProviderConfig('openai', {
    enabled: true, managed: true, name: 'LU Engine', baseUrl: 'http://127.0.0.1:8127/v1',
    isLocal: true,
    displaced: { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', isLocal: true },
  })
  useModelStore.setState({ models: [] as never, activeModel: LU_ROW })
})
afterEach(() => { vi.clearAllMocks() })

describe('one GGUF known to the LU Engine and to the backend on standby', () => {
  it('keeps the row that is serving the chat and drops the standby twin', async () => {
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })

    const lu = rows().find((m) => m.name === LU_ROW)
    expect(lu, 'the row that is actually answering was dropped').toBeTruthy()
    expect(lu?.providerName).toBe('LU Engine')
    expect(
      rows().some((m) => m.name === STANDBY_TWIN),
      'the standby twin stayed, so the model stands twice',
    ).toBe(false)
    // And the model is not gone altogether, which is what the counter-check
    // measured: one file, two sources, zero rows.
    expect(rows().filter((m) => m.name === LU_ROW || m.name === STANDBY_TWIN)).toHaveLength(1)
  })

  // NEGATIVE CONTROL: the de-duplication is about ONE file, not about the
  // standby list as a whole. A model only LM Studio has must still be listed,
  // or the way back to it is gone again.
  it('leaves the standby models that have no counterpart on disk', async () => {
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })

    const other = rows().find((m) => m.name === STANDBY_OTHER)
    expect(other, 'LM Studio lost a model it alone has').toBeTruthy()
    expect(other?.providerName).toBe('LM Studio')
  })

  // NEGATIVE CONTROL: with nothing in the LU Engine folder the standby list
  // arrives untouched, exactly as before this fix.
  it('touches nothing when the LU Engine folder is empty', async () => {
    listBundledModels.mockResolvedValue([])
    const { result } = renderHook(() => useModels())
    await act(async () => { await result.current.fetchModels() })

    expect(rows().some((m) => m.name === STANDBY_TWIN)).toBe(true)
    expect(rows().some((m) => m.name === STANDBY_OTHER)).toBe(true)
  })
})
