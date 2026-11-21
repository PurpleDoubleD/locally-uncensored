/**
 * MiniMax H3 and FastH3 leave LU's offer (David, 21.11.2026). Their licenses
 * exclude the EU, the UK, South Korea and the USA, derivatives included.
 *
 * Two guards. LU fetches these files on no path: no catalog entry, no
 * completion path, no search hit, no address a workflow declares. And a user
 * who already has them loses nothing: the files are recognised, named and run
 * through the same graphs.
 *
 * Run: npx vitest run src/api/__tests__/h3-is-not-offered-and-keeps-working.test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../comfyui-nodes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../comfyui-nodes')>()
  return { ...actual, getAllNodeInfo: vi.fn() }
})
vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, localFetch: vi.fn(), backendCall: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { buildDynamicWorkflow, WorkflowUnavailableError } from '../dynamic-workflow'
import { getAllNodeInfo } from '../comfyui-nodes'
import { backendCall, localFetch } from '../backend'
import { classifyModel, COMPONENT_REGISTRY } from '../comfyui'
import {
  catalogAddresses, getAudioBundles, getImageBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles, getVideoBundles,
  resumeDownload, startChatLinkDownload, startModelDownload, startModelDownloadToPath,
} from '../discover'
import { getLoraAddonBundles, getRetiredBundles, getThreeDBundles } from '../model-bundles'
import { nodeOf, nodesOf } from './graph-test-support'
import { RETIRED_MODEL_LINE, isRetiredModelName } from '../../lib/retired-models'
import { inspectWorkflow } from '../../lib/workflow-inspect'
import { catalogModelName } from '../../lib/local-model-name'
import { knownLora, loraFitsModel } from '../../lib/lora-stack'
import { bundlesWithFile } from '../../lib/uninstall-plan'
import { localEndFrame, localAnimateReferenceSlots } from '../../lib/frame-refs'

const FL2VA = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
const REF2VA = 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'
const FAST = 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors'
const IMAGE = 'minimax_h3_image_pruned_w4a8.safetensors'
const TURBO = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
const ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
const VIDEO_VAE = 'minimax_h3_video_vae_int8_convrot.safetensors'
const AUDIO_VAE = 'minimax_h3_audio_vae_fp32.safetensors'
const IMAGE_VAE = 'minimax_h3_image_vae_fp16.safetensors'

const offered = () => [
  ...getImageBundles(), ...getVideoBundles(), ...getLoraAddonBundles(), ...getAudioBundles(),
  ...getLipsyncBundles(), ...getMotionBundles(), ...getUpscaleBundles(), ...getThreeDBundles(),
]
const H3_TEXT = /minimax[_-]?h3|fasth3/i

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourcesUnder(path)
    return /\.(ts|tsx|json)$/.test(name) ? [path] : []
  })
}

describe('LU offers MiniMax H3 nowhere', () => {
  it('no bundle a list can show holds an H3 name, file or address', () => {
    for (const b of offered()) {
      expect(`${b.name} ${b.url ?? ''} ${b.workflow}`, b.name).not.toMatch(H3_TEXT)
      for (const f of b.files) expect(`${f.filename ?? ''} ${f.downloadUrl ?? ''}`, b.name).not.toMatch(H3_TEXT)
    }
  })

  it('no address the catalog holds points at it, the completion path included', () => {
    const urls = catalogAddresses().map((a) => a.url)
    expect(urls.length).toBeGreaterThan(50)
    expect(urls.filter((u) => H3_TEXT.test(u))).toEqual([])
    for (const type of ['minimaxh3', 'minimaxh3image']) {
      const req = COMPONENT_REGISTRY[type]
      expect([req.vae, req.clip, req.audioVae].map((s) => s?.downloadUrl).filter(Boolean), type).toEqual([])
    }
  })

  it('the shared Qwen encoder went with it: no other model needs that file', () => {
    expect(offered().flatMap((b) => b.files).some((f) => f.filename === ENCODER)).toBe(false)
  })

  it('the retired records carry no address at all', () => {
    const retired = getRetiredBundles()
    expect(retired.map((b) => b.name)).toEqual([
      'MiniMax H3 · Start/End Frames, with Sound', 'MiniMax H3 Turbo LoRA · 8 Steps',
      'MiniMax H3 Reference · Reference Images, with Sound', 'FastH3 · MiniMax H3 in 8 Steps',
    ])
    for (const b of retired) {
      expect(b.url, b.name).toBeUndefined()
      for (const f of b.files) expect(f.downloadUrl, f.name).toBeUndefined()
    }
  })

  it('no source file outside the tests holds a Hugging Face address of it', () => {
    const root = join(__dirname, '..', '..')
    const hits = sourcesUnder(root).filter((p) => /huggingface\.co\/[^\s'"`]*(minimax[_-]?h3|fasth3)/i.test(readFileSync(p, 'utf8')))
    expect(hits).toEqual([])
  })

  it.each([
    ['the official repo', `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/${FL2VA}`, FL2VA],
    ['a file name alone', 'https://civitai.com/api/download/models/1', FAST],
    ['the address alone', 'https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy/resolve/main/x.safetensors', 'x.safetensors'],
    ['H3 Image', `https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/vae/${IMAGE_VAE}`, IMAGE_VAE],
  ])('every download path refuses %s', async (_what, url, file) => {
    vi.mocked(backendCall).mockClear()
    for (const start of [
      () => startModelDownload(url, 'vae', file),
      () => startChatLinkDownload(url, 'vae', file),
      () => startModelDownloadToPath(url, '/tmp/x', file),
    ]) expect(await start()).toEqual({ status: 'error', id: file, error: RETIRED_MODEL_LINE })
    await expect(resumeDownload(file, url, 'vae')).rejects.toThrow(RETIRED_MODEL_LINE)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL: another MiniMax model and a normal download are not caught', async () => {
    expect(isRetiredModelName('MiniMax-M2.7-Q4_K_M.gguf')).toBe(false)
    expect(isRetiredModelName('minimax-speech-hd')).toBe(false)
    vi.mocked(backendCall).mockReset().mockResolvedValue({ status: 'started', id: 'a.safetensors' } as never)
    expect((await startModelDownload('https://huggingface.co/a/b/resolve/main/a.safetensors', 'loras', 'a.safetensors')).status).toBe('started')
    expect(backendCall).toHaveBeenCalledTimes(1)
  })

  it('a workflow that declares an H3 address gets no download out of it', () => {
    const report = inspectWorkflow({
      bytes: 10, format: 'api', nodes: [{ id: '1', type: 'UNETLoader', values: [FL2VA], note: false, off: false }],
      models: [{ name: FL2VA, directory: 'diffusion_models', hash: 'a'.repeat(64), hashType: 'sha256',
        url: `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/${FL2VA}` }],
      installed: { UNETLoader: { module: 'nodes', options: { unet_name: [] } } }, luPacks: [], registry: {},
      catalog: () => null, source: { kind: 'civitai', host: 'civitai.com' },
    })
    const model = report.models.find((m) => m.name === FL2VA)!
    expect(model.state).toBe('missing')
    expect(model.url).toBeUndefined()
    expect(model.why).toBe(RETIRED_MODEL_LINE)
  })
})

describe('a user who has the files keeps them', () => {
  const nodes = (loras: string[] = [TURBO]) => {
    const empty = { input: { required: {} } }
    return {
      UNETLoader: { input: { required: { unet_name: [[FL2VA, REF2VA, FAST, IMAGE]] } } },
      CLIPLoader: { input: { required: { clip_name: [[ENCODER]], type: [['minimax']] } } },
      VAELoader: { input: { required: { vae_name: [[VIDEO_VAE, AUDIO_VAE, IMAGE_VAE]] } } },
      LoraLoader: { input: { required: { lora_name: [loras] } } },
      LoraLoaderModelOnly: { input: { required: { lora_name: [loras] } } },
      ...Object.fromEntries([
        'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo', 'MiniMaxH3ImageConditioning', 'MiniMaxH3SigmaShift', 'BlockSparseAttention',
        'BasicGuider', 'BasicScheduler', 'KSamplerSelect', 'RandomNoise', 'SamplerCustomAdvanced', 'VAEDecode', 'VAEDecodeAudio',
        'CreateVideo', 'SaveVideo', 'KSampler', 'ConditioningZeroOut', 'SaveImage', 'LoadImage', 'ImageScale', 'RepeatLatentBatch',
      ].map((c) => [c, empty])),
    }
  }
  beforeEach(() => {
    const n = nodes()
    vi.mocked(getAllNodeInfo).mockResolvedValue(n as never)
    vi.mocked(localFetch).mockImplementation((async () => ({ ok: true, status: 200, json: async () => n, text: async () => '' })) as never)
  })
  const video = (model: string, extra: Record<string, unknown> = {}) => ({
    model, prompt: 'a fox', negativePrompt: '', sampler: 'res_multistep', scheduler: 'simple', steps: 20, cfgScale: 1,
    width: 1344, height: 768, seed: 1, batchSize: 1, frames: 124, fps: 24, ...extra,
  }) as never

  it('start and end frames, with the turbo LoRA on it', async () => {
    const wf = await buildDynamicWorkflow(video(FL2VA, { lora: [TURBO], loraStrength: [1], inputImage: 'a.png', endImage: 'b.png' }), 'minimaxh3')
    expect(nodeOf(wf, 'UNETLoader')![1].inputs.unet_name).toBe(FL2VA)
    expect(nodeOf(wf, 'MiniMaxH3ImageToVideo')![1].inputs.last_frame).toBeDefined()
    expect(nodesOf(wf, 'LoraLoaderModelOnly').map(([, n]) => n.inputs.lora_name)).toEqual([TURBO])
    expect(nodeOf(wf, 'BasicScheduler')![1].inputs.steps).toBe(8)
  })

  it('reference to video', async () => {
    const wf = await buildDynamicWorkflow(video(REF2VA, { inputImage: 'a.png', referenceImages: ['b.png'] }), 'minimaxh3')
    expect(nodeOf(wf, 'MiniMaxH3ReferenceToVideo')![1].inputs['ref_images.ref_image_1']).toBeDefined()
  })

  it('FastH3', async () => {
    const wf = await buildDynamicWorkflow(video(FAST), 'minimaxh3')
    expect(nodeOf(wf, 'BlockSparseAttention')).toBeTruthy()
  })

  it('H3 Image, text to image and edit', async () => {
    const base = { model: IMAGE, prompt: 'a fox', negativePrompt: '', sampler: 'euler', scheduler: 'simple', steps: 6, cfgScale: 1, width: 2048, height: 2048, seed: 1, batchSize: 1 }
    expect(nodeOf(await buildDynamicWorkflow(base as never), 'MiniMaxH3ImageConditioning')![1].inputs.vae).toBeDefined()
    const edit = await buildDynamicWorkflow({ ...base, inputImage: 'a.png', editShape: 'canvas' } as never)
    expect(nodeOf(edit, 'MiniMaxH3ImageConditioning')![1].inputs['images.image_1']).toBeDefined()
  })

  it('the files are still recognised as what they are', () => {
    expect([FL2VA, REF2VA, FAST].map(classifyModel)).toEqual(['minimaxh3', 'minimaxh3', 'minimaxh3'])
    expect(classifyModel(IMAGE)).toBe('minimaxh3image')
    expect(localEndFrame(FL2VA)).toBe(true)
    expect(localAnimateReferenceSlots(REF2VA)).toBe(8)
  })

  it('the picker keeps their names and the stack keeps the turbo LoRA on H3 only', () => {
    expect(catalogModelName(FL2VA)).toBe('MiniMax H3 fl2va (int8) · Start/End frames')
    expect(knownLora(TURBO)?.family).toBe('minimaxh3')
    expect(loraFitsModel(TURBO, 'minimaxh3')).toBe(true)
    expect(loraFitsModel(TURBO, 'zimage')).toBe(false)
  })

  it('uninstalling one H3 model still sees who else uses the shared encoder', () => {
    expect(bundlesWithFile(ENCODER, getRetiredBundles()).length).toBe(3)
  })

  it('a missing file is named in one neutral sentence, with nothing to fetch', async () => {
    const n = { ...nodes(), VAELoader: { input: { required: { vae_name: [[VIDEO_VAE]] } } } }
    vi.mocked(getAllNodeInfo).mockResolvedValue(n as never)
    vi.mocked(localFetch).mockImplementation((async () => ({ ok: true, status: 200, json: async () => n, text: async () => '' })) as never)
    const err = await buildDynamicWorkflow(video(FL2VA), 'minimaxh3').catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowUnavailableError)
    expect(err.message).toContain(AUDIO_VAE)
    expect(err.message).toContain(RETIRED_MODEL_LINE)
    expect(err.message).not.toMatch(/huggingface|Comfy-Org|Model Manager|Download "/i)
    expect(err.missing ?? []).toEqual([])
  })
})
