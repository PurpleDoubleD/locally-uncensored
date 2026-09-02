/**
 * Built-in Engine client (2.5.7) — P2.
 *
 * Pins the Tauri-command wrappers, the GGUF→AIModel mapper, and the
 * activate→swap path against the P1 command surface in
 * `src-tauri/src/commands/engine.rs`.
 *
 * Run: npx vitest run src/api/__tests__/engine.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import {
  startBundledEngine,
  stopBundledEngine,
  bundledEngineStatus,
  swapBundledModel,
  listBundledModels,
  bundledToAIModels,
  activateBuiltinModel,
  type BundledModel,
} from '../engine'
import { backendCall } from '../backend'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import type { BuiltinEngineTuning } from '../../types/settings'

// v18: the wrappers inject the settings-backed expert tuning on every
// start/swap; the real settings store is loaded here, so "no explicit tuning"
// must resolve to DEFAULT_SETTINGS.builtinEngine — that IS the chokepoint.
const DEFAULT_TUNING = DEFAULT_SETTINGS.builtinEngine

beforeEach(() => {
  vi.mocked(backendCall).mockReset()
})

describe('engine command wrappers', () => {
  it('starts the engine with camelCase args and an explicit tuning', async () => {
    vi.mocked(backendCall).mockResolvedValue({ port: 8127 } as never)
    const tuning: BuiltinEngineTuning = { ...DEFAULT_TUNING, ctx: 4096, cacheTypeK: 'q8_0' }
    await startBundledEngine('/models/qwen.gguf', tuning)
    expect(backendCall).toHaveBeenCalledWith('start_bundled_engine', {
      modelPath: '/models/qwen.gguf',
      tuning,
    })
  })

  it('injects the settings-backed tuning when none is passed (chokepoint)', async () => {
    vi.mocked(backendCall).mockResolvedValue({ port: 8127 } as never)
    await startBundledEngine('/models/qwen.gguf')
    expect(backendCall).toHaveBeenCalledWith('start_bundled_engine', {
      modelPath: '/models/qwen.gguf',
      tuning: DEFAULT_TUNING,
    })
  })

  it('swaps the loaded model by path with the settings tuning', async () => {
    vi.mocked(backendCall).mockResolvedValue({ port: 8127 } as never)
    await swapBundledModel('/models/other.gguf')
    expect(backendCall).toHaveBeenCalledWith('swap_bundled_model', {
      modelPath: '/models/other.gguf',
      tuning: DEFAULT_TUNING,
    })
  })

  it('stops the engine and reads status', async () => {
    vi.mocked(backendCall).mockResolvedValue({} as never)
    await stopBundledEngine()
    expect(backendCall).toHaveBeenCalledWith('stop_bundled_engine')

    vi.mocked(backendCall).mockResolvedValue({
      running: true, healthy: true, port: 8127, model_path: '/models/qwen.gguf',
    } as never)
    const status = await bundledEngineStatus()
    expect(status.port).toBe(8127)
    expect(backendCall).toHaveBeenCalledWith('bundled_engine_status')
  })

  it('unwraps the models array from list_bundled_models', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      dir: '/data/models',
      models: [{ name: 'qwen', path: '/data/models/qwen.gguf', size: 400, loaded: true }],
    } as never)
    const models = await listBundledModels()
    expect(backendCall).toHaveBeenCalledWith('list_bundled_models', { extraDirs: [] })
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('qwen')
  })

  it('tolerates a missing models field', async () => {
    vi.mocked(backendCall).mockResolvedValue({ dir: '/data/models' } as never)
    expect(await listBundledModels()).toEqual([])
  })
})

describe('bundledToAIModels', () => {
  it('maps GGUFs to openai::-prefixed text models', () => {
    const bundled: BundledModel[] = [
      { name: 'qwen2.5-0.5b', path: '/m/qwen.gguf', size: 400, loaded: true },
      { name: 'llama3', path: '/m/llama3.gguf', size: 8000, loaded: false },
    ]
    const models = bundledToAIModels(bundled)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      name: 'openai::qwen2.5-0.5b',
      model: 'qwen2.5-0.5b',
      type: 'text',
      provider: 'openai',
      providerName: 'Built-in Engine',
    })
    expect(models[1].name).toBe('openai::llama3')
  })

  /**
   * Runde 4, Nebenbefund N3 of the D1 counter-check: whether a built-in model
   * can read images is a file on disk (the projector next to the GGUF, which
   * Rust reports as `vision`), not a guess from the model name.
   */
  it('carries the projector answer through as supportsVision, both ways', () => {
    const models = bundledToAIModels([
      { name: 'Qwen3.8-27B-UD-Q4_K_M', path: '/m/q.gguf', size: 1, loaded: true, vision: true },
      { name: 'gemma-3-4b-it-abliterated-Q4_K_M', path: '/m/g.gguf', size: 1, loaded: false, vision: false },
    ])
    expect(models[0].supportsVision).toBe(true)
    // The N3 witness: a gemma3 by name with no projector next to it.
    expect(models[1].supportsVision).toBe(false)
  })

  it('negative control: a backend that does not report the field leaves it absent', () => {
    // An older sidecar. The flag must stay undefined so the name heuristic
    // keeps deciding, instead of every built-in model losing vision.
    const models = bundledToAIModels([
      { name: 'llama3', path: '/m/llama3.gguf', size: 1, loaded: false },
    ])
    expect('supportsVision' in models[0]).toBe(false)
  })
})

describe('activateBuiltinModel', () => {
  it('resolves the path from the last list and calls swap', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      dir: '/m',
      models: [{ name: 'qwen', path: '/m/qwen.gguf', size: 400, loaded: false }],
    } as never)
    await listBundledModels() // populates name→path map

    vi.mocked(backendCall).mockClear()
    const ok = await activateBuiltinModel('openai::qwen')
    expect(ok).toBe(true)
    expect(backendCall).toHaveBeenCalledWith('swap_bundled_model', {
      modelPath: '/m/qwen.gguf',
      tuning: DEFAULT_TUNING,
    })
  })

  it('accepts a bare (unprefixed) model id', async () => {
    vi.mocked(backendCall).mockResolvedValue({
      dir: '/m',
      models: [{ name: 'qwen', path: '/m/qwen.gguf', size: 400, loaded: false }],
    } as never)
    await listBundledModels()
    vi.mocked(backendCall).mockClear()
    expect(await activateBuiltinModel('qwen')).toBe(true)
  })

  it('refreshes the listing once for an unknown name, then no-ops without a swap', async () => {
    vi.mocked(backendCall).mockResolvedValue({ dir: '/m', models: [] } as never)
    await listBundledModels()
    vi.mocked(backendCall).mockClear()
    const ok = await activateBuiltinModel('openai::ghost')
    expect(ok).toBe(false)
    // A caller may run before any listing populated the map (Models-page →
    // store chokepoint), so ONE refresh is expected — but never a swap for a
    // name that stays unknown.
    expect(backendCall).toHaveBeenCalledTimes(1)
    expect(backendCall).toHaveBeenCalledWith('list_bundled_models', { extraDirs: [] })
    expect(backendCall).not.toHaveBeenCalledWith('swap_bundled_model', expect.anything())
  })
})
