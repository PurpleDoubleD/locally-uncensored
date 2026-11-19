/**
 * A45 (Discord general 15.11.2026): Krea 2 with a reference image loads the
 * style reference LoRA on its own. Turned on in the LoRA stack as well, it
 * went into the model twice and the pictures came out as noise. 3.0.9 had
 * the same with the lightx2v speed LoRA in the Wan 14B graph.
 *
 * This walks every model chain of every graph LU builds itself, for each
 * family that loads a LoRA, with a stack that holds one LoRA twice (two
 * spellings of one file) and the LoRA the graph adds on its own. No chain may
 * hold one file twice. A LoRA-imported workflow (C72) is checked the same way.
 *
 * Run: npx vitest run src/api/__tests__/no-lora-twice-in-a-chain-a45.test.ts
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
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}`, isMacOS: () => false }
})

import { buildDynamicWorkflow, dedupeLoraStack, loraFileKey } from '../dynamic-workflow'
import { injectLoraStack } from '../workflow-lora-inject'
import { getAllNodeInfo } from '../comfyui-nodes'
import { localFetch } from '../backend'
import { KREA2_STYLE_LORA } from '../../lib/frame-refs'
import { wanSpeedLoraNames } from '../../lib/wan-speed'
import { apiNodes, isComfyLinkRef, type ComfyApiGraph } from '../../types/comfy-graph'

const STYLE = 'style.safetensors'
const H3_TURBO = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
const [WAN_HIGH, WAN_LOW] = wanSpeedLoraNames('a14b-t2v')
const LORAS = [STYLE, KREA2_STYLE_LORA.filename, H3_TURBO, WAN_HIGH, WAN_LOW]

const MODELS = {
  sdxl: 'juggernautXL_v9.safetensors',
  flux: 'flux1-dev-fp8.safetensors',
  krea: 'krea2_turbo_int8_convrot.safetensors',
  zimage: 'z_image_turbo_bf16.safetensors',
  qwen: 'qwen_image_2.1_int8_convrot.safetensors',
  flux2: 'flux-2-klein-4b.safetensors',
  wanHigh: 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
  wanLow: 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors',
  wan22: 'wan2.2_ti2v_5B_fp16.safetensors',
  h3: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  h3image: 'minimax_h3_image_pruned_w4a8.safetensors',
}
const CLIPS = [
  'clip_l.safetensors', 't5xxl_fp16.safetensors', 'qwen3vl_4b_fp8_scaled.safetensors', 'qwen_3_4b.safetensors',
  'qwen3vl_8b_int8_convrot.safetensors', 'qwen_3_8b_fp8mixed.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
]
const VAES = [
  'ae.safetensors', 'qwen_image_vae.safetensors', 'qwen_image_2.1_vae_bf16.safetensors', 'flux2-vae.safetensors',
  'wan_2.1_vae.safetensors', 'wan2.2_vae.safetensors', 'minimax_h3_video_vae_int8_convrot.safetensors',
  'minimax_h3_audio_vae_fp32.safetensors', 'minimax_h3_image_vae_fp16.safetensors',
]

/** Every node class the builders write or ask for, read off the builder's own
 *  source, so a graph never fails for a node this fixture forgot. */
function everyNodeClass(): string[] {
  const src = readFileSync(join(__dirname, '..', 'dynamic-workflow.ts'), 'utf8')
  return [...new Set([...src.matchAll(/'([A-Z][A-Za-z0-9_]{3,})'/g)].map((m) => m[1]))]
}

function serve() {
  const combo = (key: string, values: string[]) => ({ input: { required: { [key]: [values] } } })
  const nodes: Record<string, unknown> = Object.fromEntries(everyNodeClass().map((c) => [c, { input: { required: {} } }]))
  Object.assign(nodes, {
    CheckpointLoaderSimple: combo('ckpt_name', [MODELS.sdxl]),
    UNETLoader: combo('unet_name', Object.values(MODELS).filter((m) => m !== MODELS.sdxl)),
    CLIPLoader: { input: { required: { clip_name: [CLIPS], type: [['stable_diffusion', 'flux', 'flux2', 'krea2', 'qwen_image', 'wan', 'minimax']] } } },
    DualCLIPLoader: combo('clip_name1', CLIPS),
    VAELoader: combo('vae_name', VAES),
    LoraLoader: combo('lora_name', LORAS),
    LoraLoaderModelOnly: combo('lora_name', LORAS),
  })
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes as never)
  vi.mocked(localFetch).mockImplementation((async () => ({
    ok: true, status: 200, json: async () => nodes, text: async () => JSON.stringify(nodes),
  })) as never)
}
beforeEach(serve)

/** The LoRA files on the model path that ends at `id`, upstream first. */
function chainLoras(wf: ComfyApiGraph, id: string, seen = new Set<string>()): string[] {
  if (seen.has(id)) return []
  seen.add(id)
  const node = wf[id]
  const model = node?.inputs?.model
  const up = isComfyLinkRef(model) ? chainLoras(wf, String(model[0]), seen) : []
  const lora = /^LoraLoader/.test(node?.class_type ?? '') ? node.inputs?.lora_name : undefined
  return typeof lora === 'string' ? [...up, loraFileKey(lora)] : up
}

/** Every chain end in the graph with a LoRA file in it twice. */
function twiceInAChain(wf: ComfyApiGraph): string[] {
  const found: string[] = []
  for (const [id] of apiNodes(wf)) {
    const loras = chainLoras(wf, id)
    const twice = loras.filter((l, i) => loras.indexOf(l) !== i)
    if (twice.length) found.push(`${wf[id].class_type} ${id}: ${twice.join(', ')}`)
  }
  return found
}

const allLorasIn = (wf: ComfyApiGraph) =>
  apiNodes(wf).filter(([, n]) => /^LoraLoader/.test(n.class_type)).map(([, n]) => loraFileKey(String(n.inputs?.lora_name)))

/** The user's stack: one LoRA in two spellings, and the family's own LoRA. */
const stack = (own: string[]) => [STYLE, 'loras/Style.safetensors', ...own]

const image = (model: string, own: string[] = [], extra: Record<string, unknown> = {}) => {
  const lora = stack(own)
  return {
    model, prompt: 'a lighthouse at dusk, image 1', negativePrompt: '', sampler: 'euler', scheduler: 'simple',
    steps: 8, cfgScale: 1, width: 1024, height: 1024, seed: 1, batchSize: 1,
    lora, loraStrength: lora.map(() => 0.7), ...extra,
  } as never
}
const video = (model: string, own: string[] = [], extra: Record<string, unknown> = {}) => image(model, own, { frames: 33, fps: 16, ...extra })

const CASES: Array<[string, () => ReturnType<typeof image>]> = [
  ['SDXL checkpoint', () => image(MODELS.sdxl, [], { steps: 20, cfgScale: 6 })],
  ['FLUX.1', () => image(MODELS.flux)],
  ['Krea 2', () => image(MODELS.krea)],
  ['Krea 2 with reference images (style LoRA of its own)', () => image(MODELS.krea, [KREA2_STYLE_LORA.filename], { referenceImages: ['ref.png'] })],
  ['Z-Image', () => image(MODELS.zimage)],
  ['Qwen-Image 2.1', () => image(MODELS.qwen, [], { cfgScale: 4, steps: 20 })],
  ['FLUX.2', () => image(MODELS.flux2)],
  ['Wan 2.2 14B fast (speed LoRAs of its own)', () => video(MODELS.wanHigh, [WAN_HIGH, WAN_LOW], { steps: 4, cfgScale: 1 })],
  ['Wan 2.2 TI2V 5B', () => video(MODELS.wan22, [], { steps: 20, cfgScale: 5 })],
  ['MiniMax H3 with its turbo LoRA', () => video(MODELS.h3, [H3_TURBO, H3_TURBO], { frames: 124, fps: 24 })],
  ['MiniMax H3 Image', () => image(MODELS.h3image, [], { steps: 6, width: 2048, height: 2048 })],
  ['MiniMax H3 Image edit', () => image(MODELS.h3image, [], { steps: 6, width: 2048, height: 2048, inputImage: 'src.png' })],
]

describe('A45: no built-in workflow loads one LoRA twice on one model', () => {
  it.each(CASES)('%s', async (_name, params) => {
    const wf = await buildDynamicWorkflow(params())
    expect(allLorasIn(wf)).toContain(STYLE)
    expect(twiceInAChain(wf)).toEqual([])
  })

  it('the Krea 2 style LoRA from the stack sets the strength of the graph\'s own node', async () => {
    const lora = [KREA2_STYLE_LORA.filename]
    const wf = await buildDynamicWorkflow(image(MODELS.krea, [], { lora, loraStrength: [0.6], referenceImages: ['ref.png'] }))
    const style = apiNodes(wf).filter(([, n]) => n.inputs?.lora_name === KREA2_STYLE_LORA.filename)
    expect(style).toHaveLength(1)
    expect(style[0][1].class_type).toBe('LoraLoaderModelOnly')
    expect(style[0][1].inputs?.strength_model).toBe(0.6)
  })

  it('without reference images a Krea 2 run keeps the style LoRA the user picked', async () => {
    const wf = await buildDynamicWorkflow(image(MODELS.krea, [], { lora: [KREA2_STYLE_LORA.filename], loraStrength: [0.5] }))
    expect(allLorasIn(wf)).toEqual([KREA2_STYLE_LORA.filename])
  })
})

describe('A45: the stack helper', () => {
  it('joins two spellings at the sum of their strengths, drops a reserved file and hands back its strength', () => {
    const out = dedupeLoraStack(['a.safetensors', 'sub\\A.safetensors', 'b.safetensors', 'B.safetensors'], [0.5, 0.9, 1, 2], ['b.safetensors'])
    expect(out.names).toEqual(['a.safetensors'])
    expect(out.strengths[0]).toBeCloseTo(1.4)
    expect(out.reservedStrength.get('b.safetensors')).toBe(1)
  })
})

describe('A45: an imported workflow (C72)', () => {
  it('a LoRA the workflow loads itself, in another spelling, and a doubled stack entry go in once', () => {
    const wf: ComfyApiGraph = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: MODELS.krea, weight_dtype: 'default' } },
      '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'krea\\krea2_style_reference.safetensors', strength_model: 1 } },
      '3': { class_type: 'KSampler', inputs: { model: ['2', 0] } },
    }
    const installed = [...LORAS, 'krea\\krea2_style_reference.safetensors']
    const res = injectLoraStack(wf, { model: { nodeId: '1' } } as never, [KREA2_STYLE_LORA.filename, STYLE, 'Style.safetensors'], [1, 0.7, 0.7], installed)
    expect(res.alreadyThere).toEqual([KREA2_STYLE_LORA.filename])
    expect(res.added).toEqual([STYLE])
    expect(twiceInAChain(wf)).toEqual([])
  })
})
