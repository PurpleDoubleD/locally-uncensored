/**
 * Wan 2.2 TI2V-5B — unified text+image-to-video (David 2026-06-11: "wan 2.2
 * komplett in app … dann ausgiebig testen").
 *
 * Wan 2.2 5B is ONE model that does both T2V and I2V via Wan22ImageToVideoLatent
 * (an OPTIONAL start_image switches the mode). It needs its own VAE (wan2.2_vae —
 * higher compression than 2.1) and the shared UMT5 text encoder. These tests pin:
 *   - classification / dual-capability routing (classifyModel, isI2VModel, isT2VCapable)
 *   - the strategy gate (needs the Wan22ImageToVideoLatent node)
 *   - the built graph for BOTH modes (start_image only on I2V; faithful ImageScale)
 *   - the length grid (4k+1) and the I2V resolution picker
 *
 * Run: npx vitest run src/api/__tests__/wan22-workflow.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  // comfyuiUrl reads `window` (isTauri) — stub it for the node test env.
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow, determineStrategy, snapWanLength } from '../dynamic-workflow'
import { categorizeNodes, getAllNodeInfo, type CategorizedNodes } from '../comfyui-nodes'
import { classifyModel, isI2VModel, isT2VCapable, findMatchingVAE } from '../comfyui'
import { localFetch } from '../backend'
import { resolveI2VResolution } from '../vram-handoff'
import { nodeOf, nodesOf } from './graph-test-support'
import { inputNumber } from '../../types/comfy-graph'

// Minimal /object_info for a ComfyUI that can run Wan 2.2 5B.
const WAN22_NODES = {
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
}

const wan22Params = {
  model: 'wan2.2_ti2v_5B_fp16.safetensors',
  prompt: 'a red apple on a white plate', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple',
  steps: 30, cfgScale: 5, width: 1024, height: 576, seed: 42, batchSize: 1,
  frames: 49, fps: 24,
}

// nodeOf/nodesOf/classTypes leben in graph-test-support.ts — siehe dort, warum
// eine Graph-Fixture als ComfyApiGraph statt als Record<string, any> gelesen wird.

describe('classifyModel — Wan 2.2 vs 2.1', () => {
  it('classifies the TI2V-5B file as wan22', () => {
    expect(classifyModel('wan2.2_ti2v_5B_fp16.safetensors')).toBe('wan22')
  })
  it('matches the various 2.2 spellings', () => {
    expect(classifyModel('Wan2.2-TI2V-5B.safetensors')).toBe('wan22')
    expect(classifyModel('wan2_2_ti2v_5b.gguf')).toBe('wan22')
    expect(classifyModel('wan22_5b_q8.gguf')).toBe('wan22')
  })
  it('does NOT misfire on Wan 2.1 (regression guard)', () => {
    expect(classifyModel('wan2.1_t2v_1.3B_bf16.safetensors')).toBe('wan')
    expect(classifyModel('wan2.1_t2v_14B_fp8.safetensors')).toBe('wan')
  })
})

describe('dual-capability predicates', () => {
  it('Wan 2.2 is BOTH I2V-capable and T2V-capable', () => {
    const f = 'wan2.2_ti2v_5B_fp16.safetensors'
    expect(isI2VModel(f)).toBe(true)   // shows up in the I2V picker list
    expect(isT2VCapable(f)).toBe(true) // AND stays in the T2V picker list
  })
  it('Wan 2.1 is T2V-only (not an I2V model)', () => {
    expect(isI2VModel('wan2.1_t2v_14B_fp8.safetensors')).toBe(false)
    expect(isT2VCapable('wan2.1_t2v_14B_fp8.safetensors')).toBe(true)
  })
  it('SVD / FramePack stay I2V-ONLY (excluded from T2V)', () => {
    expect(isT2VCapable('svd_xt_1_1.safetensors')).toBe(false)
    expect(isT2VCapable('FramePackI2V_HY_fp8_e4m3fn.safetensors')).toBe(false)
  })
})

describe('snapWanLength — 4k+1 grid (Wan 2.2 VAE temporal stride 4)', () => {
  it('snaps common durations at 24 fps to the nearest valid length', () => {
    expect(snapWanLength(48)).toBe(49)   // 2 s
    expect(snapWanLength(72)).toBe(73)   // 3 s
    expect(snapWanLength(120)).toBe(121) // 5 s
    expect(snapWanLength(168)).toBe(169) // 7 s
  })
  it('already-valid lengths pass through; tiny values floor to 5', () => {
    expect(snapWanLength(49)).toBe(49)
    expect(snapWanLength(1)).toBe(5)
    expect(snapWanLength(0)).toBe(5)
  })
  it('every result satisfies (length - 1) % 4 === 0', () => {
    for (const f of [13, 30, 47, 50, 99, 150, 200]) {
      expect((snapWanLength(f) - 1) % 4).toBe(0)
    }
  })
})

describe('determineStrategy — wan22 gate', () => {
  const full: CategorizedNodes = categorizeNodes(WAN22_NODES as never)
  const models = { checkpoints: [], unets: [], vaes: [], clips: [], loras: [], controlnets: [], ipadapters: [], motionModels: [] }

  it('routes to wan22 when UNET + CLIP + VAE + Wan22ImageToVideoLatent are present', () => {
    const r = determineStrategy('wan22', true, full, models as never)
    expect(r.strategy).toBe('wan22')
  })
  it('is unavailable (with an update hint) when the Wan 2.2 latent node is missing', () => {
    const noLatent: CategorizedNodes = { ...full, latentInit: full.latentInit.filter(n => n !== 'Wan22ImageToVideoLatent') }
    const r = determineStrategy('wan22', true, noLatent, models as never)
    expect(r.strategy).toBe('unavailable')
    expect(r.reason).toMatch(/Wan22ImageToVideoLatent|Update ComfyUI/i)
  })
})

describe('buildDynamicWorkflow — Wan 2.2 graph', () => {
  beforeEach(() => {
    vi.mocked(getAllNodeInfo).mockResolvedValue(WAN22_NODES as never)
  })

  it('T2V (no inputImage): Wan22 latent has NO start_image, uses the 2.2 VAE + UMT5', async () => {
    const wf = await buildDynamicWorkflow({ ...wan22Params } as never)

    const latent = nodeOf(wf, 'Wan22ImageToVideoLatent')!
    expect(latent).toBeDefined()
    expect(latent[1].inputs.start_image).toBeUndefined() // T2V: no still
    expect(latent[1].inputs.length).toBe(49)
    expect(latent[1].inputs.batch_size).toBe(1)

    const vae = nodeOf(wf, 'VAELoader')!
    expect(vae[1].inputs.vae_name).toBe('wan2.2_vae.safetensors')
    const clip = nodeOf(wf, 'CLIPLoader')!
    expect(clip[1].inputs.clip_name).toBe('umt5_xxl_fp8_e4m3fn_scaled.safetensors')
    expect(clip[1].inputs.type).toBe('wan')

    // No image nodes on the T2V path.
    expect(nodeOf(wf, 'LoadImage')).toBeUndefined()
    expect(nodeOf(wf, 'ImageScale')).toBeUndefined()
  })

  it('T2V wires the sampler through ModelSamplingSD3 (Wan shift)', async () => {
    const wf = await buildDynamicWorkflow({ ...wan22Params } as never)
    const [shiftId, shift] = nodeOf(wf, 'ModelSamplingSD3')!
    expect(shift.inputs.shift).toBe(8.0)
    const [unetId] = nodeOf(wf, 'UNETLoader')!
    expect(shift.inputs.model).toEqual([unetId, 0])
    const sampler = nodeOf(wf, 'KSampler')![1]
    expect(sampler.inputs.model).toEqual([shiftId, 0]) // sampler reads the shifted model
  })

  it('I2V (inputImage set): LoadImage → ImageScale(crop center) → Wan22 start_image', async () => {
    const wf = await buildDynamicWorkflow({ ...wan22Params, inputImage: 'lu_apple_input.png' } as never)

    const load = nodeOf(wf, 'LoadImage')!
    expect(load[1].inputs.image).toBe('lu_apple_input.png')
    const [scaleId, scale] = nodeOf(wf, 'ImageScale')!
    expect(scale.inputs.crop).toBe('center')               // aspect-fill, no squish
    expect(scale.inputs.image).toEqual([load[0], 0])

    const latent = nodeOf(wf, 'Wan22ImageToVideoLatent')![1]
    expect(latent.inputs.start_image).toEqual([scaleId, 0]) // the still drives the opening frame
  })

  it('snaps off-grid duration + dims (120 frames → 121, 1000×570 → /32)', async () => {
    const wf = await buildDynamicWorkflow({ ...wan22Params, frames: 120, width: 1000, height: 570 } as never)
    const latent = nodeOf(wf, 'Wan22ImageToVideoLatent')![1]
    expect(inputNumber(latent, 'length')).toBe(121)
    // Erst nachweisen, dass es die Zahl ueberhaupt gibt: `undefined % 32` ist
    // NaN und ein fehlender Input duerfte nicht wie ein Rest von 0 aussehen.
    const width = inputNumber(latent, 'width')
    const height = inputNumber(latent, 'height')
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(width! % 32).toBe(0)
    expect(height! % 32).toBe(0)
  })

  it('produces a video output node (VHS preferred when present)', async () => {
    const wf = await buildDynamicWorkflow({ ...wan22Params } as never)
    expect(nodesOf(wf, 'VHS_VideoCombine').length).toBe(1)
  })
})

describe('findMatchingVAE — Wan 2.1 vs 2.2 (48-channel regression)', () => {
  // David's EXACT live VAELoader enum after the Wan 2.2 bundle install. Note
  // wan2.2_vae sorts BEFORE wan_2.1_vae — the old first-.includes('wan') hit
  // decoded Wan 2.1 (16-ch latents) with the 2.2 VAE (48-ch) and every Wan 2.1
  // generation died with "expected input to have 48 channels, but got 16".
  const LIVE_VAE_ENUM = ['hunyuanvideo15_vae_fp16.safetensors', 'sdxl_vae.safetensors', 'wan2.2_vae.safetensors', 'wan_2.1_vae.safetensors', 'pixel_space']

  beforeEach(() => {
    vi.mocked(localFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ VAELoader: { input: { required: { vae_name: [LIVE_VAE_ENUM] } } } }),
    } as never)
  })

  it("'wan' (2.1) picks the 2.1 VAE even though the 2.2 file sorts first", async () => {
    expect(await findMatchingVAE('wan')).toBe('wan_2.1_vae.safetensors')
  })
  it("'wan22' picks the 2.2 VAE", async () => {
    expect(await findMatchingVAE('wan22')).toBe('wan2.2_vae.safetensors')
  })
  it("'wan' without a 2.1 file falls to a 16-channel hunyuan VAE, never the 1.5 one", async () => {
    // The 1.5 VAE is 32-channel and would crash Wan 2.1 exactly the way it
    // crashed FramePack (bob80817, D#104), so it is not a fallback at all.
    vi.mocked(localFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ VAELoader: { input: { required: { vae_name: [['wan2.2_vae.safetensors', 'hunyuanvideo15_vae_fp16.safetensors', 'hunyuan_video_vae_bf16.safetensors']] } } } }),
    } as never)
    expect(await findMatchingVAE('wan')).toBe('hunyuan_video_vae_bf16.safetensors')
  })

  it("'wan' with ONLY a 32-channel VAE on disk refuses instead of crashing later", async () => {
    vi.mocked(localFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ VAELoader: { input: { required: { vae_name: [['wan2.2_vae.safetensors', 'hunyuanvideo15_vae_fp16.safetensors']] } } } }),
    } as never)
    await expect(findMatchingVAE('wan')).rejects.toThrow('No Wan VAE found')
  })
})

describe('resolveI2VResolution — wan22 (pixel-budget for 12 GB)', () => {
  it('landscape source keeps aspect, snaps to 32, fits the ~0.6 M-px budget', () => {
    const r = resolveI2VResolution('wan22', 1920, 1080)
    expect(r.width).toBe(1024)
    expect(r.height).toBe(576)
    expect(r.width % 32).toBe(0)
    expect(r.height % 32).toBe(0)
  })
  it('portrait source stays portrait', () => {
    const r = resolveI2VResolution('wan22', 1080, 1920)
    expect(r.height).toBeGreaterThan(r.width)
    expect(r.height).toBe(1024)
    expect(r.width).toBe(576)
  })
  it('SQUARE source is budgeted to 768² — NOT 1024² (which OOMs a 3060 at 5-7 s)', () => {
    // David's red apple is 1024×1024. The old long-edge cap left it at 1024²
    // (1.05 M px, VRAM ceiling); the pixel budget pulls it to a runnable 768².
    const r = resolveI2VResolution('wan22', 1024, 1024)
    expect(r).toEqual({ width: 768, height: 768 })
    expect(r.width * r.height).toBeLessThanOrEqual(650_000)
  })
  it('a small source is NOT upscaled (only budgeted down)', () => {
    expect(resolveI2VResolution('wan22', 512, 512)).toEqual({ width: 512, height: 512 })
  })
  it('unprobed (0×0) falls back to a 16:9 landscape default', () => {
    expect(resolveI2VResolution('wan22', 0, 0)).toEqual({ width: 1024, height: 576 })
  })
})
