/**
 * P11 (3.0.9): a persona with its own Neuron tweaker sliders brings them to
 * the engine when it becomes active; a switch between two personas without
 * their own sliders restarts nothing.
 *
 * Run: npx vitest run src/hooks/__tests__/neuron-follows-persona.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const apply = vi.fn(async (_p: string, _e: unknown[], _t?: unknown) => ({ mix: null, restarted: true, load: 0 }))
vi.mock('../../api/engine', () => ({
  bundledEngineStatus: async () => ({ running: true, healthy: true, port: 8127, model_path: '/m/qwen.gguf' }),
}))
vi.mock('../../api/neuron', () => ({
  neuronInfo: async () => ({ modelKey: 'qwen-1', vectors: [{ id: 'cheerful' }, { id: 'casual' }] }),
  neuronApply: (p: string, e: unknown[], t?: unknown) => apply(p, e, t),
}))

import { followPersona } from '../useNeuronFollowsPersona'
import { useNeuronStore } from '../../stores/neuronStore'

beforeEach(() => {
  apply.mockClear()
  useNeuronStore.setState({
    profiles: { 'qwen-1': { cheerful: 0.5 }, 'qwen-1::persona:pirate': { casual: 0.8 } },
    scopeByModel: {},
  })
})

describe('Neuron sliders follow the persona', () => {
  it('applies the persona profile when switching to it', async () => {
    expect(await followPersona('unrestricted', 'pirate')).toBe(true)
    expect(apply.mock.calls[0][0]).toBe('/m/qwen.gguf')
    expect(apply.mock.calls[0][1]).toEqual([{ id: 'casual', strength: 0.8 }])
  })

  it('goes back to the model profile when leaving it', async () => {
    expect(await followPersona('pirate', 'unrestricted')).toBe(true)
    expect(apply.mock.calls[0][1]).toEqual([{ id: 'cheerful', strength: 0.5 }])
  })

  it('restarts nothing between two personas without own sliders', async () => {
    expect(await followPersona('unrestricted', 'coder')).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })
})
