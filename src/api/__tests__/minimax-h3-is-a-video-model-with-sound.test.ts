/**
 * Discord 2026-09-26 (throwaway): MiniMax H3 from CivitAI showed up as an
 * image model. LU did not know the family, so it went to the image picker and
 * the checkpoint loader. It is a video model that writes its own sound, built
 * the way the official Comfy-Org templates build it.
 *
 * Run: npx vitest run src/api/__tests__/minimax-h3-is-a-video-model-with-sound.test.ts
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

import { buildDynamicWorkflow, snapMiniMaxH3Length, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { classifyModel, isImageModelType, isVideoModelType, isI2VModel, isT2VCapable, findMatchingCLIP, findMatchingVAE } from '../comfyui'
import { resolveI2VResolution } from '../vram-handoff'
import { getVideoBundles } from '../discover'
import { localFetch } from '../backend'
import { nodeOf } from './graph-test-support'

const FL2VA = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
const REF2VA = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'
const ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'

const H3_NODES: Record<string, unknown> = {
  UNETLoader: { input: { required: { unet_name: [[FL2VA, REF2VA]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VIDEO_VAE, AUDIO_VAE]] } } },
  LoraLoaderModelOnly: { input: { required: {} } },
  MiniMaxH3ImageToVideo: { input: { required: {} } },
  MiniMaxH3ReferenceToVideo: { input: { required: {} } },
  BasicGuider: { input: { required: {} } },
  BasicScheduler: { input: { required: {} } },
  KSamplerSelect: { input: { required: {} } },
  RandomNoise: { input: { required: {} } },
  SamplerCustomAdvanced: { input: { required: {} } },
  VAEDecode: { input: { required: {} } },
  VAEDecodeAudio: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  CreateVideo: { input: { required: {} } },
  SaveVideo: { input: { required: {} } },
}

function serveEnums(vaes: string[], clips: string[]) {
  vi.mocked(localFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      CLIPLoader: { input: { required: { clip_name: [clips] } } },
      VAELoader: { input: { required: { vae_name: [vaes] } } },
    }),
  } as never)
}

const run = (model: string, extra: Record<string, unknown> = {}) => ({
  model, prompt: 'a drummer on a rooftop, the snare cracks on every hit', negativePrompt: '',
  sampler: 'res_multistep', scheduler: 'simple', steps: 20, cfgScale: 1,
  width: 1344, height: 768, seed: 7, batchSize: 1, frames: 124, fps: 24, ...extra,
}) as never

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(H3_NODES as never)
  serveEnums([VIDEO_VAE, AUDIO_VAE], [ENCODER])
})

describe('MiniMax H3 is a video model', () => {
  it('both weight sets land in the video lane, for text and for a start image', () => {
    for (const name of [FL2VA, REF2VA, 'MiniMax-H3-civitai-repack.safetensors']) {
      expect(classifyModel(name)).toBe('minimaxh3')
      expect(isVideoModelType(classifyModel(name))).toBe(true)
      expect(isImageModelType(classifyModel(name))).toBe(false)
      expect(isI2VModel(name)).toBe(true)
      expect(isT2VCapable(name)).toBe(true)
    }
  })

  it('the Model Manager no longer offers it (3.1.3, license)', () => {
    expect(getVideoBundles().some((b) => b.workflow === 'minimaxh3')).toBe(false)
  })
})

describe('the graph follows the official templates', () => {
  it('text to video: UNET, CLIPLoader(minimax), MiniMaxH3ImageToVideo, BasicGuider, both decoders, CreateVideo with sound', async () => {
    const wf = await buildDynamicWorkflow(run(FL2VA), 'minimaxh3')
    expect(nodeOf(wf, 'UNETLoader')![1].inputs.unet_name).toBe(FL2VA)
    expect(nodeOf(wf, 'CLIPLoader')![1].inputs).toMatchObject({ clip_name: ENCODER, type: 'minimax' })
    const [encId, enc] = nodeOf(wf, 'MiniMaxH3ImageToVideo')!
    expect(enc.inputs).toMatchObject({ width: 1344, height: 768, length: 124 })
    expect(enc.inputs.first_frame).toBeUndefined()
    const sample = nodeOf(wf, 'SamplerCustomAdvanced')!
    expect(sample[1].inputs.latent_image).toEqual([encId, 1])
    expect(nodeOf(wf, 'BasicGuider')![1].inputs.conditioning).toEqual([encId, 0])
    expect(nodeOf(wf, 'KSamplerSelect')![1].inputs.sampler_name).toBe('res_multistep')
    // Each decoder gets its own autoencoder, both read the one sampled latent.
    const vaeOf = (id: unknown) => wf[(id as [string, number])[0]]?.inputs?.vae_name
    expect(vaeOf(nodeOf(wf, 'VAEDecode')![1].inputs.vae)).toBe(VIDEO_VAE)
    expect(vaeOf(nodeOf(wf, 'VAEDecodeAudio')![1].inputs.vae)).toBe(AUDIO_VAE)
    expect(nodeOf(wf, 'VAEDecodeAudio')![1].inputs.samples).toEqual([sample[0], 0])
    const create = nodeOf(wf, 'CreateVideo')![1].inputs
    expect(create.fps).toBe(24)
    expect(create.audio).toEqual([nodeOf(wf, 'VAEDecodeAudio')![0], 0])
    expect(nodeOf(wf, 'KSampler')).toBeUndefined()
    expect(nodeOf(wf, 'CheckpointLoaderSimple')).toBeUndefined()
  })

  it('a start image becomes the first frame, cropped to the canvas', async () => {
    const wf = await buildDynamicWorkflow(run(FL2VA, { inputImage: 'still.png' }), 'minimaxh3')
    const [scaleId, scale] = nodeOf(wf, 'ImageScale')!
    expect(scale.inputs).toMatchObject({ width: 1344, height: 768, crop: 'center' })
    expect(nodeOf(wf, 'MiniMaxH3ImageToVideo')![1].inputs.first_frame).toEqual([scaleId, 0])
  })

  it('ref2va weights take the image as reference picture 1 and the audio VAE', async () => {
    const wf = await buildDynamicWorkflow(run(REF2VA, { inputImage: 'face.png' }), 'minimaxh3')
    const ref = nodeOf(wf, 'MiniMaxH3ReferenceToVideo')![1].inputs
    expect(ref['ref_images.ref_image_0']).toEqual([nodeOf(wf, 'ImageScale')![0], 0])
    expect(ref.ref_image_size).toBe('match')
    expect(wf[(ref.audio_vae as [string, number])[0]]?.inputs?.vae_name).toBe(AUDIO_VAE)
    expect(nodeOf(wf, 'MiniMaxH3ImageToVideo')).toBeUndefined()
  })

  it('a video LoRA patches the model the guider and scheduler read', async () => {
    const wf = await buildDynamicWorkflow(run(FL2VA, { lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' }), 'minimaxh3')
    const [loraId] = nodeOf(wf, 'LoraLoaderModelOnly')!
    expect(nodeOf(wf, 'BasicGuider')![1].inputs.model).toEqual([loraId, 0])
    expect(nodeOf(wf, 'BasicScheduler')![1].inputs.model).toEqual([loraId, 0])
  })

  // Discord 2026-10-02: the turbo LoRA runs at the step
  // count in its name, the way the official template runs it.
  it('the 8-step turbo LoRA runs 8 steps, without it the slider counts', async () => {
    const turbo = await buildDynamicWorkflow(run(FL2VA, { lora: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' }), 'minimaxh3')
    expect(nodeOf(turbo, 'BasicScheduler')![1].inputs.steps).toBe(8)
    const plain = await buildDynamicWorkflow(run(FL2VA, { lora: 'some_style_lora.safetensors' }), 'minimaxh3')
    expect(nodeOf(plain, 'BasicScheduler')![1].inputs.steps).toBe(20)
  })

  it('frame counts snap up to the 17k+5 grid', () => {
    expect(snapMiniMaxH3Length(124)).toBe(124)
    expect(snapMiniMaxH3Length(120)).toBe(124)
    expect(snapMiniMaxH3Length(125)).toBe(141)
    expect(snapMiniMaxH3Length(1)).toBe(5)
    expect(snapMiniMaxH3Length(360)).toBe(362)
  })

  it('a portrait still gets a portrait canvas in the chat tool', () => {
    expect(resolveI2VResolution('minimaxh3', 768, 1344)).toEqual({ width: 768, height: 1344 })
    expect(resolveI2VResolution('minimaxh3', 1024, 1024)).toEqual({ width: 768, height: 768 })
    expect(resolveI2VResolution('minimaxh3', 0, 0)).toEqual({ width: 1344, height: 768 })
  })

  // Negative control: an install without the H3 nodes gets the update
  // sentence, never a graph ComfyUI would refuse.
  it('an older ComfyUI is told to update', async () => {
    const old = { ...H3_NODES }
    delete old.MiniMaxH3ImageToVideo
    delete old.MiniMaxH3ReferenceToVideo
    vi.mocked(getAllNodeInfo).mockResolvedValue(old as never)
    const err = await buildDynamicWorkflow(run(FL2VA), 'minimaxh3').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(String(err.message)).toMatch(/Update ComfyUI/)
  })
})

describe('the H3 files stay out of the other families', () => {
  // The H3 encoder is a Qwen3-VL file too, and both VAEs say minimax.
  it('Krea 2, FLUX 2, HunyuanVideo and FramePack never take the 32B H3 encoder', async () => {
    serveEnums([VIDEO_VAE, AUDIO_VAE], [ENCODER])
    await expect(findMatchingCLIP('krea2', 'krea-2-dev-fp8.safetensors')).rejects.toThrow(/Krea 2 text encoder/)
    await expect(findMatchingCLIP('flux2', 'flux2_klein_4b_fp4.safetensors')).rejects.toThrow()
    await expect(findMatchingCLIP('hunyuan', 'hunyuanvideo1.5_720p.safetensors')).rejects.toThrow()
    await expect(findMatchingCLIP('framepack', 'FramePackI2V_HY.safetensors')).rejects.toThrow()
  })

  it('H3 takes the video VAE for the picture and says what is missing', async () => {
    expect(await findMatchingVAE('minimaxh3')).toBe(VIDEO_VAE)
    serveEnums(['wan_2.1_vae.safetensors'], ['umt5_xxl_fp8_e4m3fn_scaled.safetensors'])
    await expect(findMatchingVAE('minimaxh3')).rejects.toThrow(/minimax_h3_video_vae_int8_convrot/)
    await expect(findMatchingCLIP('minimaxh3', FL2VA)).rejects.toThrow(/qwen3vl_32b_minimax_h3_nvfp4_awq/)
  })
})
