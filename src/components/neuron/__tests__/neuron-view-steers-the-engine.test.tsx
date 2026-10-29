/**
 * @vitest-environment jsdom
 *
 * P11 (3.0.9): the Neuron tweaker. A slider that is not computed for the
 * model offers to compute it (locked, with no false notice, until the model's
 * info is in); a computed one, moved, reaches the engine as
 * one entry; Reset brings the engine back to no vector at all; a chat model
 * in Ollama is told plainly that the sliders cannot reach it; an embedding
 * model is never offered.
 *
 * Run: npx vitest run src/components/neuron/__tests__/neuron-view-steers-the-engine.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const apply = vi.fn(async (_path: string, _entries: unknown[], _tuning?: unknown) => ({ mix: null, restarted: true, load: 0 }))
const buildPreset = vi.fn(async (_path: string, _id: string) => ({ started: true }))
const vectors: Array<Record<string, unknown>> = []

vi.mock('../../../api/neuron', () => ({
  neuronPresets: async () => [
    { id: 'creative', left: 'Sober', right: 'Creative' },
    { id: 'cheerful', left: 'Serious', right: 'Cheerful' },
  ],
  neuronInfo: async () => ({
    facts: { arch: 'qwen2', nLayer: 24, nEmbd: 896, template: 'chatMl', name: 'Qwen2.5 0.5B Instruct' },
    modelKey: 'qwen-1',
    generator: true,
    band: [3, 20],
    vectors: [...vectors],
    sae: null,
    activeMix: null,
  }),
  neuronStatus: async () => ({ status: 'idle', kind: '', title: '', modelPath: '', phaseLabel: '', step: 0, total: 0, bytesDone: 0, bytesTotal: 0, rateBps: 0, etaSecs: null, elapsedSecs: 0, resultId: null, error: null, logs: [] }),
  neuronApply: (p: string, e: unknown[], t?: unknown) => apply(p, e, t),
  neuronBuildPreset: (p: string, id: string) => buildPreset(p, id),
  neuronBuildOwn: vi.fn(), neuronCancel: vi.fn(), neuronCompare: vi.fn(), neuronDelete: vi.fn(), neuronDismiss: vi.fn(),
  neuronFeatureAdd: vi.fn(), neuronSaeDownload: vi.fn(), neuronSaeSearch: vi.fn(),
}))
vi.mock('../../../api/engine', () => ({
  listBundledModels: async () => [...disk.models],
  isEmbeddingGgufName: (name: string) => /embed/.test(name.toLowerCase()),
  bundledEngineStatus: async () => ({ running: true, healthy: true, port: 8127, model_path: '/models/qwen.gguf', ctx: 8192 }),
}))
vi.mock('../../../api/backend', () => ({ openExternal: vi.fn(), backendCall: vi.fn() }))
const QWEN = { name: 'qwen2.5-0.5b-instruct-q8_0', path: '/models/qwen.gguf', size: 1, loaded: true }
const NOMIC = { name: 'nomic-embed-text-v1.5.Q4_K_M', path: '/models/nomic.gguf', size: 1, loaded: false }
const disk = vi.hoisted(() => ({ models: [] as Array<Record<string, unknown>> }))
const slot = vi.hoisted(() => ({ managed: true }))
vi.mock('../../../api/builtin-ensure', () => ({ isManagedBuiltinSlot: () => slot.managed }))

import { NeuronView } from '../NeuronView'
import { useModelStore } from '../../../stores/modelStore'
import { useNeuronStore } from '../../../stores/neuronStore'

beforeEach(() => {
  apply.mockClear()
  buildPreset.mockClear()
  vectors.length = 0
  slot.managed = true
  disk.models = [NOMIC, QWEN]
  useNeuronStore.setState({ profiles: {}, scopeByModel: {} })
  useModelStore.setState({ activeModel: 'openai::qwen2.5-0.5b-instruct-q8_0' })
})
afterEach(() => cleanup())

describe('Neuron tweaker view', () => {
  it('offers to compute a slider the model does not have yet', async () => {
    render(createElement(NeuronView))
    const button = (await screen.findByTestId('neuron-compute-creative')) as HTMLButtonElement
    // Locked until the model's info says the vector tool is there; a click
    // before that does nothing, as it should.
    expect(screen.queryByText(/This build has no vector tool/)).toBeNull()
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(buildPreset).toHaveBeenCalledWith('/models/qwen.gguf', 'creative'))
  })

  it('sends a moved slider to the engine and Reset sends none', async () => {
    vectors.push({ id: 'creative', kind: 'preset', name: 'Sober ↔ Creative', left: 'Sober', right: 'Creative', unit: 0.8, builtAt: 1, more: [], less: [] })
    render(createElement(NeuronView))
    const row = await screen.findByTestId('neuron-slider-creative')
    // First apply on open: nothing set, no vector.
    await waitFor(() => expect(apply).toHaveBeenCalled())
    expect(apply.mock.calls[0][1]).toEqual([])
    const range = row.querySelector('input[type=range]') as HTMLInputElement
    fireEvent.change(range, { target: { value: '0.6' } })
    await waitFor(() => expect(apply.mock.calls.at(-1)?.[1]).toEqual([{ id: 'creative', strength: 0.6 }]), { timeout: 3000 })
    fireEvent.click(screen.getByTestId('neuron-reset'))
    await waitFor(() => expect(apply.mock.calls.at(-1)?.[1]).toEqual([]), { timeout: 3000 })
  })

  // T1 (3.0.9): the embedding model of Document Chat was the only choice,
  // and the vector tool aborted on it.
  it('offers chat models only, under a labelled picker', async () => {
    render(createElement(NeuronView))
    const picker = (await screen.findByLabelText('Model')) as HTMLSelectElement
    await waitFor(() => expect(picker.options.length).toBe(1))
    expect(picker.options[0].value).toBe('/models/qwen.gguf')
  })

  it('says so when only an embedding model is there', async () => {
    disk.models = [NOMIC]
    useModelStore.setState({ activeModel: 'ollama::llama3:8b' })
    render(createElement(NeuronView))
    expect((await screen.findByTestId('neuron-no-chat-model')).textContent).toMatch(/no chat model/)
    expect(screen.getByText(/Ollama takes no control vectors/)).toBeTruthy()
    expect(screen.queryByTestId('neuron-model')).toBeNull()
  })

  it('says plainly when the chat model runs in Ollama', async () => {
    useModelStore.setState({ activeModel: 'ollama::llama3:8b' })
    render(createElement(NeuronView))
    expect(await screen.findByText(/Ollama takes no control vectors/)).toBeTruthy()
  })
})
