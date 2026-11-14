/**
 * The MiniMax H3 turbo LoRA is a catalog download (Discord 2026-10-03,
 * A user: 3.0.4 said "put the turbo lora in the lora stack and it runs
 * at 8 steps", and he asked how the LoRA gets there).
 *
 * The file is the one the official Comfy-Org templates video_minimax_h3_t2v
 * and _i2v load. Read from the Hugging Face tree API and an anonymous HEAD on
 * 2026-10-03: Comfy-Org/MiniMax-H3, not gated, loras/minimax_h3_fl2v_turbo_
 * 8step_v1.0_comfyui_bf16.safetensors, 1956193000 bytes, and the origin repo
 * lightx2v/Minimax-h3-Turbo states the same sha256 for it.
 *
 * Run: npx vitest run src/api/__tests__/h3-turbo-lora-is-one-click.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend')>()
  return { ...actual, backendCall: vi.fn(), localFetch: vi.fn(), comfyuiUrl: (p: string) => `http://test${p}` }
})

import { getVideoBundles, getLoraAddonBundles } from '../model-bundles'
import { lookupFileMeta, checkBundlesInstalled, onDiskMatchesCatalog } from '../discover'
import { bundleForVideoIntent, classifyModel, subfolderForSource } from '../comfyui'
import { backendCall } from '../backend'
import { defaultLoraStrength } from '../../lib/lora-strength'

const FILE = 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
const SHA = '2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e'
const BYTES = 1956193000
const GIB = 1024 ** 3

const turbo = () => getVideoBundles().find((b) => b.files.some((f) => f.filename === FILE))!

describe('the download entry is complete', () => {
  it('one file: URL, folder, size and sha256 as Hugging Face states them', () => {
    const b = turbo()
    expect(b).toBeDefined()
    expect(b.files).toHaveLength(1)
    const f = b.files[0]
    expect(f.downloadUrl).toBe(`https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/${FILE}`)
    expect(f.filename).toBe(FILE)
    expect(f.subfolder).toBe('loras')
    expect(f.sizeBytes).toBe(BYTES)
    expect(f.sha256).toBe(SHA)
    // The shown size is the byte count in GiB, like the rest of the catalog.
    expect(f.sizeGB).toBeCloseTo(BYTES / GIB, 2)
    expect(b.totalSizeGB).toBe(f.sizeGB)
  })

  it('the folder is the one the LoRA stack reads', () => {
    expect(turbo().files[0].subfolder).toBe(subfolderForSource('lora'))
  })

  it('a retry or resume finds the same URL, folder and checksum', () => {
    const meta = lookupFileMeta(FILE)
    expect(meta).toMatchObject({ url: turbo().files[0].downloadUrl, subfolder: 'loras', sha256: SHA })
  })

  it('counts as installed only at exactly its size', async () => {
    const b = turbo()
    vi.mocked(backendCall).mockResolvedValueOnce([{ filename: FILE, exists: true, actualBytes: BYTES, complete: true }] as never)
    expect(await checkBundlesInstalled([b])).toEqual({ [b.name]: true })
    expect(vi.mocked(backendCall).mock.calls[0]).toEqual(['check_model_sizes', {
      files: [{ subfolder: 'loras', filename: FILE, expectedBytes: Math.round(1.82 * GIB) }],
    }])
    // The 4 step LoRA renamed by hand, or a cut download: not this file.
    expect(onDiskMatchesCatalog(b.files[0], { complete: true, actualBytes: BYTES - 8 })).toBe(false)
  })
})

describe('where it shows', () => {
  it('as an add-on of the H3 family, right behind the H3 bundle', () => {
    const all = getVideoBundles()
    const b = turbo()
    expect(b.name).toBe('MiniMax H3 Turbo LoRA · 8 Steps')
    expect(b.workflow).toBe('minimaxh3')
    expect(b.tier).toBe('best')
    expect(all[all.findIndex((x) => x.name === b.name) - 1].name).toBe('MiniMax H3 · Start/End Frames, with Sound')
    // The first minimaxh3 entry stays the model itself.
    expect(all.find((x) => x.workflow === 'minimaxh3')!.name).toBe('MiniMax H3 · Start/End Frames, with Sound')
    // It needs the model next to it, so it is sized like the model.
    const model = all.find((x) => x.workflow === 'minimaxh3')!
    expect([b.vramMinGB, b.vramComfortGB]).toEqual([model.vramMinGB, model.vramComfortGB])
  })

  it('on Models, LoRAs, Get new, next to the other catalog LoRA', () => {
    const names = getLoraAddonBundles().map((b) => b.name)
    expect(names).toContain('MiniMax H3 Turbo LoRA · 8 Steps')
    expect(names).toContain('Pixel Art XL · SDXL LoRA')
    for (const b of getLoraAddonBundles()) for (const f of b.files) expect(f.subfolder).toBe('loras')
  })

  it('is never the starter download of a video lane', () => {
    for (const intent of ['video', 'animate', 'extend']) {
      expect(bundleForVideoIntent(getVideoBundles(), intent)?.name).not.toBe(turbo().name)
    }
    expect(bundleForVideoIntent([turbo()], 'video')).toBeUndefined()
  })
})

describe('what the cards say', () => {
  it('the H3 bundle names the fastest way, in the two lines a card shows', () => {
    const h3 = getVideoBundles().find((b) => b.name === 'MiniMax H3 · Start/End Frames, with Sound')!
    expect(h3.description).toMatch(/Fastest way: add the MiniMax H3 Turbo LoRA, 8 steps instead of 20\./)
    expect(h3.description.length).toBeLessThanOrEqual(170)
  })

  it('the add-on says where to turn it on, FastH3 stays the prompt only route', () => {
    expect(turbo().description).toMatch(/LoRA stack/)
    expect(turbo().description).toMatch(/from a prompt or a first frame/)
    const fast = getVideoBundles().find((b) => b.name === 'FastH3 · MiniMax H3 in 8 Steps')!
    expect(fast.description).toMatch(/Text to video only/)
  })

  it('no dash characters in the new texts', () => {
    for (const text of [turbo().name, turbo().description, turbo().files[0].name, turbo().files[0].description]) {
      expect(text).not.toMatch(/[\u2013\u2014]/)
    }
  })
})

describe('once it is in the stack', () => {
  it('the name carries the step count the H3 builder reads, and it starts at strength 1', () => {
    expect(/turbo\D*?(\d+)\s*_?steps?/i.exec(FILE)?.[1]).toBe('8')
    expect(defaultLoraStrength(FILE)).toBe(1)
    // A LoRA file of the H3 family, not a second model in the video picker.
    expect(classifyModel(FILE)).toBe('minimaxh3')
  })
})
