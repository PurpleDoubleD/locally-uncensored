/**
 * Round 3 of B1 / GH #113, from the counter-check on the real 2.6.7 Windows
 * build (2026-08-29).
 *
 * What the box did: opening the Models page logged
 *
 *   [useModels] ComfyUI video discovery failed
 *   TypeError: (intermediate value).map is not a function
 *
 * at warn level, so silently, and the whole video discovery died with it. The
 * Video tab had no number, Installed said 0 and the list said "No video models
 * installed", while three cards correctly said Installed because they read the
 * disk.
 *
 * The cause, read straight off that box's ComfyUI on 127.0.0.1:8188 (not
 * guessed): a dropdown comes back in two different shapes in ONE ComfyUI, and
 * the AnimateDiff node uses the newer one.
 *
 *   GET /object_info/CheckpointLoaderSimple
 *     "ckpt_name": [["Realistic_Vision_V6.0_NV_B1_fp16.safetensors", ...],
 *                   {"tooltip": "..."}]
 *
 *   GET /object_info/ADE_LoadAnimateDiffModel
 *     "model_name": ["COMBO", {"multiselect": false,
 *                              "options": ["animatediff_lightning_4step_comfyui.safetensors",
 *                                          "v3_sd15_mm.ckpt"]}]
 *
 * Round 2 added that sixth loader and mocked it in the LEGACY shape, which is
 * why its tests were green while the real box crashed. The bodies below are the
 * shapes the box actually returned.
 *
 * Run: npx vitest run src/api/__tests__/comfyui-combo-schema.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const localFetch = vi.fn()
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  isTauri: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

import { readComboOptions, nodeComboOptions } from '../comfyui-enum'
import {
  getAnimateDiffModels, getAnimateDiffMotionModels, getInstalledVideoModels,
  getVideoModels, getImageModels, getSamplers, buildAnimateDiffWorkflow,
} from '../comfyui'
import { readComfyModelNames } from '../discover'
import { detectAvailableModels } from '../comfyui-nodes'

const MOTION_LIGHTNING = 'animatediff_lightning_4step_comfyui.safetensors'
const MOTION_V3 = 'v3_sd15_mm.ckpt'
const SD15 = 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors'
const SVD = 'svd_xt_1_1.safetensors'
const WAN13 = 'wan2.1_t2v_1.3B_bf16.safetensors'
const WAN5B = 'wan2.2_ti2v_5B_fp16.safetensors'
const ZIMAGE = 'z_image_bf16.safetensors'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

/** Verbatim shape of the box answer for the AnimateDiff node, options included. */
const ADE_BODY_REAL = {
  ADE_LoadAnimateDiffModel: {
    input: {
      required: {
        model_name: ['COMBO', { multiselect: false, options: [MOTION_LIGHTNING, MOTION_V3] }],
      },
      optional: { ad_settings: ['AD_SETTINGS', {}] },
    },
    output: ['MOTION_MODEL_ADE'],
    name: 'ADE_LoadAnimateDiffModel',
    python_module: 'custom_nodes.ComfyUI-AnimateDiff-Evolved',
  },
}

/** Verbatim shape of the box answer for the two stock loaders, legacy schema. */
const CHECKPOINT_BODY_REAL = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [[SD15, 'sd_turbo.safetensors', SVD], { tooltip: 'The name of the checkpoint (model) to load.' }] } },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
}
const UNET_BODY_REAL = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [[WAN13, WAN5B, ZIMAGE]],
        weight_dtype: [['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2'], { advanced: true }],
      },
    },
    output: ['MODEL'],
  },
}

/** The box, exactly as it answered on 2026-08-29. `ade` swaps in a broken
 *  answer for the one node, to prove the other lanes survive it. */
function routeRealBox(ade: unknown = ADE_BODY_REAL) {
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('CheckpointLoaderSimple')) return okJson(CHECKPOINT_BODY_REAL)
    if (url.includes('UnetLoaderGGUF')) return okJson({}) // pack not installed: ComfyUI answers {} with HTTP 200
    if (url.includes('UNETLoader')) return okJson(UNET_BODY_REAL)
    if (url.includes('ADE_LoadAnimateDiffModel')) {
      if (typeof ade === 'function') return (ade as () => unknown)()
      return okJson(ade)
    }
    return okJson({})
  })
}

beforeEach(() => {
  localFetch.mockReset()
})

describe('one ComfyUI, two dropdown schemas', () => {
  it('reads the legacy shape (options in slot 0)', () => {
    expect(readComboOptions([[SD15, SVD], { tooltip: 'x' }])).toEqual([SD15, SVD])
  })

  it('THE FIX: reads the newer COMBO shape the AnimateDiff node uses', () => {
    expect(readComboOptions(['COMBO', { multiselect: false, options: [MOTION_LIGHTNING, MOTION_V3] }]))
      .toEqual([MOTION_LIGHTNING, MOTION_V3])
  })

  it('an empty dropdown is an empty list in both shapes, not a failure', () => {
    expect(readComboOptions([[]])).toEqual([])
    expect(readComboOptions(['COMBO', { options: [] }])).toEqual([])
    expect(readComboOptions(['COMBO', {}])).toEqual([])
  })

  it('a spec that is not a dropdown at all answers null, so the caller can log it', () => {
    expect(readComboOptions(['INT', { min: 1, max: 100 }])).toBeNull()
    expect(readComboOptions('<html>404</html>')).toBeNull()
    expect(readComboOptions(undefined)).toBeNull()
    expect(readComboOptions(42)).toBeNull()
  })

  it('a missing node in an /object_info answer is an empty list, never a throw', () => {
    // ComfyUI answers {} with HTTP 200 for a class it does not know.
    expect(nodeComboOptions({}, 'ADE_LoadAnimateDiffModel', 'model_name')).toEqual([])
    expect(nodeComboOptions(null, 'ADE_LoadAnimateDiffModel', 'model_name')).toEqual([])
    expect(nodeComboOptions('<html>Not Found</html>', 'UNETLoader', 'unet_name')).toEqual([])
  })

  it('an unreadable spec yields an empty list, never the type name as a filename', () => {
    const out = nodeComboOptions(
      { UNETLoader: { input: { required: { unet_name: ['COMBO'] } } } },
      'UNETLoader', 'unet_name',
    )
    expect(out).toEqual([])
    expect(out).not.toContain('COMBO')
  })
})

describe('the box answer that killed the video discovery', () => {
  it('THE CRASH: the AnimateDiff loader returns the two files, not the word COMBO', async () => {
    routeRealBox()
    const names = await getAnimateDiffModels()
    expect(Array.isArray(names)).toBe(true)
    expect(names).toEqual([MOTION_LIGHTNING, MOTION_V3])
    expect(names).not.toContain('COMBO')
  })

  it('THE CRASH: getAnimateDiffMotionModels no longer throws on the real answer', async () => {
    routeRealBox()
    const models = await getAnimateDiffMotionModels()
    expect(models.map((m) => m.name)).toEqual([MOTION_LIGHTNING, MOTION_V3])
  })

  it('THE CRASH: the inventory survives and lists what the cards list', async () => {
    routeRealBox()
    const names = (await getInstalledVideoModels()).map((m) => m.name)
    // the two motion modules whose cards said Installed
    expect(names).toContain(MOTION_LIGHTNING)
    expect(names).toContain(MOTION_V3)
    // the freshly installed SVD-XT that appeared in no list on the box
    expect(names).toContain(SVD)
    // the Wan files ComfyUI already knew
    expect(names).toContain(WAN13)
    expect(names).toContain(WAN5B)
    // the SD1.5 half of both AnimateDiff bundles, in the video lane too
    expect(names).toContain(SD15)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBeGreaterThan(0) // the box showed 0
  })

  it('card, counter and list speak from the same inventory', async () => {
    routeRealBox()
    const inventory = await getInstalledVideoModels()
    // The counter is the length of the list, so pinning both against the same
    // read is what "the tab number and the list agree" means in code.
    expect(inventory.length).toBe(new Set(inventory.map((m) => m.name)).size)
    for (const installed of [MOTION_LIGHTNING, MOTION_V3, SVD]) {
      expect(inventory.some((m) => m.name === installed)).toBe(true)
    }
  })

  it('the Create picker still refuses a motion module as a main model', async () => {
    routeRealBox()
    const picker = (await getVideoModels()).map((m) => m.name)
    expect(picker).toContain(SVD)
    expect(picker).not.toContain(MOTION_LIGHTNING)
    expect(picker).not.toContain(MOTION_V3)
  })

  it('the image lane is unaffected by the newer schema next door', async () => {
    routeRealBox()
    const image = (await getImageModels()).map((m) => m.name)
    expect(image).toContain(SD15)
    expect(image).toContain(ZIMAGE)
    expect(image).not.toContain('COMBO')
  })

  it('the shared visibility reader never carries the word COMBO as a filename', async () => {
    routeRealBox()
    const visible = await readComfyModelNames()
    expect(visible).toContain(MOTION_V3)
    expect(visible).not.toContain('COMBO')
  })

  it('THE GENERATION: the AnimateDiff graph carries the file, not one letter of the word COMBO', async () => {
    // findAnimateDiffModel took models[0] of what the loader returned. On the
    // bare string "COMBO" that is the character "C", and length 5 sailed past
    // the "nothing installed" guard, so a video run would have asked ComfyUI
    // to load a motion model called C.
    routeRealBox()
    const workflow = await buildAnimateDiffWorkflow({
      prompt: 'a cat', negativePrompt: '', model: SD15,
      sampler: 'euler', scheduler: 'normal', steps: 20, cfgScale: 8,
      width: 512, height: 512, seed: 1, frames: 16, fps: 8,
    } as Parameters<typeof buildAnimateDiffWorkflow>[0])
    const loader = Object.values(workflow).find(
      (n) => (n as { class_type?: string }).class_type === 'ADE_LoadAnimateDiffModel',
    ) as { inputs: { model_name: string } }
    expect(loader.inputs.model_name).toBe(MOTION_LIGHTNING)
    expect(loader.inputs.model_name).not.toBe('C')
  })

  it('the AnimateDiff models reach the workflow builder from the newer schema', async () => {
    const allNodes = { ...ADE_BODY_REAL, ...CHECKPOINT_BODY_REAL } as unknown as Parameters<typeof detectAvailableModels>[0]
    const available = detectAvailableModels(allNodes)
    expect(available.motionModels).toEqual([MOTION_LIGHTNING, MOTION_V3])
    expect(available.checkpoints).toContain(SD15)
  })
})

describe('one broken loader never empties the page again', () => {
  const brokenAnswers: Array<[string, unknown]> = [
    ['a shape nobody has seen', { ADE_LoadAnimateDiffModel: { input: { required: { model_name: { weird: true } } } } }],
    ['an error page instead of JSON', () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token < in JSON') } })],
    ['HTTP 500 from the node', () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['a hard network failure', () => { throw new Error('fetch failed') }],
    ['the node missing entirely', {}],
  ]

  for (const [label, answer] of brokenAnswers) {
    it(`keeps the video inventory when the AnimateDiff loader gives ${label}`, async () => {
      routeRealBox(answer)
      const names = (await getInstalledVideoModels()).map((m) => m.name)
      expect(names).toContain(SVD)
      expect(names).toContain(WAN13)
      expect(names).toContain(WAN5B)
      expect(names).not.toContain(MOTION_LIGHTNING) // that one lane, and only it, is empty
    })
  }

  it('THE ISOLATION: a dead checkpoint loader no longer empties the whole tab', async () => {
    // The main-model lane throws (ComfyUI answering 500 for its own loader is
    // the "no engine" case, and getVideoModels still says so). The inventory
    // must degrade to the lane it CAN read instead of rejecting, because a
    // rejection here is exactly what left the page at "No video models
    // installed" on the box.
    localFetch.mockImplementation(async (url: string) => {
      if (url.includes('CheckpointLoaderSimple')) return { ok: false, status: 500, json: async () => ({}) }
      if (url.includes('ADE_LoadAnimateDiffModel')) return okJson(ADE_BODY_REAL)
      return okJson({})
    })
    await expect(getVideoModels()).rejects.toThrow()
    const names = (await getInstalledVideoModels()).map((m) => m.name)
    expect(names).toContain(MOTION_LIGHTNING)
    expect(names).toContain(MOTION_V3)
  })

  it('a broken KSampler answer still yields usable samplers', async () => {
    localFetch.mockImplementation(async () =>
      okJson({ KSampler: { input: { required: { sampler_name: ['COMBO'] } } } }))
    expect(await getSamplers()).toContain('euler')
  })
})
