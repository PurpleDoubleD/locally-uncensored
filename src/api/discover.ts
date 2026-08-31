import { backendCall, fetchExternal } from "./backend"
import { getCheckpoints, getDiffusionModels, getVAEModels, getCLIPModels, getGgufUnetModels, getAnimateDiffModels, getLoraModels, filterPartialFiles, refreshComfyModels } from "./comfyui"
import type { ProviderId } from "./providers/types"
import { log } from "../lib/logger"

export interface DiscoverModel {
  name: string
  description: string
  pulls: string
  tags: string[]
  updated: string
  url?: string
  // For direct download
  downloadUrl?: string
  filename?: string
  subfolder?: string  // ComfyUI models subfolder: checkpoints, diffusion_models, vae, text_encoders
  sizeGB?: number
  // Vision projector that belongs to `downloadUrl`. A text GGUF carries no
  // image tower: llama.cpp keeps it in a separate mmproj file and only sees
  // images when the server is started with `--mmproj`. When this is set the
  // download writes BOTH files into the model folder and the built-in engine
  // picks the projector up by name (see `mmprojFileName`). Ollama entries never
  // need it, their tag already ships a projector layer.
  mmprojUrl?: string
  mmprojSizeGB?: number
  // Discovery flags
  hot?: boolean       // Featured/trending model
  agent?: boolean     // Supports Agent Mode tool calling
  released?: string   // Release date YYYY-MM for sorting (newest first)
  // F4 (juliandiggins-stack GH#21): explicit CPU-only / ≤8 GB RAM
  // tag. Surfaces a green "CPU-friendly" badge in DiscoverModels and
  // exposes the optional "Lightweight" filter. Set true for ≤4B
  // unfiltered models we have personally test-loaded on a CPU-only
  // 8 GB box.
  lightweight?: boolean
  // Multi-provider
  provider?: ProviderId   // Which provider this model belongs to
  providerName?: string   // Display name of the provider
  canPull?: boolean       // false = no download/pull capability (cloud/external)
  ollamaModel?: string    // Ollama model tag for `ollama pull` (e.g. 'qwen3.6')
  // Model Hub grouping (2.5.8 redesign): entries that are the SAME model in a
  // different quant share a `group` and render as ONE card with a size picker.
  // Different parameter sizes stay separate cards on purpose.
  group?: string
  // Optional hand-written one-liner for the card. When absent the card derives
  // a short line from `description` (text after the first "·", first sentence).
  blurb?: string
  /**
   * SHA256 of the file at `downloadUrl`, 64 hex characters.
   *
   * The only thing that can tell a complete multi-gigabyte model from a
   * plausible-looking truncated one. `sizeGB` cannot: it is a rounded human
   * number ("9.2"), which is why the old completeness check ran on a 10 %
   * tolerance and accepted a download that died at 91 %.
   *
   * Optional on purpose. HuggingFace states this digest for every LFS file
   * (`lfs.oid` in the tree API, which `resolveHfGgufFiles` now reads), but the
   * hand-written catalog entries below carry none yet. When it is absent the
   * download is checked against the server's exact byte count and the Rust side
   * logs, per file, that the CONTENT went unverified.
   */
  sha256?: string
}

export interface DownloadProgress {
  progress: number
  total: number
  speed: number
  filename: string
  status: 'connecting' | 'downloading' | 'pausing' | 'paused' | 'complete' | 'error'
  error?: string
}

// ─── Download API ───

export async function startModelDownload(url: string, subfolder: string, filename: string, expectedBytes?: number, sha256?: string): Promise<{ status: string; id: string; error?: string }> {
  return backendCall("download_model", { url, subfolder, filename, expectedBytes: expectedBytes ?? null, expectedSha256: sha256 ?? null })
}

export async function getDownloadProgress(): Promise<Record<string, DownloadProgress>> {
  try {
    return await backendCall("download_progress")
  } catch {
    return {}
  }
}

export async function pauseDownload(id: string): Promise<void> {
  await backendCall("pause_download", { id })
}

/**
 * The user aborting a transfer: stops it AND deletes the partial file.
 *
 * Not the same thing as `clearDownloadEntry`, and the two must never be swapped
 * again. `retry()` used to come through here, so a short outage on a 40 GB
 * bundle cost the whole download: the error text said "start it again to
 * resume", the UI offered Retry, and Retry deleted the bytes it was about to
 * resume from.
 */
export async function cancelDownload(id: string): Promise<void> {
  await backendCall("cancel_download", { id })
}

/**
 * Drop a settled row (error / paused / complete) from the Rust progress map and
 * LEAVE THE PARTIAL FILE ALONE.
 *
 * Clearing the Rust side is not optional before a retry: `download_model`
 * short-circuits on a file that is already on disk without ever touching the
 * map, so the next poll would resurrect the error row the user just retried
 * (the_mr_pickles). That bookkeeping is all this does — it is not a decision
 * about the user's bytes.
 */
export async function clearDownloadEntry(id: string): Promise<void> {
  await backendCall("clear_download_entry", { id })
}

/** Statuses that mean the address itself is dead, so Retry cannot work. */
const PERMANENT_HTTP = /\(HTTP (401|403|404|410)\)/

/**
 * Would pressing Retry on this error ever succeed?
 *
 * The catalog hard-codes 106 HuggingFace addresses. When one of those repos is
 * renamed, gated or taken down, every attempt answers the same 404/403 forever,
 * and the old UI answered with a bare "HTTP 404" and a Retry button — a loop
 * with no exit. The status code inside the message is the contract; it is put
 * there by `http_error_message` in src-tauri/src/commands/download.rs.
 *
 * A transport error, a rate limit and a 5xx are all temporary and stay
 * retryable: only an address that is gone is permanent.
 */
export function isPermanentDownloadError(error?: string | null): boolean {
  return !!error && PERMANENT_HTTP.test(error)
}

export async function resumeDownload(id: string, url: string, subfolder: string, expectedBytes?: number, sha256?: string): Promise<void> {
  await backendCall("resume_download", { id, url, subfolder, expectedBytes: expectedBytes ?? null, expectedSha256: sha256 ?? null })
}

/** A `.download` partial from an earlier run of the app, with no row watching it. */
export interface OrphanDownload {
  /** Basename minus its extension — NOT the download id. See `orphanFilename`. */
  stem: string
  /** Absolute path of the partial. */
  path: string
  /** Directory it sits in; a GGUF outside the ComfyUI tree resumes into this. */
  dir: string
  bytes: number
}

/**
 * Partial downloads a previous run of the app left behind.
 *
 * Both halves of the download kept their state purely in RAM, so quitting
 * during a multi-gigabyte transfer left the `.download` file on disk with no
 * row, no button and no way to finish or delete it. `extraDirs` carries the
 * provider model folders only the frontend knows (LM Studio, a custom path),
 * taken from the download meta the store now persists.
 */
export async function findOrphanDownloads(extraDirs: string[] = []): Promise<OrphanDownload[]> {
  try {
    return await backendCall("find_orphan_downloads", { extraDirs })
  } catch (err) {
    log.warn('[discover] orphan scan failed', { err })
    return []
  }
}

/** Delete one orphaned partial. Jailed to the model folders on the Rust side. */
export async function deleteOrphanDownload(path: string, extraDirs: string[] = []): Promise<void> {
  await backendCall("delete_orphan_download", { path, extraDirs })
}

/**
 * Recover the download id (the real filename) for an orphaned partial.
 *
 * `Path::with_extension("download")` REPLACES the extension, so the partial for
 * `wan_2.1_vae.safetensors` is `wan_2.1_vae.download`: the original suffix is
 * not on disk any more. Everything that can name the file lives up here — the
 * persisted download meta first, because it also knows the destDir, then the
 * catalog. A stem nothing recognises stays unresolved; it can still be shown
 * and deleted, just not resumed.
 */
export function orphanFilename(stem: string, knownFilenames: Iterable<string>): string | null {
  for (const name of knownFilenames) {
    if (name === stem || name.replace(/\.[^.]+$/, '') === stem) return name
  }
  return null
}

/** Verdict of the ONE space check a bundle gets before its first transfer. */
export interface SpaceVerdict {
  fits: boolean
  requiredBytes: number
  reservedBytes: number
  availableBytes?: number | null
  message?: string
}

/**
 * Does `requiredBytes` still fit, counting what running transfers still owe?
 *
 * Asked once for a whole bundle. The per-file check in `do_download` answers
 * "does the rest of THIS file fit", which is the wrong question when four files
 * start at the same moment: all four passed against the same free bytes, all
 * four started, and the drive filled anyway — on Windows a full system
 * partition degrades the whole machine, not just the download.
 */
export async function checkDownloadSpace(
  target: { subfolder?: string; destDir?: string },
  requiredBytes: number,
): Promise<SpaceVerdict | null> {
  try {
    return await backendCall("check_download_space", {
      subfolder: target.subfolder ?? null,
      destDir: target.destDir ?? null,
      requiredBytes: Math.max(0, Math.round(requiredBytes)),
    })
  } catch (err) {
    // A drive we cannot measure must never block a download.
    log.warn('[discover] space check unavailable', { err })
    return null
  }
}

// ─── Custom Node Installation ───

/** Check if ALL files in a bundle are completely downloaded (size validated) */
export async function checkBundleInstalled(bundle: ModelBundle): Promise<boolean> {
  try {
    const files = bundle.files
      .filter(f => f.subfolder && f.filename)
      .map(f => ({
        subfolder: f.subfolder!,
        filename: f.filename!,
        expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : 0,
      }))
    if (files.length === 0) return false
    const results: Array<{ filename: string; exists: boolean; actualBytes: number; complete: boolean }> =
      await backendCall('check_model_sizes', { files })
    return results.every(r => r.complete)
  } catch {
    return false
  }
}

/** Check multiple bundles at once, returns map of bundle name → installed status */
export async function checkBundlesInstalled(bundles: ModelBundle[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {}
  // Collect ALL files from ALL bundles into a single batch request
  const allFiles: Array<{ subfolder: string; filename: string; expectedBytes: number; bundleName: string }> = []
  for (const bundle of bundles) {
    for (const f of bundle.files) {
      if (!f.subfolder || !f.filename) continue
      allFiles.push({
        subfolder: f.subfolder,
        filename: f.filename,
        expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : 0,
        bundleName: bundle.name,
      })
    }
  }
  if (allFiles.length === 0) return result

  try {
    const checkFiles = allFiles.map(f => ({ subfolder: f.subfolder, filename: f.filename, expectedBytes: f.expectedBytes }))
    const results: Array<{ filename: string; exists: boolean; actualBytes: number; complete: boolean }> =
      await backendCall('check_model_sizes', { files: checkFiles })

    // Map results back to bundles
    const fileStatus = new Map(results.map(r => [r.filename, r.complete]))
    for (const bundle of bundles) {
      const bundleFiles = bundle.files.filter(f => f.filename)
      result[bundle.name] = bundleFiles.length > 0 && bundleFiles.every(f => fileStatus.get(f.filename!) === true)
    }
  } catch {
    // If check fails (e.g. no ComfyUI), all bundles are not installed
    for (const b of bundles) result[b.name] = false
  }

  // ComfyUI's own model lists — fetched once, used twice: to CONFIRM the
  // size-check hits (a file the RUNNING ComfyUI cannot see must not count as
  // installed) and as the fuzzy variant fallback further down.
  // Issue #51 (adhney): ComfyUI lists partially-downloaded files too, so the
  // fuzzy fallback would mark an incomplete download as INSTALLED. Drop any
  // file check_model_sizes confirms is partial before matching.
  let comfyLists: Record<string, string[]> | null = null
  try {
    // getGgufUnetModels for the same reason the Create probe needs it
    // (b8531b6): UNETLoader only enumerates .safetensors and .sft, and GGUF
    // quants are listed by ComfyUI-GGUF's own loader. Both Unfiltered video
    // bundles are GGUF, so without it this cannot see the one file that makes
    // them what they are, and the fuzzy fallback below can never confirm them.
    // getAnimateDiffModels for the same reason getGgufUnetModels is here: the
    // motion modules of both AnimateDiff bundles live under custom_nodes and
    // none of the four ComfyUI\models loaders can see them. Without it the
    // gate below skipped those files and the card trusted the disk alone,
    // which is how two cards read Installed over a rail counter that knew
    // neither of them.
    // getLoraModels for the same reason, found one round later (abnahme
    // counter-check 2026-08-29): the LoRA folder is enumerated by LoraLoader
    // and nothing here asked it, so a LoRA bundle's card was decided on the
    // disk alone while no counter and no list knew the file existed.
    const [rawCheckpoints, rawDiffModels, rawGgufUnets, rawVaes, rawClips, rawMotion, rawLoras] = await Promise.all([
      getCheckpoints(), getDiffusionModels(), getGgufUnetModels(), getVAEModels(), getCLIPModels(),
      getAnimateDiffModels(), getLoraModels(),
    ])
    const [checkpoints, diffModels, ggufUnets, vaes, clips, motion, loras] = await Promise.all([
      filterPartialFiles(rawCheckpoints).then(s => Array.from(s)),
      filterPartialFiles(rawDiffModels).then(s => Array.from(s)),
      filterPartialFiles(rawGgufUnets).then(s => Array.from(s)),
      filterPartialFiles(rawVaes).then(s => Array.from(s)),
      filterPartialFiles(rawClips).then(s => Array.from(s)),
      filterPartialFiles(rawMotion).then(s => Array.from(s)),
      filterPartialFiles(rawLoras).then(s => Array.from(s)),
    ])
    comfyLists = {
      checkpoints,
      diffusion_models: [...diffModels, ...ggufUnets],
      vae: vaes,
      text_encoders: clips,
      loras,
      [ANIMATEDIFF_SUBFOLDER]: motion,
    }
  } catch {
    comfyLists = null // ComfyUI not reachable · size-check verdicts stand
  }

  // pnwpdr4519 (Discord 2026-07-27): the size check looks at the directory LU
  // resolves, but the RUNNING ComfyUI may scan a different install (second
  // copy, moved install). "Installed" from the disk check alone then locks the
  // user out: the Create picker (fed by ComfyUI's enums) shows nothing AND
  // re-downloading is refused. When ComfyUI is reachable, a bundle only counts
  // as installed if ComfyUI can actually see the files it needs.
  //
  // EVERY enumerable file, not merely one of them. GH #113 came back on 2.6.6
  // (Blahx with a screenshot, lapbo: "the model is not visible, although it is
  // downloaded") because "at least one" is nearly free in this catalogue:
  // seven of the thirteen video bundles ship the same umt5_xxl_fp8_e4m3fn_scaled
  // text encoder and six the same wan_2.1_vae. One neighbour that installed
  // cleanly leaves those two listed forever, so a bundle whose own main model
  // ComfyUI cannot serve still passed the gate on somebody else's file. The
  // card then said Installed while the Installed tab and every picker, which
  // enumerate the real model, had nothing (Blahx: two cards reading Installed
  // over a rail counter of 1). The file that makes the bundle what it is is
  // exactly the file this gate has to be sure about.
  if (comfyLists) {
    const visible = new Set<string>()
    for (const arr of Object.values(comfyLists)) for (const n of arr) visible.add(normalizeModelBase(n))
    for (const bundle of bundles) {
      if (!result[bundle.name]) continue
      const enumFiles = bundle.files.filter(f => f.filename && f.subfolder && ENUM_SUBFOLDERS.has(f.subfolder))
      if (enumFiles.length === 0) continue
      const unseen = enumFiles.filter(f => !visible.has(normalizeModelBase(f.filename!)))
      if (unseen.length > 0) {
        result[bundle.name] = false
        log.warn(`[discover] ${bundle.name}: files on disk but invisible to the running ComfyUI · not counting as installed`, {
          files: unseen.map(f => f.filename),
        })
      }
    }
  }

  // Fallback: for bundles not detected by exact filename, check ComfyUI's model lists
  // This catches variant files (e.g. fp8 version of a model with different filename)
  // STRICT: only exact base-name match · no substring matching (caused false positives
  // where z_image_turbo matched z_image_base, or gemma-4-31b matched gemma-4-e4b)
  const undetected = bundles.filter(b => !result[b.name])
  if (undetected.length > 0 && comfyLists) {
    const modelsBySubfolder = comfyLists
    for (const bundle of undetected) {
      const allFound = bundle.files.every(f => {
        if (!f.filename || !f.subfolder) return true
        const models = modelsBySubfolder[f.subfolder] || []
        const base = normalizeModelBase(f.filename)
        return models.some(m => normalizeModelBase(m) === base)
      })
      if (allFound) result[bundle.name] = true
    }
  }

  return result
}

/** Where the AnimateDiff-Evolved pack keeps its motion modules. Not under
 *  ComfyUI\models at all, which is exactly why the counter and the Installed
 *  list used to miss a fully installed AnimateDiff bundle while its card said
 *  Installed (counter-check on the Windows box, 2026-08-29). */
export const ANIMATEDIFF_SUBFOLDER = 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models'

/** Subfolders whose contents ComfyUI enumerates via object_info — the only
 *  ones the visibility check can reason about (upscale models and the GGUF
 *  text downloads stay on the pure size check). The AnimateDiff one is
 *  enumerated by the pack's own ADE_LoadAnimateDiffModel node, so it belongs
 *  here even though it sits under custom_nodes: a motion module the running
 *  ComfyUI cannot list is exactly as useless as an invisible checkpoint.
 *
 *  loras joined on 2026-08-29, with readComfyModelNames below. LoraLoader has
 *  always enumerated that folder; nothing here ever asked it, so a LoRA was
 *  the one installed file the app could not reason about anywhere: its card
 *  trusted the disk alone, the counter and the list never saw it, and a
 *  finished LoRA download was skipped by the visibility wait as unjudgeable. */
export const ENUM_SUBFOLDERS = new Set(['checkpoints', 'diffusion_models', 'vae', 'text_encoders', 'loras', ANIMATEDIFF_SUBFOLDER])

/** Base identity of a model file: basename only (ComfyUI enums can carry
 *  nested-subdir prefixes), lowercase, extension and common quant suffixes
 *  stripped. Shared by the installed-detection visibility check and the fuzzy
 *  variant fallback so both agree on what "the same model" means. */
export function normalizeModelBase(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  return base.replace(/\.[^.]+$/, '').toLowerCase()
    .replace(/[-_](fp4|fp8|fp16|bf16|e4m3fn|scaled|fp8_e4m3fn_scaled)$/g, '')
}

/** Every model name the RUNNING ComfyUI enumerates, as one flat list.
 *
 *  ONE reader, because "can ComfyUI see this file" is asked from three places
 *  and every place that asked its own way ended up asking a different question.
 *  UNETLoader enumerates only .safetensors and .sft; every GGUF quant is listed
 *  by ComfyUI-GGUF's own loader instead. checkBundlesInstalled was taught that
 *  fifth loader in 2.6.6 (6abf570) and the Create probe in 2.6.5 (b8531b6),
 *  while the Model Manager's install click kept asking four. Both Unfiltered
 *  video bundles are GGUF, so on that path a perfectly listed model came back
 *  "not listed" and the user was told LU and ComfyUI use different model
 *  folders, which was never true. Nothing here may go back to a subset. */
export async function readComfyModelNames(): Promise<string[]> {
  const lists = await Promise.all([
    getCheckpoints(), getDiffusionModels(), getVAEModels(), getCLIPModels(), getGgufUnetModels(),
    // Seventh loader, added 2026-08-29 after the abnahme counter-check: the
    // LoRA folder. Two installed addon bundles (Pixel Art XL, SDXL VAE) read
    // Installed on their cards while no list and no counter knew them, and
    // the LoRA half of that could not even be judged, because this reader
    // never asked LoraLoader.
    getLoraModels(),
    // Sixth loader, added 2026-08-29 after the counter-check: the AnimateDiff
    // pack enumerates its motion modules itself, from a folder under
    // custom_nodes. Without it a finished AnimateDiff download could never be
    // confirmed, so the download store spent its full budget and then told the
    // user LU and ComfyUI use different model folders, which was not true.
    getAnimateDiffModels(),
  ])
  return lists.flat()
}

/** Which of `wanted` the RUNNING ComfyUI does not list yet.
 *
 *  One function, because there are two journeys that end in the same place: a
 *  bundle installed from Create (CreateContext) and a download finished in the
 *  Model Manager (downloadStore). C8 gave the first one a wait and left the
 *  second with a single fetch, so the same slow directory scan that froze
 *  Voxyl AI's card on 2026-08-13 simply left a model out of the Installed tab
 *  instead. Two probes would have been two chances to drift.
 *
 *  getGgufUnetModels belongs here for the same reason getImageModels needs it
 *  (comfyui.ts:658): UNETLoader only enumerates .safetensors and .sft, GGUF
 *  quants are listed by ComfyUI-GGUF's own loader. The default Talking
 *  Character bundle IS a .gguf in diffusion_models, so without it the probe
 *  can never succeed for that bundle.
 *
 *  An engine it cannot reach reports everything as missing: an answer we could
 *  not get is not a file we have seen. */
export async function modelsNotVisibleInComfy(wanted: string[]): Promise<string[]> {
  try {
    const visible = new Set((await readComfyModelNames()).map(normalizeModelBase))
    return wanted.filter((n) => !visible.has(normalizeModelBase(n)))
  } catch {
    return wanted // engine unreachable, so it has confirmed nothing
  }
}

/** #72: the backend used to resolve a failed `git pull` as
 *  `{status:"update_failed"}` instead of rejecting · anything but an
 *  installed/updated status must be treated as a failure, not success. */
export function assertNodeInstallOk(result: unknown, name: string): void {
  if (result && typeof result === 'object' && 'status' in result) {
    const status = String((result as { status?: unknown }).status)
    if (status !== 'installed' && status !== 'updated') {
      throw new Error(`${name}: backend reported status "${status}"`)
    }
  }
}

export async function installCustomNodes(nodeKeys: string[]): Promise<void> {
  for (const key of nodeKeys) {
    const entry = CUSTOM_NODE_REGISTRY[key]
    if (!entry) {
      log.warn(`[discover] Unknown custom node key: ${key}`)
      continue
    }
    try {
      const result = await backendCall('install_custom_node', { repoUrl: entry.repo, nodeName: entry.name })
      assertNodeInstallOk(result, entry.name)
      log.info(`[discover] Installed custom node: ${entry.name}`)
    } catch (err) {
      log.error(`[discover] Failed to install ${entry.name}`, { err })
      throw new Error(`Failed to install ${entry.name}: ${err}`)
    }
  }
}

/** How long an install click itself waits for ComfyUI to notice a file that is
 *  already complete on disk. Three rounds of 1.5s against the 20 rounds of 3s
 *  the Create install and the download poller spend, because this one runs
 *  inside a click: the common case is an old file that answers on the very
 *  first lookup, before any waiting happens at all.
 *
 *  This is a fast path, NOT the verdict. Anything it cannot confirm inside the
 *  click goes to confirmVisibleOrAccuse below, on the full budget. */
const INVISIBLE_RECHECK_ATTEMPTS = 3
const INVISIBLE_RECHECK_DELAY_MS = 1500

/** Files whose long visibility confirmation is already running, so a second
 *  click on an overlapping bundle does not start a second one. */
const confirmingVisibility = new Map<string, Promise<void>>()

/** Resolves once every long visibility confirmation started so far has ended.
 *  The confirmation outlives the install click by design, so a test about its
 *  verdict needs something to wait on, and a test about the NEXT install needs
 *  a way to be sure the previous one is not still asking the engine. */
export async function whenVisibilityConfirmed(): Promise<void> {
  await Promise.all([...confirmingVisibility.values()])
}

/**
 * D2. Give a file that is on disk but not listed yet the same sixty seconds the
 * other two paths give it, without holding the click.
 *
 * 05ee25ff justified the click's three rounds with "the download poller keeps
 * watching the same file with the full budget afterwards". For a file that was
 * DOWNLOADED in this run that is true. For a file the install skipped because
 * it was already complete on disk it is not: nothing is started, so the Rust
 * progress map never gains an entry, downloadStore.refresh never sees a
 * transition to complete, and announceUntilVisible is never called. Those 4.5
 * seconds were the only window such a file ever got, and the video bundles
 * share exactly those files, so the case is the common one and not the rare
 * one. Voxyl AI and Aldrich Ironhart (Discord 2026-08-13) measured scans on the
 * big files that run far longer than that.
 *
 * So the click says what it knows for certain, that the file is on disk, and
 * this keeps asking. Every round re-announces the arrival, which is what makes
 * the Model Manager re-run its installed check, and only an engine that still
 * does not list the file after the full budget is called a folder mismatch.
 */
function confirmVisibleOrAccuse(filename: string): Promise<void> {
  const running = confirmingVisibility.get(filename)
  if (running) return running
  const started = runVisibilityConfirmation(filename).finally(() => confirmingVisibility.delete(filename))
  confirmingVisibility.set(filename, started)
  return started
}

async function runVisibilityConfirmation(filename: string): Promise<void> {
  try {
    const { waitForModelsVisible } = await import('../lib/bundle-install')
    const left = await waitForModelsVisible({
      missing: () => modelsNotVisibleInComfy([filename]),
      refresh: async () => {
        await refreshComfyModels().catch(() => false)
        window.dispatchEvent(new CustomEvent('comfyui-model-downloaded', { detail: { filename } }))
      },
    })
    if (left.length === 0) {
      log.info(`[discover] ${filename} is listed by ComfyUI now`)
      return
    }
    log.warn(`[discover] ${filename} exists on disk but the running ComfyUI does not list it`)
    window.dispatchEvent(new CustomEvent('comfyui-model-invisible', { detail: { filename } }))
  } catch (err) {
    log.warn('[discover] visibility confirmation failed', { filename, err })
  }
}

/** One gibibyte, the unit the catalog's `sizeGB` and every size message use. */
const GIB = 1_073_741_824

/**
 * How many bytes this bundle still has to fetch, and where they land.
 *
 * Pure, so the sum can be tested without a drive. Files already on disk are
 * left out — re-checking space for a file that is not going to be fetched would
 * refuse installs that fit perfectly well. `totalSizeGB` is the fallback when
 * the per-file sizes are missing: a rough number is a far better plan than
 * planning for nothing, and it is only ever used to refuse, never to promise.
 */
export function bundleBytesToFetch(
  bundle: ModelBundle,
  installed: Set<string>,
): { bytes: number; subfolder?: string; files: number } {
  const pending = bundle.files.filter(
    f => f.downloadUrl && f.filename && f.subfolder && !installed.has(f.filename),
  )
  if (pending.length === 0) return { bytes: 0, files: 0 }
  const known = pending.reduce((sum, f) => sum + (f.sizeGB ? f.sizeGB * GIB : 0), 0)
  // Not one file states a size: fall back to the bundle total, minus nothing,
  // because we cannot tell which part of it is already there.
  const bytes = known > 0 ? known : (bundle.totalSizeGB || 0) * GIB
  return { bytes: Math.round(bytes), subfolder: pending[0].subfolder, files: pending.length }
}

export async function installBundleComplete(bundle: ModelBundle): Promise<void> {
  const errors: string[] = []

  // Pre-check: which files already exist on disk (skip re-downloading them)
  let installedFiles = new Set<string>()
  try {
    const checkFiles = bundle.files
      .filter(f => f.subfolder && f.filename)
      .map(f => ({ subfolder: f.subfolder!, filename: f.filename!, expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : 0 }))
    if (checkFiles.length > 0) {
      const results: Array<{ filename: string; exists: boolean; complete: boolean }> =
        await backendCall('check_model_sizes', { files: checkFiles })
      for (const r of results) {
        if (r.complete) installedFiles.add(r.filename)
      }
    }
  } catch { /* can't check · download everything */ }

  // Lazily fetched ComfyUI visibility set: "already installed" is only true
  // when the RUNNING ComfyUI lists the file. A file that exists on disk but is
  // invisible to ComfyUI means LU and ComfyUI look at different model folders
  // (pnwpdr4519 Discord 2026-07-27) — silently skipping it as installed left
  // the user with no picker entry AND no way to re-download.
  let visibleBases: Set<string> | null | undefined
  const readVisibleBases = async (): Promise<Set<string> | null> => {
    try {
      return new Set((await readComfyModelNames()).map(normalizeModelBase))
    } catch {
      return null // ComfyUI unreachable · cannot judge visibility
    }
  }
  const comfyCanSee = async (filename: string): Promise<boolean | null> => {
    if (visibleBases === undefined) visibleBases = await readVisibleBases()
    if (!visibleBases) return null
    const base = normalizeModelBase(filename)
    if (visibleBases.has(base)) return true
    // C8, third path. A bundle that finished downloading moments ago leaves its
    // files complete on disk while ComfyUI's own directory scan is still
    // running, and the video bundles share files, so starting an overlapping
    // bundle lands exactly in that window. Asking once there turned a file that
    // was merely not scanned yet into a red row blaming mismatched model
    // folders, which was simply untrue. Same cure as the Create install and the
    // download poller, on a much shorter clock. The rescan also refreshes the
    // set every later file of this bundle is judged against.
    // waitForModelsVisible is pulled in here rather than at the top because
    // bundle-install.ts points back at this module.
    const { waitForModelsVisible } = await import('../lib/bundle-install')
    const left = await waitForModelsVisible({
      missing: async () => (visibleBases?.has(base) ? [] : [filename]),
      refresh: async () => {
        await refreshComfyModels(1).catch(() => false)
        visibleBases = await readVisibleBases()
      },
      attempts: INVISIBLE_RECHECK_ATTEMPTS,
      delayMs: INVISIBLE_RECHECK_DELAY_MS,
    })
    if (!visibleBases) return null // engine left mid wait · still no verdict
    return left.length === 0
  }

  // ONE space check for the whole bundle, before the first byte moves.
  //
  // Every file starts its own transfer and every transfer checked the free
  // space on its own, so a four file bundle passed the same free bytes four
  // times over and then filled the drive between them. The sum is the only
  // honest question, and it has to be asked before anything starts: refusing
  // file three after files one and two have written 20 GB helps nobody.
  const pendingBytes = bundleBytesToFetch(bundle, installedFiles)
  if (pendingBytes.bytes > 0 && pendingBytes.subfolder) {
    const verdict = await checkDownloadSpace({ subfolder: pendingBytes.subfolder }, pendingBytes.bytes)
    if (verdict && !verdict.fits) {
      throw new Error(verdict.message || `${bundle.name} does not fit on this drive.`)
    }
  }

  // Step 1: Start downloads only for files NOT already installed
  for (const file of bundle.files) {
    if (!file.downloadUrl || !file.filename || !file.subfolder) continue
    if (installedFiles.has(file.filename)) {
      const visible = ENUM_SUBFOLDERS.has(file.subfolder) ? await comfyCanSee(file.filename) : null
      // The file is on disk at its full size. That much is certain right now,
      // so it is what the card is told, and an engine that has not caught up
      // yet is not turned into an accusation the user cannot act on.
      log.info(`[discover] Skipping ${file.filename} · already installed`)
      window.dispatchEvent(new CustomEvent('comfyui-download-exists', { detail: { filename: file.filename } }))
      if (visible === false) void confirmVisibleOrAccuse(file.filename)
      continue
    }
    try {
      const expectedBytes = file.sizeGB ? Math.round(file.sizeGB * 1_073_741_824) : undefined
      const result = await startModelDownload(file.downloadUrl, file.subfolder, file.filename, expectedBytes, file.sha256)
      if (result.status === 'exists') {
        // File already on disk · emit synthetic 'complete' so UI reflects it
        window.dispatchEvent(new CustomEvent('comfyui-download-exists', { detail: { filename: file.filename } }))
      }
    } catch (err) {
      log.error(`[discover] Download failed for ${file.filename}`, { err })
      errors.push(`${file.filename}: ${err}`)
    }
  }

  // Step 2: Install custom nodes in BACKGROUND (fire-and-forget, non-blocking)
  // This runs git clone + pip install which can take minutes · never block downloads
  if (bundle.customNodes && bundle.customNodes.length > 0) {
    const nodeKeys = [...bundle.customNodes]
    void (async () => {
      for (const key of nodeKeys) {
        try {
          const entry = CUSTOM_NODE_REGISTRY[key]
          if (!entry) continue
          const result = await backendCall('install_custom_node', { repoUrl: entry.repo, nodeName: entry.name })
          assertNodeInstallOk(result, entry.name)
          log.info(`[discover] Installed custom node: ${entry.name}`)
        } catch (err) {
          log.warn('[discover] Custom node install failed', { err })
        }
      }
      // Restart ComfyUI after custom nodes are done (needed for node registration)
      try {
        await backendCall('stop_comfyui')
        await new Promise(resolve => setTimeout(resolve, 2000))
        await backendCall('start_comfyui')
        log.info('[discover] ComfyUI restarted after custom node install')
      } catch (err) {
        log.warn('[discover] ComfyUI restart after custom node install failed', { err })
      }
    })()
  }

  // Force ComfyUI to re-scan model directories so new files appear in /object_info.
  // Without this, ComfyUI's cached model list stays stale on Windows.
  try {
    const { refreshComfyModels } = await import('./comfyui')
    await refreshComfyModels()
  } catch { /* non-fatal · fetchModels also calls refresh */ }

  // Dispatch event so CreateView + the Model Manager refresh their lists. This
  // fires AFTER refreshComfyModels() above, so a consumer that refetches here
  // sees ComfyUI's rescanned /object_info (the new file). useModels listens for
  // this event too (see its effect) so the Installed tab + pickers update.
  window.dispatchEvent(new CustomEvent('comfyui-model-downloaded'))

  if (errors.length > 0) {
    throw new Error(`Bundle install had ${errors.length} issue(s): ${errors.join('; ')}`)
  }
}

// ─── Component Registry: What each model type needs to work ───


export interface ComponentSpec {
  patterns: string[]
  downloadName: string
  downloadUrl: string
  subfolder: string
}

export interface ComponentRequirements {
  loader: 'UNETLoader' | 'CheckpointLoaderSimple'
  vae?: ComponentSpec
  clip?: ComponentSpec
  clipSecondary?: ComponentSpec
  needsSeparateVAE: boolean
  needsSeparateCLIP: boolean
}

export const COMPONENT_REGISTRY: Record<string, ComponentRequirements> = {
  sd15: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  sdxl: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
  flux: {
    loader: 'UNETLoader',
    vae: { patterns: ['ae', 'flux'], downloadName: 'ae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['t5xxl', 't5-xxl', 't5_xxl'], downloadName: 't5xxl_fp8_e4m3fn.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders' },
    clipSecondary: { patterns: ['clip_l'], downloadName: 'clip_l.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  flux2: {
    loader: 'UNETLoader',
    vae: { patterns: ['flux2', 'flux'], downloadName: 'flux2-vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['qwen', 'mistral'], downloadName: 'qwen_3_4b_fp4_flux2.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  zimage: {
    loader: 'UNETLoader',
    vae: { patterns: ['ae', 'flux'], downloadName: 'ae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['qwen_3_4b', 'qwen3'], downloadName: 'qwen_3_4b.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  ernie_image: {
    loader: 'UNETLoader',
    vae: { patterns: ['flux2-vae', 'flux2', 'flux'], downloadName: 'flux2-vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['ministral-3-3b', 'ministral', 'ernie-image-prompt-enhancer'], downloadName: 'ministral-3-3b.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  wan: {
    loader: 'UNETLoader',
    vae: { patterns: ['wan'], downloadName: 'wan_2.1_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['umt5', 'wan'], downloadName: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  wan22: {
    loader: 'UNETLoader',
    // Wan 2.2 5B uses its OWN VAE (higher compression than 2.1). Prefer the 2.2 file;
    // 'wan' fallback covers a 2.1 VAE only as a last resort. CLIP is the shared UMT5.
    vae: { patterns: ['wan2.2', 'wan2_2'], downloadName: 'wan2.2_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['umt5', 'wan'], downloadName: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  hunyuan: {
    loader: 'UNETLoader',
    vae: { patterns: ['hunyuanvideo', 'hunyuan'], downloadName: 'hunyuanvideo15_vae_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae' },
    clip: { patterns: ['qwen', 'llava'], downloadName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  ltx: {
    loader: 'UNETLoader',
    clip: { patterns: ['gemma'], downloadName: 'gemma_3_12B_it_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: false, needsSeparateCLIP: true,
  },
  mochi: {
    loader: 'UNETLoader',
    vae: { patterns: ['mochi'], downloadName: 'mochi_vae.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/vae/mochi_vae.safetensors', subfolder: 'vae' },
    clip: { patterns: ['t5'], downloadName: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  cosmos: {
    loader: 'UNETLoader',
    vae: { patterns: ['cosmos'], downloadName: 'cosmos_cv8x8x8_1.0.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/vae/cosmos_cv8x8x8_1.0.safetensors', subfolder: 'vae' },
    clip: { patterns: ['oldt5'], downloadName: 'oldt5_xxl_fp8_e4m3fn_scaled.safetensors', downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/text_encoders/oldt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  cogvideo: {
    loader: 'UNETLoader',
    vae: { patterns: ['cogvideox', 'cogvideo'], downloadName: 'cogvideox_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/CogVideoX-comfy/resolve/main/cogvideox_vae_bf16.safetensors', subfolder: 'vae' },
    clip: { patterns: ['t5'], downloadName: 't5xxl_fp16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  svd: { loader: 'ImageOnlyCheckpointLoader', needsSeparateVAE: false, needsSeparateCLIP: false },
  framepack: {
    loader: 'UNETLoader',
    vae: { patterns: ['hunyuan_video_vae', 'hunyuan'], downloadName: 'hunyuan_video_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/vae/hunyuan_video_vae_bf16.safetensors', subfolder: 'vae' },
    clip: { patterns: ['llava', 'qwen'], downloadName: 'llava_llama3_fp8_scaled.safetensors', downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/llava_llama3_fp8_scaled.safetensors', subfolder: 'text_encoders' },
    needsSeparateVAE: true, needsSeparateCLIP: true,
  },
  pyramidflow: {
    loader: 'UNETLoader',
    vae: { patterns: ['pyramid'], downloadName: 'pyramid_flow_vae_bf16.safetensors', downloadUrl: 'https://huggingface.co/Kijai/pyramid-flow-comfy/resolve/main/pyramid_flow_vae_bf16.safetensors', subfolder: 'vae' },
    needsSeparateVAE: true, needsSeparateCLIP: false,
  },
  allegro: { loader: 'UNETLoader', needsSeparateVAE: false, needsSeparateCLIP: false },
  unknown: { loader: 'CheckpointLoaderSimple', needsSeparateVAE: false, needsSeparateCLIP: false },
}

// ─── Text Models (HuggingFace GGUF · unified source for all providers) ───

const HF = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

/**
 * On-disk name of the vision projector that belongs to `modelFilename`:
 * `<model stem>.mmproj.gguf`, written next to the model.
 *
 * Derived, never hand-written in the catalog, because the built-in engine has
 * to find the projector from the model path alone (src-tauri engine.rs mirrors
 * this exact rule). The upstream repos disagree on naming (`mmproj-F16.gguf`,
 * `mmproj-model-bf16.gguf`, `Qwen3.8-27B-Uncensored-vision-f16.gguf`), and the
 * built-in models dir is FLAT, so keeping the upstream name would leave two
 * models fighting over one projector file. Tying the name to the model also
 * keeps the pairing right when a user downloads several quants of one model.
 */
export function mmprojFileName(modelFilename: string): string {
  const stem = modelFilename.replace(/\.gguf$/i, '')
  return `${stem}.mmproj.gguf`
}

/** One file a catalog entry writes into the model folder. */
export interface PlannedDownload {
  url: string
  filename: string
  expectedBytes?: number
  /** Content digest, when the catalog or the HF tree stated one. */
  sha256?: string
}

/**
 * Everything a catalog entry has to put on disk: the model, and its vision
 * projector when it has one. `url` / `filename` / `bytes` are the RESOLVED
 * model file (the HF tree corrects the catalog's guess), the projector rides
 * along under the derived name.
 *
 * Pure on purpose: the download UI only loops over the result, so the "does
 * this model need a second file, and what is it called" decision is unit
 * testable without rendering the Models tab.
 */
export function planModelDownload(model: DiscoverModel, url: string, filename: string, bytes?: number, sha256?: string): PlannedDownload[] {
  // The resolved digest wins over the catalog's: `url` may have been corrected
  // by the HF tree, and a digest that belongs to a different file is worse than
  // none at all.
  const plan: PlannedDownload[] = [{ url, filename, expectedBytes: bytes, sha256: sha256 ?? (url === model.downloadUrl ? model.sha256 : undefined) }]
  if (model.mmprojUrl) {
    plan.push({
      url: model.mmprojUrl,
      filename: mmprojFileName(filename),
      expectedBytes: model.mmprojSizeGB ? Math.round(model.mmprojSizeGB * 1_073_741_824) : undefined,
    })
  }
  return plan
}

/** Sort models by release date, newest first */
function sortByRelease(models: DiscoverModel[]): DiscoverModel[] {
  return models.sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''))
}

/** Unfiltered / abliterated GGUF models · the core of LU. One entry per size variant. */
export function getUncensoredTextModels(): DiscoverModel[] {
  return sortByRelease([
    // ── 2026 SOTA sub-4GB UNCENSORED tool caller (deep-researched 2026-06-06,
    //    Ultra-Lightweight weight class). Abliterated Qwen3-4B keeps the native
    //    Hermes tool template. A/B its tool reliability (abliteration can dent
    //    function calling); run thinking-OFF. ──
    // Uses the huihui Ollama-native tag (NOT a repacked HF GGUF): its template
    // carries the full Hermes tool scaffold, so Ollama accepts the `tools` array.
    // The DevQuasar HF-GGUF repack dropped the tool template → Ollama returned
    // "does not support tools" for every tool call (verified live 2026-06-06).
    { name: 'Qwen3 4B Abliterated', description: 'huihui Qwen3 4B abliterated · unfiltered + native Hermes tool calling in under 4GB (Ollama). Run thinking-OFF for reliable tool calls. Apache-2.0 base.', pulls: '20K+', tags: ['4B', 'Q4_K_M', '2.4 GB', 'Tools', 'Unfiltered'], updated: 'Hot', agent: true, lightweight: true, released: '2025-05', ollamaModel: 'huihui_ai/qwen3-abliterated:4b', sizeGB: 2.4 },
    // ── HOT: Hermes 3 ──
    // Bug Z/b v2.5.0 · leonsk29 GH #48. Pre-v2.5.0 these pointed at
    // `bartowski/Hermes-3-Llama-*-GGUF`. leon's 2026-05-26 CLI repro
    // `ollama pull hf.co/bartowski/Hermes-3-Llama-3.1-8B-GGUF:Q4_K_M`
    // returned HTTP 400 "Repository is not GGUF or is not compatible with
    // llama.cpp" on current Ollama. Switched to `mradermacher/...-GGUF`
    // mirrors which produce llama.cpp-compatible quants (verified all
    // three repos host Q4_K_M files of the expected size). Note the
    // filename convention: mradermacher uses `.` between model name and
    // quant (e.g. `Hermes-3-Llama-3.1-8B.Q4_K_M.gguf`), bartowski uses `-`.
    { name: 'Hermes 3 Llama 3.2 3B', description: 'NousResearch Hermes 3 · unfiltered + native tool calling. Runs on 8 GB RAM, CPU-only.', pulls: '500K+', tags: ['3B', 'Q4_K_M', '2 GB'], updated: 'Hot', agent: true, lightweight: true, released: '2024-08', downloadUrl: HF('mradermacher/Hermes-3-Llama-3.2-3B-GGUF', 'Hermes-3-Llama-3.2-3B.Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.2-3B.Q4_K_M.gguf', sizeGB: 2 },
    { name: 'Hermes 3 Llama 3.1 8B', description: 'NousResearch Hermes 3 · unfiltered + native tool calling. THE agent model.', pulls: '500K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Hot', agent: true, released: '2024-08', downloadUrl: HF('mradermacher/Hermes-3-Llama-3.1-8B-GGUF', 'Hermes-3-Llama-3.1-8B.Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.1-8B.Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Hermes 3 Llama 3.1 70B', description: 'NousResearch Hermes 3 70B · maximum intelligence, unfiltered.', pulls: '500K+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Hot', agent: true, released: '2024-08', downloadUrl: HF('mradermacher/Hermes-3-Llama-3.1-70B-GGUF', 'Hermes-3-Llama-3.1-70B.Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.1-70B.Q4_K_M.gguf', sizeGB: 42 },
    // ── HOT: Dolphin 3 ──
    { name: 'Dolphin 3 Llama 3.1 8B', description: 'Dolphin 3 · unfiltered from training. Coding, math, general purpose.', pulls: '3.7M', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Hot', released: '2024-12', downloadUrl: HF('bartowski/dolphin-2.9.4-llama3.1-8b-GGUF', 'dolphin-2.9.4-llama3.1-8b-Q4_K_M.gguf'), filename: 'dolphin-2.9.4-llama3.1-8b-Q4_K_M.gguf', sizeGB: 5 },
    // ── HOT: Qwen 3.5 Abliterated ──
    { name: 'Qwen 3.5 9B Abliterated', description: 'Qwen 3.5 abliterated · newest, strongest reasoning + coding.', pulls: '10K+', tags: ['9B', 'Q4_K_M', '6 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('mradermacher/Qwen3.5-9B-abliterated-GGUF', 'Qwen3.5-9B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3.5-9B-abliterated.Q4_K_M.gguf', sizeGB: 5 },
    // ── HOT: GPT-OSS Abliterated ──
    { name: 'GPT-OSS 20B Abliterated', description: 'OpenAI GPT-OSS · abliterated open-source GPT model.', pulls: '15K+', tags: ['20B', 'Q4_K_M', '13 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('bartowski/huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-GGUF', 'huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-Q4_K_M.gguf', sizeGB: 13 },
    // ── Qwen 3.8 27B UNCENSORED (August 2026) ──
    // Two independent uncensors of the same dense 27B base. Both are native
    // vision-language models, so every entry carries the repo's own mmproj and
    // LU downloads it with the model (see `mmprojFileName`). The MTP head that
    // ships inside these GGUFs loads fine on the pinned llama.cpp b9949, which
    // implements the qwen35 MTP block, so we point at the plain files and not
    // at JonathanColetti's noMTP cut.
    { name: 'Qwen 3.8 27B Uncensored', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B dense · the viral uncensored build. Vision + thinking, 262K context. Recommended quant. The 0.9 GB vision projector comes with it.', pulls: '1M+', tags: ['27B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q4_K_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q4_K_M.gguf', sizeGB: 16.8, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-vision-f16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored IQ2_M', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · smallest quant, fits a 12 GB card. Real quality tradeoff, but it runs.', pulls: '1M+', tags: ['27B', 'Vision', 'IQ2_M', '11 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-IQ2_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-IQ2_M.gguf', sizeGB: 10.6, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-vision-f16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored IQ4_XS', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · IQ4_XS, the cheapest 4 bit. Close to Q4_K_M on 16 GB cards.', pulls: '1M+', tags: ['27B', 'Vision', 'IQ4_XS', '15 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-IQ4_XS.gguf'), filename: 'Qwen3.8-27B-Uncensored-IQ4_XS.gguf', sizeGB: 15.3, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-vision-f16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored Q5_K_M', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · Q5, higher quality. For 24 GB cards.', pulls: '1M+', tags: ['27B', 'Vision', 'Q5_K_M', '20 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q5_K_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q5_K_M.gguf', sizeGB: 19.5, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-vision-f16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored Q6_K', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · Q6, near-lossless. High-VRAM setups.', pulls: '1M+', tags: ['27B', 'Vision', 'Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q6_K.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q6_K.gguf', sizeGB: 22.4, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-vision-f16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored Q8_0', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · Q8, full quality. 32 GB+ or CPU with lots of RAM.', pulls: '1M+', tags: ['27B', 'Vision', 'Q8_0', '29 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q8_0.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q8_0.gguf', sizeGB: 29, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-vision-f16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Abliterated', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · clean uncensor of the newest Qwen dense model. Vision + thinking. Note the quant is called Q4_K, not Q4_K_M.', pulls: '635K+', tags: ['27B', 'Vision', 'Q4_K', '17 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf', sizeGB: 16.8, mmprojUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'mmproj-model-bf16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Abliterated Q2_K', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · smallest quant for 12 GB cards.', pulls: '635K+', tags: ['27B', 'Vision', 'Q2_K', '11 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q2_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q2_K.gguf', sizeGB: 10.9, mmprojUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'mmproj-model-bf16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Abliterated Q5_K', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · Q5, higher quality. For 24 GB cards.', pulls: '635K+', tags: ['27B', 'Vision', 'Q5_K', '20 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q5_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q5_K.gguf', sizeGB: 19.5, mmprojUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'mmproj-model-bf16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Abliterated Q6_K', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · Q6, near-lossless.', pulls: '635K+', tags: ['27B', 'Vision', 'Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q6_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q6_K.gguf', sizeGB: 22.4, mmprojUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'mmproj-model-bf16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Abliterated Q8_0', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · Q8, full quality.', pulls: '635K+', tags: ['27B', 'Vision', 'Q8_0', '29 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf', sizeGB: 29, mmprojUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'mmproj-model-bf16.gguf'), mmprojSizeGB: 0.93 },
    // Ollama ships the projector as a layer of the tag, so vision works there
    // without a second file.
    { name: 'Qwen 3.8 27B Abliterated (Ollama)', description: 'huihui Qwen 3.8 27B abliterated · one-command pull, projector included. Vision + tools + thinking out of the box.', pulls: '24K+', tags: ['27B', 'Vision', 'Tools', '18 GB'], updated: 'Hot', agent: true, released: '2026-08', ollamaModel: 'huihui_ai/Qwen3.8-abliterated:27b', sizeGB: 17.7 },
    // ── HOT: Qwen 3.6 Unfiltered (April 2026) ──
    { name: 'Qwen 3.6 27B Samantha Unfiltered', description: 'Qwen 3.6 27B dense · Samantha personality, unfiltered finetune. Released April 22 2026. Needs GGUF conversion (see HF).', pulls: 'New', tags: ['27B', 'Vision', 'Unfiltered', '50 GB'], updated: 'Hot', agent: true, released: '2026-04', url: 'https://huggingface.co/cloudbjorn/Qwen3.6-27B_Samantha-Uncensored', canPull: false, sizeGB: 50 },
    { name: 'Qwen 3.6 35B MoE Abliterated', description: 'Qwen 3.6 35B MoE abliterated · brand new unfiltered. 3B active, vision + agentic coding + thinking. 256K context.', pulls: '1K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'huihui_ai/Qwen3.6-abliterated:35b', sizeGB: 24 },
    // Task #34 v2.5.0 · leon-recommended Heretic abliteration (GH #48 reply
    // pointed users with weak Ollama-side downloads at this LM-Studio-friendly
    // direct path). 21.2 GB single file, Q4_K_M. 3B-active MoE so it runs
    // surprisingly well on 24 GB cards with -ncmoe expert offload.
    { name: 'Qwen 3.6 35B MoE Abliterated Heretic', description: 'Qwen 3.6 35B MoE · Heretic abliteration (stronger unfiltered). 3B active expert MoE, runs on 24 GB GPUs.', pulls: '12K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '21 GB', 'Heretic'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF', 'Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M/Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M.gguf'), filename: 'Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M.gguf', sizeGB: 21 },
    // ── HOT: Qwen 3.5 Abliterated (larger variants) ──
    { name: 'Qwen 3.5 27B Abliterated', description: 'Qwen 3.5 27B abliterated · Claude Opus-style, strongest reasoning.', pulls: '20K+', tags: ['27B', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('mradermacher/Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated-GGUF', 'Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf'), filename: 'Huihui-Qwen3.5-27B-Claude-4.6-Opus-abliterated.Q4_K_M.gguf', sizeGB: 16 },
    { name: 'Qwen 3.5 35B MoE Abliterated', description: 'Qwen 3.5 35B MoE abliterated · best agentic, 256K context.', pulls: '26K+', tags: ['35B MoE', 'Q4_K_M', '22 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('mradermacher/Huihui-Qwen3.5-35B-A3B-abliterated-i1-GGUF', 'Huihui-Qwen3.5-35B-A3B-abliterated.i1-Q4_K_M.gguf'), filename: 'Huihui-Qwen3.5-35B-A3B-abliterated.i1-Q4_K_M.gguf', sizeGB: 22 },
    // ── HOT: Qwen3-Coder Abliterated ──
    { name: 'Qwen3-Coder 30B Abliterated', description: 'Qwen3-Coder abliterated · 30B MoE (3B active), built for code agents. 256K context.', pulls: '10K+', tags: ['30B MoE', 'Q4_K_M', '19 GB'], updated: 'Hot', agent: true, released: '2026-02', downloadUrl: HF('mradermacher/Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated-i1-GGUF', 'Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated.i1-Q4_K_M.gguf'), filename: 'Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated.i1-Q4_K_M.gguf', sizeGB: 19 },
    // ── HOT: Gemma 4 Unfiltered Variants ──
    { name: 'Gemma 4 31B Unfiltered', description: 'Gemma 4 31B unfiltered · frontier dense model, native tool calling + vision. 256K context.', pulls: '400+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('TrevorJS/gemma-4-31B-it-uncensored-GGUF', 'gemma-4-31B-it-uncensored-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-uncensored-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Gemma 4 26B MoE Heretic', description: 'Gemma 4 26B MoE HERETIC · 26B brain, 4B active. Unfiltered + tools + vision.', pulls: '43K+', tags: ['26B MoE', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('nohurry/gemma-4-26B-A4B-it-heretic-GUFF', 'gemma-4-26b-a4b-it-heretic.q4_k_m.gguf'), filename: 'gemma-4-26b-a4b-it-heretic.q4_k_m.gguf', sizeGB: 16 },
    { name: 'Gemma 4 31B Heretic', description: 'Gemma 4 31B HERETIC · full uncensor, native tool calling, 256K context.', pulls: '32K+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('Stabhappy/gemma-4-31B-it-heretic-Gguf', 'coder3101_gemma_4_31b_it_heretic-Q4_K_M.gguf'), filename: 'coder3101_gemma_4_31b_it_heretic-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Gemma 4 31B Abliterated', description: 'Gemma 4 31B abliterated · strong reasoning, Apache 2.0.', pulls: '7K+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('LiconStudio/Gemma-4-31B-it-abliterated-GGUF', 'gemma-4-31B-it-abliterated-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-abliterated-Q4_K_M.gguf', sizeGB: 17 },
    // ── Popular: Qwen3 Abliterated ──
    { name: 'Qwen3 8B Abliterated', description: 'Qwen3 abliterated · best overall. Exceptional reasoning, coding, multilingual.', pulls: '30K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('mradermacher/Qwen3-8B-abliterated-GGUF', 'Qwen3-8B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3-8B-abliterated.Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Qwen3 30B MoE Abliterated', description: 'Qwen3 30B MoE abliterated · powerful, runs like 3B active.', pulls: '30K+', tags: ['30B MoE', 'Q4_K_M', '19 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('mradermacher/Qwen3-30B-A3B-abliterated-GGUF', 'Qwen3-30B-A3B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3-30B-A3B-abliterated.Q4_K_M.gguf', sizeGB: 19 },
    // ── Popular: Llama 3.1 8B Abliterated (two quants) ──
    { name: 'Llama 3.1 8B Abliterated Q5', group: 'Llama 3.1 8B Abliterated', description: 'Llama 3.1 8B abliterated · fast, reliable, great entry point. Higher quality quant.', pulls: '200K+', tags: ['8B', 'Q5_K_M', '6 GB'], updated: 'Popular', agent: true, released: '2024-07', downloadUrl: HF('bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF', 'Meta-Llama-3.1-8B-Instruct-abliterated-Q5_K_M.gguf'), filename: 'Meta-Llama-3.1-8B-Instruct-abliterated-Q5_K_M.gguf', sizeGB: 6 },
    { name: 'Llama 3.1 8B Abliterated Q4', group: 'Llama 3.1 8B Abliterated', description: 'Llama 3.1 8B abliterated · fast, reliable, great entry point. Smaller quant.', pulls: '200K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-07', downloadUrl: HF('bartowski/Meta-Llama-3.1-8B-Instruct-abliterated-GGUF', 'Meta-Llama-3.1-8B-Instruct-abliterated-Q4_K_M.gguf'), filename: 'Meta-Llama-3.1-8B-Instruct-abliterated-Q4_K_M.gguf', sizeGB: 5 },
    // ── Popular: DeepSeek R1 Abliterated ──
    { name: 'DeepSeek R1 8B Abliterated', description: 'DeepSeek R1 abliterated 8B · chain-of-thought reasoning.', pulls: '40K+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('mradermacher/DeepSeek-R1-Distill-Qwen-7B-abliterated-v2-GGUF', 'DeepSeek-R1-Distill-Qwen-7B-abliterated-v2.Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-7B-abliterated-v2.Q4_K_M.gguf', sizeGB: 5 },
    { name: 'DeepSeek R1 14B Abliterated', description: 'DeepSeek R1 abliterated 14B · stronger reasoning.', pulls: '40K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('QuantFactory/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2-GGUF', 'DeepSeek-R1-Distill-Qwen-14B-abliterated-v2.Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-14B-abliterated-v2.Q4_K_M.gguf', sizeGB: 9 },
    { name: 'DeepSeek R1 32B Abliterated', description: 'DeepSeek R1 abliterated 32B · powerful reasoning.', pulls: '40K+', tags: ['32B', 'Q4_K_M', '19 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('bartowski/DeepSeek-R1-Distill-Qwen-32B-abliterated-GGUF', 'DeepSeek-R1-Distill-Qwen-32B-abliterated-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-32B-abliterated-Q4_K_M.gguf', sizeGB: 19 },
    { name: 'DeepSeek R1 70B Abliterated', description: 'DeepSeek R1 abliterated 70B · maximum reasoning for high-VRAM setups.', pulls: '40K+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('bartowski/huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-GGUF', 'huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_DeepSeek-R1-Distill-Llama-70B-abliterated-Q4_K_M.gguf', sizeGB: 42 },
    // ── HOT: GLM 4.7 Flash Unfiltered Heretic ──
    { name: 'GLM 4.7 Flash Heretic IQ2', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, fits 12GB VRAM. Strongest 30B class.', pulls: '5K+', tags: ['30B', 'IQ2_M', '10 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-IQ2_M.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-IQ2_M.gguf', sizeGB: 10 },
    { name: 'GLM 4.7 Flash Heretic Q4', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, best quality/size balance.', pulls: '5K+', tags: ['30B', 'Q4_K_M', '19 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q4_K_M.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q4_K_M.gguf', sizeGB: 19 },
    { name: 'GLM 4.7 Flash Heretic Q6', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, high quality quant.', pulls: '5K+', tags: ['30B', 'Q6_K', '25 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q6_K.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q6_K.gguf', sizeGB: 25 },
    { name: 'GLM 4.7 Flash Heretic Q8', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, near-lossless quality.', pulls: '5K+', tags: ['30B', 'Q8_0', '32 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q8_0.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q8_0.gguf', sizeGB: 32 },
    // ── Popular: GLM 4.6 Abliterated ──
    { name: 'GLM 4 9B Abliterated', description: 'GLM 4 9B abliterated · strong coding and reasoning.', pulls: '5K+', tags: ['9B', 'Q4_K_M', '5 GB'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('bartowski/glm-4-9b-chat-abliterated-GGUF', 'glm-4-9b-chat-abliterated-Q4_K_M.gguf'), filename: 'glm-4-9b-chat-abliterated-Q4_K_M.gguf', sizeGB: 5 },
    // ── Popular: Gemma 3 Abliterated ──
    { name: 'Gemma 3 4B Abliterated', description: 'Google Gemma 3 4B abliterated · vision support, runs on 8 GB RAM CPU-only.', pulls: '20K+', tags: ['4B', 'Q4_K_M', '2.3 GB'], updated: 'Popular', lightweight: true, released: '2025-03', downloadUrl: HF('bartowski/mlabonne_gemma-3-4b-it-abliterated-GGUF', 'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf'), filename: 'mlabonne_gemma-3-4b-it-abliterated-Q4_K_M.gguf', sizeGB: 2.3 },
    // ── Lightweight pinned for CPU-only / ≤8 GB RAM (F4 juliandiggins-stack GH#21) ──
    { name: 'Llama 3.2 3B Abliterated', description: 'Meta Llama 3.2 3B abliterated · proven small unfiltered, low resource footprint.', pulls: '50K+', tags: ['3B', 'Q4_K_M', '2 GB'], updated: 'Popular', agent: true, lightweight: true, released: '2024-09', downloadUrl: HF('mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF', 'Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 2 },
    { name: 'Gemma 3 12B Abliterated', description: 'Google Gemma 3 12B abliterated · vision support, great quality.', pulls: '20K+', tags: ['12B', 'Q4_K_M', '8 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('bartowski/mlabonne_gemma-3-12b-it-abliterated-GGUF', 'mlabonne_gemma-3-12b-it-abliterated-Q4_K_M.gguf'), filename: 'mlabonne_gemma-3-12b-it-abliterated-Q4_K_M.gguf', sizeGB: 8 },
    { name: 'Gemma 3 27B Abliterated', description: 'Google Gemma 3 27B abliterated · strong reasoning + vision.', pulls: '20K+', tags: ['27B', 'Q4_K_M', '17 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('bartowski/mlabonne_gemma-3-27b-it-abliterated-GGUF', 'mlabonne_gemma-3-27b-it-abliterated-Q4_K_M.gguf'), filename: 'mlabonne_gemma-3-27b-it-abliterated-Q4_K_M.gguf', sizeGB: 17 },
    // ── Popular: Qwen3 14B Abliterated (two quants) ──
    { name: 'Qwen3 14B Abliterated Q4', group: 'Qwen3 14B Abliterated', description: 'Qwen3 14B abliterated · sweet spot of speed and intelligence.', pulls: '4K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Recent', agent: true, released: '2025-05', downloadUrl: HF('bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF', 'huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_Qwen3-14B-abliterated-Q4_K_M.gguf', sizeGB: 9 },
    { name: 'Qwen3 14B Abliterated Q5', group: 'Qwen3 14B Abliterated', description: 'Qwen3 14B abliterated · higher quality quant.', pulls: '4K+', tags: ['14B', 'Q5_K_M', '10 GB'], updated: 'Recent', agent: true, released: '2025-05', downloadUrl: HF('bartowski/huihui-ai_Qwen3-14B-abliterated-GGUF', 'huihui-ai_Qwen3-14B-abliterated-Q5_K_M.gguf'), filename: 'huihui-ai_Qwen3-14B-abliterated-Q5_K_M.gguf', sizeGB: 10 },
    // ── Popular: Qwen 2.5 Abliterated ──
    { name: 'Qwen 2.5 7B Abliterated', description: 'Qwen 2.5 7B abliterated · proven and reliable.', pulls: '50K+', tags: ['7B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('QuantFactory/Qwen2.5-7B-Instruct-abliterated-v2-GGUF', 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf'), filename: 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Qwen 2.5 14B Abliterated', description: 'Qwen 2.5 14B abliterated · stronger reasoning.', pulls: '50K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('mradermacher/Qwen2.5-14B-Instruct-abliterated-GGUF', 'Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Qwen2.5-14B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 9 },
    { name: 'Qwen 2.5 32B Abliterated', description: 'Qwen 2.5 32B abliterated · powerful.', pulls: '50K+', tags: ['32B', 'Q4_K_M', '19 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('RichardErkhov/huihui-ai_-_Qwen2.5-32B-Instruct-abliterated-gguf', 'Qwen2.5-32B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Qwen2.5-32B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 19 },
    // ── Popular: Single-size unfiltered ──
    { name: 'Llama 3.3 70B Abliterated', description: 'Llama 3.3 70B abliterated · maximum intelligence for high-VRAM setups.', pulls: '15K+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/Llama-3.3-70B-Instruct-abliterated-GGUF', 'Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf'), filename: 'Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf', sizeGB: 42 },
    { name: 'Mistral Small 24B Abliterated', description: 'Mistral Small 24B abliterated · powerful, strong multilingual.', pulls: '10K+', tags: ['24B', 'Q4_K_M', '14 GB'], updated: 'Recent', agent: true, released: '2024-09', downloadUrl: HF('bartowski/huihui-ai_Mistral-Small-24B-Instruct-2501-abliterated-GGUF', 'huihui-ai_Mistral-Small-24B-Instruct-2501-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_Mistral-Small-24B-Instruct-2501-abliterated-Q4_K_M.gguf', sizeGB: 14 },
    { name: 'Phi-4 14B Abliterated', description: 'Microsoft Phi-4 abliterated · excellent at math, logic, structured tasks.', pulls: '8K+', tags: ['14B', 'Q4_K_M', '8 GB'], updated: 'Recent', agent: true, released: '2024-12', downloadUrl: HF('mradermacher/phi-4-abliterated-GGUF', 'phi-4-abliterated.Q4_K_M.gguf'), filename: 'phi-4-abliterated.Q4_K_M.gguf', sizeGB: 8 },
    { name: 'Mistral Nemo 12B Abliterated', description: 'Mistral Nemo 12B abliterated · multilingual powerhouse.', pulls: '5K+', tags: ['12B', 'Q4_K_M', '7 GB'], updated: 'Popular', released: '2024-07', downloadUrl: HF('QuantFactory/Mistral-Nemo-Instruct-2407-abliterated-GGUF', 'Mistral-Nemo-Instruct-2407-abliterated.Q4_K_M.gguf'), filename: 'Mistral-Nemo-Instruct-2407-abliterated.Q4_K_M.gguf', sizeGB: 7 },
    // ── 2026-07-17 catalog refresh (May to July 2026 wave, HF-API-verified
    //    repos/filenames/sizes; DL counts from HF at research time) ──
    { name: 'Qwen 3.6 40B Deckard Heretic', description: 'DavidAU Qwen 3.6 40B Deckard · Heretic uncensored thinking + code model, Claude-Opus-distill flavor. The top unfiltered release of mid-2026 (380K+ downloads).', pulls: '384K+', tags: ['40B', 'Q4_K_M', '23 GB', 'Heretic'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-NEO-CODE-Di-IMatrix-MAX-GGUF', 'Qwen3.6-40B-Deck-Opus-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf'), filename: 'Qwen3.6-40B-Deck-Opus-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf', sizeGB: 23 },
    { name: 'Qwen 3.6 27B Heretic Finetune', description: 'DavidAU Qwen 3.6 27B · Heretic uncensored finetune with NEO-CODE tuning. Strongest 27B-class unfiltered.', pulls: '156K+', tags: ['27B', 'Q4_K_M', '16 GB', 'Heretic'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('DavidAU/Qwen3.6-27B-Heretic-Uncensored-FINETUNE-NEO-CODE-Di-IMatrix-MAX-GGUF', 'Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf'), filename: 'Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf', sizeGB: 16 },
    { name: 'Qwen 3.6 27B Abliterated', description: 'huihui Qwen 3.6 27B abliterated · clean uncensor of the newest Qwen dense model.', pulls: '95K+', tags: ['27B', 'Q4_K', '16 GB'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('huihui-ai/Huihui-Qwen3.6-27B-abliterated-MTP-GGUF', 'Huihui-Qwen3.6-27B-abliterated-ggml-model-Q4_K.gguf'), filename: 'Huihui-Qwen3.6-27B-abliterated-ggml-model-Q4_K.gguf', sizeGB: 16 },
    { name: 'Qwen 3.6 35B MoE Opus Abliterated', description: 'huihui Qwen 3.6 35B MoE · Claude-4.7-Opus-distill flavor, abliterated. Fast 3B-active MoE.', pulls: '42K+', tags: ['35B MoE', 'Q4_K', '20 GB'], updated: 'New', agent: true, released: '2026-05', downloadUrl: HF('huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-MTP-GGUF', 'Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-ggml-model-Q4_K.gguf'), filename: 'Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-ggml-model-Q4_K.gguf', sizeGB: 20 },
    { name: 'Qwythos 9B Mythos Abliterated', description: 'huihui Qwythos 9B · community Claude-Mythos distill on Qwen 3.5, abliterated. Creative-writing hit of June 2026.', pulls: '90K+', tags: ['9B', 'Q4_K', '5.4 GB'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF', 'Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-Q4_K.gguf'), filename: 'Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-Q4_K.gguf', sizeGB: 5.4 },
    { name: 'Gemma 4 12B Abliterated', description: 'huihui Gemma 4 12B QAT abliterated · the first solid Gemma 4 uncensor, vision-capable base.', pulls: '33K+', tags: ['12B', 'Q4_K', '6.9 GB'], updated: 'New', released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF', 'Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf'), filename: 'Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf', sizeGB: 6.9 },
    { name: 'Ornith 1.0 35B Heretic', description: 'Heretic uncensored pass on Ornith 1.0 35B · June 2026\'s hottest agentic coder, unfiltered. MIT.', pulls: '55K+', tags: ['35B MoE', 'Q4_K_M', '20 GB', 'Heretic'], updated: 'Hot', agent: true, released: '2026-07', downloadUrl: HF('llmfan46/Ornith-1.0-35B-uncensored-heretic-GGUF', 'Ornith-1.0-35B-uncensored-heretic-Q4_K_M.gguf'), filename: 'Ornith-1.0-35B-uncensored-heretic-Q4_K_M.gguf', sizeGB: 20 },
    { name: 'Agents A1 Abliterated', description: 'huihui abliterated Agents-A1 · uncensored 35B MoE (3B active) agent model, a rare combo. Apache-2.0.', pulls: '10K+', tags: ['35B MoE', 'Q4_K', '20 GB'], updated: 'New', agent: true, released: '2026-07', downloadUrl: HF('huihui-ai/Huihui-Agents-A1-abliterated-GGUF', 'Agents-A1-abliterated-Q4_K.gguf'), filename: 'Agents-A1-abliterated-Q4_K.gguf', sizeGB: 20 },
    { name: 'Rocinante XL 16B', description: 'TheDrummer Rocinante XL · roleplay / creative-writing specialist, successor to the classic Rocinante.', pulls: '6K+', tags: ['16B', 'Q4_K_M', '9.1 GB', 'RP'], updated: 'New', released: '2026-04', downloadUrl: HF('TheDrummer/Rocinante-XL-16B-v1-GGUF', 'Rocinante-XL-16B-v1a-Q4_K_M.gguf'), filename: 'Rocinante-XL-16B-v1a-Q4_K_M.gguf', sizeGB: 9.1 },
    { name: 'Cydonia 24B v4.3', description: 'TheDrummer Cydonia · the de-facto standard roleplay finetune of Mistral Small 24B.', pulls: '50K+', tags: ['24B', 'Q4_K_M', '13.4 GB', 'RP'], updated: 'Popular', released: '2025-12', downloadUrl: HF('TheDrummer/Cydonia-24B-v4.3-GGUF', 'Cydonia-24B-v4zg-Q4_K_M.gguf'), filename: 'Cydonia-24B-v4zg-Q4_K_M.gguf', sizeGB: 13.4 },
    // 2026-08-01: swapped the ds4 single file for huihui's plain llama.cpp
    // repo. Their "ds4" files are built for the DwarfStar engine first and
    // "may work with other inference engines or not" (their README); a 154 GB
    // download that might not load is the most expensive catalog bug we can
    // ship. Base is still the V4-Flash preview: no GGUF uncensor of 0731
    // exists yet (checked 2026-08-01, one day after the 0731 drop; only FP8
    // and MLX abliterations are out). Watchlist: swap to the 0731 uncensor
    // the day huihui or DavidAU ships one.
    { name: 'DeepSeek V4 Flash Abliterated IQ1', group: 'DeepSeek V4 Flash Abliterated', description: 'huihui abliterated DeepSeek V4-Flash · 284B MoE (13B active), the most-downloaded uncensored model of 2026 so far. Smallest quant, single 87 GB file, runs on 96 GB RAM rigs. MIT.', pulls: '115K+', tags: ['284B MoE', 'UD-IQ1_M', '87 GB'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF', 'DeepSeek-V4-Flash-UD-IQ1_M.gguf'), filename: 'DeepSeek-V4-Flash-UD-IQ1_M.gguf', sizeGB: 86.8 },
    { name: 'DeepSeek V4 Flash Abliterated Q3', group: 'DeepSeek V4 Flash Abliterated', description: 'huihui abliterated DeepSeek V4-Flash · Q3_K_S, higher fidelity. Single 122 GB file for big-RAM setups. MIT.', pulls: '115K+', tags: ['284B MoE', 'Q3_K_S', '122 GB'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF', 'ggml-model-Q3_K_S.gguf'), filename: 'ggml-model-Q3_K_S.gguf', sizeGB: 122 },
    { name: 'GLM 5.2 Abliterated', description: 'huihui abliterated GLM 5.2 · 744B MoE (40B active) uncensored frontier coder. Multi-part download, ~356 GB. MIT.', pulls: '13K+', tags: ['744B MoE', 'UD-Q3_K_M', '356 GB', 'Multi-part'], updated: 'New', agent: true, released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-GLM-5.2-abliterated-GGUF', 'UD-Q3_K_M/GLM-5.2-UD-Q3_K_M-00001-of-00009.gguf'), filename: 'GLM-5.2-UD-Q3_K_M-00001-of-00009.gguf', sizeGB: 356 },
  ])
}

/** Mainstream GGUF models · not unfiltered but excellent for specific tasks. All URLs verified. */
export function getMainstreamTextModels(): DiscoverModel[] {
  return sortByRelease([
    // ── 2026 SOTA sub-4GB TOOL CALLERS (deep-researched + adversarially
    //    verified 2026-06-06). All run in UNDER 4GB VRAM/RAM (Ultra-Lightweight
    //    weight class), commercially licensed (Apache-2.0 / MIT), native tool
    //    calling. The curated "good tool calls on weak hardware" set. ──
    { name: 'Qwen3 4B', description: 'Qwen3 4B · best all-round sub-4GB tool caller (BFCL ~62%). Native Hermes-style tools, 256K context. Tip: run thinking-OFF for reliable tool calls. Apache-2.0.', pulls: '5M+', tags: ['4B', 'Q4_K_M', '2.4 GB', 'Tools'], updated: 'Hot', agent: true, lightweight: true, released: '2025-05', downloadUrl: HF('Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'), filename: 'Qwen3-4B-Q4_K_M.gguf', sizeGB: 2.4 },
    { name: 'IBM Granite 4.0 Micro', description: 'IBM Granite 4.0 Micro (3B) · agentic + coding tool caller. BFCL v3 59.98 (best third-party-sourced sub-4GB score). Native tool calling, runs CPU-only. Apache-2.0.', pulls: '50K+', tags: ['3B', 'Q4_K_M', '2 GB', 'Tools'], updated: 'Hot', agent: true, lightweight: true, released: '2025-10', downloadUrl: HF('ibm-granite/granite-4.0-micro-GGUF', 'granite-4.0-micro-Q4_K_M.gguf'), filename: 'granite-4.0-micro-Q4_K_M.gguf', sizeGB: 2 },
    { name: 'Phi-4 Mini', description: 'Microsoft Phi-4-mini (3.8B) · disciplined JSON-schema function calling, 128K context. Different tool format (<|tool|> tokens) than the Qwen/Granite trio, adds diversity. MIT.', pulls: '500K+', tags: ['3.8B', 'Q4_K_M', '2.4 GB', 'Tools'], updated: 'Hot', agent: true, lightweight: true, released: '2025-02', downloadUrl: HF('lmstudio-community/Phi-4-mini-instruct-GGUF', 'Phi-4-mini-instruct-Q4_K_M.gguf'), filename: 'Phi-4-mini-instruct-Q4_K_M.gguf', sizeGB: 2.4 },
    // ── Gemma 4 (April 2026) ──
    { name: 'Gemma 4 31B', description: 'Google Gemma 4 31B · frontier dense model, native tools + vision. 256K context.', pulls: '100K+', tags: ['31B', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-31B-it-GGUF', 'gemma-4-31B-it-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Gemma 4 26B MoE', description: 'Gemma 4 26B MoE · 26B brain, runs like 4B. Tools + vision. Apache 2.0.', pulls: '100K+', tags: ['26B', 'Q4_K_XL', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'), filename: 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf', sizeGB: 16 },
    { name: 'Gemma 4 12B (Q4)', group: 'Gemma 4 12B', description: 'Google Gemma 4 12B · Q4_K_M, ~7 GB, fits 8 GB GPUs. Native tools + vision, 128K context. lmstudio-community build (LM-Studio-curated) with a fixed tool-template, so tool calling works. Best on LM Studio (Ollama cannot load the gemma4 vision projector yet).', pulls: '100K+', tags: ['12B', 'Q4_K_M', '7 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('lmstudio-community/gemma-4-12b-it-GGUF', 'gemma-4-12B-it-Q4_K_M.gguf'), filename: 'gemma-4-12B-it-Q4_K_M.gguf', sizeGB: 7 },
    { name: 'Gemma 4 12B (Q6)', group: 'Gemma 4 12B', description: 'Google Gemma 4 12B · Q6_K, ~10 GB, fits 12 GB GPUs. Native tools + vision, 128K context. lmstudio-community build (LM-Studio-curated) with a fixed tool-template, so tool calling works. Best on LM Studio (Ollama cannot load the gemma4 vision projector yet).', pulls: '100K+', tags: ['12B', 'Q6_K', '10 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('lmstudio-community/gemma-4-12b-it-GGUF', 'gemma-4-12B-it-Q6_K.gguf'), filename: 'gemma-4-12B-it-Q6_K.gguf', sizeGB: 10 },
    { name: 'Gemma 4 12B (Q8)', group: 'Gemma 4 12B', description: 'Google Gemma 4 12B · Q8_0, near-lossless full quality. Native tools + vision, 128K context, ~13 GB. lmstudio-community build (LM-Studio-curated) with a fixed tool-template, so tool calling works out of the box. Best on LM Studio (Ollama cannot load the gemma4 vision projector yet).', pulls: '100K+', tags: ['12B', 'Q8_0', '13 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('lmstudio-community/gemma-4-12b-it-GGUF', 'gemma-4-12B-it-Q8_0.gguf'), filename: 'gemma-4-12B-it-Q8_0.gguf', sizeGB: 13 },
    { name: 'Gemma 4 E4B', description: 'Gemma 4 E4B · lightweight 4.5B, great for small GPUs.', pulls: '100K+', tags: ['4.5B', 'Q4_K_M', '5 GB'], updated: 'Hot', released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf'), filename: 'gemma-4-E4B-it-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Gemma 4 E2B', description: 'Gemma 4 E2B · ultra-light 2.3B, runs on anything.', pulls: '100K+', tags: ['2.3B', 'Q4_K_M', '3 GB'], updated: 'New', released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf'), filename: 'gemma-4-E2B-it-Q4_K_M.gguf', sizeGB: 3 },
    // ── Qwen 3.8 (August 2026) ──
    // Qwen shipped no GGUF of its own, so the 27B rides on unsloth's dynamic
    // quants (the most-downloaded conversion by a wide margin). Every 27B entry
    // pairs with the repo's mmproj so vision works on the built-in engine and in
    // LM Studio; the Ollama tag brings its own projector layer. The 9B distill
    // has no projector upstream and is therefore text-only.
    { name: 'Qwen 3.8 27B', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B dense · vision + tools + switchable thinking, 262K context. Unsloth dynamic Q4, the recommended default.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q4_K_M.gguf'), filename: 'Qwen3.8-27B-UD-Q4_K_M.gguf', sizeGB: 16.5, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B UD-IQ2_XXS', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · smallest dynamic quant, runs on an 8 GB card.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-IQ2_XXS', '7 GB'], updated: 'New', released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-IQ2_XXS.gguf'), filename: 'Qwen3.8-27B-UD-IQ2_XXS.gguf', sizeGB: 7.3, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B UD-IQ3_XXS', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · 3 bit dynamic, fits 12 GB with context to spare.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-IQ3_XXS', '11 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-IQ3_XXS.gguf'), filename: 'Qwen3.8-27B-UD-IQ3_XXS.gguf', sizeGB: 10.9, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B UD-Q3_K_XL', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q3 dynamic, the 12 GB sweet spot.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q3_K_XL', '13 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q3_K_XL.gguf'), filename: 'Qwen3.8-27B-UD-Q3_K_XL.gguf', sizeGB: 13.1, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B UD-Q4_K_XL', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · better quality per GB than plain Q4. For 20 GB+ cards.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q4_K_XL', '18 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q4_K_XL.gguf'), filename: 'Qwen3.8-27B-UD-Q4_K_XL.gguf', sizeGB: 17.6, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B UD-Q5_K_M', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q5 dynamic, higher quality. For 24 GB cards.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q5_K_M', '20 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q5_K_M.gguf'), filename: 'Qwen3.8-27B-UD-Q5_K_M.gguf', sizeGB: 19.8, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B UD-Q6_K', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q6 dynamic, near-lossless.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q6_K.gguf'), filename: 'Qwen3.8-27B-UD-Q6_K.gguf', sizeGB: 22, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Q8_0', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q8, full quality. 32 GB+ or CPU with lots of RAM.', pulls: '6M+', tags: ['27B', 'Vision', 'Q8_0', '29 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-Q8_0.gguf'), filename: 'Qwen3.8-27B-Q8_0.gguf', sizeGB: 29, mmprojUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'mmproj-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B (Ollama)', description: 'Qwen 3.8 27B · one-command pull, projector included. Vision + tools + thinking out of the box.', pulls: '570K+', tags: ['27B', 'Vision', 'Tools', '18 GB'], updated: 'Hot', agent: true, released: '2026-08', ollamaModel: 'qwen3.8', sizeGB: 17.7 },
    { name: 'Qwen 3.8 9B Distill', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · the 27B reasoning in a size that fits an 8 GB card. Text only, the repo ships no vision projector.', pulls: '126K+', tags: ['9B', 'Q4_K_M', '6 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q4_K_M.gguf'), filename: 'Qwen3.8-9B-Q4_K_M.gguf', sizeGB: 5.8 },
    { name: 'Qwen 3.8 9B Distill Q5_K_M', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · Q5, higher quality. Text only.', pulls: '126K+', tags: ['9B', 'Q5_K_M', '7 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q5_K_M.gguf'), filename: 'Qwen3.8-9B-Q5_K_M.gguf', sizeGB: 6.6 },
    { name: 'Qwen 3.8 9B Distill Q6_K', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · Q6, near-lossless. Text only.', pulls: '126K+', tags: ['9B', 'Q6_K', '8 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q6_K.gguf'), filename: 'Qwen3.8-9B-Q6_K.gguf', sizeGB: 7.6 },
    { name: 'Qwen 3.8 9B Distill Q8_0', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · Q8, full quality. Text only.', pulls: '126K+', tags: ['9B', 'Q8_0', '10 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q8_0.gguf'), filename: 'Qwen3.8-9B-Q8_0.gguf', sizeGB: 9.8 },
    // ── Qwen 3.6 27B DENSE (April 21, 2026 · new release) ──
    { name: 'Qwen 3.6 27B', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B dense · vision + agentic coding + thinking preservation. 256K context. Recommended default.', pulls: 'New', tags: ['27B', 'Vision', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q4_K_M.gguf'), filename: 'Qwen3.6-27B-Q4_K_M.gguf', sizeGB: 16 },
    { name: 'Qwen 3.6 27B Q3_K_M', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B · Q3 quant, fits 12GB VRAM completely. For GPU-only inference.', pulls: 'New', tags: ['27B', 'Vision', 'Q3_K_M', '13 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q3_K_M.gguf'), filename: 'Qwen3.6-27B-Q3_K_M.gguf', sizeGB: 13 },
    { name: 'Qwen 3.6 27B UD-Q4_K_XL', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B · Unsloth Dynamic 2.0 quant. Better quality per GB than Q4_K_M.', pulls: 'New', tags: ['27B', 'Vision', 'UD-Q4_K_XL', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-UD-Q4_K_XL.gguf'), filename: 'Qwen3.6-27B-UD-Q4_K_XL.gguf', sizeGB: 16 },
    { name: 'Qwen 3.6 27B UD-IQ2_XXS', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B · smallest quant (8.7 GB). Runs on 8GB VRAM.', pulls: 'New', tags: ['27B', 'Vision', 'UD-IQ2_XXS', '9 GB'], updated: 'New', released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-UD-IQ2_XXS.gguf'), filename: 'Qwen3.6-27B-UD-IQ2_XXS.gguf', sizeGB: 9 },
    { name: 'Qwen 3.6 27B Q5_K_M', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B · Q5 quant, higher quality. For 24GB+ VRAM.', pulls: 'New', tags: ['27B', 'Vision', 'Q5_K_M', '18 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q5_K_M.gguf'), filename: 'Qwen3.6-27B-Q5_K_M.gguf', sizeGB: 18 },
    { name: 'Qwen 3.6 27B Q6_K', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B · Q6 quant, near-lossless. For high-VRAM setups.', pulls: 'New', tags: ['27B', 'Vision', 'Q6_K', '21 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q6_K.gguf'), filename: 'Qwen3.6-27B-Q6_K.gguf', sizeGB: 21 },
    { name: 'Qwen 3.6 27B Q8_0', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B · Q8 quant, full quality. 24GB+ VRAM / CPU-friendly.', pulls: 'New', tags: ['27B', 'Vision', 'Q8_0', '27 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q8_0.gguf'), filename: 'Qwen3.6-27B-Q8_0.gguf', sizeGB: 27 },
    // ── Qwen 3.6 35B MoE (April 2026) · power user MoE variants ──
    { name: 'Qwen 3.6 35B MoE', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 · 35B MoE (3B active), vision + agentic coding + thinking preservation. 256K context. Power users.', pulls: 'New', tags: ['35B MoE', 'Vision', 'Q4_K_M', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6', sizeGB: 24 },
    { name: 'Qwen 3.6 35B MoE NVFP4', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · NVFP4 quant, smallest size. Best for RTX 40-series / Blackwell.', pulls: 'New', tags: ['35B MoE', 'Vision', 'NVFP4', '22 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-nvfp4', sizeGB: 22 },
    { name: 'Qwen 3.6 35B MoE Coding NVFP4', group: 'Qwen 3.6 35B MoE Coding', description: 'Qwen 3.6 coding-specialized · NVFP4 quant, smaller. Best coding benchmarks per GB.', pulls: 'New', tags: ['35B MoE', 'Coding', 'NVFP4', '22 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-nvfp4', sizeGB: 22 },
    { name: 'Qwen 3.6 35B MoE Q8_0', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · Q8 quant, near-lossless quality. For high-VRAM setups.', pulls: 'New', tags: ['35B MoE', 'Vision', 'Q8_0', '39 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-q8_0', sizeGB: 39 },
    { name: 'Qwen 3.6 35B MoE MXFP8', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · MXFP8 (MicroScaling FP8). Best precision on H100/MI300X.', pulls: 'New', tags: ['35B MoE', 'MXFP8', '38 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-mxfp8', sizeGB: 38 },
    { name: 'Qwen 3.6 35B MoE Coding MXFP8', group: 'Qwen 3.6 35B MoE Coding', description: 'Qwen 3.6 coding + MXFP8. Highest coding quality on datacenter GPUs.', pulls: 'New', tags: ['35B MoE', 'Coding', 'MXFP8', '38 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-mxfp8', sizeGB: 38 },
    { name: 'Qwen 3.6 35B MoE BF16', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · BF16 full precision. Reference quality, big VRAM only.', pulls: 'New', tags: ['35B MoE', 'Vision', 'BF16', '71 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-bf16', sizeGB: 71 },
    { name: 'Qwen 3.6 35B MoE Coding BF16', group: 'Qwen 3.6 35B MoE Coding', description: 'Qwen 3.6 coding specialist · BF16 full precision. Reference coding quality.', pulls: 'New', tags: ['35B MoE', 'Coding', 'BF16', '70 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-bf16', sizeGB: 70 },
    { name: 'Qwen 3.6 35B MoE MLX BF16', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · MLX BF16. Optimized for Apple Silicon (M2/M3/M4).', pulls: 'New', tags: ['35B MoE', 'MLX', 'BF16', '70 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-mlx-bf16', sizeGB: 70 },
    // ── Qwen 3.5 (March 2026) ──
    { name: 'Qwen 3.5 35B MoE', description: 'Qwen 3.5 35B MoE · best agentic, 256K context. SWE-bench leader.', pulls: '100K+', tags: ['35B', 'Q4_K_M', '21 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-35B-A3B-GGUF', 'Qwen3.5-35B-A3B-Q4_K_M.gguf'), filename: 'Qwen3.5-35B-A3B-Q4_K_M.gguf', sizeGB: 21 },
    { name: 'Qwen 3.5 27B', description: 'Qwen 3.5 27B dense · strongest reasoning + coding.', pulls: '100K+', tags: ['27B', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-27B-GGUF', 'Qwen3.5-27B-Q4_K_M.gguf'), filename: 'Qwen3.5-27B-Q4_K_M.gguf', sizeGB: 16 },
    { name: 'Qwen 3.5 9B', description: 'Qwen 3.5 9B · excellent balance of speed and quality.', pulls: '100K+', tags: ['9B', 'Q4_K_M', '5 GB'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf'), filename: 'Qwen3.5-9B-Q4_K_M.gguf', sizeGB: 5 },
    // ── GPT-OSS (March 2026) ──
    { name: 'GPT-OSS 20B', description: 'OpenAI GPT-OSS · open-source GPT model, strong all-rounder.', pulls: '100K+', tags: ['20B', 'Q4_K_M', '11 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/gpt-oss-20b-GGUF', 'gpt-oss-20b-Q4_K_M.gguf'), filename: 'gpt-oss-20b-Q4_K_M.gguf', sizeGB: 11 },
    // ── Qwen3-Coder (Feb-March 2026) ──
    { name: 'Qwen3-Coder 30B', description: 'Qwen3-Coder · 30B MoE coding agent (3B active). Native tool calling, 256K context.', pulls: '100K+', tags: ['30B MoE', 'Q4_K_M', '17 GB'], updated: 'New', agent: true, released: '2026-02', downloadUrl: HF('unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'), filename: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', sizeGB: 17 },
    { name: 'Qwen3-Coder-Next', description: 'Qwen3-Coder-Next · 80B MoE, optimized for agentic coding.', pulls: '10K+', tags: ['80B MoE', 'Q4_K_M', '45 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3-Coder-Next-GGUF', 'Qwen3-Coder-Next-Q4_K_M.gguf'), filename: 'Qwen3-Coder-Next-Q4_K_M.gguf', sizeGB: 45 },
    // ── GLM 4.7 Flash (April 2026) ──
    { name: 'GLM 4.7 Flash IQ2', group: 'GLM 4.7 Flash', description: 'ZhipuAI GLM 4.7 Flash · strongest 30B class model. Fits 12GB VRAM. 198K context.', pulls: '50K+', tags: ['30B', 'IQ2_M', '10 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-IQ2_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-IQ2_M.gguf', sizeGB: 10 },
    { name: 'GLM 4.7 Flash Q2', group: 'GLM 4.7 Flash', description: 'ZhipuAI GLM 4.7 Flash · 30B, low VRAM quant. 198K context.', pulls: '50K+', tags: ['30B', 'Q2_K_L', '11 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q2_K_L.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q2_K_L.gguf', sizeGB: 11 },
    { name: 'GLM 4.7 Flash Q3', group: 'GLM 4.7 Flash', description: 'ZhipuAI GLM 4.7 Flash · 30B, balanced quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q3_K_M', '14 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q3_K_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q3_K_M.gguf', sizeGB: 14 },
    { name: 'GLM 4.7 Flash Q4', group: 'GLM 4.7 Flash', description: 'ZhipuAI GLM 4.7 Flash · 30B, recommended quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q4_K_M', '18 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q4_K_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q4_K_M.gguf', sizeGB: 18 },
    { name: 'GLM 4.7 Flash Q5', group: 'GLM 4.7 Flash', description: 'ZhipuAI GLM 4.7 Flash · 30B, high quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q5_K_M', '22 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q5_K_M.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q5_K_M.gguf', sizeGB: 22 },
    { name: 'GLM 4.7 Flash Q6', group: 'GLM 4.7 Flash', description: 'ZhipuAI GLM 4.7 Flash · 30B, near-lossless. 198K context.', pulls: '50K+', tags: ['30B', 'Q6_K', '25 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q6_K.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q6_K.gguf', sizeGB: 25 },
    { name: 'GLM 4.7 Flash Q8', group: 'GLM 4.7 Flash', description: 'ZhipuAI GLM 4.7 Flash · 30B, maximum quality. 198K context.', pulls: '50K+', tags: ['30B', 'Q8_0', '32 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('bartowski/zai-org_GLM-4.7-Flash-GGUF', 'zai-org_GLM-4.7-Flash-Q8_0.gguf'), filename: 'zai-org_GLM-4.7-Flash-Q8_0.gguf', sizeGB: 32 },
    // ── GLM 5.1 (April 2026) ──
    { name: 'GLM 5.1 754B MoE', description: 'ZhipuAI GLM 5.1 · 754B MoE (40B active). Frontier agentic engineering model. MIT license. Needs multi-file download via CLI.', pulls: '50K+', tags: ['754B MoE', 'IQ2_M', '236 GB'], updated: 'Hot', agent: true, released: '2026-04', url: 'https://huggingface.co/unsloth/GLM-5.1-GGUF', canPull: false, sizeGB: 236 },
    // ── DeepSeek R1 (Jan-Jun 2025) ──
    { name: 'DeepSeek R1 Qwen3 8B', description: 'DeepSeek R1 distilled into Qwen3 8B · chain-of-thought reasoning.', pulls: '2M+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', released: '2025-06', downloadUrl: HF('unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF', 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'DeepSeek R1 Qwen 14B', description: 'DeepSeek R1 distilled into Qwen 14B · stronger reasoning.', pulls: '2M+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF', 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', sizeGB: 9 },
    { name: 'DeepSeek R1 Qwen 32B', description: 'DeepSeek R1 distilled into Qwen 32B · powerful reasoning.', pulls: '2M+', tags: ['32B', 'Q4_K_M', '19 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('unsloth/DeepSeek-R1-Distill-Qwen-32B-GGUF', 'DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Qwen-32B-Q4_K_M.gguf', sizeGB: 19 },
    { name: 'DeepSeek R1 Llama 70B', description: 'DeepSeek R1 distilled into Llama 70B · maximum reasoning.', pulls: '2M+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', released: '2025-01', downloadUrl: HF('unsloth/DeepSeek-R1-Distill-Llama-70B-GGUF', 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf'), filename: 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf', sizeGB: 42 },
    // ── Qwen 3 (May 2025) · 4B moved into the sub-4GB tool-caller group above ──
    { name: 'Qwen 3 8B', description: 'Qwen 3 8B · top-tier reasoning and coding. Thinking mode.', pulls: '5M+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('unsloth/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf'), filename: 'Qwen3-8B-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'Qwen 3 14B', description: 'Qwen 3 14B · sweet spot of speed and quality.', pulls: '5M+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('unsloth/Qwen3-14B-GGUF', 'Qwen3-14B-Q4_K_M.gguf'), filename: 'Qwen3-14B-Q4_K_M.gguf', sizeGB: 9 },
    { name: 'Qwen 3 32B', description: 'Qwen 3 32B · powerful reasoning and coding.', pulls: '5M+', tags: ['32B', 'Q4_K_XL', '20 GB'], updated: 'Popular', agent: true, released: '2025-05', downloadUrl: HF('unsloth/Qwen3-32B-GGUF', 'Qwen3-32B-UD-Q4_K_XL.gguf'), filename: 'Qwen3-32B-UD-Q4_K_XL.gguf', sizeGB: 20 },
    // ── Llama 4 (April 2025) ──
    { name: 'Llama 4 Scout', description: 'Meta Llama 4 Scout · 16x17B MoE. Massive context window.', pulls: '1M+', tags: ['Scout', 'Q2_K_XL', '40 GB'], updated: 'New', agent: true, released: '2025-04', downloadUrl: HF('unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF', 'Llama-4-Scout-17B-16E-Instruct-UD-Q2_K_XL.gguf'), filename: 'Llama-4-Scout-17B-16E-Instruct-UD-Q2_K_XL.gguf', sizeGB: 40 },
    // ── Gemma 3 (March 2025) ──
    { name: 'Gemma 3 12B', description: 'Google Gemma 3 12B · vision support, great quality.', pulls: '100K+', tags: ['12B', 'Q4_K_M', '8 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('unsloth/gemma-3-12b-it-GGUF', 'gemma-3-12b-it-Q4_K_M.gguf'), filename: 'gemma-3-12b-it-Q4_K_M.gguf', sizeGB: 8 },
    { name: 'Gemma 3 27B', description: 'Google Gemma 3 27B · strong reasoning + vision.', pulls: '100K+', tags: ['27B', 'Q4_K_M', '17 GB'], updated: 'Popular', released: '2025-03', downloadUrl: HF('unsloth/gemma-3-27b-it-GGUF', 'gemma-3-27b-it-Q4_K_M.gguf'), filename: 'gemma-3-27b-it-Q4_K_M.gguf', sizeGB: 17 },
    // ── Phi 4 (Dec 2024) ──
    { name: 'Phi-4 14B', description: 'Microsoft Phi-4 · excellent at math, logic, structured tasks.', pulls: '500K+', tags: ['14B', 'Q4_K_M', '9 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/phi-4-GGUF', 'phi-4-Q4_K_M.gguf'), filename: 'phi-4-Q4_K_M.gguf', sizeGB: 9 },
    // ── Llama 3.3 / 3.1 ──
    { name: 'Llama 3.3 70B', description: 'Meta Llama 3.3 70B · maximum intelligence for high-end setups.', pulls: '1M+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/Llama-3.3-70B-Instruct-GGUF', 'Llama-3.3-70B-Instruct-Q4_K_M.gguf'), filename: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf', sizeGB: 42 },
    { name: 'Llama 3.1 8B', description: 'Meta Llama 3.1 8B · fast, reliable, great entry point.', pulls: '1M+', tags: ['8B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-07', downloadUrl: HF('bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf'), filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', sizeGB: 5 },
    // ── Mistral ──
    { name: 'Mistral Small 24B', description: 'Mistral Small · fast, multilingual, native tool calling.', pulls: '300K+', tags: ['24B', 'Q4_K_M', '14 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('bartowski/Mistral-Small-24B-Instruct-2501-GGUF', 'Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf'), filename: 'Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf', sizeGB: 14 },
    { name: 'Mistral Nemo 12B', description: 'Mistral Nemo 12B · multilingual powerhouse.', pulls: '300K+', tags: ['12B', 'Q4_K_M', '7 GB'], updated: 'Popular', released: '2024-07', downloadUrl: HF('bartowski/Mistral-Nemo-Instruct-2407-GGUF', 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf'), filename: 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf', sizeGB: 7 },
    // ── Qwen 2.5 ──
    { name: 'Qwen 2.5 7B', description: 'Qwen 2.5 7B · proven and reliable all-rounder.', pulls: '100K+', tags: ['7B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('bartowski/Qwen2.5-7B-Instruct-GGUF', 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'), filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', sizeGB: 5 },
    // ── 2026-07-17 catalog refresh (May to July 2026 wave, HF-API-verified
    //    repos/filenames/sizes; DL counts from HF at research time).
    //    Negative findings from the same research pass: "Llama 5" and
    //    "Qwen 4" claims circulating in SEO blogs are fabrications (verified
    //    against the live meta-llama / Qwen HF orgs); Kimi K3 weights land
    //    July 27; Qwen 3.7 is API-only · all watchlist, not catalog. ──
    { name: 'Ornith 1.0 9B', description: 'DeepReinforce Ornith 1.0 · 9B coding + agent model that learns its own RL scaffolds. The small-model hit of June 2026 (2M+ downloads). MIT.', pulls: '2.2M', tags: ['9B', 'Q4_K_M', '5.3 GB', 'Coding'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('deepreinforce-ai/Ornith-1.0-9B-GGUF', 'ornith-1.0-9b-Q4_K_M.gguf'), filename: 'ornith-1.0-9b-Q4_K_M.gguf', sizeGB: 5.3 },
    { name: 'Ornith 1.0 35B', description: 'Ornith 1.0 35B MoE (3B active) · agentic coding monster, beats far bigger models on Terminal-Bench. Runs like a 3B. MIT.', pulls: '1.8M', tags: ['35B MoE', 'Q5_K_M', '23 GB', 'Coding'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('deepreinforce-ai/Ornith-1.0-35B-GGUF', 'ornith-1.0-35b-Q5_K_M.gguf'), filename: 'ornith-1.0-35b-Q5_K_M.gguf', sizeGB: 23 },
    { name: 'Agents A1 35B', description: 'InternScience Agents-A1 · 35B MoE (3B active) built for long-horizon agent work. Apache-2.0.', pulls: '34K+', tags: ['35B MoE', 'Q4_K_M', '20 GB'], updated: 'Hot', agent: true, released: '2026-07', downloadUrl: HF('InternScience/Agents-A1-Q4_K_M-GGUF', 'Agents-A1-Q4_K_M.gguf'), filename: 'Agents-A1-Q4_K_M.gguf', sizeGB: 20 },
    { name: 'Agents A1 4B', description: 'Agents-A1 distilled to 4B · small agentic model from the hyped 35B, fits tiny GPUs. Apache-2.0.', pulls: '10K+', tags: ['4B', 'Q4_K_M', '2.5 GB'], updated: 'New', agent: true, released: '2026-07', downloadUrl: HF('InternScience/Agents-A1-4B-Q4_K_M-GGUF', 'Agents-A1-4B-Q4_K_M.gguf'), filename: 'Agents-A1-4B-Q4_K_M.gguf', sizeGB: 2.5 },
    { name: 'LFM 2.5 8B MoE', description: 'Liquid AI LFM 2.5 · 8B MoE (1.5B active), extremely fast on-device model. 128K context, native tools.', pulls: '50K+', tags: ['8B MoE', 'Q4_K_M', '4.8 GB', 'Fast'], updated: 'New', agent: true, released: '2026-05', downloadUrl: HF('LiquidAI/LFM2.5-8B-A1B-GGUF', 'LFM2.5-8B-A1B-Q4_K_M.gguf'), filename: 'LFM2.5-8B-A1B-Q4_K_M.gguf', sizeGB: 4.8 },
    { name: 'IBM Granite 4.1 8B', description: 'IBM Granite 4.1 · 8B hybrid with 512K context and rock-solid tool calling. Apache-2.0.', pulls: '100K+', tags: ['8B', 'Q4_K_M', '5 GB', 'Tools'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('unsloth/granite-4.1-8b-GGUF', 'granite-4.1-8b-Q4_K_M.gguf'), filename: 'granite-4.1-8b-Q4_K_M.gguf', sizeGB: 5 },
    { name: 'MiniCPM-V 4.6', description: 'MiniCPM-V 4.6 · pocket vision model (1.3B) that reads images and video in ~2 GB. Ollama pulls the vision projector automatically. Apache-2.0.', pulls: '100K+', tags: ['1.3B', 'Vision', '2 GB'], updated: 'New', released: '2026-05', ollamaModel: 'openbmb/minicpm-v4.6', sizeGB: 2 },
    { name: 'Nemotron 3 Nano 4B', description: 'NVIDIA Nemotron 3 Nano · 4B hybrid reasoner for edge GPUs. Native tool calling.', pulls: '30K+', tags: ['4B', 'Q4_K_M', '2.7 GB', 'Tools'], updated: 'New', agent: true, released: '2026-01', downloadUrl: HF('unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF', 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf'), filename: 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf', sizeGB: 2.7 },
    { name: 'Qwen 3.5 9B DeepSeek V4 Distill', description: 'DeepSeek V4-Flash reasoning distilled into Qwen 3.5 9B · the "R1 moment" for V4, in 6 GB. Apache-2.0.', pulls: '118K+', tags: ['9B', 'Q4_K_M', '5.3 GB', 'Reasoning'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF', 'Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf'), filename: 'Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf', sizeGB: 5.3 },
    { name: 'Nemotron 3 Nano Omni 30B', description: 'NVIDIA Nemotron 3 Omni · 30B MoE (3B active) that reasons over text, images and audio. The only local omni model in its class.', pulls: '13K+', tags: ['30B MoE', 'UD-Q4_K_XL', '22.3 GB'], updated: 'New', agent: true, released: '2026-05', downloadUrl: HF('unsloth/NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-GGUF', 'NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_XL.gguf'), filename: 'NVIDIA-Nemotron-3-Nano-Omni-30B-A3B-Reasoning-UD-Q4_K_XL.gguf', sizeGB: 22.3 },
    { name: 'Mistral Medium 3.5 128B', description: 'Mistral Medium 3.5 · frontier-class 128B dense drop with reasoning-effort control. Custom Mistral license (check terms for commercial use).', pulls: '222K+', tags: ['128B', 'UD-Q2_K_XL', '45 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Mistral-Medium-3.5-128B-GGUF', 'Mistral-Medium-3.5-128B-UD-Q2_K_XL.gguf'), filename: 'Mistral-Medium-3.5-128B-UD-Q2_K_XL.gguf', sizeGB: 45 },
    // 2026-08-01: 0731 replaces the April preview build. deepseek-ai calls
    // 0731 the official V4-Flash release (beats V4-Pro Preview on agentic
    // benchmarks at 13B active). Repos/paths/sizes HF-verified 2026-08-01;
    // shards resolve at download time via resolveHfGgufFiles, llama.cpp
    // merges the parts.
    { name: 'DeepSeek V4 Flash 0731 IQ1', group: 'DeepSeek V4 Flash 0731', description: 'DeepSeek V4-Flash-0731 · the official V4-Flash release, sharper agentic tuning. 284B MoE (13B active), 1M context, MIT. Smallest quant, runs on 96 GB RAM rigs. Multi-part download.', pulls: '4K+', tags: ['284B MoE', 'UD-IQ1_S', '82.5 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-07', downloadUrl: HF('unsloth/DeepSeek-V4-Flash-0731-GGUF', 'UD-IQ1_S/DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf'), filename: 'DeepSeek-V4-Flash-0731-UD-IQ1_S-00001-of-00003.gguf', sizeGB: 82.5 },
    { name: 'DeepSeek V4 Flash 0731 Q2', group: 'DeepSeek V4 Flash 0731', description: 'DeepSeek V4-Flash-0731 · Unsloth Dynamic Q2_K_XL, the quality/size sweet spot for this MoE. 1M context, MIT. Multi-part download.', pulls: '4K+', tags: ['284B MoE', 'UD-Q2_K_XL', '96.8 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-07', downloadUrl: HF('unsloth/DeepSeek-V4-Flash-0731-GGUF', 'UD-Q2_K_XL/DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00001-of-00003.gguf'), filename: 'DeepSeek-V4-Flash-0731-UD-Q2_K_XL-00001-of-00003.gguf', sizeGB: 96.8 },
    { name: 'DeepSeek V4 Flash 0731 Q4', group: 'DeepSeek V4 Flash 0731', description: 'DeepSeek V4-Flash-0731 · UD-Q4_K_XL full quality. Needs ~155 GB disk and serious RAM. 1M context, MIT. Multi-part download.', pulls: '4K+', tags: ['284B MoE', 'UD-Q4_K_XL', '155 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-07', downloadUrl: HF('unsloth/DeepSeek-V4-Flash-0731-GGUF', 'UD-Q4_K_XL/DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00001-of-00005.gguf'), filename: 'DeepSeek-V4-Flash-0731-UD-Q4_K_XL-00001-of-00005.gguf', sizeGB: 155 },
    { name: 'Hunyuan 3 295B Q4', group: 'Hunyuan 3 295B', description: 'Tencent Hunyuan 3 · 295B MoE (21B active), Apache-2.0 without territorial limits. Needs a current llama.cpp / LM Studio build.', pulls: '20K+', tags: ['295B MoE', 'Q4_K_M', '170 GB'], updated: 'New', agent: true, released: '2026-07', downloadUrl: HF('AngelSlim/Hy3-GGUF', 'Hy3-Q4_K_M.gguf'), filename: 'Hy3-Q4_K_M.gguf', sizeGB: 170 },
    { name: 'Hunyuan 3 295B IQ1', group: 'Hunyuan 3 295B', description: 'Tencent Hunyuan 3 · 1 bit quant for 96 to 128 GB setups. Real quality tradeoff, but it runs. Apache-2.0.', pulls: '20K+', tags: ['295B MoE', 'IQ1_M', '83.3 GB'], updated: 'New', agent: true, released: '2026-07', downloadUrl: HF('AngelSlim/Hy3-GGUF', 'Hy3-IQ1_M.gguf'), filename: 'Hy3-IQ1_M.gguf', sizeGB: 83.3 },
    { name: 'GLM 5.2 744B MoE', description: 'ZhipuAI GLM 5.2 · 744B MoE (40B active), 1M context, MIT. The agentic-coding successor to GLM 5.1. Multi-part, ~304 GB.', pulls: '50K+', tags: ['744B MoE', 'UD-Q2_K_XL', '304 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('unsloth/GLM-5.2-GGUF', 'UD-Q2_K_XL/GLM-5.2-UD-Q2_K_XL-00001-of-00007.gguf'), filename: 'GLM-5.2-UD-Q2_K_XL-00001-of-00007.gguf', sizeGB: 304 },
    { name: 'Kimi K2.7 Code 1T', description: 'Moonshot Kimi K2.7-Code · 1T MoE (32B active) coding flagship. Even the 2-bit quant is ~370 GB · multi-GPU / Mac-cluster territory.', pulls: '392K+', tags: ['1T MoE', 'UD-Q2_K_XL', '371 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('unsloth/Kimi-K2.7-Code-GGUF', 'UD-Q2_K_XL/Kimi-K2.7-Code-UD-Q2_K_XL-00001-of-00008.gguf'), filename: 'Kimi-K2.7-Code-UD-Q2_K_XL-00001-of-00008.gguf', sizeGB: 371 },
  ])
}

// ─── Multi-Provider Discovery ───

/** Fetch models from an OpenAI-compatible provider */
export async function getOpenAIProviderModels(providerName: string): Promise<DiscoverModel[]> {
  try {
    const { getProvider } = await import('./providers/registry')
    const provider = getProvider('openai')
    const models = await provider.listModels()
    return models.map(m => ({
      name: m.id,
      description: m.name !== m.id ? m.name : '',
      pulls: '',
      tags: m.contextLength ? [`${Math.round(m.contextLength / 1024)}K ctx`] : [],
      updated: '',
      provider: 'openai' as ProviderId,
      providerName,
      canPull: false,
      agent: m.supportsTools,
    }))
  } catch {
    return []
  }
}

/** Fetch Anthropic Claude models */
export async function getAnthropicModels(): Promise<DiscoverModel[]> {
  try {
    const { getProvider } = await import('./providers/registry')
    const provider = getProvider('anthropic')
    const models = await provider.listModels()
    return models.map(m => ({
      name: m.id,
      description: m.name,
      pulls: '',
      tags: [
        m.contextLength ? `${Math.round(m.contextLength / 1000)}K ctx` : '',
        m.supportsTools ? 'Tools' : '',
        m.supportsVision ? 'Vision' : '',
      ].filter(Boolean),
      updated: '',
      provider: 'anthropic' as ProviderId,
      providerName: 'Anthropic',
      canPull: false,
      agent: m.supportsTools,
    }))
  } catch {
    return []
  }
}

/** Search HuggingFace for GGUF models */
/**
 * Derive the guessed Q4_K_M filename for a HuggingFace repo name like
 * "TinyLlama-1.1B-Chat-v1.0-Q4_K_M-GGUF" → "TinyLlama-1.1B-Chat-v1.0-Q4_K_M.gguf".
 *
 * Heuristic:
 *   - strip a trailing "-GGUF" / "-gguf"
 *   - if the base already ends with a quant suffix (Q4_K_M, UD-IQ2_XXS, …),
 *     keep it and just append ".gguf" · otherwise HF returns 404 because the
 *     actual file is "basename.gguf", not "basename-Q4_K_M.gguf"
 *   - else default to "{basename}-Q4_K_M.gguf"
 *
 * Exported so the E2E regression test can exercise the edge cases without
 * hitting the live HF API.
 */
export function deriveQ4FilenameFromRepo(repoName: string): string {
  const baseName = repoName.replace(/-GGUF$/i, '').replace(/-gguf$/i, '')
  const QUANT_SUFFIX = /-(Q[0-9]+_K_[MSL]|Q[0-9]_[0-9]+|IQ[0-9]_[A-Z]+(?:_[A-Z]+)?|UD-Q[0-9A-Z_]+|UD-IQ[0-9A-Z_]+|BF16|FP16|F16|F32)$/i
  return QUANT_SUFFIX.test(baseName) ? `${baseName}.gguf` : `${baseName}-Q4_K_M.gguf`
}

export async function searchHuggingFaceModels(query: string): Promise<DiscoverModel[]> {
  try {
    // Case-insensitive · HF repos almost always end in `-GGUF` (uppercase),
    // and the previous case-sensitive `includes('gguf')` missed those, so a
    // user pasting a full repo path like `bartowski/Foo-GGUF` got a search
    // string mangled to `bartowski/Foo-GGUF gguf` which matched 0 HF rows.
    const searchQuery = /gguf/i.test(query) ? query : `${query} gguf`
    const url = `https://huggingface.co/api/models?search=${encodeURIComponent(searchQuery)}&filter=gguf&sort=downloads&direction=-1&limit=20`

    let json: string
    const { isTauri, fetchExternal } = await import('./backend')
    if (isTauri()) {
      json = await fetchExternal(url)
    } else {
      const res = await fetch(url)
      json = await res.text()
    }

    const repos: Array<{ id: string; downloads?: number; modelId?: string }> = JSON.parse(json)

    const models: DiscoverModel[] = []
    for (const repo of repos) {
      const repoName = repo.id.split('/').pop() || ''
      const q4File = deriveQ4FilenameFromRepo(repoName)
      const downloadUrl = `https://huggingface.co/${repo.id}/resolve/main/${q4File}`

      // Display name = repo basename without the GGUF suffix. The previous
      // version referenced an undefined `baseName` here, throwing a
      // ReferenceError that the catch silently turned into an empty array
      // · the user-facing P11 search was returning "No models found" for
      // every query, even ones that match plenty of HF results.
      const displayName = repoName.replace(/-GGUF$/i, '').replace(/-gguf$/i, '')

      const downloads = repo.downloads || 0
      const pullsStr = downloads > 1000000 ? `${(downloads / 1000000).toFixed(1)}M` :
        downloads > 1000 ? `${Math.round(downloads / 1000)}K` : `${downloads}`

      models.push({
        name: displayName,
        description: repo.id,
        pulls: pullsStr,
        tags: ['Q4_K_M', 'GGUF'],
        updated: '',
        downloadUrl,
        filename: q4File,
        url: `https://huggingface.co/${repo.id}`,
      })
    }
    return models
  } catch (err) {
    log.warn('[discover] HF search failed', { err })
    return []
  }
}

// ─── HuggingFace file-tree resolution (sharded / multi-part GGUF) ───
//
// The naive "guess one Q4 filename from the repo name" path (search results +
// some curated entries) breaks for three real-world layouts the HF API reveals:
//   1. The quant lives in a subfolder (bartowski ships big quants as
//      `<base>-<Quant>/<file>.gguf`), not at the repo root.
//   2. The quant is split into multiple parts (`-00001-of-0000N.gguf`). Every
//      part must land in ONE folder for llama.cpp / LM Studio to load it as a
//      single model. `ollama pull` cannot consume split GGUF at all
//      (ollama/ollama#5245) · direct multi-part download is the only sound path.
//   3. The guessed single-file name simply doesn't exist (404).
// Resolving against the real tree fixes all three.

/**
 * One entry of `/api/models/<repo>/tree/main`.
 *
 * `lfs.oid` is the SHA256 of the file content — every GGUF and safetensors file
 * on HuggingFace is stored via LFS, so this is a free, authoritative digest for
 * exactly the files that are too big to re-download by accident.
 */
export interface HfTreeEntry { type: string; path: string; size?: number; lfs?: { oid?: string; size?: number } }

export interface HfGgufFile { url: string; filename: string; sizeBytes: number; sha256?: string }

/** A 64 hex character digest, or undefined. HF prefixes nothing, but a repo can
 *  carry a non-LFS pointer whose oid is a git blob hash (40 hex) — that one is
 *  NOT a content digest and must not be handed on as one. */
export function lfsSha256(entry: HfTreeEntry): string | undefined {
  const oid = entry.lfs?.oid?.trim().toLowerCase()
  return oid && /^[0-9a-f]{64}$/.test(oid) ? oid : undefined
}

export interface HfGgufResolution {
  sharded: boolean
  files: HfGgufFile[]
  totalBytes: number
  quant?: string
}

// 5-digit llama.cpp split convention: `<name>-00001-of-00002.gguf`. A few
// uploaders pad to 4, so accept 4-5.
const GGUF_SHARD_RE = /-(\d{4,5})-of-(\d{4,5})\.gguf$/i
// Broad quant token matcher (covers Q2_K, Q3_K_S/M/L, Q4_0/1, Q4_K_S/M/L,
// Q5_K_*, Q6_K(_L), Q8_0, IQ1..IQ4 variants, F16/BF16/F32). Used only to LABEL
// and PICK a group · grouping itself never depends on it.
const GGUF_QUANT_TOKEN = /(IQ\d_[A-Z0-9]+|Q\d_K(?:_[A-Z]+)?|Q\d_[01]|BF16|F16|F32)/i

/**
 * Pure: given a HuggingFace repo file tree, pick the GGUF file-set to download.
 * Returns every part of a sharded set (sorted) or the single matching file.
 * Exported for unit testing without a network round-trip.
 */
export function selectGgufFromTree(
  entries: HfTreeEntry[],
  repoId: string,
  preferredQuant?: string,
): HfGgufResolution | null {
  const ggufs = entries.filter(e => e.type === 'file' && /\.gguf$/i.test(e.path))
  if (ggufs.length === 0) return null

  // Group by the path with the shard suffix stripped. Single files keep their
  // full path (their own group of one); all parts of a split set collapse to
  // the same key regardless of whether the quant sits in the folder or the leaf.
  interface Group { key: string; quant?: string; parts: HfTreeEntry[] }
  const groups = new Map<string, Group>()
  for (const f of ggufs) {
    const key = f.path.replace(GGUF_SHARD_RE, '')
    const leaf = (f.path.split('/').pop() || '').replace(GGUF_SHARD_RE, '.gguf')
    const quant = (GGUF_QUANT_TOKEN.exec(leaf)?.[1] || GGUF_QUANT_TOKEN.exec(f.path)?.[1])?.toUpperCase()
    let g = groups.get(key)
    if (!g) { g = { key, quant, parts: [] }; groups.set(key, g) }
    g.parts.push(f)
  }

  const all = [...groups.values()]
  const wanted = preferredQuant?.toUpperCase()
  const picked =
    (wanted ? all.find(g => g.quant === wanted) : undefined) ||
    (wanted ? all.find(g => g.key.toUpperCase().includes(wanted)) : undefined) ||
    all.find(g => g.quant === 'Q4_K_M') ||
    all[0]
  if (!picked) return null

  const sorted = [...picked.parts].sort((a, b) => {
    const ai = parseInt(a.path.match(GGUF_SHARD_RE)?.[1] || '0', 10)
    const bi = parseInt(b.path.match(GGUF_SHARD_RE)?.[1] || '0', 10)
    return ai - bi
  })
  const files: HfGgufFile[] = sorted.map(p => ({
    url: `https://huggingface.co/${repoId}/resolve/main/${p.path}`,
    filename: p.path.split('/').pop() as string,
    sizeBytes: p.size || 0,
    sha256: lfsSha256(p),
  }))
  return {
    sharded: files.length > 1,
    files,
    totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
    quant: picked.quant,
  }
}

/**
 * Resolve the real downloadable GGUF file(s) for a HuggingFace repo by querying
 * its file tree. Returns null if the tree can't be fetched · callers then fall
 * back to their guessed single-file URL (no regression, just no improvement).
 */
export async function resolveHfGgufFiles(
  repoId: string,
  preferredQuant?: string,
): Promise<HfGgufResolution | null> {
  try {
    const url = `https://huggingface.co/api/models/${repoId}/tree/main?recursive=true`
    let json: string
    const { isTauri, fetchExternal } = await import('./backend')
    if (isTauri()) {
      json = await fetchExternal(url)
    } else {
      const res = await fetch(url)
      json = await res.text()
    }
    const entries = JSON.parse(json)
    if (!Array.isArray(entries)) return null
    return selectGgufFromTree(entries as HfTreeEntry[], repoId, preferredQuant)
  } catch (err) {
    log.warn('[discover] HF tree resolve failed', { repoId, err })
    return null
  }
}

/** Detect the model directory for the active local provider */
export async function detectProviderModelPath(providerName: string): Promise<string | null> {
  try {
    return await backendCall('detect_model_path', { provider: providerName })
  } catch {
    return null
  }
}

/** Download a GGUF model to a specific directory (for non-Ollama providers) */
export async function startModelDownloadToPath(url: string, destDir: string, filename: string, expectedBytes?: number, sha256?: string): Promise<{ status: string; id: string; error?: string }> {
  return backendCall('download_model_to_path', { url, destDir, filename, expectedBytes: expectedBytes ?? null, expectedSha256: sha256 ?? null })
}

/** What the catalog knows about one downloadable file. */
export interface FileMeta {
  url: string
  subfolder: string
  expectedBytes?: number
  sha256?: string
}

/** Every catalog entry that carries a downloadable file, image/video bundles
 *  and text models alike. One walk, so the lookups below cannot drift apart. */
function catalogEntries(): DiscoverModel[] {
  const out: DiscoverModel[] = []
  for (const bundle of [...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles()]) {
    out.push(...bundle.files)
  }
  out.push(...getUncensoredTextModels(), ...getMainstreamTextModels())
  return out
}

/** Look up download URL + subfolder for a file by filename · searches all bundles + text models */
export function lookupFileMeta(filename: string): FileMeta | null {
  for (const m of catalogEntries()) {
    if (m.filename === filename && m.downloadUrl && m.subfolder) {
      return {
        url: m.downloadUrl,
        subfolder: m.subfolder,
        expectedBytes: m.sizeGB ? Math.round(m.sizeGB * GIB) : undefined,
        sha256: m.sha256,
      }
    }
  }
  return null
}

/** Every filename the catalog can name. Used to turn an orphaned partial's
 *  stem back into a real download id — see `orphanFilename`. */
export function catalogFilenames(): string[] {
  const names: string[] = []
  for (const m of catalogEntries()) if (m.filename) names.push(m.filename)
  return names
}

// ─── Image Model Bundles ───

export function getImageBundles(): ModelBundle[] {
  return [
    {
      name: 'Juggernaut XL V9 (Photorealistic)',
      description: 'Best photorealistic SDXL checkpoint. All in one. Just install and generate.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'sdxl',
      url: 'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9',
      files: [
        {
          name: 'Juggernaut XL V9 Photo v2',
          description: 'SDXL checkpoint · includes VAE and CLIP.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9/resolve/main/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
          filename: 'Juggernaut-XL_v9.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'RealVisXL V5 (Photorealistic)',
      description: 'Great for portraits, landscapes, and product photos. Ready to use.',
      tags: ['SDXL', 'Photorealistic', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'sdxl',
      url: 'https://huggingface.co/SG161222/RealVisXL_V5.0',
      files: [
        {
          name: 'RealVisXL V5 FP16',
          description: 'SDXL checkpoint · includes VAE and CLIP.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors',
          filename: 'RealVisXL_V5.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'FLUX.1 [schnell] FP8 (Fast & Modern)',
      description: 'State of the art image gen. 1 to 4 steps for fast results. Complete package with all required encoders.',
      tags: ['FLUX', 'Fast', 'FP8', '1024px'],
      verified: true,
      totalSizeGB: 21,
      vramRequired: '8-10 GB',
      workflow: 'flux',
      url: 'https://huggingface.co/Comfy-Org/flux1-schnell',
      files: [
        {
          name: 'FLUX.1 schnell FP8',
          description: 'The main FLUX diffusion model (quantized).',
          pulls: '', tags: ['Model', '16 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors',
          filename: 'flux1-schnell-fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 16.1,
        },
        {
          name: 'FLUX VAE',
          description: 'Required autoencoder for FLUX.1 (16 channel ae).',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'T5-XXL Text Encoder (FP8)',
          description: 'Required text encoder for FLUX prompt understanding.',
          pulls: '', tags: ['Text Encoder', '4.6 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
          filename: 't5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders', sizeGB: 4.6,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required secondary text encoder for FLUX.',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
      ],
    },
    {
      name: 'FLUX.1 [dev] FP8 (High Quality)',
      description: 'Highest quality FLUX. More steps but better results. Complete package with all required encoders.',
      tags: ['FLUX', 'Quality', 'FP8', '1024px'],
      verified: true,
      totalSizeGB: 21,
      vramRequired: '8-10 GB',
      workflow: 'flux',
      url: 'https://huggingface.co/Comfy-Org/flux1-dev',
      files: [
        {
          name: 'FLUX.1 dev FP8',
          description: 'The main FLUX diffusion model (dev, quantized).',
          pulls: '', tags: ['Model', '16 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors',
          filename: 'flux1-dev-fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 16.1,
        },
        {
          name: 'FLUX VAE',
          description: 'Required autoencoder for FLUX.1 (16 channel ae).',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'T5-XXL Text Encoder (FP8)',
          description: 'Required text encoder for FLUX prompt understanding.',
          pulls: '', tags: ['Text Encoder', '4.6 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
          filename: 't5xxl_fp8_e4m3fn.safetensors', subfolder: 'text_encoders', sizeGB: 4.6,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required secondary text encoder for FLUX.',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
      ],
    },
    {
      name: 'FLUX 2 Klein 4B (Next Gen)',
      description: 'Latest FLUX architecture. Fastest FLUX model with stunning quality. Includes Qwen 3 text encoder.',
      tags: ['FLUX 2', 'Fast', '1024px'],
      verified: true,
      totalSizeGB: 11.1,
      vramRequired: '8-10 GB',
      workflow: 'flux2',
      url: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b',
      files: [
        {
          name: 'FLUX 2 Klein Base 4B',
          description: 'FLUX 2 Klein diffusion model · next gen image generation.',
          pulls: '', tags: ['Diffusion Model', '7.2 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/diffusion_models/flux-2-klein-base-4b.safetensors',
          filename: 'flux-2-klein-base-4b.safetensors', subfolder: 'diffusion_models', sizeGB: 7.2,
        },
        {
          name: 'FLUX 2 VAE',
          description: 'Required autoencoder for FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'Qwen 3 4B Text Encoder (FP4)',
          description: 'Required text encoder for FLUX 2 Klein prompt understanding.',
          pulls: '', tags: ['Text Encoder', '~3.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files/text_encoders/qwen_3_4b_fp4_flux2.safetensors',
          filename: 'qwen_3_4b_fp4_flux2.safetensors', subfolder: 'text_encoders', sizeGB: 3.5,
        },
      ],
    },
    {
      name: 'Z-Image Turbo (Unfiltered, Fast)',
      description: 'Explicitly unfiltered image model. 8 to 15 seconds per image. No safety filters. Text to Image and Image to Image.',
      tags: ['Z-Image', 'Unfiltered', 'Fast', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 19.3,
      vramRequired: '10-16 GB',
      workflow: 'zimage',
      url: 'https://huggingface.co/Comfy-Org/z_image_turbo',
      files: [
        {
          name: 'Z-Image Turbo BF16',
          description: 'Unfiltered diffusion model · no safety filters, fast generation.',
          pulls: '', tags: ['Diffusion Model', '11.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
          filename: 'z_image_turbo_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 11.5,
        },
        {
          name: 'Z-Image VAE',
          description: 'Required autoencoder for Z-Image Turbo.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'Qwen 3 4B Text Encoder',
          description: 'Required text encoder for Z-Image Turbo prompt understanding.',
          pulls: '', tags: ['Text Encoder', '7.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
          filename: 'qwen_3_4b.safetensors', subfolder: 'text_encoders', sizeGB: 7.5,
        },
      ],
    },
    {
      name: 'Z-Image Base (Unfiltered, Quality)',
      description: 'Highest quality unfiltered model. 30 to 50 steps for maximum detail and composition diversity. Shares VAE/CLIP with Z-Image Turbo.',
      tags: ['Z-Image', 'Unfiltered', 'Quality', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 19.3,
      vramRequired: '10-16 GB',
      workflow: 'zimage',
      url: 'https://huggingface.co/Comfy-Org/z_image',
      files: [
        {
          name: 'Z-Image Base BF16',
          description: 'Unfiltered diffusion model · maximum quality, more compositional diversity.',
          pulls: '', tags: ['Diffusion Model', '11.5 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors',
          filename: 'z_image_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 11.5,
        },
        {
          name: 'Z-Image VAE',
          description: 'Required autoencoder · shared with Z-Image Turbo.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/vae/ae.safetensors',
          filename: 'ae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
        {
          name: 'Qwen 3 4B Text Encoder',
          description: 'Required text encoder · shared with Z-Image Turbo.',
          pulls: '', tags: ['Text Encoder', '7.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
          filename: 'qwen_3_4b.safetensors', subfolder: 'text_encoders', sizeGB: 7.5,
        },
      ],
    },
    {
      name: 'DreamShaper XL Turbo V2 (Anime/Stylized)',
      description: 'Fast anime and stylized art. Turbo mode for 4 step generation. Great for creative work.',
      tags: ['SDXL', 'Anime', 'Stylized', 'Turbo', '1024px'],
      uncensored: true,
      verified: true,
      totalSizeGB: 6.5,
      vramRequired: '6-8 GB',
      workflow: 'sdxl',
      url: 'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo',
      files: [
        {
          name: 'DreamShaper XL Turbo V2',
          description: 'SDXL checkpoint · anime and stylized art, turbo mode.',
          pulls: '', tags: ['Checkpoint', '6.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo/resolve/main/DreamShaperXL_Turbo_V2-SFW.safetensors',
          filename: 'DreamShaperXL_Turbo_V2.safetensors', subfolder: 'checkpoints', sizeGB: 6.5,
        },
      ],
    },
    {
      name: 'ERNIE-Image Turbo',
      description: 'Baidu ERNIE-Image Turbo · 8B DiT, 8 steps, 1024x1024. Fastest ERNIE variant with Ministral-3B encoder + Prompt Enhancer.',
      tags: ['ernie_image', 'Image', '1024x1024'],
      uncensored: false,
      verified: true,
      totalSizeGB: 28.9,
      vramRequired: '24 GB',
      workflow: 'ernie_image',
      url: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
      files: [
        {
          name: 'ERNIE-Image Turbo (DiT 8B)',
          description: 'Baidu ERNIE-Image Turbo diffusion model. 8 steps, fast inference.',
          pulls: '', tags: ['Diffusion Model', '15.0 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/diffusion_models/ernie-image-turbo.safetensors',
          filename: 'ernie-image-turbo.safetensors', subfolder: 'diffusion_models', sizeGB: 15.0,
        },
        {
          name: 'Ministral-3-3B Text Encoder',
          description: 'Main text encoder (Ministral-3B) for ERNIE-Image prompt understanding.',
          pulls: '', tags: ['Text Encoder', '7.2 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors',
          filename: 'ministral-3-3b.safetensors', subfolder: 'text_encoders', sizeGB: 7.2,
        },
        {
          name: 'ERNIE Prompt Enhancer',
          description: 'Optional prompt enhancer that expands short prompts into richer descriptions.',
          pulls: '', tags: ['Text Encoder', '6.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ernie-image-prompt-enhancer.safetensors',
          filename: 'ernie-image-prompt-enhancer.safetensors', subfolder: 'text_encoders', sizeGB: 6.4,
        },
        {
          name: 'FLUX 2 VAE',
          description: 'Required autoencoder · shared with FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
      ],
    },
    {
      name: 'ERNIE-Image Base',
      description: 'Baidu ERNIE-Image Base · 8B DiT, 50 steps, 1024x1024. Highest quality ERNIE variant.',
      tags: ['ernie_image', 'Image', '1024x1024'],
      uncensored: false,
      verified: true,
      totalSizeGB: 28.9,
      vramRequired: '24 GB',
      workflow: 'ernie_image',
      url: 'https://huggingface.co/Comfy-Org/ERNIE-Image',
      files: [
        {
          name: 'ERNIE-Image Base (DiT 8B)',
          description: 'Baidu ERNIE-Image Base diffusion model. 50 steps, highest quality.',
          pulls: '', tags: ['Diffusion Model', '15.0 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/diffusion_models/ernie-image.safetensors',
          filename: 'ernie-image.safetensors', subfolder: 'diffusion_models', sizeGB: 15.0,
        },
        {
          name: 'Ministral-3-3B Text Encoder',
          description: 'Main text encoder (Ministral-3B) for ERNIE-Image prompt understanding.',
          pulls: '', tags: ['Text Encoder', '7.2 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ministral-3-3b.safetensors',
          filename: 'ministral-3-3b.safetensors', subfolder: 'text_encoders', sizeGB: 7.2,
        },
        {
          name: 'ERNIE Prompt Enhancer',
          description: 'Optional prompt enhancer that expands short prompts into richer descriptions.',
          pulls: '', tags: ['Text Encoder', '6.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/text_encoders/ernie-image-prompt-enhancer.safetensors',
          filename: 'ernie-image-prompt-enhancer.safetensors', subfolder: 'text_encoders', sizeGB: 6.4,
        },
        {
          name: 'FLUX 2 VAE',
          description: 'Required autoencoder · shared with FLUX 2.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ERNIE-Image/resolve/main/vae/flux2-vae.safetensors',
          filename: 'flux2-vae.safetensors', subfolder: 'vae', sizeGB: 0.3,
        },
      ],
    },
    {
      name: 'SDXL VAE (fp16-fix) · addon',
      description: 'Standard SDXL VAE (madebyollin fp16-fix). Optional VAE override for any SDXL checkpoint; fixes washed out / desaturated output on some models. After download, pick it under Advanced → VAE.',
      tags: ['SDXL', 'VAE', 'Addon'],
      verified: true,
      totalSizeGB: 0.33,
      vramRequired: 'any',
      workflow: 'sdxl',
      url: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix',
      files: [
        {
          name: 'SDXL VAE fp16-fix',
          description: 'Drop in SDXL VAE → models/vae.',
          pulls: '', tags: ['VAE', '335 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors',
          filename: 'sdxl_vae.safetensors', subfolder: 'vae', sizeGB: 0.33,
        },
      ],
    },
    {
      name: 'Pixel Art XL · SDXL LoRA',
      description: 'nerijs Pixel Art XL · turns any SDXL model into crisp pixel art. A clearly visible style LoRA. After download, pick it under Advanced → LoRA and raise the strength.',
      tags: ['SDXL', 'LoRA', 'Style'],
      verified: true,
      totalSizeGB: 0.17,
      vramRequired: 'any',
      workflow: 'sdxl',
      url: 'https://huggingface.co/nerijs/pixel-art-xl',
      files: [
        {
          name: 'Pixel Art XL LoRA',
          description: 'SDXL pixel art style LoRA → models/loras.',
          pulls: '', tags: ['LoRA', '170 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/nerijs/pixel-art-xl/resolve/main/pixel-art-xl.safetensors',
          filename: 'pixel-art-xl.safetensors', subfolder: 'loras', sizeGB: 0.17,
        },
      ],
    },
  ]
}

// Flat list for backwards compat
export function getImageModelsDiscover(): DiscoverModel[] {
  const bundles = getImageBundles()
  const files: DiscoverModel[] = []
  for (const b of bundles) files.push(...b.files)
  const seen = new Set<string>()
  return files.filter(f => {
    if (!f.filename || seen.has(f.filename)) return false
    seen.add(f.filename)
    return true
  })
}

// ─── Video Model Bundles ───
// Each bundle contains ALL files needed for a working video workflow.
// "Install All" downloads model + VAE + CLIP together.

export interface CustomNodeDef {
  key: string
  repo: string
  name: string
}

export const CUSTOM_NODE_REGISTRY: Record<string, { repo: string; name: string; requiredNodes: string[] }> = {
  'animatediff-evolved': {
    repo: 'https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved',
    name: 'ComfyUI-AnimateDiff-Evolved',
    requiredNodes: ['ADE_LoadAnimateDiffModel', 'ADE_ApplyAnimateDiffModelSimple', 'ADE_UseEvolvedSampling'],
  },
  'cogvideox-wrapper': {
    repo: 'https://github.com/kijai/ComfyUI-CogVideoXWrapper',
    name: 'ComfyUI-CogVideoXWrapper',
    requiredNodes: ['CogVideoXModelLoader', 'CogVideoXCLIPLoader', 'CogVideoXTextEncode', 'CogVideoXEmptyLatents', 'CogVideoXSampler', 'CogVideoXVAEDecode'],
  },
  'framepack-wrapper': {
    repo: 'https://github.com/kijai/ComfyUI-FramePackWrapper',
    name: 'ComfyUI-FramePackWrapper',
    requiredNodes: ['LoadFramePackModel', 'FramePackSampler'],
  },
  'pyramidflow-wrapper': {
    repo: 'https://github.com/kijai/ComfyUI-PyramidFlowWrapper',
    name: 'ComfyUI-PyramidFlowWrapper',
    requiredNodes: ['PyramidFlowModelLoader', 'PyramidFlowVAELoader', 'PyramidFlowTextEncode', 'PyramidFlowSampler', 'PyramidFlowDecode'],
  },
  'allegro': {
    repo: 'https://github.com/bombax-xiaoice/ComfyUI-Allegro',
    name: 'ComfyUI-Allegro',
    requiredNodes: ['AllegroModelLoader', 'AllegroTextEncode', 'AllegroSampler', 'AllegroDecoder'],
  },
  // VHS_VideoCombine · the ONLY ComfyUI node that produces actual .mp4 video
  // output. Without it, the workflow falls back to SaveAnimatedWEBP which
  // makes "video generation" emit an animated .webp file. Two reporters
  // (miguelkodoatie on Discord 2026-05-14, Turbulent_Tomato7559 on Reddit
  // 2026-05-10) hit this on v2.4.3/2.4.4: t2i works, t2v "succeeds" but the
  // output is a .webp that no video player will open. v2.4.4 added a
  // warning banner; v2.4.5 makes it a one-click install instead.
  'videohelpersuite': {
    repo: 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
    name: 'ComfyUI-VideoHelperSuite',
    requiredNodes: ['VHS_VideoCombine', 'VHS_LoadVideo'],
  },
  // Background removal (Create → Remove Background). ComfyUI-RMBG registers the
  // `RMBG` node · the exact class the capability probe + workflow builder look
  // for · and auto-downloads its cutout model (BiRefNet / RMBG-2.0, ~300 MB)
  // into ComfyUI/models/RMBG on first use. So the one-click action only needs to
  // install the node; the model lands on the first cutout run.
  'rmbg': {
    repo: 'https://github.com/1038lab/ComfyUI-RMBG',
    name: 'ComfyUI-RMBG',
    requiredNodes: ['RMBG'],
  },
  // GGUF quant loader (city96). Lets the 2.5.8 lanes offer Q4 quants of the
  // 14B Wan models (S2V / Animate / NSFW finetunes) — the difference between
  // "needs 16 GB on disk and heavy offload" and "runs comfortably on 12 GB".
  // requirements.txt is just the gguf package, no exotic wheels.
  'gguf': {
    repo: 'https://github.com/city96/ComfyUI-GGUF',
    name: 'ComfyUI-GGUF',
    requiredNodes: ['UnetLoaderGGUF'],
  },
  // Pose extraction for the local Motion Control lane (DWPose skeletons feed
  // WanAnimateToVideo / WanVaceToVideo). Its requirements pull the CPU
  // onnxruntime wheel — works on every Windows box, no GPU wheel roulette;
  // the DWPose onnx models auto-download on first run.
  'controlnet-aux': {
    repo: 'https://github.com/Fannovel16/comfyui_controlnet_aux',
    name: 'comfyui_controlnet_aux',
    requiredNodes: ['DWPreprocessor'],
  },
}

export interface ModelBundle {
  name: string
  description: string
  tags: string[]
  totalSizeGB: number
  vramRequired: string
  workflow: string
  files: DiscoverModel[]
  url?: string
  hot?: boolean
  uncensored?: boolean
  customNodes?: string[]  // keys into CUSTOM_NODE_REGISTRY
  i2v?: boolean           // Image-to-Video model
  verified?: boolean      // E2E tested and confirmed working
}

export function getVideoBundles(): ModelBundle[] {
  return [
    {
      name: 'Wan 2.1 · 1.3B (Lightweight)',
      description: 'Best for 8 to 10 GB VRAM GPUs. Generates 480p video. Fast and lightweight.',
      tags: ['Wan 2.1', '480p', 'Fast'],
      uncensored: true,
      verified: true,
      totalSizeGB: 9.2,
      vramRequired: '8-10 GB',
      workflow: 'wan',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
      files: [
        {
          name: 'Wan 2.1 T2V 1.3B Model',
          description: 'The main video generation model.',
          pulls: '', tags: ['Model', '2.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_bf16.safetensors',
          filename: 'wan2.1_t2v_1.3B_bf16.safetensors', subfolder: 'diffusion_models', sizeGB: 2.5,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '200 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.2,
        },
        {
          name: 'Wan 2.1 CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '4.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.3,
        },
      ],
    },
    {
      name: 'Wan 2.1 · 14B FP8 (High Quality)',
      description: 'Best quality for 12+ GB VRAM. Generates up to 720p. Slower but much better results.',
      tags: ['Wan 2.1', '720p', 'Quality'],
      uncensored: true,
      verified: true,
      totalSizeGB: 20.5,
      vramRequired: '12+ GB',
      workflow: 'wan',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
      files: [
        {
          name: 'Wan 2.1 T2V 14B (FP8)',
          description: 'The main video generation model (quantized).',
          pulls: '', tags: ['Model', '14 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_14B_fp8_e4m3fn.safetensors',
          filename: 'wan2.1_t2v_14B_fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 14.0,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '200 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.2,
        },
        {
          name: 'Wan 2.1 CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '4.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.3,
        },
      ],
    },
    {
      name: 'Wan 2.2 · TI2V 5B (Image + Text to Video)',
      description: 'Wan 2.2 TI2V-5B · ONE model for both text to video and faithful image to video (the clip opens on your source image). Native 1280×704 @ 24 fps, smooth 2 to 7 s clips. The best quality video model that fits 12 GB.',
      tags: ['Wan 2.2', '720p', 'I2V', 'T2V', 'Quality'],
      uncensored: true,
      verified: true,
      i2v: true,
      hot: true,
      totalSizeGB: 16.9,
      vramRequired: '12+ GB',
      workflow: 'wan22',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged',
      files: [
        {
          name: 'Wan 2.2 TI2V 5B Model (FP16)',
          description: 'The unified text + image to video model.',
          pulls: '', tags: ['Model', '~9.3 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
          filename: 'wan2.2_ti2v_5B_fp16.safetensors', subfolder: 'diffusion_models', sizeGB: 9.3,
        },
        {
          name: 'Wan 2.2 VAE',
          description: 'Required video encoder/decoder · the 2.2 VAE (NOT the 2.1 VAE: higher compression, different latent shape).',
          pulls: '', tags: ['VAE', '~1.3 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors',
          filename: 'wan2.2_vae.safetensors', subfolder: 'vae', sizeGB: 1.3,
        },
        {
          name: 'Wan CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder · shared with Wan 2.1, so it is skipped if already installed.',
          pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.3,
        },
      ],
    },
    {
      name: 'HunyuanVideo 1.5 T2V FP8 (High Quality)',
      description: 'Tencent HunyuanVideo 1.5 · excellent temporal consistency and visual quality. 480p text to video with CFG distillation.',
      tags: ['HunyuanVideo 1.5', '480p', 'Quality'],
      uncensored: true,
      verified: true,
      totalSizeGB: 18.8,
      vramRequired: '12+ GB',
      workflow: 'hunyuan',
      url: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged',
      files: [
        {
          name: 'HunyuanVideo 1.5 T2V FP8',
          description: 'The main video generation model (480p, CFG distilled, quantized).',
          pulls: '', tags: ['Model', '7.8 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/diffusion_models/hunyuanvideo1.5_480p_t2v_cfg_distilled_fp8_scaled.safetensors',
          filename: 'hunyuanvideo1.5_480p_t2v_fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 7.8,
        },
        {
          name: 'HunyuanVideo 1.5 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '2.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/vae/hunyuanvideo15_vae_fp16.safetensors',
          filename: 'hunyuanvideo15_vae_fp16.safetensors', subfolder: 'vae', sizeGB: 2.3,
        },
        {
          name: 'Qwen 2.5 VL 7B Text Encoder (FP8)',
          description: 'Required text encoder for HunyuanVideo 1.5.',
          pulls: '', tags: ['Text Encoder', '8.8 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
          filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 8.8,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required secondary text encoder.',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
      ],
    },
    {
      name: 'LTX Video 2.3 · 22B FP8 (Latest)',
      description: 'Lightricks LTX Video 2.3 · fast inference, high quality. Uses Gemma 3 12B text encoder. Distilled for speed.',
      tags: ['LTX 2.3', '22B', 'Quality'],
      verified: true,
      totalSizeGB: 40,
      vramRequired: '16+ GB',
      workflow: 'ltx',
      url: 'https://huggingface.co/Lightricks/LTX-2.3-fp8',
      files: [
        {
          name: 'LTX 2.3 22B Distilled FP8',
          description: 'Main video model · distilled for fast inference.',
          pulls: '', tags: ['Model', '~22 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors',
          filename: 'ltx-2.3-22b-distilled-fp8.safetensors', subfolder: 'diffusion_models', sizeGB: 27.5,
        },
        {
          name: 'Gemma 3 12B Text Encoder (FP8)',
          description: 'Required text encoder for LTX Video 2.x.',
          pulls: '', tags: ['Text Encoder', '12.4 GB'], updated: 'New',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp8_scaled.safetensors',
          filename: 'gemma_3_12B_it_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 12.4,
        },
      ],
    },
    // ─── NEW VIDEO BUNDLES ───
    {
      name: 'AnimateDiff Lightning',
      description: 'Ultra fast 4 step animation on any SD1.5 checkpoint. Great for quick iterations. Needs an SD1.5 base model.',
      tags: ['AnimateDiff', '512x512', 'Lightning'],
      verified: true,
      totalSizeGB: 2.8,
      vramRequired: '6-8 GB',
      workflow: 'animatediff',
      customNodes: ['animatediff-evolved'],
      url: 'https://huggingface.co/ByteDance/AnimateDiff-Lightning',
      files: [
        {
          name: 'AnimateDiff Lightning Motion Model (4 step)',
          description: 'Lightning fast motion model. Only 4 sampling steps needed.',
          pulls: '', tags: ['Motion', '800 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/ByteDance/AnimateDiff-Lightning/resolve/main/animatediff_lightning_4step_comfyui.safetensors',
          filename: 'animatediff_lightning_4step_comfyui.safetensors', subfolder: 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models', sizeGB: 0.8,
        },
        {
          name: 'Realistic Vision V6 (SD1.5 Base)',
          description: 'Recommended SD1.5 base checkpoint for realistic animations.',
          pulls: '', tags: ['Checkpoint', '~2 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/Realistic_Vision_V6.0_B1_noVAE/resolve/main/Realistic_Vision_V6.0_NV_B1_fp16.safetensors',
          filename: 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors', subfolder: 'checkpoints', sizeGB: 2.0,
        },
      ],
    },
    {
      name: 'AnimateDiff v3',
      description: 'Classic AnimateDiff with more frames and better quality than Lightning. Slower but more detailed.',
      tags: ['AnimateDiff', '512x768', 'Quality'],
      totalSizeGB: 3.6,
      vramRequired: '6-8 GB',
      workflow: 'animatediff',
      customNodes: ['animatediff-evolved'],
      url: 'https://huggingface.co/guoyww/animatediff',
      files: [
        {
          name: 'AnimateDiff v3 Motion Adapter',
          description: 'Standard motion model · 20 steps, good quality.',
          pulls: '', tags: ['Motion', '1.6 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/guoyww/animatediff/resolve/main/v3_sd15_mm.ckpt',
          filename: 'v3_sd15_mm.ckpt', subfolder: 'custom_nodes/ComfyUI-AnimateDiff-Evolved/models', sizeGB: 1.6,
        },
        {
          name: 'Realistic Vision V6 (SD1.5 Base)',
          description: 'Recommended SD1.5 base checkpoint.',
          pulls: '', tags: ['Checkpoint', '~2 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/SG161222/Realistic_Vision_V6.0_B1_noVAE/resolve/main/Realistic_Vision_V6.0_NV_B1_fp16.safetensors',
          filename: 'Realistic_Vision_V6.0_NV_B1_fp16.safetensors', subfolder: 'checkpoints', sizeGB: 2.0,
        },
      ],
    },
    // CogVideoX removed 2026-07-24 (D#88) · both bundles were 21 GB of download
    // for a lane that could never run. buildCogVideoWorkflow emits five class
    // types that exist in no version of kijai/ComfyUI-CogVideoXWrapper
    // (CogVideoXCLIPLoader, CogVideoXTextEncode, CogVideoXEmptyLatents,
    // CogVideoXSampler, CogVideoXVAEDecode · the real names are CogVideoTextEncode,
    // CogVideoSampler, CogVideoDecode and there is no empty latents node at all),
    // so every submit came back a 400. Verified against a real checkout of the
    // wrapper. Offering the download again needs a rebuilt builder plus a real
    // end to end run, not a rename. Wan, LTX and SVD cover the same ground and
    // are proven.
    {
      name: 'FramePack F1 (Image to Video)',
      description: 'Revolutionary I2V: runs on 6 GB VRAM via next frame prediction. Upload an image, get a video. Uses HunyuanVideo backbone.',
      tags: ['FramePack', 'I2V', 'Low VRAM'],
      uncensored: true,
      verified: true,
      totalSizeGB: 27.0,
      vramRequired: '6-8 GB',
      workflow: 'framepack',
      i2v: true,
      customNodes: ['framepack-wrapper'],
      url: 'https://huggingface.co/lllyasviel/FramePack_F1_I2V_HY_20250503',
      files: [
        {
          name: 'FramePack F1 I2V Model (FP8)',
          description: 'Main I2V model · generates video from a single image.',
          pulls: '', tags: ['Model', '15.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Kijai/HunyuanVideo_comfy/resolve/main/FramePackI2V_HY_fp8_e4m3fn.safetensors',
          filename: 'FramePackI2V_HY_fp8_e4m3fn.safetensors', subfolder: 'diffusion_models', sizeGB: 15.3,
        },
        {
          name: 'SigCLIP Vision Encoder',
          description: 'Required vision encoder for image understanding.',
          pulls: '', tags: ['CLIP Vision', '900 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/sigclip_vision_384/resolve/main/sigclip_vision_patch14_384.safetensors',
          filename: 'sigclip_vision_patch14_384.safetensors', subfolder: 'clip_vision', sizeGB: 0.9,
        },
        {
          name: 'HunyuanVideo VAE',
          description: 'Required video encoder/decoder (HunyuanVideo 1.0, the backbone FramePack was trained on).',
          pulls: '', tags: ['VAE', '493 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/vae/hunyuan_video_vae_bf16.safetensors',
          filename: 'hunyuan_video_vae_bf16.safetensors', subfolder: 'vae', sizeGB: 0.5,
        },
        {
          name: 'CLIP-L Text Encoder',
          description: 'Required text encoder (shared).',
          pulls: '', tags: ['Text Encoder', '240 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/clip_l.safetensors',
          filename: 'clip_l.safetensors', subfolder: 'text_encoders', sizeGB: 0.2,
        },
        {
          name: 'LLaVA LLaMA3 Text Encoder (FP8)',
          description: 'Required text encoder for FramePack.',
          pulls: '', tags: ['Text Encoder', '8.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/resolve/main/split_files/text_encoders/llava_llama3_fp8_scaled.safetensors',
          filename: 'llava_llama3_fp8_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 8.5,
        },
      ],
    },
    {
      name: 'SVD-XT 1.1 (Image to Video)',
      description: 'Stable Video Diffusion by Stability AI. Upload an image, get 25 frames of smooth video. Native ComfyUI support.',
      tags: ['SVD', 'I2V', 'Native'],
      verified: true,
      totalSizeGB: 4.8,
      vramRequired: '12+ GB',
      workflow: 'svd',
      i2v: true,
      url: 'https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt-1-1',
      files: [
        {
          name: 'SVD-XT 1.1 Checkpoint',
          description: 'Complete I2V model · no additional downloads needed.',
          pulls: '', tags: ['Checkpoint', '4.8 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/vdo/stable-video-diffusion-img2vid-xt-1-1/resolve/main/svd_xt_1_1.safetensors',
          filename: 'svd_xt_1_1.safetensors', subfolder: 'checkpoints', sizeGB: 4.8,
        },
      ],
    },
    {
      name: 'Mochi 1 Preview (FP8)',
      description: 'Genmo Mochi · 848x480 video at 24 FPS. Good motion and temporal consistency. Native ComfyUI support.',
      tags: ['Mochi', '848x480', 'Native'],
      totalSizeGB: 20.4,
      vramRequired: '16+ GB',
      workflow: 'mochi',
      url: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged',
      files: [
        {
          name: 'Mochi 1 Preview (FP8)',
          description: 'Main video model (quantized for lower VRAM).',
          pulls: '', tags: ['Model', '10 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/diffusion_models/mochi_preview_fp8_scaled.safetensors',
          filename: 'mochi_preview_fp8_scaled.safetensors', subfolder: 'diffusion_models', sizeGB: 10,
        },
        {
          name: 'Mochi VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '0.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/vae/mochi_vae.safetensors',
          filename: 'mochi_vae.safetensors', subfolder: 'vae', sizeGB: 0.9,
        },
        {
          name: 'T5-XXL Text Encoder (FP16)',
          description: 'Required text encoder for Mochi.',
          pulls: '', tags: ['Text Encoder', '9.5 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp16.safetensors',
          filename: 't5xxl_fp16.safetensors', subfolder: 'text_encoders', sizeGB: 9.5,
        },
      ],
    },
    // Pyramid Flow removed 2026-07-24 (same audit as CogVideoX) · the builder was
    // written against invented node names too. Checked against a real checkout of
    // kijai/ComfyUI-PyramidFlowWrapper: the loader is registered as
    // PyramidFlowTransformerLoader (not PyramidFlowModelLoader), decode is
    // PyramidFlowVAEDecode (not PyramidFlowDecode) and needs a vae input we never
    // wired, the text encoder takes clip + positive_prompt + negative_prompt (we
    // passed a single `text` and no CLIP at all), and the sampler wants
    // prompt_embeds plus per stage step strings rather than steps and frames. That
    // is a rewrite, not a rename, so the 4.6 GB download comes back only with a
    // real run behind it.
    // Allegro removed · diffusers format only, no single-file safetensors available for one-click install
    {
      name: 'NVIDIA Cosmos 7B',
      description: 'NVIDIA Cosmos Diffusion 7B Text to World. 1024x1024 output at 24 FPS. Native ComfyUI support. Uses oldt5 text encoder (NOT t5xxl).',
      tags: ['Cosmos', '1024x1024', 'NVIDIA'],
      totalSizeGB: 19.2,
      vramRequired: '24+ GB',
      workflow: 'cosmos',
      url: 'https://huggingface.co/mcmonkey/cosmos-1.0',
      files: [
        {
          name: 'Cosmos 7B Text2World',
          description: 'Main video generation model by NVIDIA.',
          pulls: '', tags: ['Model', '14 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/mcmonkey/cosmos-1.0/resolve/main/Cosmos-1_0-Diffusion-7B-Text2World.safetensors',
          filename: 'Cosmos-1_0-Diffusion-7B-Text2World.safetensors', subfolder: 'diffusion_models', sizeGB: 14,
        },
        {
          name: 'OldT5-XXL Text Encoder (FP8)',
          description: 'Required text encoder · NOT the same as regular T5-XXL!',
          pulls: '', tags: ['Text Encoder', '4.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/text_encoders/oldt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'oldt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 4.9,
        },
        {
          name: 'Cosmos VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '300 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/resolve/main/vae/cosmos_cv8x8x8_1.0.safetensors',
          filename: 'cosmos_cv8x8x8_1.0.safetensors', subfolder: 'vae', sizeGB: 0.2,
        },
      ],
    },
    {
      name: 'NSFW Wan 14B (Uncensored, GGUF)',
      description: 'Full uncensored finetune of Wan 2.1 14B. Text to video, motion trained in, no helper LoRA needed.',
      tags: ['Wan 2.1', 'Uncensored', 'GGUF', '480p'],
      uncensored: true,
      totalSizeGB: 15.5,
      vramRequired: '10-12 GB',
      workflow: 'wan',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/NSFW-API/NSFW_Wan_14b',
      files: [
        {
          name: 'NSFW Wan 14B Q4 (GGUF)',
          description: 'The finetuned video model, final e15 epoch, Q4 quant.',
          pulls: '', tags: ['Model', '9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/NSFW-API/NSFW_Wan_14b/resolve/main/nsfw_wan_14b_e15_q4_k.gguf',
          filename: 'nsfw_wan_14b_e15_q4_k.gguf', subfolder: 'diffusion_models', sizeGB: 9.0,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '250 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
        },
        {
          name: 'Wan CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
        },
      ],
    },
    {
      name: 'Wan 2.2 Rapid AIO (Uncensored I2V, GGUF)',
      description: 'Uncensored Wan 2.2 image to video, lightning merged for few step renders. Great for Animate and Extend.',
      tags: ['Wan 2.2', 'Uncensored', 'I2V', 'GGUF', 'Fast'],
      uncensored: true,
      i2v: true,
      totalSizeGB: 16.6,
      vramRequired: '10-12 GB',
      workflow: 'wan',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/desirel/WAN2.2-14B-Rapid-AllInOne-GGUF-NSFW-v10',
      files: [
        {
          name: 'Wan 2.2 Rapid AIO v10 Q4 (GGUF)',
          description: 'The merged uncensored i2v model, Q4 quant.',
          pulls: '', tags: ['Model', '10.1 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/desirel/WAN2.2-14B-Rapid-AllInOne-GGUF-NSFW-v10/resolve/main/wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf',
          filename: 'wan2.2-i2v-rapid-aio-v10-nsfw-Q4_K_M.gguf', subfolder: 'diffusion_models', sizeGB: 10.1,
        },
        {
          name: 'Wan 2.1 VAE',
          description: 'Required video encoder/decoder.',
          pulls: '', tags: ['VAE', '250 MB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
          filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
        },
        {
          name: 'Wan CLIP (UMT5-XXL FP8)',
          description: 'Required text encoder.',
          pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
        },
      ],
    },
  ]
}

// ─── 2.5.8 specialized local-lane bundles (music / talking character / motion) ───
//
// Every URL below was HEAD-verified against HuggingFace on 2026-07-18 (status
// 200 + content-length; sizes in GiB from the actual response). Music and
// talking character have no censored/uncensored axis — local rendering runs
// unfiltered by nature, so no red badge games; the honest split lives in the
// video list above (real uncensored finetunes) instead.

export function getAudioBundles(): ModelBundle[] {
  return [
    {
      name: 'ACE Step 1.5 Turbo (Music)',
      description: 'Newest full song generator, MIT licensed. Vocals, lyrics and instruments from a text description. One file.',
      tags: ['Music', 'Vocals', 'MIT'],
      totalSizeGB: 9.4,
      vramRequired: '6-8 GB',
      workflow: 'ace',
      url: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files',
      files: [
        {
          name: 'ACE Step 1.5 Turbo (all in one)',
          description: 'Complete music model. Includes its text encoder and audio VAE.',
          pulls: '', tags: ['Checkpoint', '9.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/checkpoints/ace_step_1.5_turbo_aio.safetensors',
          filename: 'ace_step_1.5_turbo_aio.safetensors', subfolder: 'checkpoints', sizeGB: 9.34,
        },
      ],
    },
    {
      name: 'ACE Step v1 3.5B (Music, lighter)',
      description: 'The proven full song generator. Smaller download, runs from 4 GB VRAM.',
      tags: ['Music', 'Vocals', 'Light'],
      totalSizeGB: 7.2,
      vramRequired: '4-6 GB',
      workflow: 'ace',
      url: 'https://huggingface.co/Comfy-Org/ACE-Step_ComfyUI_repackaged',
      files: [
        {
          name: 'ACE Step v1 3.5B (all in one)',
          description: 'Complete music model. Includes its text encoder and audio VAE.',
          pulls: '', tags: ['Checkpoint', '7.2 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/ACE-Step_ComfyUI_repackaged/resolve/main/all_in_one/ace_step_v1_3.5b.safetensors',
          filename: 'ace_step_v1_3.5b.safetensors', subfolder: 'checkpoints', sizeGB: 7.17,
        },
      ],
    },
  ]
}

export function getLipsyncBundles(): ModelBundle[] {
  // Shared support files for the S2V graph (text encoder, VAE, audio encoder).
  const s2vSupport: DiscoverModel[] = [
    {
      name: 'Wan CLIP (UMT5-XXL FP8)',
      description: 'Required text encoder.',
      pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
    },
    {
      name: 'Wan 2.1 VAE',
      description: 'Required video encoder/decoder.',
      pulls: '', tags: ['VAE', '250 MB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
      filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
    },
    {
      name: 'Wav2Vec2 Audio Encoder',
      description: 'Turns the speech audio into the embeddings the model lip reads from.',
      pulls: '', tags: ['Audio Encoder', '600 MB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/audio_encoders/wav2vec2_large_english_fp16.safetensors',
      filename: 'wav2vec2_large_english_fp16.safetensors', subfolder: 'audio_encoders', sizeGB: 0.59,
    },
  ]
  return [
    {
      name: 'Wan 2.2 S2V Q4 (Talking Character, GGUF)',
      description: 'A portrait plus any voice becomes a talking video. Q4 quant, the comfortable pick for 12 GB cards.',
      tags: ['Wan 2.2', 'S2V', 'GGUF'],
      totalSizeGB: 20.0,
      vramRequired: '10-12 GB',
      workflow: 'wans2v',
      customNodes: ['gguf'],
      url: 'https://huggingface.co/QuantStack/Wan2.2-S2V-14B-GGUF',
      files: [
        {
          name: 'Wan 2.2 S2V 14B Q4 (GGUF)',
          description: 'The sound to video model, Q4 quant.',
          pulls: '', tags: ['Model', '12.9 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/QuantStack/Wan2.2-S2V-14B-GGUF/resolve/main/Wan2.2-S2V-14B-Q4_K_M.gguf',
          filename: 'Wan2.2-S2V-14B-Q4_K_M.gguf', subfolder: 'diffusion_models', sizeGB: 12.91,
        },
        ...s2vSupport,
      ],
    },
    {
      name: 'Wan 2.2 S2V FP8 (Talking Character)',
      description: 'The full precision friendly variant. Bigger file; offloads below 16 GB VRAM, so renders take longer there.',
      tags: ['Wan 2.2', 'S2V', 'FP8'],
      totalSizeGB: 22.4,
      vramRequired: '16 GB best, offloads on less',
      workflow: 'wans2v',
      url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged',
      files: [
        {
          name: 'Wan 2.2 S2V 14B (FP8)',
          description: 'The sound to video model.',
          pulls: '', tags: ['Model', '15.3 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors',
          filename: 'wan2.2_s2v_14B_fp8_scaled.safetensors', subfolder: 'diffusion_models', sizeGB: 15.27,
        },
        ...s2vSupport,
      ],
    },
  ]
}

export function getMotionBundles(): ModelBundle[] {
  const wanSupport: DiscoverModel[] = [
    {
      name: 'Wan CLIP (UMT5-XXL FP8)',
      description: 'Required text encoder.',
      pulls: '', tags: ['CLIP', '6.3 GB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      filename: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', subfolder: 'text_encoders', sizeGB: 6.27,
    },
    {
      name: 'Wan 2.1 VAE',
      description: 'Required video encoder/decoder.',
      pulls: '', tags: ['VAE', '250 MB'], updated: '',
      downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors',
      filename: 'wan_2.1_vae.safetensors', subfolder: 'vae', sizeGB: 0.24,
    },
  ]
  return [
    {
      name: 'Wan VACE 1.3B (Motion Control, light)',
      description: 'Your character copies the moves from any dance or pose video. The light pick, runs from 8 GB VRAM.',
      tags: ['VACE', 'Motion', 'Light'],
      totalSizeGB: 10.5,
      vramRequired: '8-10 GB',
      workflow: 'wanvace',
      customNodes: ['controlnet-aux'],
      url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
      files: [
        {
          name: 'Wan 2.1 VACE 1.3B',
          description: 'The motion control model.',
          pulls: '', tags: ['Model', '4 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_vace_1.3B_fp16.safetensors',
          filename: 'wan2.1_vace_1.3B_fp16.safetensors', subfolder: 'diffusion_models', sizeGB: 4.01,
        },
        ...wanSupport,
      ],
    },
    {
      name: 'Wan 2.2 Animate Q4 (Motion Control, GGUF)',
      description: 'The bigger, better motion transfer model. Q4 quant for 12 GB cards.',
      tags: ['Wan 2.2', 'Animate', 'GGUF'],
      totalSizeGB: 17.3,
      vramRequired: '10-12 GB',
      workflow: 'wananimate',
      customNodes: ['gguf', 'controlnet-aux'],
      url: 'https://huggingface.co/QuantStack/Wan2.2-Animate-14B-GGUF',
      files: [
        {
          name: 'Wan 2.2 Animate 14B Q4 (GGUF)',
          description: 'The motion transfer model, Q4 quant.',
          pulls: '', tags: ['Model', '10.7 GB'], updated: '',
          downloadUrl: 'https://huggingface.co/QuantStack/Wan2.2-Animate-14B-GGUF/resolve/main/Wan2.2-Animate-14B-Q4_K_M.gguf',
          filename: 'Wan2.2-Animate-14B-Q4_K_M.gguf', subfolder: 'diffusion_models', sizeGB: 10.71,
        },
        ...wanSupport,
      ],
    },
  ]
}

// ─── CivitAI Model Search ───

export interface CivitAIModelResult {
  id: number
  name: string
  description: string
  type: string
  thumbnailUrl?: string
  downloadUrl?: string
  filename?: string
  subfolder?: string
  sizeGB?: number
  stats?: { downloads: number; likes: number }
  creator?: string
  sourceUrl: string
}

export const CIVITAI_DEFAULT_HOST = 'civitai.com'

/**
 * Rewrite a civitai.com absolute URL to the chosen mirror host (GitHub #53).
 * The CivitAI API returns absolute civitai.com download/source URLs even when
 * it is queried through a mirror, so without this the actual file download
 * still hits the blocked origin for users on civitai.red. No-op on the default
 * host. Exported + pure for unit tests.
 */
export function civitaiHostSwap(url: string | undefined, host: string): string | undefined {
  if (!url || !host || host === CIVITAI_DEFAULT_HOST) return url
  return url.replace(/^(https?:\/\/)civitai\.com/i, `$1${host}`)
}

export async function searchCivitaiModels(
  query: string,
  type: 'Checkpoint' | 'LORA' | 'VAE' | 'TextualInversion' = 'Checkpoint',
  apiKey?: string,
  host: string = CIVITAI_DEFAULT_HOST
): Promise<CivitAIModelResult[]> {
  try {
    const params = new URLSearchParams({
      query,
      types: type,
      limit: '20',
      sort: 'Most Downloaded',
      // LU positions itself as "uncensored" · surface adult content too. Without
      // an explicit nsfw flag CivitAI silently filters most of the SFW catalog
      // for an unauthenticated client, which is what made earlier searches come
      // back near-empty for users who expected to find e.g. unfiltered SDXL forks.
      nsfw: 'true',
    })
    // Adding the user's API key as a bearer token unlocks the full catalog and
    // lifts the per-IP rate limit. Falls back to anon access if no key is set.
    const url = `https://${host}/api/v1/models?${params}${apiKey ? `&token=${encodeURIComponent(apiKey)}` : ''}`
    const text = await fetchExternal(url)
    const data = JSON.parse(text)
    const items: any[] = data.items ?? []

    return items.map((item) => {
      const version = item.modelVersions?.[0]
      const file = version?.files?.[0]
      const thumb = version?.images?.[0]?.url
      const downloadUrl = version?.downloadUrl ?? file?.downloadUrl
      const sizeKB = file?.sizeKB ?? 0

      // Determine subfolder based on model type
      let subfolder = 'checkpoints'
      if (type === 'LORA') subfolder = 'loras'
      else if (type === 'VAE') subfolder = 'vae'
      else if (type === 'TextualInversion') subfolder = 'embeddings'
      // Check if it's a diffusion model (FLUX, Wan, etc.)
      const name = item.name?.toLowerCase() || ''
      if (name.includes('flux') || name.includes('wan') || name.includes('hunyuan')) {
        subfolder = 'diffusion_models'
      }

      const filename = file?.name || `${item.name?.replace(/[^a-zA-Z0-9._-]/g, '_')}.safetensors`

      const descParts: string[] = []
      const rawDesc = (item.description ?? '').replace(/<[^>]*>/g, '').trim()
      if (rawDesc) descParts.push(rawDesc.slice(0, 120))
      if (item.stats?.downloadCount) descParts.push(`${item.stats.downloadCount.toLocaleString()} downloads`)
      if (item.creator?.username) descParts.push(`by ${item.creator.username}`)

      return {
        id: item.id,
        name: item.name || `Model #${item.id}`,
        description: descParts.join(' · '),
        type: type,
        thumbnailUrl: thumb,
        downloadUrl: civitaiHostSwap(downloadUrl, host),
        filename,
        subfolder,
        sizeGB: sizeKB > 0 ? Math.round(sizeKB / 1024 / 1024 * 10) / 10 : undefined,
        stats: item.stats ? { downloads: item.stats.downloadCount || 0, likes: item.stats.thumbsUpCount || 0 } : undefined,
        creator: item.creator?.username,
        sourceUrl: `https://${host}/models/${item.id}`,
      }
    })
  } catch (err) {
    log.warn('[discover] CivitAI model search failed', { err })
    return []
  }
}

// Flat list for backwards compatibility (individual files)
export function getVideoModelsDiscover(): DiscoverModel[] {
  const bundles = getVideoBundles()
  const files: DiscoverModel[] = []
  for (const b of bundles) {
    files.push(...b.files)
  }
  // Deduplicate by filename
  const seen = new Set<string>()
  return files.filter(f => {
    if (!f.filename || seen.has(f.filename)) return false
    seen.add(f.filename)
    return true
  })
}
