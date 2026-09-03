/**
 * Local Animate (I2V) restored (David 2026-07-17): a video request that
 * carries an inputImage must swap the empty latent for the family's
 * image-to-video conditioning on the MAIN builder path — WAN 2.1 i2v
 * (WanImageToVideo), Hunyuan i2v (HunyuanImageToVideo, single conditioning
 * output), LTX (LTXVImgToVideo), Cosmos (CosmosImageToVideoLatent,
 * latent-only) — with schema-driven inputs and output mapping. Mochi (t2v
 * only) and a missing family node must reject-and-report, never silently
 * ignore the source image (the lu-labs port regression that hid the lane).
 *
 * Run: npx vitest run src/api/__tests__/dynamic-workflow-i2v.test.ts
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
// The encoder/VAE resolvers hit live model listings — not what these tests pin.
// Predicates (isI2VModel/isT2VCapable) stay REAL via the actual spread.
vi.mock('../comfyui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui')>()
  return {
    ...actual,
    findMatchingCLIP: vi.fn(async () => 'mock_text_encoder.safetensors'),
    findMatchingVAE: vi.fn(async () => 'mock_vae.safetensors'),
  }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { isI2VModel, isT2VCapable } from '../comfyui'
import { nodeOf } from './graph-test-support'

// nodeOf/classTypes/nodesOf leben jetzt in graph-test-support.ts — siehe dort,
// warum eine Fixture als ComfyApiGraph und nicht als Record<string, any> gelesen
// wird.

// Core nodes every video family shares in these fixtures.
const CORE = {
  CLIPTextEncode: { input: { required: {} } },
  KSampler: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  LoadImage: { input: { required: { image: [[]] } } },
  VHS_VideoCombine: { input: { required: {} } },
  EmptyHunyuanLatentVideo: { input: { required: {} } },
}

const vidParams = (model: string) => ({
  model,
  prompt: 'gentle camera push in', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple',
  steps: 20, cfgScale: 5, width: 832, height: 480, seed: 7, batchSize: 1,
  frames: 33, fps: 16,
  inputImage: 'still.png',
})

describe('predicate coverage for the Animate picker', () => {
  it('LTX base checkpoints are dual (i2v + t2v)', () => {
    expect(isI2VModel('ltx-video-2b-v0.9.safetensors')).toBe(true)
    expect(isT2VCapable('ltx-video-2b-v0.9.safetensors')).toBe(true)
  })
  it('Cosmos Video2World is i2v-only, Text2World stays t2v-only', () => {
    expect(isI2VModel('Cosmos-1_0-Diffusion-7B-Video2World.safetensors')).toBe(true)
    expect(isT2VCapable('Cosmos-1_0-Diffusion-7B-Video2World.safetensors')).toBe(false)
    expect(isI2VModel('Cosmos-1_0-Diffusion-7B-Text2World.safetensors')).toBe(false)
    expect(isT2VCapable('Cosmos-1_0-Diffusion-7B-Text2World.safetensors')).toBe(true)
  })
  it('WAN 2.1 t2v stays out of the Animate list', () => {
    expect(isI2VModel('wan2.1_t2v_1.3B_bf16.safetensors')).toBe(false)
  })
})

describe('buildDynamicWorkflow — I2V override on the main path', () => {
  beforeEach(() => vi.clearAllMocks())

  it('WAN i2v: WanImageToVideo consumes pos/neg/vae/start_image and re-points the sampler', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['wan2.1_i2v_14B_fp8.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors']] } } },
      WanImageToVideo: {
        input: {
          required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] },
          optional: { start_image: ['IMAGE', {}] },
        },
        output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
      },
    } as never)

    const wf = await buildDynamicWorkflow(vidParams('wan2.1_i2v_14B_fp8.safetensors') as never, 'wan')
    const [loadId, load] = nodeOf(wf, 'LoadImage')!
    const [i2vId, i2v] = nodeOf(wf, 'WanImageToVideo')!
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(load.inputs.image).toBe('still.png')
    expect(i2v.inputs.start_image).toEqual([loadId, 0])
    expect(i2v.inputs.length).toBe(33)
    expect(sampler.inputs.positive).toEqual([i2vId, 0])
    expect(sampler.inputs.negative).toEqual([i2vId, 1])
    expect(sampler.inputs.latent_image).toEqual([i2vId, 2])
    expect(nodeOf(wf, 'EmptyHunyuanLatentVideo')).toBeUndefined()
  })

  it('a required combo in the newer COMBO/options shape still fills its widget with the first option', async () => {
    // The box's custom_nodes answer in the newer schema: spec[0] is the string
    // "COMBO" and the choices sit under options. The old grab read spec[0][0]
    // and left the widget unset, ComfyUI then refused the graph.
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['wan2.1_i2v_14B_fp8.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors']] } } },
      WanImageToVideo: {
        input: {
          required: {
            positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'],
            width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'],
            sampling_mode: ['COMBO', { options: ['flow', 'legacy'] }],
          },
          optional: { start_image: ['IMAGE', {}] },
        },
        output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
      },
    } as never)

    const wf = await buildDynamicWorkflow(vidParams('wan2.1_i2v_14B_fp8.safetensors') as never, 'wan')
    const [, i2v] = nodeOf(wf, 'WanImageToVideo')!
    expect(i2v.inputs.sampling_mode).toBe('flow')
  })

  it('Hunyuan i2v: single CONDITIONING output re-points positive only', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['hunyuan_video_i2v_720_fp8.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['llava_llama3_fp8_scaled.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['hunyuan_video_vae_bf16.safetensors']] } } },
      HunyuanImageToVideo: {
        input: {
          required: { positive: ['CONDITIONING'], vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'], guidance_type: [['v1 (concat)', 'v2 (replace)']] },
          optional: { start_image: ['IMAGE', {}] },
        },
        output: ['CONDITIONING', 'LATENT'],
      },
    } as never)

    const wf = await buildDynamicWorkflow(vidParams('hunyuan_video_i2v_720_fp8.safetensors') as never, 'hunyuan')
    const [i2vId, i2v] = nodeOf(wf, 'HunyuanImageToVideo')!
    const [, sampler] = nodeOf(wf, 'KSampler')!
    // unknown required widget falls back to the schema's first combo option
    expect(i2v.inputs.guidance_type).toBe('v1 (concat)')
    expect(sampler.inputs.positive).toEqual([i2vId, 0])
    expect(sampler.inputs.latent_image).toEqual([i2vId, 1])
    // negative stays on the text encoder — Hunyuan's node emits no negative
    expect(sampler.inputs.negative).not.toEqual([i2vId, expect.anything()])
  })

  it('LTX: LTXVImgToVideo wires image input and conditioning outputs', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['ltx-video-2b-v0.9.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['t5xxl_fp16.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['ltx_vae.safetensors']] } } },
      EmptyLTXVLatentVideo: { input: { required: {} } },
      LTXVImgToVideo: {
        input: {
          required: { positive: ['CONDITIONING'], negative: ['CONDITIONING'], vae: ['VAE'], image: ['IMAGE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] },
        },
        output: ['CONDITIONING', 'CONDITIONING', 'LATENT'],
      },
    } as never)

    const wf = await buildDynamicWorkflow(vidParams('ltx-video-2b-v0.9.safetensors') as never, 'ltx')
    const [loadId] = nodeOf(wf, 'LoadImage')!
    const [i2vId, i2v] = nodeOf(wf, 'LTXVImgToVideo')!
    const [, sampler] = nodeOf(wf, 'KSampler')!
    expect(i2v.inputs.image).toEqual([loadId, 0])
    expect(sampler.inputs.latent_image).toEqual([i2vId, 2])
    expect(nodeOf(wf, 'EmptyLTXVLatentVideo')).toBeUndefined()
  })

  it('Cosmos: latent-only CosmosImageToVideoLatent leaves conditioning untouched', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['Cosmos-1_0-Diffusion-7B-Video2World.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['oldt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['cosmos_cv8x8x8_1.0.safetensors']] } } },
      EmptyCosmosLatentVideo: { input: { required: {} } },
      CosmosImageToVideoLatent: {
        input: {
          required: { vae: ['VAE'], width: ['INT'], height: ['INT'], length: ['INT'], batch_size: ['INT'] },
          optional: { start_image: ['IMAGE', {}] },
        },
        output: ['LATENT'],
      },
    } as never)

    const wf = await buildDynamicWorkflow(vidParams('Cosmos-1_0-Diffusion-7B-Video2World.safetensors') as never, 'cosmos')
    const [i2vId, i2v] = nodeOf(wf, 'CosmosImageToVideoLatent')!
    const [, sampler] = nodeOf(wf, 'KSampler')!
    const [posId] = nodeOf(wf, 'CLIPTextEncode')!
    expect(i2v.inputs.start_image).toBeDefined()
    expect(sampler.inputs.latent_image).toEqual([i2vId, 0])
    // conditioning still comes from the text encoders, not the latent node
    expect(sampler.inputs.positive).toEqual([posId, 0])
    expect(nodeOf(wf, 'EmptyCosmosLatentVideo')).toBeUndefined()
  })

  it('Mochi + inputImage rejects with an actionable message', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['mochi_preview_bf16.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['t5xxl_fp16.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['mochi_vae.safetensors']] } } },
      EmptyMochiLatentVideo: { input: { required: {} } },
    } as never)

    await expect(
      buildDynamicWorkflow(vidParams('mochi_preview_bf16.safetensors') as never, 'mochi'),
    ).rejects.toThrow(/text-to-video only/i)
  })

  it('missing family node rejects with an update hint instead of a silent t2v graph', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['wan2.1_i2v_14B_fp8.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors']] } } },
      // no WanImageToVideo on this (old) ComfyUI
    } as never)

    await expect(
      buildDynamicWorkflow(vidParams('wan2.1_i2v_14B_fp8.safetensors') as never, 'wan'),
    ).rejects.toThrow(WorkflowUnavailableError)
  })

  it('t2v request (no inputImage) still builds the plain empty-latent graph', async () => {
    vi.mocked(getAllNodeInfo).mockResolvedValue({
      ...CORE,
      UNETLoader: { input: { required: { unet_name: [['wan2.1_t2v_1.3B_bf16.safetensors']] } } },
      CLIPLoader: { input: { required: { clip_name: [['umt5_xxl_fp8_e4m3fn_scaled.safetensors']] } } },
      VAELoader: { input: { required: { vae_name: [['wan_2.1_vae.safetensors']] } } },
      WanImageToVideo: { input: { required: {} }, output: ['CONDITIONING', 'CONDITIONING', 'LATENT'] },
    } as never)

    const { inputImage: _drop, ...t2v } = vidParams('wan2.1_t2v_1.3B_bf16.safetensors')
    const wf = await buildDynamicWorkflow(t2v as never, 'wan')
    expect(nodeOf(wf, 'WanImageToVideo')).toBeUndefined()
    expect(nodeOf(wf, 'EmptyHunyuanLatentVideo')).toBeDefined()
  })
})
