/**
 * C75 (Discord feature-requests, 11.11.2026): a Qwen-Image 2.1 edit could
 * only come out in the shape of its source. With "Custom size" it comes out
 * in the shape of the size fields. The default stays.
 *
 * 3.1.3 (Discord bug-reports, 19.11.2026): "Custom size" cropped the source
 * to that shape from its centre before the encode node. A full-length
 * picture in a square lost its head, and the red frame drawn around the
 * face with it, so the model invented a new face, hair and clothes. Now the
 * whole source is the reference and the canvas latent has the fields' size.
 *
 * Run: npx vitest run src/api/__tests__/qwen-edit-shape-c75.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  it('"Custom size": the whole source is the reference, the canvas latent has the fields\' size', async () => {
    const wf = await buildDynamicWorkflow(edit({ editShape: 'canvas' }) as never)
    const [loadId] = nodeOf(wf, 'LoadImage')!
    // Nothing is cropped off the picture any more.
    expect(nodeOf(wf, 'ImageScale')).toBeUndefined()
    const [, enc] = nodeOf(wf, 'TextEncodeQwenImage21')!
    expect(enc.inputs['images.image_1']).toEqual([loadId, 0])
    // The pixel budget of the fields, as before.
    expect(enc.inputs.resolution).toBe(1248)
    // The canvas: an empty latent at exactly the fields' size, not the node's.
    const [latentId, latent] = nodeOf(wf, 'EmptyLatentImage')!
    expect(latent.inputs).toMatchObject({ width: 1664, height: 928, batch_size: 1 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.latent_image).toEqual([latentId, 0])
  })

  it('THE REPORT: a full-length picture in a square keeps its head in the reference', async () => {
    // The user's case: a tall full-length photo with a red frame around the
    // face, "close up" in 1024 x 1024. A centre crop to a square removed the
    // top and the bottom of the picture; now no node cuts anything.
    const wf = await buildDynamicWorkflow(edit({ editShape: 'canvas', width: 1024, height: 1024, prompt: 'a close-up of the face in the red frame' }) as never)
    const cropping = Object.values(wf).filter((node) => node.class_type === 'ImageScale' || node.class_type === 'ImageCrop')
    expect(cropping).toEqual([])
    expect(nodeOf(wf, 'EmptyLatentImage')![1].inputs).toMatchObject({ width: 1024, height: 1024 })
  })

  it('"Like the picture" is what it was: the latent comes from the node', async () => {
    const wf = await buildDynamicWorkflow(edit() as never)
    const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
    expect(nodeOf(wf, 'KSampler')![1].inputs.latent_image).toEqual([encId, 2])
    expect(nodeOf(wf, 'EmptyLatentImage')).toBeUndefined()
  })

  it('references go in as they are', async () => {
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

describe('the Mac does the same (useCreate, second engine)', () => {
  const src = readFileSync(join(process.cwd(), 'src/hooks/useCreate.ts'), 'utf8')
  it('cuts the picture to the shape only for a masked edit, and hands the engine the canvas', () => {
    expect(src).toMatch(/const macShapeCrop = macShape && !!mask\?\.url/)
    // Every cover crop of the source and the mask hangs on the masked case.
    const calls = [...src.matchAll(/await coverCropBlob\(/g)].map((m) => m.index!)
    expect(calls.length).toBe(2)
    for (const at of calls) expect(src.slice(at - 80, at)).toContain('macShapeCrop')
    // "Custom size" names the canvas even with one image, not only with several.
    expect(src).toMatch(/const editSize = mlxEdit && source && \(editRefs\.length > 1 \|\| macShape\)/)
  })
})
