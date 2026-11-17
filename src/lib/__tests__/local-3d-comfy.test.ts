// Local 3D on Windows and Linux (3.1.0): readiness, the run, its progress line
// and where the finished model is found. ComfyUI is mocked at the module edge.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const submitWorkflow = vi.fn()
const getHistory = vi.fn()
const promptQueueState = vi.fn()
const abandonPrompt = vi.fn()
const folderRead = vi.fn()
vi.mock('../../api/comfyui', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../api/comfyui')>()
  return {
    ...real,
    submitWorkflow: (...a: unknown[]) => submitWorkflow(...a),
    getHistory: (...a: unknown[]) => getHistory(...a),
    promptQueueState: (...a: unknown[]) => promptQueueState(...a),
    abandonPrompt: (...a: unknown[]) => abandonPrompt(...a),
    COMFY_MODEL_FOLDERS: real.COMFY_MODEL_FOLDERS.map((f) => ({ subfolder: f.subfolder, read: () => folderRead(f.subfolder) })),
  }
})
const wsListeners: Array<(e: unknown) => void> = []
const wsConnect = vi.fn()
vi.mock('../../api/comfyui-ws', () => ({
  CLIENT_ID: 'lu-test',
  comfyWS: {
    connect: (...a: unknown[]) => wsConnect(...a),
    mark: () => 0,
    on: (l: (e: unknown) => void) => { wsListeners.push(l); return () => { wsListeners.splice(wsListeners.indexOf(l), 1) } },
  },
}))
const buildLocalThreeDWorkflow = vi.fn()
vi.mock('../../api/dynamic-workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/dynamic-workflow')>()),
  buildLocalThreeDWorkflow: (...a: unknown[]) => buildLocalThreeDWorkflow(...a),
}))

import {
  comfyThreeDReady, runComfyThreeD, createThreeDProgress, threeDOutputFromHistory, threeDPhaseForNode,
} from '../local-3d-comfy'
import { buildThreeDWorkflow, THREE_D_NODES, THREE_D_CUTOUT_NODES, THREE_D_SAVE_NODE, THREE_D_NEEDS_UPDATE, WorkflowUnavailableError } from '../../api/dynamic-workflow'
import { TRELLIS2_FILES } from '../../api/model-bundles'

const ALL = Object.fromEntries([...THREE_D_NODES, ...THREE_D_CUTOUT_NODES].map((n) => [n, {}]))
const graph = buildThreeDWorkflow({ image: 'chair.png', detail: 'standard', cutout: true, seed: 7 }, ALL)
const GLB = { filename: 'locally_uncensored_3d_x_00001_.glb', subfolder: '3d', type: 'output' }
const success = { status: { status_str: 'success', completed: true }, outputs: { [THREE_D_SAVE_NODE]: { '3d': [GLB], camera_info: [null] } } }

const ON_DISK: Record<string, string[]> = {
  diffusion_models: [TRELLIS2_FILES.model, 'flux.safetensors'],
  vae: [TRELLIS2_FILES.shapeVae, TRELLIS2_FILES.textureVae],
  clip_vision: [TRELLIS2_FILES.imageEncoder],
  background_removal: [TRELLIS2_FILES.cutout],
}

beforeEach(() => {
  vi.clearAllMocks()
  wsListeners.length = 0
  folderRead.mockImplementation(async (sub: string) => ON_DISK[sub] ?? [])
  buildLocalThreeDWorkflow.mockResolvedValue(graph)
  submitWorkflow.mockResolvedValue('p1')
  getHistory.mockResolvedValue(null)
  promptQueueState.mockResolvedValue('queued')
  wsConnect.mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers() })

describe('comfyThreeDReady', () => {
  it('is true with all five files listed in their folders', async () => {
    expect(await comfyThreeDReady()).toBe(true)
  })

  it('is false with one file missing', async () => {
    folderRead.mockImplementation(async (sub: string) => sub === 'background_removal' ? [] : ON_DISK[sub] ?? [])
    expect(await comfyThreeDReady()).toBe(false)
  })

  it('is false when a folder\'s loader is not registered (older ComfyUI)', async () => {
    folderRead.mockImplementation(async (sub: string) => sub === 'background_removal' ? null : ON_DISK[sub] ?? [])
    expect(await comfyThreeDReady()).toBe(false)
  })

  it('is false when ComfyUI cannot be asked', async () => {
    folderRead.mockRejectedValue(new Error('down'))
    expect(await comfyThreeDReady()).toBe(false)
  })

  it('finds a file ComfyUI lists in a subfolder', async () => {
    folderRead.mockImplementation(async (sub: string) =>
      sub === 'diffusion_models' ? [`3d\\${TRELLIS2_FILES.model}`] : ON_DISK[sub] ?? [])
    expect(await comfyThreeDReady()).toBe(true)
  })
})

describe('the progress line', () => {
  it('names the phases of plan 1.8 and never goes back', () => {
    const p = createThreeDProgress(graph, true)
    const lines: string[] = []
    const pct: number[] = []
    for (const id of ['122', '193', '192', '312', '299', '3', '241', '12', '186', '147', '260', THREE_D_SAVE_NODE]) {
      const r = p.executing(id)
      lines.push(r.line)
      pct.push(r.percent)
    }
    expect(lines[0]).toBe('Getting the model ready…')
    expect(lines).toContain('Cutting out your object…')
    expect(lines).toContain('Building the shape…')
    expect(lines).toContain('Painting the surface…')
    expect(lines.at(-1)).toBe('Saving your model…')
    // Remesh (shape) after the texture sampler (paint) keeps the paint line.
    expect(lines[8]).toBe('Painting the surface…')
    for (let i = 1; i < pct.length; i++) expect(pct[i]).toBeGreaterThanOrEqual(pct[i - 1])
    expect(Math.max(...pct)).toBeLessThan(100)
  })

  it('moves inside a sampler', () => {
    const p = createThreeDProgress(graph, true)
    const a = p.executing('18').percent
    const b = p.step(10, 20).percent
    expect(b).toBeGreaterThanOrEqual(a)
  })

  it('without a cutout the crop is part of getting ready', () => {
    expect(threeDPhaseForNode('312', false)).toBe('load')
    expect(threeDPhaseForNode('312', true)).toBe('cutout')
  })
})

describe('threeDOutputFromHistory', () => {
  it('takes the GLB of the save node', () => {
    expect(threeDOutputFromHistory(success)).toEqual(GLB)
  })
  it('is null without a mesh file', () => {
    expect(threeDOutputFromHistory({ outputs: { '1': { images: [{ filename: 'x.png', type: 'temp' }] } } })).toBeNull()
    expect(threeDOutputFromHistory(null)).toBeNull()
  })
})

describe('runComfyThreeD', () => {
  it('queues the graph and hands back the GLB when ComfyUI says it is done', async () => {
    getHistory.mockResolvedValue(success)
    const lines: string[] = []
    const run = runComfyThreeD({ imageName: 'chair.png', detail: 'standard', cutout: true, seed: 7, onProgress: (l) => lines.push(l) })
    await vi.waitFor(() => expect(wsListeners.length).toBe(1))
    wsListeners[0]({ type: 'executing', data: { node: '3', prompt_id: 'p1' } })
    wsListeners[0]({ type: 'executing', data: { node: '3', prompt_id: 'someone-else' } })
    wsListeners[0]({ type: 'execution_success', data: { prompt_id: 'p1' } })
    await expect(run).resolves.toEqual(GLB)
    expect(buildLocalThreeDWorkflow).toHaveBeenCalledWith({ image: 'chair.png', detail: 'standard', cutout: true, seed: 7 })
    expect(submitWorkflow).toHaveBeenCalledWith(graph, 'lu-test')
    expect(lines).toContain('Building the shape…')
    expect(lines.at(-1)).toBe('Saving your model…')
    expect(wsListeners.length).toBe(0)
  })

  it('reports ComfyUI\'s own error', async () => {
    const run = runComfyThreeD({ imageName: 'chair.png', detail: 'draft', cutout: false })
    await vi.waitFor(() => expect(wsListeners.length).toBe(1))
    wsListeners[0]({ type: 'execution_error', data: { prompt_id: 'p1', exception_message: 'CUDA out of memory', node_type: 'KSampler' } })
    await expect(run).rejects.toThrow('CUDA out of memory (KSampler)')
  })

  it('queues nothing on a ComfyUI too old for the graph, and says to update', async () => {
    // A RemeshMesh without 'solid' (ComfyUI 0.36 to 0.41), found before the run.
    buildLocalThreeDWorkflow.mockRejectedValue(new WorkflowUnavailableError(THREE_D_NEEDS_UPDATE, 'unavailable', undefined, { needsComfyUpdate: true }))
    await expect(runComfyThreeD({ imageName: 'chair.png', detail: 'draft', cutout: false })).rejects.toThrow(THREE_D_NEEDS_UPDATE)
    expect(submitWorkflow).not.toHaveBeenCalled()
  })

  it('a cancel takes only this prompt out of ComfyUI', async () => {
    const ctl = new AbortController()
    const run = runComfyThreeD({ imageName: 'chair.png', detail: 'draft', cutout: true, signal: ctl.signal })
    await vi.waitFor(() => expect(wsListeners.length).toBe(1))
    ctl.abort()
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(abandonPrompt).toHaveBeenCalledWith('p1')
  })

  it('a cancel before the submit queues nothing', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(runComfyThreeD({ imageName: 'chair.png', detail: 'draft', cutout: true, signal: ctl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(submitWorkflow).not.toHaveBeenCalled()
  })

  it('finishes from the history poll when there is no socket', async () => {
    vi.useFakeTimers()
    wsConnect.mockRejectedValue(new Error('no ws'))
    const run = runComfyThreeD({ imageName: 'chair.png', detail: 'fine', cutout: true })
    await vi.advanceTimersByTimeAsync(0)
    getHistory.mockResolvedValue(success)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(run).resolves.toEqual(GLB)
  })

  it('says so when a finished run left no model', async () => {
    getHistory.mockResolvedValue({ status: { status_str: 'success', completed: true }, outputs: {} })
    const run = runComfyThreeD({ imageName: 'chair.png', detail: 'fine', cutout: true })
    await vi.waitFor(() => expect(wsListeners.length).toBe(1))
    wsListeners[0]({ type: 'executing', data: { node: null, prompt_id: 'p1' } })
    await expect(run).rejects.toThrow(/no 3D model came out/)
  })

  it('gives up on a prompt ComfyUI no longer has', async () => {
    vi.useFakeTimers()
    promptQueueState.mockResolvedValue('gone')
    const run = runComfyThreeD({ imageName: 'chair.png', detail: 'fine', cutout: true })
    const done = expect(run).rejects.toThrow(/no longer has this 3D run/)
    await vi.advanceTimersByTimeAsync(20_000)
    await done
  })
})
