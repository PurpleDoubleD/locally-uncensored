/**
 * Round 3 of B1 / GH #113: card, counter and Installed list, driven by ONE set
 * of answers, and those answers are the ones the real Windows box gave on
 * 2026-08-29 (read straight off its ComfyUI on 127.0.0.1:8188).
 *
 * The point of this file is the chain, not one function. On the box the card
 * said Installed while the counter had no number and the list said "No video
 * models installed", and the reason was a single loader answering in the newer
 * COMBO schema:
 *
 *   "model_name": ["COMBO", {"multiselect": false, "options": [...]}]
 *
 * That answer cost BOTH ends. The inventory threw ("(intermediate value).map is
 * not a function") and left the page empty. And the card lost its ComfyUI
 * visibility gate without a word: checkBundlesInstalled hands each loader's
 * answer to filterPartialFiles, a bare "COMBO" string has no .filter, the throw
 * landed in the catch that means "ComfyUI not reachable", and the gate that
 * round 1 built to stop a card trusting the disk alone was simply skipped.
 *
 * Run: npx vitest run src/api/__tests__/gh113-card-counter-list-chain.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ModelBundle } from '../discover'

const localFetch = vi.fn()
const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()

vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  isTauri: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

const { getInstalledVideoModels } = await import('../comfyui')
const { checkBundlesInstalled, ANIMATEDIFF_SUBFOLDER } = await import('../discover')

const MOTION_LIGHTNING = 'animatediff_lightning_4step_comfyui.safetensors'
const MOTION_V3 = 'v3_sd15_mm.ckpt'
const SD15 = 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors'

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

/** The AnimateDiff v3 bundle as the catalogue ships it: motion module under
 *  custom_nodes, SD1.5 checkpoint under checkpoints. */
const ANIMATEDIFF_V3 = {
  name: 'AnimateDiff v3',
  description: '', tags: [], totalSizeGB: 3.6, vramRequired: '8 GB',
  files: [
    { name: '', description: '', pulls: '', tags: [], updated: '', filename: MOTION_V3, subfolder: ANIMATEDIFF_SUBFOLDER, sizeGB: 1.6 },
    { name: '', description: '', pulls: '', tags: [], updated: '', filename: SD15, subfolder: 'checkpoints', sizeGB: 2.0 },
  ],
} as unknown as ModelBundle

/** Every file of every bundle is on disk at full size, which is what the box
 *  had: 866,8 MB + 1595,7 MB + 2033,8 MB, all complete. */
function diskIsFull() {
  backendCall.mockImplementation(async (cmd, args) => {
    if (cmd !== 'check_model_sizes') return undefined
    const files = (args as { files: Array<{ filename: string }> }).files
    return files.map((f) => ({ filename: f.filename, exists: true, actualBytes: 1, complete: true }))
  })
}

/** ComfyUI, answering exactly as the box did: stock loaders legacy, the
 *  AnimateDiff node in the newer COMBO schema. `motion` is what that node
 *  lists. */
function routeComfy(motion: string[]) {
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('CheckpointLoaderSimple')) {
      return okJson({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[SD15], { tooltip: 'x' }] } } } })
    }
    if (url.includes('UnetLoaderGGUF')) return okJson({})
    if (url.includes('UNETLoader')) return okJson({ UNETLoader: { input: { required: { unet_name: [[]] } } } })
    if (url.includes('ADE_LoadAnimateDiffModel')) {
      return okJson({
        ADE_LoadAnimateDiffModel: {
          input: { required: { model_name: ['COMBO', { multiselect: false, options: motion }] } },
        },
      })
    }
    return okJson({})
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localFetch.mockReset()
  diskIsFull()
})

describe('card, counter and Installed list read the same shelf', () => {
  it('THE CHAIN: a bundle whose card says Installed is in the inventory', async () => {
    routeComfy([MOTION_LIGHTNING, MOTION_V3])
    const cards = await checkBundlesInstalled([ANIMATEDIFF_V3])
    expect(cards['AnimateDiff v3']).toBe(true)

    const inventory = (await getInstalledVideoModels()).map((m) => m.name)
    for (const file of [MOTION_V3, SD15]) {
      expect(inventory, `card says Installed, inventory must hold ${file}`).toContain(file)
    }
    // The counter is the size of that same list, so a card reading Installed
    // can no longer stand over a tab with no number.
    expect(inventory.length).toBeGreaterThan(0)
  })

  it('THE SILENT GATE: a motion module ComfyUI cannot see stops the card again', async () => {
    // Same full disk, but the running ComfyUI lists no motion module (second
    // install, moved folder, pack not loaded). Round 1 built this gate; the
    // COMBO answer disabled it by throwing into the "ComfyUI unreachable"
    // catch, so the card trusted the disk alone.
    routeComfy([])
    const cards = await checkBundlesInstalled([ANIMATEDIFF_V3])
    expect(cards['AnimateDiff v3']).toBe(false)

    const inventory = (await getInstalledVideoModels()).map((m) => m.name)
    expect(inventory).not.toContain(MOTION_V3)
  })

  it('the gate and the inventory agree file by file', async () => {
    // Only the lightning module is visible, so the v3 bundle is not installed
    // and its file is not in the inventory, while the visible one is.
    routeComfy([MOTION_LIGHTNING])
    const cards = await checkBundlesInstalled([ANIMATEDIFF_V3])
    const inventory = (await getInstalledVideoModels()).map((m) => m.name)
    expect(cards['AnimateDiff v3']).toBe(false)
    expect(inventory).toContain(MOTION_LIGHTNING)
    expect(inventory).not.toContain(MOTION_V3)
  })
})
