/**
 * B18 (3.0.9): the graphs behind Fast mode and long local clips.
 *
 *   Fast      Wan 14B with lightx2v's 4 step LoRAs: the high noise LoRA on
 *             the high noise half, the low noise LoRA on the low half, each
 *             half through ModelSamplingSD3 at shift 5. A fast run without
 *             its LoRA stops with the file names instead of making mush.
 *   Shift     A quality Wan run gets the template's shift 8 (it had none).
 *   Continue  A later section loads the clip so far (LoadVideo,
 *             GetVideoComponents), starts on its last frames, pads with its
 *             first frame (ref_pad_image) and saves the whole clip: the
 *             section without the repeated frames behind the clip so far.
 *   Windows   One pass past the native length: the family's context window
 *             node on the model.
 *
 * Every class here is a core ComfyUI node (no custom node pack).
 *
 * Run: npx vitest run src/api/__tests__/long-and-fast-video-graphs.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { localFetch } from '../backend'
import { classTypes, nodeAt, nodeOf, nodesOf } from './graph-test-support'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const HIGH = 'Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf'
const LOW = 'Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf'
const T2V_HIGH = 'Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf'
const T2V_LOW = 'Wan2.2-T2V-A14B-LowNoise-Q4_K_S.gguf'
const LORA_HIGH = 'wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors'
const LORA_LOW = 'wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors'
const WAN21 = 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors'
const WAN21_LORA = 'wan2.1_t2v_14b_lora_rank64_lightx2v_4step.safetensors'
const TI2V = 'wan2.2_ti2v_5B_fp16.safetensors'

const base = (loras: string[]): Record<string, unknown> => ({
  UNETLoader: { input: { required: { unet_name: [[WAN21, TI2V]] } } },
  UnetLoaderGGUF: { input: { required: { unet_name: [[HIGH, LOW, T2V_HIGH, T2V_LOW]] } } },
  CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
  VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors', 'wan2.2_vae.safetensors']] } } },
  LoraLoader: { input: { required: { lora_name: [loras] } } },
  LoraLoaderModelOnly: { input: { required: { lora_name: [loras] } } },
  WanImageToVideo: {
    input: {
      required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] },
      optional: { start_image: ['IMAGE'], clip_vision_output: ['CLIP_VISION_OUTPUT'], ref_pad_image: ['IMAGE'] },
    },
    output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
  },
  Wan22ImageToVideoLatent: { input: { required: {} } },
  WanContextWindowsManual: {
    input: {
      required: {
        model: ['MODEL'], context_length: ['INT', { default: 81 }], context_overlap: ['INT', { default: 30 }],
        context_schedule: [['standard_static', 'standard_uniform'], { default: 'standard_uniform' }],
        fuse_method: [['flat', 'pyramid'], { default: 'pyramid' }],
        freenoise: ['BOOLEAN', { default: true }], retain_first_frame: ['BOOLEAN', { default: false }],
      },
    },
  },
  EmptyHunyuanLatentVideo: { input: { required: {} } },
  ModelSamplingSD3: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  KSamplerAdvanced: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecodeTiled: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  LoadVideo: { input: { required: {} } },
  GetVideoComponents: { input: { required: {} } },
  ImageFromBatch: { input: { required: {} } },
  BatchImagesNode: { input: { required: {} } },
  CreateVideo: { input: { required: {} } },
  SaveVideo: { input: { required: {} } },
})

const serve = (nodes: Record<string, unknown>) => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes as never)
  vi.mocked(localFetch).mockImplementation((async () => ({
    ok: true, status: 200, json: async () => nodes, text: async () => JSON.stringify(nodes),
  })) as never)
}

const run = (model: string, extra: Record<string, unknown> = {}) => ({
  model, prompt: 'a fox runs through snow', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple', steps: 4, cfgScale: 1,
  width: 832, height: 480, seed: 3, batchSize: 1, frames: 81, fps: 16, ...extra,
}) as never

/** The chain of model nodes a sampler reads from, down to the loader. */
function modelChain(wf: ComfyApiGraph, ref: unknown): string[] {
  const out: string[] = []
  let at = ref as [string, number] | undefined
  while (Array.isArray(at)) {
    const node = nodeAt(wf, at[0])!
    out.push(node.class_type === 'LoraLoaderModelOnly' ? `Lora(${node.inputs.lora_name})` : node.class_type === 'ModelSamplingSD3' ? `Shift(${node.inputs.shift})` : node.class_type)
    at = node.inputs.model as [string, number] | undefined
  }
  return out
}

describe('Fast mode: Wan 2.2 A14B with the lightx2v 4 step LoRAs', () => {
  beforeEach(() => serve(base([LORA_HIGH, LORA_LOW, WAN21_LORA])))

  it('each half gets its own LoRA and shift 5, split 2 + 2', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png' }))
    const [high, low] = nodesOf(wf, 'KSamplerAdvanced').map(([, n]) => n)
    expect(modelChain(wf, high.inputs.model)).toEqual(['Shift(5)', `Lora(${LORA_HIGH})`, 'UnetLoaderGGUF'])
    expect(modelChain(wf, low.inputs.model)).toEqual(['Shift(5)', `Lora(${LORA_LOW})`, 'UnetLoaderGGUF'])
    expect(high.inputs).toMatchObject({ steps: 4, cfg: 1, start_at_step: 0, end_at_step: 2 })
    expect(low.inputs).toMatchObject({ steps: 4, cfg: 1, start_at_step: 2 })
    const loaders = nodesOf(wf, 'UnetLoaderGGUF').map(([, n]) => n.inputs.unet_name)
    expect(loaders.sort()).toEqual([HIGH, LOW].sort())
  })

  it('stops with the file names when a speed LoRA is missing', async () => {
    serve(base([LORA_HIGH]))
    await expect(buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png' }))).rejects.toThrow(WorkflowUnavailableError)
    await expect(buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png' }))).rejects.toThrow(/lightx2v.*low_noise.*Quality/s)
  })

  it('Wan 2.1 14B takes its one LoRA on the single model', async () => {
    const wf = await buildDynamicWorkflow(run(WAN21))
    const sampler = nodeOf(wf, 'KSampler')![1]
    expect(modelChain(wf, sampler.inputs.model)).toEqual(['Shift(5)', `Lora(${WAN21_LORA})`, 'UNETLoader'])
  })

  it('a quality run takes no LoRA and the template shift 8', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png', steps: 20, cfgScale: 3.5 }))
    const [high, low] = nodesOf(wf, 'KSamplerAdvanced').map(([, n]) => n)
    expect(modelChain(wf, high.inputs.model)).toEqual(['Shift(8)', 'UnetLoaderGGUF'])
    expect(modelChain(wf, low.inputs.model)).toEqual(['Shift(8)', 'UnetLoaderGGUF'])
    expect(classTypes(wf)).not.toContain('LoraLoaderModelOnly')
  })

  it('a merged fast model (Rapid AIO) gets no second LoRA', async () => {
    serve({ ...base([LORA_HIGH, LORA_LOW]), UnetLoaderGGUF: { input: { required: { unet_name: [['wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf']] } } } })
    const wf = await buildDynamicWorkflow(run('wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf', { inputImage: 'start.png', steps: 6 }))
    expect(classTypes(wf)).not.toContain('LoraLoaderModelOnly')
  })
})

describe('a later section continues the clip so far (core nodes only)', () => {
  beforeEach(() => serve(base([LORA_HIGH, LORA_LOW])))

  it('Wan A14B: last 5 frames in, first frame as padding, whole clip out', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { continueFrom: { video: 'lu_long_1.mp4', overlap: 5 } }))
    expect(nodeOf(wf, 'LoadVideo')![1].inputs.file).toBe('lu_long_1.mp4')
    expect(classTypes(wf)).not.toContain('LoadImage')
    const i2v = nodeOf(wf, 'WanImageToVideo')![1]
    const tail = nodeAt(wf, (i2v.inputs.start_image as [string, number])[0])!
    expect(tail.class_type).toBe('ImageFromBatch')
    expect(tail.inputs).toMatchObject({ batch_index: -5, length: 5 })
    const pad = nodeAt(wf, (i2v.inputs.ref_pad_image as [string, number])[0])!
    expect(pad.inputs).toMatchObject({ batch_index: 0, length: 1 })
    // The save gets the joined frames: clip so far + section from frame 5.
    const create = nodeOf(wf, 'CreateVideo')![1]
    const join = nodeAt(wf, (create.inputs.images as [string, number])[0])!
    expect(join.class_type).toBe('BatchImagesNode')
    const parts = nodeOf(wf, 'GetVideoComponents')![0]
    expect(join.inputs['images.image0']).toEqual([parts, 0])
    const rest = nodeAt(wf, (join.inputs['images.image1'] as [string, number])[0])!
    expect(rest.inputs).toMatchObject({ batch_index: 5 })
    expect(nodeAt(wf, (rest.inputs.image as [string, number])[0])!.class_type).toBe('VAEDecodeTiled')
  })

  it('falls back to ImageBatch on a core without BatchImagesNode', async () => {
    const nodes = base([LORA_HIGH, LORA_LOW])
    delete nodes.BatchImagesNode
    nodes.ImageBatch = { input: { required: {} } }
    serve(nodes)
    const wf = await buildDynamicWorkflow(run(HIGH, { continueFrom: { video: 'c.mp4', overlap: 5 } }))
    expect(classTypes(wf)).toContain('ImageBatch')
  })

  it('a core without the video nodes is told to update', async () => {
    const nodes = base([LORA_HIGH, LORA_LOW])
    delete nodes.LoadVideo
    serve(nodes)
    await expect(buildDynamicWorkflow(run(HIGH, { continueFrom: { video: 'c.mp4', overlap: 5 } }))).rejects.toThrow(/Update ComfyUI/)
  })

  it('Wan 2.2 5B continues through Wan22ImageToVideoLatent', async () => {
    const wf = await buildDynamicWorkflow(run(TI2V, { steps: 20, cfgScale: 5, frames: 121, fps: 24, width: 1280, height: 704, continueFrom: { video: 'c.mp4', overlap: 5 } }))
    const latent = nodeOf(wf, 'Wan22ImageToVideoLatent')![1]
    const scale = nodeAt(wf, (latent.inputs.start_image as [string, number])[0])!
    expect(scale.class_type).toBe('ImageScale')
    expect(nodeAt(wf, (scale.inputs.image as [string, number])[0])!.inputs).toMatchObject({ batch_index: -5, length: 5 })
    expect(classTypes(wf)).toContain('BatchImagesNode')
  })
})

describe('one pass with context windows', () => {
  beforeEach(() => serve(base([LORA_HIGH, LORA_LOW])))

  it('long enough: both halves sample through WanContextWindowsManual', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 's.png', frames: 241, contextWindows: true }))
    const [high, low] = nodesOf(wf, 'KSamplerAdvanced').map(([, n]) => n)
    expect(modelChain(wf, high.inputs.model)[0]).toBe('WanContextWindowsManual')
    expect(modelChain(wf, low.inputs.model)[0]).toBe('WanContextWindowsManual')
    expect(nodeOf(wf, 'WanContextWindowsManual')![1].inputs).toMatchObject({ context_length: 81, context_overlap: 30, fuse_method: 'pyramid', freenoise: true })
  })

  it('a clip inside one window gets none', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 's.png', frames: 81, contextWindows: true }))
    expect(classTypes(wf)).not.toContain('WanContextWindowsManual')
  })
})
