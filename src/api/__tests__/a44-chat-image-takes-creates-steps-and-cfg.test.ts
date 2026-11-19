/**
 * A44 (Discord, 19.11.2026, glitter_fart): an own workflow ran on the Steps
 * and CFG of Create when the picture was made in Create, and on LU's
 * per-model defaults when it was made from Chat or Agent. Same model, same
 * workflow, two results. Now a chat run takes Create's values for the model
 * Create has picked; a value the call names itself still wins.
 *
 * Run: npx vitest run src/api/__tests__/a44-chat-image-takes-creates-steps-and-cfg.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()
const listRunningModels = vi.fn()
const loadModel = vi.fn()
const unloadModel = vi.fn()
const getImageModels = vi.fn()
const getSystemVRAM = vi.fn()
const submitWorkflow = vi.fn()
const getHistory = vi.fn()
const freeMemory = vi.fn()
const buildDynamicWorkflow = vi.fn()
const backendCall = vi.fn()
const getActiveAgentModel = vi.fn()
let isOllamaLocalReturn = true

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...a),
  localFetch: (...a: unknown[]) => localFetch(...a),
  ollamaUrl: (p: string) => `http://localhost:11434/api${p.startsWith('/') ? p : '/' + p}`,
  comfyuiUrl: (p: string) => `http://localhost:8188${p}`,
  isOllamaLocal: () => isOllamaLocalReturn,
  isWindows: () => true,
}))

vi.mock('../ollama', () => ({
  listRunningModels: (...a: unknown[]) => listRunningModels(...a),
  loadModel: (...a: unknown[]) => loadModel(...a),
  unloadModel: (...a: unknown[]) => unloadModel(...a),
}))

vi.mock('../comfyui', async () => {
  const actual = await vi.importActual<typeof import('../comfyui')>('../comfyui')
  return {
    ...actual,
    getImageModels: (...a: unknown[]) => getImageModels(...a),
    getSystemVRAM: (...a: unknown[]) => getSystemVRAM(...a),
    submitWorkflow: (...a: unknown[]) => submitWorkflow(...a),
    getHistory: (...a: unknown[]) => getHistory(...a),
    freeMemory: (...a: unknown[]) => freeMemory(...a),
  }
})

vi.mock('../dynamic-workflow', async () => ({
  ...(await vi.importActual<typeof import('../dynamic-workflow')>('../dynamic-workflow')),
  buildDynamicWorkflow: (...a: unknown[]) => buildDynamicWorkflow(...a),
}))

vi.mock('../agent-context', () => ({
  getActiveAgentModel: () => getActiveAgentModel(),
}))

vi.mock('../comfyui-ws', () => ({
  comfyWS: { on: () => () => {}, connect: () => Promise.resolve(), connected: false },
  CLIENT_ID: 'lu-test-client',
}))

import {
  vramHandoffGenerate,
  createSamplingFor,
  __resetGenerationStateForTests,
  __resetRenderJuggleForTests,
} from '../vram-handoff'
import { useCreateStore } from '../../stores/createStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { useSettingsStore } from '../../stores/settingsStore'

const GB = 1024 * 1024 * 1024

/** What `get_comfy_gpu_status` answers in this test run. */
let gpuStatus: { startedCpu: boolean; mode: string; hasAmd: boolean } = {
  startedCpu: false,
  mode: 'auto',
  hasAmd: false,
}

/** The box's layout: built-in engine up with a GGUF, one Ollama model resident. */
function mockBackends() {
  backendCall.mockImplementation(async (cmd: unknown, args?: unknown) => {
    if (cmd === 'get_comfy_gpu_status') return gpuStatus
    if (cmd === 'bundled_engine_status') {
      return { running: true, port: 8127, model_path: 'C:/models/qwen3-8b.gguf', modelBytes: 5 * GB }
    }
    if (cmd === 'kv_slot_action') {
      const a = args as { action?: string } | undefined
      return a?.action === 'save' ? { ok: true } : { ok: true }
    }
    if (cmd === 'lmstudio_list_loaded') return { loaded: [] }
    if (cmd === 'comfyui_status') return { running: true }
    return {}
  })
}

function completedHistory() {
  return {
    status: { completed: true },
    outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
  }
}


beforeEach(() => {
  for (const m of [localFetch, listRunningModels, loadModel, unloadModel, getImageModels, getSystemVRAM, submitWorkflow, getHistory, freeMemory, buildDynamicWorkflow, backendCall, getActiveAgentModel]) m.mockReset()
  __resetGenerationStateForTests()
  __resetRenderJuggleForTests()
  isOllamaLocalReturn = true
  gpuStatus = { startedCpu: false, mode: 'auto', hasAmd: false }
  loadModel.mockResolvedValue(undefined)
  unloadModel.mockResolvedValue(undefined)
  freeMemory.mockResolvedValue(undefined)
  getActiveAgentModel.mockReturnValue({ name: 'qwen:14b', providerId: 'ollama', remote: false })
  // A model with a KNOWN footprint, so the fits-or-not math really says
  // "evict" and the CPU guard is the only thing that can stop it.
  getImageModels.mockResolvedValue([{ name: 'flux1-dev.safetensors', type: 'flux', source: 'diffusion_model' }])
  getSystemVRAM.mockResolvedValue(12)
  buildDynamicWorkflow.mockResolvedValue({ '9': { class_type: 'SaveImage' } })
  submitWorkflow.mockResolvedValue('pid-1')
  getHistory.mockResolvedValue(completedHistory())
  // /api/ps: the 14 B chat model sits in 9 GB of VRAM on a 12 GB card, so the
  // fits-or-not math says evict whenever it is asked.
  localFetch.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/api/ps')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen:14b', size_vram: 9 * GB }] }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  listRunningModels.mockResolvedValueOnce(['qwen:14b']).mockResolvedValue([])
  mockBackends()
  useSettingsStore.getState().updateSettings({ exclusiveVramMode: 'auto' })
})


const MODEL = 'flux1-dev.safetensors'
/** The user's own workflow for this model, steps and cfg mapped to its KSampler. */
const OWN = {
  id: 'wf-own', name: 'My Flux', source: 'manual', mode: 'api', modelTypes: ['flux'], installedAt: 0,
  workflow: {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['5', 0] } },
    '3': { class_type: 'KSampler', inputs: { steps: 99, cfg: 9.9, seed: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '5': { class_type: 'DualCLIPLoader', inputs: { clip_name1: 'a', clip_name2: 'b', type: 'flux' } },
    '9': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'x' } },
  },
  parameterMap: {
    positivePrompt: { nodeId: '2', inputKey: 'text' },
    steps: { nodeId: '3', inputKey: 'steps' },
    cfgScale: { nodeId: '3', inputKey: 'cfg' },
    seed: { nodeId: '3', inputKey: 'seed' },
  },
}

function sentKSampler(): Record<string, unknown> {
  const graph = submitWorkflow.mock.calls.at(-1)?.[0] as Record<string, { class_type: string; inputs: Record<string, unknown> }>
  return Object.values(graph).find((n) => n.class_type === 'KSampler')!.inputs
}

beforeEach(() => {
  for (const m of [localFetch, listRunningModels, loadModel, unloadModel, getImageModels, getSystemVRAM, submitWorkflow, getHistory, freeMemory, buildDynamicWorkflow, backendCall, getActiveAgentModel]) m.mockReset()
  __resetGenerationStateForTests()
  __resetRenderJuggleForTests()
  gpuStatus = { startedCpu: true, mode: 'cpu', hasAmd: false }
  getActiveAgentModel.mockReturnValue(null)
  getImageModels.mockResolvedValue([{ name: MODEL, type: 'flux', source: 'diffusion_model' }])
  getSystemVRAM.mockResolvedValue(24)
  buildDynamicWorkflow.mockResolvedValue({ '9': { class_type: 'SaveImage' } })
  submitWorkflow.mockResolvedValue('pid-1')
  getHistory.mockResolvedValue({ status: { completed: true }, outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } })
  localFetch.mockImplementation(async () => new Response('{}', { status: 200 }))
  listRunningModels.mockResolvedValue([])
  mockBackends()
  useWorkflowStore.setState({ getWorkflowForModel: (name: string) => (name === MODEL ? OWN : null), paramOverrides: {} } as never)
  // Create: this model picked, the user's own Steps and CFG.
  useCreateStore.setState({ imageModel: MODEL, imageModelType: 'flux', steps: 34, cfgScale: 2.5, sampler: 'dpmpp_2m', scheduler: 'karras' } as never)
})

describe('createSamplingFor', () => {
  it('Create\'s values only for the model Create has picked', () => {
    const create = { imageModel: MODEL, steps: 34, cfgScale: 2.5, sampler: 'dpmpp_2m', scheduler: 'karras' }
    expect(createSamplingFor(MODEL, create)).toEqual({ steps: 34, cfg: 2.5, sampler: 'dpmpp_2m', scheduler: 'karras' })
    expect(createSamplingFor('other.safetensors', create)).toBeNull()
    expect(createSamplingFor(MODEL, { ...create, steps: Number.NaN })).toBeNull()
  })
})

describe('an image from Chat or Agent with an own workflow', () => {
  it('THE REPORT: the workflow gets Create\'s Steps and CFG, as in Create', async () => {
    const out = await vramHandoffGenerate('image', { prompt: 'a red cube', model: MODEL })
    expect(out).toContain('Image generated: out.png')
    const ks = sentKSampler()
    expect(ks.steps).toBe(34)
    expect(ks.cfg).toBe(2.5)
  })

  it('a value the call names itself still wins', async () => {
    await vramHandoffGenerate('image', { prompt: 'a red cube', model: MODEL, steps: 12, cfg: 1.5 })
    const ks = sentKSampler()
    expect(ks.steps).toBe(12)
    expect(ks.cfg).toBe(1.5)
  })

  it('NEGATIVE CONTROL: with another model picked in Create, the model\'s own defaults as before', async () => {
    useCreateStore.setState({ imageModel: 'sdxl.safetensors' } as never)
    await vramHandoffGenerate('image', { prompt: 'a red cube', model: MODEL })
    const ks = sentKSampler()
    expect(ks.steps).not.toBe(34)
    expect(ks.cfg).toBe(1)
  })
})
