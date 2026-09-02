/**
 * Review S7 on the GH #118 fix: the port sync was unit-tested on its own, but
 * nothing held the WIRING. A start, a swap or a status probe that forgets to
 * call it puts the app back where the ticket started, asking a port nobody is
 * listening on while the engine answers one port away.
 *
 * Run: npx vitest run src/api/__tests__/builtin-engine-port-wiring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  isTauri: () => true,
  isMacOS: () => false,
}))

const { useProviderStore } = await import('../../stores/providerStore')
const { startBundledEngine, swapBundledModel, bundledEngineStatus, ENGINE_PORT } = await import(
  '../engine'
)

const DEFAULTS = structuredClone(useProviderStore.getState().providers)
const slotUrl = () => useProviderStore.getState().providers.openai.baseUrl

beforeEach(() => {
  useProviderStore.setState({ providers: structuredClone(DEFAULTS) })
  backendCall.mockReset()
})

describe('the slot follows every call that can move the engine', () => {
  it('start_bundled_engine', async () => {
    backendCall.mockResolvedValue({ status: 'started', port: 8137, model_path: '/m.gguf' })
    await startBundledEngine('/m.gguf')
    expect(slotUrl()).toBe('http://127.0.0.1:8137/v1')
  })

  it('swap_bundled_model', async () => {
    backendCall.mockResolvedValue({ status: 'started', port: 8139, model_path: '/m.gguf' })
    await swapBundledModel('/m.gguf')
    expect(slotUrl()).toBe('http://127.0.0.1:8139/v1')
  })

  it('a running status probe', async () => {
    backendCall.mockResolvedValue({ running: true, healthy: true, port: 8141, model_path: '/m.gguf' })
    await bundledEngineStatus()
    expect(slotUrl()).toBe('http://127.0.0.1:8141/v1')
  })
})

describe('a fallback port does not outlive the conflict (S5)', () => {
  it('a stopped engine puts the slot back on the preferred port', async () => {
    backendCall.mockResolvedValue({ status: 'started', port: 8137, model_path: '/m.gguf' })
    await startBundledEngine('/m.gguf')
    expect(slotUrl()).toBe('http://127.0.0.1:8137/v1')

    // Next app start: 8127 is free again, the engine is not running yet.
    backendCall.mockResolvedValue({ running: false, healthy: false, port: ENGINE_PORT, model_path: null })
    await bundledEngineStatus()
    expect(slotUrl()).toBe(`http://127.0.0.1:${ENGINE_PORT}/v1`)
  })

  // Negative control: the reset must not fire while the engine IS up, or every
  // status probe would point the slot away from a healthy fallback engine.
  it('a running engine on a fallback port is never reset', async () => {
    backendCall.mockResolvedValue({ running: true, healthy: true, port: 8137, model_path: '/m.gguf' })
    await bundledEngineStatus()
    await bundledEngineStatus()
    expect(slotUrl()).toBe('http://127.0.0.1:8137/v1')
  })
})
