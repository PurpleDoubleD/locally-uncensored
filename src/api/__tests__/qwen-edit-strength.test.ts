/**
 * B46 / D8 (Discord #bug-reports 30.10.2026, help chat 06.11.2026 on 3.0.10):
 * the Edit strength of a Qwen edit through ComfyUI.
 *
 * Up to 3.0.7 the slider set `denoise`, which the graph never read. 3.0.9
 * started the sampler from the source at denoise = strength: the box run of
 * 01.11. came back as the source at 0.40 and 0.10, only 1.00 edited, because
 * these edit models copy their reference unless they start from pure noise.
 * Now the edit always runs as the template runs it, and below 1 the result is
 * mixed with the source in that share (ImageBlend after the decode).
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
    'RandomNoise', 'KSamplerSelect', 'CFGGuider', 'ManualSigmas', 'SamplerCustomAdvanced', 'ImageBlend'])
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

/** The edit as the template runs it: denoise 1.0, nothing between the
 *  decode and SaveImage. */
function expectTemplateEdit(wf: ComfyApiGraph) {
  const [, save] = nodeOf(wf, 'SaveImage')!
  expect(classAt(wf, save.inputs.images)).toBe('VAEDecode')
  expect(classTypes(wf)).not.toContain('ImageBlend')
}

/** The ImageBlend in front of SaveImage: the decoded edit as image1, the
 *  source as image2, at 1 - strength. */
function blendOf(wf: ComfyApiGraph) {
  const [, save] = nodeOf(wf, 'SaveImage')!
  expect(classAt(wf, save.inputs.images)).toBe('ImageBlend')
  const blend = nodeAt(wf, String((save.inputs.images as [string, number])[0]))!
  expect(classAt(wf, blend.inputs.image1)).toBe('VAEDecode')
  expect(blend.inputs.blend_mode).toBe('normal')
  return blend
}

describe('Qwen-Image 2.1 edit: the Edit strength reaches the picture', () => {
  it('0.4: the edit runs at denoise 1.0 from the encoder latent, then 40 % of it over 60 % of the source', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.4 })
    const [encId, enc] = nodeOf(wf, 'TextEncodeQwenImage21')!
    const [, sampler] = nodeOf(wf, 'KSampler')!
    // The run that edits, unchanged: the 3.0.9 start from the source at
    // denoise 0.4 is what gave the source back.
    expect(sampler.inputs.denoise).toBe(1)
    expect(sampler.inputs.latent_image).toEqual([encId, 2])
    expect(classTypes(wf)).not.toContain('VAEEncode')
    const blend = blendOf(wf)
    expect(blend.inputs.blend_factor).toBe(0.6)
    // image2 is the source the encoder reads as image_1.
    expect(blend.inputs.image2).toEqual(enc.inputs['images.image_1'])
    expect(nodeAt(wf, String((blend.inputs.image2 as [string, number])[0]))!.inputs.image).toBe('jacket.png')
  })

  it('every step of the slider gives its own share: 0.05 to 0.95', async () => {
    for (const s of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: s })
      expect(blendOf(wf).inputs.blend_factor).toBeCloseTo(1 - s, 6)
      expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(1)
    }
  })

  it('with references the source is still image_1, not a reference', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.5, referenceImages: ['ref2.png', 'ref3.png'] })
    const blend = blendOf(wf)
    expect(nodeAt(wf, String((blend.inputs.image2 as [string, number])[0]))!.inputs.image).toBe('jacket.png')
  })

  it('COUNTER-CHECK: 1 or unset is the graph of today, denoise 1.0 on the encoder latent, no blend', async () => {
    for (const extra of [{}, { editStrength: 1 }]) {
      const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', extra)
      const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
      const [, sampler] = nodeOf(wf, 'KSampler')!
      expect(sampler.inputs.denoise).toBe(1)
      expect(sampler.inputs.latent_image).toEqual([encId, 2])
      expectTemplateEdit(wf)
    }
  })

  it('COUNTER-CHECK: the img2img denoise alone changes nothing on a Qwen edit', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { denoise: 0.3 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(1)
    expectTemplateEdit(wf)
  })

  it('below 0.05 it holds at 0.05', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.01 })
    expect(blendOf(wf).inputs.blend_factor).toBe(0.95)
  })

  it('a ComfyUI without ImageBlend says so instead of failing in the run', async () => {
    const err = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.4 }, ['ImageBlend']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(String((err as Error).message)).toMatch(/Edit strength below 1 needs a newer ComfyUI/)
  })

  it('Turbo: its whole schedule as at 1, then the same blend', async () => {
    const wf = await build(TURBO, 'qwenimage', { editStrength: 0.5 })
    const [samplerId, custom] = nodeOf(wf, 'SamplerCustomAdvanced')!
    expect(classAt(wf, custom.inputs.sigmas)).toBe('ManualSigmas')
    expect(classTypes(wf)).not.toContain('SplitSigmasDenoise')
    expect(classAt(wf, custom.inputs.latent_image)).toBe('TextEncodeQwenImage21')
    const blend = blendOf(wf)
    expect(blend.inputs.blend_factor).toBe(0.5)
    const decode = nodeAt(wf, String((blend.inputs.image1 as [string, number])[0]))!
    expect(decode.inputs.samples).toEqual([samplerId, 0])
  })

  it('COUNTER-CHECK Turbo at 1: the template chain as before', async () => {
    const wf = await build(TURBO, 'qwenimage', { editStrength: 1 })
    expect(classAt(wf, nodeOf(wf, 'SamplerCustomAdvanced')![1].inputs.sigmas)).toBe('ManualSigmas')
    expectTemplateEdit(wf)
  })
})

describe('Qwen-Image-Edit 2509/2511: the same field, the same blend', () => {
  it('0.4: the template edit at denoise 1.0, then mixed with the scaled source it edited', async () => {
    const wf = await build(EDIT_PLUS, 'qwenimage1', { editStrength: 0.4 })
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs.denoise).toBe(1)
    expect(classAt(wf, sampler.inputs.latent_image)).toBe('VAEEncode')
    const blend = blendOf(wf)
    expect(blend.inputs.blend_factor).toBe(0.6)
    // The source the latent was encoded from (FluxKontextImageScale), so
    // both images have the same size.
    const [, enc] = nodeOf(wf, 'VAEEncode')!
    expect(blend.inputs.image2).toEqual(enc.inputs.pixels)
    expect(classAt(wf, blend.inputs.image2)).toBe('FluxKontextImageScale')
  })

  it('COUNTER-CHECK: unset stays at 1.0, the template', async () => {
    const wf = await build(EDIT_PLUS, 'qwenimage1')
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(1)
    expectTemplateEdit(wf)
  })
})

describe('every other edit ignores it', () => {
  it('SDXL keeps the img2img denoise and no blend', async () => {
    const wf = await build(SDXL, 'sdxl', { editStrength: 0.2 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.denoise).toBe(0.7)
    expectTemplateEdit(wf)
  })
})
