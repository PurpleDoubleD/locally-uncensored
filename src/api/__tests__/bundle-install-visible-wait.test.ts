/**
 * C8, the third path: the install click.
 *
 * Create waits for ComfyUI's directory scan (2.6.5) and the Model Manager's
 * download poller waits too (2.6.6). installBundleComplete did not. It asked
 * ComfyUI once, cached the answer, and judged every file that check_model_sizes
 * reported as complete on disk from that single lookup. In the C8 window, the
 * seconds after a big download lands while ComfyUI is still scanning, the
 * answer for a file that is perfectly fine is "not listed", and the video
 * bundles share files, so starting an overlapping bundle right after one
 * finished produced a red row claiming LU and ComfyUI use different model
 * folders. They do not. The scan was simply still running.
 *
 * The budget inside the click is deliberately short, three rounds against the
 * other two paths' twenty, because it runs inside a click and an old file
 * answers on the first lookup with no waiting at all.
 *
 * D2, 2.6.7: those three rounds are a fast path, not the verdict. 05ee25ff
 * justified them with "the download poller keeps watching the same file with
 * the full budget", which is not true for a file the install SKIPPED because it
 * was already on disk: no transfer is started, so nothing ever reaches the
 * poller. Anything the click cannot confirm now goes to a background
 * confirmation on the full budget, and the click meanwhile announces the one
 * thing that is certain, that the file is on disk.
 *
 * Run: npx vitest run src/api/__tests__/bundle-install-visible-wait.test.ts
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { ModelBundle } from '../discover'

const backendCall = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>()
const getCheckpoints = vi.fn<() => Promise<string[]>>(async () => [])
const getGgufUnetModels = vi.fn<() => Promise<string[]>>(async () => [])
const refreshComfyModels = vi.fn<(maxAttempts?: number) => Promise<boolean>>(async () => true)

vi.mock('../backend', () => ({
  backendCall: (...a: unknown[]) => backendCall(...(a as [string, unknown])),
  fetchExternal: vi.fn(),
}))

vi.mock('../comfyui', () => ({
  getCheckpoints: () => getCheckpoints(),
  getDiffusionModels: async () => [],
  getVAEModels: async () => [],
  getCLIPModels: async () => [],
  getGgufUnetModels: () => getGgufUnetModels(),
  // Sixth loader (2026-08-29): the AnimateDiff pack lists its motion modules
  // itself. No motion module in these fixtures, so it answers empty.
  getAnimateDiffModels: async () => [],
  // Seventh loader (2026-08-29, abnahme counter-check): LoraLoader enumerates
  // the loras folder, so a LoRA is judged like every other file now.
  getLoraModels: async () => [],
  filterPartialFiles: async (names: string[]) => new Set(names),
  refreshComfyModels: (...a: unknown[]) => refreshComfyModels(...(a as [number])),
}))

// The real loop, on a short clock. Sleeping the production 1.5 seconds is the
// one thing here a test has no reason to reproduce; the attempt budget is the
// shipped code.
vi.mock('../../lib/bundle-install', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/bundle-install')>()
  return {
    ...real,
    waitForModelsVisible: (opts: Parameters<typeof real.waitForModelsVisible>[0]) =>
      real.waitForModelsVisible({ ...opts, delayMs: 1 }),
  }
})

let installBundleComplete: typeof import('../discover').installBundleComplete
let whenVisibilityConfirmed: typeof import('../discover').whenVisibilityConfirmed
let win: EventTarget

beforeAll(async () => {
  // vitest runs this suite in the node environment and the install dispatches
  // its verdicts on window.
  win = new EventTarget()
  ;(globalThis as unknown as { window: EventTarget }).window = win
  ;({ installBundleComplete, whenVisibilityConfirmed } = await import('../discover'))
})

const VIDEO = 'wan2.2_s2v_14B_fp8.safetensors'
const VAE = 'wan_2.1_vae.safetensors'
const GGUF = 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf'

function bundleOf(files: Array<{ filename: string; subfolder: string }>): ModelBundle {
  return {
    name: 'Extend Video',
    description: '',
    tags: [],
    totalSizeGB: 12,
    vramRequired: '12 GB',
    files: files.map((f) => ({
      name: '', description: '', pulls: '', tags: [], updated: '',
      downloadUrl: `https://example.test/${f.filename}`,
      filename: f.filename,
      subfolder: f.subfolder,
      sizeGB: 6,
    })),
  } as unknown as ModelBundle
}

/** Every verdict the install announced about a file already on disk. */
function recordVerdicts() {
  const seen: Array<{ type: string; filename?: string }> = []
  const push = (e: Event) =>
    seen.push({ type: e.type, filename: (e as CustomEvent<{ filename?: string }>).detail?.filename })
  win.addEventListener('comfyui-download-exists', push)
  win.addEventListener('comfyui-model-invisible', push)
  return {
    seen,
    stop: () => {
      win.removeEventListener('comfyui-download-exists', push)
      win.removeEventListener('comfyui-model-invisible', push)
    },
  }
}

/** Resolves with the filename the next event of this type carries. The long
 *  visibility confirmation runs past the install click on purpose, so a test
 *  about its verdict has to wait for it instead of for the click. */
function nextEvent(type: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const once = (e: Event) => {
      win.removeEventListener(type, once)
      resolve((e as CustomEvent<{ filename?: string }>).detail?.filename)
    }
    win.addEventListener(type, once)
  })
}

/** ComfyUI lists nothing on the first read and everything from the second on,
 *  which is what the tail of its directory scan looks like from outside. */
function scanFinishesAfterOneRound(...names: string[]) {
  let reads = 0
  getCheckpoints.mockImplementation(async () => (++reads > 1 ? names : []))
}

describe('a file complete on disk waits out the ComfyUI scan before it is called invisible', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    refreshComfyModels.mockResolvedValue(true)
    // The disk check says every file of the bundle is there at full size.
    backendCall.mockImplementation(async (cmd, args) => {
      if (cmd !== 'check_model_sizes') return undefined
      const files = (args as { files: Array<{ filename: string }> }).files
      return files.map((f) => ({ filename: f.filename, exists: true, complete: true }))
    })
  })

  // The long confirmation outlives the click on purpose. Draining it here keeps
  // one test's engine chatter out of the next test's call counts.
  afterEach(async () => {
    await whenVisibilityConfirmed()
  })

  it('a file the engine already lists is skipped without any waiting', async () => {
    getCheckpoints.mockResolvedValue([VIDEO])
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: VIDEO }])
    // One lookup, no rescan round. This is the common case and it must stay free.
    expect(getCheckpoints).toHaveBeenCalledTimes(1)
    expect(refreshComfyModels.mock.calls.filter((c) => c[0] === 1)).toHaveLength(0)
  })

  it('a scan that finishes a moment later is not a folder mismatch', async () => {
    scanFinishesAfterOneRound(VIDEO)
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: VIDEO }])
    // The initial lookup plus the one rescan round it took.
    expect(getCheckpoints).toHaveBeenCalledTimes(2)
  })

  it('NEGATIVE CONTROL: the single lookup the old path made answers "not listed"', async () => {
    // The exact moment the old code decided: ComfyUI's scan has not reached the
    // file yet, so the one and only lookup says it is invisible. A path that
    // stops there dispatches comfyui-model-invisible, which downloadStore turns
    // into a red "LU and ComfyUI are using different model folders" row for a
    // file that is on disk, intact, and about to be listed. Without the wait
    // this test goes red on the last expect.
    const answers: string[][] = []
    getCheckpoints.mockImplementation(async () => {
      const list = answers.length === 0 ? [] : [VIDEO]
      answers.push(list)
      return list
    })
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(answers[0]).toEqual([])
    expect(answers[answers.length - 1]).toEqual([VIDEO])
    expect(rec.seen.map((v) => v.type)).not.toContain('comfyui-model-invisible')
  })

  it('a file the engine never lists still reports the folder mismatch, after the FULL budget', async () => {
    // D2, changed on 2.6.7. The click no longer passes its own verdict. 4.5s is
    // the patience of a click, not the length of a ComfyUI directory scan, and
    // the justification for it ("the download poller keeps watching with the
    // full budget afterwards") is not true for a file the install SKIPPED: no
    // transfer is started, so the Rust progress map never gains an entry,
    // downloadStore.refresh never sees a completion, and announceUntilVisible
    // is never called. The video bundles share exactly those already-present
    // files, so that is the common case, not the rare one.
    //
    // The click therefore announces the one thing that is certain, that the
    // file is on disk, and the accusation only follows if the full budget runs
    // out with the engine still silent.
    getCheckpoints.mockResolvedValue([])
    const rec = recordVerdicts()
    const accused = nextEvent('comfyui-model-invisible')

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))

    // Nothing but "it is on disk" while the click is still running.
    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: VIDEO }])
    // Three rescan rounds is all the click itself spends. refreshComfyModels(1)
    // is the click's single attempt rescan; the long confirmation calls it with
    // no argument, so the two are told apart by the argument.
    expect(refreshComfyModels.mock.calls.filter((c) => c[0] === 1)).toHaveLength(3)

    expect(await accused).toBe(VIDEO)
    rec.stop()
    expect(rec.seen.map((v) => v.type)).toContain('comfyui-model-invisible')
    // The long confirmation ran on top of the click's four lookups, which is
    // the point: the file got the same budget the other two paths give it.
    expect(getCheckpoints.mock.calls.length).toBeGreaterThan(4)
  })

  it('a scan that finishes after the click keeps the card honest without an accusation', async () => {
    // D2's payoff. The click's three rounds run out, then the scan finishes.
    // Nobody is accused of anything, and every round of the confirmation
    // re-announces the arrival, which is what makes the Model Manager run its
    // installed check again instead of leaving the model out of the list until
    // the user reloads by hand.
    let reads = 0
    getCheckpoints.mockImplementation(async () => (++reads > 6 ? [VIDEO] : []))
    const rec = recordVerdicts()
    const announced: Array<string | undefined> = []
    const onAnnounce = (e: Event) =>
      announced.push((e as CustomEvent<{ filename?: string }>).detail?.filename)
    win.addEventListener('comfyui-model-downloaded', onAnnounce)

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    await whenVisibilityConfirmed()
    rec.stop()
    win.removeEventListener('comfyui-model-downloaded', onAnnounce)

    expect(rec.seen.map((v) => v.type)).not.toContain('comfyui-model-invisible')
    expect(announced).toContain(VIDEO)
  })

  it('a GGUF quant the ComfyUI-GGUF loader lists is visible to the install click too', async () => {
    // B1. UNETLoader enumerates only .safetensors and .sft, so a .gguf never
    // shows up in getDiffusionModels. checkBundlesInstalled was taught the GGUF
    // loader in 2.6.6 and modelsNotVisibleInComfy was born with it; the install
    // click kept asking four loaders. Both Unfiltered video bundles are GGUF,
    // which is the title of GH #113, so on that path a model ComfyUI serves
    // perfectly came back "not listed" and the user was told LU and ComfyUI use
    // different model folders. Without the fifth list this test goes red: the
    // click finds nothing, spends its rounds, and starts an accusation.
    getCheckpoints.mockResolvedValue([])
    getGgufUnetModels.mockResolvedValue([GGUF])
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: GGUF, subfolder: 'diffusion_models' }]))
    await whenVisibilityConfirmed()
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: GGUF }])
    // Answered on the very first lookup, no rescan round at all.
    expect(refreshComfyModels.mock.calls.filter((c) => c[0] === 1)).toHaveLength(0)
  })

  it('the rescan carries the next file of the same bundle, no second wait', async () => {
    // Video bundles share files. Once one wait has seen the scan finish, every
    // later file is judged against that refreshed list instead of starting its
    // own wait.
    scanFinishesAfterOneRound(VIDEO, VAE)
    const rec = recordVerdicts()

    await installBundleComplete(
      bundleOf([
        { filename: VIDEO, subfolder: 'diffusion_models' },
        { filename: VAE, subfolder: 'vae' },
      ]),
    )
    rec.stop()

    expect(rec.seen).toEqual([
      { type: 'comfyui-download-exists', filename: VIDEO },
      { type: 'comfyui-download-exists', filename: VAE },
    ])
    expect(getCheckpoints).toHaveBeenCalledTimes(2)
  })

  it('a subfolder ComfyUI never enumerates is not judged at all', async () => {
    // Upscale models do not appear in these lists, so waiting on one would be
    // certain failure on a click. (loras left this group on 2026-08-29: the
    // LoRA folder IS enumerated, by LoraLoader, and the abnahme counter-check
    // showed what not asking it costs.)
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: '4x-UltraSharp.pth', subfolder: 'upscale_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: '4x-UltraSharp.pth' }])
    expect(getCheckpoints).not.toHaveBeenCalled()
  })

  it('a LoRA IS judged now, so a finished LoRA download gets the same wait as any other file', async () => {
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: 'mychar.safetensors', subfolder: 'loras' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: 'mychar.safetensors' }])
    expect(getCheckpoints).toHaveBeenCalled()
  })

  it('an engine that cannot be reached is not a verdict, and costs no budget', async () => {
    getCheckpoints.mockRejectedValue(new Error('ECONNREFUSED'))
    const rec = recordVerdicts()

    await installBundleComplete(bundleOf([{ filename: VIDEO, subfolder: 'diffusion_models' }]))
    rec.stop()

    expect(rec.seen).toEqual([{ type: 'comfyui-download-exists', filename: VIDEO }])
    expect(getCheckpoints).toHaveBeenCalledTimes(1)
    expect(refreshComfyModels.mock.calls.filter((c) => c[0] === 1)).toHaveLength(0)
  })
})
