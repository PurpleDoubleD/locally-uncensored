/**
 * B46 / D8 (Discord #bug-reports 30.10.2026, help chat 06.11.2026 on 3.0.10):
 * the Edit strength of a Qwen edit through ComfyUI.
 *
 * Up to 3.0.7 the slider set `denoise`, which the graph never read. 3.0.9
 * started the sampler from the source at denoise = strength: the box run of
 * 01.11. came back as the source at 0.40 and 0.10, only 1.00 edited, because
 * these edit models copy their reference unless they start from pure noise.
 * Now the strength is guidance between the edit and the same images without
 * an instruction (identity): identity + strength x (edit - identity), on one
 * path from noise. At CFG 1 that is the sampler's CFG with identity as the
 * negative; above it the nested DualCFGGuider keeps the user's negative.
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
    'RandomNoise', 'KSamplerSelect', 'CFGGuider', 'ManualSigmas', 'SamplerCustomAdvanced', 'DualCFGGuider', 'BasicScheduler'])
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

const ref = (wf: ComfyApiGraph, r: unknown) => nodeAt(wf, String((r as [string, number])[0]))!

/** The edit as the template runs it: denoise 1.0, the template's negative
 *  and CFG, no second guidance. */
function expectTemplateEdit(wf: ComfyApiGraph, cfg: number) {
  expect(classTypes(wf)).not.toContain('DualCFGGuider')
  const sampler = nodeOf(wf, 'KSampler')?.[1] ?? nodeOf(wf, 'CFGGuider')![1]
  expect(sampler.inputs.cfg).toBe(cfg)
  if (sampler.class_type === 'KSampler') expect(sampler.inputs.denoise).toBe(1)
}

describe('Qwen-Image 2.1 edit (CFG 1): the strength is the CFG between the edit and the source as it is', () => {
  it('0.4: KSampler at CFG 0.4, positive the edit, negative the same images without an instruction, denoise 1 from the encoder latent', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.4, cfgScale: 1 })
    const [encId, enc] = nodeOf(wf, 'TextEncodeQwenImage21')!
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs.cfg).toBe(0.4)
    expect(sampler.inputs.denoise).toBe(1)
    expect(sampler.inputs.latent_image).toEqual([encId, 2])
    expect(sampler.inputs.positive).toEqual([encId, 0])
    // The node's negative: the images with the (empty) negative prompt.
    expect(sampler.inputs.negative).toEqual([encId, 1])
    expect(enc.inputs.negative_prompt).toBe('')
    expect(enc.inputs['images.image_1']).toBeDefined()
    // One path from noise: no blend, no start from the source.
    for (const c of ['ImageBlend', 'VAEEncode', 'DualCFGGuider']) expect(classTypes(wf)).not.toContain(c)
  })

  it('every step of the slider is its own CFG: 0.05 to 0.95', async () => {
    for (const s of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: s, cfgScale: 1 })
      expect(nodeOf(wf, 'KSampler')![1].inputs.cfg).toBe(s)
    }
  })

  it('with a negative prompt the identity is an encode of its own, the same images and no text', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.5, cfgScale: 1, negativePrompt: 'blurry' })
    const encoders = Object.entries(wf).filter(([, node]) => node.class_type === 'TextEncodeQwenImage21')
    expect(encoders).toHaveLength(2)
    const [, sampler] = nodeOf(wf, 'KSampler')!
    const identity = ref(wf, sampler.inputs.negative)
    expect(identity.class_type).toBe('TextEncodeQwenImage21')
    expect(identity.inputs.prompt).toBe('')
    expect(identity.inputs.negative_prompt).toBe('')
    const edit = ref(wf, sampler.inputs.positive)
    expect(identity.inputs['images.image_1']).toEqual(edit.inputs['images.image_1'])
    expect(identity.inputs.resolution).toBe(edit.inputs.resolution)
    expect(sampler.inputs.negative).toEqual([encoders.find(([, n]) => n === identity)![0], 0])
  })

  it('COUNTER-CHECK: 1 or unset is the graph of today', async () => {
    for (const extra of [{}, { editStrength: 1 }]) {
      const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { ...extra, cfgScale: 1 })
      const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
      expectTemplateEdit(wf, 1)
      expect(nodeOf(wf, 'KSampler')![1].inputs.latent_image).toEqual([encId, 2])
    }
  })

  it('COUNTER-CHECK: the img2img denoise alone changes nothing on a Qwen edit', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { denoise: 0.3, cfgScale: 1 })
    expectTemplateEdit(wf, 1)
  })

  it('below 0.05 it holds at 0.05', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.01, cfgScale: 1 })
    expect(nodeOf(wf, 'KSampler')![1].inputs.cfg).toBe(0.05)
  })

  it('Turbo: its whole schedule, the CFGGuider at the strength against the identity', async () => {
    const wf = await build(TURBO, 'qwenimage', { editStrength: 0.5, cfgScale: 1 })
    const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
    const [, custom] = nodeOf(wf, 'SamplerCustomAdvanced')!
    expect(classAt(wf, custom.inputs.sigmas)).toBe('ManualSigmas')
    const guider = ref(wf, custom.inputs.guider)
    expect(guider.class_type).toBe('CFGGuider')
    expect(guider.inputs.cfg).toBe(0.5)
    expect(guider.inputs.negative).toEqual([encId, 1])
    expect(custom.inputs.latent_image).toEqual([encId, 2])
  })

  it('COUNTER-CHECK Turbo at 1: the template chain as before', async () => {
    const wf = await build(TURBO, 'qwenimage', { editStrength: 1, cfgScale: 1 })
    const guider = ref(wf, nodeOf(wf, 'SamplerCustomAdvanced')![1].inputs.guider)
    expect(guider.inputs.cfg).toBe(1)
    expect(classTypes(wf)).not.toContain('DualCFGGuider')
  })
})

describe('a Qwen edit above CFG 1: the nested DualCFGGuider keeps the negative', () => {
  it('Qwen-Image-Edit 2509 at CFG 4, 0.4: cond1 the edit, cond2 the identity, cfg_conds 0.4, cfg_cond2_negative 4, nested', async () => {
    const wf = await build(EDIT_PLUS, 'qwenimage1', { editStrength: 0.4, cfgScale: 4 })
    expect(classTypes(wf)).not.toContain('KSampler')
    const [, custom] = nodeOf(wf, 'SamplerCustomAdvanced')!
    const guider = ref(wf, custom.inputs.guider)
    expect(guider.class_type).toBe('DualCFGGuider')
    expect(guider.inputs).toMatchObject({ cfg_conds: 0.4, cfg_cond2_negative: 4, style: 'nested' })
    const edit = ref(wf, guider.inputs.cond1)
    const identity = ref(wf, guider.inputs.cond2)
    expect(edit.class_type).toBe('TextEncodeQwenImageEditPlus')
    expect(identity.class_type).toBe('TextEncodeQwenImageEditPlus')
    expect(identity.inputs.prompt).toBe('')
    expect(identity.inputs.image1).toEqual(edit.inputs.image1)
    // Empty negative prompt: the identity IS the negative encode.
    expect(guider.inputs.negative).toEqual(guider.inputs.cond2)
    // The KSampler's steps, scheduler, sampler and seed, denoise 1 on the
    // encoded source as the template.
    const sigmas = ref(wf, custom.inputs.sigmas)
    expect(sigmas).toMatchObject({ class_type: 'BasicScheduler', inputs: { scheduler: 'simple', steps: 20, denoise: 1 } })
    expect(ref(wf, custom.inputs.sampler).inputs.sampler_name).toBe('euler')
    expect(ref(wf, custom.inputs.noise).inputs.noise_seed).toBe(7)
    expect(classAt(wf, custom.inputs.latent_image)).toBe('VAEEncode')
  })

  it('with a negative prompt the identity is its own encode and the negative stays the negative', async () => {
    const wf = await build(EDIT_PLUS, 'qwenimage1', { editStrength: 0.6, cfgScale: 4, negativePrompt: 'blurry' })
    const guider = ref(wf, nodeOf(wf, 'SamplerCustomAdvanced')![1].inputs.guider)
    const identity = ref(wf, guider.inputs.cond2)
    const negative = ref(wf, guider.inputs.negative)
    expect(identity.inputs.prompt).toBe('')
    expect(String(negative.inputs.prompt)).toContain('blurry')
    expect(guider.inputs.cond2).not.toEqual(guider.inputs.negative)
  })

  it('Qwen-Image 2.1 at CFG 4 takes the same guider', async () => {
    const wf = await build(QWEN21_OFFICIAL_MODEL, 'qwenimage', { editStrength: 0.5, cfgScale: 4 })
    const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
    const [, custom] = nodeOf(wf, 'SamplerCustomAdvanced')!
    const guider = ref(wf, custom.inputs.guider)
    expect(guider.inputs).toMatchObject({ cond1: [encId, 0], cond2: [encId, 1], negative: [encId, 1], cfg_conds: 0.5, cfg_cond2_negative: 4 })
    expect(custom.inputs.latent_image).toEqual([encId, 2])
  })

  it('a ComfyUI without DualCFGGuider says so instead of failing in the run', async () => {
    const err = await build(EDIT_PLUS, 'qwenimage1', { editStrength: 0.4, cfgScale: 4 }, ['DualCFGGuider']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(String((err as Error).message)).toMatch(/Edit strength below 1 needs a newer ComfyUI/)
  })

  it('COUNTER-CHECK: 2509 unset stays the template, KSampler at CFG 4', async () => {
    const wf = await build(EDIT_PLUS, 'qwenimage1', { cfgScale: 4 })
    expectTemplateEdit(wf, 4)
  })
})

describe('every other edit ignores it', () => {
  it('SDXL keeps the img2img denoise and its CFG', async () => {
    const wf = await build(SDXL, 'sdxl', { editStrength: 0.2, cfgScale: 7 })
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(sampler.inputs.denoise).toBe(0.7)
    expect(sampler.inputs.cfg).toBe(7)
  })
})
