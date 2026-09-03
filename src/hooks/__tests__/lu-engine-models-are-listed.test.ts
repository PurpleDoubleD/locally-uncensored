/**
 * @vitest-environment jsdom
 *
 * A14 (2.6.8), David, measured on his Mac: Ollama is the chat backend, the LU
 * Engine folder is ~/lu-e2e-models and holds Qwen2.5-0.5B-Instruct-Q8_0.gguf,
 * and the model appears nowhere in the app. Model Storage says in writing that
 * the folder is read; useModels asked `list_bundled_models` only while the LU
 * Engine held the chat slot, so the promise was true about the disk and false
 * about the screen.
 *
 * The listing is unconditional now. That opens the two doors this file walks
 * through as well: the same file can be known twice when the folder points at
 * ~/.lmstudio/models, and the two resume paths (chat engine, embeddings
 * server) must keep pointing where they always did.
 *
 * Run: npx vitest run src/hooks/__tests__/lu-engine-models-are-listed.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const listBundledModels = vi.fn()
const resumeStatus = vi.fn(async () => ({ running: true, healthy: true, port: 8127 }))
const embedStatus = vi.fn(async () => ({ running: true, healthy: true, port: 8128 }))
let managedBuiltin = false
let providerRows: Array<{ id: string; listModels: () => Promise<unknown[]> }> = []

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => true, // Mac: ComfyUI never auto-starts, so the media lanes stay out of the way
  isWindows: () => false,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
}))
vi.mock('../../api/comfyui', () => ({
  getInstalledImageModels: vi.fn(async () => []),
  getInstalledVideoModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => false),
  readModelDiskSizes: vi.fn(async () => new Map()),
}))
vi.mock('../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  pullModel: vi.fn(),
  pullModelTauri: vi.fn(),
  deleteModel: vi.fn(),
}))
vi.mock('../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../api/providers')>('../../api/providers')
  return { ...actual, getEnabledProviders: () => providerRows }
})
vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listBundledModels: (...a: unknown[]) => listBundledModels(...a),
    isManagedBuiltinActive: () => managedBuiltin,
    bundledEngineStatus: resumeStatus,
    bundledEmbedStatus: embedStatus,
    startBundledEmbed: vi.fn(async () => ({ ok: true })),
    activateBuiltinModel: vi.fn(async () => true),
  }
})

const { useModels } = await import('../useModels')
const { useModelStore } = await import('../../stores/modelStore')
const { useProviderStore } = await import('../../stores/providerStore')

const GGUF = { name: 'Qwen2.5-0.5B-Instruct-Q8_0', path: '/Users/d/lu-e2e-models/Qwen2.5-0.5B-Instruct-Q8_0.gguf', size: 531_000_000, loaded: false }

/** An Ollama backend with one model, the shape David's Mac was in. */
function ollamaHolds(...names: string[]) {
  providerRows = [{
    id: 'ollama',
    listModels: async () => names.map((n) => ({ id: n, provider: 'ollama', providerName: 'Ollama' })),
  }]
}

/** LM Studio in the shared openai slot, listing one model over its own API. */
function lmStudioHolds(...ids: string[]) {
  providerRows = [{
    id: 'openai',
    listModels: async () => ids.map((id) => ({ id, provider: 'openai', providerName: 'LM Studio' })),
  }]
}

async function refresh() {
  const { result } = renderHook(() => useModels())
  await act(async () => { await result.current.fetchModels() })
  return useModelStore.getState().models
}

beforeEach(() => {
  listBundledModels.mockReset()
  listBundledModels.mockResolvedValue([GGUF])
  managedBuiltin = false
  providerRows = []
  useModelStore.setState({ models: [] })
  useProviderStore.getState().setProviderConfig('ollama', { enabled: false })
})

describe('the GGUF in the LU Engine folder is listed whoever holds the chat', () => {
  it('shows up while Ollama is the chat backend', async () => {
    ollamaHolds('llama3.2:3b')
    const models = await refresh()
    const row = models.find((m) => m.name === 'openai::Qwen2.5-0.5B-Instruct-Q8_0')
    expect(row, 'the GGUF David can see on his disk').toBeTruthy()
    expect((row as { providerName?: string }).providerName).toBe('LU Engine')
    // The Ollama model it stands beside is untouched.
    expect(models.some((m) => m.name === 'llama3.2:3b')).toBe(true)
  })

  it('still shows up while the LU Engine itself holds the chat', async () => {
    managedBuiltin = true
    const models = await refresh()
    expect(models.some((m) => m.name === 'openai::Qwen2.5-0.5B-Instruct-Q8_0')).toBe(true)
  })

  // NEGATIVE CONTROL: the web and remote-bridge builds have no sidecar and no
  // route for the command. A throw there must leave the list exactly as it was
  // and must not take the other backends' rows down with it.
  it('lists nothing of its own where the command does not exist, and keeps the rest', async () => {
    ollamaHolds('llama3.2:3b')
    listBundledModels.mockRejectedValue(new Error('command list_bundled_models not found'))
    const models = await refresh()
    expect(models.some((m) => m.providerName === 'LU Engine')).toBe(false)
    expect(models.some((m) => m.name === 'llama3.2:3b')).toBe(true)
  })
})

describe('one file, one row', () => {
  it('drops the LU Engine row for a GGUF LM Studio already serves', async () => {
    // The exact collision: the LU Engine folder is set to ~/.lmstudio/models,
    // so the folder walk finds the same file LM Studio lists over its API.
    lmStudioHolds('qwen2.5-0.5b-instruct@q8_0')
    const models = await refresh()
    const rows = models.filter((m) => m.name.toLowerCase().includes('qwen2.5-0.5b-instruct'))
    expect(rows.length, 'one model, one row').toBe(1)
    // Precedence to the backend that is actually serving the chat.
    expect((rows[0] as { providerName?: string }).providerName).toBe('LM Studio')
  })

  // NEGATIVE CONTROL: a different quant of the same model is a different file
  // and a different download. Collapsing those would hide a model the user has.
  it('keeps both rows when LM Studio serves another quant of the same model', async () => {
    lmStudioHolds('qwen2.5-0.5b-instruct@q4_k_m')
    const models = await refresh()
    expect(models.filter((m) => m.name.toLowerCase().includes('qwen2.5-0.5b-instruct')).length).toBe(2)
  })

  // NEGATIVE CONTROL: Ollama keeps its own blob store, so an Ollama entry with
  // a similar name is a SECOND copy of the model, not a second view of one
  // file. Hiding the GGUF there would hide a real download.
  it('keeps the GGUF beside a similarly named Ollama model', async () => {
    ollamaHolds('qwen2.5:0.5b-instruct-q8_0')
    const models = await refresh()
    expect(models.some((m) => m.providerName === 'LU Engine')).toBe(true)
    expect(models.some((m) => m.name === 'qwen2.5:0.5b-instruct-q8_0')).toBe(true)
  })
})
