// Swap Character on this computer (3.1.3): Wan 2.2 Animate in replace mode,
// with a mask made from the DWPose skeleton by ComfyUI's core mask nodes.
import { describe, it, expect, vi } from 'vitest'
import { buildSwapWorkflow, swapMaskGrow, WorkflowUnavailableError, type LocalOpParams } from '../dynamic-workflow'
import type { ComfyApiGraph, ComfyApiNode } from '../../types/comfy-graph'

vi.mock('../comfyui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui')>()
  return {
    ...actual,
    findMatchingCLIP: vi.fn(async () => 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'),
    findMatchingVAE: vi.fn(async () => 'wan_2.1_vae.safetensors'),
  }
})

const CORE = [
  'WanAnimateToVideo', 'TrimVideoLatent', 'LoadVideo', 'GetVideoComponents', 'CreateVideo', 'SaveVideo',
  'DWPreprocessor', 'UnetLoaderGGUF', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'KSampler',
  'VAEDecode', 'ModelSamplingSD3', 'LoadImage', 'ImageScale', 'ImageToMask', 'MaskComposite', 'ThresholdMask',
  'GrowMask', 'EmptyImage', 'ImageCompositeMasked',
]
const nodes = (...extra: string[]) => Object.fromEntries([...CORE, ...extra].map((n) => [n, {}]))
const without = (name: string) => { const n = nodes('VHS_LoadVideo'); delete n[name]; return n }

const params = (over: Partial<LocalOpParams> = {}): LocalOpParams => ({
  op: 'swap', model: 'Wan2.2-Animate-14B-Q4_K_M.gguf', prompt: '', negativePrompt: '',
  seed: 7, steps: 20, cfgScale: 5, sampler: 'euler', scheduler: 'simple',
  width: 832, height: 480, frames: 77, fps: 16, drivingVideo: 'clip.mp4', refImage: 'char.png', ...over,
})

type Node = ComfyApiNode & { inputs: Record<string, unknown> }
const of = (wf: ComfyApiGraph, t: string): [string, Node] => {
  const hit = Object.entries(wf).find(([, n]) => n.class_type === t)
  if (!hit || !hit[1].inputs) throw new Error(`no ${t}`)
  return hit as [string, Node]
}

describe('buildSwapWorkflow', () => {
  it('replace mode: background with the person painted out, a mask from the pose, the pose, the character', async () => {
    const wf = await buildSwapWorkflow(params(), 7, nodes('VHS_LoadVideo'))
    const [, cond] = of(wf, 'WanAnimateToVideo')
    const [maskId, grow] = of(wf, 'GrowMask')
    const [bgId, bg] = of(wf, 'ImageCompositeMasked')
    expect(cond.inputs.character_mask).toEqual([maskId, 0])
    expect(cond.inputs.background_video).toEqual([bgId, 0])
    expect(bg.inputs.mask).toEqual([maskId, 0])
    expect(grow.inputs.expand).toBe(48)
    expect(cond.inputs.pose_video).toBeTruthy()
    expect(cond.inputs.reference_image).toBeTruthy()
    // Three channels of the skeleton, added, thresholded.
    expect(Object.values(wf).filter((n) => n.class_type === 'ImageToMask').map((n) => n.inputs?.channel)).toEqual(['red', 'green', 'blue'])
    expect(of(wf, 'ThresholdMask')[1].inputs.value).toBe(0.1)
  })

  it('reads the video at the run rate with VideoHelperSuite and keeps its sound', async () => {
    const wf = await buildSwapWorkflow(params(), 7, nodes('VHS_LoadVideo'))
    const [vid, load] = of(wf, 'VHS_LoadVideo')
    expect(load.inputs).toMatchObject({ video: 'clip.mp4', force_rate: 16, frame_load_cap: 77 })
    expect(of(wf, 'CreateVideo')[1].inputs).toMatchObject({ audio: [vid, 2], fps: 16 })
  })

  it('without VideoHelperSuite: the core loader, and the clip keeps the video\'s own rate', async () => {
    const wf = await buildSwapWorkflow(params(), 7, nodes())
    const [comp] = of(wf, 'GetVideoComponents')
    expect(of(wf, 'CreateVideo')[1].inputs).toMatchObject({ audio: [comp, 1], fps: [comp, 2] })
  })

  it('needs Wan 2.2 Animate, DWPose, a video and a character', async () => {
    await expect(buildSwapWorkflow(params({ model: 'wan2.1_vace_14B_fp16.safetensors' }), 7, nodes())).rejects.toThrow(/Wan 2\.2 Animate/)
    await expect(buildSwapWorkflow(params({ drivingVideo: undefined }), 7, nodes())).rejects.toThrow(/original video/)
    await expect(buildSwapWorkflow(params({ refImage: undefined }), 7, nodes())).rejects.toThrow(/character or a photo/)
    await expect(buildSwapWorkflow(params(), 7, without('DWPreprocessor'))).rejects.toBeInstanceOf(WorkflowUnavailableError)
    await expect(buildSwapWorkflow(params(), 7, without('GrowMask'))).rejects.toBeInstanceOf(WorkflowUnavailableError)
  })

  it('grows the mask by a tenth of the short side, at least 24 px', () => {
    expect(swapMaskGrow(832, 480)).toBe(48)
    expect(swapMaskGrow(480, 832)).toBe(48)
    expect(swapMaskGrow(160, 160)).toBe(24)
  })
})
