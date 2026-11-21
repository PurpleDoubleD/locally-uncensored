/**
 * MiniMax H3 Image gets LU's own graph (3.1.3). Discord 17./18.11.2026
 * (.molot, thirdorbital): the official ComfyUI template, imported under
 * Workflows, ignored the batch, the size and the reference picture, and the
 * pictures had nothing to do with the prompt. The graph follows the official
 * templates image_minimax_h3_image_t2i / _edit and the node
 * MiniMaxH3ImageConditioning (ComfyUI 0.45.0), and uses what Create sets.
 *
 * Run: npx vitest run src/api/__tests__/minimax-h3-image-builtin.test.ts
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

import { buildDynamicWorkflow, h3ImageMegapixels, MINIMAX_H3_IMAGE_NEEDS_UPDATE, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { localFetch } from '../backend'
import { classTypes, nodeAt, nodeOf, nodesOf } from './graph-test-support'
import { COMPONENT_REGISTRY, MODEL_TYPE_DEFAULTS } from '../comfyui'
import { createReferenceSupport } from '../../lib/frame-refs'
import { extraReferenceSlots } from '../../lib/edit-references'
import { editHiresBase } from '../../lib/edit-hires'
import { latentDownscale } from '../hires-fix'
import { applyEditBatch } from '../edit-batch'

const MODEL = 'minimax_h3_image_pruned_w4a8.safetensors'
const ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const PE = 'qwen3.8_27b_minimax_h3_image_pe_w4a8_gptq.safetensors'
const IMAGE_VAE = 'minimax_h3_image_vae_fp16.safetensors'
const VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'

const empty = { input: { required: {} } }
const NODES = (extra: Record<string, unknown> = {}) => ({
  UNETLoader: { input: { required: { unet_name: [[MODEL]] } } },
  CLIPLoader: { input: { required: { clip_name: [[PE, ENCODER]], type: [['minimax', 'qwen_image']] } } },
  VAELoader: { input: { required: { vae_name: [[VIDEO_VAE, IMAGE_VAE]] } } },
  LoraLoader: { input: { required: { lora_name: [['h3img_detail.safetensors']] } } },
  LoraLoaderModelOnly: { input: { required: { lora_name: [['h3img_detail.safetensors']] } } },
  MiniMaxH3ImageConditioning: empty, ConditioningZeroOut: empty, KSampler: empty, VAEDecode: empty, SaveImage: empty,
  LoadImage: empty, ImageScale: { input: { required: { upscale_method: [['lanczos', 'area']] } } },
  ImageScaleToTotalPixels: empty, GetImageSize: empty, RepeatLatentBatch: empty,
  ...extra,
})
const serve = (nodes: Record<string, unknown> = NODES()) => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes as never)
  vi.mocked(localFetch).mockImplementation((async () => ({
    ok: true, status: 200, json: async () => nodes, text: async () => JSON.stringify(nodes),
  })) as never)
}
beforeEach(() => serve())

const run = (extra: Record<string, unknown> = {}) => buildDynamicWorkflow({
  model: MODEL, prompt: 'a red fox on a snowy hill, the scarf from image 2', negativePrompt: 'blurry',
  sampler: 'euler', scheduler: 'simple', steps: 6, cfgScale: 1, width: 2048, height: 2048, seed: 42, batchSize: 1,
  ...extra,
} as never)

const cond = (wf: Awaited<ReturnType<typeof run>>) => nodeOf(wf, 'MiniMaxH3ImageConditioning')!
const loaded = (wf: Awaited<ReturnType<typeof run>>, ref: unknown) => nodeAt(wf, (ref as [string, number])[0])!

describe('MiniMax H3 Image: text to image, as the official template', () => {
  it('UNET, CLIPLoader minimax with the H3 encoder, its own VAE, the conditioning node, KSampler, zeroed negative', async () => {
    const wf = await run()
    expect(nodeOf(wf, 'UNETLoader')![1].inputs.unet_name).toBe(MODEL)
    // The H3 encoder, never the prompt enhancer that also says "minimax".
    expect(nodeOf(wf, 'CLIPLoader')![1].inputs).toMatchObject({ clip_name: ENCODER, type: 'minimax' })
    // Its own autoencoder, never the H3 video one.
    expect(nodeOf(wf, 'VAELoader')![1].inputs.vae_name).toBe(IMAGE_VAE)
    const [condId, c] = cond(wf)
    expect(c.inputs).toMatchObject({ width: 2048, height: 2048, prompt: 'a red fox on a snowy hill, the scarf from image 2' })
    expect(Object.keys(c.inputs).filter((k) => k.startsWith('images.'))).toEqual([])
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs).toMatchObject({ steps: 6, cfg: 1, sampler_name: 'euler', scheduler: 'simple', seed: 42, denoise: 1 })
    expect(sampler.inputs.positive).toEqual([condId, 0])
    expect(sampler.inputs.latent_image).toEqual([condId, 1])
    expect(loaded(wf, sampler.inputs.negative).class_type).toBe('ConditioningZeroOut')
    expect(classTypes(wf)).toContain('SaveImage')
    expect(classTypes(wf)).not.toContain('EmptyLatentImage')
  })

  it('the model card defaults are what Create starts from', () => {
    expect(MODEL_TYPE_DEFAULTS.minimaxh3image).toMatchObject({ steps: 6, cfg: 1, sampler: 'euler', scheduler: 'simple', width: 2048, height: 2048 })
  })

  it('steps, CFG, sampler and scheduler from Create reach the sampler', async () => {
    const wf = await run({ steps: 12, cfgScale: 2.5, sampler: 'dpmpp_2m', scheduler: 'beta' })
    expect(nodeOf(wf, 'KSampler')![1].inputs).toMatchObject({ steps: 12, cfg: 2.5, sampler_name: 'dpmpp_2m', scheduler: 'beta' })
  })

  it('the size from Create, on the node\'s 32 px grid, in any aspect', async () => {
    expect(cond(await run({ width: 2720, height: 1536 }))[1].inputs).toMatchObject({ width: 2720, height: 1536 })
    expect(cond(await run({ width: 1500, height: 2650 }))[1].inputs).toMatchObject({ width: 1504, height: 2656 })
    expect(latentDownscale('minimaxh3image')).toBe(32)
  })

  it('pictures per run: the latent repeated, each copy its own noise', async () => {
    const one = await run({ batchSize: 1 })
    expect(classTypes(one)).not.toContain('RepeatLatentBatch')
    const four = await run({ batchSize: 4 })
    const [repeatId, repeat] = nodeOf(four, 'RepeatLatentBatch')!
    expect(repeat.inputs).toEqual({ samples: [cond(four)[0], 1], amount: 4 })
    expect(nodeOf(four, 'KSampler')![1].inputs.latent_image).toEqual([repeatId, 0])
  })

  it('LoRAs patch the model, once each (two spellings of one file: the sum)', async () => {
    const wf = await run({ lora: ['h3img_detail.safetensors', 'H3IMG_DETAIL'], loraStrength: [0.8, 0.8] })
    const loras = nodesOf(wf, 'LoraLoaderModelOnly')
    expect(loras).toHaveLength(1)
    expect(loras[0][1].inputs).toMatchObject({ lora_name: 'h3img_detail.safetensors', strength_model: 1.6 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.model).toEqual([loras[0][0], 0])
  })

  it('reference images in Create are image_1 and up, named <Picture N> in the prompt', async () => {
    expect(createReferenceSupport('minimaxh3image', MODEL)).toEqual({ slots: 4, kind: 'content' })
    const wf = await run({ referenceImages: ['fox.png', 'scarf.png', 'c.png', 'd.png', 'e.png'] })
    const c = cond(wf)[1]
    expect(['images.image_1', 'images.image_2', 'images.image_3', 'images.image_4'].map((k) => loaded(wf, c.inputs[k]).inputs.image))
      .toEqual(['fox.png', 'scarf.png', 'c.png', 'd.png'])
    expect(c.inputs['images.image_5']).toBeUndefined()
    expect(c.inputs.prompt).toBe('a red fox on a snowy hill, the scarf from <Picture 2>')
    expect(c.inputs).toMatchObject({ width: 2048, height: 2048 })
  })
})

describe('MiniMax H3 Image: edit', () => {
  it('the source is image_1 at the fields\' pixel count in its own shape, the references follow', async () => {
    expect(extraReferenceSlots('minimaxh3image', MODEL)).toBe(3)
    const wf = await run({ inputImage: 'src.png', referenceImages: ['scarf.png'], width: 2048, height: 2048 })
    const [, c] = cond(wf)
    const scaled = loaded(wf, c.inputs['images.image_1'])
    expect(scaled.class_type).toBe('ImageScaleToTotalPixels')
    expect(scaled.inputs).toMatchObject({ megapixels: 4, resolution_steps: 32 })
    expect(loaded(wf, scaled.inputs.image).inputs.image).toBe('src.png')
    const size = loaded(wf, c.inputs.width)
    expect(size.class_type).toBe('GetImageSize')
    expect(c.inputs.width).toEqual([nodeOf(wf, 'GetImageSize')![0], 0])
    expect(c.inputs.height).toEqual([nodeOf(wf, 'GetImageSize')![0], 1])
    expect(loaded(wf, c.inputs['images.image_2']).inputs.image).toBe('scarf.png')
    expect(c.inputs.prompt).toBe('a red fox on a snowy hill, the scarf from <Picture 2>')
    expect(h3ImageMegapixels(2720, 1536)).toBe(3.98)
  })

  it('"Custom size": the whole source is the reference, the canvas the fields (3.1.3, nothing cropped)', async () => {
    // Until 3.1.3 the source was cropped to the fields' shape from its
    // centre: a full-length picture in a wide canvas lost its head and the
    // frame drawn around it (the same report as on Qwen-Image 2.1).
    const wf = await run({ inputImage: 'src.png', editShape: 'canvas', width: 2720, height: 1536 })
    const [, c] = cond(wf)
    expect(c.inputs).toMatchObject({ width: 2720, height: 1536 })
    const source = loaded(wf, c.inputs['images.image_1'])
    expect(source.class_type).toBe('LoadImage')
    expect(source.inputs.image).toBe('src.png')
    for (const cut of ['ImageScale', 'ImageCrop', 'GetImageSize', 'ImageScaleToTotalPixels']) expect(classTypes(wf)).not.toContain(cut)
  })

  it('the size line in Create says what the edit comes out at', () => {
    expect(editHiresBase({ source: { width: 1600, height: 900 }, width: 2048, height: 2048, modelType: 'minimaxh3image' }))
      .toEqual({ width: 2720, height: 1536 })
  })

  it('an edit batch repeats the one latent once, not twice', async () => {
    const wf = applyEditBatch(await run({ inputImage: 'src.png', batchSize: 4 }), 4)
    expect(nodesOf(wf, 'RepeatLatentBatch')).toHaveLength(1)
  })

  it('a painted mask is refused, not dropped', async () => {
    await expect(run({ inputImage: 'src.png', maskImage: 'mask.png' })).rejects.toBeInstanceOf(WorkflowUnavailableError)
  })
})

describe('MiniMax H3 Image: what is missing is named', () => {
  it('a ComfyUI before 0.45.0 is asked to update', async () => {
    const nodes = NODES() as Record<string, unknown>
    delete nodes.MiniMaxH3ImageConditioning
    serve(nodes)
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toBe(MINIMAX_H3_IMAGE_NEEDS_UPDATE)
    expect(err.needsComfyUpdate).toBe(true)
  })

  it('without its VAE the file is named, and nothing is offered or pointed to', async () => {
    serve(NODES({ VAELoader: { input: { required: { vae_name: [[VIDEO_VAE]] } } } }))
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toContain('minimax_h3_image_vae_fp16.safetensors')
    expect(err.message).not.toMatch(/huggingface|Comfy-Org|Model Manager/i)
    expect(err.missing ?? []).toEqual([])
    expect(COMPONENT_REGISTRY.minimaxh3image.vae?.downloadUrl).toBeUndefined()
  })

  it('the prompt enhancer alone is not taken for the encoder', async () => {
    serve(NODES({ CLIPLoader: { input: { required: { clip_name: [[PE]], type: [['minimax']] } } } }))
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toContain(ENCODER)
  })
})

describe('MiniMax H3 Image: the imported official template is set aside', () => {
  // The class types of image_minimax_h3_image_t2i after LU's import (subgraph
  // unpacked), read from LU's own converter against ComfyUI 0.46.0 on 19.11.:
  // the prompt reached MiniMaxH3ImageConditioning only through the prompt
  // writer, so LU found no prompt box and every run drew the sample prompt.
  const TEMPLATE = ['SaveImage', 'ResolutionSelector', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'MiniMaxH3ImageConditioning',
    'ConditioningZeroOut', 'TextGenerateV2', 'CLIPLoader', 'PrimitiveStringMultiline', 'PreviewAny', 'KSampler',
    'PrimitiveStringMultiline', 'StringReplace', 'ComfySwitchNode', 'VAEDecode', 'PrimitiveStringMultiline', 'JsonExtractString']

  it('Create and the chat image tool run LU\'s graph, with a note that says why', async () => {
    const { ownWorkflowMisfit, ownWorkflowMisfitNote } = await import('../../lib/own-workflow-fit')
    expect(ownWorkflowMisfit(TEMPLATE, 'minimaxh3image', 'diffusion_model')).toMatch(/template/)
    expect(ownWorkflowMisfitNote('MiniMax-H3-Image: Text to Image', TEMPLATE, 'minimaxh3image', 'diffusion_model'))
      .toContain('LU runs MiniMax H3 Image with its own workflow now')
  })

  it('a plain workflow of the user\'s own for the model is still used', async () => {
    const { ownWorkflowMisfit } = await import('../../lib/own-workflow-fit')
    expect(ownWorkflowMisfit(['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'MiniMaxH3ImageConditioning', 'KSampler', 'VAEDecode', 'SaveImage'], 'minimaxh3image', 'diffusion_model')).toBeNull()
    // The same nodes on another model are none of this rule's business.
    expect(ownWorkflowMisfit(TEMPLATE, 'flux', 'diffusion_model')).toBeNull()
  })
})
