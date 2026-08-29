/**
 * Round 2 of B1 / GH #113, from the counter-check on the real 2.6.7 Windows
 * build (2026-08-29).
 *
 * Endstate there: two video bundles installed cleanly, both cards reading
 * Installed, the rail counter on Video reading 3, and the Installed list
 * holding three Wan files and neither AnimateDiff bundle. Same bug shape as
 * the round 1 finding, one layer further out: the card checks its own files,
 * the counter and the list read the four ComfyUI\models loaders, and
 * AnimateDiff-Evolved keeps its motion modules in
 * custom_nodes/ComfyUI-AnimateDiff-Evolved/models. Nothing that reads only
 * ComfyUI\models can ever see them.
 *
 * Second finding in the same frame: the other file of those bundles, the
 * Realistic Vision SD1.5 checkpoint, was counted under Image only, so one
 * video bundle showed up half in the wrong lane and half nowhere.
 *
 * These tests pin the inventory reader the counter and the Installed list use
 * now, and they pin that the Create picker reader did NOT change with it: a
 * motion module is half of a pair, never a main model.
 *
 * Run: npx vitest run src/api/__tests__/installed-video-inventory.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  isTauri: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

import {
  getVideoModels, getImageModels, getInstalledVideoModels, getAnimateDiffMotionModels,
  classifyModel, isImageModelType,
} from '../comfyui'
import { ENUM_SUBFOLDERS, ANIMATEDIFF_SUBFOLDER, readComfyModelNames, modelsNotVisibleInComfy } from '../discover'
import { getVideoBundles } from '../discover'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

/** The two files of the AnimateDiff bundles, exactly as the catalogue and the
 *  box name them. */
const MOTION_LIGHTNING = 'animatediff_lightning_4step_comfyui.safetensors'
const MOTION_V3 = 'v3_sd15_mm.ckpt'
const SD15 = 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors'
const WAN = 'wan2.2_ti2v_5B_fp16.safetensors'

function routeObjectInfo(opts: {
  checkpoints?: string[]
  unets?: string[]
  gguf?: string[]
  motion?: string[]
  adeInstalled?: boolean
}) {
  const { checkpoints = [], unets = [], gguf = [], motion = [], adeInstalled = true } = opts
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
    if (url.includes('ADE_LoadAnimateDiffModel')) {
      if (!adeInstalled) return { ok: false, status: 404, json: async () => ({}) }
      return okJson({ ADE_LoadAnimateDiffModel: { input: { required: { model_name: [motion] } } } })
    }
    return okJson({})
  })
}

beforeEach(() => {
  localFetch.mockReset()
})

describe('the Installed counter sees what the cards see', () => {
  it('THE FIX: a motion module under custom_nodes is in the video inventory', async () => {
    routeObjectInfo({ motion: [MOTION_LIGHTNING, MOTION_V3] })
    const names = (await getInstalledVideoModels()).map(m => m.name)
    expect(names).toContain(MOTION_LIGHTNING)
    expect(names).toContain(MOTION_V3)
  })

  it('the exact counter-check endstate: three Wan files plus two AnimateDiff bundles', async () => {
    // What the box actually had: the counter said 3 and both AnimateDiff cards
    // said Installed. The inventory now holds all of it.
    routeObjectInfo({
      checkpoints: [SD15],
      unets: ['wan2.1_t2v_1.3B_bf16.safetensors', WAN],
      gguf: ['wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf'],
      motion: [MOTION_LIGHTNING, MOTION_V3],
    })
    const names = (await getInstalledVideoModels()).map(m => m.name)
    expect(names).toContain(MOTION_LIGHTNING)
    expect(names).toContain(MOTION_V3)
    // and the three Wan files that were already counted
    expect(names).toContain('wan2.1_t2v_1.3B_bf16.safetensors')
    expect(names).toContain(WAN)
    expect(names).toContain('wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf')
    expect(new Set(names).size).toBe(names.length) // no double counting
  })

  it('SECOND FINDING: the SD1.5 half of a video bundle counts in the video lane too', async () => {
    routeObjectInfo({ checkpoints: [SD15], motion: [MOTION_LIGHTNING] })
    const video = (await getInstalledVideoModels()).map(m => m.name)
    expect(video).toContain(SD15)
    // and it stays an image checkpoint, because that is what it also is
    const image = (await getImageModels()).map(m => m.name)
    expect(image).toContain(SD15)
  })

  it('without a motion module an SD1.5 checkpoint does NOT inflate the video count', async () => {
    // No AnimateDiff pack, no AnimateDiff lane. selectStrategy uses the same
    // condition before it routes video onto the animatediff pipeline.
    routeObjectInfo({ checkpoints: [SD15], adeInstalled: false })
    const names = (await getInstalledVideoModels()).map(m => m.name)
    expect(names).toEqual([])
  })

  it('the Create picker reader is unchanged: no motion module as a main model', async () => {
    routeObjectInfo({ checkpoints: [SD15], motion: [MOTION_LIGHTNING, MOTION_V3] })
    const picker = (await getVideoModels()).map(m => m.name)
    expect(picker).not.toContain(MOTION_LIGHTNING)
    expect(picker).not.toContain(MOTION_V3)
    expect(picker).not.toContain(SD15)
  })

  it('a motion module is never offered in the image picker either', async () => {
    routeObjectInfo({ checkpoints: [MOTION_LIGHTNING], motion: [MOTION_LIGHTNING] })
    const image = (await getImageModels()).map(m => m.name)
    expect(image).not.toContain(MOTION_LIGHTNING)
    expect(classifyModel(MOTION_LIGHTNING)).toBe('animatediff')
    expect(isImageModelType('animatediff')).toBe(false)
  })

  it('degrades quietly when the AnimateDiff pack is not installed', async () => {
    routeObjectInfo({ unets: [WAN], adeInstalled: false })
    expect(await getAnimateDiffMotionModels()).toEqual([])
    const names = (await getInstalledVideoModels()).map(m => m.name)
    expect(names).toEqual([WAN])
  })
})

describe('the shared visibility reader covers the custom_nodes path', () => {
  it('readComfyModelNames lists a motion module', async () => {
    routeObjectInfo({ motion: [MOTION_V3] })
    expect(await readComfyModelNames()).toContain(MOTION_V3)
  })

  it('a finished AnimateDiff download is confirmed instead of accused', async () => {
    // Before the sixth loader, this file could never be confirmed: the install
    // click and the download poller spent their whole budget and then told the
    // user LU and ComfyUI use different model folders.
    routeObjectInfo({ motion: [MOTION_V3] })
    expect(await modelsNotVisibleInComfy([MOTION_V3])).toEqual([])
  })

  it('a motion module the engine does not list is still reported missing', async () => {
    routeObjectInfo({ motion: [] })
    expect(await modelsNotVisibleInComfy([MOTION_V3])).toEqual([MOTION_V3])
  })

  it('the AnimateDiff subfolder is judged, and both catalogue bundles use it', () => {
    expect(ENUM_SUBFOLDERS.has(ANIMATEDIFF_SUBFOLDER)).toBe(true)
    const animate = getVideoBundles().filter(b => b.workflow === 'animatediff')
    expect(animate.length).toBeGreaterThan(0)
    for (const b of animate) {
      const motionFile = b.files.find(f => f.filename === MOTION_LIGHTNING || f.filename === MOTION_V3)
      expect(motionFile, b.name).toBeTruthy()
      expect(motionFile!.subfolder, b.name).toBe(ANIMATEDIFF_SUBFOLDER)
    }
  })
})
