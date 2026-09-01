/**
 * FramePack decodes again: the 1.0 transformer needs the 1.0 VAE.
 *
 * bob80817 (D#104): every FramePack run died with "Sizes of tensors must match
 * except in dimension 2. Expected size 32 but got size 16 (FramePackSampler)".
 * FramePack is a HunyuanVideo 1.0 model and its sampler allocates the history
 * buffer with 16 latent channels; the HunyuanVideo 1.5 VAE encodes 32. Commit
 * 6fb83d31 (09.04.2026) renamed the FramePack VAE to the 1.5 file while fixing
 * a batch of unrelated filename typos, so every run since then paired the two.
 *
 * Run: npx vitest run src/api/__tests__/framepack-vae.test.ts
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
import { findMatchingVAE, COMPONENT_REGISTRY } from '../comfyui'
import { localFetch } from '../backend'

const VAE_10 = 'hunyuan_video_vae_bf16.safetensors'
const VAE_15 = 'hunyuanvideo15_vae_fp16.safetensors'

/** bob's disk after the FramePack bundle: both VAEs present, and the 1.5 file
 *  sorts FIRST in ComfyUI's enum, which is what decided the old first-hit. */
const BOTH_VAES = [VAE_15, VAE_10, 'wan_2.1_vae.safetensors']

const FRAMEPACK_NODES = {
  UNETLoader: { input: { required: { unet_name: [['FramePack_F1_I2V_HY_20250503_fp8.safetensors']] } } },
  VAELoader: { input: { required: { vae_name: [BOTH_VAES] } } },
  DualCLIPLoader: { input: { required: { clip_name1: [['clip_l.safetensors']], clip_name2: [['llava_llama3_fp8_scaled.safetensors']], type: [['hunyuan_video']] } } },
  CLIPVisionLoader: { input: { required: { clip_name: [['sigclip_vision_patch14_384.safetensors']] } } },
  CLIPVisionEncode: { input: { required: {} } },
  LoadFramePackModel: { input: { required: { model: [['FramePack_F1_I2V_HY_20250503_fp8.safetensors']] } } },
  FramePackSampler: { input: { required: {} } },
  LoadImage: { input: { required: { image: [['input_image.png']] } } },
  ImageScale: { input: { required: {} } },
  VAEEncode: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  CLIPTextEncode: { input: { required: {} } },
  SaveAnimatedWEBP: { input: { required: {} } },
}

const params = {
  model: 'FramePack_F1_I2V_HY_20250503_fp8.safetensors',
  prompt: 'a cat turns its head',
  inputImage: 'cat.png',
  width: 640, height: 640, steps: 25, cfgScale: 1.0,
  frames: 49, fps: 16, seed: 42,
}

function vaeEnum(list: string[]) {
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ VAELoader: { input: { required: { vae_name: [list] } } } }),
  } as never)
}

describe('findMatchingVAE — FramePack never gets a 32-channel VAE', () => {
  beforeEach(() => vi.clearAllMocks())

  it('picks the 1.0 VAE even though the 1.5 file sorts first', async () => {
    vaeEnum(BOTH_VAES)
    expect(await findMatchingVAE('framepack')).toBe(VAE_10)
  })

  it('NEGATIVE CONTROL: the old rule (first `hunyuan` hit) would have picked the 1.5 file', async () => {
    // The exact expression this fix replaced. Kept as an executable record of
    // what bob's crash was: on his enum it returns the 32-channel VAE.
    const oldRule = BOTH_VAES.find(v => v.toLowerCase().includes('hunyuan') || v.toLowerCase().includes('wan'))
    expect(oldRule).toBe(VAE_15)
    vaeEnum(BOTH_VAES)
    expect(await findMatchingVAE('framepack')).not.toBe(oldRule)
  })

  it('refuses a lone 1.5 VAE and names the file to download', async () => {
    vaeEnum([VAE_15, 'sdxl_vae.safetensors'])
    await expect(findMatchingVAE('framepack')).rejects.toThrow(VAE_10)
  })

  it('the 1.5 lane is untouched: hunyuan still picks its own VAE', async () => {
    vaeEnum(BOTH_VAES)
    expect(await findMatchingVAE('hunyuan')).toBe(VAE_15)
  })

  it('Wan 2.1 is 16-channel too, so it never falls into the 1.5 VAE either', async () => {
    vaeEnum([VAE_15, VAE_10])
    expect(await findMatchingVAE('wan')).toBe(VAE_10)
  })

  it('the download named in the registry is the 1.0 file', () => {
    expect(COMPONENT_REGISTRY.framepack.vae!.downloadFilename).toBe(VAE_10)
  })
})

describe('the built FramePack graph', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAllNodeInfo).mockResolvedValue(FRAMEPACK_NODES as never)
    vaeEnum(BOTH_VAES)
  })

  it('loads the 1.0 VAE, and both the encode and the decode read that one node', async () => {
    const wf = await buildDynamicWorkflow(params as never)
    // buildDynamicWorkflow returns a typed ComfyApiGraph now, so these read
    // real fields instead of casting each node back into a hand-written shape.
    const vaeNodes = Object.entries(wf).filter(([, v]) => v.class_type === 'VAELoader')
    expect(vaeNodes).toHaveLength(1)
    const [vaeId, vaeNode] = vaeNodes[0]
    expect(vaeNode.inputs?.vae_name).toBe(VAE_10)

    // One VAE for the whole graph: encoding the start frame with a different
    // VAE than the decode uses would be the same channel mismatch, one node on.
    for (const cls of ['VAEEncode', 'VAEDecode', 'VAEDecodeTiled']) {
      for (const [, node] of Object.entries(wf).filter(([, v]) => v.class_type === cls)) {
        const vae = node.inputs?.vae
        expect(Array.isArray(vae) && vae[0]).toBe(vaeId)
      }
    }
  })

  it('a disk without the 1.0 VAE fails with the download hint, not a ComfyUI 400', async () => {
    vaeEnum([VAE_15])
    await expect(buildDynamicWorkflow(params as never)).rejects.toThrow(/No FramePack VAE found.*hunyuan_video_vae_bf16/s)
  })
})
