import { describe, expect, it, vi } from 'vitest'

const call = vi.hoisted(() => vi.fn(async () => ({ started: true })))
vi.mock('../backend', () => ({ backendCall: call }))

import { neuronMlpAdd } from '../neuron'

// Single neurons (David, 31.10.2026, "Ja, in 3.0.9"): N2's recipe view finds
// this export and runs it for every `L13N7956±d` line that is not ready yet.
describe('neuronMlpAdd', () => {
  it('asks the backend for one neuron of the model as a slider', async () => {
    await neuronMlpAdd('/m/Qwen3.5-4B-Q8_0.gguf', 13, 7956)
    expect(call).toHaveBeenCalledWith('neuron_mlp_add', { modelPath: '/m/Qwen3.5-4B-Q8_0.gguf', layer: 13, neuron: 7956 })
  })
})
