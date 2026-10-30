/**
 * B38 (Discord 29.10.2026 .molot, 30.10.2026 thirdorbital): Animate took one
 * picture. Asked for: several references where the model takes them, and a
 * start AND an end image (FL2V). Read off ComfyUI master b5a43215 and the
 * Comfy-Org templates video_wan2_2_14B_flf2v, wan2.1_flf2v_720_f16,
 * video_minimax_h3_i2v and video_minimax_h3_r2v:
 *   - Wan 2.2 A14B i2v and the Wan 2.1 FLF2V file: WanFirstLastFrameToVideo
 *     with start_image and end_image.
 *   - MiniMax H3 fl2va: MiniMaxH3ImageToVideo last_frame.
 *   - MiniMax H3 ref2va: ref_image_0 to ref_image_8, prompted <Picture N>.
 * A model that cannot take them refuses with the models that can, instead of
 * dropping the picture.
 *
 * Run: npx vitest run src/api/__tests__/animate-takes-an-end-image-and-references.test.ts
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
import { classTypes, nodeAt, nodeOf } from './graph-test-support'
import { localAnimateReferenceSlots, localEndFrame } from '../../lib/frame-refs'
import { isI2VModel, isT2VCapable } from '../comfyui'
import { studioReadsEndImage } from '../../lib/render/create-studio'

const A14B_HIGH = 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors'
const A14B_LOW = 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors'
const FLF2V = 'wan2.1_flf2v_720p_14B_fp16.safetensors'
const WAN21_I2V = 'wan2.1_i2v_480p_14B_fp16.safetensors'
const TI2V = 'wan2.2_ti2v_5B_fp16.safetensors'
const FL2VA = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
const REF2VA = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'
const H3_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const H3_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'
const H3_AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'

const wanCond = (optional: Record<string, unknown>) => ({
  input: {
    required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] },
    optional,
  },
  output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
})

const NODES = {
  UNETLoader: { input: { required: { unet_name: [[A14B_HIGH, A14B_LOW, FLF2V, WAN21_I2V, TI2V, FL2VA, REF2VA]] } } },
  CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors', H3_ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors', 'wan2.2_vae.safetensors', H3_VAE, H3_AUDIO_VAE]] } } },
  WanImageToVideo: wanCond({ start_image: ['IMAGE'] }),
  // The schema of comfy_extras/nodes_wan.py, master b5a43215.
  WanFirstLastFrameToVideo: wanCond({ clip_vision_start_image: ['CLIP_VISION_OUTPUT'], clip_vision_end_image: ['CLIP_VISION_OUTPUT'], start_image: ['IMAGE'], end_image: ['IMAGE'] }),
  Wan22ImageToVideoLatent: { input: { required: { vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] }, optional: { start_image: ['IMAGE', {}] } } },
  EmptyHunyuanLatentVideo: { input: { required: {} } },
  ModelSamplingSD3: { input: { required: { model: ['MODEL'], shift: ['FLOAT'] } } },
  KSampler: { input: { required: {} } },
  KSamplerAdvanced: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  VHS_VideoCombine: { input: { required: {} } },
  SaveAnimatedWEBP: { input: { required: {} } },
  LoraLoaderModelOnly: { input: { required: {} } },
  MiniMaxH3ImageToVideo: { input: { required: {} } },
  MiniMaxH3ReferenceToVideo: { input: { required: {} } },
  BasicGuider: { input: { required: {} } },
  BasicScheduler: { input: { required: {} } },
  KSamplerSelect: { input: { required: {} } },
  RandomNoise: { input: { required: {} } },
  SamplerCustomAdvanced: { input: { required: {} } },
  VAEDecodeAudio: { input: { required: {} } },
  CreateVideo: { input: { required: {} } },
  SaveVideo: { input: { required: {} } },
}

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(NODES as never)
  vi.mocked(localFetch).mockImplementation((async () => ({
    ok: true, status: 200, json: async () => NODES, text: async () => JSON.stringify(NODES),
  })) as never)
})

const animate = (model: string, extra: Record<string, unknown> = {}) => ({
  model, prompt: 'the girl from image 1 turns, image 2 waves', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple', steps: 20, cfgScale: 5, width: 832, height: 480,
  seed: 42, batchSize: 1, frames: 81, fps: 16, inputImage: 'start.png', ...extra,
}) as never

const loadedImage = (wf: Parameters<typeof nodeAt>[0], ref: unknown) => {
  const [id] = ref as [string, number]
  const node = nodeAt(wf, id)!
  if (node.class_type === 'ImageScale') return nodeAt(wf, (node.inputs.image as [string, number])[0])!.inputs.image
  return node.inputs.image
}

describe('which local models take an end image', () => {
  it('the models whose official template runs first and last frame', () => {
    for (const m of [A14B_HIGH, A14B_LOW, FLF2V, FL2VA]) expect(localEndFrame(m), m).toBe(true)
  })
  it('the ones that start from one image only', () => {
    for (const m of [WAN21_I2V, TI2V, REF2VA, 'fastvideo_fasth3_8step_v2_pruned_bf16.safetensors', 'ltx-2.5-22b-distilled.safetensors', 'svd_xt.safetensors', 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors']) {
      expect(localEndFrame(m), m).toBe(false)
    }
  })
  it('the Wan 2.1 FLF2V file is an Animate model, not a text to video one', () => {
    expect(isI2VModel(FLF2V)).toBe(true)
    expect(isT2VCapable(FLF2V)).toBe(false)
  })
  it('LU Cloud: the Studio models with a last_image input', () => {
    for (const m of ['wan-3.0', 'seedance-2.5', 'ltx-2.5-i2v', 'minimax-h3']) expect(studioReadsEndImage(m), m).toBe(true)
    for (const m of ['wan-3.0-ref', 'minimax-h3-ref', 'open-video']) expect(studioReadsEndImage(m), m).toBe(false)
  })
  it('references: MiniMax H3 ref2va reads eight more, nothing else locally', () => {
    expect(localAnimateReferenceSlots(REF2VA)).toBe(8)
    for (const m of [FL2VA, A14B_HIGH, 'wan2.1_vace_14B_fp16.safetensors']) expect(localAnimateReferenceSlots(m), m).toBe(0)
  })
})

describe('Wan: start and end image go through WanFirstLastFrameToVideo', () => {
  it('A14B i2v pair: both images reach the node, both halves sample on it', async () => {
    const wf = await buildDynamicWorkflow(animate(A14B_HIGH, { endImage: 'end.png' }))
    expect(classTypes(wf)).not.toContain('WanImageToVideo')
    const [flfId, flf] = nodeOf(wf, 'WanFirstLastFrameToVideo')!
    expect(loadedImage(wf, flf.inputs.start_image)).toBe('start.png')
    expect(loadedImage(wf, flf.inputs.end_image)).toBe('end.png')
    expect(flf.inputs.length).toBe(81)
    const samplers = Object.values(wf).filter((n) => n.class_type === 'KSamplerAdvanced')
    expect(samplers).toHaveLength(2)
    for (const s of samplers) {
      expect((s.inputs!.positive as [string, number])[0]).toBe(flfId)
    }
  })
  it('the Wan 2.1 FLF2V file', async () => {
    const wf = await buildDynamicWorkflow(animate(FLF2V, { endImage: 'end.png' }))
    expect(loadedImage(wf, nodeOf(wf, 'WanFirstLastFrameToVideo')![1].inputs.end_image)).toBe('end.png')
  })
  it('without an end image nothing changes (regression guard)', async () => {
    const wf = await buildDynamicWorkflow(animate(A14B_HIGH))
    expect(classTypes(wf)).toContain('WanImageToVideo')
    expect(classTypes(wf)).not.toContain('WanFirstLastFrameToVideo')
  })
  it('a model that cannot take it says so and names the ones that can', async () => {
    for (const m of [WAN21_I2V, TI2V]) {
      const err = await buildDynamicWorkflow(animate(m, { endImage: 'end.png' })).catch((e) => e)
      expect(err, m).toBeInstanceOf(WorkflowUnavailableError)
      expect(err.message).toMatch(/cannot also take an end image/)
      expect(err.message).toMatch(/Wan 2\.2 14B i2v/)
    }
  })
})

describe('MiniMax H3', () => {
  it('fl2va ends on the end image (last_frame)', async () => {
    const wf = await buildDynamicWorkflow(animate(FL2VA, { endImage: 'end.png', width: 1344, height: 768, frames: 124, fps: 24 }))
    const enc = nodeOf(wf, 'MiniMaxH3ImageToVideo')![1]
    expect(loadedImage(wf, enc.inputs.first_frame)).toBe('start.png')
    expect(loadedImage(wf, enc.inputs.last_frame)).toBe('end.png')
  })
  it('ref2va takes up to nine pictures and the prompt names them <Picture N>', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => `ref${i + 2}.png`)
    const wf = await buildDynamicWorkflow(animate(REF2VA, { referenceImages: refs, width: 1344, height: 768, frames: 124, fps: 24 }))
    const enc = nodeOf(wf, 'MiniMaxH3ReferenceToVideo')![1]
    expect(loadedImage(wf, enc.inputs['ref_images.ref_image_0'])).toBe('start.png')
    for (let i = 1; i <= 8; i++) expect(loadedImage(wf, enc.inputs[`ref_images.ref_image_${i}`])).toBe(`ref${i + 1}.png`)
    expect(enc.inputs['ref_images.ref_image_9']).toBeUndefined()
    expect(enc.inputs.prompt).toBe('the girl from <Picture 1> turns, <Picture 2> waves')
  })
})

describe('references on a model that reads one picture', () => {
  it('refuse instead of animating the first one alone', async () => {
    const err = await buildDynamicWorkflow(animate(A14B_HIGH, { referenceImages: ['ref2.png'] })).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toMatch(/MiniMax H3 Reference/)
  })
})
