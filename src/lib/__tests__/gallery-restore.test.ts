// @vitest-environment jsdom
/**
 * "Restore from the output folder" (C27, 3.1.0): the prompt and settings come
 * back out of the text ComfyUI and A1111-style tools store in a PNG, and a
 * second run adds nothing.
 *
 * Run: npx vitest run src/lib/__tests__/gallery-restore.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { entryFromScan, madeWithFromComfyGraph, madeWithFromParameters, restoreFromOutputFolder, restoredId, type ScannedFile } from '../gallery-restore'
import { useCreateStore, type GalleryItem } from '../../stores/createStore'

/** The graph shape of LU's own SDXL run (dynamic workflow, KSampler). */
const KSAMPLER_GRAPH = JSON.stringify({
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'juggernautXL_v9.safetensors' } },
  '10': { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors', strength_model: 0.8, strength_clip: 0.8, model: ['4', 0], clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a red fox in snow', clip: ['10', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['10', 1] } },
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 30, cfg: 6.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['10', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'LU', images: ['8', 0] } },
})

/** The Flux shape: custom sampler, guidance node, prompt from a text primitive. */
const CUSTOM_GRAPH = JSON.stringify({
  '12': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev-fp8.safetensors', weight_dtype: 'default' } },
  '40': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'portrait, soft light' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: ['40', 0], clip: ['11', 0] } },
  '26': { class_type: 'FluxGuidance', inputs: { guidance: 3.5, conditioning: ['6', 0] } },
  '22': { class_type: 'BasicGuider', inputs: { model: ['12', 0], conditioning: ['26', 0] } },
  '25': { class_type: 'RandomNoise', inputs: { noise_seed: 7 } },
  '16': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
  '17': { class_type: 'BasicScheduler', inputs: { scheduler: 'simple', steps: 20, denoise: 1, model: ['12', 0] } },
  '27': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '13': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['25', 0], guider: ['22', 0], sampler: ['16', 0], sigmas: ['17', 0], latent_image: ['27', 0] } },
})

const file = (extra: Partial<ScannedFile> = {}): ScannedFile => ({
  filename: 'LU_00001_.png', subfolder: '', kind: 'image', modifiedMs: 1_700_000_000_000, bytes: 1000, width: 512, height: 768, ...extra,
})

describe('the graph ComfyUI stored', () => {
  it('KSampler: prompt, negative, settings, model, size and LoRA', () => {
    expect(madeWithFromComfyGraph(KSAMPLER_GRAPH)).toEqual({
      prompt: 'a red fox in snow', negativePrompt: 'blurry', seed: 42, steps: 30, cfgScale: 6.5,
      sampler: 'dpmpp_2m', scheduler: 'karras', model: 'juggernautXL_v9.safetensors', width: 832, height: 1216,
      loras: [{ name: 'style.safetensors', strength: 0.8 }],
    })
  })

  it('custom sampler: through the guider and the guidance node to the text primitive', () => {
    expect(madeWithFromComfyGraph(CUSTOM_GRAPH)).toEqual({
      prompt: 'portrait, soft light', seed: 7, steps: 20, sampler: 'euler', scheduler: 'simple',
      model: 'flux1-dev-fp8.safetensors', width: 1024, height: 1024,
    })
  })

  it('anything else is no graph', () => {
    expect(madeWithFromComfyGraph('not json')).toBeNull()
    expect(madeWithFromComfyGraph('[1,2]')).toBeNull()
    expect(madeWithFromComfyGraph('{}')).toBeNull()
  })
})

describe('A1111 parameters', () => {
  it('prompt over several lines, negative, settings', () => {
    const text = 'a cat\non a roof\nNegative prompt: ugly, blurry\nSteps: 25, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 7, Seed: 123, Size: 512x768, Model: dreamshaper_8'
    expect(madeWithFromParameters(text)).toEqual({
      prompt: 'a cat\non a roof', negativePrompt: 'ugly, blurry', steps: 25, sampler: 'DPM++ 2M', scheduler: 'Karras',
      cfgScale: 7, seed: 123, width: 512, height: 768, model: 'dreamshaper_8',
    })
  })

  it('only a prompt', () => {
    expect(madeWithFromParameters('just words')).toEqual({ prompt: 'just words' })
  })
})

describe('entries', () => {
  it('a picture with its graph, and one that says nothing', () => {
    const made = entryFromScan(file({ prompt: KSAMPLER_GRAPH }))
    expect(made).toMatchObject({ prompt: 'a red fox in snow', model: 'juggernautXL_v9.safetensors', modelType: 'sdxl', width: 832, comfyType: 'output', createdAt: 1_700_000_000_000 })
    expect(made.label).toBeUndefined()
    const bare = entryFromScan(file({ filename: 'clip.mp4', subfolder: 'video', kind: 'video', width: null, height: null }))
    expect(bare).toMatchObject({ type: 'video', prompt: '', label: 'clip.mp4', subfolder: 'video', modelType: 'unknown' })
  })

  it('the same file is the same id, another file another', () => {
    expect(restoredId('', 'a.png')).toBe(restoredId('', 'a.png'))
    expect(restoredId('', 'a.png')).not.toBe(restoredId('x', 'a.png'))
  })
})

describe('restoreFromOutputFolder', () => {
  const listed = (n: number): GalleryItem => ({
    id: `g${n}`, type: 'image', filename: `LU_${n}.png`, subfolder: '', prompt: 'kept', negativePrompt: '', model: 'm',
    modelType: 'sdxl', seed: 1, steps: 1, cfgScale: 1, sampler: 's', scheduler: 's', width: 1, height: 1, batchSize: 1, createdAt: n,
  })
  beforeEach(() => { useCreateStore.setState({ gallery: [listed(2), listed(1)] }) })

  it('adds the files the gallery does not list, keeps the entries it has, and a second run adds nothing', async () => {
    const files = [file({ filename: 'LU_1.png' }), file({ filename: 'LU_9.png', prompt: KSAMPLER_GRAPH }), file({ filename: 'v.mp4', kind: 'video' })]
    const scan = async () => ({ reachable: true, folder: '/c/output', files, truncated: false })
    const first = await restoreFromOutputFolder(scan)
    expect(first).toMatchObject({ reachable: true, found: 3, added: 2, withPrompt: 1 })
    const g1 = useCreateStore.getState().gallery.find((g) => g.filename === 'LU_1.png')!
    expect(g1).toMatchObject({ id: 'g1', prompt: 'kept' })
    expect(useCreateStore.getState().gallery).toHaveLength(4)
    expect((await restoreFromOutputFolder(scan)).added).toBe(0)
  })

  it('says so when the folder cannot be read', async () => {
    const r = await restoreFromOutputFolder(async () => ({ reachable: false, folder: '', files: [], truncated: false }))
    expect(r).toMatchObject({ reachable: false, added: 0 })
    expect(useCreateStore.getState().gallery).toHaveLength(2)
  })
})
