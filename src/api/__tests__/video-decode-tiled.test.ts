/**
 * Video latents decode TILED whenever the install has VAEDecodeTiled.
 *
 * Live on the 3060 (David 2026-08-02): NSFW Wan 14B GGUF sampled 12/12 steps
 * in 2:54, then the full-frame WanVAE decode sat at "GPU 100%" for 45+
 * minutes. The resident 14B UNet left the VAE 312 MB of usable VRAM; CUDA on
 * the Windows driver pages instead of throwing, so ComfyUI's own OOM-based
 * tiled retry never fired. Tiling keeps the decode working set flat, which is
 * the difference between minutes and "is this thing hung" on the 12 GB cards
 * the GGUF catalog targets. Image decodes stay on plain VAEDecode, and a core
 * without the tiled node (very old installs) keeps validating.
 *
 * Run: npx vitest run src/api/__tests__/video-decode-tiled.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow, videoDecodeNode } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { buildSDXLImgWorkflow } from '../comfyui'
import { localFetch } from '../backend'
import { classTypes, nodeOf } from './graph-test-support'
import { linkTarget, nodeInput } from '../../types/comfy-graph'

const NSFW_WAN14B = 'nsfw_wan_14b_e15_q4_k.gguf'
const WAN22_5B_GGUF = 'wan2_2_ti2v_5b_q8.gguf'

const BASE_NODES = {
  UNETLoader: { input: { required: { unet_name: [['wan2.1_t2v_14B_fp8.safetensors']] } } },
  UnetLoaderGGUF: { input: { required: { unet_name: [[NSFW_WAN14B, WAN22_5B_GGUF]] } } },
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
const NODES_WITH_TILED = {
  ...BASE_NODES,
  VAEDecodeTiled: { input: { required: { samples: ['LATENT'], vae: ['VAE'], tile_size: ['INT'], overlap: ['INT'], temporal_size: ['INT'], temporal_overlap: ['INT'] } } },
}

const serveComfy = (nodes: Record<string, unknown>) => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(nodes as never)
  vi.mocked(localFetch).mockImplementation((async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (typeof url === 'string' && url.includes('object_info') ? nodes : {}),
    text: async () => JSON.stringify(nodes),
  })) as never)
}

const videoParams = {
  prompt: 'a red lighthouse by the sea at dusk', negativePrompt: '',
  sampler: 'euler', scheduler: 'simple',
  steps: 12, cfgScale: 5, width: 640, height: 384, seed: 42, batchSize: 1,
  frames: 9, fps: 16,
}

// nodeOf/nodesOf/classTypes leben in graph-test-support.ts — siehe dort, warum
// eine Graph-Fixture als ComfyApiGraph statt als Record<string, any> gelesen wird.

describe('videoDecodeNode', () => {
  it('emits VAEDecodeTiled with ALL four tiling fields (the live validator refuses omitted required-with-default inputs)', () => {
    const node = videoDecodeNode(['7', 0], ['3', 0], true)
    expect(node.class_type).toBe('VAEDecodeTiled')
    expect(node.inputs).toEqual({
      samples: ['7', 0], vae: ['3', 0],
      tile_size: 256, overlap: 64, temporal_size: 64, temporal_overlap: 8,
    })
  })
  it('falls back to plain VAEDecode when the install has no tiled node', () => {
    const node = videoDecodeNode(['7', 0], ['3', 0], false)
    expect(node.class_type).toBe('VAEDecode')
    expect(node.inputs).toEqual({ samples: ['7', 0], vae: ['3', 0] })
  })
})

describe('generic wan video builder (the catalog GGUF path customers hit)', () => {
  it('decodes tiled when the install has the node, and the saver reads from it', async () => {
    serveComfy(NODES_WITH_TILED)
    const wf = await buildDynamicWorkflow({ ...videoParams, model: NSFW_WAN14B } as never)
    const tiled = nodeOf(wf, 'VAEDecodeTiled')
    expect(tiled).toBeDefined()
    expect(tiled![1].inputs.tile_size).toBe(256)
    expect(classTypes(wf)).not.toContain('VAEDecode')
    const saver = nodeOf(wf, 'VHS_VideoCombine') ?? nodeOf(wf, 'SaveAnimatedWEBP')
    // linkTarget beweist zusaetzlich, dass `images` ueberhaupt eine Kante ist —
    // `inputs.images[0]` haette bei einem Literal still `undefined` geliefert.
    expect(linkTarget(nodeInput(saver![1], 'images'))).toBe(tiled![0])
  })
  it('keeps plain VAEDecode on a core without the tiled node', async () => {
    serveComfy(BASE_NODES)
    const wf = await buildDynamicWorkflow({ ...videoParams, model: NSFW_WAN14B } as never)
    expect(classTypes(wf)).toContain('VAEDecode')
    expect(classTypes(wf)).not.toContain('VAEDecodeTiled')
  })
})

describe('wan 2.2 builder', () => {
  it('decodes tiled too', async () => {
    serveComfy(NODES_WITH_TILED)
    const wf = await buildDynamicWorkflow({ ...videoParams, model: WAN22_5B_GGUF } as never)
    expect(classTypes(wf)).toContain('VAEDecodeTiled')
    expect(classTypes(wf)).not.toContain('VAEDecode')
  })
})

describe('image decodes are untouched', () => {
  it('the SDXL image graph stays on plain VAEDecode', () => {
    const wf = buildSDXLImgWorkflow({
      model: 'juggernaut_xl.safetensors', prompt: 'a red apple', negativePrompt: '',
      sampler: 'euler', scheduler: 'normal',
      steps: 20, cfgScale: 7, width: 1024, height: 1024, seed: 42, batchSize: 1,
    } as never)
    expect(classTypes(wf)).toContain('VAEDecode')
    expect(classTypes(wf)).not.toContain('VAEDecodeTiled')
  })
})
