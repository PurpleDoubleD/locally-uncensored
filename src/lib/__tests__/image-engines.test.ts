/**
 * The Mac has a second image engine (mflux, for packs that are quantized
 * already, Qwen-Image 2.1 among them). It installs with the first model that
 * needs it, inside that model's own install. These tests hold the places the
 * surface has to know about it:
 *
 *  - Get on such a pack does not set the sidecar engine up beforehand,
 *  - Get on any other image model still does,
 *  - either engine counts as "an image engine is set up",
 *  - an image from such a pack goes straight to `mlx_generate`, with no
 *    sidecar started and the catalogue's step count,
 *  - and the one-click setup in Create never picks an experimental pack.
 *
 * Run: npx vitest run src/lib/__tests__/image-engines.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type Reply = unknown | ((args: unknown) => unknown)
let replies: Record<string, Reply> = {}
const calls: Array<{ cmd: string; args: unknown }> = []

vi.mock('../../api/backend', () => ({
  backendCall: async (cmd: string, payload?: { args?: unknown }) => {
    calls.push({ cmd, args: payload?.args })
    if (!(cmd in replies)) throw new Error(`unexpected command: ${cmd}`)
    const reply = replies[cmd]
    return typeof reply === 'function' ? (reply as (a: unknown) => unknown)(payload?.args) : reply
  },
  isTauri: () => true,
  isMacOS: () => true,
}))
vi.mock('../../stores/mlxInstallStore', () => ({
  mlxLaneGeneration: () => 0,
  useMlxInstallStore: {
    getState: () => ({
      watch: vi.fn(),
      begin: vi.fn(),
      abandon: vi.fn(),
      settled: async () => {},
      starting: <T>(_lane: string, call: Promise<T>) => call,
    }),
  },
}))
vi.mock('../bundle-install', () => ({ waitOrAbort: vi.fn(async () => {}) }))

import { buildMlxImageModels, generateMlxImageDataUrl, listMlxImageModels, mlxModelType, type MlxImageModel } from '../../api/mlx-image'
import { installMlxModel, installMlxStack } from '../../api/mlx-install'
import {
  MAC_EDIT_DEAD_SIDE, MAC_EDIT_SIDE_INSTEAD, MFLUX_FAMILY, anyImageEngineReady, editCanvas, imageLaneModels, macEditCanvas, macEditSide, imageModelBringsItsEngine, laneImageModel,
  mlxTakesEditImage, runsAtOwnSampling,
} from '../image-engines'

const WURZEL = resolve(__dirname, '../../..')
const DONE = { status: 'complete', logs: [], error: null, download_progress: 0, download_total: 0, download_speed: 0 }
const model = (id: string, family: string, sizeGB: number, installed = false) => ({
  id, name: id, repo: `org/${id}`, sizeGB, minRamGB: 16, steps: 40, guidance: 1, defaultSize: 1024,
  unfiltered: false, description: '', installed, family,
})
const CATALOGUE = [
  model('sd-turbo', 'diffusers', 2.6, true),
  model('flux2-klein-4b-4bit', MFLUX_FAMILY, 4.6),
  model('juggernaut-xl-v9', 'diffusers', 6.9),
  model('qwen-image-2.1-8bit', MFLUX_FAMILY, 18.5, true),
]
const cmds = () => calls.map((c) => c.cmd)

describe('the second image engine', () => {
  beforeEach(() => {
    calls.length = 0
    replies = {
      mlx_status: { installed: false, running: false, port: 47712, unsupported: null, mfluxInstalled: false },
      mlx_image_models: CATALOGUE,
      mlx_image_install_model: { ok: true, status: 'installing' },
      mlx_image_install_status: DONE,
      install_mlx_diffusion: { ok: true, status: 'installing' },
      install_mlx_diffusion_status: DONE,
      mlx_generate: { image_base64: 'AAAA', width: 1024, height: 1024, output: '/i/mlx-1.png' },
    }
  })

  it('names the family the way Rust does', () => {
    const rust = readFileSync(resolve(WURZEL, 'src-tauri/src/commands/mlx.rs'), 'utf8')
    expect(rust).toContain(`"family": if c.mflux.is_some() { "${MFLUX_FAMILY}" } else { "diffusers" }`)
    expect(imageModelBringsItsEngine(MFLUX_FAMILY)).toBe(true)
    for (const family of ['diffusers', '', undefined]) expect(imageModelBringsItsEngine(family)).toBe(false)
  })

  it('Get on an mflux pack does not set the sidecar engine up', async () => {
    await installMlxModel('image', { id: 'qwen-image-2.1-8bit', name: 'Qwen-Image 2.1 8-bit', family: MFLUX_FAMILY })
    expect(cmds()).not.toContain('install_mlx_diffusion')
    expect(calls.find((c) => c.cmd === 'mlx_image_install_model')?.args).toEqual({ id: 'qwen-image-2.1-8bit' })
  })

  it('COUNTER-CHECK: Get on a model of the sidecar sets that engine up first', async () => {
    await installMlxModel('image', { id: 'juggernaut-xl-v9', name: 'Juggernaut XL v9', family: 'diffusers' })
    expect(cmds().indexOf('install_mlx_diffusion')).toBeGreaterThanOrEqual(0)
    expect(cmds().indexOf('install_mlx_diffusion')).toBeLessThan(cmds().indexOf('mlx_image_install_model'))
    // Having the second engine does not stand in for the first.
    calls.length = 0
    replies.mlx_status = { installed: false, running: false, port: 47712, mfluxInstalled: true }
    await installMlxModel('image', { id: 'juggernaut-xl-v9', name: 'Juggernaut XL v9' })
    expect(cmds()).toContain('install_mlx_diffusion')
  })

  it('either engine is an image engine that is set up', () => {
    expect(anyImageEngineReady(null)).toBe(false)
    expect(anyImageEngineReady({ installed: false })).toBe(false)
    expect(anyImageEngineReady({ installed: false, mfluxInstalled: false })).toBe(false)
    expect(anyImageEngineReady({ installed: true, mfluxInstalled: false })).toBe(true)
    expect(anyImageEngineReady({ installed: false, mfluxInstalled: true })).toBe(true)
  })

  it('an image from an mflux pack needs no sidecar and runs at the catalogue step count', async () => {
    replies.mlx_status = { installed: false, running: false, port: 47712, mfluxInstalled: true }
    const made = await generateMlxImageDataUrl({ prompt: 'a red panda', model: 'qwen-image-2.1-8bit', steps: 25, seed: 7, width: 1024, height: 1024 })
    expect(made).toEqual({ dataUrl: 'data:image/png;base64,AAAA', width: 1024, height: 1024, localPath: '/i/mlx-1.png' })
    expect(cmds()).not.toContain('mlx_start')
    expect(calls.find((c) => c.cmd === 'mlx_generate')?.args).toEqual({ prompt: 'a red panda', model: 'qwen-image-2.1-8bit', seed: 7, width: 1024, height: 1024, run: expect.any(String) })
  })

  it('COUNTER-CHECK: a sidecar model without the sidecar engine is still refused', async () => {
    replies.mlx_status = { installed: false, running: false, port: 47712, mfluxInstalled: true }
    await expect(generateMlxImageDataUrl({ prompt: 'x', model: 'sd-turbo' })).rejects.toThrow(/not set up/)
    expect(cmds()).not.toContain('mlx_generate')
  })

  it('the one-click setup never picks an experimental pack', async () => {
    replies.mlx_status = { installed: true, running: false, port: 47712 }
    await installMlxStack('image')
    // flux2-klein-4b-4bit is the smallest one missing, and it is passed over.
    expect(calls.find((c) => c.cmd === 'mlx_image_install_model')?.args).toEqual({ id: 'juggernaut-xl-v9' })
  })

  it('the quantized Z-Image packs are Z-Image to Create', () => {
    expect(mlxModelType({ id: 'z-image-turbo-4bit', defaultSize: 1024 })).toBe('zimage')
    expect(mlxModelType({ id: 'z-image-turbo', defaultSize: 1024 })).toBe('zimage')
    expect(mlxModelType({ id: 'z-image', defaultSize: 1024 })).toBe('sdxl')
  })
})

/**
 * Qwen-Image 2.1 on the Mac does what it does on Windows (08.10.2026): it
 * edits one image or several, and it takes the steps and the CFG set in
 * Create. What the surface has to know for that comes from the catalogue.
 */
describe('Qwen-Image 2.1 edits on the Mac and takes Create\'s settings', () => {
  const entry = (id: string, extra: Partial<MlxImageModel> = {}): MlxImageModel => ({
    id, name: id, repo: `org/${id}`, sizeGB: 1, sizeBytes: 1e9, minRamGB: 16, steps: 25, guidance: 1, defaultSize: 1024,
    unfiltered: false, description: '', installed: true, family: 'diffusers', editImages: 0, userSampling: null, ...extra,
  })
  const QWEN = entry('qwen-image-2.1-8bit', { family: MFLUX_FAMILY, editImages: 10, userSampling: true })
  const TURBO = entry('qwen-image-2.1-turbo', { family: MFLUX_FAMILY, editImages: 10, userSampling: false, steps: 6 })
  const ZIMAGE = entry('z-image-turbo-4bit', { family: MFLUX_FAMILY, userSampling: false, steps: 9 })
  const SDTURBO = entry('sd-turbo', { defaultSize: 512 })

  beforeEach(async () => {
    calls.length = 0
    replies = {
      mlx_status: { installed: true, running: true, port: 47712, unsupported: null, mfluxInstalled: true },
      mlx_image_models: [SDTURBO, ZIMAGE, QWEN, TURBO],
      mlx_generate: { image_base64: 'AAAA', width: 1376, height: 768, steps: 30, guidance: 4, output: '/i/mlx-1.png' },
      mlx_generate_progress: { running: true, step: 3, steps: 30 },
      mlx_generate_cancel: { ok: true, stopped: true },
    }
    // As the app does whenever Create reads its models.
    await listMlxImageModels()
    calls.length = 0
  })

  it('Rust says the two things under the names read here', () => {
    const rust = readFileSync(resolve(WURZEL, 'src-tauri/src/commands/mlx.rs'), 'utf8')
    expect(rust).toContain('"editImages": c.mflux.map_or(0, |pack| pack.edit_images())')
    expect(rust).toContain('"userSampling": c.mflux.map(|pack| pack.user_sampling())')
    for (const field of ['guidance: Option<f32>', 'images: Vec<String>', 'resolution: Option<u32>']) expect(rust).toContain(field)
  })

  it('is the family Windows runs it as, and says what it can do', () => {
    for (const id of ['qwen-image-2.1-8bit', 'qwen-image-2.1-4bit', 'qwen-image-2.1-turbo']) {
      expect(mlxModelType({ id, defaultSize: 1024 })).toBe('qwenimage')
    }
    // The 20B model is another model, here as on Windows.
    expect(mlxModelType({ id: 'qwen-image-2512-8bit', defaultSize: 1024 })).toBe('sdxl')
    expect(mlxModelType({ id: 'qwen-image-2512', defaultSize: 1024 })).toBe('sdxl')
    const list = buildMlxImageModels([SDTURBO, ZIMAGE, QWEN, TURBO, entry('not-installed', { installed: false })])
    expect(list.map((m) => [m.name, m.type, m.editImages, m.ownSampling])).toEqual([
      ['MLX sd-turbo', 'sd15', 0, undefined],
      ['MLX z-image-turbo-4bit', 'zimage', 0, true],
      ['MLX qwen-image-2.1-8bit', 'qwenimage', 10, undefined],
      ['MLX qwen-image-2.1-turbo', 'qwenimage', 10, true],
    ])
  })

  it('Edit lists the models that take an image, and a ComfyUI list is never narrowed', () => {
    const mac = buildMlxImageModels([SDTURBO, ZIMAGE, QWEN, TURBO])
    expect(imageLaneModels(mac, 'edit').map((m) => m.name)).toEqual(['MLX qwen-image-2.1-8bit', 'MLX qwen-image-2.1-turbo'])
    expect(imageLaneModels(mac, 'image')).toBe(mac)
    expect(mlxTakesEditImage(mac)).toBe(true)
    expect(mlxTakesEditImage(buildMlxImageModels([SDTURBO, ZIMAGE]))).toBe(false)
    expect(imageLaneModels(buildMlxImageModels([SDTURBO]), 'edit')).toEqual([])
    // The pick the tab runs.
    expect(laneImageModel(mac, 'MLX sd-turbo', 'edit')).toBe('MLX qwen-image-2.1-8bit')
    expect(laneImageModel(mac, 'MLX qwen-image-2.1-turbo', 'edit')).toBe('MLX qwen-image-2.1-turbo')
    expect(laneImageModel(mac, 'MLX sd-turbo', 'image')).toBe('MLX sd-turbo')
    expect(runsAtOwnSampling(mac, 'MLX qwen-image-2.1-turbo')).toBe(true)
    expect(runsAtOwnSampling(mac, 'MLX qwen-image-2.1-8bit')).toBe(false)
    expect(runsAtOwnSampling(mac, 'MLX sd-turbo')).toBe(false)

    // Windows and Linux: the same array on every tab, and the pick as it is,
    // also one that is not in the list.
    const comfy: Array<{ name: string; editImages?: number; ownSampling?: boolean }> = [{ name: 'sdxl_base.safetensors' }, { name: 'qwen_image_2.1_int8_convrot.safetensors' }]
    for (const intent of ['image', 'edit', 'removebg']) expect(imageLaneModels(comfy, intent)).toBe(comfy)
    expect(laneImageModel(comfy, 'gone.safetensors', 'edit')).toBe('gone.safetensors')
    expect(mlxTakesEditImage(comfy)).toBe(false)
    expect(runsAtOwnSampling(comfy, 'sdxl_base.safetensors')).toBe(false)
  })

  it('the size of an edit is the engine\'s own rule, in the shape of the first image', () => {
    // Each line was worked out by mflux 0.22.0 itself:
    // QwenImage21LatentCreator.dimensions(side, width / height).
    for (const [side, w, h, width, height] of [
      [1024, 1600, 900, 1376, 768],
      [1024, 600, 800, 896, 1184],
      [1024, 512, 512, 1024, 1024],
      [1024, 3024, 4032, 896, 1184],
      [768, 1920, 1080, 1024, 576],
      [2048, 1000, 3000, 1184, 3552],
      [32, 4000, 100, 192, 32],
    ]) {
      expect(editCanvas(side, { width: w, height: h }), `${side} ${w}x${h}`).toEqual({ width, height })
    }
    // An image whose size is not known is a square.
    expect(editCanvas(1024, { width: 0, height: 0 })).toEqual({ width: 1024, height: 1024 })
  })

  it('an edit never runs on 1024 by 1024, by the numbers Rust moves it with', () => {
    // Real run, 09.10.2026: the model does not edit on that one canvas.
    const mflux = readFileSync(resolve(__dirname, '../../../src-tauri/src/commands/image_mflux.rs'), 'utf-8')
    expect(mflux).toContain(`const EDIT_DEAD_SIDE: u32 = ${MAC_EDIT_DEAD_SIDE};`)
    expect(mflux).toContain(`const EDIT_SIDE_INSTEAD: u32 = ${MAC_EDIT_SIDE_INSTEAD};`)
    expect(macEditSide(1024)).toBe(1056)
    for (const side of [512, 768, 896, 992, 1056, 1536]) expect(macEditSide(side)).toBe(side)
    expect(macEditCanvas({ width: 1024, height: 1024 })).toEqual({ width: 1056, height: 1056 })
    for (const [width, height] of [[1024, 768], [1376, 768], [1056, 1056], [992, 992]]) {
      expect(macEditCanvas({ width, height })).toEqual({ width, height })
    }
  })

  it('steps, CFG, negative prompt and the images of an edit reach mlx_generate', async () => {
    const made = await generateMlxImageDataUrl({
      prompt: 'make the car blue', model: 'qwen-image-2.1-8bit', steps: 30, guidance: 4, seed: 7, negativePrompt: 'blurry',
      images: ['/v/start-images/a.png', '/v/start-images/b.png'], resolution: 1024, width: 1376, height: 768,
    })
    expect(calls.find((c) => c.cmd === 'mlx_generate')?.args).toEqual({
      prompt: 'make the car blue', model: 'qwen-image-2.1-8bit', steps: 30, guidance: 4, seed: 7, negative_prompt: 'blurry',
      images: ['/v/start-images/a.png', '/v/start-images/b.png'], resolution: 1024, width: 1376, height: 768,
      // Every run has a name, which its Cancel carries.
      run: expect.any(String),
    })
    // What the run took comes back for the gallery.
    expect(made).toEqual({ dataUrl: 'data:image/png;base64,AAAA', width: 1376, height: 768, localPath: '/i/mlx-1.png', steps: 30, guidance: 4 })
    expect(cmds()).not.toContain('mlx_start')
  })

  it('COUNTER-CHECK: a pack tuned to one count gets neither steps nor CFG, and still its images', async () => {
    await generateMlxImageDataUrl({ prompt: 'x', model: 'qwen-image-2.1-turbo', steps: 30, guidance: 4, seed: 1, images: ['/v/start-images/a.png'], resolution: 1024 })
    expect(calls.find((c) => c.cmd === 'mlx_generate')?.args).toEqual({ prompt: 'x', model: 'qwen-image-2.1-turbo', seed: 1, images: ['/v/start-images/a.png'], resolution: 1024, run: expect.any(String) })
    calls.length = 0
    await generateMlxImageDataUrl({ prompt: 'x', model: 'z-image-turbo-4bit', steps: 12, guidance: 3.5, seed: 1, width: 1024, height: 1024 })
    expect(calls.find((c) => c.cmd === 'mlx_generate')?.args).toEqual({ prompt: 'x', model: 'z-image-turbo-4bit', seed: 1, width: 1024, height: 1024, run: expect.any(String) })
  })

  it('COUNTER-CHECK: a model of the sidecar keeps its steps and is sent no CFG', async () => {
    await generateMlxImageDataUrl({ prompt: 'x', model: 'sd-turbo', steps: 4, guidance: 7, seed: 1, width: 512, height: 512 })
    expect(calls.find((c) => c.cmd === 'mlx_generate')?.args).toEqual({ prompt: 'x', model: 'sd-turbo', steps: 4, seed: 1, width: 512, height: 512, run: expect.any(String), stall_timeout_secs: expect.any(Number) })
    // An image is passed on, so that Rust can refuse the edit in words. It
    // is never dropped on the way.
    calls.length = 0
    await generateMlxImageDataUrl({ prompt: 'x', model: 'sd-turbo', images: ['/v/start-images/a.png'] })
    expect(calls.find((c) => c.cmd === 'mlx_generate')?.args).toMatchObject({ images: ['/v/start-images/a.png'] })
  })

  it('a running image reports its step, and Cancel ends the engine', async () => {
    vi.useFakeTimers()
    try {
      let finish: (v: unknown) => void = () => {}
      let fail: (e: unknown) => void = () => {}
      replies.mlx_generate = () => new Promise((resolve, reject) => { finish = resolve; fail = reject })
      const steps: Array<[number, number]> = []
      const stop = new AbortController()
      const run = generateMlxImageDataUrl(
        { prompt: 'x', model: 'qwen-image-2.1-8bit', steps: 30 },
        { signal: stop.signal, onStep: (step, of) => steps.push([step, of]) },
      )
      const failed = run.catch((e) => String(e))
      await vi.advanceTimersByTimeAsync(2100)
      expect(steps).toEqual([[3, 30], [3, 30]])
      expect(cmds()).not.toContain('mlx_generate_cancel')
      stop.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(cmds().filter((c) => c === 'mlx_generate_cancel')).toHaveLength(1)
      // Rust answers the generate call with the sentence for a stopped run.
      fail(new Error('The image was not finished because the app stopped the engine.'))
      expect(await failed).toContain('stopped the engine')
      // Nothing polls on after the run has ended.
      const before = calls.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls.length).toBe(before)
      void finish
    } finally {
      vi.useRealTimers()
    }
  })

  it('a run that was cancelled before it began starts nothing', async () => {
    const stop = new AbortController()
    stop.abort()
    await expect(generateMlxImageDataUrl({ prompt: 'x', model: 'qwen-image-2.1-8bit' }, { signal: stop.signal })).rejects.toThrow(/cancelled/)
    expect(cmds()).not.toContain('mlx_generate')
  })
})
