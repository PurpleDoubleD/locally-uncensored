/**
 * C75 (Discord feature-requests, 11.11.2026): a Qwen-Image 2.1 edit could
 * only come out in the shape of its source. With "Custom size" it comes out
 * in the shape of the size fields: the source is scaled to cover that shape
 * and cropped from its centre BEFORE the encode node, whose latent follows
 * the first image (any other latent size shifts the edit). The default stays.
 *
 * Run: npx vitest run src/api/__tests__/qwen-edit-shape-c75.test.ts
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
import { nodeOf } from './graph-test-support'
import { QWEN21_OFFICIAL_MODEL as MODEL } from './qwen21-weights'
import { editHiresBase } from '../../lib/edit-hires'

const ENCODER = 'qwen3vl_8b_int8_convrot.safetensors'
const VAE_FILE = 'qwen_image_2.1_vae_bf16.safetensors'
const NODES = {
  UNETLoader: { input: { required: { unet_name: [[MODEL]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VAE_FILE]] } } },
  TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'], 'images.image_1': ['IMAGE'] } } },
  ImageScale: { input: { required: { image: ['IMAGE'], upscale_method: [['nearest-exact', 'bilinear', 'area', 'bicubic', 'lanczos']], width: ['INT'], height: ['INT'], crop: [['disabled', 'center']] } } },
  EmptyLatentImage: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  SaveImage: { input: { required: {} } },
}

const edit = (extra: Record<string, unknown> = {}) => ({
  model: MODEL, prompt: 'make it a beach at sunset', negativePrompt: '', sampler: 'euler', scheduler: 'simple',
  steps: 25, cfgScale: 1, width: 1664, height: 928, seed: 42, batchSize: 1,
  inputImage: 'lu_source.png', denoise: 0.7, ...extra,
})

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(NODES as never)
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } }, VAELoader: { input: { required: { vae_name: [[VAE_FILE]] } } } }),
  } as never)
})

describe('the shape of a Qwen-Image 2.1 edit', () => {
  it('by default the source goes in as it is, and the edit keeps its shape', async () => {
    const wf = await buildDynamicWorkflow(edit() as never)
    const [loadId] = nodeOf(wf, 'LoadImage')!
    expect(nodeOf(wf, 'ImageScale')).toBeUndefined()
    expect(nodeOf(wf, 'TextEncodeQwenImage21')![1].inputs['images.image_1']).toEqual([loadId, 0])
  })

  it('"Custom size": the source is cropped to the fields\' shape before the encode, the latent still comes from the node', async () => {
    const wf = await buildDynamicWorkflow(edit({ editShape: 'canvas' }) as never)
    const [loadId] = nodeOf(wf, 'LoadImage')!
    const [scaleId, scale] = nodeOf(wf, 'ImageScale')!
    expect(scale.inputs).toEqual({ image: [loadId, 0], upscale_method: 'lanczos', width: 1664, height: 928, crop: 'center' })
    const [encId, enc] = nodeOf(wf, 'TextEncodeQwenImage21')!
    expect(enc.inputs['images.image_1']).toEqual([scaleId, 0])
    // The pixel budget of the fields, as before.
    expect(enc.inputs.resolution).toBe(1248)
    expect(nodeOf(wf, 'KSampler')![1].inputs.latent_image).toEqual([encId, 2])
    expect(nodeOf(wf, 'EmptyLatentImage')).toBeUndefined()
  })

  it('only the source is cropped, references go in as they are', async () => {
    const wf = await buildDynamicWorkflow(edit({ editShape: 'canvas', referenceImages: ['person.png'] }) as never)
    const enc = nodeOf(wf, 'TextEncodeQwenImage21')![1]
    const ref = enc.inputs['images.image_2'] as [string, number]
    expect(wf[ref[0]].class_type).toBe('LoadImage')
    expect(wf[ref[0]].inputs?.image).toBe('person.png')
  })

  it('the size the settings name follows the shape', () => {
    const source = { width: 1000, height: 1500 }
    expect(editHiresBase({ source, width: 1664, height: 928, modelType: 'qwenimage' })).toEqual({ width: 1024, height: 1536 })
    expect(editHiresBase({ source, width: 1664, height: 928, modelType: 'qwenimage', editShape: 'canvas' })).toEqual({ width: 1664, height: 928 })
  })
})
