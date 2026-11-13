/**
 * Discord help-chat 2026-09-02 (Windows 11 25H2, RTX 5060, LU
 * 2.6.7, ComfyUI backend): FramePack F1 and Wan 2.1 install through our own Get
 * button and never appear in the picker. Moving the files into a different
 * ComfyUI folder by hand fixed it.
 *
 * Two questions, and this file answers the second one. Where a file is WRITTEN
 * is settled in Rust, where the download now asks the running ComfyUI for its
 * own model folders instead of guessing (src-tauri/src/commands/comfy_folders.rs
 * and `models_dir_in` in download.rs). What is left over here is the other side
 * of the same coin: every folder the Get button writes into has to be a folder
 * the app reads back, or a download lands somewhere nothing looks even when the
 * tree is right.
 *
 * The catalog's write folders and the app's read folders were two hand-written
 * lists in two files, and they had drifted by two entries:
 *
 *   clip_vision     FramePack F1's 900 MB SigCLIP encoder
 *   audio_encoders  the Wav2Vec2 encoder both Talking Character bundles need
 *
 * Both are written by our own Get button, and neither was read by anything, so
 * a file in either could never be confirmed after its download.
 *
 * The tree below is a real one in a temp dir, filled with exactly the files the
 * Get button writes, and the ComfyUI in front of it enumerates that tree the
 * way the real one does: `supported_pt_extensions` for the stock loaders, the
 * GGUF pack's own loader for `.gguf`, and `diffusion_models` covering both
 * `models\unet` and `models\diffusion_models`.
 *
 * Run: npx vitest run src/api/__tests__/get-target-is-a-folder-we-read.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, statSync, openSync, closeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const localFetch = vi.fn()
const backendCall = vi.fn()
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  localFetch: (...a: unknown[]) => localFetch(...a),
  backendCall: (...a: unknown[]) => backendCall(...a),
  isTauri: () => false,
  isMacOS: () => false,
  comfyuiUrl: (path: string) => `http://127.0.0.1:8188${path}`,
}))

import {
  COMFY_MODEL_FOLDERS, getVideoModels, getImageModels, getAudioModels,
  getLipsyncModels, getMotionModels, getUpscaleModels, getDiffusionModels, type ClassifiedModel,
} from '../comfyui'
import { getThreeDBundles } from '../model-bundles'
import {
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles,
  modelsNotVisibleInComfy, type ModelBundle, type DiscoverModel,
} from '../discover'

/** ComfyUI's `supported_pt_extensions` (folder_paths.py). No `.gguf`, which is
 *  the whole reason the GGUF pack registers a loader of its own. */
const PT = new Set(['.ckpt', '.pt', '.pt2', '.bin', '.pth', '.safetensors', '.pkl', '.sft'])
const extOf = (n: string) => n.slice(n.lastIndexOf('.')).toLowerCase()

/** ComfyUI's folder keys and the directories each one scans, as `folder_paths`
 *  has them. `diffusion_models` really does cover both, which is why a file in
 *  either is offered by UNETLoader. */
const SCANS: Record<string, string[]> = {
  checkpoints: ['models/checkpoints'],
  diffusion_models: ['models/unet', 'models/diffusion_models'],
  vae: ['models/vae'],
  text_encoders: ['models/text_encoders', 'models/clip'],
  clip_vision: ['models/clip_vision'],
  audio_encoders: ['models/audio_encoders'],
  loras: ['models/loras'],
  controlnet: ['models/controlnet'],
  upscale_models: ['models/upscale_models'],
  latent_upscale_models: ['models/latent_upscale_models'],
  style_models: ['models/style_models'],
  // Local 3D (3.1.0): BiRefNet, read by LoadBackgroundRemovalModel.
  background_removal: ['models/background_removal'],
}

function filesIn(root: string, rel: string): string[] {
  try {
    return readdirSync(join(root, rel)).filter((f) => statSync(join(root, rel, f)).isFile())
  } catch { return [] }
}

const listFor = (root: string, key: string, gguf: boolean) =>
  (SCANS[key] ?? []).flatMap((d) => filesIn(root, d))
    .filter((f) => (gguf ? extOf(f) === '.gguf' : PT.has(extOf(f))))

/**
 * The tree used to be built with ftruncateSync to the real catalog size, up
 * to 27 GB per bundle, on the theory that a sparse file costs no bytes. That
 * is only true on APFS and ext4. On NTFS ftruncate allocates for real, and a
 * single run on the Windows test box wrote 100.8 GB and filled the disk.
 *
 * Every file the Get button "writes" here is now a handful of real bytes,
 * on every filesystem. The completeness math in `serve()` below still sees
 * the real catalog size, but reads it from `declaredBytes` instead of from
 * statSync, so the proof that a 27 GB bundle reads back as complete survives
 * without ever asking the disk for 27 GB.
 */
const declaredBytes = new Map<string, number>()
const createdRoots = new Set<string>()

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const notFound = { ok: false, status: 404, json: async () => ({}) }
const combo = (node: string, field: string, list: string[]) =>
  okJson({ [node]: { input: { required: { [field]: [list] } } } })

/** A ComfyUI serving the tree under `root`. */
function serve(root: string) {
  localFetch.mockImplementation(async (url: string) => {
    if (url.includes('CheckpointLoaderSimple')) return combo('CheckpointLoaderSimple', 'ckpt_name', listFor(root, 'checkpoints', false))
    if (url.includes('UnetLoaderGGUF')) return combo('UnetLoaderGGUF', 'unet_name', listFor(root, 'diffusion_models', true))
    if (url.includes('UNETLoader')) return combo('UNETLoader', 'unet_name', listFor(root, 'diffusion_models', false))
    if (url.includes('VAELoader')) return combo('VAELoader', 'vae_name', listFor(root, 'vae', false))
    if (url.includes('CLIPVisionLoader')) return combo('CLIPVisionLoader', 'clip_name', listFor(root, 'clip_vision', false))
    if (url.includes('CLIPLoader')) return combo('CLIPLoader', 'clip_name', listFor(root, 'text_encoders', false))
    if (url.includes('AudioEncoderLoader')) return combo('AudioEncoderLoader', 'audio_encoder_name', listFor(root, 'audio_encoders', false))
    if (url.includes('LoraLoader')) return combo('LoraLoader', 'lora_name', listFor(root, 'loras', false))
    if (url.includes('ControlNetLoader')) return combo('ControlNetLoader', 'control_net_name', listFor(root, 'controlnet', false))
    if (url.includes('LatentUpscaleModelLoader')) return combo('LatentUpscaleModelLoader', 'model_name', listFor(root, 'latent_upscale_models', false))
    if (url.includes('UpscaleModelLoader')) return combo('UpscaleModelLoader', 'model_name', listFor(root, 'upscale_models', false))
    if (url.includes('StyleModelLoader')) return combo('StyleModelLoader', 'style_model_name', listFor(root, 'style_models', false))
    if (url.includes('LoadBackgroundRemovalModel')) return combo('LoadBackgroundRemovalModel', 'bg_removal_name', listFor(root, 'background_removal', false))
    if (url.includes('ADE_LoadAnimateDiffModel')) {
      return combo('ADE_LoadAnimateDiffModel', 'model_name', filesIn(root, 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models'))
    }
    return notFound
  })
  // The disk probe answers about the same tree, so nothing is hidden as a
  // partial download: every planted file has its announced size.
  backendCall.mockImplementation(async (
    _cmd: string,
    args: { files?: Array<{ subfolder: string; filename: string; expectedBytes: number }> },
  ) => (args?.files ?? []).map((f) => {
    const p = join(root, f.subfolder.startsWith('custom_nodes') ? '' : 'models', f.subfolder, f.filename)
    try {
      statSync(p) // throws if the file was never planted
      const bytes = declaredBytes.get(p) ?? 0
      return { filename: f.filename, exists: true, actualBytes: bytes, complete: bytes >= f.expectedBytes * 0.5 }
    } catch {
      return { filename: f.filename, exists: false, actualBytes: 0, complete: false }
    }
  }))
}

/**
 * Exactly what the Get button writes: same folder, same name. The size is
 * real for the completeness math (see `declaredBytes` above) but the file on
 * disk stays empty, so the tree costs no real bytes on any filesystem.
 */
function runTheGet(files: DiscoverModel[]): string {
  const root = mkdtempSync(join(tmpdir(), 'lu-comfy-tree-'))
  createdRoots.add(root)
  for (const f of files) {
    if (!f.filename || !f.subfolder) continue
    const rel = f.subfolder.startsWith('custom_nodes') ? f.subfolder : join('models', f.subfolder)
    const p = join(root, rel, f.filename)
    mkdirSync(dirname(p), { recursive: true })
    closeSync(openSync(p, 'w'))
    declaredBytes.set(p, Math.round((f.sizeGB ?? 0.001) * 1_073_741_824))
  }
  return root
}

/** Real bytes on disk under `root`, the number the guard test below checks. */
function realBytesUnder(root: string): number {
  let total = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name)
    if (entry.isDirectory()) total += realBytesUnder(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

/** The file that makes a bundle what it is: the one that generates. */
const MAIN_FOLDERS = new Set(['diffusion_models', 'checkpoints', 'unet'])
const mainFiles = (b: ModelBundle) => b.files.filter((f) => MAIN_FOLDERS.has(f.subfolder ?? ''))

const LANES: Array<{ lane: string; bundles: () => ModelBundle[]; picker: () => Promise<ClassifiedModel[]> }> = [
  { lane: 'image', bundles: getImageBundles, picker: getImageModels },
  { lane: 'video', bundles: getVideoBundles, picker: getVideoModels },
  { lane: 'audio', bundles: getAudioBundles, picker: getAudioModels },
  { lane: 'lipsync', bundles: getLipsyncBundles, picker: getLipsyncModels },
  { lane: 'motion', bundles: getMotionBundles, picker: getMotionModels },
  // Enhance Image (3.0.7): the upscale model is the bundle's only file and
  // lives in upscale_models, so it is checked as a support file below.
  {
    lane: 'upscale', bundles: getUpscaleBundles,
    picker: async () => (await getUpscaleModels()).map((name) => ({ name }) as ClassifiedModel),
  },
  // Local 3D (3.1.0): TRELLIS.2 has no picker, the graph loads it by name
  // from UNETLoader's list (lib/local-3d-comfy comfyThreeDReady).
  {
    lane: '3d', bundles: getThreeDBundles,
    picker: async () => (await getDiffusionModels()).map((name) => ({ name }) as ClassifiedModel),
  },
]

const allBundles = () => LANES.flatMap((l) => l.bundles())

beforeEach(() => { localFetch.mockReset(); backendCall.mockReset() })

// Every mkdtempSync above used to live forever: nothing in this file removed
// its own tree, which is how 4864 of them piled up in one TMPDIR. Runs even
// when a test goes red, so a failure never leaves a bigger mess than a pass.
afterEach(() => {
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true })
  createdRoots.clear()
  declaredBytes.clear()
})

describe('every folder the Get button writes into is one the app reads back', () => {
  it('THE FIX: no bundle in the catalog writes into a folder no reader knows', () => {
    const read = new Set(COMFY_MODEL_FOLDERS.map((f) => f.subfolder))
    const unread = new Map<string, string[]>()
    for (const b of allBundles()) {
      for (const f of b.files) {
        if (!f.subfolder || read.has(f.subfolder)) continue
        unread.set(f.subfolder, [...(unread.get(f.subfolder) ?? []), `${b.name} · ${f.filename}`])
      }
    }
    // Named rather than counted: the message has to say which folder, or the
    // next person has to go and find it again.
    expect(Object.fromEntries(unread)).toEqual({})
  })

  // Negative control: a table that claims a folder ComfyUI does not have would
  // be the same drift facing the other way: a reader asking a loader that
  // answers nothing, forever.
  it('and reads no folder ComfyUI does not have', () => {
    const known = new Set([...Object.keys(SCANS), 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models'])
    for (const f of COMFY_MODEL_FOLDERS) {
      expect(known, f.subfolder).toContain(f.subfolder)
    }
  })
})

describe('what the Get wrote, the picker offers', () => {
  // The two from the report, by name, because they are the two he could not
  // see. Both land in diffusion_models and both are offered from there.
  it('FramePack F1 and Wan 2.1 are in the video picker after their own Get', async () => {
    for (const name of ['FramePack F1 (Image to Video)', 'Wan 2.1 · 1.3B (Lightweight)']) {
      const bundle = getVideoBundles().find((b) => b.name === name)!
      expect(bundle, name).toBeTruthy()
      serve(runTheGet(bundle.files))
      const offered = (await getVideoModels()).map((m) => m.name)
      for (const f of mainFiles(bundle)) expect(offered, `${name} · ${f.filename}`).toContain(f.filename)
    }
  })

  it('the 3D model is not offered as an image model after its Get', async () => {
    const [bundle] = getThreeDBundles()
    serve(runTheGet(bundle.files))
    const offered = (await getImageModels()).map((m) => m.name)
    for (const f of mainFiles(bundle)) expect(offered).not.toContain(f.filename)
  })

  // ...and the same question for every other Get target in the catalog, which
  // is the only way to know the two above were not the only two.
  it('and so is the main model of every other bundle', async () => {
    for (const { lane, bundles, picker } of LANES) {
      for (const b of bundles()) {
        // The AnimateDiff lane is the one pair that has no main model of its
        // own: an SD checkpoint (an image model) plus a motion module under
        // custom_nodes. Its own picker is getAnimateDiffMotionModels.
        if (b.workflow === 'animatediff') continue
        serve(runTheGet(b.files))
        const offered = (await picker()).map((m) => m.name)
        for (const f of mainFiles(b)) expect(offered, `${lane} · ${b.name} · ${f.filename}`).toContain(f.filename)
      }
    }
  }, 30_000)

  /**
   * The support files, which is where the drift actually sat. A file the
   * running ComfyUI lists must never come back from the visibility probe as
   * missing: that answer stops a bundle counting as installed and, on the
   * Create card, ends in "ComfyUI still does not list …" over a file it is
   * listing.
   */
  it('and every support file is confirmed, SigCLIP and Wav2Vec2 included', async () => {
    for (const b of allBundles()) {
      serve(runTheGet(b.files))
      const wanted = b.files.filter((f) => f.filename && f.subfolder).map((f) => f.filename!)
      expect(await modelsNotVisibleInComfy(wanted), b.name).toEqual([])
    }
  }, 30_000)
})

// Guard against the disk-filling bug coming back. The whole catalog,
// including the 27 GB bundle, must still land under a few real MB.
describe('the tree this file builds never gets large for real', () => {
  it('runTheGet across the whole catalog stays far under 5 MB on disk', () => {
    let total = 0
    for (const b of allBundles()) total += realBytesUnder(runTheGet(b.files))
    expect(total).toBeLessThan(5_000_000)
  }, 30_000)
})
