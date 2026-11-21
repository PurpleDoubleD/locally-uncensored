/**
 * FastH3 (FastVideo's 8 step distillation of MiniMax H3, ComfyUI nodes since
 * 0.35.0). A full checkpoint of its own, not a LoRA: the Hugging Face repo
 * FastVideo/FastVideo-FastH3-Comfy holds fastvideo_fasth3_8step_v2_pruned_*,
 * and the official Comfy-Org template video_fastvideo_fasth3_t2v loads it with
 * H3's own encoder and VAEs, a sigma shift of 10 and VSA sparse attention.
 * Text to video only: the model card says first/last frame and reference were
 * not distilled.
 *
 * Run: npx vitest run src/api/__tests__/fasth3-is-the-fast-minimax-h3.test.ts
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

import { buildDynamicWorkflow, FASTH3_NEEDS_UPDATE, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { classifyModel, isFastH3, isVideoModelType, isI2VModel, isT2VCapable, videoLaneModels, type ClassifiedModel } from '../comfyui'
import { localFetch } from '../backend'
import { nodeOf } from './graph-test-support'

const FAST = 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors'
const BASE = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
const ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'

const NODES: Record<string, unknown> = {
  UNETLoader: { input: { required: { unet_name: [[FAST, BASE]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VIDEO_VAE, AUDIO_VAE]] } } },
  LoraLoaderModelOnly: { input: { required: {} } },
  MiniMaxH3ImageToVideo: { input: { required: {} } },
  MiniMaxH3ReferenceToVideo: { input: { required: {} } },
  MiniMaxH3SigmaShift: { input: { required: {} } },
  BlockSparseAttention: { input: { required: {} } },
  BasicGuider: { input: { required: {} } },
  BasicScheduler: { input: { required: {} } },
  KSamplerSelect: { input: { required: {} } },
  RandomNoise: { input: { required: {} } },
  SamplerCustomAdvanced: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  VAEDecodeAudio: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  CreateVideo: { input: { required: {} } },
  SaveVideo: { input: { required: {} } },
}

const run = (model: string, extra: Record<string, unknown> = {}) => ({
  model, prompt: 'a drummer on a rooftop, the snare cracks on every hit', negativePrompt: '',
  sampler: 'res_multistep', scheduler: 'simple', steps: 20, cfgScale: 1,
  width: 1344, height: 768, seed: 7, batchSize: 1, frames: 124, fps: 24, ...extra,
}) as never

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(NODES as never)
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
      VAELoader: { input: { required: { vae_name: [[VIDEO_VAE, AUDIO_VAE]] } } },
    }),
  } as never)
})

describe('FastH3 is an H3 video model that only does text to video', () => {
  it('the file name says fasth3, not minimax, and still lands in the H3 family', () => {
    expect(isFastH3(FAST)).toBe(true)
    expect(isFastH3(BASE)).toBe(false)
    expect(classifyModel(FAST)).toBe('minimaxh3')
    expect(isVideoModelType(classifyModel(FAST))).toBe(true)
  })

  it('it is offered for text to video and left out of Animate and Extend', () => {
    expect(isT2VCapable(FAST)).toBe(true)
    expect(isI2VModel(FAST)).toBe(false)
    expect(isI2VModel(BASE)).toBe(true)
    const list = [FAST, BASE].map((name) => ({ name, type: 'minimaxh3', source: 'diffusion_model' }) as ClassifiedModel)
    expect(videoLaneModels(list, 'video').map((m) => m.name)).toEqual([FAST, BASE])
    expect(videoLaneModels(list, 'animate').map((m) => m.name)).toEqual([BASE])
    expect(videoLaneModels(list, 'extend').map((m) => m.name)).toEqual([BASE])
  })
})

describe('the graph follows the official template', () => {
  it('UNET, then the sigma shift (10 and 3), then VSA sparse attention, then guider and scheduler on that model', async () => {
    const wf = await buildDynamicWorkflow(run(FAST), 'minimaxh3')
    const unetId = nodeOf(wf, 'UNETLoader')![0]
    expect(nodeOf(wf, 'UNETLoader')![1].inputs.unet_name).toBe(FAST)
    const [shiftId, shift] = nodeOf(wf, 'MiniMaxH3SigmaShift')!
    expect(shift.inputs).toEqual({ model: [unetId, 0], shift_video: 10, shift_audio: 3 })
    const [sparseId, sparse] = nodeOf(wf, 'BlockSparseAttention')!
    // DynamicCombo inputs go over the API as "name" plus "name.child".
    expect(sparse.inputs).toMatchObject({
      model: [shiftId, 0], selection: 'vsa', 'selection.keep_percent': 10,
      start_percent: 0.2, end_percent: 1, dense_blocks: '', min_tokens: 12288, extra_tokens: 256,
      sink_conditioning: 'exact_kv_and_rows', verbose: false,
    })
    expect(nodeOf(wf, 'BasicGuider')![1].inputs.model).toEqual([sparseId, 0])
    expect(nodeOf(wf, 'BasicScheduler')![1].inputs.model).toEqual([sparseId, 0])
  })

  it('runs exactly 8 steps on res_multistep, whatever the slider says', async () => {
    const wf = await buildDynamicWorkflow(run(FAST, { steps: 30 }), 'minimaxh3')
    expect(nodeOf(wf, 'BasicScheduler')![1].inputs).toMatchObject({ scheduler: 'simple', steps: 8, denoise: 1 })
    expect(nodeOf(wf, 'KSamplerSelect')![1].inputs.sampler_name).toBe('res_multistep')
  })

  it('leaves the H3 turbo LoRA out (FastH3 is already distilled) and keeps every other LoRA with its own strength', async () => {
    const TURBO = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
    const wf = await buildDynamicWorkflow(run(FAST, { lora: [TURBO, 'style.safetensors'], loraStrength: [1, 0.6] }), 'minimaxh3')
    const loras = Object.values(wf as Record<string, { class_type: string; inputs: Record<string, unknown> }>)
      .filter((nd) => nd.class_type === 'LoraLoaderModelOnly')
    expect(loras.map((nd) => [nd.inputs.lora_name, nd.inputs.strength_model])).toEqual([['style.safetensors', 0.6]])
    // On the base H3 the same stack keeps both.
    const base = await buildDynamicWorkflow(run(BASE, { lora: [TURBO, 'style.safetensors'], loraStrength: [1, 0.6] }), 'minimaxh3')
    expect(Object.values(base as Record<string, { class_type: string }>).filter((nd) => nd.class_type === 'LoraLoaderModelOnly').length).toBe(2)
  })

  it('keeps the H3 wiring: encode node, joint latent, both decoders, sound muxed', async () => {
    const wf = await buildDynamicWorkflow(run(FAST), 'minimaxh3')
    const [encId, enc] = nodeOf(wf, 'MiniMaxH3ImageToVideo')!
    expect(enc.inputs).toMatchObject({ width: 1344, height: 768, length: 124 })
    expect(enc.inputs.first_frame).toBeUndefined()
    expect(nodeOf(wf, 'SamplerCustomAdvanced')![1].inputs.latent_image).toEqual([encId, 1])
    expect(nodeOf(wf, 'CreateVideo')![1].inputs.audio).toEqual([nodeOf(wf, 'VAEDecodeAudio')![0], 0])
  })

  it('the base H3 graph is untouched: no shift, no sparse attention, the slider counts', async () => {
    const wf = await buildDynamicWorkflow(run(BASE), 'minimaxh3')
    expect(nodeOf(wf, 'MiniMaxH3SigmaShift')).toBeUndefined()
    expect(nodeOf(wf, 'BlockSparseAttention')).toBeUndefined()
    expect(nodeOf(wf, 'BasicScheduler')![1].inputs.steps).toBe(20)
    expect(nodeOf(wf, 'BasicGuider')![1].inputs.model).toEqual([nodeOf(wf, 'UNETLoader')![0], 0])
  })

  it('a start image is refused with a sentence, FastH3 was not distilled for it', async () => {
    const err = await buildDynamicWorkflow(run(FAST, { inputImage: 'still.png' }), 'minimaxh3').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(String(err.message)).toMatch(/prompt only/)
  })
})

describe('the version lock is per model', () => {
  it('without BlockSparseAttention (older than 0.35.0) FastH3 gets its update sentence', async () => {
    const old = { ...NODES }
    delete old.BlockSparseAttention
    vi.mocked(getAllNodeInfo).mockResolvedValue(old as never)
    expect(FASTH3_NEEDS_UPDATE).toBe('FastH3 needs ComfyUI 0.35.0 or newer. Update ComfyUI in Settings.')
    const err = await buildDynamicWorkflow(run(FAST), 'minimaxh3').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toBe(FASTH3_NEEDS_UPDATE)
    expect(err.needsComfyUpdate).toBe(true)
  })

  it('and the same install still runs the base MiniMax H3', async () => {
    const old = { ...NODES }
    delete old.BlockSparseAttention
    vi.mocked(getAllNodeInfo).mockResolvedValue(old as never)
    const wf = await buildDynamicWorkflow(run(BASE), 'minimaxh3')
    expect(nodeOf(wf, 'MiniMaxH3ImageToVideo')).toBeDefined()
  })
})
