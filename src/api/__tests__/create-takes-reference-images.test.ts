/**
 * B45 (Discord 30.10.2026, boromirofgeo): reference images in Create, text to
 * image, not Edit, for style, pose and camera angle, above all with Krea 2.
 * Each family reads them the way its official Comfy-Org template does
 * (workflow_templates abb9cf64, ComfyUI master b5a43215):
 *   - Krea 2: image_krea2_turbo_int8_image_style_reference. The Comfy-Org
 *     LoRA krea2_style_reference, ModelSamplingFlux 1.15 / 0.5,
 *     TextEncodeQwenImageEditPlus with image1 to image3,
 *     FluxKontextMultiReferenceLatentMethod index_timestep_zero, the negative
 *     the zeroed positive.
 *   - Qwen-Image 2.1: TextEncodeQwenImage21 images.image_N with the VAE, the
 *     picture from the empty latent at the canvas size.
 *   - FLUX.2: ReferenceLatent on both sides, each image a megapixel through
 *     VAEEncode (image_flux2, image_flux2_klein_image_edit_*).
 * Any other model refuses and names the ones that can.
 *
 * Run: npx vitest run src/api/__tests__/create-takes-reference-images.test.ts
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
import { createReferenceSupport, KREA2_STYLE_LORA } from '../../lib/frame-refs'
import { classifyModel } from '../comfyui'

const KREA = 'krea2_turbo_int8_convrot.safetensors'
const QWEN = 'qwen_image_2.1_int8_convrot.safetensors'
const FLUX2 = 'flux-2-klein-4b.safetensors'
const SDXL = 'juggernautXL_v9.safetensors'

const NODES = (loras: string[]) => ({
  UNETLoader: { input: { required: { unet_name: [[KREA, QWEN, FLUX2]] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [[SDXL]] } } },
  CLIPLoader: { input: { required: { clip_name: [['qwen3vl_4b_fp8_scaled.safetensors', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_3_4b.safetensors']], type: [['krea2', 'qwen_image', 'flux2', 'stable_diffusion']] } } },
  VAELoader: { input: { required: { vae_name: [['qwen_image_vae.safetensors', 'qwen_image_2.1_vae_bf16.safetensors', 'flux2-vae.safetensors']] } } },
  LoraLoaderModelOnly: { input: { required: { lora_name: [loras] } } },
  LoraLoader: { input: { required: { lora_name: [loras] } } },
  TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'] } } },
  TextEncodeQwenImageEditPlus: { input: { required: {} } },
  FluxKontextMultiReferenceLatentMethod: { input: { required: {} } },
  ModelSamplingFlux: { input: { required: {} } },
  ReferenceLatent: { input: { required: {} } },
  ImageScaleToTotalPixels: { input: { required: {} } },
  VAEEncode: { input: { required: {} } },
  EmptyLatentImage: { input: { required: {} } },
  EmptySD3LatentImage: { input: { required: {} } },
  EmptyFlux2LatentImage: { input: { required: {} } },
  ConditioningZeroOut: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
})

const serve = (loras: string[] = [KREA2_STYLE_LORA.filename]) => {
  const nodes = NODES(loras)
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes as never)
  vi.mocked(localFetch).mockImplementation((async () => ({
    ok: true, status: 200, json: async () => nodes, text: async () => JSON.stringify(nodes),
  })) as never)
}
beforeEach(() => serve())

const image = (model: string, refs: string[], extra: Record<string, unknown> = {}) => ({
  model, prompt: 'a knight in the pose of image 1, the armour of image 2', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple', steps: 8, cfgScale: 1, width: 1024, height: 1024,
  seed: 7, batchSize: 1, referenceImages: refs, ...extra,
}) as never

const loaded = (wf: Parameters<typeof nodeAt>[0], ref: unknown) => nodeAt(wf, (ref as [string, number])[0])!.inputs.image

describe('which local image models take reference images', () => {
  it('Krea 2 (style), Qwen-Image 2.1 and FLUX.2 (content)', () => {
    expect(createReferenceSupport(classifyModel(KREA), KREA)).toEqual({ slots: 3, kind: 'style' })
    expect(createReferenceSupport(classifyModel(QWEN), QWEN)).toEqual({ slots: 10, kind: 'content' })
    expect(createReferenceSupport(classifyModel(FLUX2), FLUX2)).toEqual({ slots: 4, kind: 'content' })
  })
  it('none for SDXL, SD 1.5, FLUX.1, Z-Image (IP-Adapter and Redux are not built)', () => {
    for (const m of [SDXL, 'v1-5-pruned.safetensors', 'flux1-dev-fp8.safetensors', 'z_image_turbo_bf16.safetensors']) {
      expect(createReferenceSupport(classifyModel(m), m).slots, m).toBe(0)
    }
  })
})

describe('Krea 2: the official style reference graph', () => {
  it('LoRA, sampling patch, edit encoder with the images, index_timestep_zero, zeroed negative', async () => {
    const wf = await buildDynamicWorkflow(image(KREA, ['a.png', 'b.png', 'c.png', 'd.png']))
    const [, lora] = nodesOf(wf, 'LoraLoaderModelOnly').find(([, n]) => n.inputs.lora_name === KREA2_STYLE_LORA.filename)!
    expect(lora.inputs.strength_model).toBe(1)
    const [shiftId, shift] = nodeOf(wf, 'ModelSamplingFlux')!
    expect(shift.inputs).toMatchObject({ max_shift: 1.15, base_shift: 0.5, width: 1024, height: 1024 })
    const enc = nodeOf(wf, 'TextEncodeQwenImageEditPlus')![1]
    expect([loaded(wf, enc.inputs.image1), loaded(wf, enc.inputs.image2), loaded(wf, enc.inputs.image3)]).toEqual(['a.png', 'b.png', 'c.png'])
    expect(enc.inputs.image4).toBeUndefined()
    expect(enc.inputs.vae).toBeDefined()
    expect(enc.inputs.prompt).toBe('a knight in the pose of Picture 1, the armour of Picture 2')
    const [methodId, method] = nodeOf(wf, 'FluxKontextMultiReferenceLatentMethod')!
    expect(method.inputs.reference_latents_method).toBe('index_timestep_zero')
    const sampler = nodeOf(wf, 'KSampler')![1]
    expect(sampler.inputs.model).toEqual([shiftId, 0])
    expect(sampler.inputs.positive).toEqual([methodId, 0])
    const neg = nodeAt(wf, (sampler.inputs.negative as [string, number])[0])!
    expect(neg.class_type).toBe('ConditioningZeroOut')
    expect(neg.inputs.conditioning).toEqual([methodId, 0])
  })
  it('without the LoRA Create offers it as a checked download', async () => {
    serve([])
    const err = await buildDynamicWorkflow(image(KREA, ['a.png'])).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    // The download is checked against the sha256 Hugging Face states for it.
    expect(err.missing).toEqual([expect.objectContaining({
      downloadFilename: KREA2_STYLE_LORA.filename, downloadUrl: KREA2_STYLE_LORA.url, subfolder: 'loras', sha256: KREA2_STYLE_LORA.sha256,
    })])
    expect(KREA2_STYLE_LORA.sha256).toBe('f50df5a9e62e4be8aa926a63dd5bb1a64770c4004f763c1208007ae13daa82b8')
  })
  it('without references the plain Krea 2 graph stays (regression guard)', async () => {
    const wf = await buildDynamicWorkflow(image(KREA, []))
    expect(classTypes(wf)).not.toContain('TextEncodeQwenImageEditPlus')
    expect(classTypes(wf)).not.toContain('ModelSamplingFlux')
  })
})

describe('Qwen-Image 2.1: references in the text encoder, picture from the empty latent', () => {
  it('images.image_N with the VAE, <imageN> in the prompt', async () => {
    const wf = await buildDynamicWorkflow(image(QWEN, ['a.png', 'b.png'], { cfgScale: 4, steps: 25 }))
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    expect(loaded(wf, enc.inputs['images.image_1'])).toBe('a.png')
    expect(loaded(wf, enc.inputs['images.image_2'])).toBe('b.png')
    expect(enc.inputs.vae).toBeDefined()
    expect(enc.inputs.prompt).toBe('a knight in the pose of <image1>, the armour of <image2>')
    const sampler = nodeOf(wf, 'KSampler')![1]
    expect(nodeAt(wf, (sampler.inputs.latent_image as [string, number])[0])!.class_type).toBe('EmptyLatentImage')
  })
})

describe('FLUX.2: ReferenceLatent on both sides', () => {
  it('each image scaled to a megapixel, encoded, chained', async () => {
    const wf = await buildDynamicWorkflow(image(FLUX2, ['a.png', 'b.png']))
    const refs = nodesOf(wf, 'ReferenceLatent')
    expect(refs).toHaveLength(4)
    for (const [, s] of nodesOf(wf, 'ImageScaleToTotalPixels')) expect(s.inputs.megapixels).toBe(1)
    const sampler = nodeOf(wf, 'KSampler')![1]
    const pos = nodeAt(wf, (sampler.inputs.positive as [string, number])[0])!
    const neg = nodeAt(wf, (sampler.inputs.negative as [string, number])[0])!
    expect(pos.class_type).toBe('ReferenceLatent')
    expect(neg.class_type).toBe('ReferenceLatent')
    const enc = nodeAt(wf, (pos.inputs.latent as [string, number])[0])!
    expect(enc.class_type).toBe('VAEEncode')
  })
})

describe('a model without reference images', () => {
  it('refuses and names the ones that can, instead of ignoring the images', async () => {
    const err = await buildDynamicWorkflow(image(SDXL, ['a.png'])).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toMatch(/cannot take reference images/)
    expect(err.message).toMatch(/Krea 2/)
  })
})
