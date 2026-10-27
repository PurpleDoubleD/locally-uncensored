/**
 * B18 (3.0.9): LTX 2.5 past its 10 seconds. A later section pins the last 17
 * frames of the clip so far (three latent frames) at full strength in both
 * passes, and saves the whole clip with the whole sound: the section's sound
 * past the overlap behind the sound so far (TrimAudioDuration, AudioConcat).
 * One pass instead puts LTXVContextWindows on the model. Core nodes only.
 *
 * Run: npx vitest run src/api/__tests__/ltx-25-runs-past-ten-seconds.test.ts
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
import { localFetch } from '../backend'
import { classTypes, nodeAt, nodeOf, nodesOf } from './graph-test-support'

const DIT = 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors'
const DEV = 'ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors'
const ENCODER = 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors'
const VIDEO_VAE = 'ltx-2.5-video-vae-bf16.safetensors'
const AUDIO_VAE = 'ltx-2.5-audio-vae-bf16.safetensors'
const UPSCALER = 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'

const LTX25_NODES: Record<string, unknown> = {
  UNETLoader: { input: { required: { unet_name: [[DIT, DEV]] } } },
  CLIPLoader: { input: { required: { clip_name: [[ENCODER]] } } },
  VAELoader: { input: { required: { vae_name: [[VIDEO_VAE, AUDIO_VAE]] } } },
  LatentUpscaleModelLoader: { input: { required: { model_name: [[UPSCALER]] } } },
  CLIPTextEncode: { input: { required: {} } },
  LTXVConditioning: { input: { required: {} } },
  EmptyLTXVLatentVideo: { input: { required: {} } },
  LTXVEmptyLatentAudio: { input: { required: {} } },
  LTXVConcatAVLatent: { input: { required: {} } },
  LTXVSeparateAVLatent: { input: { required: {} } },
  LTXVLatentUpsampler: { input: { required: {} } },
  LTXVAudioVAEDecode: { input: { required: {} } },
  LTXVDualCFGGuider: { input: { required: {} } },
  LTXVImgToVideoInplace: { input: { required: {} } },
  LTXVPreprocess: { input: { required: {} } },
  ManualSigmas: { input: { required: {} } },
  KSamplerSelect: { input: { required: {} } },
  RandomNoise: { input: { required: {} } },
  SamplerCustomAdvanced: { input: { required: {} } },
  VAEDecodeTiled: { input: { required: {} } },
  LoadImage: { input: { required: {} } },
  ImageScale: { input: { required: {} } },
  CreateVideo: { input: { required: {} } },
  SaveVideo: { input: { required: {} } },
  LoadVideo: { input: { required: {} } },
  GetVideoComponents: { input: { required: {} } },
  ImageFromBatch: { input: { required: {} } },
  BatchImagesNode: { input: { required: {} } },
  TrimAudioDuration: { input: { required: {} } },
  AudioConcat: { input: { required: {} } },
  LTXVContextWindows: { input: { required: {} } },
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
  model, prompt: 'two rangers argue at a campfire, then a cut to the lake at dawn', negativePrompt: '',
  sampler: 'euler_ancestral', scheduler: 'simple', steps: 8, cfgScale: 1,
  width: 1280, height: 704, seed: 7, batchSize: 1, frames: 121, fps: 24, ...extra,
}) as never

beforeEach(() => {
  vi.mocked(getAllNodeInfo).mockResolvedValue(LTX25_NODES as never)
  serveEnums([VIDEO_VAE, AUDIO_VAE], [ENCODER])
})

describe('a later LTX 2.5 section', () => {
  it('pins the last 17 frames at strength 1 in both passes', async () => {
    const wf = await buildDynamicWorkflow(run(DIT, { frames: 241, continueFrom: { video: 'so_far.mp4', overlap: 17 } }))
    expect(nodeOf(wf, 'LoadVideo')![1].inputs.file).toBe('so_far.mp4')
    expect(classTypes(wf)).not.toContain('LoadImage')
    const pins = nodesOf(wf, 'LTXVImgToVideoInplace').map(([, n]) => n.inputs.strength)
    expect(pins).toEqual([1, 1])
    const pre = nodeOf(wf, 'LTXVPreprocess')![1]
    const scale = nodeAt(wf, (pre.inputs.image as [string, number])[0])!
    expect(nodeAt(wf, (scale.inputs.image as [string, number])[0])!.inputs).toMatchObject({ batch_index: -17, length: 17 })
  })

  it('saves the whole clip with the whole sound', async () => {
    const wf = await buildDynamicWorkflow(run(DIT, { frames: 241, continueFrom: { video: 'so_far.mp4', overlap: 17 } }))
    const create = nodeOf(wf, 'CreateVideo')![1]
    expect(nodeAt(wf, (create.inputs.images as [string, number])[0])!.class_type).toBe('BatchImagesNode')
    const sound = nodeAt(wf, (create.inputs.audio as [string, number])[0])!
    expect(sound.class_type).toBe('AudioConcat')
    const parts = nodeOf(wf, 'GetVideoComponents')![0]
    expect(sound.inputs.audio1).toEqual([parts, 1])
    const trim = nodeAt(wf, (sound.inputs.audio2 as [string, number])[0])!
    expect(trim.class_type).toBe('TrimAudioDuration')
    expect(trim.inputs.start_index).toBeCloseTo(17 / 24)
    expect(nodeAt(wf, (trim.inputs.audio as [string, number])[0])!.class_type).toBe('LTXVAudioVAEDecode')
  })

  it('one pass puts LTXVContextWindows under both guiders', async () => {
    const wf = await buildDynamicWorkflow(run(DIT, { frames: 721, contextWindows: true }))
    const win = nodeOf(wf, 'LTXVContextWindows')!
    expect(win[1].inputs).toMatchObject({ context_length: 145, context_overlap: 40 })
    for (const [, g] of nodesOf(wf, 'LTXVDualCFGGuider')) expect(g.inputs.model).toEqual([win[0], 0])
  })
})
