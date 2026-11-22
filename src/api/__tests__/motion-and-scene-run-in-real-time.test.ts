// Motion took the first frames of a video and saved them at 16 fps, so a 24 fps
// clip moved 1.5 times too slowly against its own sound. Scene kept the speed
// but came back 3.4 s long where the app says five (RTX 5080, 22.11.2026).
import { describe, it, expect, vi } from 'vitest'
import {
  buildMotionWorkflow, buildSceneWorkflow, clipFramesExpression, clipRateExpression, type LocalOpParams,
} from '../dynamic-workflow'
import { localClipFrames } from '../../lib/create/swap-local'
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
  'WanAnimateToVideo', 'WanVaceToVideo', 'TrimVideoLatent', 'LoadVideo', 'GetVideoComponents', 'CreateVideo',
  'SaveVideo', 'DWPreprocessor', 'DepthAnythingV2Preprocessor', 'UnetLoaderGGUF', 'UNETLoader', 'CLIPLoader',
  'VAELoader', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'ModelSamplingSD3', 'LoadImage', 'ImageScale',
  'ImageFromBatch', 'ImageBatch', 'EmptyImage', 'ImageToMask',
]
const TIMED = ['Video Slice', 'VideoFrameSample', 'ComfyMathExpression']
const nodes = (...extra: string[]) => Object.fromEntries([...CORE, ...extra].map((n) => [n, {}]))

const VACE = 'wan2.1_vace_1.3B_fp16.safetensors'
const params = (op: 'motion' | 'scene', over: Partial<LocalOpParams> = {}): LocalOpParams => ({
  op, model: VACE, prompt: 'a scene', negativePrompt: '', seed: 7, steps: 20, cfgScale: 5,
  sampler: 'euler', scheduler: 'simple', width: 832, height: 480, frames: 81, fps: 16,
  drivingVideo: 'clip.mp4', refImage: 'char.png', ...over,
})

type Node = ComfyApiNode & { inputs: Record<string, unknown> }
const all = (wf: ComfyApiGraph, t: string) =>
  Object.entries(wf).filter(([, n]) => n.class_type === t) as [string, Node][]
const math = (wf: ComfyApiGraph, expression: string) =>
  all(wf, 'ComfyMathExpression').find(([, n]) => n.inputs.expression === expression)![0]
const evaluate = (expression: string, a: number): number =>
  new Function('min', 'max', 'floor', 'a', `return ${expression}`)(Math.min, Math.max, Math.floor, a) as number

describe('without VideoHelperSuite', () => {
  it('Motion reads the clip at the run\'s rate and keeps that stretch of sound', async () => {
    const wf = await buildMotionWorkflow(params('motion'), 7, nodes(...TIMED))
    const count = math(wf, clipFramesExpression(81, 16))
    const rate = math(wf, clipRateExpression(16))
    const [sampleId, sample] = all(wf, 'VideoFrameSample')[0]
    expect(sample.inputs.num_frames).toEqual([count, 1])
    const picture = all(wf, 'GetVideoComponents').find(([, n]) => (n.inputs.video as unknown[])[0] === sampleId)![0]
    expect(all(wf, 'DWPreprocessor')[0][1].inputs.image).toEqual([picture, 0])
    expect(all(wf, 'WanVaceToVideo')[0][1].inputs.length).toEqual([count, 1])
    const output = all(wf, 'CreateVideo')[0][1].inputs
    expect(output.fps).toEqual([rate, 0])
    const soundFrom = (output.audio as [string, number])[0]
    expect((wf[soundFrom] as Node).inputs.video).toEqual(sample.inputs.video)
  })

  it('Scene reads the clip at the run\'s rate', async () => {
    const wf = await buildSceneWorkflow(params('scene'), 7, nodes(...TIMED))
    const count = math(wf, clipFramesExpression(81, 16))
    expect(all(wf, 'WanVaceToVideo')[0][1].inputs.length).toEqual([count, 1])
    expect(all(wf, 'CreateVideo')[0][1].inputs.fps).toEqual([math(wf, clipRateExpression(16)), 0])
  })

  it('Scene with an own first frame counts the rest from the real frames', async () => {
    const wf = await buildSceneWorkflow(params('scene', { firstFrame: 'first.png' }), 7, nodes(...TIMED))
    const rest = math(wf, 'a - 1')
    expect(all(wf, 'ImageFromBatch')[0][1].inputs.length).toEqual([rest, 1])
    expect(all(wf, 'EmptyImage').some(([, n]) => JSON.stringify(n.inputs.batch_size) === JSON.stringify([rest, 1]))).toBe(true)
  })

  it('a ComfyUI without the core nodes keeps the old graph', async () => {
    const motion = await buildMotionWorkflow(params('motion'), 7, nodes())
    expect(all(motion, 'Video Slice')).toHaveLength(0)
    const scene = await buildSceneWorkflow(params('scene'), 7, nodes())
    expect(all(scene, 'Video Slice')).toHaveLength(0)
  })
})

describe('with VideoHelperSuite', () => {
  it('Scene stays on its resampling loader', async () => {
    const wf = await buildSceneWorkflow(params('scene'), 7, nodes('VHS_LoadVideo', ...TIMED))
    expect(all(wf, 'VHS_LoadVideo')[0][1].inputs).toMatchObject({ force_rate: 16, frame_load_cap: 81 })
    expect(all(wf, 'Video Slice')).toHaveLength(0)
  })
})

describe('the length of a run', () => {
  it.each([[60, 16, 81], [30, 16, 81], [24, 16, 81], [15, 15, 73], [12, 12, 57], [8, 8, 37]])(
    'a %i fps video plays at %i fps with %i real frames',
    (source, rate, frames) => {
      const played = evaluate(clipRateExpression(16), source)
      const count = evaluate(clipFramesExpression(81, 16), played)
      expect([played, count]).toEqual([rate, frames])
      expect(count).toBeLessThanOrEqual(Math.floor((81 / 16) * source))
    },
  )

  it.each([[3, 45], [2, 29], [4.9, 77], [7, 77]])('a %f s clip with a 77 frame slider makes %i frames', (seconds, frames) => {
    expect(localClipFrames(77, seconds, 16)).toBe(frames)
    expect(frames / 16).toBeLessThanOrEqual(seconds)
  })

  it('an unreadable length keeps the slider', () => {
    expect(localClipFrames(77, undefined, 16)).toBe(77)
  })
})
