/**
 * Discord #help-chat, 28.10.2026 (.molot, P5 add-on to GitHub #196): an own
 * Qwen Image 2.1 workflow with a character LoRA renders smooth, plastic faces
 * in LU and real skin in ComfyUI, "with exactly the same workflow".
 *
 * What reaches ComfyUI, value by value, for a graph of that shape:
 *   - kept as the workflow has it: the LoRA loader (file and strength), the
 *     sampling shift, the text encoder and its type, the VAE, the model
 *     loader's weight dtype;
 *   - LU's own on this path (by design since GitHub wish #8, and listed as
 *     "set by LU" under Workflow parameters): prompt, negative prompt, seed,
 *     steps, CFG, sampler, scheduler, width, height, batch size.
 * So the LoRA and the loaders are not lost; steps, CFG, sampler, scheduler
 * and size come from the Create controls. A run with LU's controls left at
 * the Qwen defaults is not the workflow's run.
 *
 * Run: npx vitest run src/api/__tests__/own-qwen-image-workflow-values.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { ComfyApiGraph } from '../../types/comfy-graph'
import type { GenerateParams } from '../comfyui'

vi.mock('../comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comfyui')>()),
  getVAEModels: vi.fn(async () => ['qwen_image_vae.safetensors']),
  getCLIPModels: vi.fn(async () => ['qwen_2.5_vl_7b_fp8_scaled.safetensors']),
  findMatchingVAE: vi.fn(async () => 'lu_pick_vae.safetensors'),
  findMatchingCLIP: vi.fn(async () => 'lu_pick_clip.safetensors'),
}))

const { autoDetectParameterMap, injectParameters } = await import('../workflows')
const { luSetInputs, paramKey } = await import('../workflow-params')

function qwenGraph(): ComfyApiGraph {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_fp8_e4m3fn.safetensors', weight_dtype: 'fp8_e4m3fn' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'su542e_character.safetensors', strength_model: 0.85 } },
    '3': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['2', 0], shift: 3.1 } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a photo of a france woman su542e, skin texture', clip: ['4', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'plastic, smooth skin', clip: ['4', 0] } },
    '8': { class_type: 'EmptySD3LatentImage', inputs: { width: 768, height: 1360, batch_size: 1 } },
    '9': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0], seed: 42, steps: 30, cfg: 2.5, sampler_name: 'res_multistep', scheduler: 'beta', denoise: 1 } },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['5', 0] } },
    '11': { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: 'Qwen_image_2.1' } },
  }
}

const lu: GenerateParams = {
  prompt: 'a photo of a france woman su542e', negativePrompt: '', model: 'qwen_image_2.1_fp8_e4m3fn.safetensors',
  sampler: 'euler', scheduler: 'simple', steps: 20, cfgScale: 4,
  width: 768, height: 1376, seed: 7, batchSize: 1,
}

describe('an own Qwen Image 2.1 workflow, value by value', () => {
  it('the LoRA, the shift and both loaders reach ComfyUI as the workflow has them', async () => {
    const wf = qwenGraph()
    const out = await injectParameters(wf, autoDetectParameterMap(wf), lu, 'qwenimage')
    expect(out['2'].inputs).toEqual(wf['2'].inputs)
    expect(out['3'].inputs).toEqual(wf['3'].inputs)
    expect(out['4'].inputs).toEqual(wf['4'].inputs)
    expect(out['5'].inputs).toEqual(wf['5'].inputs)
    expect(out['1'].inputs.weight_dtype).toBe('fp8_e4m3fn')
    expect(out['9'].inputs.denoise).toBe(1)
  })

  it('the prompt goes into the positive box, the negative box gets LU\'s negative', async () => {
    const wf = qwenGraph()
    const out = await injectParameters(wf, autoDetectParameterMap(wf), lu, 'qwenimage')
    expect(out['6'].inputs.text).toBe(lu.prompt)
    expect(out['7'].inputs.text).toBe('')
  })

  it('steps, CFG, sampler, scheduler and size are the Create controls, not the workflow', async () => {
    const wf = qwenGraph()
    const out = await injectParameters(wf, autoDetectParameterMap(wf), lu, 'qwenimage')
    expect(out['9'].inputs).toMatchObject({ steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'simple' })
    expect(out['8'].inputs).toMatchObject({ width: 768, height: 1376 })
  })

  it('Workflow parameters says so: those fields are listed as set by LU', () => {
    const wf = qwenGraph()
    const set = luSetInputs(wf, autoDetectParameterMap(wf))
    for (const [id, key] of [['9', 'steps'], ['9', 'cfg'], ['9', 'sampler_name'], ['9', 'scheduler'], ['8', 'width'], ['8', 'height']]) {
      expect(set.has(paramKey(id, key))).toBe(true)
    }
    for (const [id, key] of [['2', 'strength_model'], ['2', 'lora_name'], ['3', 'shift']]) {
      expect(set.has(paramKey(id, key))).toBe(false)
    }
    // The loaders are marked "auto": LU replaces them only when the file is missing.
    expect(set.get(paramKey('4', 'clip_name'))?.auto).toBe(true)
  })
})
