/**
 * Discord 21.11.2026: a second character painted into a picture with a mask
 * was refused on Z-Image, with a line saying the model cannot do it. Z-Image
 * samples a masked latent like any other model: the source is encoded whole,
 * ComfyUI's core SetLatentNoiseMask limits the sampler to the painted area.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../comfyui-nodes', async (o) => ({ ...(await o<typeof import('../comfyui-nodes')>()), getAllNodeInfo: vi.fn() }))
vi.mock('../comfyui', async (o) => ({
  ...(await o<typeof import('../comfyui')>()),
  findMatchingCLIP: vi.fn(async () => 'qwen_3_4b.safetensors'),
  findMatchingVAE: vi.fn(async () => 'ae.safetensors'),
}))

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { applyEditBatch } from '../edit-batch'
import { classTypes, nodeOf } from './graph-test-support'

const Z = 'z_image_turbo_bf16.safetensors'
const CHAR = 'char_mira_zimage.safetensors'

function info(without: string[] = []) {
  const n: Record<string, unknown> = {}
  for (const k of ['CLIPTextEncode', 'KSampler', 'EmptySD3LatentImage', 'LoadImage', 'LoadImageMask', 'VAEEncode', 'VAEEncodeForInpaint',
    'InpaintModelConditioning', 'SetLatentNoiseMask', 'GrowMask', 'VAEDecode', 'SaveImage', 'ModelSamplingAuraFlow', 'ConditioningZeroOut',
    'RepeatLatentBatch']) n[k] = { input: { required: {} } }
  for (const k of ['LoraLoaderModelOnly', 'LoraLoader']) n[k] = { input: { required: { lora_name: [[CHAR]] } } }
  n.UNETLoader = { input: { required: { unet_name: [[Z]] } } }
  n.CLIPLoader = { input: { required: { clip_name: [['qwen_3_4b.safetensors']], type: [['qwen_image']] } } }
  n.VAELoader = { input: { required: { vae_name: [['ae.safetensors']] } } }
  for (const k of without) delete n[k]
  return n
}
const params = (extra: Record<string, unknown> = {}) => ({
  model: Z, prompt: 'mira stands next to him', negativePrompt: '', sampler: 'euler', scheduler: 'simple',
  width: 1024, height: 1024, steps: 8, cfgScale: 1, seed: 1, batchSize: 1,
  inputImage: 'src.png', maskImage: 'mask.png', growMaskBy: 8, denoise: 0.9, lora: [CHAR], ...extra,
}) as never

beforeEach(() => { vi.mocked(getAllNodeInfo).mockResolvedValue(info() as never) })

describe('Z-Image with a mask', () => {
  it('samples only the painted area of the encoded source', async () => {
    const wf = await buildDynamicWorkflow(params(), 'zimage')
    const [noiseId, noise] = nodeOf(wf, 'SetLatentNoiseMask')!
    const [encId] = nodeOf(wf, 'VAEEncode')!
    const [growId, grow] = nodeOf(wf, 'GrowMask')!
    const [maskId, mask] = nodeOf(wf, 'LoadImageMask')!
    expect(noise.inputs.samples).toEqual([encId, 0])
    expect(noise.inputs.mask).toEqual([growId, 0])
    expect(grow.inputs).toMatchObject({ mask: [maskId, 0], expand: 8 })
    expect(mask.inputs).toMatchObject({ image: 'mask.png', channel: 'red' })
    const sampler = nodeOf(wf, 'KSampler')![1]
    expect(sampler.inputs.latent_image).toEqual([noiseId, 0])
    expect(sampler.inputs.denoise).toBe(0.9)
  })

  it('takes no inpaint-model path and no empty latent', async () => {
    const types = classTypes(await buildDynamicWorkflow(params(), 'zimage'))
    for (const t of ['InpaintModelConditioning', 'VAEEncodeForInpaint', 'EmptySD3LatentImage']) expect(types).not.toContain(t)
  })

  it('carries the character LoRA', async () => {
    const wf = await buildDynamicWorkflow(params(), 'zimage')
    expect(Object.values(wf).some((n) => String(n.class_type).startsWith('LoraLoader') && n.inputs?.lora_name === CHAR)).toBe(true)
  })

  it('keeps the mask on every picture of a batch', async () => {
    const wf = applyEditBatch(await buildDynamicWorkflow(params(), 'zimage'), 3)
    const [noiseId] = nodeOf(wf, 'SetLatentNoiseMask')!
    const [repeatId, repeat] = nodeOf(wf, 'RepeatLatentBatch')!
    expect(repeat.inputs.samples).toEqual([noiseId, 0])
    expect(nodeOf(wf, 'KSampler')![1].inputs.latent_image).toEqual([repeatId, 0])
  })

  it('without a mask it stays the whole-image edit', async () => {
    const wf = await buildDynamicWorkflow(params({ maskImage: undefined }), 'zimage')
    expect(classTypes(wf)).not.toContain('SetLatentNoiseMask')
    expect(classTypes(wf)).toContain('VAEEncode')
  })

  it('a ComfyUI without the node gets a sentence, never a dropped mask', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(info(['SetLatentNoiseMask']) as never)
    const err = await buildDynamicWorkflow(params(), 'zimage').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect((err as Error).message).toMatch(/Update ComfyUI/)
  })
})
