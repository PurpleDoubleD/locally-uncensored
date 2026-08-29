/**
 * 2.6.7 counter-check, nebenbefund 1: the built-in engine ignores the `model`
 * field. With Gemma loaded, requests naming Hermes and even naming a model
 * that does not exist were answered by Gemma, with no error. The app never
 * asked whether the loaded model IS the requested one, so a group chat with
 * two local speakers showed two names and ran one model.
 *
 * These tests pin the app side of the cure: the send-time gate now compares
 * and reloads, and `builtinReloadNeeded` answers the same question without
 * acting so the group round can say what it is waiting for.
 *
 * Run: npx vitest run src/api/__tests__/builtin-model-guard.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let managed = true
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: {
    getState: () => ({ providers: { openai: { enabled: true, managed } } }),
  },
}))

const TUNING = { ctx: 16384 }
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ settings: { builtinEngine: TUNING } }),
  },
}))

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: any[]) => backendCall(...args),
}))

import { ensureBuiltinEngineAlive, builtinReloadNeeded } from '../builtin-ensure'

const GEMMA = { name: 'gemma-3-4b-it-abliterated-Q4_K_M', path: 'C:\\m\\gemma-3-4b-it-abliterated-Q4_K_M.gguf' }
const HERMES = { name: 'Hermes-3-Llama-3.2-3B.Q4_K_M', path: 'C:\\m\\Hermes-3-Llama-3.2-3B.Q4_K_M.gguf' }

/** The box as it stood: engine up, Gemma loaded, both GGUFs on disk. */
function gemmaLoaded(list: Array<{ name: string; path: string }> = [GEMMA, HERMES]) {
  backendCall.mockImplementation(async (cmd: string) => {
    if (cmd === 'bundled_engine_status') {
      return { running: true, healthy: true, ctx: 8192, model_path: GEMMA.path }
    }
    if (cmd === 'list_bundled_models') return { models: list }
    if (cmd === 'swap_bundled_model') return { status: 'started' }
    if (cmd === 'start_bundled_engine') return { status: 'started' }
    throw new Error(`unexpected command ${cmd}`)
  })
}

const callsTo = (cmd: string) => backendCall.mock.calls.filter((c) => c[0] === cmd)

describe('the send-time gate enforces which model is loaded', () => {
  beforeEach(() => {
    backendCall.mockReset()
    managed = true
  })

  it('swaps the engine when the request names a different model than the loaded one', async () => {
    gemmaLoaded()
    await ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    const swaps = callsTo('swap_bundled_model')
    expect(swaps).toHaveLength(1)
    expect(swaps[0][1]).toEqual({ modelPath: HERMES.path, tuning: TUNING })
    // A swap is a restart, never a silent second engine.
    expect(callsTo('start_bundled_engine')).toHaveLength(0)
  })

  // Negative control 1: the model that IS loaded must not cause a reload. A
  // gate that swaps on every send would restart llama-server for every message.
  it('does nothing when the loaded model is the requested one', async () => {
    gemmaLoaded()
    await ensureBuiltinEngineAlive('openai::gemma-3-4b-it-abliterated-Q4_K_M')
    expect(callsTo('swap_bundled_model')).toHaveLength(0)
    expect(callsTo('start_bundled_engine')).toHaveLength(0)
    expect(callsTo('list_bundled_models')).toHaveLength(0)
  })

  // Negative control 2: an engine whose status carries no model_path cannot be
  // judged, and guessing there would break every send on an older status shape.
  it('does not reload when the loaded model is unknown', async () => {
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'bundled_engine_status') return { running: true, healthy: true }
      throw new Error(`unexpected command ${cmd}`)
    })
    await ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    expect(callsTo('swap_bundled_model')).toHaveLength(0)
  })

  it('refuses with an English sentence naming both models when the wanted one is gone', async () => {
    // The invented name from the counter-check. Nothing to load, so the only
    // honest answer is to say what is loaded and what was asked for.
    gemmaLoaded([GEMMA])
    await expect(ensureBuiltinEngineAlive('openai::gibt-es-nicht-42')).rejects.toThrow(
      /has "gemma-3-4b-it-abliterated-Q4_K_M" loaded, but this request asked for "gibt-es-nicht-42"/,
    )
    expect(callsTo('swap_bundled_model')).toHaveLength(0)
  })

  it('serialises two different models instead of handing the second the first promise', async () => {
    // The old coalescing was a single global promise: a concurrent send for
    // another model got "ready" back without its model ever being loaded.
    let releaseFirst!: () => void
    const firstSwap = new Promise<void>((r) => (releaseFirst = r))
    backendCall.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === 'bundled_engine_status') {
        return { running: true, healthy: true, model_path: GEMMA.path }
      }
      if (cmd === 'list_bundled_models') return { models: [GEMMA, HERMES] }
      if (cmd === 'swap_bundled_model') {
        if (args.modelPath === HERMES.path) await firstSwap
        return { status: 'started' }
      }
      throw new Error(`unexpected command ${cmd}`)
    })
    const a = ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    const b = ensureBuiltinEngineAlive('openai::gemma-3-4b-it-abliterated-Q4_K_M')
    releaseFirst()
    await Promise.all([a, b])
    // The second caller ran its own check after the first finished. It asked
    // for the model the status still reports as loaded, so it needed no swap,
    // but it did look, which is the whole point.
    expect(callsTo('swap_bundled_model')).toHaveLength(1)
    expect(callsTo('bundled_engine_status')).toHaveLength(2)
  })
})

describe('builtinReloadNeeded', () => {
  beforeEach(() => {
    backendCall.mockReset()
    managed = true
  })

  it('names the model that has to be loaded first', async () => {
    gemmaLoaded()
    expect(await builtinReloadNeeded('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')).toBe('Hermes-3-Llama-3.2-3B.Q4_K_M')
  })

  it('answers null for the model that is already loaded', async () => {
    gemmaLoaded()
    expect(await builtinReloadNeeded('openai::gemma-3-4b-it-abliterated-Q4_K_M')).toBeNull()
  })

  it('answers the model when the engine is down, because a start is a load too', async () => {
    backendCall.mockImplementation(async (cmd: string) => {
      if (cmd === 'bundled_engine_status') return { running: false, healthy: false, model_path: null }
      throw new Error(`unexpected command ${cmd}`)
    })
    expect(await builtinReloadNeeded('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')).toBe('Hermes-3-Llama-3.2-3B.Q4_K_M')
  })

  // Negative controls: it must stay quiet for everything that is not ours.
  it('answers null for a cloud model, an unmanaged slot and a dead backend', async () => {
    gemmaLoaded()
    expect(await builtinReloadNeeded('lucloud::kimi-k2')).toBeNull()
    expect(await builtinReloadNeeded('ollama-model-with-no-prefix')).not.toBeNull()
    managed = false
    expect(await builtinReloadNeeded('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')).toBeNull()
    managed = true
    backendCall.mockRejectedValue(new Error('not in tauri'))
    expect(await builtinReloadNeeded('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')).toBeNull()
  })

  it('changes nothing it looked at', async () => {
    gemmaLoaded()
    await builtinReloadNeeded('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    expect(callsTo('swap_bundled_model')).toHaveLength(0)
    expect(callsTo('start_bundled_engine')).toHaveLength(0)
  })
})
