/**
 * B46 (Discord #bug-reports 30.10.2026, boromirofgeo; back in 3.0.9 on
 * David's word 01.11.): the Edit strength of a Qwen edit through ComfyUI.
 *
 * Up to 3.0.7 the slider showed on a Qwen-Image 2.1 edit, but it set
 * `denoise`, and the graph sampled at 1.0 from the empty latent of
 * TextEncodeQwenImage21 whatever it said; 3.0.8 took it out as dead. Now it
 * is the Edit strength (`editStrength`, 1 = as before): below 1 the sampler
 * starts from the source, scaled to exactly the latent the encoder hands
 * over, at that denoise. Qwen-Image-Edit 2509/2511 already samples from the
 * encoded source and only needs the denoise.
 *
 * Run: npx vitest run src/api/__tests__/qwen-edit-strength.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (o) => ({ ...(await o<typeof import('../comfyui-nodes')>()), getAllNodeInfo: vi.fn() }))
vi.mock('../comfyui', async (o) => ({
  ...(await o<typeof import('../comfyui')>()),
  findMatchingCLIP: vi.fn(async () => 'qwen_2.5_vl_7b_fp8_scaled.safetensors'),
  findMatchingVAE: vi.fn(async () => 'qwen_image_vae.safetensors'),
  getSystemVRAM: vi.fn(async () => null),
}))
vi.mock('../backend', async (o) => ({
  ...(await o<typeof import('../backend')>()),
  isMacOS: vi.fn(() => false),
  localFetch: vi.fn(),
  comfyuiUrl: (p: string) => `http://test${p}`,
}))

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { localFetch } from '../backend'
import { nodeOf, nodeAt, classTypes } from './graph-test-support'
import { QWEN21_OFFICIAL_MODEL } from './qwen21-weights'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const EDIT_PLUS = 'qwen_image_edit_2509_fp8_e4m3fn.safetensors'
const TURBO = 'qwen_image_2.1_turbo_int8_convrot.safetensors'
const SDXL = 'sdxl.safetensors'
const ENCODER = 'qwen3vl_8b_int8_convrot.safetensors'
const VAE_FILE = 'qwen_image_2.1_vae_bf16.safetensors'

function nodes(without: string[] = []): Record<string, unknown> {
  const n: Record<string, unknown> = {}
  for (const k of ['CLIPTextEncode', 'KSampler', 'EmptyLatentImage', 'EmptySD3LatentImage', 'LoadImage', 'VAEEncode', 'VAEDecode',
    'SaveImage', 'ModelSamplingAuraFlow', 'TextEncodeQwenImageEditPlus', 'CFGNorm', 'FluxKontextImageScale', 'ImageScaleToTotalPixels',
    'RandomNoise', 'KSamplerSelect', 'CFGGuider', 'ManualSigmas', 'SamplerCustomAdvanced', 'SplitSigmasDenoise'])
    n[k] = { input: { required: {} } }
  n.UNETLoader = { input: { required: { unet_name: [[EDIT_PLUS, QWEN21_OFFICIAL_MODEL, TURBO]] } } }
  n.CheckpointLoaderSimple = { input: { required: { ckpt_name: [[SDXL]] } } }
  n.CLIPLoader = { input: { required: { clip_name: [[ENCODER, 'qwen_2.5_vl_7b_fp8_scaled.safetensors']], type: [['qwen_image', 'stable_diffusion']] } } }
  n.VAELoader = { input: { required: { vae_name: [[VAE_FILE, 'qwen_image_vae.safetensors']] } } }
  n.TextEncodeQwenImage21 = { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'], 'images.image_1': ['IMAGE'] } } }
  for (const k of without) delete n[k]
  return n
}

const edit = (model: string, extra: Record<string, unknown> = {}) => ({
  model, prompt: 'make the jacket red', negativePrompt: '', sampler: 'euler', scheduler: 'simple',
  width: 1328, height: 1328, steps: 20, cfgScale: 4, seed: 7, batchSize: 1,
  // The img2img denoise rides along on every edit (0.7 is its default);
  // a Qwen edit must not read it.
  inputImage: 'jacket.png', denoise: 0.7, ...extra,
}) as never

async function build(model: string, type: string, extra: Record<string, unknown> = {}, without: string[] = []): Promise<ComfyApiGraph> {
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes(without) as never)
  return buildDynamicWorkflow(edit(model, extra), type as never)
}

const classAt = (wf: ComfyApiGraph, ref: unknown) => nodeAt(wf, String((ref as [string, number])[0]))?.class_type

beforeEach(() => {
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
      VAELoader: { input: { required: { vae_name: [[VAE_FILE]] } } },
    }),
  } as never)
})

describe('Qwen-Image 2.1 edit: the Edit strength reaches the graph', () => {
  it('0.4: the KSampler runs at denoise 0.4 from the encoded source, not the empty latent', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.4 })
    const [encId, enc] = nodeOf(wf, 'TextEncodeQwenImage21')!
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs.denoise).toBe(0.4)
    expect(sampler.inputs.latent_image).not.toEqual([encId, 2])
    expect(classAt(wf, sampler.inputs.latent_image)).toBe('VAEEncode')
    const [, vaeEnc] = nodeOf(wf, 'VAEEncode')!
    expect(vaeEnc.inputs.vae).toEqual(enc.inputs.vae)
    // The source the encoder reads as image_1, scaled the way the encoder
    // scales it: side² pixels, multiples of 32, lanczos.
    const [scaleId, scale] = nodeOf(wf, 'ImageScaleToTotalPixels')!
    expect(vaeEnc.inputs.pixels).toEqual([scaleId, 0])
    expect(scale.inputs.image).toEqual(enc.inputs['images.image_1'])
    expect(nodeAt(wf, String((scale.inputs.image as [string, number])[0]))!.inputs.image).toBe('jacket.png')
    expect(scale.inputs.resolution_steps).toBe(32)
    expect(scale.inputs.upscale_method).toBe('lanczos')
    const side = enc.inputs.resolution as number
    expect(side).toBe(1344) // 1328 on the grid of 32 (qwenEditResolution)
    expect((scale.inputs.megapixels as number) * 1024 * 1024).toBeCloseTo(side * side, 6)
  })

  it('the shared side of many images is the side the source is scaled to', async () => {
    const refs = Array.from({ length: 6 }, (_, i) => `ref${i + 2}.png`)
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.5, referenceImages: refs })
    const side = nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs.resolution as number
    expect(side).toBeLessThan(1328)
    expect((nodeOf(wf, 'ImageScaleToTotalPixels')![1].inputs.megapixels as number) * 1024 * 1024).toBeCloseTo(side * side, 6)
  })

  it('COUNTER-CHECK: 1 or unset is the graph of today, denoise 1.0 on the encoder latent', async () => {
    for (const extra of [{}, { editStrength: 1 }]) {
      const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', extra)
      const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
      const [, sampler] = nodeOf(wf, 'KSampler')!
      expect(sampler.inputs.denoise).toBe(1)
      expect(sampler.inputs.latent_image).toEqual([encId, 2])
      expect(classTypes(wf)).not.toContain('VAEEncode')
      expect(classTypes(wf)).not.toContain('ImageScaleToTotalPixels')
    }
  })

  it('COUNTER-CHECK: the img2img denoise alone changes nothing on a Qwen edit', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { denoise: 0.3 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(1)
  })

  it('below 0.05 it holds at 0.05', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.01 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(0.05)
  })

  it('a ComfyUI without ImageScaleToTotalPixels says so instead of failing in the run', async () => {
    const err = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.4 }, ['ImageScaleToTotalPixels']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(String((err as Error).message)).toMatch(/Edit strength below 1 needs a newer ComfyUI/)
  })

  it('Turbo: its own sigmas, cut to the strength by SplitSigmasDenoise (low sigmas)', async () => {
    const wf = await build(TURBO, 'qwenimage', { editStrength: 0.5 })
    const [, custom] = nodeOf(wf, 'SamplerCustomAdvanced')!
    const [splitId, split] = nodeOf(wf, 'SplitSigmasDenoise')!
    expect(custom.inputs.sigmas).toEqual([splitId, 1])
    expect(split.inputs.denoise).toBe(0.5)
    expect(classAt(wf, split.inputs.sigmas)).toBe('ManualSigmas')
    expect(classAt(wf, custom.inputs.latent_image)).toBe('VAEEncode')
  })

  it('COUNTER-CHECK Turbo at 1: the template chain as before', async () => {
    const wf = await build(TURBO, 'qwenimage', { editStrength: 1 })
    expect(classTypes(wf)).not.toContain('SplitSigmasDenoise')
    expect(classAt(wf, nodeOf(wf, 'SamplerCustomAdvanced')![1].inputs.sigmas)).toBe('ManualSigmas')
  })
})

describe('Qwen-Image-Edit 2509/2511: the same field', () => {
  it('0.4 is the denoise of its KSampler, still on the encoded source', async () => {
    const wf = await build(EDIT_PLUS, 'qwenimage1', { editStrength: 0.4 })
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs.denoise).toBe(0.4)
    expect(classAt(wf, sampler.inputs.latent_image)).toBe('VAEEncode')
  })

  it('COUNTER-CHECK: unset stays at 1.0, the template', async () => {
    const wf = await build(EDIT_PLUS, 'qwenimage1')
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(1)
  })
})

describe('every other edit ignores it', () => {
  it('SDXL keeps the img2img denoise', async () => {
    const wf = await build(SDXL, 'sdxl', { editStrength: 0.2 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(0.7)
  })
})
