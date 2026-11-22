// Swap Character on this computer (3.1.3): Wan 2.2 Animate in replace mode,
// with a mask made from the DWPose skeleton by ComfyUI's core mask nodes.
import { describe, it, expect, vi } from 'vitest'
import { buildSwapWorkflow, swapFramesExpression, swapMaskGrow, swapRateExpression, WorkflowUnavailableError, type LocalOpParams } from '../dynamic-workflow'
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

  it('without VideoHelperSuite: the core nodes cut the clip and sample it at the run\'s rate', async () => {
    const wf = await buildSwapWorkflow(params({ frames: 81 }), 7, nodes('Video Slice', 'VideoFrameSample'))
    const [load] = of(wf, 'LoadVideo')
    const [slice, cut] = of(wf, 'Video Slice')
    const [sample, sampled] = of(wf, 'VideoFrameSample')
    expect(cut.inputs).toMatchObject({ video: [load, 0], start_time: 0, duration: 81 / 16, strict_duration: false })
    expect(sampled.inputs).toMatchObject({ video: [slice, 0], num_frames: 81, strategy: 'uniform' })
    const comps = Object.entries(wf).filter(([, x]) => x.class_type === 'GetVideoComponents') as [string, Node][]
    const picture = comps.find(([, x]) => (x.inputs.video as unknown[])[0] === sample)![0]
    const sound = comps.find(([, x]) => (x.inputs.video as unknown[])[0] === slice)![0]
    expect(of(wf, 'ImageScale')[1].inputs.image).toEqual([picture, 0])
    expect(of(wf, 'CreateVideo')[1].inputs).toMatchObject({ audio: [sound, 1], fps: 16 })
  })

  it('with the math node: the frames, the cut and the output rate all follow the video', async () => {
    const wf = await buildSwapWorkflow(params({ frames: 81 }), 7, nodes('Video Slice', 'VideoFrameSample', 'ComfyMathExpression'))
    const maths = Object.entries(wf).filter(([, x]) => x.class_type === 'ComfyMathExpression') as [string, Node][]
    const rate = maths.find(([, x]) => x.inputs.expression === swapRateExpression(16))![0]
    const count = maths.find(([, x]) => x.inputs.expression === swapFramesExpression(81, 16))![0]
    const seconds = maths.find(([, x]) => x.inputs.expression === 'a / b')![0]
    const cut = Object.values(wf).filter((x) => x.class_type === 'Video Slice').map((x) => (x as Node).inputs.duration)
    expect(cut).toContainEqual([seconds, 0])
    expect(of(wf, 'VideoFrameSample')[1].inputs.num_frames).toEqual([count, 1])
    expect(of(wf, 'WanAnimateToVideo')[1].inputs.length).toEqual([count, 1])
    expect(of(wf, 'CreateVideo')[1].inputs.fps).toEqual([rate, 0])
  })

  // The expressions as ComfyUI evaluates them: min, max and floor over numbers.
  const evaluate = (expression: string, a: number): number =>
    new Function('min', 'max', 'floor', 'a', `return ${expression}`)(Math.min, Math.max, Math.floor, a) as number

  it.each([[60, 16, 81], [30, 16, 81], [24, 16, 81], [16, 16, 81], [15, 15, 73], [12, 12, 57], [8, 8, 37]])(
    'a %i fps video plays at %i fps with %i frames, at its real speed',
    (source, rate, frames) => {
      const played = evaluate(swapRateExpression(16), source)
      const count = evaluate(swapFramesExpression(81, 16), played)
      expect([played, count]).toEqual([rate, frames])
      expect((count - 1) % 4).toBe(0)
      expect(count / played).toBeLessThanOrEqual(81 / 16)
      expect(count).toBeLessThanOrEqual(Math.floor((81 / 16) * source))
    },
  )

  it('a ComfyUI without those nodes: the core loader, and the clip keeps the video\'s own rate', async () => {
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
