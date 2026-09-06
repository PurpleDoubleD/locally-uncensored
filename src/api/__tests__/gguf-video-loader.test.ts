/**
 * GGUF video models must load through UnetLoaderGGUF (stasicby-max, D#93,
 * 2026-08-01): "Failed to submit: ComfyUI rejected workflow: Node 1
 * (UNETLoader): Value not in list" on Wan 2.2 Rapid AIO (Uncensored I2V,
 * GGUF) and NSFW Wan 14B (Uncensored, GGUF).
 *
 * Core `UNETLoader` only enumerates .safetensors, so handing it a .gguf gets
 * the whole workflow rejected. The catalog ships exactly two uncensored video
 * quants as GGUF (discover.ts: nsfw_wan_14b 9.0 GB, wan2.2-i2v-rapid-aio
 * 10.1 GB), so before this fix every generation with the uncensored video
 * models failed — 19 GB of downloads that could never run, the same shape as
 * the CogVideoX node-name bug we pulled in 2.5.9.
 *
 * The GGUF-aware loader already existed but was only wired into the lipsync
 * and motion lanes. These tests pin it on every path a user can reach: the
 * generic video builder (where both catalog entries actually land, since a
 * 14B "rapid AIO" merge classifies as plain wan), the separate Wan 2.2
 * TI2V-5B builder, and the legacy builder that still carries the VRAM handoff
 * and the agent's video tool.
 *
 * Run: npx vitest run src/api/__tests__/gguf-video-loader.test.ts
 */
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
import { buildTxt2VidWorkflow, classifyModel } from '../comfyui'
import { localFetch } from '../backend'
import { classTypes, nodeOf, type BuiltNode } from './graph-test-support'
import type { ComfyApiGraph } from '../../types/comfy-graph'

const RAPID_AIO = 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf'
const NSFW_WAN14B = 'nsfw_wan_14b_e15_q4_k.gguf'
// A real Wan 2.2 TI2V-5B quant — the only shape that reaches the separate
// Wan 2.2 builder. The two catalog entries above are 14B merges and
// deliberately classify as plain 'wan' (comfyui.ts), so they take the generic
// unet_video path. Both builders needed the fix.
const WAN22_5B_GGUF = 'wan2_2_ti2v_5b_q8.gguf'

/** /object_info for a ComfyUI that can run Wan 2.1 + 2.2 AND has the city96
 *  GGUF pack installed. Each loader lists its own file types, which is exactly
 *  why the wrong one rejects the model. */
const NODES_WITH_GGUF = {
  UNETLoader: { input: { required: { unet_name: [['wan2.2_ti2v_5B_fp16.safetensors', 'wan2.1_t2v_14B_fp8.safetensors']] } } },
  UnetLoaderGGUF: { input: { required: { unet_name: [[RAPID_AIO, NSFW_WAN14B, WAN22_5B_GGUF]] } } },
  CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
  VAELoader: { input: { required: { vae_name: [['wan2.2_vae.safetensors', 'wan_2.1_vae.safetensors']] } } },
  Wan22ImageToVideoLatent: { input: { required: { vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] }, optional: { start_image: ['IMAGE', {}] } } },
  EmptyHunyuanLatentVideo: { input: { required: {} } },
  ModelSamplingSD3: { input: { required: { model: ['MODEL'], shift: ['FLOAT'] } } },
  KSampler: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  VHS_VideoCombine: { input: { required: {} } },
  SaveAnimatedWEBP: { input: { required: {} } },
}

const withoutGgufPack = () => {
  const { UnetLoaderGGUF: _dropped, ...rest } = NODES_WITH_GGUF
  return rest
}

/** VAE and CLIP lookups go to ComfyUI over localFetch, not through the cached
 *  node info, so every builder test needs both wired. */
const serveObjectInfo = (nodes: Record<string, unknown>) => {
  vi.mocked(localFetch).mockImplementation((async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (typeof url === 'string' && url.includes('object_info') ? nodes : {}),
    text: async () => JSON.stringify(nodes),
  })) as never)
}

/** Both mock seams at once: the cached node catalog and the live lookups. */
const serveComfy = (nodes: Record<string, unknown>) => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes as never)
  serveObjectInfo(nodes)
}

const videoParams = {
  prompt: 'a woman walking through neon rain', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple',
  steps: 20, cfgScale: 5, width: 832, height: 480, seed: 42, batchSize: 1,
  frames: 49, fps: 16,
}

// nodeOf/nodesOf/classTypes leben in graph-test-support.ts — siehe dort, warum
// eine Graph-Fixture als ComfyApiGraph statt als Record<string, any> gelesen wird.
const loaderOf = (wf: ComfyApiGraph): BuiltNode | undefined =>
  (nodeOf(wf, 'UnetLoaderGGUF') ?? nodeOf(wf, 'UNETLoader'))?.[1]

describe('the catalog entries this bug was reported against', () => {
  it('both uncensored video quants are GGUF', () => {
    expect(RAPID_AIO.endsWith('.gguf')).toBe(true)
    expect(NSFW_WAN14B.endsWith('.gguf')).toBe(true)
  })
  it('both take the generic wan path, so that builder is the one users hit', () => {
    expect(classifyModel(RAPID_AIO)).toBe('wan')
    expect(classifyModel(NSFW_WAN14B)).toBe('wan')
  })
  it('a TI2V-5B quant still routes to the separate Wan 2.2 builder', () => {
    expect(classifyModel(WAN22_5B_GGUF)).toBe('wan22')
  })
})

describe('generic video builder — the two uncensored catalog models', () => {
  beforeEach(() => serveComfy(NODES_WITH_GGUF))

  for (const model of [RAPID_AIO, NSFW_WAN14B]) {
    it(`loads ${model} through UnetLoaderGGUF, never core UNETLoader`, async () => {
      const wf = await buildDynamicWorkflow({ ...videoParams, model } as never)
      expect(classTypes(wf)).toContain('UnetLoaderGGUF')
      expect(classTypes(wf)).not.toContain('UNETLoader')
      expect(loaderOf(wf)!.inputs.unet_name).toBe(model)
    })
  }

  it('the GGUF loader takes no weight_dtype (not in that node schema)', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: NSFW_WAN14B } as never)
    expect(loaderOf(wf)!.inputs).not.toHaveProperty('weight_dtype')
  })

  it('a safetensors Wan model still uses core UNETLoader (regression guard)', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: 'wan2.1_t2v_14B_fp8.safetensors' } as never)
    expect(classTypes(wf)).toContain('UNETLoader')
    expect(classTypes(wf)).not.toContain('UnetLoaderGGUF')
    expect(loaderOf(wf)!.inputs.weight_dtype).toBe('default')
  })

  it('without the GGUF pack it names the pack instead of letting ComfyUI reject the graph', async () => {
    serveComfy(withoutGgufPack())
    await expect(buildDynamicWorkflow({ ...videoParams, model: NSFW_WAN14B } as never))
      .rejects.toThrow(/ComfyUI-GGUF node pack/i)
  })
})

describe('Wan 2.2 TI2V-5B builder', () => {
  beforeEach(() => serveComfy(NODES_WITH_GGUF))

  it('loads a GGUF quant through UnetLoaderGGUF', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: WAN22_5B_GGUF } as never)
    expect(classTypes(wf)).toContain('UnetLoaderGGUF')
    expect(classTypes(wf)).not.toContain('UNETLoader')
    expect(loaderOf(wf)!.inputs.unet_name).toBe(WAN22_5B_GGUF)
  })

  it('keeps core UNETLoader for the safetensors build (regression guard)', async () => {
    const wf = await buildDynamicWorkflow({ ...videoParams, model: 'wan2.2_ti2v_5B_fp16.safetensors' } as never)
    expect(classTypes(wf)).toContain('UNETLoader')
    expect(classTypes(wf)).not.toContain('UnetLoaderGGUF')
  })

  it('without the GGUF pack it names the pack', async () => {
    serveComfy(withoutGgufPack())
    await expect(buildDynamicWorkflow({ ...videoParams, model: WAN22_5B_GGUF } as never))
      .rejects.toThrow(/ComfyUI-GGUF node pack/i)
  })
})

describe('legacy builder — still carries the VRAM handoff and the agent video tool', () => {
  beforeEach(() => serveComfy(NODES_WITH_GGUF))

  it('buildTxt2VidWorkflow loads a GGUF quant through UnetLoaderGGUF', async () => {
    const wf = await buildTxt2VidWorkflow({ ...videoParams, model: NSFW_WAN14B } as never, 'wan')
    expect(classTypes(wf)).toContain('UnetLoaderGGUF')
    expect(classTypes(wf)).not.toContain('UNETLoader')
  })

  it('buildTxt2VidWorkflow keeps core UNETLoader for safetensors', async () => {
    const wf = await buildTxt2VidWorkflow({ ...videoParams, model: 'wan2.1_t2v_14B_fp8.safetensors' } as never, 'wan')
    expect(classTypes(wf)).toContain('UNETLoader')
    expect(classTypes(wf)).not.toContain('UnetLoaderGGUF')
  })

  it('buildTxt2VidWorkflow without the GGUF pack names the pack', async () => {
    serveComfy(withoutGgufPack())
    await expect(buildTxt2VidWorkflow({ ...videoParams, model: NSFW_WAN14B } as never, 'wan'))
      .rejects.toThrow(/ComfyUI-GGUF node pack/i)
  })
})
