/**
 * @vitest-environment jsdom
 *
 * A14 (2.6.8): `list_bundled_models` is asked unconditionally now, and the two
 * boot-resume paths hang off that same answer. The chat engine is resumed only
 * while it holds the slot; the bundled embeddings server is resumed while it
 * does not, so Document Chat survives a relaunch under LM Studio or Ollama.
 * Folding the two calls into one made it easy to route both down one branch,
 * which would either boot a chat engine nothing sends to or take RAG offline
 * after every restart. So the fork is pinned from both sides.
 *
 * `builtinResumeAttempted` is module state, once per app session, so each case
 * re-imports the hook to start from a fresh app.
 *
 * Run: npx vitest run src/hooks/__tests__/lu-engine-resume-routing.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const bundledEngineStatus = vi.fn(async () => ({ running: false, healthy: false, port: 8127 }))
const bundledEmbedStatus = vi.fn(async () => ({ running: false, healthy: false, port: 8128 }))
const startBundledEmbed = vi.fn(async () => ({ ok: true }))
const activateBuiltinModel = vi.fn(async () => true)
let managedBuiltin = false

const CHAT = { name: 'Qwen2.5-0.5B-Instruct-Q8_0', path: '/m/Qwen2.5-0.5B-Instruct-Q8_0.gguf', size: 1, loaded: false }
const EMBED = { name: 'nomic-embed-text-v1.5.Q4_K_M', path: '/m/nomic-embed-text-v1.5.Q4_K_M.gguf', size: 1, loaded: false }

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => true,
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
  return { ...actual, getEnabledProviders: () => [] }
})
vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listBundledModels: vi.fn(async () => [CHAT, EMBED]),
    isManagedBuiltinActive: () => managedBuiltin,
    bundledEngineStatus,
    bundledEmbedStatus,
    startBundledEmbed,
    activateBuiltinModel,
  }
})

/** One fresh app session. */
async function bootAndRefresh() {
  vi.resetModules()
  const { useModels } = await import('../useModels')
  const { result } = renderHook(() => useModels())
  await act(async () => { await result.current.fetchModels() })
  // The resumes are fired without await on purpose, so the list is not held
  // hostage by a cold engine start. Let those microtasks land.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  bundledEngineStatus.mockClear()
  bundledEmbedStatus.mockClear()
  startBundledEmbed.mockClear()
  activateBuiltinModel.mockClear()
})

describe('the boot resume goes to the right process', () => {
  it('under a foreign chat backend: the embeddings server, and never the chat engine', async () => {
    managedBuiltin = false
    await bootAndRefresh()
    expect(startBundledEmbed, 'RAG has to survive a relaunch under LM Studio or Ollama').toHaveBeenCalledWith(EMBED.path)
    // NEGATIVE CONTROL in the same frame: booting the chat engine here would
    // put a model in memory that no request is routed to.
    expect(bundledEngineStatus).not.toHaveBeenCalled()
  })

  it('while the LU Engine holds the chat: both, exactly as before', async () => {
    managedBuiltin = true
    await bootAndRefresh()
    expect(bundledEngineStatus).toHaveBeenCalled()
    expect(startBundledEmbed).toHaveBeenCalledWith(EMBED.path)
  })
})
