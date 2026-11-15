/**
 * GH #192 (ToxesFoxes): MOSS Image (OpenMOSS, 16.10.2026) was no family LU
 * knew. Create said "LU does not recognize which model family ..." and
 * dropped the workflow the user had imported and assigned to it, because an
 * unknown model was taken for a checkpoint and the workflow loads a UNET.
 * Now MOSS Image is an image model by its name, LU's builder says it has no
 * graph for it yet, and a workflow assigned to a model LU does not know is
 * used as it is. The chat image tool goes through the same check
 * (vram-handoff.ts, since 2271a04da).
 *
 * Run: npx vitest run src/api/__tests__/moss-image-and-an-assigned-workflow-192.test.ts
 */
import { describe, it, expect } from 'vitest'
import { classifyModel, isImageModelType, isVideoModelType } from '../comfyui'
import { determineStrategy, MOSS_IMAGE_NO_BUILDER } from '../dynamic-workflow'
import { ownWorkflowMisfit, ownWorkflowMisfitNote } from '../../lib/own-workflow-fit'
import { MODEL_TYPE_DEFAULTS } from '../../stores/createStore'

/** The workflow the reporter ran in ComfyUI: UNET, CLIP, VAE, no checkpoint. */
const MOSS_WORKFLOW = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'EmptyFlux2LatentImage', 'ModelSamplingAuraFlow', 'KSampler', 'VAEDecode', 'SaveImage']

describe('MOSS Image is an image model', () => {
  it('by the names it is shipped under, also with the folder in front', () => {
    for (const n of ['MOSS\\SFT\\MOSS-Image_SFT_int8.safetensors', 'mossImage_sft_pruned_int8.safetensors', 'moss_image_sft_bf16.safetensors', 'MOSS-Image-SFT-Q8_0.gguf']) {
      expect(classifyModel(n), n).toBe('mossimage')
      expect(isImageModelType(classifyModel(n))).toBe(true)
      expect(isVideoModelType(classifyModel(n))).toBe(false)
    }
  })

  it('NEGATIVE CONTROL: a name that only contains "moss" is not MOSS Image', () => {
    for (const n of ['mossy_forest_sdxl.safetensors', 'kromoss_dmd2_lora.safetensors', 'flux1-dev.safetensors']) {
      expect(classifyModel(n), n).not.toBe('mossimage')
    }
  })

  it('starts from the OpenMOSS defaults', () => {
    expect(MODEL_TYPE_DEFAULTS.mossimage).toMatchObject({ steps: 50, cfgScale: 3, sampler: 'euler', scheduler: 'simple' })
  })

  it('LU\'s own builder says what to do instead of building a wrong graph', () => {
    const nodes = { loaders: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CheckpointLoaderSimple'], samplers: ['KSampler'], latentImage: [], textEncoders: [], decoders: [], savers: [], other: [] }
    expect(determineStrategy('mossimage', false, nodes as never, {} as never)).toEqual({ strategy: 'unavailable', reason: MOSS_IMAGE_NO_BUILDER })
    expect(MOSS_IMAGE_NO_BUILDER).toMatch(/assign it to this model/)
  })

  it('and its workflow fits it, wherever the file was found', () => {
    expect(ownWorkflowMisfit(MOSS_WORKFLOW, 'mossimage', 'diffusion_model')).toBeNull()
    expect(ownWorkflowMisfit(MOSS_WORKFLOW, 'mossimage')).toBeNull()
  })
})

describe('a workflow assigned to a model LU does not know is used', () => {
  it('the reported case: an unknown model and a UNET workflow, no folder known', () => {
    expect(ownWorkflowMisfit(MOSS_WORKFLOW, 'unknown')).toBeNull()
    expect(ownWorkflowMisfitNote('MOSS API', MOSS_WORKFLOW, 'unknown')).toBeNull()
  })

  it('also a checkpoint workflow on an unknown model in diffusion_models', () => {
    expect(ownWorkflowMisfit(['CheckpointLoaderSimple', 'KSampler'], 'unknown', 'diffusion_model')).toBeNull()
  })

  it('NEGATIVE CONTROL: for a family LU knows, a wrong loader is still set aside', () => {
    expect(ownWorkflowMisfit(['UNETLoader', 'KSampler'], 'sdxl', 'checkpoint')).toMatch(/CheckpointLoaderSimple/)
    expect(ownWorkflowMisfit(['CheckpointLoaderSimple', 'KSampler'], 'flux')).toMatch(/UNETLoader/)
  })
})
