/**
 * Local background removal (David 2026-07-04): buildDynamicWorkflow must emit a
 * self-contained LoadImage → RMBG → SaveImage cutout graph instead of letting a
 * `removebg` request fall through to a diffusion pass. Every RMBG widget is
 * defaulted from the node's LIVE object_info schema so we never hard-code an
 * enum a future RMBG version would reject with a ComfyUI 400.
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-removebg.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock only the live-fetch boundary; keep the real pure helpers.
vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { classTypes, nodeAt, nodeOf } from './graph-test-support'

// A realistic ComfyUI-RMBG "RMBG" node: one IMAGE connection (`image`) plus a
// handful of widgets, including a `background` combo whose "Alpha" option yields
// a transparent cutout.
const RMBG_NODES = {
  RMBG: {
    input: {
      required: {
        image: ['IMAGE'],
        model: [['RMBG-2.0', 'INSPYRENET', 'BEN2', 'BiRefNet-general'], { default: 'RMBG-2.0' }],
      },
      // ComfyUI-RMBG declares these OPTIONAL in INPUT_TYPES, but its Python reads
      // them as plain kwargs — omitting any throws "'process_res' (RMBG)". The
      // graph must default every widget, required AND optional, from the schema.
      optional: {
        sensitivity: ['FLOAT', { default: 1.0, min: 0, max: 1, step: 0.01 }],
        process_res: ['INT', { default: 1024, min: 256, max: 2048, step: 128 }],
        mask_blur: ['INT', { default: 0, min: 0, max: 64 }],
        background: [['Alpha', 'black', 'white', 'green'], { default: 'Alpha' }],
        background_color: ['COLORCODE', { default: '#222222' }],
        invert_output: ['BOOLEAN', { default: false }],
      },
    },
    output: ['IMAGE', 'MASK'],
  },
  LoadImage: { input: { required: { image: [[]] } } },
  SaveImage: { input: { required: {} } },
}

const removebgParams = {
  model: 'sdxl.safetensors',
  prompt: 'a portrait', negativePrompt: '',
  width: 1024, height: 1024, steps: 20, cfgScale: 7, seed: 1, batchSize: 1,
  removebg: true,
  inputImage: 'photo.png',
} as never

describe('buildDynamicWorkflow — local background removal (RMBG cutout)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAllNodeInfo).mockResolvedValue(RMBG_NODES as never)
  })

  it('builds a self-contained LoadImage → RMBG → SaveImage graph', async () => {
    const wf = await buildDynamicWorkflow(removebgParams)
    const types = classTypes(wf).sort()
    expect(types).toEqual(['LoadImage', 'RMBG', 'SaveImage'])

    const loadId = Object.keys(wf).find((k) => wf[k].class_type === 'LoadImage')!
    const rmbgId = Object.keys(wf).find((k) => wf[k].class_type === 'RMBG')!
    const load = nodeAt(wf, loadId)!
    const rmbg = nodeAt(wf, rmbgId)!
    const [, save] = nodeOf(wf, 'SaveImage')!

    // Source image loaded; RMBG.image wired to it; all other widgets defaulted.
    expect(load.inputs.image).toBe('photo.png')
    expect(rmbg.inputs.image).toEqual([loadId, 0])
    expect(rmbg.inputs.model).toBe('RMBG-2.0')     // combo → declared default
    expect(rmbg.inputs.sensitivity).toBe(1.0)      // FLOAT default
    expect(rmbg.inputs.process_res).toBe(1024)     // INT default
    expect(rmbg.inputs.invert_output).toBe(false)  // BOOLEAN default
    expect(rmbg.inputs.background).toBe('Alpha')   // nudged to transparent
    expect(rmbg.inputs.background_color).toBe('#222222') // COLORCODE default (optional widget)
    // SaveImage takes RMBG's IMAGE output (slot 0) → transparent PNG.
    expect(save.inputs.images).toEqual([rmbgId, 0])
  })

  it('throws an actionable WorkflowUnavailableError when the RMBG node is missing', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({ LoadImage: { input: { required: {} } } } as never)
    await expect(buildDynamicWorkflow(removebgParams)).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(buildDynamicWorkflow(removebgParams)).rejects.toThrow(/ComfyUI-RMBG|background-removal/i)
  })
})
