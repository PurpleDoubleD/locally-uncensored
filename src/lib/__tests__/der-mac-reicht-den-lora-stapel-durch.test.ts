/**
 * The LoRA stack on the Mac (09.10.2026). Windows hands the stack of Create
 * to ComfyUI. The Mac has no ComfyUI: its second image engine (mflux) takes
 * LoRA files on its command line, from a folder of the app. These cases hold
 * the way from the catalogue to the request:
 *
 *   the catalogue says which models take a stack (the packs of the second
 *   engine do, the sidecar's models do not),
 *   a run sends the stack to such a model, in the order it was picked,
 *   a model of the sidecar is never sent one,
 *   and the store keeps the stack against the Mac's folder the way it keeps
 *   it against ComfyUI's list.
 *
 * Run: npx vitest run src/lib/__tests__/der-mac-reicht-den-lora-stapel-durch.test.ts
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

import { buildMlxImageModels, generateMlxImageDataUrl, listMlxImageModels, mlxGenerate, type MlxImageModel } from '../../api/mlx-image'
import { listMlxLoras, openMlxLoraFolder, deleteMlxLora, mlxLoraKeysNote } from '../../api/mlx-loras'
import { MFLUX_FAMILY, takesMlxLoras } from '../image-engines'
import { lorasForRun, loraRows, skippedLorasLine } from '../lora-stack'
import { useCreateStore } from '../../stores/createStore'

const WURZEL = resolve(__dirname, '../../..')
const entry = (id: string, extra: Partial<MlxImageModel> = {}): MlxImageModel => ({
  id, name: id, repo: `org/${id}`, sizeGB: 1, sizeBytes: 1e9, minRamGB: 16, steps: 25, guidance: 1, defaultSize: 1024,
  unfiltered: false, description: '', installed: true, family: 'diffusers', editImages: 0, userSampling: null, loras: false, ...extra,
})
const QWEN = entry('qwen-image-2.1-8bit', { family: MFLUX_FAMILY, editImages: 10, userSampling: true, loras: true })
const TURBO = entry('qwen-image-2.1-turbo', { family: MFLUX_FAMILY, editImages: 10, userSampling: false, steps: 6, loras: true })
const ZIMAGE = entry('z-image-turbo-4bit', { family: MFLUX_FAMILY, userSampling: false, steps: 9, loras: true })
const SDTURBO = entry('sd-turbo', { defaultSize: 512 })
const STACK = [{ name: 'qwen/detail.safetensors', strength: 0.8 }, { name: 'slider.safetensors', strength: -4 }]
const sent = () => calls.find((c) => c.cmd === 'mlx_generate')?.args as Record<string, unknown> | undefined

beforeEach(async () => {
  calls.length = 0
  replies = {
    mlx_status: { installed: true, running: true, port: 47712, unsupported: null, mfluxInstalled: true },
    mlx_image_models: [SDTURBO, ZIMAGE, QWEN, TURBO],
    mlx_generate: { image_base64: 'AAAA', width: 1024, height: 1024, steps: 25, guidance: 1, output: '/i/mlx-1.png' },
    mlx_generate_progress: { running: false, step: 0, steps: 0 },
    mlx_generate_cancel: { ok: true, stopped: false },
    mlx_loras: { dir: '/data/loras', loras: [{ name: 'qwen/detail.safetensors', sizeBytes: 150, keys: 'peft' }, { name: 'slider.safetensors', sizeBytes: 9, keys: 'kohya' }] },
    mlx_loras_open_folder: { ok: true, dir: '/data/loras' },
    mlx_lora_delete: { ok: true },
  }
  await listMlxImageModels()
  calls.length = 0
})

describe('which models take a LoRA stack on the Mac', () => {
  it('Rust says it under the name read here, and takes the stack under the name sent here', () => {
    const rust = readFileSync(resolve(WURZEL, 'src-tauri/src/commands/mlx.rs'), 'utf8')
    expect(rust).toContain('"loras": c.mflux.is_some_and(|pack| pack.takes_loras())')
    expect(rust).toContain('loras: Vec<LoraArg>')
    expect(rust).toMatch(/struct LoraArg \{\s*name: String,\s*#\[serde\(default = "full_strength"\)\]\s*strength: f32,/)
    const folder = readFileSync(resolve(WURZEL, 'src-tauri/src/commands/mlx_loras.rs'), 'utf8')
    for (const key of ['"name": l.name', '"sizeBytes": l.bytes', '"keys": l.keys.id()', '"dir": root.to_string_lossy()']) expect(folder).toContain(key)
  })

  it('the packs of the second engine do, the models of the sidecar do not', () => {
    const list = buildMlxImageModels([SDTURBO, ZIMAGE, QWEN, TURBO])
    expect(list.map((m) => [m.name, m.mlxLoras])).toEqual([
      ['MLX sd-turbo', undefined],
      ['MLX z-image-turbo-4bit', true],
      ['MLX qwen-image-2.1-8bit', true],
      ['MLX qwen-image-2.1-turbo', true],
    ])
    expect(takesMlxLoras(list, 'MLX qwen-image-2.1-8bit')).toBe(true)
    expect(takesMlxLoras(list, 'MLX qwen-image-2.1-turbo')).toBe(true)
    expect(takesMlxLoras(list, 'MLX sd-turbo')).toBe(false)
    expect(takesMlxLoras(list, 'not in the list')).toBe(false)
  })

  it('an older backend that does not say so gives no model a stack', () => {
    const silent = buildMlxImageModels([{ ...QWEN, loras: undefined }])
    expect(takesMlxLoras(silent, silent[0].name)).toBe(false)
  })

  it('COUNTER-CHECK: a ComfyUI list never carries the mark, whatever the file is', () => {
    const comfy = [{ name: 'qwen_image_2.1_int8_convrot.safetensors' }, { name: 'sdxl_base.safetensors' }]
    for (const m of comfy) expect(takesMlxLoras(comfy, m.name)).toBe(false)
  })
})

describe('a run hands the stack to the second engine', () => {
  it('in the order it was picked, each file with its strength', async () => {
    await generateMlxImageDataUrl({ prompt: 'x', model: 'qwen-image-2.1-8bit', steps: 25, guidance: 1, seed: 1, width: 1024, height: 1024, loras: STACK })
    expect(sent()).toEqual({
      prompt: 'x', model: 'qwen-image-2.1-8bit', steps: 25, guidance: 1, seed: 1, width: 1024, height: 1024,
      loras: [{ name: 'qwen/detail.safetensors', strength: 0.8 }, { name: 'slider.safetensors', strength: -4 }],
      run: expect.any(String),
    })
  })

  it('Turbo keeps running at its own count and still gets the stack', async () => {
    await generateMlxImageDataUrl({ prompt: 'x', model: 'qwen-image-2.1-turbo', steps: 30, guidance: 4, seed: 1, loras: STACK })
    expect(sent()).toEqual({ prompt: 'x', model: 'qwen-image-2.1-turbo', seed: 1, loras: STACK, run: expect.any(String) })
  })

  it('an edit carries its images and the stack', async () => {
    await generateMlxImageDataUrl({ prompt: 'x', model: 'qwen-image-2.1-8bit', images: ['/v/start-images/a.png'], resolution: 1024, loras: STACK.slice(0, 1) })
    expect(sent()).toMatchObject({ images: ['/v/start-images/a.png'], resolution: 1024, loras: [STACK[0]] })
  })

  it('an empty stack is not on the request at all', async () => {
    await generateMlxImageDataUrl({ prompt: 'x', model: 'qwen-image-2.1-8bit', loras: [] })
    expect(sent()).not.toHaveProperty('loras')
    calls.length = 0
    await mlxGenerate({ prompt: 'x' })
    expect(sent()).toEqual({ prompt: 'x' })
  })

  it('COUNTER-CHECK: a model of the sidecar is never sent one', async () => {
    await generateMlxImageDataUrl({ prompt: 'x', model: 'sd-turbo', steps: 4, seed: 1, loras: STACK })
    expect(sent()).toEqual({ prompt: 'x', model: 'sd-turbo', steps: 4, seed: 1, run: expect.any(String), stall_timeout_secs: expect.any(Number) })
  })
})

describe('the folder as the interface reads it', () => {
  it('lists what Rust lists, opens the folder and deletes by name', async () => {
    const listing = await listMlxLoras()
    expect(listing.dir).toBe('/data/loras')
    expect(listing.loras.map((l) => l.name)).toEqual(['qwen/detail.safetensors', 'slider.safetensors'])
    await openMlxLoraFolder()
    await deleteMlxLora('slider.safetensors')
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ['mlx_loras', {}],
      ['mlx_loras_open_folder', {}],
      ['mlx_lora_delete', { name: 'slider.safetensors' }],
    ])
  })

  it('an answer without a list is an empty folder, not a crash', async () => {
    replies.mlx_loras = { dir: '/data/loras' }
    expect(await listMlxLoras()).toEqual({ dir: '/data/loras', loras: [] })
  })

  it('says of a file what not every model reads, and nothing of a plain one', () => {
    expect(mlxLoraKeysNote('peft')).toBeNull()
    expect(mlxLoraKeysNote('kohya')).toMatch(/Qwen-Image 2\.1 does not/)
    expect(mlxLoraKeysNote('other')).toMatch(/may refuse/)
    expect(mlxLoraKeysNote('unreadable')).toMatch(/incomplete download/)
  })
})

describe('the stack in the store against the Mac\'s folder', () => {
  const names = ['qwen/detail.safetensors', 'slider.safetensors']
  beforeEach(() => useCreateStore.setState({ selectedLoras: [], loraStrengths: {} }))

  it('adds in the order of the clicks, sets a strength, takes one out again', () => {
    const s = () => useCreateStore.getState()
    s().toggleLora('slider.safetensors')
    s().toggleLora('qwen/detail.safetensors')
    expect(s().selectedLoras.map((l) => l.name)).toEqual(['slider.safetensors', 'qwen/detail.safetensors'])
    s().setLoraStrengthFor('slider.safetensors', -4)
    s().setLoraStrengthFor('qwen/detail.safetensors', 25)
    expect(s().selectedLoras).toEqual([{ name: 'slider.safetensors', strength: -4 }, { name: 'qwen/detail.safetensors', strength: 20 }])
    s().toggleLora('slider.safetensors')
    expect(s().selectedLoras).toEqual([{ name: 'qwen/detail.safetensors', strength: 20 }])
    // Turned on again it comes back at the end, with the strength it had.
    s().toggleLora('slider.safetensors')
    expect(s().selectedLoras).toEqual([{ name: 'qwen/detail.safetensors', strength: 20 }, { name: 'slider.safetensors', strength: -4 }])
  })

  it('a file taken out of the folder leaves the stack and is named under the result', () => {
    useCreateStore.setState({ selectedLoras: [{ name: 'gone.safetensors', strength: 1 }, { name: names[0], strength: 0.8 }] })
    const pick = lorasForRun(useCreateStore.getState().selectedLoras, names, 'qwenimage')
    expect(pick.use).toEqual([{ name: names[0], strength: 0.8 }])
    expect(skippedLorasLine(pick.missing, pick.otherModel)?.replace('models/loras', 'the LoRA folder'))
      .toBe('Skipping LoRA no longer in the LoRA folder: gone')
    useCreateStore.getState().keepListedLoras(names)
    expect(useCreateStore.getState().selectedLoras).toEqual([{ name: names[0], strength: 0.8 }])
  })

  it('a folder that could not be read proves nothing gone', () => {
    const picks = [{ name: 'gone.safetensors', strength: 1 }]
    expect(lorasForRun(picks, null, 'qwenimage').use).toEqual(picks)
  })

  it('a file in a subfolder is a row under its path, and a Z-Image character stays Z-Image only', () => {
    const rows = loraRows([...names, 'char_mira_zimage.safetensors'], [], 'qwenimage')
    expect(rows.map((r) => [r.label, r.fits])).toEqual([['qwen/detail', true], ['slider', true], ['char_mira_zimage', false]])
    expect(loraRows(['char_mira_zimage.safetensors'], [], 'zimage')[0].fits).toBe(true)
  })
})
