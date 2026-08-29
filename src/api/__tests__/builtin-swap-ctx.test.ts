/**
 * Counter-check round 2, side finding 3 (installed Windows build, 2026-08-29).
 *
 * In a two-model group chat the header said "ctx 32K" and the counter
 * "555/32.8k", while every swap_bundled_model of that round asked for
 * "ctx": 8192 and llama-server's /props confirmed 8192. Four times the context
 * on screen than in the process.
 *
 * The 32K was real: an earlier agent turn had raised the engine through
 * ensureBuiltinAgentCtx. The group round then went through
 * ensureBuiltinEngineAlive, which restarts with the raw settings tuning whose
 * untouched default is 8192, so every speaker change handed context back.
 *
 * Fixed on both sides: the swap keeps what the engine already holds, and every
 * start/swap tells the display to re-read the engine, so the number on screen
 * is the loaded one even where nothing could be kept.
 *
 * Run: npx vitest run src/api/__tests__/builtin-swap-ctx.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn() }
})

import { preservedSwapCtx, ENGINE_DEFAULT_CTX } from '../../lib/builtin-ctx'
import { ensureBuiltinEngineAlive } from '../builtin-ensure'
import { __resetEngineSwapGateForTests } from '../engine-swap-gate'
import { backendCall } from '../backend'
import { useProviderStore } from '../../stores/providerStore'
import { useSettingsStore } from '../../stores/settingsStore'

describe('preservedSwapCtx', () => {
  it('keeps the 32K the engine already runs instead of dropping to 8192', () => {
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: 32768, ctxTrain: 131072 })).toBe(32768)
  })

  it('clamps to what the incoming GGUF was trained for', () => {
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: 32768, ctxTrain: 16384 })).toBe(16384)
  })

  it('treats a missing tuning value as the untouched default', () => {
    expect(preservedSwapCtx({ tuningCtx: undefined, currentCtx: 32768, ctxTrain: 32768 })).toBe(32768)
    expect(preservedSwapCtx({ tuningCtx: 0, currentCtx: 24576, ctxTrain: 32768 })).toBe(24576)
  })

  // NEGATIVE CONTROLS: every reason NOT to touch the tuning.
  it('leaves an expert value alone in both directions', () => {
    expect(preservedSwapCtx({ tuningCtx: 4096, currentCtx: 32768, ctxTrain: 131072 })).toBeUndefined()
    expect(preservedSwapCtx({ tuningCtx: 65536, currentCtx: 8192, ctxTrain: 131072 })).toBeUndefined()
  })

  it('never guesses when the GGUF header is silent about ctx_train', () => {
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: 32768, ctxTrain: null })).toBeUndefined()
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: 32768, ctxTrain: 0 })).toBeUndefined()
  })

  it('does nothing when no context is being given back', () => {
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: 8192, ctxTrain: 131072 })).toBeUndefined()
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: 4096, ctxTrain: 131072 })).toBeUndefined()
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: null, ctxTrain: 131072 })).toBeUndefined()
  })

  it('never raises above the default on a clamp that lands below it', () => {
    expect(preservedSwapCtx({ tuningCtx: 8192, currentCtx: 32768, ctxTrain: 4096 })).toBeUndefined()
    expect(ENGINE_DEFAULT_CTX).toBe(8192)
  })
})

// ── The group round itself ───────────────────────────────────────────────────

const MANAGED_URL = 'http://127.0.0.1:8127/v1'
const GEMMA = '/m/gemma-3-4b-it-abliterated-Q4_K_M.gguf'
const HERMES = '/m/Hermes-3-Llama-3.2-3B.Q4_K_M.gguf'

/** The engine as the counter-check found it: up on Gemma with 32K loaded. */
function engineOnGemmaAt32k(models: Array<{ name: string; path: string; ctx_train?: number }>) {
  vi.mocked(backendCall).mockImplementation((async (cmd: string) => {
    if (cmd === 'bundled_engine_status') {
      return { running: true, healthy: true, ctx: 32768, model_path: GEMMA }
    }
    if (cmd === 'list_bundled_models') return { models }
    return { status: 'started' }
  }) as never)
}

const swapArgs = () =>
  vi.mocked(backendCall).mock.calls.find((c) => c[0] === 'swap_bundled_model')?.[1] as
    | { modelPath: string; tuning?: { ctx?: number } }
    | undefined

// The suite runs on the node environment (vitest.config.ts), so there is no
// DOM. A bare EventTarget is all announceContextReload touches, and it lets
// the test watch the event the header listens for.
beforeEach(() => {
  ;(globalThis as unknown as { window: EventTarget }).window = new EventTarget()
  vi.mocked(backendCall).mockReset()
  __resetEngineSwapGateForTests()
  useProviderStore.setState((s) => ({
    providers: {
      ...s.providers,
      openai: { ...s.providers.openai, enabled: true, managed: true, baseUrl: MANAGED_URL },
    },
  }))
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, builtinEngine: { ...s.settings.builtinEngine, ctx: 8192 } },
  }))
})

describe('a group speaker change stops shrinking the context', () => {
  it('swaps to the next speaker keeping 32K, not the 8192 default', async () => {
    engineOnGemmaAt32k([
      { name: 'gemma-3-4b-it-abliterated-Q4_K_M', path: GEMMA, ctx_train: 32768 },
      { name: 'Hermes-3-Llama-3.2-3B.Q4_K_M', path: HERMES, ctx_train: 131072 },
    ])
    await ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    expect(swapArgs()?.modelPath).toBe(HERMES)
    expect(swapArgs()?.tuning?.ctx).toBe(32768)
  })

  // NEGATIVE CONTROL: the model coming in cannot take 32K, so the swap must
  // ask for what its header allows and no more.
  it('clamps to the incoming model trained context', async () => {
    engineOnGemmaAt32k([
      { name: 'gemma-3-4b-it-abliterated-Q4_K_M', path: GEMMA, ctx_train: 32768 },
      { name: 'Hermes-3-Llama-3.2-3B.Q4_K_M', path: HERMES, ctx_train: 16384 },
    ])
    await ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    expect(swapArgs()?.tuning?.ctx).toBe(16384)
  })

  // NEGATIVE CONTROL: an expert ctx is a decision, and the group round must
  // not quietly override it.
  it('leaves an expert ctx exactly where the user put it', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, builtinEngine: { ...s.settings.builtinEngine, ctx: 4096 } },
    }))
    engineOnGemmaAt32k([
      { name: 'gemma-3-4b-it-abliterated-Q4_K_M', path: GEMMA, ctx_train: 32768 },
      { name: 'Hermes-3-Llama-3.2-3B.Q4_K_M', path: HERMES, ctx_train: 131072 },
    ])
    await ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    expect(swapArgs()?.tuning?.ctx).toBe(4096)
  })
})

describe('the display re-reads the engine after every swap', () => {
  it('fires lu-context-reloaded so the header cannot keep a stale number', async () => {
    const seen = vi.fn()
    window.addEventListener('lu-context-reloaded', seen)
    engineOnGemmaAt32k([
      { name: 'gemma-3-4b-it-abliterated-Q4_K_M', path: GEMMA, ctx_train: 32768 },
      { name: 'Hermes-3-Llama-3.2-3B.Q4_K_M', path: HERMES, ctx_train: 131072 },
    ])
    await ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    window.removeEventListener('lu-context-reloaded', seen)
    expect(seen).toHaveBeenCalled()
  })

  // NEGATIVE CONTROL: nothing was restarted, so nothing may claim it was.
  // A stray event on every send would make the header re-probe for nothing.
  it('stays quiet when the engine already holds the right model', async () => {
    const seen = vi.fn()
    window.addEventListener('lu-context-reloaded', seen)
    vi.mocked(backendCall).mockImplementation((async (cmd: string) => {
      if (cmd === 'bundled_engine_status') {
        return { running: true, healthy: true, ctx: 32768, model_path: HERMES }
      }
      return { models: [] }
    }) as never)
    await ensureBuiltinEngineAlive('openai::Hermes-3-Llama-3.2-3B.Q4_K_M')
    window.removeEventListener('lu-context-reloaded', seen)
    expect(seen).not.toHaveBeenCalled()
  })
})
