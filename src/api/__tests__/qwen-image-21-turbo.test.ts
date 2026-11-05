/**
 * Qwen-Image 2.1 Turbo on ComfyUI (Discord, 28.10.2026: Turbo looks bad in
 * LU, the full 2.1 model is fine).
 *
 * Turbo is distilled to eight steps on its own sigma schedule. LU built the
 * same KSampler graph for both files, at the sliders' 25 steps and the simple
 * scheduler. The official templates run Turbo through SamplerCustomAdvanced
 * with ManualSigmas instead, and put QwenImage21Cache in front of the sampler
 * for both models.
 *
 * The expectations are read off the templates themselves
 * (fixtures/comfy-ui/templates, Comfy-Org/workflow_templates at
 * 14220b8bd3e86baa852959f17039613191e66656, see SOURCE.md), not typed in a
 * second time.
 *
 * Run: npx vitest run src/api/__tests__/qwen-image-21-turbo.test.ts
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
import { classifyModel } from '../comfyui'
import { localFetch } from '../backend'
import { applyNativeHiresFix } from '../hires-fix'
import { isQwenImage21Turbo } from '../../lib/render/qwen21-turbo'
import { nodeOf, nodeAt, classTypes } from './graph-test-support'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const NORMAL = 'qwen_image_2.1_int8_convrot.safetensors'
const TURBO = 'qwen_image_2.1_turbo_int8_convrot.safetensors'
const TURBO_BF16 = 'qwen_image_2.1_turbo_bf16.safetensors'
const ENCODER = 'qwen3vl_8b_int8_convrot.safetensors'
const VAE_FILE = 'qwen_image_2.1_vae_bf16.safetensors'
const LORA = 'qwen21_style.safetensors'

// ── The official templates ─────────────────────────────────────────────

interface TplNode { id: number; type: string; widgets_values?: unknown[]; inputs?: { name: string; link: number | null; type: string }[] }
interface TplSubgraph { nodes: TplNode[]; links: { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number }[]; inputs: { name: string; type: string }[] }
interface Tpl { nodes: TplNode[]; definitions: { subgraphs: TplSubgraph[] } }

const template = (name: string): Tpl =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures/comfy-ui/templates', name), 'utf8')) as Tpl

/** The template's own subgraph, where its sampler chain lives. */
function chainOf(name: string) {
  const tpl = template(name)
  const sg = tpl.definitions.subgraphs[0]
  const byType = (t: string) => {
    const hits = sg.nodes.filter((nd) => nd.type === t)
    expect(hits, `${name}: one ${t}`).toHaveLength(1)
    return hits[0]
  }
  /** The node class feeding input `input` of `node`, -10 for the subgraph's own inputs. */
  const feeder = (node: TplNode, input: string): { type: string; slot: number; sgInput?: string } => {
    const linkId = node.inputs?.find((i) => i.name === input)?.link
    const link = sg.links.find((l) => l.id === linkId)
    if (!link) throw new Error(`${name}: ${node.type}.${input} is not linked`)
    if (link.origin_id === -10) return { type: 'subgraph-input', slot: link.origin_slot, sgInput: sg.inputs[link.origin_slot].name }
    return { type: sg.nodes.find((nd) => nd.id === link.origin_id)!.type, slot: link.origin_slot }
  }
  return { tpl, sg, byType, feeder }
}

const TURBO_T2I = chainOf('image_qwen_image_2_1_turbo_t2i.json')
const TEMPLATE_SIGMAS = TURBO_T2I.byType('ManualSigmas').widgets_values![0] as string
const TEMPLATE_SAMPLER = TURBO_T2I.byType('KSamplerSelect').widgets_values![0] as string
const TEMPLATE_CFG = TURBO_T2I.byType('CFGGuider').widgets_values![0] as number
const TEMPLATE_CACHE = TURBO_T2I.byType('QwenImage21Cache').widgets_values as [string, string]

// ── /object_info ───────────────────────────────────────────────────────

const CUSTOM = ['RandomNoise', 'KSamplerSelect', 'CFGGuider', 'ManualSigmas', 'SamplerCustomAdvanced']

function nodes(opts: { custom?: string[]; cache?: boolean } = {}) {
  const custom = opts.custom ?? CUSTOM
  const info: Record<string, unknown> = {
    UNETLoader: { input: { required: { unet_name: [[NORMAL, TURBO, TURBO_BF16]] } } },
    CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
    VAELoader: { input: { required: { vae_name: [[VAE_FILE]] } } },
    LoraLoader: { input: { required: { lora_name: [[LORA]] } } },
    TextEncodeQwenImage21: { input: { required: { clip: ['CLIP'], prompt: ['STRING'], negative_prompt: ['STRING'], resolution: ['INT'] }, optional: { vae: ['VAE'], 'images.image_1': ['IMAGE'] } } },
    EmptyLatentImage: { input: { required: {} } },
    KSampler: { input: { required: {} } },
    CLIPTextEncode: { input: { required: {} } },
    VAEDecode: { input: { required: {} } },
    LoadImage: { input: { required: {} } },
    SaveImage: { input: { required: {} } },
    ModelSamplingAuraFlow: { input: { required: {} } },
  }
  if (opts.cache !== false) info.QwenImage21Cache = { input: { required: { model: ['MODEL'], device: [['auto', 'gpu', 'cpu', 'off']], dtype: [['default', 'int8', 'int4']] } } }
  for (const c of custom) info[c] = { input: { required: {} } }
  return info
}

const params = (model: string, extra: Record<string, unknown> = {}) => ({
  model, prompt: 'a red apple on a white plate', negativePrompt: '',
  // What the sliders said in the report: the full model's values.
  sampler: 'dpmpp_2m', scheduler: 'karras', steps: 25, cfgScale: 1,
  width: 1024, height: 1024, seed: 4242, batchSize: 1, ...extra,
})

async function build(model: string, extra: Record<string, unknown> = {}, opts: Parameters<typeof nodes>[0] = {}): Promise<ComfyApiGraph> {
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes(opts) as never)
  return buildDynamicWorkflow(params(model, extra) as never, classifyModel(model))
}

/** The class of the node a link points at. */
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

// ── (a) Which file is Turbo ────────────────────────────────────────────

describe('isQwenImage21Turbo', () => {
  it('the Comfy-Org files and the community spellings', () => {
    for (const name of [
      TURBO, TURBO_BF16,
      'Qwen-Image-2.1-Turbo-Q8_0.gguf',
      'Qwen-Image-2.1-Turbo-fp8_e4m3fn.safetensors',
      'qwen_image_2_1_TURBO_nvfp4.safetensors',
      'qwen\\qwen_image_2.1_turbo_int8_convrot.safetensors',
    ]) {
      expect(isQwenImage21Turbo(name), name).toBe(true)
      // And on the 2.1 lane, never Qwen-Image 1 with its AuraFlow shift.
      expect(classifyModel(name), name).toBe('qwenimage')
    }
  })

  it('COUNTER-CHECK: the full model, other Turbo families, the Mac pack and junk are not', () => {
    for (const name of [
      NORMAL, 'qwen_image_2.1_bf16.safetensors', 'NoctQ_V4_int8_convrot.safetensors',
      'z_image_turbo_bf16.safetensors', 'sd_turbo.safetensors', 'sdxl_turbo_1.0_fp16.safetensors',
      'qwen_image_2512_turbo_lightning.safetensors', 'qwen_image_edit_2509_turbo.safetensors',
      // The Mac's Qwen-Image 2.1 Turbo is mflux with the Viggle LoRA, its own model.
      'MLX Qwen-Image 2.1 Turbo 8-bit',
      // A folder called turbo says nothing about the file.
      'turbo/qwen_image_2.1_int8_convrot.safetensors',
      '', null, undefined,
    ]) {
      expect(isQwenImage21Turbo(name), String(name)).toBe(false)
    }
  })
})

// ── (b) The Turbo graph is the template's ──────────────────────────────

describe('Qwen-Image 2.1 Turbo builds the official Turbo chain', () => {
  it('the template says what this file checks', () => {
    expect(TEMPLATE_SIGMAS).toBe('1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0')
    expect(TEMPLATE_SAMPLER).toBe('euler')
    expect(TEMPLATE_CFG).toBe(1)
    expect(TEMPLATE_CACHE).toEqual(['auto', 'default'])
    const { byType, feeder } = TURBO_T2I
    expect(feeder(byType('QwenImage21Cache'), 'model').type).toBe('UNETLoader')
    expect(feeder(byType('CFGGuider'), 'model').type).toBe('QwenImage21Cache')
    expect(feeder(byType('CFGGuider'), 'positive')).toMatchObject({ type: 'TextEncodeQwenImage21', slot: 0 })
    expect(feeder(byType('CFGGuider'), 'negative')).toMatchObject({ type: 'TextEncodeQwenImage21', slot: 1 })
    expect(feeder(byType('VAEDecode'), 'samples')).toMatchObject({ type: 'SamplerCustomAdvanced', slot: 0 })
    expect(TURBO_T2I.sg.nodes.some((nd) => nd.type === 'KSampler')).toBe(false)
  })

  for (const model of [TURBO, TURBO_BF16]) {
    it(`${model}: node classes, wiring, sigmas word for word, cfg, sampler, cache`, async () => {
      const wf = await build(model)
      const { byType, feeder } = TURBO_T2I
      const [, custom] = nodeOf(wf, 'SamplerCustomAdvanced')!
      // Every input the template wires, from the same class.
      for (const input of ['noise', 'guider', 'sampler', 'sigmas', 'latent_image']) {
        expect(classAt(wf, custom.inputs[input]), input).toBe(feeder(byType('SamplerCustomAdvanced'), input).type)
      }
      expect(nodeOf(wf, 'ManualSigmas')![1].inputs.sigmas).toBe(TEMPLATE_SIGMAS)
      expect(nodeOf(wf, 'KSamplerSelect')![1].inputs.sampler_name).toBe(TEMPLATE_SAMPLER)
      const [, guider] = nodeOf(wf, 'CFGGuider')!
      expect(guider.inputs.cfg).toBe(TEMPLATE_CFG)
      expect(classAt(wf, guider.inputs.model)).toBe('QwenImage21Cache')
      expect(guider.inputs.positive).toEqual([nodeOf(wf, 'TextEncodeQwenImage21')![0], 0])
      expect(guider.inputs.negative).toEqual([nodeOf(wf, 'TextEncodeQwenImage21')![0], 1])
      expect(nodeOf(wf, 'RandomNoise')![1].inputs.noise_seed).toBe(4242)
      const [, cache] = nodeOf(wf, 'QwenImage21Cache')!
      expect([cache.inputs.device, cache.inputs.dtype]).toEqual(TEMPLATE_CACHE)
      expect(classAt(wf, cache.inputs.model)).toBe('UNETLoader')
      expect(nodeOf(wf, 'VAEDecode')![1].inputs.samples).toEqual([nodeOf(wf, 'SamplerCustomAdvanced')![0], 0])
      // Nothing of the old graph and nothing of Qwen-Image 1.
      expect(classTypes(wf)).not.toContain('KSampler')
      expect(classTypes(wf)).not.toContain('ModelSamplingAuraFlow')
      // The sliders' 25 steps and karras scheduler go nowhere.
      expect(JSON.stringify(wf)).not.toContain('karras')
      expect(JSON.stringify(wf)).not.toContain('dpmpp_2m')
    })
  }

  it('Edit runs the same chain, on the latent of the encode node', async () => {
    const wf = await build(TURBO, { inputImage: 'lu_source.png', denoise: 0.7 })
    const [encId] = nodeOf(wf, 'TextEncodeQwenImage21')!
    const [, custom] = nodeOf(wf, 'SamplerCustomAdvanced')!
    expect(custom.inputs.latent_image).toEqual([encId, 2])
    expect(nodeOf(wf, 'ManualSigmas')![1].inputs.sigmas).toBe(TEMPLATE_SIGMAS)
    expect(nodeOf(wf, 'CFGGuider')![1].inputs.cfg).toBe(1)
    expect(classTypes(wf)).not.toContain('KSampler')
  })

  it('the Turbo edit template shows cfg 8 on its CFGGuider, but runs at 1', () => {
    const edit = chainOf('image_qwen_image_2_1_turbo_image_edit.json')
    const guider = edit.byType('CFGGuider')
    expect(guider.widgets_values).toEqual([8])
    // The widget is overridden: cfg is wired to the subgraph input "cfg" ...
    const fed = edit.feeder(guider, 'cfg')
    expect(fed).toMatchObject({ type: 'subgraph-input', sgInput: 'cfg' })
    // ... which the outer node sets to 1 (widget values follow the subgraph's
    // widget inputs, the IMAGE slots carry none).
    const widgetInputs = edit.sg.inputs.filter((i) => i.type !== 'IMAGE').map((i) => i.name)
    const outer = edit.tpl.nodes.find((nd) => nd.widgets_values?.length === widgetInputs.length)!
    expect(outer.widgets_values![widgetInputs.indexOf('cfg')]).toBe(1)
    expect(edit.byType('ManualSigmas').widgets_values![0]).toBe(TEMPLATE_SIGMAS)
  })

  it('a CFG above 1 on the slider reaches the guider', async () => {
    const wf = await build(TURBO, { cfgScale: 2.5 })
    expect(nodeOf(wf, 'CFGGuider')![1].inputs.cfg).toBe(2.5)
  })

  it('LoRAs sit between the model and the cache: UNET → LoRA → cache → guider', async () => {
    const wf = await build(TURBO, { lora: [LORA], loraStrength: [0.8] })
    const [loraId, lora] = nodeOf(wf, 'LoraLoader')!
    expect(classAt(wf, lora.inputs.model)).toBe('UNETLoader')
    const [cacheId, cache] = nodeOf(wf, 'QwenImage21Cache')!
    expect(cache.inputs.model).toEqual([loraId, 0])
    expect(nodeOf(wf, 'CFGGuider')![1].inputs.model).toEqual([cacheId, 0])
  })
})

// ── (c) The full model keeps its KSampler ──────────────────────────────

describe('the full Qwen-Image 2.1 model', () => {
  it('KSampler with the sliders\' values, behind the cache like its template', async () => {
    const full = chainOf('image_qwen_image_2_1_t2i.json')
    expect(full.feeder(full.byType('KSampler'), 'model').type).toBe('QwenImage21Cache')
    expect(full.byType('QwenImage21Cache').widgets_values).toEqual(['auto', 'default'])

    const wf = await build(NORMAL)
    const [, ks] = nodeOf(wf, 'KSampler')!
    expect(ks.inputs).toMatchObject({ steps: 25, cfg: 1, sampler_name: 'dpmpp_2m', scheduler: 'karras', seed: 4242, denoise: 1 })
    expect(classAt(wf, ks.inputs.model)).toBe('QwenImage21Cache')
    const [, cache] = nodeOf(wf, 'QwenImage21Cache')!
    expect([cache.inputs.device, cache.inputs.dtype]).toEqual(['auto', 'default'])
    for (const c of CUSTOM) expect(classTypes(wf)).not.toContain(c)
  })

  it('with LoRAs: UNET → LoRA → cache → KSampler', async () => {
    const wf = await build(NORMAL, { lora: [LORA] })
    const [loraId] = nodeOf(wf, 'LoraLoader')!
    const [cacheId, cache] = nodeOf(wf, 'QwenImage21Cache')!
    expect(cache.inputs.model).toEqual([loraId, 0])
    expect(nodeOf(wf, 'KSampler')![1].inputs.model).toEqual([cacheId, 0])
  })

  it('a ComfyUI without QwenImage21Cache runs without it', async () => {
    const wf = await build(NORMAL, {}, { cache: false })
    expect(classTypes(wf)).not.toContain('QwenImage21Cache')
    expect(classAt(wf, nodeOf(wf, 'KSampler')![1].inputs.model)).toBe('UNETLoader')
  })
})

// ── (d) Without the custom sampler nodes ───────────────────────────────

describe('Turbo on a ComfyUI without the custom sampler nodes', () => {
  for (const missing of CUSTOM) {
    it(`without ${missing}: KSampler at 8 steps, euler, simple`, async () => {
      const wf = await build(TURBO, {}, { custom: CUSTOM.filter((c) => c !== missing) })
      const [, ks] = nodeOf(wf, 'KSampler')!
      expect(ks.inputs).toMatchObject({ steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', seed: 4242, denoise: 1 })
      expect(classAt(wf, ks.inputs.model)).toBe('QwenImage21Cache')
      expect(classTypes(wf)).not.toContain('SamplerCustomAdvanced')
      expect(classTypes(wf)).not.toContain('ManualSigmas')
    })
  }
})

// ── Native HiRes on the Turbo chain ────────────────────────────────────

describe('Native HiRes on the Turbo chain', () => {
  it('the refinement pass reads model, prompt, cfg, seed and sampler off the chain', async () => {
    const wf = await build(TURBO)
    const out = applyNativeHiresFix(wf, {
      baseWidth: 1024, baseHeight: 1024, scale: 1.5, denoise: 0.4, steps: 6, upscaleMethod: 'nearest-exact', latentDownscale: 16,
    })
    const [customId] = nodeOf(out.workflow, 'SamplerCustomAdvanced')!
    const [, guider] = nodeOf(out.workflow, 'CFGGuider')!
    const upscale = nodeAt(out.workflow, out.upscaleNodeId)!
    expect(upscale.inputs.samples).toEqual([customId, 0])
    const pass = nodeAt(out.workflow, out.samplerNodeId)!
    expect(pass.class_type).toBe('KSampler')
    expect(pass.inputs).toMatchObject({
      model: guider.inputs.model, positive: guider.inputs.positive, negative: guider.inputs.negative,
      latent_image: [out.upscaleNodeId, 0], seed: 4242, cfg: 1, sampler_name: 'euler', scheduler: 'simple', steps: 6, denoise: 0.4,
    })
    expect(nodeOf(out.workflow, 'VAEDecode')![1].inputs.samples).toEqual([out.samplerNodeId, 0])
  })
})
