/**
 * C72 (Discord help-chat, 10.11.2026): a workflow imported from ComfyUI
 * rendered without the LoRAs picked in Create. injectParameters set model,
 * prompts, seed, steps, CFG, size and sampler, and dropped the stack.
 *
 * Run: npx vitest run src/api/__tests__/own-workflow-gets-the-lora-stack-c72.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { ComfyApiGraph } from '../../types/comfy-graph'
import type { GenerateParams } from '../comfyui'

vi.mock('../comfyui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../comfyui')>()),
  getVAEModels: vi.fn(async () => ['ae.safetensors', 'sdxl_vae.safetensors']),
  getCLIPModels: vi.fn(async () => ['t5xxl.safetensors', 'qwen_2.5_vl_7b_fp8_scaled.safetensors']),
  getLoraModels: vi.fn(async () => ['styles/pixel-art-xl.safetensors', 'detail_slider.safetensors', 'su542e_character.safetensors']),
  findMatchingVAE: vi.fn(async () => 'ae.safetensors'),
  findMatchingCLIP: vi.fn(async () => 't5xxl.safetensors'),
}))

const { autoDetectParameterMap, injectParameters } = await import('../workflows')

const sdxl = (): ComfyApiGraph => ({
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'juggernaut.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '3': { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'x' } },
})

const qwen = (): ComfyApiGraph => ({
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'su542e_character.safetensors', strength_model: 0.85 } },
  '3': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['2', 0], shift: 3.1 } },
  '4': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['4', 0] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['4', 0] } },
  '8': { class_type: 'EmptySD3LatentImage', inputs: { width: 768, height: 1360, batch_size: 1 } },
  '9': { class_type: 'KSampler', inputs: { model: ['3', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0], seed: 42, steps: 30, cfg: 2.5, sampler_name: 'euler', scheduler: 'beta', denoise: 1 } },
})

const params = (extra: Partial<GenerateParams> = {}): GenerateParams => ({
  prompt: 'a cat', negativePrompt: '', model: 'juggernaut.safetensors', sampler: 'euler', scheduler: 'normal',
  steps: 20, cfgScale: 7, width: 1024, height: 1024, seed: 7, batchSize: 1, ...extra,
})

describe('the LoRA stack in a workflow of the user\'s own', () => {
  it('a checkpoint workflow: one LoraLoader per LoRA behind the loader, model and CLIP both through the chain', async () => {
    const wf = sdxl()
    const out = await injectParameters(wf, autoDetectParameterMap(wf), params({ lora: ['pixel-art-xl', 'detail_slider'], loraStrength: [0.6, 1.2] }), 'sdxl')
    const loras = Object.entries(out).filter(([, n]) => n.class_type === 'LoraLoader')
    expect(loras.map(([, n]) => [n.inputs?.lora_name, n.inputs?.strength_model, n.inputs?.strength_clip])).toEqual([
      ['styles/pixel-art-xl.safetensors', 0.6, 0.6],
      ['detail_slider.safetensors', 1.2, 1.2],
    ])
    const [[firstId, first], [lastId, last]] = loras
    expect(first.inputs?.model).toEqual(['4', 0])
    expect(first.inputs?.clip).toEqual(['4', 1])
    expect(last.inputs?.model).toEqual([firstId, 0])
    expect(last.inputs?.clip).toEqual([firstId, 1])
    // Sampler and both prompts read the end of the chain; the VAE stays the checkpoint's.
    expect(out['3'].inputs?.model).toEqual([lastId, 0])
    expect(out['6'].inputs?.clip).toEqual([lastId, 1])
    expect(out['7'].inputs?.clip).toEqual([lastId, 1])
    expect(out['8'].inputs?.vae).toEqual(['4', 2])
    // The template the user saved is not touched.
    expect(wf['3'].inputs?.model).toEqual(['4', 0])
  })

  it('a UNET workflow with its own LoRA: the stack goes behind the loader, the workflow\'s LoRA stays once', async () => {
    const wf = qwen()
    const out = await injectParameters(wf, autoDetectParameterMap(wf), params({
      model: 'qwen_image.safetensors', lora: ['detail_slider', 'su542e_character'], loraStrength: 0.9,
    }), 'qwenimage')
    const added = Object.entries(out).filter(([, n]) => n._meta?.title?.startsWith('LoRA (LU)'))
    expect(added).toHaveLength(1)
    const [[id, node]] = added
    expect(node.class_type).toBe('LoraLoader')
    expect(node.inputs).toMatchObject({ lora_name: 'detail_slider.safetensors', model: ['1', 0], clip: ['4', 0], strength_model: 0.9 })
    expect(out['2'].inputs).toMatchObject({ model: [id, 0], lora_name: 'su542e_character.safetensors', strength_model: 0.85 })
    expect(out['6'].inputs?.clip).toEqual([id, 1])
  })

  it('two model loaders (Wan 2.2 high and low noise): each gets the stack, the second one model-only', async () => {
    const wf: ComfyApiGraph = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'wan22_high.safetensors', weight_dtype: 'default' } },
      '2': { class_type: 'UNETLoader', inputs: { unet_name: 'wan22_low.safetensors', weight_dtype: 'default' } },
      '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5.safetensors', type: 'wan', device: 'default' } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['3', 0] } },
      '5': { class_type: 'KSamplerAdvanced', inputs: { model: ['1', 0], positive: ['4', 0] } },
      '6': { class_type: 'KSamplerAdvanced', inputs: { model: ['2', 0], positive: ['4', 0] } },
    }
    const out = await injectParameters(wf, { model: { nodeId: '1', inputKey: 'unet_name' } }, params({ model: 'wan22_high.safetensors', lora: 'detail_slider' }), 'wan')
    const high = out[String((out['5'].inputs?.model as [string, number])[0])]
    const low = out[String((out['6'].inputs?.model as [string, number])[0])]
    expect(high.class_type).toBe('LoraLoader')
    expect(low.class_type).toBe('LoraLoaderModelOnly')
    expect(low.inputs?.model).toEqual(['2', 0])
  })

  it('no stack: the graph is what it was', async () => {
    const wf = sdxl()
    const out = await injectParameters(wf, autoDetectParameterMap(wf), params(), 'sdxl')
    expect(Object.values(out).some((n) => n.class_type === 'LoraLoader')).toBe(false)
    expect(Object.keys(out).sort()).toEqual(Object.keys(wf).sort())
  })

  it('a LoRA ComfyUI does not have is said by name, as in LU\'s own builder', async () => {
    const wf = sdxl()
    await expect(injectParameters(wf, autoDetectParameterMap(wf), params({ lora: 'gone' }), 'sdxl'))
      .rejects.toThrow(/LoRA "gone" is not installed in ComfyUI/)
  })

  it('a graph with no model loader LU knows says so instead of dropping the stack', async () => {
    const wf: ComfyApiGraph = { '1': { class_type: 'SomeCustomLoader', inputs: {} }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }
    await expect(injectParameters(wf, {}, params({ lora: 'detail_slider' }), 'sdxl')).rejects.toThrow(/no model loader LU can put a LoRA behind/)
  })
})
