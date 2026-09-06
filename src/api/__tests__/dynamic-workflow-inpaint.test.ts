/**
 * Local Edit = mask inpaint (David 2026-07-12): with inputImage + maskImage on
 * the checkpoint path, buildDynamicWorkflow must emit the inpaint pipeline —
 * Path A (core VAEEncodeForInpaint) or Path B (InpaintModelConditioning) —
 * instead of silently dropping the mask and repainting the whole image as
 * plain img2img (the pre-2.5.7 behavior). Ported 1:1 from the web app's
 * tested builder (create-workflows.ts).
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-inpaint.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { classTypes, nodeOf } from './graph-test-support'

// Minimal live /object_info for an SDXL-checkpoint ComfyUI with core nodes.
const CHECKPOINT_NODES: Record<string, unknown> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors']] } } },
  CLIPTextEncode: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  LoadImage: { input: { required: { image: [[]] } } },
  LoadImageMask: { input: { required: { image: [[]] } } },
  VAEEncode: { input: { required: {} } },
  VAEEncodeForInpaint: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
}

const baseParams = {
  model: 'sdxl.safetensors',
  prompt: 'a red jacket', negativePrompt: 'blurry',
  sampler: 'euler', scheduler: 'normal',
  width: 1024, height: 1024, steps: 20, cfgScale: 7, seed: 1, batchSize: 1,
} as never

// nodeOf/nodesOf/classTypes leben in graph-test-support.ts — siehe dort, warum
// eine Graph-Fixture als ComfyApiGraph statt als Record<string, any> gelesen wird.
const node = nodeOf

describe('buildDynamicWorkflow — local Edit (mask inpaint, checkpoint path)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAllNodeInfo).mockResolvedValue(CHECKPOINT_NODES as never)
  })

  it('Path A: LoadImage + LoadImageMask(red) → VAEEncodeForInpaint → KSampler', async () => {
    const wf = await buildDynamicWorkflow({
      ...(baseParams as object),
      inputImage: 'src.png', maskImage: 'mask.png', growMaskBy: 8,
    } as never)

    const types = classTypes(wf)
    expect(types).toContain('LoadImageMask')
    expect(types).toContain('VAEEncodeForInpaint')
    expect(types).not.toContain('EmptyLatentImage') // replaced by the inpaint latent
    expect(types).not.toContain('VAEEncode')        // NOT the plain-i2i encode

    const [loadId, load] = node(wf, 'LoadImage')!
    const [maskId, mask] = node(wf, 'LoadImageMask')!
    const [encId, enc] = node(wf, 'VAEEncodeForInpaint')!
    const [, sampler] = node(wf, 'KSampler')!
    expect(load.inputs.image).toBe('src.png')
    expect(mask.inputs).toEqual({ image: 'mask.png', channel: 'red' })
    expect(enc.inputs.pixels).toEqual([loadId, 0])
    expect(enc.inputs.mask).toEqual([maskId, 0])
    expect(enc.inputs.grow_mask_by).toBe(8)
    expect(sampler.inputs.latent_image).toEqual([encId, 0])
    // Inpaint denoise default = 0.85 (web-builder parity)
    expect(sampler.inputs.denoise).toBe(0.85)
  })

  it('Path B: InpaintModelConditioning rewires conditionings + latent slot 2', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CHECKPOINT_NODES,
      InpaintModelConditioning: { input: { required: {} } },
    } as never)

    const wf = await buildDynamicWorkflow({
      ...(baseParams as object),
      inputImage: 'src.png', maskImage: 'mask.png',
    } as never)

    const [condId, cond] = node(wf, 'InpaintModelConditioning')!
    const [, sampler] = node(wf, 'KSampler')!
    expect(cond.inputs.noise_mask).toBe(true)
    expect(sampler.inputs.positive).toEqual([condId, 0])
    expect(sampler.inputs.negative).toEqual([condId, 1])
    expect(sampler.inputs.latent_image).toEqual([condId, 2])
    expect(classTypes(wf)).not.toContain('VAEEncodeForInpaint')
  })

  it('inpaint wins over plain i2i when both a mask and denoise<1 are present', async () => {
    const wf = await buildDynamicWorkflow({
      ...(baseParams as object),
      inputImage: 'src.png', maskImage: 'mask.png', denoise: 0.6,
    } as never)
    expect(classTypes(wf)).toContain('VAEEncodeForInpaint')
    expect(classTypes(wf)).not.toContain('VAEEncode')
    expect(node(wf, 'KSampler')![1].inputs.denoise).toBe(0.6) // user strength honored
  })

  it('plain i2i without a mask still uses VAEEncode (no regression)', async () => {
    const wf = await buildDynamicWorkflow({
      ...(baseParams as object),
      inputImage: 'src.png', denoise: 0.7,
    } as never)
    expect(classTypes(wf)).toContain('VAEEncode')
    expect(classTypes(wf)).not.toContain('VAEEncodeForInpaint')
  })

  // 2.5.9: the Edit lane is "Edit / Image to Image" and its canvas says "leave
  // the mask empty to restyle the whole image". useCreate used to refuse that
  // with "Paint a mask first" — the gate contradicted the copy directly above
  // it (found by live E2E on the ship exe, 2026-07-24). The builder was never
  // the problem; this pins the exact params the lane submits with no mask.
  it('the Edit lane with no mask builds i2i at the Edit strength the slider shows', async () => {
    const wf = await buildDynamicWorkflow({
      ...(baseParams as object),
      inputImage: 'apple.png',
      denoise: 0.8, // Edit strength slider default
    } as never)

    const types = classTypes(wf)
    expect(types).toContain('VAEEncode')
    expect(types).not.toContain('LoadImageMask')
    expect(types).not.toContain('VAEEncodeForInpaint')
    expect(types).not.toContain('EmptyLatentImage')

    const [loadId, load] = node(wf, 'LoadImage')!
    const [encId, enc] = node(wf, 'VAEEncode')!
    const [, sampler] = node(wf, 'KSampler')!
    expect(load.inputs.image).toBe('apple.png')
    expect(enc.inputs.pixels).toEqual([loadId, 0])
    expect(sampler.inputs.latent_image).toEqual([encId, 0])
    expect(sampler.inputs.denoise).toBe(0.8)
  })

  it('rejects a masked edit on a non-checkpoint strategy instead of dropping the mask', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CHECKPOINT_NODES,
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } },
      UNETLoader: { input: { required: { unet_name: [['flux1-dev-fp8.safetensors']] } } },
      DualCLIPLoader: { input: { required: {} } },
    } as never)

    await expect(buildDynamicWorkflow({
      ...(baseParams as object),
      model: 'flux1-dev-fp8.safetensors',
      inputImage: 'src.png', maskImage: 'mask.png',
    } as never)).rejects.toThrow(WorkflowUnavailableError)
  })
})
