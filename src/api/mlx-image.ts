/**
 * MLX-Stable-Diffusion image pipeline (Apple Silicon), running IN-PROCESS —
 * the app spawns its own MLX Python sidecar (server.py on 127.0.0.1:47712)
 * directly from Rust (`commands::mlx`), no separate lu-bridge daemon. Ported
 * from the web app; the transport is a direct Tauri
 * `invoke` via `invokeMedia` (api/mlx-invoke) plus a readiness wait: the FastAPI
 * sidecar binds a beat after `mlx_start` returns, so a cold first generate
 * can race and 500 with "mlx unreachable".
 *
 * Hard rule: this is the Mac local image backend, NOT ComfyUI.
 */
import { hasMlx } from '../lib/capabilities'
import { invokeMedia } from './mlx-invoke'
import { siGbToBytes } from '../lib/formatters'
import type { ClassifiedModel } from './comfyui'
import { MFLUX_FAMILY, imageModelBringsItsEngine, isMlxEnhancer } from '../lib/image-engines'
import { renderStallLimitMs } from '../lib/tool-timeout'
import { useSettingsStore } from '../stores/settingsStore'

export interface MlxStatus {
  /** The engine can run: venv, the record of a finished pip run and the
   *  packages themselves. A venv alone does not count. */
  installed: boolean
  /** A venv is there but the engine in it is not complete. Setting it up
   *  again repairs it. */
  broken?: boolean
  /** False on an Intel Mac, where the engine has no packages to install. */
  appleSilicon?: boolean
  /** Why this Mac cannot run the engine at all. Null: it can. */
  unsupported?: string | null
  running: boolean
  /** Why the sidecar ended by itself, until the next start. */
  startError?: string | null
  port: number
  modelLoaded?: boolean
  modelRepo?: string | null
  idleSeconds?: number | null
  /** The second engine, mflux, is installed. It arrives with the first model
   *  that runs on it and has no setup step of its own. */
  mfluxInstalled?: boolean
  mfluxVersion?: string
}

/** One bridge image-catalog entry (bridge commands/mlx.rs IMAGE_CATALOG). */
export interface MlxImageModel {
  id: string
  name: string
  repo: string
  /** Wie der Katalog sie fuehrt: in Dezimal-GB. Fuer Text nie direkt nehmen. */
  sizeGB: number
  /** Dieselbe Groesse in Bytes, am Rand aus `sizeGB` gerechnet. JEDE Anzeige
   *  geht hierueber durch `formatBytes`, damit Karte und Downloads-Leiste fuer
   *  dieselbe Datei denselben Text zeigen (Fund 5). */
  sizeBytes: number
  minRamGB: number
  steps: number
  guidance: number
  defaultSize: number
  unfiltered: boolean
  description: string
  /** No longer offered. Listed only because it is still installed here. */
  retired?: boolean
  installed: boolean
  /** The engine that runs it: 'diffusers' is the sidecar, 'mflux' the second
   *  engine, which such a model brings along (lib/image-engines). */
  family?: string
  /** How many images an edit with it takes in all. 0: text to image only. */
  editImages?: number
  /** Whether the steps and the guidance set in Create reach a run. Said for
   *  the packs of the second engine alone: false means the pack runs at its
   *  own count (a distilled model, or one with a Turbo adapter). */
  userSampling?: boolean | null
  /** Whether a run takes the LoRA stack of Create. True for the packs of the
   *  second engine, false for the sidecar's models. */
  loras?: boolean
  /** Set for a Qwen-Image 2.1 prompt enhancer (family 'enhancer'): what it
   *  rewrites. It makes no images and is offered by "Improve my prompt". */
  enhancer?: 't2i' | 'i2i'
  /** It enhances pictures instead of making them (SeedVR2). Such a model is
   *  for Enhance Image alone and is never offered to make a picture with. */
  upscaler?: boolean
}

export interface MlxInstallStatus {
  status: 'idle' | 'installing' | 'complete' | 'error'
  logs: string[]
  error: string | null
  download_progress: number
  download_total: number
  download_speed: number
}

export interface MlxGenerateArgs {
  prompt: string
  model?: string
  steps?: number
  seed?: number
  width?: number
  height?: number
  negativePrompt?: string
  /** Create's CFG scale. Reaches the models that take it (Qwen-Image 2.1). */
  guidance?: number
  /** The images of an edit as staged paths (loadImageRef), the edited one first. */
  images?: string[]
  /** The side an edit scales its images to (qwenEditResolution). */
  resolution?: number
  /** An edit's mask as a staged path, painted over the first image: white
   *  is painted from the prompt, black stays. Grey keeps a share of both. */
  mask?: string
  /** How far an edit starts from noise, in (0, 1]. 1 or absent: from noise. */
  strength?: number
  /** The name of this run. Cancel carries the same one and ends this run
   *  and no other. `generateMlxImageDataUrl` gives every run its own. */
  run?: string
  /** The LoRA stack: files of the Mac's LoRA folder (api/mlx-loras) by name,
   *  in the order they were picked. Reaches the second engine alone. */
  loras?: { name: string; strength: number }[]
  /** C71: how long an image of the sidecar may go without any progress, in
   *  seconds. `generateMlxImageDataUrl` sends Settings' Image timeout. */
  stallTimeoutSecs?: number
}

export interface MlxGenerateResult {
  image_base64: string
  width: number
  height: number
  /** The steps and the guidance the run really took, where the engine says
   *  so: a pack with a Turbo adapter runs at its own whatever was asked. */
  steps?: number
  guidance?: number | null
  /** Absolute path of the PNG Rust also wrote to disk. Absent only when that
   *  write failed (best-effort — a full disk must not fail a render), which
   *  costs the gallery entry its life beyond this session, nothing more. */
  output?: string
}

export async function mlxStatus(): Promise<MlxStatus> {
  return invokeMedia<MlxStatus>('mlx_status')
}

export async function mlxStart(): Promise<{ ok: boolean; port: number }> {
  return invokeMedia<{ ok: boolean; port: number }>('mlx_start')
}

export async function mlxUnload(): Promise<{ ok: boolean; was_loaded: boolean; running: boolean }> {
  return invokeMedia('mlx_unload')
}

export async function mlxGenerate(args: MlxGenerateArgs): Promise<MlxGenerateResult> {
  const body: Record<string, unknown> = { prompt: args.prompt }
  if (args.model) body.model = args.model
  if (args.steps != null) body.steps = args.steps
  if (args.seed != null && args.seed !== -1) body.seed = args.seed
  if (args.width != null) body.width = args.width
  if (args.height != null) body.height = args.height
  if (args.negativePrompt) body.negative_prompt = args.negativePrompt
  if (args.guidance != null) body.guidance = args.guidance
  if (args.images?.length) body.images = args.images
  if (args.resolution != null) body.resolution = args.resolution
  if (args.mask) body.mask = args.mask
  if (args.strength != null && args.strength < 1) body.strength = args.strength
  if (args.run) body.run = args.run
  if (args.loras?.length) body.loras = args.loras.map((l) => ({ name: l.name, strength: l.strength }))
  if (args.stallTimeoutSecs != null) body.stall_timeout_secs = args.stallTimeoutSecs
  // A single long-blocking request (model load + diffusion) — in-process
  // invoke has no per-call timeout to pass (unlike the old HTTP bridgeCmd).
  return invokeMedia<MlxGenerateResult>('mlx_generate', body)
}

/** How far the image is that the second engine or the sidecar is making.
 *  `running` is false for a sidecar pipeline that counts no steps. */
export async function mlxGenerateProgress(): Promise<{ running: boolean; step: number; steps: number }> {
  return invokeMedia('mlx_generate_progress')
}

/** End the image that is being made. The second engine's process is ended,
 *  the sidecar stops between two steps. With `run` only the run of that name
 *  is ended. `stopped` is false when there was no such image. */
export async function cancelMlxGenerate(run?: string): Promise<{ ok: boolean; stopped: boolean }> {
  return invokeMedia('mlx_generate_cancel', run ? { run } : undefined)
}

export async function listMlxImageModels(): Promise<MlxImageModel[]> {
  const catalog = await invokeMedia<MlxImageModel[]>('mlx_image_models')
  // Hier ist die Grenze zwischen den zwei Zaehlweisen, und hier wird gerechnet:
  // der Katalog fuehrt Dezimal-GB (siehe `siGbToBytes`), die Oberflaeche zeigt
  // Bytes durch `formatBytes`. Danach nennt jede Karte, jede Zeile und jede
  // Leiste fuer dieselbe Datei denselben Text.
  mfluxPacks = new Map(
    catalog.filter((m) => m.family === MFLUX_FAMILY).map((m) => [m.id, { userSampling: m.userSampling === true }]),
  )
  catalogueIds = new Set(catalog.map((m) => m.id))
  return catalog.map((m) => ({ ...m, sizeBytes: siGbToBytes(m.sizeGB) }))
}

/** The entries of the catalogue that run on the second engine, each with
 *  whether Create's steps and guidance reach it. Null until the catalogue was
 *  read once. */
let mfluxPacks: Map<string, { userSampling: boolean }> | null = null
let catalogueIds: Set<string> = new Set()

/** The pack of the second engine behind this catalogue id, null for a model
 *  of the sidecar. */
async function mfluxPack(id: string | undefined): Promise<{ userSampling: boolean } | null> {
  if (!id) return null
  // Read again for an id the last reading did not have: a model installed
  // since then must not pass for one of the sidecar.
  if (!mfluxPacks || !catalogueIds.has(id)) await listMlxImageModels().catch(() => null)
  return mfluxPacks?.get(id) ?? null
}

export async function installMlxImageModel(
  id: string,
): Promise<{ ok: boolean; status: string; id?: string }> {
  return invokeMedia('mlx_image_install_model', { id })
}

export async function getMlxImageInstallStatus(): Promise<MlxInstallStatus> {
  return invokeMedia<MlxInstallStatus>('mlx_image_install_status')
}

/** Stop what the image lane is installing: the model download or the engine
 *  setup. What a download fetched stays in the cache, so installing the same
 *  model again resumes instead of restarting. */
export async function cancelMlxImageInstall(): Promise<{ ok: boolean; cancelled: boolean }> {
  return invokeMedia('mlx_image_cancel_install')
}

export async function deleteMlxImageModel(id: string): Promise<{ ok: boolean; id: string }> {
  return invokeMedia('mlx_image_delete_model', { id })
}

/** Install the MLX image engine itself (venv + torch/diffusers sidecar). */
export async function installMlxImageEngine(): Promise<{ ok: boolean; status: string }> {
  return invokeMedia('install_mlx_diffusion')
}

export async function getMlxImageEngineStatus(): Promise<MlxInstallStatus> {
  return invokeMedia<MlxInstallStatus>('install_mlx_diffusion_status')
}

/** Keychain account for the HuggingFace token (see stores/providerStore). */
export const HF_TOKEN_ACCOUNT = 'huggingface-token'

/**
 * Hand the HuggingFace token to Rust, which attaches it to every model
 * download it spawns. Anonymous hub traffic gets rate-limited into the
 * ground: a download that crawls at kilobytes per second is throttling, not
 * a bad connection. Gated repos need a token outright.
 *
 * Rust keeps it in memory only; the keychain is the store of record, so this
 * has to run again on every app start.
 */
export async function applyHfToken(token: string): Promise<{ present: boolean }> {
  return invokeMedia<{ present: boolean }>('set_hf_token', { token })
}

/** Whether Rust currently holds a token. Never returns the token itself. */
export async function hfTokenPresent(): Promise<boolean> {
  const r = await invokeMedia<{ present: boolean }>('hf_token_present')
  return !!r?.present
}

export type MlxImageDecision = 'use' | 'start' | 'comfyui' | 'unavailable'

export function decideMlxImageBackend(opts: {
  isAppleSilicon: boolean
  comfyHasModels: boolean
  mlx: MlxStatus | null
}): MlxImageDecision {
  if (opts.comfyHasModels) return 'comfyui'
  if (!opts.isAppleSilicon) return 'comfyui'
  if (!opts.mlx || !opts.mlx.installed) return 'unavailable'
  return opts.mlx.running ? 'use' : 'start'
}

/** Poll `mlx_status` until the sidecar reports `running`, or time out. */
export async function waitForMlxRunning(timeoutMs = 30_000, pollMs = 500): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const st = await mlxStatus().catch(() => null)
    if (st?.running) return
    // The sidecar died on its way up. Rust has read the reason from its log,
    // and waiting out the rest of the timeout would only replace that reason
    // with "connection refused".
    if (st?.startError) throw new Error(st.startError)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

export interface MlxImage {
  dataUrl: string
  width: number
  height: number
  localPath?: string
  /** What the run really took, where the engine reports it. */
  steps?: number
  guidance?: number
}

/** The name the gallery gives the tool that cut out a picture on a Mac. */
export const MAC_CUTOUT_TOOL = 'macOS Vision'

/** Remove Background on a Mac: Vision finds the subject of the staged image
 *  at `imagePath` and its mask becomes the alpha channel (commands/mlx_cutout.rs).
 *  No model and no engine to set up: macOS brings it. Throws the sentence for
 *  the user, such as when the picture holds no subject. */
export async function cutOutOnMac(imagePath: string): Promise<MlxImage> {
  const made = await invokeMedia<MlxGenerateResult>('mlx_cutout', { image: imagePath })
  return {
    dataUrl: `data:image/png;base64,${made.image_base64}`,
    width: made.width,
    height: made.height,
    localPath: made.output,
  }
}

/** Whether Enhance Image has a local lane on this Mac: an upscaler of the
 *  catalogue is installed (commands/mlx.rs `upscaler`). */
export function mlxUpscalerInstalled(catalog: readonly Pick<MlxImageModel, 'upscaler' | 'installed'>[]): boolean {
  return catalog.some((m) => m.upscaler === true && m.installed)
}

/** The factors Enhance Image takes on a Mac (`UPSCALE_FACTORS` in
 *  commands/image_mflux.rs). */
export const MAC_UPSCALE_FACTORS = [2, 4] as const
export type MacUpscaleFactor = (typeof MAC_UPSCALE_FACTORS)[number]

/** The name the gallery gives the tool that enhanced a picture on a Mac. */
export const MAC_UPSCALE_TOOL = 'SeedVR2 3B'

/** How a caller follows and ends an image of the second engine. */
export interface MlxGenerateWatch {
  /** Called about once a second with the step the engine has finished. */
  onStep?: (step: number, steps: number) => void
  /** Aborting it ends the engine's process (Cancel in Create). */
  signal?: AbortSignal
}

let runsNamed = 0
/** A name no other run of this session has. */
function nameRun(): string {
  runsNamed += 1
  return `run-${Date.now().toString(36)}-${runsNamed}`
}

/** Run `job` while reporting its steps and listening for Cancel. `run` is
 *  the name the job's request carries. */
async function watched<T>(run: string, job: () => Promise<T>, { onStep, signal }: MlxGenerateWatch): Promise<T> {
  // The request may not have arrived at the moment Cancel is pressed, so the
  // stop is asked for again until the run has ended. It names its run: by
  // the time a repeated one arrives, the next image may be the one running.
  const stop = () => { void cancelMlxGenerate(run).catch(() => null) }
  if (signal?.aborted) throw new Error('The image was cancelled before it started.')
  signal?.addEventListener('abort', stop)
  const poll = setInterval(() => {
    if (signal?.aborted) { stop(); return }
    if (!onStep) return
    void mlxGenerateProgress().then((p) => { if (p.running && p.steps > 0) onStep(p.step, p.steps) }).catch(() => null)
  }, 1000)
  try {
    return await job()
  } finally {
    clearInterval(poll)
    signal?.removeEventListener('abort', stop)
  }
}

/**
 * Enhance Image on a Mac: SeedVR2 on the second engine makes the staged
 * picture at `imagePath` larger by `scale` (commands/mlx.rs `mlx_upscale`).
 * Progress and Cancel are those of an image of the second engine. Throws the
 * sentence for the user, such as when no upscaler is installed.
 */
export async function upscaleOnMac(
  imagePath: string,
  opts: { scale: MacUpscaleFactor; seed?: number },
  watch: MlxGenerateWatch = {},
): Promise<MlxImage> {
  const run = nameRun()
  const body: Record<string, unknown> = { image: imagePath, scale: opts.scale, run }
  if (opts.seed != null && opts.seed !== -1) body.seed = opts.seed
  const made = await watched(run, () => invokeMedia<MlxGenerateResult>('mlx_upscale', body), watch)
  return {
    dataUrl: `data:image/png;base64,${made.image_base64}`,
    width: made.width,
    height: made.height,
    localPath: made.output,
    steps: made.steps,
  }
}

/**
 * Ensure the MLX sidecar is up and warm, then generate and return a
 * ready-to-render PNG data URL. Throws on any failure so callers surface a
 * single error string. Retries once on a transient "unreachable" — the cold
 * sidecar binds its port a moment after `mlx_start` returns.
 */
export async function generateMlxImageDataUrl(
  args: MlxGenerateArgs,
  watch: MlxGenerateWatch = {},
): Promise<MlxImage> {
  const status = await mlxStatus()
  if (status.unsupported) throw new Error(status.unsupported)
  const pack = await mfluxPack(args.model)
  const run = nameRun()
  if (pack) {
    // The second engine is a process per image: no sidecar to set up, start
    // or wait for. Qwen-Image 2.1 takes the steps and the guidance set in
    // Create, as it does on Windows. The other packs are distilled or tuned
    // to one count, and Create's default for the model type would run a four
    // step model at twenty five: they run at the catalogue's.
    const sent = { ...(pack.userSampling ? args : { ...args, steps: undefined, guidance: undefined }), run }
    const made = await watched(run, () => mlxGenerate(sent), watch)
    return {
      dataUrl: `data:image/png;base64,${made.image_base64}`,
      width: made.width,
      height: made.height,
      localPath: made.output,
      steps: made.steps,
      guidance: made.guidance ?? undefined,
    }
  }
  // The sidecar makes images from text at the catalogue's guidance. An edit
  // never reaches it: Rust refuses one, and it is not sent a field it drops.
  // It has no place for a LoRA either, and Create offers it no stack.
  // C71: Rust ends it only when it stops moving for this long, the same Image
  // timeout ComfyUI renders go by (Settings).
  const stallTimeoutSecs = Math.round(renderStallLimitMs('image', useSettingsStore.getState().settings) / 1000)
  const plain = { ...args, guidance: undefined, resolution: undefined, mask: undefined, strength: undefined, loras: undefined, run, stallTimeoutSecs }
  if (status.broken) {
    throw new Error('The image engine is incomplete. Set it up again in the Model Manager.')
  }
  if (!status.installed) {
    throw new Error(
      'The local image engine is not set up on this Mac yet (a one-time setup of the on-device image models is needed before local generation works).',
    )
  }
  if (!status.running) {
    await mlxStart()
    await waitForMlxRunning()
  }
  // Cancel reaches the sidecar as well: it stops between two steps, and what
  // a request still brings back after that is dropped by Rust.
  const once = () => watched(run, () => mlxGenerate(plain), watch)
  let result: MlxGenerateResult
  try {
    result = await once()
  } catch (e) {
    // Cold-start race: the sidecar port bound a beat late. Wait + retry once.
    if (!watch.signal?.aborted && /unreachable|refused|reset|ECONNREFUSED/i.test(String(e))) {
      await waitForMlxRunning()
      result = await once()
    } else {
      throw e
    }
  }
  return {
    dataUrl: `data:image/png;base64,${result.image_base64}`,
    width: result.width,
    height: result.height,
    localPath: result.output,
    // What the run took: the sidecar runs at the catalogue's guidance.
    steps: result.steps,
    guidance: result.guidance ?? undefined,
  }
}

/** True when this machine is a Mac (Apple Silicon build → the MLX host). */
export function isMlxImageHost(): boolean {
  return hasMlx()
}

export const MLX_MODEL_PREFIX = 'MLX '
export const MLX_IMAGE_MODEL_NAME = 'MLX SD-Turbo'

export function mlxDisplayName(m: Pick<MlxImageModel, 'name'>): string {
  return `${MLX_MODEL_PREFIX}${m.name}`
}

const mlxIdByDisplayName = new Map<string, string>([[MLX_IMAGE_MODEL_NAME, 'sd-turbo']])

/** Resolve a dropdown selection back to the bridge catalog id. */
export function mlxModelIdFor(displayName: string | null | undefined): string {
  return (displayName && mlxIdByDisplayName.get(displayName)) || 'sd-turbo'
}

export function mlxModelType(m: Pick<MlxImageModel, 'id' | 'defaultSize'>): ClassifiedModel['type'] {
  if (m.id.startsWith('z-image-turbo')) return 'zimage'
  // The family Windows runs this model as: Create then opens on the same
  // steps, CFG and size, shows the reference strip and the transparent
  // background, and names the model the same way.
  if (m.id.startsWith('qwen-image-2.1')) return 'qwenimage'
  return m.defaultSize >= 1024 ? 'sdxl' : 'sd15'
}

/**
 * What the model picker calls the family of a Mac model, and the family it
 * is sorted by.
 *
 * `mlxModelType` answers another question: which of Create's value sets a
 * model opens on, and there every 512 px model is `sd15` and every other
 * 1024 px model `sdxl`. Read as a name that was wrong: SD Turbo carried the
 * tag "SD 1.5" and stood under "Older models" (persona walk, 09.10.2026,
 * Fund 23), and FLUX.2 klein, Z-Image and Chroma carried "SDXL". Null for a
 * model whose type is its family too, and for a name that is not a Mac model.
 */
export function mlxPickerFamily(displayName: string): { label: string; type: string } | null {
  const id = mlxIdByDisplayName.get(displayName)
  if (!id) return null
  // Distilled from SD 2.1. No family of the tier table, so no "Older models".
  if (id === 'sd-turbo') return { label: 'SD Turbo', type: 'sdturbo' }
  if (id.startsWith('flux2')) return { label: 'FLUX 2', type: 'flux2' }
  if (id.startsWith('z-image')) return { label: 'Z-Image', type: 'zimage' }
  if (id.startsWith('chroma')) return { label: 'Chroma', type: 'chroma' }
  if (id === 'qwen-image' || id.startsWith('qwen-image-2512')) return { label: 'Qwen Image', type: 'qwenimage1' }
  return null
}

export function buildMlxImageModels(catalog: MlxImageModel[]): ClassifiedModel[] {
  return catalog
    // An enhancer and an upscaler make no picture from a prompt: no picker
    // lists them (Enhance Image has its own, mlxUpscalerInstalled).
    .filter((m) => m.installed && !isMlxEnhancer(m) && m.upscaler !== true)
    .map((m) => {
      mlxIdByDisplayName.set(mlxDisplayName(m), m.id)
      return {
        name: mlxDisplayName(m), type: mlxModelType(m), source: 'checkpoint',
        // Every entry says whether it edits: that is what lets Edit list the
        // models that take an image and nothing else (lib/image-engines).
        editImages: m.editImages ?? 0,
        // The weights an edit counts into its memory (lib/mac-edit-memory).
        ...(m.sizeGB > 0 ? { packGb: m.sizeGB } : {}),
        ...(imageModelBringsItsEngine(m.family) && m.userSampling !== true ? { ownSampling: true } : {}),
        // Only what the backend says takes a stack gets one in Create.
        ...(m.loras === true ? { mlxLoras: true } : {}),
      } satisfies ClassifiedModel
    })
}

/** True when the given model name is a synthetic MLX image model. */
export function isMlxImageModel(name: string | null | undefined): boolean {
  return !!name && name.startsWith(MLX_MODEL_PREFIX)
}

/** Merge synthetic MLX models into ComfyUI image models — MLX first, dedup by name. */
export function mergeImageModels(
  comfy: ClassifiedModel[],
  mlx: ClassifiedModel[],
): ClassifiedModel[] {
  const names = new Set(mlx.map((m) => m.name))
  return [...mlx, ...comfy.filter((m) => !names.has(m.name))]
}
