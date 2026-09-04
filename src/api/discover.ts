import { backendCall, fetchExternal } from "./backend"
import { getCheckpoints, getDiffusionModels, getVAEModels, getCLIPModels, getGgufUnetModels, getAnimateDiffModels, getLoraModels, filterPartialFiles, refreshComfyModels } from "./comfyui"
import { clearNodeCache } from "./comfyui-nodes"
import { restartComfyForNewNodes } from "./comfy-restart"
import type { ProviderId } from "./providers/types"
import { log } from "../lib/logger"
import { useWorkflowStore } from "../stores/workflowStore"
import { waitForModelsVisible } from "../lib/bundle-install"
import type { DownloadProgress } from "../types/downloads"
import { asNumber, asRecordArray, asString, isRecord, prop, propPath } from "../types/json-guards"
import type { DiscoverModel, ModelBundle } from "./model-bundles"
import { formatCount } from '../lib/formatters'
import { BUILTIN_BACKEND_ID } from '../lib/onboarding-backend'
import { customModelDirs } from './engine'
import {
  CUSTOM_NODE_REGISTRY,
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles,
} from "./model-bundles"

// Katalog + Formen liegen in model-bundles.ts (siehe dort). Re-Export, damit
// bestehende Importpfade unverändert bleiben.
export type { DiscoverModel, ModelBundle, CustomNodeDef } from './model-bundles'
export {
  CUSTOM_NODE_REGISTRY,
  getImageBundles, getImageModelsDiscover, getVideoBundles,
  getAudioBundles, getLipsyncBundles, getMotionBundles,
} from './model-bundles'

// Die Fortschrittsform lebt in types/downloads.ts, damit lib/bundle-install.ts
// sie lesen kann, ohne dieses Modul zu importieren. Re-Export, damit bestehende
// Importpfade unverändert bleiben.
export type { DownloadProgress }

// ─── Download API ───

/**
 * Is this URL served by CivitAI? Host comparison, never a substring of the
 * whole URL: `https://evil.test/?x=civitai.com` must not collect the user's
 * API key. Mirrors `is_civitai_host` in `src-tauri/src/commands/download.rs`,
 * which gates the same key a second time on its way onto the wire.
 */
const CIVITAI_HOSTS = ['civitai.com', 'civitai.red']

export function isCivitaiUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return CIVITAI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * The user's CivitAI API key, for a CivitAI URL and no other.
 *
 * goonerforporn (Discord #bug-reports, 2026-08-28): downloads from the CivitAI
 * search died in 400s because they went out anonymous. The key was in the store
 * and read by the search, and by nothing on the download path.
 */
export function civitaiAuthToken(url: string): string | null {
  if (!isCivitaiUrl(url)) return null
  const key = useWorkflowStore.getState().civitaiApiKey?.trim()
  return key ? key : null
}

export async function startModelDownload(url: string, subfolder: string, filename: string, expectedBytes?: number, sha256?: string): Promise<{ status: string; id: string; error?: string }> {
  return backendCall("download_model", {
    url,
    subfolder,
    filename,
    expectedBytes: expectedBytes ?? null,
    expectedSha256: sha256 ?? null,
    authToken: civitaiAuthToken(url),
  })
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

/**
 * The four answers that mean the ADDRESS is dead rather than the connection:
 * gone (404/410) and gated-or-private (401/403). Everything else — a transport
 * error, a rate limit, a 5xx — is the host having a bad minute and stays
 * retryable.
 *
 * ONE list, read from two directions. `isPermanentDownloadError` reads it out
 * of the message a failed download carries back from Rust; `classifyAddressProbe`
 * (below, used by the catalog gate) reads it out of a bare HTTP status. Two
 * hand-written copies of "what counts as broken" would be two chances to
 * disagree, and the disagreement would be silent: the gate would pass an
 * address the download path calls permanently dead.
 */
export const PERMANENT_HTTP_STATUSES: readonly number[] = [401, 403, 404, 410]

const PERMANENT_HTTP = new RegExp(`\\(HTTP (${PERMANENT_HTTP_STATUSES.join('|')})\\)`)

/**
 * Would pressing Retry on this error ever succeed?
 *
 * The catalog hard-codes its HuggingFace addresses (`catalogAddresses()` walks
 * every one of them). When one of those repos is renamed, gated or taken down,
 * every attempt answers the same 404/403 forever, and the old UI answered with
 * a bare "HTTP 404" and a Retry button — a loop with no exit. The status code
 * inside the message is the contract; it is put there by `http_error_message`
 * in src-tauri/src/commands/download.rs.
 *
 * A transport error, a rate limit and a 5xx are all temporary and stay
 * retryable: only an address that is gone is permanent.
 */
export function isPermanentDownloadError(error?: string | null): boolean {
  return !!error && PERMANENT_HTTP.test(error)
}

export async function resumeDownload(id: string, url: string, subfolder: string, expectedBytes?: number, sha256?: string): Promise<void> {
  await backendCall("resume_download", {
    id,
    url,
    subfolder,
    expectedBytes: expectedBytes ?? null,
    expectedSha256: sha256 ?? null,
    authToken: civitaiAuthToken(url),
  })
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
    // Die Antwort wird geprueft und nicht geglaubt. Der Aufrufer im
    // downloadStore liest sofort `.length`, und eine Gegenstelle, die statt
    // der Liste `null` oder gar nichts schickt (eine aeltere Rust-Seite, ein
    // Bridge-Aufruf, der still leer zurueckkommt), erzeugte dort eine
    // unbehandelte Zurueckweisung statt eines leeren Ergebnisses. Ein
    // fehlgeschlagener Suchlauf ist "es liegt nichts herum", nicht ein Fehler,
    // den der Nutzer sieht.
    const antwort = await backendCall("find_orphan_downloads", { extraDirs })
    return Array.isArray(antwort) ? antwort : []
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

/** Where the callers of a node install genuinely differ — and nothing else. */
export interface CustomNodeInstallOptions {
  /**
   * Keep going when one pack fails, instead of throwing on the first.
   *
   * True for the bundle download, where the packs are an extra alongside
   * gigabytes of models and one broken clone must not cost the rest. False —
   * the default — for the Create flows, which install exactly the pack the
   * next step needs and have nothing to do without it.
   */
  keepGoing?: boolean
  /**
   * Restart ComfyUI afterwards so the packs actually register.
   *
   * A cloned pack is Python that only loads at ComfyUI startup, so without
   * this the install is on disk and invisible. The callers in the Create
   * surface do their own restart around their own progress text; the bundle
   * download has no such surface and asks for it here.
   */
  restart?: boolean
  /** Progress text for a caller that has somewhere to put it. */
  onProgress?: (message: string) => void
}

/**
 * Install node packs — and leave this process's idea of "which nodes exist"
 * broken behind you, because it is now a lie.
 *
 * THE ONE PATH. There used to be two: this function, and a hand-copied loop
 * inside `installBundleComplete` below. They drifted, as copies do. This one never
 * touched `clearNodeCache()`, so every caller had to remember; three of them
 * did, each in its own hand-written sequence (CreateContext.tsx:346 and :407,
 * useCreate.ts:991). The copy in `installBundleComplete` did not — it restarted
 * ComfyUI and refreshed the MODEL lists, which is a different cache entirely.
 * `getAllNodeInfo` holds `/object_info` for five minutes
 * (comfyui-nodes.ts:60), so after a bundle install the workflow builder kept
 * reading the pre-install catalogue and kept telling the user to install the
 * pack he had just installed. T-67.
 *
 * The cache break is in a `finally` on purpose. A pack whose `pip install`
 * died halfway can still have registered its nodes, and a failed install is
 * exactly the moment nobody remembers to invalidate anything. Dropping a
 * five-minute cache costs one `/object_info` fetch; keeping a stale one costs
 * the user a wrong instruction he cannot argue with.
 *
 * It is broken a SECOND time after the restart, and that is the one that
 * matters: between install and restart the nodes are still not registered, so
 * anything that refetches in that window would just re-cache the same stale
 * answer. The restart is when the truth changes.
 */
export async function installCustomNodes(nodeKeys: string[], opts: CustomNodeInstallOptions = {}): Promise<void> {
  try {
    for (const key of nodeKeys) {
      const entry = CUSTOM_NODE_REGISTRY[key]
      if (!entry) {
        log.warn(`[discover] Unknown custom node key: ${key}`)
        continue
      }
      try {
        opts.onProgress?.(`Installing ${entry.name}…`)
        const result = await backendCall('install_custom_node', { repoUrl: entry.repo, nodeName: entry.name })
        assertNodeInstallOk(result, entry.name)
        log.info(`[discover] Installed custom node: ${entry.name}`)
      } catch (err) {
        if (!opts.keepGoing) {
          log.error(`[discover] Failed to install ${entry.name}`, { err })
          throw new Error(`Failed to install ${entry.name}: ${err}`)
        }
        log.warn('[discover] Custom node install failed', { err })
      }
    }
  } finally {
    clearNodeCache()
  }

  if (!opts.restart) return
  // `restartComfyForNewNodes`, not a hand-rolled stop/sleep/start. The copy
  // this replaced slept two seconds and started again unconditionally, which
  // is exactly wrong for a ComfyUI that LU did not spawn: the old process
  // keeps the port and its old node list, the new one never gets the port, and
  // the user is sent hunting an IMPORT FAILED line nobody ever wrote (measured
  // on the test box 2026-08-15, see comfy-restart.ts).
  opts.onProgress?.('Restarting ComfyUI so the new nodes register…')
  await restartComfyForNewNodes()
  clearNodeCache()
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
  const installedFiles = new Set<string>()
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
  //
  // Through `installCustomNodes`, not a copy of it. The loop that used to stand
  // here was the second of two paths doing the same job, and it was the one
  // nobody maintained: it never broke the /object_info cache, so the workflow
  // builder went on recommending the pack this very call had just installed
  // (T-67), and its restart was a hand-rolled sleep that could not tell a
  // ComfyUI LU owns from one it does not.
  if (bundle.customNodes && bundle.customNodes.length > 0) {
    void installCustomNodes([...bundle.customNodes], { keepGoing: true, restart: true })
      .catch((err) => log.warn('[discover] Custom node install/restart failed', { err }))
  }

  // Force ComfyUI to re-scan model directories so new files appear in /object_info.
  // Without this, ComfyUI's cached model list stays stale on Windows. This is
  // the MODEL scan (ComfyUI's own), not the node catalogue — the node half is
  // `clearNodeCache()` inside installCustomNodes above, and confusing the two
  // is what left T-67 open.
  try {
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
  // SVD loads through ComfyUI's ImageOnlyCheckpointLoader — the registry
  // below has always said so, only this union (a stale copy of the one in
  // comfyui.ts, which lists all three) had not caught up.
  loader: 'UNETLoader' | 'CheckpointLoaderSimple' | 'ImageOnlyCheckpointLoader'
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
 * `mmproj-model-bf16.gguf`, `mmproj-Qwen3.8-27B-Uncensored-F16.gguf`), and the
 * built-in models dir is FLAT, so keeping the upstream name would leave two
 * models fighting over one projector file. Tying the name to the model also
 * keeps the pairing right when a user downloads several quants of one model.
 *
 * The third example used to read `Qwen3.8-27B-Uncensored-vision-f16.gguf`.
 * That file never existed: the address built from it answered 404, and all six
 * Qwen 3.8 27B entries pointed at it, so every one of them would have fetched
 * 11-29 GB of model and then failed on the projector. Nothing noticed for as
 * long as nobody asked the host — which is the whole of T-70. Corrected
 * against the repo's own file list on 2026-09-01, first run of the gate in
 * `__tests__/hf-catalog-addresses.live.test.ts`.
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
    { name: 'Qwen 3.8 27B Uncensored', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B dense · the viral uncensored build. Vision + thinking, 262K context. Recommended quant. The 0.9 GB vision projector comes with it.', pulls: '1M+', tags: ['27B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q4_K_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q4_K_M.gguf', sizeGB: 16.8, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Uncensored-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored IQ2_M', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · smallest quant, fits a 12 GB card. Real quality tradeoff, but it runs.', pulls: '1M+', tags: ['27B', 'Vision', 'IQ2_M', '11 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-IQ2_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-IQ2_M.gguf', sizeGB: 10.6, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Uncensored-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored IQ4_XS', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · IQ4_XS, the cheapest 4 bit. Close to Q4_K_M on 16 GB cards.', pulls: '1M+', tags: ['27B', 'Vision', 'IQ4_XS', '15 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-IQ4_XS.gguf'), filename: 'Qwen3.8-27B-Uncensored-IQ4_XS.gguf', sizeGB: 15.3, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Uncensored-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored Q5_K_M', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · Q5, higher quality. For 24 GB cards.', pulls: '1M+', tags: ['27B', 'Vision', 'Q5_K_M', '20 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q5_K_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q5_K_M.gguf', sizeGB: 19.5, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Uncensored-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored Q6_K', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · Q6, near-lossless. High-VRAM setups.', pulls: '1M+', tags: ['27B', 'Vision', 'Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q6_K.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q6_K.gguf', sizeGB: 22.4, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Uncensored-F16.gguf'), mmprojSizeGB: 0.93 },
    { name: 'Qwen 3.8 27B Uncensored Q8_0', group: 'Qwen 3.8 27B Uncensored', description: 'Qwen 3.8 27B uncensored · Q8, full quality. 32 GB+ or CPU with lots of RAM.', pulls: '1M+', tags: ['27B', 'Vision', 'Q8_0', '29 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'Qwen3.8-27B-Uncensored-Q8_0.gguf'), filename: 'Qwen3.8-27B-Uncensored-Q8_0.gguf', sizeGB: 29, mmprojUrl: HF('JonathanColetti/Qwen3.8-27B-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Uncensored-F16.gguf'), mmprojSizeGB: 0.93 },
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
    // ── Qwen 3.8 27B Heretic RVN ──────────────────────────────────────
    //
    // Nachgetragen am 02.09.2026, nachdem David gesagt hatte „such mehr nach
    // uncensored, irgendwas muss es geben". Es gab etwas: dieses Repo stand
    // mit 1,2 Mio Downloads auf Platz zwei aller unzensierten GGUF-Modelle
    // und fehlte hier.
    //
    // WICHTIG zur Dateiwahl, sonst laedt jemand das Falsche: die Modellkarte
    // sagt ausdruecklich, dass das sauber benannte
    // `Qwen3.8-27B-Heretic-Q4_K_M.gguf` die AELTERE Abliteration ist und nur
    // „for download-count continuity" liegen bleibt. Empfohlen sind die
    // `RVN-*-multilingual`-Dateien: zwei zusaetzliche ARA-Durchgaenge, KL
    // 0,0085, Verweigerungen von 3/100 auf 0–1/100. Genau die stehen hier.
    // `-mtp`- und `-vision`-Varianten sind absichtlich draussen, solange sie
    // niemand am Pin gefahren hat.
    //
    // Architektur am 02.09.2026 aus dem echten Dateikopf gelesen: `qwen35` —
    // dieselbe wie beim Nachbareintrag oben, also von b9949 getragen.
    { name: 'Qwen 3.8 27B Heretic', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · twice-sharpened abliteration, 0–1 refusals per 100 prompts. Vision, multilingual. Recommended size.', pulls: '1.2M+', tags: ['27B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-Q4_K_M-multilingual.gguf'), filename: 'RVN-Q4_K_M-multilingual.gguf', sizeGB: 16.6, mmprojUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Q8_0.gguf'), mmprojSizeGB: 0.63 },
    { name: 'Qwen 3.8 27B Heretic IQ2_M', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · the smallest usable quant, fits a 12 GB card.', pulls: '1.2M+', tags: ['27B', 'Vision', 'IQ2_M', '10 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-IQ2_M-multilingual.gguf'), filename: 'RVN-IQ2_M-multilingual.gguf', sizeGB: 10, mmprojUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Q8_0.gguf'), mmprojSizeGB: 0.63 },
    { name: 'Qwen 3.8 27B Heretic Q5_K_M', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · Q5, higher quality. For 24 GB cards.', pulls: '1.2M+', tags: ['27B', 'Vision', 'Q5_K_M', '19 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-Q5_K_M-multilingual.gguf'), filename: 'RVN-Q5_K_M-multilingual.gguf', sizeGB: 19.2, mmprojUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Q8_0.gguf'), mmprojSizeGB: 0.63 },
    { name: 'Qwen 3.8 27B Heretic Q6_K', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · Q6, near-lossless. For high-VRAM setups.', pulls: '1.2M+', tags: ['27B', 'Vision', 'Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-Q6_K-multilingual.gguf'), filename: 'RVN-Q6_K-multilingual.gguf', sizeGB: 22.1, mmprojUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'mmproj-Qwen3.8-27B-Q8_0.gguf'), mmprojSizeGB: 0.63 },
    // ── Gemma 4 12B Heretic ───────────────────────────────────────────
    //
    // Die Luecke, die dem Katalog am meisten gefehlt hat: alles Unzensierte
    // hier ist Qwen oder GLM. Wer mit Gemma anders zurechtkommt — und viele
    // tun das —, hatte keine Wahl. 302K Downloads, Architektur `gemma4` am
    // 02.09.2026 aus dem Dateikopf gelesen, von b9949 getragen.
    { name: 'Gemma 4 12B Heretic', group: 'Gemma 4 12B Heretic', description: 'Gemma 4 12B heretic-abliterated · the uncensored counterpart to Qwen and GLM, with a different voice. Vision. Recommended size.', pulls: '300K+', tags: ['12B', 'Vision', 'Q4_K_M', '7 GB'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-Q4_K_M.gguf'), filename: 'gemma-4-12b-heretic-Q4_K_M.gguf', sizeGB: 7.4, mmprojUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-mmproj-f16.gguf'), mmprojSizeGB: 0.18 },
    { name: 'Gemma 4 12B Heretic IQ4_XS', group: 'Gemma 4 12B Heretic', description: 'Gemma 4 12B heretic · IQ4_XS, the cheapest 4-bit. For 8 GB cards.', pulls: '300K+', tags: ['12B', 'Vision', 'IQ4_XS', '7 GB'], updated: 'New', agent: true, released: '2026-06', downloadUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-IQ4_XS.gguf'), filename: 'gemma-4-12b-heretic-IQ4_XS.gguf', sizeGB: 6.6, mmprojUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-mmproj-f16.gguf'), mmprojSizeGB: 0.18 },
    { name: 'Gemma 4 12B Heretic Q6_K', group: 'Gemma 4 12B Heretic', description: 'Gemma 4 12B heretic · Q6, near-lossless.', pulls: '300K+', tags: ['12B', 'Vision', 'Q6_K', '10 GB'], updated: 'New', agent: true, released: '2026-06', downloadUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-Q6_K.gguf'), filename: 'gemma-4-12b-heretic-Q6_K.gguf', sizeGB: 9.8, mmprojUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-mmproj-f16.gguf'), mmprojSizeGB: 0.18 },
    // ── Qwen3-VL 8B Abliterated ───────────────────────────────────────
    //
    // Die zweite echte Luecke: alles Unzensierte mit Bildverstehen ist hier
    // 27B aufwaerts. Wer eine 8-GB-Karte hat, konnte Bilder nur zensiert
    // ansehen lassen. Das hier laeuft in 5 GB. Architektur `qwen3vl`, am
    // 02.09.2026 aus dem Dateikopf gelesen, von b9949 getragen.
    { name: 'Qwen3-VL 8B Abliterated', group: 'Qwen3-VL 8B Abliterated', description: 'Qwen3-VL 8B abliterated · uncensored image understanding on an 8 GB card. Recommended size.', pulls: '650K+', tags: ['8B', 'Vision', 'Q4_K_M', '5 GB'], updated: 'Hot', agent: true, released: '2025-11', downloadUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Qwen3-VL-8B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 5, mmprojUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf'), mmprojSizeGB: 1.16 },
    { name: 'Qwen3-VL 8B Abliterated Q5_K_M', group: 'Qwen3-VL 8B Abliterated', description: 'Qwen3-VL 8B abliterated · Q5, higher quality.', pulls: '650K+', tags: ['8B', 'Vision', 'Q5_K_M', '6 GB'], updated: 'New', agent: true, released: '2025-11', downloadUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.Q5_K_M.gguf'), filename: 'Qwen3-VL-8B-Instruct-abliterated.Q5_K_M.gguf', sizeGB: 5.9, mmprojUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf'), mmprojSizeGB: 1.16 },
    { name: 'Qwen3-VL 8B Abliterated Q6_K', group: 'Qwen3-VL 8B Abliterated', description: 'Qwen3-VL 8B abliterated · Q6, near-lossless.', pulls: '650K+', tags: ['8B', 'Vision', 'Q6_K', '7 GB'], updated: 'New', agent: true, released: '2025-11', downloadUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.Q6_K.gguf'), filename: 'Qwen3-VL-8B-Instruct-abliterated.Q6_K.gguf', sizeGB: 6.7, mmprojUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf'), mmprojSizeGB: 1.16 },
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
    //
    // BOTH ADDRESSES BELOW ANSWER 401 (measured 2026-09-01, first run of the
    // catalog gate in __tests__/hf-catalog-addresses.live.test.ts).
    // `huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF` is private or gone
    // — HuggingFace answers 401 for both, on purpose, so which one it is
    // cannot be told from outside. They are LEFT AS THEY ARE and not repointed,
    // because there is nothing verified to repoint them to: the two surviving
    // huihui repos with similar names
    // (`...-abliterated-ds4-GGUF`, `...-0731-abliterated-GGUF`) carry neither
    // `DeepSeek-V4-Flash-UD-IQ1_M.gguf` nor `ggml-model-Q3_K_S.gguf`, and their
    // quants (Q2/Q2_K/Q4_K) are different files at different sizes. Swapping a
    // dead 87 GB promise for an unverified one is not a fix, it is a new bug
    // with a nicer address. Until someone confirms a replacement, the user
    // clicking these gets the gated-repo sentence from `http_error_message`
    // and no Retry button (T-07), which is the honest end of the road.
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
    // ── GLM 5.3 ─────────────────────────────────────────────────────────
    //
    // Nur die GROSSE Variante steht hier, und das ist eine gemessene
    // Entscheidung, keine Auslassung. Aus den GGUF-Kopfbytes gelesen
    // (02.09.2026, siehe api/gguf-arch.ts):
    //
    //   unsloth/GLM-5.3-GGUF          general.architecture = glm-dsa
    //   unsloth/GLM-5.3-Flash-GGUF    general.architecture = glm5next
    //   antirez, AesSedai (Flash)     general.architecture = glm5-next
    //
    // Die zweite Schreibweise ist kein Tippfehler von mir: die Flash-GGUFs
    // tragen je nach Konvertierdatum `glm5next` ODER `glm5-next`. llama.cpp
    // kennt beide nicht — weder am gepinnten Tag noch auf master. Vier PRs
    // waren an dem Tag offen (#27752, #27754, #27773, #27917 fuer MTP), kein
    // einziger gemergt. Ein Flash-Eintrag hiesse: der Nutzer laedt zweistellig
    // Gigabyte und die Engine oeffnet die Datei nicht.
    //
    // Uncensored gibt es GLM 5.3 derzeit nur als Flash (AliceThirty, darask0,
    // orcarouter, Blackfrost) — also genau in der Variante, die lokal nicht
    // laeuft. Fuer die grosse gibt es nur NVFP4/FP8 (dealignai), und das sind
    // vLLM-Formate, keine GGUF.
    //
    // Ollama fuehrt glm-5.3 und glm-5.3-flash ausschliesslich als `:cloud` —
    // ohne lokale Gewichte. In diesem Katalog waere das ein Eintrag, der
    // "lokal" verspricht und auf fremden Rechnern rechnet.
    //
    // Der Waechter __tests__/katalog-architektur.live.test.ts prueft das ab
    // jetzt selbst; seine Gegenprobe wird GRUEN-nach-ROT, sobald llama.cpp
    // glm5next kennt. Dann gehoert Flash hier hinein.
    //
    // NACHGEPRUEFT am 02.09.2026, weil David gesagt hatte „such mehr nach
    // uncensored, irgendwas muss es geben". Das war berechtigt — nur nicht
    // hier: an GLM 5.3 hat sich nichts geaendert. Neu erhoben statt erinnert:
    //
    //   - HuggingFace fuehrt 52 GGUF-Repos zu GLM-5.3, davon 40 Flash.
    //   - AliceThirty/GLM-5.3-Flash-UNCENSORED-GGUF hat inzwischen 4.572
    //     Downloads, ist also kein Einzelfall mehr. Kopfbytes am 02.09.2026
    //     gelesen: `glm5next`. Unveraendert.
    //   - src/llama-arch.cpp auf MASTER am 02.09.2026 geholt und durchsucht:
    //     glm4, glm4moe, glm-dsa — kein glm5next, kein glm5-next.
    //   - Von den 12 Nicht-Flash-GGUF-Repos ist kein einziges unzensiert. Der
    //     einzige Treffer (msuiche/GLM-5.3-abliterated-cyber-GLP-77) ist eine
    //     gesperrte LoRA unter 10 MB, kein Modell.
    //
    // Was die Suche dafuer WOHL gebracht hat, steht weiter oben im
    // Uncensored-Block: Qwen 3.8 27B Heretic RVN, Gemma 4 12B Heretic und
    // Qwen3-VL 8B Abliterated fehlten hier, zusammen ueber zwei Millionen
    // Downloads. Die Antwort auf „irgendwas muss es geben" war ja — nur unter
    // einem anderen Namen.
    // ── Hunyuan 3 295B: entfernt am 03.09.2026, und warum ───────────────
    //
    // Hier standen zwei Eintraege, 170 GB und 83,3 GB. Ihre GGUFs tragen
    // `general.architecture = hy_v3`. Der in scripts/build-llama.sh gepinnte
    // Stand (LLAMA_TAG b9949 / LLAMA_COMMIT 049326a0, 09.07.2026) kennt die
    // Architektur NICHT; sie kam am 14.07.2026 mit llama.cpp #25395 dazu und
    // steht ab Tag b10000.
    //
    // Der Nutzer haette also bis zu 170 GB geladen und die Datei danach nicht
    // oeffnen koennen. Die Eintraege sagten das sogar selbst — "Needs a current
    // llama.cpp / LM Studio build" — und die App liefert keinen.
    //
    // Warum nicht stattdessen der Tag gehoben wurde: das Bauskript pinnt
    // TAG UND COMMIT und prueft beides bei jedem Lauf; ein Sprung ist kein
    // Einzeiler, sondern ein Engine-Wechsel. Der Windows-Sidecar, den das
    // Release wirklich ausliefert, ist ausserdem ein 2.6.3-Build und gar nicht
    // b9949 (EXPERIMENT-CHANGELOG.md) — ein gehobener Tag im Skript haette den
    // Architektur-Waechter gruen gemacht, waehrend der Nutzer weiterhin
    // 170 GB umsonst laedt. Und der Qwen-3.8-27B-Eintrag oben begruendet sich
    // ausdruecklich damit, dass sein MTP-Kopf "loads fine on the pinned
    // llama.cpp b9949" — ein Sprung ohne Ladelauf stellt das unbewiesen.
    //
    // Zurueck kommen die zwei, wenn LLAMA_TAG/LLAMA_COMMIT gehoben UND ein
    // echter Ladelauf gemacht ist. Der Waechter dafuer steht schon:
    // __tests__/katalog-architektur.live.test.ts.
    { name: 'GLM 5.3 744B IQ1', group: 'GLM 5.3 744B', description: 'ZhipuAI GLM 5.3 · same base as 5.2; the whole jump comes from post-training: +50% on Z.ai Code Bench, open-weights SOTA on Terminal Bench 3.0. 744B MoE (40B active), 1M context. Smallest quant, multi-part.', pulls: '74K+', tags: ['744B MoE', 'UD-IQ1_S', '217 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('unsloth/GLM-5.3-GGUF', 'UD-IQ1_S/GLM-5.3-UD-IQ1_S-00001-of-00006.gguf'), filename: 'GLM-5.3-UD-IQ1_S-00001-of-00006.gguf', sizeGB: 216.7 },
    { name: 'GLM 5.3 744B Q2', group: 'GLM 5.3 744B', description: 'ZhipuAI GLM 5.3 · Unsloth Dynamic Q2_K_XL, the quality/size sweet spot for this MoE. 744B MoE (40B active), 1M context, GLM-5.3 licence. Multi-part.', pulls: '74K+', tags: ['744B MoE', 'UD-Q2_K_XL', '254 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('unsloth/GLM-5.3-GGUF', 'UD-Q2_K_XL/GLM-5.3-UD-Q2_K_XL-00001-of-00007.gguf'), filename: 'GLM-5.3-UD-Q2_K_XL-00001-of-00007.gguf', sizeGB: 253.9 },
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

/**
 * Wohin eine frisch heruntergeladene GGUF fuer die LU Engine gehoert.
 *
 * Der Ordner, den der Nutzer unter Model Storage gesetzt hat, wenn er einen
 * gesetzt hat, sonst der eigene der Anwendung.
 *
 * Persona P2, 04.09.2026: der Text im Panel verspricht "LU downloads GGUFs
 * here and reads every .gguf in a folder you set". Gelesen wurde der gesetzte
 * Ordner wirklich, heruntergeladen wurde aber weiter ins Roaming-Profil,
 * zweimal gemessen mit verschiedenen Modellen. Wer seine GGUFs bewusst auf
 * eine andere Platte legt, fand den frischen Download nicht dort. Der erste
 * Halbsatz des Textes stimmte nicht.
 *
 * Gefunden wird die Datei danach wie jede andere: `listBundledModels` liest
 * den eigenen Ordner UND den gesetzten, vier Ebenen tief.
 */
export async function luEngineDownloadDir(): Promise<string | null> {
  const gesetzt = customModelDirs()[0]
  if (gesetzt) return gesetzt
  return await detectProviderModelPath(BUILTIN_BACKEND_ID)
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


// ─── The catalog against reality (T-70) ───
//
// THERE IS DELIBERATELY NO LIVENESS CHECK AT RUNTIME, and this is the reason.
//
// The audit's complaint is true: every download address in this app is a
// string a human typed, and nothing ever asked HuggingFace whether the file is
// still there. The obvious repair — probe them when the app starts — is worse
// than the disease:
//
//   · It buys the app a hundred-odd HEAD requests before the user has asked
//     for anything, on every start.
//   · It invents a network dependency LU does not have. This is a local-first
//     app; the Models tab has to render on a train. A probe that fails offline
//     either lies ("all of these are broken") or is ignored, and an ignored
//     check is not a check.
//   · It cannot fix anything. These URLs are compile-time constants. Knowing
//     at 09:00 that one is dead does not give the running app a working
//     address — it only lets it phrase a better refusal.
//
// And the better refusal is already built, one layer down and at zero cost:
// the Rust downloader turns the status of the request the USER started into a
// sentence that names the cause (`http_error_message`,
// src-tauri/src/commands/download.rs), and `isPermanentDownloadError` above
// stops the UI offering Retry on an address that can never answer. That is the
// lazy check, at the moment of actual access, and it costs no extra request.
//
// What was genuinely missing is the other half: nobody checks the catalog
// BEFORE it ships. So the check moved to where it belongs — a gate the
// developer and CI run, never the user:
//
//     LIVE_HF=1 npx vitest run src/api/__tests__/hf-catalog-addresses.live.test.ts
//
// The two functions below are that gate's eyes. They live here, next to the
// catalog, and they are derived from it rather than copied out of it: a URL
// added to COMPONENT_REGISTRY or to any bundle is inside the gate the moment
// it is written. A hand-kept list in the test file would have been a second
// catalog to forget to update — the same mistake as T-67, in a new place.

/** One address the catalog can hand to the downloader. */
export interface CatalogAddress {
  url: string
  /** Every catalog slot that names this URL, each named once. Several entries
   *  share the big text encoders — the same Wan VAE sits in four bundles — and
   *  a dead address has to be able to name all of its victims. */
  where: string[]
}

/**
 * Every hardcoded download address the catalog holds, deduplicated by URL.
 *
 * Two sources, because there are two: the model catalog `catalogEntries()`
 * already walks (bundles + text models, model file and vision projector), and
 * `COMPONENT_REGISTRY`, whose VAE/CLIP addresses are handed to
 * `startModelDownload` by the component-completion path and appear in no
 * bundle at all.
 */
export function catalogAddresses(): CatalogAddress[] {
  const byUrl = new Map<string, Set<string>>()
  const add = (url: string | undefined, where: string) => {
    if (!url) return
    const seen = byUrl.get(url)
    if (seen) seen.add(where)
    else byUrl.set(url, new Set([where]))
  }

  for (const m of catalogEntries()) {
    add(m.downloadUrl, m.filename ? `${m.name} · ${m.filename}` : m.name)
    add(m.mmprojUrl, `${m.name} · vision projector`)
  }

  for (const [type, req] of Object.entries(COMPONENT_REGISTRY)) {
    add(req.vae?.downloadUrl, `COMPONENT_REGISTRY.${type}.vae`)
    add(req.clip?.downloadUrl, `COMPONENT_REGISTRY.${type}.clip`)
    add(req.clipSecondary?.downloadUrl, `COMPONENT_REGISTRY.${type}.clipSecondary`)
  }

  return [...byUrl].map(([url, where]) => ({ url, where: [...where] }))
}

/** What a probe of a catalog address proved. */
export type AddressVerdict =
  /** The host serves this file. */
  | 'reachable'
  /** The address is gone or gated — the user's download would fail forever. */
  | 'dead'
  /** The host did not answer the question (rate limit, 5xx, no network). */
  | 'unclear'

/**
 * Read one HTTP status as a verdict about the ADDRESS.
 *
 * The third case is the point. The size watcher next door
 * (`bundle-size-drift.live.test.ts`) treats every non-OK answer the same way —
 * `if (echt === null) continue` — so a 404 is silently skipped and the run
 * still goes green. "I could not ask" and "the answer is no" are different
 * facts, and a gate that cannot tell them apart passes exactly when it should
 * shout. A 429 must not fail the build; a 404 must.
 */
export function classifyAddressProbe(status: number): AddressVerdict {
  if (PERMANENT_HTTP_STATUSES.includes(status)) return 'dead'
  if (status >= 200 && status < 400) return 'reachable'
  return 'unclear'
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
    // The user's API key unlocks the full catalog and lifts the per-IP rate
    // limit. It travels as an Authorization header, NOT as `&token=` in the
    // URL: the URL is what the error text and the log line quote, and the log
    // scrubber cannot see a secret that is just another substring of a URL.
    // No key set is still a valid, anonymous search.
    const url = `https://${host}/api/v1/models?${params}`
    const text = await fetchExternal(url, apiKey ?? null)
    const data: unknown = JSON.parse(text)
    // CivitAI's catalogue, not ours: `items` is walked with the boundary
    // guards, and a single malformed entry now yields a partly-empty CARD
    // instead of throwing out of the `.map` and losing all twenty results to
    // the catch below.
    const items = asRecordArray(prop(data, 'items'))

    return items.map((item) => {
      const version = asRecordArray(prop(item, 'modelVersions'))[0]
      const file = asRecordArray(prop(version, 'files'))[0]
      const thumb = asString(propPath(asRecordArray(prop(version, 'images'))[0], 'url'))
      const downloadUrl = asString(prop(version, 'downloadUrl')) ?? asString(prop(file, 'downloadUrl'))
      const sizeKB = asNumber(prop(file, 'sizeKB')) ?? 0
      const itemName = asString(prop(item, 'name'))
      const itemId = asNumber(prop(item, 'id')) ?? 0
      const stats = prop(item, 'stats')
      const downloadCount = asNumber(prop(stats, 'downloadCount'))
      const creator = asString(propPath(item, 'creator', 'username'))

      // Determine subfolder based on model type
      let subfolder = 'checkpoints'
      if (type === 'LORA') subfolder = 'loras'
      else if (type === 'VAE') subfolder = 'vae'
      else if (type === 'TextualInversion') subfolder = 'embeddings'
      // Check if it's a diffusion model (FLUX, Wan, etc.)
      const name = (itemName ?? '').toLowerCase()
      if (name.includes('flux') || name.includes('wan') || name.includes('hunyuan')) {
        subfolder = 'diffusion_models'
      }

      const filename = asString(prop(file, 'name'))
        || `${(itemName ?? '').replace(/[^a-zA-Z0-9._-]/g, '_')}.safetensors`

      const descParts: string[] = []
      const rawDesc = (asString(prop(item, 'description')) ?? '').replace(/<[^>]*>/g, '').trim()
      if (rawDesc) descParts.push(rawDesc.slice(0, 120))
      if (downloadCount) descParts.push(`${formatCount(downloadCount)} downloads`)
      if (creator) descParts.push(`by ${creator}`)

      return {
        id: itemId,
        name: itemName || `Model #${itemId}`,
        description: descParts.join(' · '),
        type: type,
        thumbnailUrl: thumb,
        downloadUrl: civitaiHostSwap(downloadUrl, host),
        filename,
        subfolder,
        sizeGB: sizeKB > 0 ? Math.round(sizeKB / 1024 / 1024 * 10) / 10 : undefined,
        stats: isRecord(stats)
          ? { downloads: downloadCount ?? 0, likes: asNumber(prop(stats, 'thumbsUpCount')) ?? 0 }
          : undefined,
        creator,
        sourceUrl: `https://${host}/models/${itemId}`,
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
