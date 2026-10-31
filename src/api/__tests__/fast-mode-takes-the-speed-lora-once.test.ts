/**
 * FEHLER-Q1 #1 (3.0.9, box check I1): a lightx2v speed LoRA picked in the
 * LoRA stack went into a Fast run a second time, next to the one Fast mode
 * hangs in itself (same high noise LoRA at 0.8 and 1.0). Two distills on top
 * of each other burn the picture. In a fast Wan 14B run Fast mode owns the
 * speed LoRAs: a stack pick that is one of them is left out, Fast's own goes
 * in once at the strength the model card asks for. Every other stack LoRA
 * stays, and a quality run keeps the stack as it is.
 *
 * Run: npx vitest run src/api/__tests__/fast-mode-takes-the-speed-lora-once.test.ts
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

import { buildDynamicWorkflow } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { localFetch } from '../backend'
import { nodesOf } from './graph-test-support'
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


const STACK_STYLE = 'wan22_motion_boost.safetensors'
const REPACK_HIGH = 'wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors'

/** Every LoRA node in the graph, as name@strength. */
function loraNodes(wf: ComfyApiGraph): string[] {
  return [...nodesOf(wf, 'LoraLoader'), ...nodesOf(wf, 'LoraLoaderModelOnly')]
    .map(([, n]) => `${n.inputs.lora_name}@${n.inputs.strength_model}`)
    .sort()
}

describe('Fast mode takes a speed LoRA from the stack only once', () => {
  beforeEach(() => serve(base([LORA_HIGH, LORA_LOW, WAN21_LORA, STACK_STYLE, REPACK_HIGH])))

  it('the stack pick of the same file is left out, Fast hangs it in at 1.0', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png', lora: [LORA_HIGH], loraStrength: [0.8] }))
    expect(loraNodes(wf)).toEqual([`${LORA_HIGH}@1`, `${LORA_LOW}@1`].sort())
  })

  it('another spelling of the speed LoRA (the Comfy-Org repack) is left out too', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png', lora: [REPACK_HIGH], loraStrength: [0.8] }))
    expect(loraNodes(wf)).toEqual([`${LORA_HIGH}@1`, `${LORA_LOW}@1`].sort())
  })

  it('a style LoRA in the stack stays next to the speed LoRAs', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png', lora: [LORA_HIGH, STACK_STYLE], loraStrength: [0.8, 0.7] }))
    expect(loraNodes(wf)).toEqual([`${LORA_HIGH}@1`, `${LORA_LOW}@1`, `${STACK_STYLE}@0.7`].sort())
  })

  it('Wan 2.1 14B: the single speed LoRA once', async () => {
    const wf = await buildDynamicWorkflow(run(WAN21, { lora: [WAN21_LORA], loraStrength: [0.8] }))
    expect(loraNodes(wf)).toEqual([`${WAN21_LORA}@1`])
  })

  it('a quality run keeps the stack as the user set it', async () => {
    const wf = await buildDynamicWorkflow(run(HIGH, { inputImage: 'start.png', steps: 20, cfgScale: 3.5, lora: [LORA_HIGH], loraStrength: [0.8] }))
    expect(loraNodes(wf)).toEqual([`${LORA_HIGH}@0.8`])
  })
})
