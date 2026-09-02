/**
 * GH #118: the engine port stopped being a constant in 2.6.8, so the managed
 * slot has to be told where the engine actually came up. This is the applier,
 * the half that touches the provider store.
 *
 * Run: npx vitest run src/api/__tests__/builtin-engine-port-sync.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useProviderStore } from '../../stores/providerStore'
import { syncBuiltinEnginePort } from '../builtin-ensure'

const DEFAULTS = structuredClone(useProviderStore.getState().providers)
const openai = () => useProviderStore.getState().providers.openai

beforeEach(() => {
  useProviderStore.setState({ providers: structuredClone(DEFAULTS) })
})

describe('syncBuiltinEnginePort', () => {
  it('follows the engine when it had to take another port', () => {
    expect(openai().baseUrl).toBe('http://127.0.0.1:8127/v1')
    syncBuiltinEnginePort(8137)
    expect(openai().baseUrl).toBe('http://127.0.0.1:8137/v1')
  })

  it('leaves the slot alone when the engine is on the port it already names', () => {
    syncBuiltinEnginePort(8127)
    expect(openai().baseUrl).toBe('http://127.0.0.1:8127/v1')
  })

  // Negative control: the openai slot is shared. A user running LM Studio or a
  // remote OpenAI-compatible server must never have their endpoint moved by our
  // engine's port choice.
  it('never rewrites a slot that is not our managed engine', () => {
    useProviderStore.getState().setProviderConfig('openai', {
      name: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      managed: false,
    })
    syncBuiltinEnginePort(8137)
    expect(openai().baseUrl).toBe('http://localhost:1234/v1')
  })

  it('never rewrites a disabled slot', () => {
    useProviderStore.getState().setProviderConfig('openai', { enabled: false })
    syncBuiltinEnginePort(8137)
    expect(openai().baseUrl).toBe('http://127.0.0.1:8127/v1')
  })

  // Negative control: `bundled_engine_status` on a stopped engine, an older
  // backend, or a failed call can all hand back something that is not a port.
  it('ignores a non-port answer instead of corrupting the slot', () => {
    for (const bad of [undefined, null, 'later', 0, -5, 99999]) {
      syncBuiltinEnginePort(bad)
      expect(openai().baseUrl).toBe('http://127.0.0.1:8127/v1')
    }
  })
})
