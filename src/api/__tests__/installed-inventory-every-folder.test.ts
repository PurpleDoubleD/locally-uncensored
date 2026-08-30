/**
 * Meldung 1 of the R5 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r5-nachmessung.md).
 *
 * A 1 MB .safetensors dummy was dropped into ten ComfyUI model folders. The
 * running ComfyUI listed all ten at once. The app, after a reload, showed
 * five of them:
 *
 *   checkpoints ok · diffusion_models ok · loras ok · vae ok · text_encoders ok
 *   clip_vision NO · controlnet NO · upscale_models NO · embeddings NO · style_models NO
 *
 * Two real files were invisible with them:
 *   clip_vision\sigclip_vision_patch14_384.safetensors      817 MB
 *   text_encoders\llava_llama3_fp8_scaled.safetensors      2430 MB
 *
 * The second one is the harder half. Its folder was listed and its three
 * folder neighbours (clip_l, qwen_3_4b, umt5_xxl_fp8_e4m3fn_scaled) all
 * appeared, so this was not a folder gap at all: our own catalogue ships that
 * filename at 8.5 GB, the disk probe called the user's 2.4 GB copy too small,
 * and the partial filter swallowed it. A catalogue size is a claim about the
 * file WE ship. It says nothing about the file the user has, and this list
 * answers one question only: what is lying on the disk.
 *
 * And one invention in the other direction: the Installed list carried an
 * entry `pixel_space`, type safetensors, no size, for which no file exists
 * anywhere on the drive. It is ComfyUI's built-in pixel-space pseudo VAE,
 * offered by VAELoader in the same enum as the real files.
 *
 * Run: npx vitest run src/api/__tests__/installed-inventory-every-folder.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()
const backendCall = vi.fn()
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

import {
  getInstalledImageModels, getImageModels, isInstalledModelFile,
  INSTALLED_ADDON_SUBFOLDERS, subfolderForSource,
} from '../comfyui'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const notFound = { ok: false, status: 404, json: async () => ({}) }

/** The dummy the counter-check dropped into every folder, one per folder so
 *  each lane can be told apart in the result. */
const dummy = (folder: string) => `r5n-${folder}.safetensors`

/** The two real files that were invisible on the box. */
const SIGCLIP = 'sigclip_vision_patch14_384.safetensors'
const LLAVA = 'llava_llama3_fp8_scaled.safetensors'

interface Board {
  checkpoints?: string[]
  unets?: string[]
  vaes?: string[]
  clips?: string[]
  loras?: string[]
  clipVision?: string[] | 'missing'
  controlnet?: string[] | 'missing'
  upscale?: string[] | 'missing'
  styleModels?: string[] | 'missing'
  embeddings?: string[] | 'missing'
}

function board(b: Board = {}) {
  const enumFor = (list: string[] | 'missing' | undefined, node: string, field: string) => {
    if (list === 'missing' || list === undefined) return notFound
    return okJson({ [node]: { input: { required: { [field]: [list] } } } })
  }
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('/embeddings')) {
      if (b.embeddings === 'missing' || b.embeddings === undefined) return notFound
      return okJson(b.embeddings)
    }
    if (url.includes('CheckpointLoaderSimple')) return enumFor(b.checkpoints ?? [], 'CheckpointLoaderSimple', 'ckpt_name')
    if (url.includes('UnetLoaderGGUF')) return notFound
    if (url.includes('UNETLoader')) return enumFor(b.unets ?? [], 'UNETLoader', 'unet_name')
    if (url.includes('LoraLoader')) return enumFor(b.loras ?? [], 'LoraLoader', 'lora_name')
    if (url.includes('VAELoader')) return enumFor(b.vaes ?? [], 'VAELoader', 'vae_name')
    if (url.includes('CLIPVisionLoader')) return enumFor(b.clipVision ?? [], 'CLIPVisionLoader', 'clip_name')
    if (url.includes('CLIPLoader')) return enumFor(b.clips ?? [], 'CLIPLoader', 'clip_name')
    if (url.includes('ControlNetLoader')) return enumFor(b.controlnet ?? [], 'ControlNetLoader', 'control_net_name')
    if (url.includes('UpscaleModelLoader')) return enumFor(b.upscale ?? [], 'UpscaleModelLoader', 'model_name')
    if (url.includes('StyleModelLoader')) return enumFor(b.styleModels ?? [], 'StyleModelLoader', 'style_model_name')
    return okJson({})
  })
}

beforeEach(() => {
  localFetch.mockReset()
  backendCall.mockReset()
  // The disk agrees with ComfyUI unless a test says otherwise, and every file
  // is measured, so nothing here depends on a size probe missing.
  backendCall.mockImplementation(async (_cmd: string, args: { files?: Array<{ filename: string }> }) =>
    (args?.files ?? []).map((f) => ({
      filename: f.filename, exists: true, actualBytes: 1_048_576, complete: true,
    })),
  )
})

describe('the Installed inventory covers every ComfyUI model folder', () => {
  it('THE FIX: all ten dummy folders of the R5 re-measure show up, not five', async () => {
    board({
      checkpoints: [dummy('checkpoints')],
      unets: [dummy('diffusion_models')],
      loras: [dummy('loras')],
      vaes: [dummy('vae')],
      clips: [dummy('text_encoders')],
      clipVision: [dummy('clip_vision')],
      controlnet: [dummy('controlnet')],
      upscale: [dummy('upscale_models')],
      styleModels: [dummy('style_models')],
      embeddings: [dummy('embeddings')],
    })

    const names = (await getInstalledImageModels()).map((m) => m.name)

    for (const folder of [
      'checkpoints', 'diffusion_models', 'loras', 'vae', 'text_encoders',
      'clip_vision', 'controlnet', 'upscale_models', 'style_models', 'embeddings',
    ]) {
      expect(names, `${folder} must be in the inventory`).toContain(dummy(folder))
    }
  })

  it('THE FIX: the 817 MB CLIP-Vision encoder is named at last', async () => {
    board({ clipVision: [SIGCLIP] })
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names).toContain(SIGCLIP)
  })

  it('THE FIX: llava_llama3 shows up beside its folder neighbours, at its real size', async () => {
    // The exact frame from the box: four files in text_encoders, three of them
    // visible, the 2.4 GB one gone. Our catalogue ships llava at 8.5 GB, so
    // the size probe reports it as not complete.
    backendCall.mockImplementation(async (_cmd: string, args: { files?: Array<{ filename: string }> }) =>
      (args?.files ?? []).map((f) => ({
        filename: f.filename,
        exists: true,
        actualBytes: f.filename === LLAVA ? 2_548_039_680 : 1_048_576,
        complete: f.filename !== LLAVA,
      })),
    )
    board({
      clips: [
        'clip_l.safetensors', LLAVA, 'qwen_3_4b.safetensors',
        'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      ],
    })

    const names = (await getInstalledImageModels()).map((m) => m.name)

    expect(names).toContain(LLAVA)
    expect(names).toContain('clip_l.safetensors')
    expect(names).toContain('qwen_3_4b.safetensors')
    expect(names).toContain('umt5_xxl_fp8_e4m3fn_scaled.safetensors')
  })

  it('THE FIX: pixel_space is not an installed model, because it is not a file', async () => {
    board({
      vaes: [
        'ae.safetensors', 'hunyuan_video_vae_bf16.safetensors', 'sdxl_vae.safetensors',
        'pixel_space',
      ],
    })

    const names = (await getInstalledImageModels()).map((m) => m.name)

    expect(names).not.toContain('pixel_space')
    expect(names).toContain('sdxl_vae.safetensors')
  })

  it('THE FIX: the built-in taesd family goes the same way pixel_space does', async () => {
    board({ vaes: ['taesd', 'taesdxl', 'taesd3', 'taef1', 'ae.safetensors'] })
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names).toEqual(['ae.safetensors'])
  })

  it('THE FIX: an embedding gets its extension back, so it can be measured and deleted', async () => {
    // ComfyUI serves /embeddings with the extension stripped. A name with no
    // extension is not a file: it cannot be sized and it cannot be deleted.
    backendCall.mockImplementation(async (_cmd: string, args: { files?: Array<{ filename: string }> }) =>
      (args?.files ?? []).map((f) => ({
        filename: f.filename,
        exists: f.filename === 'easynegative.pt',
        actualBytes: f.filename === 'easynegative.pt' ? 24_000 : 0,
        complete: true,
      })),
    )
    board({ embeddings: ['easynegative'] })

    const found = (await getInstalledImageModels()).find((m) => m.source === 'embedding')

    expect(found?.name).toBe('easynegative.pt')
    expect(subfolderForSource('embedding')).toBe('embeddings')
  })

  it('the folder list is one table, and it holds every addon folder', () => {
    expect(INSTALLED_ADDON_SUBFOLDERS.sort()).toEqual([
      'clip_vision', 'controlnet', 'embeddings', 'loras', 'style_models',
      'text_encoders', 'upscale_models', 'vae',
    ])
  })

  it('NEGATIVE CONTROL: a loader that is not installed costs its folder and nothing else', async () => {
    board({
      checkpoints: ['sd_turbo.safetensors'],
      clipVision: 'missing',
      controlnet: 'missing',
      upscale: 'missing',
      styleModels: 'missing',
      embeddings: 'missing',
      vaes: ['sdxl_vae.safetensors'],
    })

    const names = (await getInstalledImageModels()).map((m) => m.name)

    expect(names).toContain('sd_turbo.safetensors')
    expect(names).toContain('sdxl_vae.safetensors')
  })

  it('NEGATIVE CONTROL: the Create picker did not move, an upscale model is never a main model', async () => {
    board({
      checkpoints: ['sd_turbo.safetensors'],
      upscale: ['4x-UltraSharp.pth'],
      clipVision: [SIGCLIP],
      controlnet: ['control_v11p_sd15_canny.safetensors'],
      styleModels: ['flux1-redux-dev.safetensors'],
    })

    const picker = (await getImageModels()).map((m) => m.name)

    expect(picker).toEqual(['sd_turbo.safetensors'])
  })

  it('NEGATIVE CONTROL: one file listed by two loaders is counted once', async () => {
    board({
      vaes: ['shared.safetensors'],
      clipVision: ['shared.safetensors'],
    })
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names.filter((n) => n === 'shared.safetensors')).toHaveLength(1)
  })

  it('NEGATIVE CONTROL: the file rule takes every real extension, not just safetensors', () => {
    for (const name of [
      'a.safetensors', 'b.sft', 'c.ckpt', 'd.pt', 'e.pth', 'f.bin', 'g.gguf', 'h.onnx', 'i.pkl',
      'UPPER.SAFETENSORS',
    ]) {
      expect(isInstalledModelFile(name), name).toBe(true)
    }
    for (const name of ['pixel_space', 'taesd', 'taef1', '', 'folder/name']) {
      expect(isInstalledModelFile(name), name).toBe(false)
    }
  })
})
