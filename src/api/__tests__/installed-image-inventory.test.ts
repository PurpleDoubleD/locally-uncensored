/**
 * Befund 1 of the abnahme counter-check on the real 2.6.7 Windows build
 * (2026-08-29, ergebnis-abnahme-durchklick.md).
 *
 * Endstate there, category Image: the rail said 3, the Installed list held
 * three checkpoints, and two cards in "Get new" read Installed that were in
 * no list and no counter at all. Their files were on the disk and measured:
 *
 *   C:\Users\ddrob\ComfyUI\models\loras\pixel-art-xl.safetensors   163 MB
 *   C:\Users\ddrob\ComfyUI\models\vae\sdxl_vae.safetensors         319 MB
 *
 * Beside them lay two more LoRAs, four text encoders and five more VAEs that
 * no surface in the app had ever mentioned. The cards told the truth; the
 * counter and the list read checkpoints\ and diffusion_models\ and nothing
 * else. So the user could not see what those files cost him and could not
 * remove one of them from the list.
 *
 * Same bug shape as GH #113 and as the video round before it: card, counter
 * and list answering from different readers. These tests pin the one reader
 * the image counter and the Installed list use now, that it covers every
 * storage folder, and that the Create picker reader did NOT move with it: a
 * VAE is never a main model.
 *
 * Run: npx vitest run src/api/__tests__/installed-image-inventory.test.ts
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
  getImageModels, getInstalledImageModels, getVideoModels,
  subfolderForSource, readModelDiskSizes,
} from '../comfyui'
import { ENUM_SUBFOLDERS, ANIMATEDIFF_SUBFOLDER, readComfyModelNames } from '../discover'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

// The two addon files of the counter-check, spelled as the box spells them.
const LORA = 'pixel-art-xl.safetensors'
const VAE = 'sdxl_vae.safetensors'
// And the three checkpoints that were already counted.
const CKPT_RV = 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors'
const CKPT_TURBO = 'sd_turbo.safetensors'
const UNET_Z = 'z_image_bf16.safetensors'

function routeObjectInfo(opts: {
  checkpoints?: string[]
  unets?: string[]
  gguf?: string[]
  loras?: string[] | 'missing'
  vaes?: string[]
  clips?: string[]
}) {
  const { checkpoints = [], unets = [], gguf = [], loras = [], vaes = [], clips = [] } = opts
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('CheckpointLoaderSimple')) {
      return okJson({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } })
    }
    if (url.includes('UnetLoaderGGUF')) {
      return okJson({ UnetLoaderGGUF: { input: { required: { unet_name: [gguf] } } } })
    }
    if (url.includes('UNETLoader')) {
      return okJson({ UNETLoader: { input: { required: { unet_name: [unets] } } } })
    }
    if (url.includes('LoraLoader')) {
      if (loras === 'missing') return { ok: false, status: 404, json: async () => ({}) }
      return okJson({ LoraLoader: { input: { required: { lora_name: [loras] } } } })
    }
    if (url.includes('VAELoader')) {
      return okJson({ VAELoader: { input: { required: { vae_name: [vaes] } } } })
    }
    if (url.includes('CLIPLoader')) {
      return okJson({ CLIPLoader: { input: { required: { clip_name: [clips] } } } })
    }
    return okJson({})
  })
}

beforeEach(() => {
  localFetch.mockReset()
  backendCall.mockReset()
  // Every file on disk and complete, unless a test says otherwise. This is
  // the size probe filterPartialFiles and readModelDiskSizes both ask.
  backendCall.mockImplementation(async (_cmd: string, args: { files: Array<{ filename: string }> }) =>
    args.files.map((f) => ({ filename: f.filename, exists: true, actualBytes: 1024, complete: true })),
  )
})

describe('the Image inventory sees what the cards see', () => {
  it('THE FIX: the LoRA and the VAE of the counter-check are in the image inventory', async () => {
    routeObjectInfo({ loras: [LORA], vaes: [VAE] })
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names).toContain(LORA)
    expect(names).toContain(VAE)
  })

  it('the exact counter-check endstate: three counted files plus everything that was invisible', async () => {
    routeObjectInfo({
      checkpoints: [CKPT_RV, CKPT_TURBO],
      unets: [UNET_Z],
      loras: [LORA, 'char_lukompass_v1.safetensors', 'char_lukompass_v2.safetensors'],
      vaes: [VAE, 'ae.safetensors', 'wan_2.1_vae.safetensors', 'flux2-vae.safetensors', 'mochi_vae.safetensors', 'cosmos_cv8x8x8_1.0.safetensors'],
      clips: ['t5xxl_fp8_e4m3fn.safetensors', 'clip_l.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', 'qwen_3_4b.safetensors'],
    })
    const names = (await getInstalledImageModels()).map((m) => m.name)
    // the three that were counted before
    expect(names).toContain(CKPT_RV)
    expect(names).toContain(CKPT_TURBO)
    expect(names).toContain(UNET_Z)
    // three LoRAs, six VAEs, four text encoders: 3 + 3 + 6 + 4
    expect(names).toHaveLength(16)
    expect(new Set(names).size).toBe(names.length) // no double counting
  })

  it('every addon carries the folder it lives in, so the size probe and the delete can find it', async () => {
    routeObjectInfo({ checkpoints: [CKPT_TURBO], loras: [LORA], vaes: [VAE], clips: ['clip_l.safetensors'] })
    const bySource = new Map((await getInstalledImageModels()).map((m) => [m.name, m.source]))
    expect(bySource.get(CKPT_TURBO)).toBe('checkpoint')
    expect(bySource.get(LORA)).toBe('lora')
    expect(bySource.get(VAE)).toBe('vae')
    expect(bySource.get('clip_l.safetensors')).toBe('text_encoder')
    expect(subfolderForSource('lora')).toBe('loras')
    expect(subfolderForSource('vae')).toBe('vae')
    expect(subfolderForSource('text_encoder')).toBe('text_encoders')
  })

  it('a file two loaders both list stays one entry', async () => {
    // ComfyUI does offer the same file through more than one enum. One file on
    // the disk is one line in the list, or the counter starts inventing.
    routeObjectInfo({ checkpoints: [CKPT_TURBO], vaes: [CKPT_TURBO] })
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names).toEqual([CKPT_TURBO])
  })

  it('one failing lane costs itself, never the rest of the list', async () => {
    // LoraLoader absent (a custom-node distro without it). The inventory is
    // short one folder and complete in every other.
    routeObjectInfo({ checkpoints: [CKPT_TURBO], loras: 'missing', vaes: [VAE] })
    const names = (await getInstalledImageModels()).map((m) => m.name)
    expect(names).toContain(CKPT_TURBO)
    expect(names).toContain(VAE)
    expect(names).not.toContain(LORA)
  })
})

describe('NEGATIVE CONTROL: the pickers did not move', () => {
  it('the Create image picker still offers no LoRA, no VAE and no text encoder', async () => {
    routeObjectInfo({
      checkpoints: [CKPT_TURBO], loras: [LORA], vaes: [VAE], clips: ['clip_l.safetensors'],
    })
    const picker = (await getImageModels()).map((m) => m.name)
    expect(picker).toEqual([CKPT_TURBO])
    expect(picker).not.toContain(LORA)
    expect(picker).not.toContain(VAE)
    expect(picker).not.toContain('clip_l.safetensors')
  })

  it('the video picker is untouched by the addon folders too', async () => {
    routeObjectInfo({ loras: [LORA], vaes: [VAE], clips: ['clip_l.safetensors'] })
    expect(await getVideoModels()).toEqual([])
  })

  it('an empty ComfyUI yields an empty inventory, not a phantom entry', async () => {
    routeObjectInfo({})
    expect(await getInstalledImageModels()).toEqual([])
  })
})

describe('the size on disk reaches the card', () => {
  it('asks the folder each file actually lives in and returns the measured bytes', async () => {
    const sizes = await readModelDiskSizes([
      { name: LORA, type: 'unknown', source: 'lora' },
      { name: VAE, type: 'unknown', source: 'vae' },
    ])
    expect(sizes.get(LORA)).toBe(1024)
    expect(sizes.get(VAE)).toBe(1024)
    const [, args] = backendCall.mock.calls[0] as [string, { files: Array<{ subfolder: string; filename: string }> }]
    expect(args.files).toEqual([
      { subfolder: 'loras', filename: LORA, expectedBytes: 0 },
      { subfolder: 'vae', filename: VAE, expectedBytes: 0 },
    ])
  })

  it('NEGATIVE CONTROL: a failing probe costs the sizes, never the list', async () => {
    backendCall.mockRejectedValue(new Error('ComfyUI path not set'))
    const sizes = await readModelDiskSizes([{ name: LORA, type: 'unknown', source: 'lora' }])
    expect(sizes.size).toBe(0)
  })

  it('NEGATIVE CONTROL: a file the probe cannot find gets no invented size', async () => {
    backendCall.mockResolvedValue([{ filename: LORA, exists: false, actualBytes: 0, complete: false }])
    const sizes = await readModelDiskSizes([{ name: LORA, type: 'unknown', source: 'lora' }])
    expect(sizes.has(LORA)).toBe(false)
  })

  it('nothing to weigh means no backend call at all', async () => {
    expect((await readModelDiskSizes([])).size).toBe(0)
    expect(backendCall).not.toHaveBeenCalled()
  })
})

describe('the shared visibility reader covers the LoRA folder', () => {
  it('readComfyModelNames lists a LoRA now', async () => {
    routeObjectInfo({ loras: [LORA] })
    expect(await readComfyModelNames()).toContain(LORA)
  })

  it('loras is one of the folders the installed check can reason about', () => {
    expect(ENUM_SUBFOLDERS.has('loras')).toBe(true)
  })

  it('the motion-module folder is spelled the same in both modules', () => {
    // comfyui.ts cannot import discover.ts statically (discover imports back),
    // so the string is written twice. This is the seam that keeps them equal.
    expect(subfolderForSource('motion_module')).toBe(ANIMATEDIFF_SUBFOLDER)
  })
})
