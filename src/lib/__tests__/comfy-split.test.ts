/**
 * C56 (3.1.0): one picture or video model across two cards, without a real
 * two-card machine. What is checked here:
 *   - the graph surgery on graphs LU's own builders make (Flux, Wan 2.2) and
 *     on the real LTX 2.5 template of Comfy-Org (two VAEs, two text models,
 *     a subgraph), with node definitions written down from ComfyUI v0.42.4
 *   - the shapes it must leave alone (a LoRA chain, a graph that already
 *     places its parts, an unknown node)
 *   - the check that the running ComfyUI really sees the two cards in the
 *     right order (simulated /system_stats of a 4090 + 5080 machine)
 *
 * The other half, ComfyUI being started with both cards, is in Rust
 * (commands/gpu_roles.rs, `the_split_*` tests).
 *
 * Run: npx vitest run src/lib/__tests__/comfy-split.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComfyApiGraph } from '../../types/comfy-graph'
import type { ComfyNodeDefs } from '../../api/comfy-ui-format'

vi.mock('../../api/comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../../api/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

const { splitAcrossCards, comfySeesSplit, SELECT_CLIP_DEVICE, SELECT_VAE_DEVICE } = await import('../comfy-split')
const { getAllNodeInfo } = await import('../../api/comfyui-nodes')
const { localFetch } = await import('../../api/backend')
const { useSettingsStore } = await import('../../stores/settingsStore')
const { withComfySplit } = await import('../../api/comfy-split')

/** RETURN_TYPES of the core nodes involved, from the ComfyUI v0.42.4 sources
 *  (nodes.py, comfy_extras/*). */
const OUTPUTS: Record<string, string[]> = {
  CheckpointLoaderSimple: ['MODEL', 'CLIP', 'VAE'],
  UNETLoader: ['MODEL'],
  UnetLoaderGGUF: ['MODEL'],
  CLIPLoader: ['CLIP'],
  DualCLIPLoader: ['CLIP'],
  TripleCLIPLoader: ['CLIP'],
  QuadrupleCLIPLoader: ['CLIP'],
  VAELoader: ['VAE'],
  LoraLoader: ['MODEL', 'CLIP'],
  LoraLoaderModelOnly: ['MODEL'],
  CLIPSetLastLayer: ['CLIP'],
  CLIPTextEncode: ['CONDITIONING'],
  CLIPVisionLoader: ['CLIP_VISION'],
  KSampler: ['LATENT'],
  VAEDecode: ['IMAGE'],
  VAEDecodeTiled: ['IMAGE'],
  VAEEncode: ['LATENT'],
  EmptySD3LatentImage: ['LATENT'],
  EmptyLatentImage: ['LATENT'],
  ModelSamplingSD3: ['MODEL'],
  Wan22ImageToVideoLatent: ['LATENT'],
  SaveImage: [],
  SaveVideo: [],
  CreateVideo: ['VIDEO'],
  VHS_VideoCombine: ['VHS_FILENAMES'],
  SelectCLIPDevice: ['CLIP'],
  SelectVAEDevice: ['VAE'],
}
const outputsOf = (cls: string) => OUTPUTS[cls]

const BOTH = { clip: true, vae: true }

/** Every link in the graph that carries a CLIP or a VAE, with what reads it. */
function partLinks(g: ComfyApiGraph, outs: (c: string) => readonly string[] | undefined) {
  const found: Array<{ reader: string; input: string; from: string; type: string }> = []
  for (const [id, node] of Object.entries(g)) {
    for (const [input, v] of Object.entries(node.inputs ?? {})) {
      if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'number') continue
      const src = g[v[0]]
      const type = src ? outs(src.class_type)?.[v[1]] : undefined
      if (type === 'CLIP' || type === 'VAE') found.push({ reader: `${id}:${node.class_type}`, input, from: src!.class_type, type })
    }
  }
  return found
}

/** After the split every text encoder and VAE reader either is a Select
 *  node or a node that hands a CLIP on (LoRA), or reads from one of those. */
function everyPartGoesThroughTheSecondCard(g: ComfyApiGraph, outs: (c: string) => readonly string[] | undefined) {
  for (const l of partLinks(g, outs)) {
    const isSelect = l.reader.endsWith(`:${SELECT_CLIP_DEVICE}`) || l.reader.endsWith(`:${SELECT_VAE_DEVICE}`)
    const fromLoader = !['SelectCLIPDevice', 'SelectVAEDevice', 'LoraLoader', 'CLIPSetLastLayer'].includes(l.from)
    if (fromLoader) expect(isSelect, `${l.reader}.${l.input} reads ${l.type} straight from ${l.from}`).toBe(true)
  }
  for (const node of Object.values(g)) {
    if (node.class_type === SELECT_CLIP_DEVICE || node.class_type === SELECT_VAE_DEVICE) {
      expect(node.inputs?.device).toBe('gpu:1')
    }
  }
}

describe('the graph surgery', () => {
  it('Flux as LU builds it: one CLIP node and one VAE node, every reader rewired, input untouched', async () => {
    vi.mocked(localFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        CLIPLoader: { input: { required: { clip_name: [['t5xxl_fp8_e4m3fn.safetensors', 'clip_l.safetensors']] } } },
        VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
        UNETLoader: { input: { required: { unet_name: [['flux1-dev-fp8.safetensors']] } } },
      }),
    } as never)
    const { buildFluxImgWorkflow } = await import('../../api/comfyui')
    const g = await buildFluxImgWorkflow({
      model: 'flux1-dev-fp8.safetensors', prompt: 'a red apple', negativePrompt: '',
      sampler: 'euler', scheduler: 'simple', steps: 20, cfgScale: 1, width: 1024, height: 1024, seed: 1, batchSize: 1,
    })
    const before = JSON.stringify(g)
    const { graph, inserted } = splitAcrossCards(g, outputsOf, BOTH)
    expect(JSON.stringify(g)).toBe(before)
    expect(inserted).toEqual(['CLIPLoader:0 -> SelectCLIPDevice', 'VAELoader:0 -> SelectVAEDevice'])
    expect(graph['10']).toMatchObject({ class_type: 'SelectCLIPDevice', inputs: { clip: ['2', 0], device: 'gpu:1' } })
    expect(graph['11']).toMatchObject({ class_type: 'SelectVAEDevice', inputs: { vae: ['3', 0], device: 'gpu:1' } })
    // Both prompts and the decode read the moved parts; the model stays put.
    expect(graph['4'].inputs?.clip).toEqual(['10', 0])
    expect(graph['5'].inputs?.clip).toEqual(['10', 0])
    expect(graph['8'].inputs?.vae).toEqual(['11', 0])
    expect(graph['7'].inputs?.model).toEqual(['1', 0])
    everyPartGoesThroughTheSecondCard(graph, outputsOf)
  })

  it('Wan 2.2 as LU builds it: the UMT5 encoder and the Wan VAE move, the latent node reads the moved VAE', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      UNETLoader: { input: { required: { unet_name: [['wan2.2_ti2v_5B_fp16.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['wan2.2_vae.safetensors']] } } },
      Wan22ImageToVideoLatent: { input: { required: { vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] }, optional: { start_image: ['IMAGE', {}] } } },
      ModelSamplingSD3: { input: { required: { model: ['MODEL'], shift: ['FLOAT'] } } },
      KSampler: { input: { required: {} } },
      CLIPTextEncode: { input: { required: {} } },
      VAEDecode: { input: { required: {} } },
      ImageScale: { input: { required: {} } },
      LoadImage: { input: { required: {} } },
      VHS_VideoCombine: { input: { required: {} } },
    } as never)
    vi.mocked(localFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
        VAELoader: { input: { required: { vae_name: [['wan2.2_vae.safetensors']] } } },
      }),
    } as never)
    const { buildDynamicWorkflow } = await import('../../api/dynamic-workflow')
    const g = await buildDynamicWorkflow({
      model: 'wan2.2_ti2v_5B_fp16.safetensors', prompt: 'a red apple', negativePrompt: '',
      sampler: 'euler', scheduler: 'simple', steps: 30, cfgScale: 5, width: 1024, height: 576, seed: 42, batchSize: 1,
      frames: 49, fps: 24,
    } as never)
    const { graph, inserted } = splitAcrossCards(g, outputsOf, BOTH)
    expect(inserted.sort()).toEqual(['CLIPLoader:0 -> SelectCLIPDevice', 'VAELoader:0 -> SelectVAEDevice'])
    const latent = Object.values(graph).find((n) => n.class_type === 'Wan22ImageToVideoLatent')!
    const vaeRef = latent.inputs?.vae as [string, number]
    expect(graph[vaeRef[0]].class_type).toBe('SelectVAEDevice')
    everyPartGoesThroughTheSecondCard(graph, outputsOf)
  })

  it('a LoRA chain: the node sits behind the loader, the LoRA hands the moved copy on and gets none of its own', () => {
    const g: ComfyApiGraph = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
      '2': { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['1', 1], lora_name: 'a.safetensors', strength_model: 1, strength_clip: 1 } },
      '3': { class_type: 'CLIPSetLastLayer', inputs: { clip: ['2', 1], stop_at_clip_layer: -2 } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['3', 0] } },
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['3', 0] } },
      '6': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '7': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['1', 2] } },
      '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'x' } },
    }
    const { graph, inserted } = splitAcrossCards(g, outputsOf, BOTH)
    expect(inserted).toEqual(['CheckpointLoaderSimple:1 -> SelectCLIPDevice', 'CheckpointLoaderSimple:2 -> SelectVAEDevice'])
    expect(graph['2'].inputs?.clip).toEqual(['10', 0])
    expect(graph['3'].inputs?.clip).toEqual(['2', 1])
    expect(graph['8'].inputs?.vae).toEqual(['11', 0])
    // The checkpoint's model output is not touched.
    expect(graph['2'].inputs?.model).toEqual(['1', 0])
    everyPartGoesThroughTheSecondCard(graph, outputsOf)
  })

  it('a graph that places its parts itself, an unknown loader and a part nobody reads are left alone', () => {
    const g: ComfyApiGraph = {
      '1': { class_type: 'CLIPLoader', inputs: { clip_name: 't5.safetensors' } },
      '2': { class_type: 'SelectCLIPDevice', inputs: { clip: ['1', 0], device: 'gpu:0' } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } },
      '4': { class_type: 'SomeoneElsesLoader', inputs: {} },
      '5': { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['4', 0] } },
      '6': { class_type: 'VAELoader', inputs: { vae_name: 'unused.safetensors' } },
    }
    const out = splitAcrossCards(g, outputsOf, BOTH)
    expect(out.inserted).toEqual([])
    expect(out.graph).toBe(g)
  })

  it('a ComfyUI that has only one of the two nodes gets only that one', () => {
    const g: ComfyApiGraph = {
      '1': { class_type: 'CLIPLoader', inputs: {} },
      '2': { class_type: 'VAELoader', inputs: {} },
      '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 0] } },
      '4': { class_type: 'VAEDecode', inputs: { vae: ['2', 0] } },
    }
    expect(splitAcrossCards(g, outputsOf, { clip: false, vae: true }).inserted).toEqual(['VAELoader:0 -> SelectVAEDevice'])
    expect(splitAcrossCards(g, outputsOf, { clip: false, vae: false }).graph).toBe(g)
  })

  it('the real LTX 2.5 template (two VAEs, two text models, a subgraph): every part moves', async () => {
    const DIR = join(process.cwd(), 'src/api/__tests__/fixtures/comfy-ui')
    const defs = JSON.parse(readFileSync(join(DIR, 'object-info-ltx25.json'), 'utf8')) as ComfyNodeDefs
    const text = readFileSync(join(DIR, 'templates/video_ltx2_5_i2v.json'), 'utf8')
    const { readWorkflowText } = await import('../../api/workflow-import')
    const read = await readWorkflowText(text, async (types: string[]) => {
      const out: ComfyNodeDefs = {}
      for (const t of types) if (defs[t]) out[t] = defs[t]
      return out
    })
    if (!read.ok) throw new Error(read.reason)
    const outs = (cls: string) => (defs[cls] as { output?: string[] } | undefined)?.output ?? OUTPUTS[cls]
    const before = partLinks(read.graph, outs)
    expect(before.length).toBeGreaterThan(4)
    const { graph, inserted } = splitAcrossCards(read.graph, outs, BOTH)
    // Two text models (Gemma encoder, prompt enhancer) and two VAEs (video, audio).
    expect(inserted.filter((s) => s.endsWith('SelectCLIPDevice'))).toHaveLength(2)
    expect(inserted.filter((s) => s.endsWith('SelectVAEDevice'))).toHaveLength(2)
    everyPartGoesThroughTheSecondCard(graph, outs)
    // New ids never collide with the template's own.
    expect(Object.keys(graph)).toHaveLength(Object.keys(read.graph).length + 4)
  })
})

/** /system_stats of ComfyUI v0.42.4 on the 4090 + 5080 machine, as LU starts
 *  it with the split on: the model card first. */
const STATS_SPLIT = [
  { name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync', type: 'cuda', index: 0, vram_total: 25757220864 },
  { name: 'cuda:1 NVIDIA GeForce RTX 5080 : cudaMallocAsync', type: 'cuda', index: 1, vram_total: 17094475776 },
]

describe('does the running ComfyUI see the split', () => {
  it('two cards in the right order: yes', () => {
    expect(comfySeesSplit(STATS_SPLIT, 'NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5080')).toBe(true)
  })
  it('one card (started before the setting, or a one-card box): no', () => {
    expect(comfySeesSplit([STATS_SPLIT[0]], 'NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5080')).toBe(false)
    expect(comfySeesSplit([{ name: 'cpu', type: 'cpu' }], 'a', 'b')).toBe(false)
    expect(comfySeesSplit(undefined, 'a', 'b')).toBe(false)
  })
  it('the cards the other way round (a ComfyUI LU did not start): no', () => {
    expect(comfySeesSplit([...STATS_SPLIT].reverse(), 'NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5080')).toBe(false)
  })
  it('two identical cards: yes', () => {
    const twins = [
      { name: 'cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync', type: 'cuda' },
      { name: 'cuda:1 NVIDIA GeForce RTX 3090 : cudaMallocAsync', type: 'cuda' },
    ]
    expect(comfySeesSplit(twins, 'NVIDIA GeForce RTX 3090', 'NVIDIA GeForce RTX 3090')).toBe(true)
  })
})

describe('at submit (withComfySplit)', () => {
  const flux: ComfyApiGraph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux.safetensors' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 't5.safetensors' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  }
  const split = {
    model: { vendor: 'nvidia' as const, index: 0, name: 'NVIDIA GeForce RTX 4090' },
    helper: { vendor: 'nvidia' as const, index: 1, name: 'NVIDIA GeForce RTX 5080' },
  }
  const nodeInfo = Object.fromEntries(Object.entries(OUTPUTS).map(([k, v]) => [k, { input: { required: {} }, output: v }]))
  const stats = (devices: unknown[]) => ({ ok: true, json: async () => ({ devices }) }) as never

  beforeEach(() => {
    vi.mocked(localFetch).mockReset()
    vi.mocked(getAllNodeInfo).mockReset()
    vi.mocked(getAllNodeInfo).mockResolvedValue(nodeInfo as never)
  })
  const setRoles = (comfySplit: unknown) =>
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, gpuRoles: { chat: null, comfy: null, ...(comfySplit ? { comfySplit } : {}) } as never } }))

  it('off (every one-card machine): the same object, and not one request', async () => {
    setRoles(null)
    expect(await withComfySplit(flux)).toBe(flux)
    expect(localFetch).not.toHaveBeenCalled()
  })

  it('on, and ComfyUI sees both cards: the parts move', async () => {
    setRoles(split)
    vi.mocked(localFetch).mockResolvedValue(stats(STATS_SPLIT))
    const out = await withComfySplit(flux)
    expect(Object.values(out).map((n) => n.class_type)).toEqual(expect.arrayContaining(['SelectCLIPDevice', 'SelectVAEDevice']))
  })

  it('on, but ComfyUI still runs on one card: unchanged', async () => {
    setRoles(split)
    vi.mocked(localFetch).mockResolvedValue(stats([STATS_SPLIT[0]]))
    expect(await withComfySplit(flux)).toBe(flux)
  })

  it('on, but this ComfyUI has no Select nodes (older than 0.23): unchanged', async () => {
    setRoles(split)
    vi.mocked(localFetch).mockResolvedValue(stats(STATS_SPLIT))
    const { SelectCLIPDevice: _c, SelectVAEDevice: _v, ...old } = nodeInfo
    void _c; void _v
    vi.mocked(getAllNodeInfo).mockResolvedValue(old as never)
    expect(await withComfySplit(flux)).toBe(flux)
  })

  it('on, and ComfyUI does not answer: unchanged, no throw', async () => {
    setRoles(split)
    vi.mocked(localFetch).mockRejectedValue(new Error('connection refused'))
    expect(await withComfySplit(flux)).toBe(flux)
  })

  it('a stored split on one card or on AMD is no split', async () => {
    setRoles({ model: split.model, helper: split.model })
    expect(await withComfySplit(flux)).toBe(flux)
    setRoles({ model: { ...split.model, vendor: 'amd' }, helper: { ...split.helper, vendor: 'amd' } })
    expect(await withComfySplit(flux)).toBe(flux)
    expect(localFetch).not.toHaveBeenCalled()
  })
})
