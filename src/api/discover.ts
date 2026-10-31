import { backendCall, fetchExternal } from "./backend"
import { readComfyFolderLists, filterPartialFiles, refreshComfyModels } from "./comfyui"
import { COMPONENT_REGISTRY, type ComponentSpec, type ComponentRequirements } from './component-registry'
import { clearNodeCache, getAllNodeInfo } from "./comfyui-nodes"
import { restartComfyForNewNodes } from "./comfy-restart"
import type { ProviderId } from "./providers/types"
import { log } from "../lib/logger"
import { useWorkflowStore } from "../stores/workflowStore"
import { waitForModelsVisible } from "../lib/bundle-install"
import { bundleBytesToFetch } from "../lib/bundle-state"
import type { DownloadProgress } from "../types/downloads"
import { asNumber, asRecordArray, asString, isRecord, prop, propPath } from "../types/json-guards"
import type { DiscoverModel, ModelBundle } from "./model-bundles"
import { formatCount } from '../lib/formatters'
import { BUILTIN_BACKEND_ID } from '../lib/onboarding-backend'
import { customModelDirs } from './engine'
import { extractGgufQuant, hfUrlToTreePath, parseHfUrl } from '../lib/hf-to-provider'
import { IMAGE_PART } from './image-parts'
import { kimiK3CatalogEntries } from './kimi-k3-catalog'
import { imagePartFileName, isUpstreamImagePart, pickUpstreamImagePart } from '../lib/image-part'
import { shardSetGap, type ShardGap } from '../lib/gguf-shards'
import {
  CUSTOM_NODE_REGISTRY,
  getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles,
} from "./model-bundles"

// Katalog + Formen liegen in model-bundles.ts (siehe dort). Re-Export, damit
// bestehende Importpfade unverändert bleiben.
export type { DiscoverModel, ModelBundle, CustomNodeDef } from './model-bundles'
export {
  CUSTOM_NODE_REGISTRY,
  getImageBundles, getImageModelsDiscover, getVideoBundles,
  getAudioBundles, getLipsyncBundles, getMotionBundles, getUpscaleBundles,
} from './model-bundles'

// Welche Ordner der Katalog beschreibt und wer sie zurueckliest, steht als EINE
// Tabelle neben den Lesern (comfyui.ts). Re-Export, damit bestehende
// Importpfade unveraendert bleiben.
export { ANIMATEDIFF_SUBFOLDER, ENUM_SUBFOLDERS } from './comfyui'

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
 * A user (Discord #bug-reports, 2026-08-28): downloads from the CivitAI
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
 * Remove the finished image part of a model whose download was cancelled.
 *
 * The Rust side takes nothing but a file this app named as an image part, and
 * never the part of a model that is installed (download.rs
 * `image_part_to_remove`). Best effort: a part that cannot be removed is a few
 * hundred megabytes left on disk, not a reason to fail the cancel.
 */
export async function removeImagePart(destDir: string, filename: string): Promise<void> {
  try {
    await backendCall('remove_image_part', { destDir, filename })
  } catch (err) {
    log.warn('[discover] image part not removed', { filename, err })
  }
}

/**
 * Drop a settled row (error / paused / complete) from the Rust progress map and
 * LEAVE THE PARTIAL FILE ALONE.
 *
 * Clearing the Rust side is not optional before a retry: `download_model`
 * short-circuits on a file that is already on disk without ever touching the
 * map, so the next poll would resurrect the error row the user just retried
 *. That bookkeeping is all this does — it is not a decision
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
    ...titleArg(id),
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

// ─── A ComfyUI on another machine (GH #143) ───

/** Where ComfyUI models land. `remote`: the ComfyUI LU talks to runs on
 *  another machine, so the files go to `root` on this one, in ComfyUI's own
 *  folder layout, for the user to copy over (download.rs remote_comfy). */
export interface ComfyModelTarget {
  remote: boolean
  host?: string
  root?: string
}

export async function comfyModelTarget(): Promise<ComfyModelTarget> {
  try {
    const t = await backendCall<ComfyModelTarget>('comfy_model_target')
    return t && t.remote && t.host && t.root ? t : { remote: false }
  } catch {
    // An older backend, or the dev server: the files go where they always went.
    return { remote: false }
  }
}

/** What a bundle install onto a remote ComfyUI leaves for the user to do. */
export interface RemoteBundleReport {
  host: string
  root: string
  /** Node packs the bundle needs, to install on that machine. */
  customNodes: string[]
}

export function remoteBundleNotice(bundleName: string, r: RemoteBundleReport): string {
  const nodes = r.customNodes.length > 0
    ? ` It also needs ${r.customNodes.length === 1 ? 'this node pack' : 'these node packs'} on that machine: ${r.customNodes.join(', ')}. Install ${r.customNodes.length === 1 ? 'it' : 'them'} there and restart ComfyUI.`
    : ''
  return `${bundleName}: your ComfyUI runs on ${r.host}, so LU saves the files here, in ${r.root}, in ComfyUI's own folder layout. Once they are done, copy the folders in there into the models folder of ComfyUI on that machine (or share the folder with it), then refresh the models.${nodes}`
}

// ─── Custom Node Installation ───

/** Is the file on disk the catalog's file? `check_model_sizes` only says "plausibly
 *  there" (50 % of the catalog estimate). Where the catalog knows the byte count
 *  exactly (`sizeBytes`), a file of the same name and another size is a repack from
 *  another mirror, not this model, so it must not count as installed: Get is
 *  offered again and the downloader's own size check fetches the right file. */
export function onDiskMatchesCatalog(file: { sizeBytes?: number }, check: { complete: boolean; actualBytes?: number } | undefined): boolean {
  if (!check?.complete) return false
  return file.sizeBytes == null || check.actualBytes === file.sizeBytes
}

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
    const byName = new Map(results.map(r => [r.filename, r]))
    return bundle.files.filter(f => f.subfolder && f.filename).every(f => onDiskMatchesCatalog(f, byName.get(f.filename!)))
  } catch {
    return false
  }
}

/** Check multiple bundles at once, returns map of bundle name → installed status */
export async function checkBundlesInstalled(bundles: ModelBundle[]): Promise<Record<string, boolean>> {
  return (await checkBundlesOnDisk(bundles)).installed
}

/** What the disk says about a list of bundles: which bundles are installed, and
 *  which of their files are there already. The second half is what a card needs
 *  to announce only what it will really fetch: bundles share files, so "Get"
 *  on a three file bundle is often one file (the box, 03.10.2026). A file
 *  counts by the same rule `installBundleComplete` skips it by. */
export async function checkBundlesOnDisk(bundles: ModelBundle[]): Promise<{ installed: Record<string, boolean>; files: Set<string> }> {
  const result: Record<string, boolean> = {}
  const files = new Set<string>()
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
  if (allFiles.length === 0) return { installed: result, files }

  try {
    const checkFiles = allFiles.map(f => ({ subfolder: f.subfolder, filename: f.filename, expectedBytes: f.expectedBytes }))
    const results: Array<{ filename: string; exists: boolean; actualBytes: number; complete: boolean }> =
      await backendCall('check_model_sizes', { files: checkFiles })

    // Map results back to bundles
    const fileStatus = new Map(results.map(r => [r.filename, r]))
    for (const bundle of bundles) {
      const bundleFiles = bundle.files.filter(f => f.filename)
      for (const f of bundleFiles) {
        if (onDiskMatchesCatalog(f, fileStatus.get(f.filename!))) files.add(f.filename!)
      }
      result[bundle.name] = bundleFiles.length > 0 && bundleFiles.every(f => onDiskMatchesCatalog(f, fileStatus.get(f.filename!)))
    }
  } catch {
    // If check fails (e.g. no ComfyUI), all bundles are not installed
    for (const b of bundles) result[b.name] = false
  }

  // ComfyUI's own model lists — fetched once, used twice: to CONFIRM the
  // size-check hits (a file the RUNNING ComfyUI cannot see must not count as
  // installed) and as the fuzzy variant fallback further down.
  // Issue #51: ComfyUI lists partially-downloaded files too, so the
  // fuzzy fallback would mark an incomplete download as INSTALLED. Drop any
  // file check_model_sizes confirms is partial before matching.
  let comfyLists: Record<string, string[]> | null = null
  try {
    // Every folder of COMFY_MODEL_FOLDERS, keyed by the same subfolder name the
    // catalog files carry, so the fallback further down can look a file up by
    // the folder it was downloaded into. The list this used to name by hand had
    // grown one loader at a time, each time after a bundle card said Installed
    // over a picker that had nothing: the GGUF quants (b8531b6), the motion
    // modules under custom_nodes and the LoRA folder (2026-08-29). The table is
    // what stops the next one.
    const raw = await readComfyFolderLists()
    const filtered = await Promise.all(
      Object.entries(raw).map(async ([subfolder, names]) =>
        [subfolder, Array.from(await filterPartialFiles(names))] as const),
    )
    comfyLists = Object.fromEntries(filtered)
  } catch {
    comfyLists = null // ComfyUI not reachable · size-check verdicts stand
  }

  // A user (Discord 2026-07-27): the size check looks at the directory LU
  // resolves, but the RUNNING ComfyUI may scan a different install (second
  // copy, moved install). "Installed" from the disk check alone then locks the
  // user out: the Create picker (fed by ComfyUI's enums) shows nothing AND
  // re-downloading is refused. When ComfyUI is reachable, a bundle only counts
  // as installed if ComfyUI can actually see the files it needs.
  //
  // EVERY enumerable file, not merely one of them. GH #113 came back on 2.6.6
  // (Blahx with a screenshot, a user: "the model is not visible, although it is
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
      // The folders THIS ComfyUI enumerates, not the folders a ComfyUI could:
      // a loader that is not installed here has said nothing about its folder,
      // and its silence must not send a finished bundle back to the button.
      const enumFiles = bundle.files.filter(f => f.filename && f.subfolder && f.subfolder in comfyLists!)
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

  return { installed: result, files }
}

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
 *  The loaders it asks are COMFY_MODEL_FOLDERS, the same table the catalog's
 *  write targets are checked against, so a folder can no longer be written into
 *  and then not read back. Every widening this reader has needed was a folder
 *  someone had added to the catalog and to nothing else: the GGUF loader in
 *  2.6.6 (6abf570) for the Unfiltered video bundles, the LoRA and AnimateDiff
 *  loaders on 2026-08-29, clip_vision and audio_encoders here. */
export async function readComfyModelNames(): Promise<string[]> {
  return Object.values(await readComfyFolderLists()).flat()
}

/** The folders this ComfyUI really enumerates right now. ENUM_SUBFOLDERS asks
 *  the same question of the catalog ("could this folder be judged at all");
 *  this one asks the engine in front of us ("can it, here"). A bundle must
 *  never be sent back to the download button over a loader that is simply not
 *  installed on the box. */
export async function judgeableFolders(): Promise<Set<string>> {
  try {
    return new Set(Object.keys(await readComfyFolderLists()))
  } catch {
    return new Set()
  }
}

/** Which of `wanted` the RUNNING ComfyUI does not list yet.
 *
 *  One function, because there are two journeys that end in the same place: a
 *  bundle installed from Create (CreateContext) and a download finished in the
 *  Model Manager (downloadStore). C8 gave the first one a wait and left the
 *  second with a single fetch, so the same slow directory scan that froze
 * A user AI's card on 2026-08-13 simply left a model out of the Installed tab
 *  instead. Two probes would have been two chances to drift.
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
        const result = await backendCall('install_custom_node', {
          repoUrl: entry.repo, nodeName: entry.name, ...(entry.commit ? { commit: entry.commit } : {}),
        })
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
 * one. Two users (Discord 2026-08-13) measured scans on the
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

/**
 * ONE space check for the whole bundle, before the first byte moves.
 *
 * Every file starts its own transfer and every transfer checked the free
 * space on its own, so a four file bundle passed the same free bytes four
 * times over and then filled the drive between them. The sum is the only
 * honest question, and it has to be asked before anything starts: refusing
 * file three after files one and two have written 20 GB helps nobody. Throws
 * with the numbers (how much is short, the download, the free space) when the
 * missing files plus the reserve do not fit.
 */
export async function assertBundleFits(bundle: ModelBundle, installed: ReadonlySet<string>): Promise<void> {
  const pending = bundleBytesToFetch(bundle, installed)
  if (pending.bytes <= 0 || !pending.subfolder) return
  const verdict = await checkDownloadSpace({ subfolder: pending.subfolder }, pending.bytes)
  if (verdict && !verdict.fits) {
    throw new Error(verdict.message || `${bundle.name} does not fit on this drive.`)
  }
}

/**
 * The node packs of `keys` the running ComfyUI has not loaded.
 *
 * The box, 03.10.2026: a click on Get for a GGUF bundle pulled ComfyUI-GGUF
 * again and restarted ComfyUI, with the pack loaded all along and nothing on
 * the surface saying so. A pack whose nodes are registered needs neither. One
 * that is on disk and failed to import is not loaded, so it still gets the
 * install that heals it. With ComfyUI not answering nobody can tell, and
 * every pack counts as missing, as before.
 */
export async function nodePacksNotLoaded(keys: string[]): Promise<string[]> {
  let registered: Set<string>
  try {
    registered = new Set(Object.keys(await getAllNodeInfo()))
  } catch {
    return keys
  }
  return keys.filter((key) => {
    const entry = CUSTOM_NODE_REGISTRY[key]
    return !entry || !entry.requiredNodes.every((node) => registered.has(node))
  })
}

export async function installBundleComplete(bundle: ModelBundle): Promise<{ remote?: RemoteBundleReport }> {
  const errors: string[] = []
  // GH #143: a ComfyUI on another machine. The files land here for the user
  // to copy over, so there is no engine to wait for and no node pack LU could
  // install; the report says what is left instead.
  const target = await comfyModelTarget()

  // Pre-check: which files already exist on disk (skip re-downloading them)
  const installedFiles = new Set<string>()
  try {
    const checkFiles = bundle.files
      .filter(f => f.subfolder && f.filename)
      .map(f => ({ subfolder: f.subfolder!, filename: f.filename!, expectedBytes: f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : 0 }))
    if (checkFiles.length > 0) {
      const results: Array<{ filename: string; exists: boolean; actualBytes?: number; complete: boolean }> =
        await backendCall('check_model_sizes', { files: checkFiles })
      const byName = new Map(bundle.files.map(f => [f.filename, f]))
      for (const r of results) {
        // A same-named file of another size is not ours: leave it out of the set
        // so the download starts, and download_model refetches on the size
        // mismatch (judge_existing).
        if (onDiskMatchesCatalog(byName.get(r.filename) ?? {}, r)) installedFiles.add(r.filename)
      }
    }
  } catch { /* can't check · download everything */ }

  // Lazily fetched ComfyUI visibility set: "already installed" is only true
  // when the RUNNING ComfyUI lists the file. A file that exists on disk but is
  // invisible to ComfyUI means LU and ComfyUI look at different model folders
  // (Discord 2026-07-27) — silently skipping it as installed left
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

  // Which folders this engine can be asked about at all. Started once for the
  // whole bundle; the call itself always fires here, only the AWAIT of its
  // result is deferred to the per-file check below (R2-34: this used to claim
  // it ran "lazily", which was not true, the request always goes out).
  const judgeable = judgeableFolders()

  await assertBundleFits(bundle, installedFiles)

  // Step 1: Start downloads only for files NOT already installed
  for (const file of bundle.files) {
    if (!file.downloadUrl || !file.filename || !file.subfolder) continue
    if (installedFiles.has(file.filename)) {
      if (target.remote) {
        window.dispatchEvent(new CustomEvent('comfyui-download-exists', { detail: { filename: file.filename } }))
        continue
      }
      const visible = (await judgeable).has(file.subfolder) ? await comfyCanSee(file.filename) : null
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
  if (bundle.customNodes && bundle.customNodes.length > 0 && !target.remote) {
    // Only the packs ComfyUI has not loaded: installing one that is there
    // restarts ComfyUI for nothing (nodePacksNotLoaded).
    void nodePacksNotLoaded([...bundle.customNodes])
      .then((missing) => (missing.length > 0 ? installCustomNodes(missing, { keepGoing: true, restart: true }) : undefined))
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
  if (target.remote && target.host && target.root) {
    return {
      remote: {
        host: target.host,
        root: target.root,
        customNodes: (bundle.customNodes ?? []).map((k) => CUSTOM_NODE_REGISTRY[k]?.name ?? k),
      },
    }
  }
  return {}
}

// ─── Component Registry: What each model type needs to work ───
//
// K9 (GH #136): this table used to be declared here a second time, with a
// different field naming (patterns/downloadName vs comfyui.ts's
// matchPatterns/downloadFilename) but the same per-model-type content, a
// duplicate that both had to be remembered on every new architecture. Canonical
// data now lives in component-registry.ts; re-exported here so existing
// imports of `COMPONENT_REGISTRY` / `ComponentSpec` / `ComponentRequirements`
// from './discover' keep working unchanged.
export type { ComponentSpec, ComponentRequirements }
export { COMPONENT_REGISTRY }

// ─── Text Models (HuggingFace GGUF · unified source for all providers) ───

const HF = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`

// The name an image part gets on disk is one rule for the whole app and lives
// in lib/image-part.ts, next to the Rust side's `mmproj_sibling_path`. Kept
// under this name here because the catalog and its tests speak of mmproj.
//
// A note that used to stand at this place and must not get lost: the example
// `Qwen3.8-27B-Uncensored-vision-f16.gguf` once named a file that never
// existed. Its address answered 404, and all six Qwen 3.8 27B entries pointed
// at it, so every one of them would have fetched 11 to 29 GB of model and then
// failed on the part. Corrected against the repository's own file list on
// 2026-09-01, first run of the gate in
// `__tests__/hf-catalog-addresses.live.test.ts`.
export { imagePartFileName as mmprojFileName, isImagePartFile } from '../lib/image-part'

/** One file a catalog entry writes into the model folder. */
export interface PlannedDownload {
  url: string
  filename: string
  expectedBytes?: number
  /** Content digest, when the catalog or the HF tree stated one. */
  sha256?: string
}

/** The image part of a model as the download needs it. */
export interface ImagePartSource {
  url: string
  sizeBytes?: number
  sha256?: string
}

/** The image part a catalog entry names, or null for a text model. */
export function imagePartOf(model: Pick<DiscoverModel, 'mmprojUrl' | 'mmprojBytes' | 'mmprojSizeGB' | 'mmprojSha256'>): ImagePartSource | null {
  if (!model.mmprojUrl) return null
  return {
    url: model.mmprojUrl,
    sizeBytes: model.mmprojBytes ?? (model.mmprojSizeGB ? Math.round(model.mmprojSizeGB * 1_073_741_824) : undefined),
    sha256: model.mmprojSha256,
  }
}

/**
 * Everything a model has to put on disk: the model file, and its image part
 * when it has one and the user did not leave it out. `url` / `filename` /
 * `bytes` are the RESOLVED model file (the HF tree corrects the catalog's
 * guess), the part rides along under the derived name with its own byte count
 * and digest.
 *
 * `part` is the catalog's part, or the one found in the repository's file list
 * for a model the catalog does not know. `withImagePart: false` is the user's
 * choice in the download dialog.
 *
 * Pure on purpose: the download UI only loops over the result, so the "does
 * this model need a second file, and what is it called" decision is unit
 * testable without rendering the Models tab.
 */
export function planModelDownload(
  model: DiscoverModel,
  url: string,
  filename: string,
  bytes?: number,
  sha256?: string,
  opts: { part?: ImagePartSource | null; withImagePart?: boolean } = {},
): PlannedDownload[] {
  // The resolved digest wins over the catalog's: `url` may have been corrected
  // by the HF tree, and a digest that belongs to a different file is worse than
  // none at all.
  const plan: PlannedDownload[] = [{ url, filename, expectedBytes: bytes, sha256: sha256 ?? (url === model.downloadUrl ? model.sha256 : undefined) }]
  const part = opts.part === undefined ? imagePartOf(model) : opts.part
  if (part && opts.withImagePart !== false) {
    plan.push({ url: part.url, filename: imagePartFileName(filename), expectedBytes: part.sizeBytes, sha256: part.sha256 })
  }
  return plan
}

/**
 * Why an entry of a family with image input carries no image part: its
 * repository ships none, and it is a finetune or a distill, so nothing proves
 * that the part of its base model still fits its weights. Such a model is
 * offered as what it is, a text model.
 */
const NO_PART_UPSTREAM = 'The repository ships no image part, and none of another repository is proven to fit.'

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
    // ── HOT: Qwen 3.5 Abliterated ──
    { name: 'Qwen 3.5 9B Abliterated', description: 'Qwen 3.5 abliterated · newest, strongest reasoning + coding.', pulls: '10K+', tags: ['9B', 'Vision', 'Q4_K_M', '6 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('mradermacher/Qwen3.5-9B-abliterated-GGUF', 'Qwen3.5-9B-abliterated.Q4_K_M.gguf'), filename: 'Qwen3.5-9B-abliterated.Q4_K_M.gguf', sizeGB: 5, ...IMAGE_PART['unsloth/Qwen3.5-9B-GGUF/mmproj-F16.gguf'] },
    // ── HOT: GPT-OSS Abliterated ──
    { name: 'GPT-OSS 20B Abliterated', description: 'OpenAI GPT-OSS · abliterated open-source GPT model.', pulls: '15K+', tags: ['20B', 'Q4_K_M', '13 GB'], updated: 'Hot', agent: true, released: '2026-03', downloadUrl: HF('bartowski/huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-GGUF', 'huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-Q4_K_M.gguf'), filename: 'huihui-ai_Huihui-gpt-oss-20b-BF16-abliterated-Q4_K_M.gguf', sizeGB: 13 },
    // ── Qwen 3.8 27B UNCENSORED (August 2026) ──
    // Two independent uncensors of the same dense 27B base. Both are native
    // vision-language models, so every entry carries the repo's own mmproj and
    // LU downloads it with the model (see `mmprojFileName`). The MTP head that
    // ships inside these GGUFs loads fine on llama.cpp b9949, which
    // implements the qwen35 MTP block, so we point at the plain files.
    // (E1, 3.0.9: the pin is b11960 now; these two were not loaded there.)
    //
    // The uncensored build is OrcaRouter's abliteration. Its own GGUF repo
    // (orcarouter/Qwen3.8-27B-Uncensored-GGUF) is gated: every file answers
    // HTTP 401 without a logged-in, terms-accepted account, which LU's
    // downloader does not have, so pointing there would fail after the click.
    // The rows use bartowski's requant of the same weights (base_model =
    // orcarouter/Qwen3.8-27B-Uncensored, ungated, HEAD 200 on 2026-09-05);
    // the entries used to point at JonathanColetti's requant. One HF row
    // serves both the built-in engine and LM Studio (the downloader writes
    // into whichever folder is active); Ollama gets the author's own tag.
    { name: 'Qwen 3.8 27B Uncensored', group: 'Qwen 3.8 27B Uncensored', description: 'OrcaRouter Qwen 3.8 27B uncensored · the viral abliterated build, from the author\'s own repo. Vision + thinking + tools, 262K context. Recommended quant. The 0.9 GB vision projector comes with it.', pulls: '35K+', tags: ['27B', 'Vision', 'Q4_K_M', '18 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'orcarouter_Qwen3.8-27B-Uncensored-Q4_K_M.gguf'), filename: 'orcarouter_Qwen3.8-27B-Uncensored-Q4_K_M.gguf', sizeGB: 17.8, ...IMAGE_PART['bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf'] },
    { name: 'Qwen 3.8 27B Uncensored IQ2_M', group: 'Qwen 3.8 27B Uncensored', description: 'OrcaRouter Qwen 3.8 27B uncensored · smallest quant, fits a 12 GB card. Real quality tradeoff, but it runs.', pulls: '35K+', tags: ['27B', 'Vision', 'IQ2_M', '11 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'orcarouter_Qwen3.8-27B-Uncensored-IQ2_M.gguf'), filename: 'orcarouter_Qwen3.8-27B-Uncensored-IQ2_M.gguf', sizeGB: 10.9, ...IMAGE_PART['bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf'] },
    { name: 'Qwen 3.8 27B Uncensored IQ4_XS', group: 'Qwen 3.8 27B Uncensored', description: 'OrcaRouter Qwen 3.8 27B uncensored · IQ4_XS, the cheapest 4 bit. Close to Q4_K_M on 16 GB cards.', pulls: '35K+', tags: ['27B', 'Vision', 'IQ4_XS', '16 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'orcarouter_Qwen3.8-27B-Uncensored-IQ4_XS.gguf'), filename: 'orcarouter_Qwen3.8-27B-Uncensored-IQ4_XS.gguf', sizeGB: 15.6, ...IMAGE_PART['bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf'] },
    { name: 'Qwen 3.8 27B Uncensored Q5_K_M', group: 'Qwen 3.8 27B Uncensored', description: 'OrcaRouter Qwen 3.8 27B uncensored · Q5, higher quality. For 24 GB cards.', pulls: '35K+', tags: ['27B', 'Vision', 'Q5_K_M', '21 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'orcarouter_Qwen3.8-27B-Uncensored-Q5_K_M.gguf'), filename: 'orcarouter_Qwen3.8-27B-Uncensored-Q5_K_M.gguf', sizeGB: 20.8, ...IMAGE_PART['bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf'] },
    { name: 'Qwen 3.8 27B Uncensored Q6_K', group: 'Qwen 3.8 27B Uncensored', description: 'OrcaRouter Qwen 3.8 27B uncensored · Q6, near-lossless. High-VRAM setups.', pulls: '35K+', tags: ['27B', 'Vision', 'Q6_K', '23 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'orcarouter_Qwen3.8-27B-Uncensored-Q6_K.gguf'), filename: 'orcarouter_Qwen3.8-27B-Uncensored-Q6_K.gguf', sizeGB: 23.5, ...IMAGE_PART['bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf'] },
    { name: 'Qwen 3.8 27B Uncensored Q8_0', group: 'Qwen 3.8 27B Uncensored', description: 'OrcaRouter Qwen 3.8 27B uncensored · Q8, full quality. 32 GB+ or CPU with lots of RAM.', pulls: '35K+', tags: ['27B', 'Vision', 'Q8_0', '29 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF', 'orcarouter_Qwen3.8-27B-Uncensored-Q8_0.gguf'), filename: 'orcarouter_Qwen3.8-27B-Uncensored-Q8_0.gguf', sizeGB: 29.1, ...IMAGE_PART['bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF/mmproj-orcarouter_Qwen3.8-27B-Uncensored-f16.gguf'] },
    { name: 'Qwen 3.8 27B Abliterated', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · clean uncensor of the newest Qwen dense model. Vision + thinking. Note the quant is called Q4_K, not Q4_K_M.', pulls: '635K+', tags: ['27B', 'Vision', 'Q4_K', '17 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf', sizeGB: 16.8, ...IMAGE_PART['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Qwen 3.8 27B Abliterated Q2_K', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · smallest quant for 12 GB cards.', pulls: '635K+', tags: ['27B', 'Vision', 'Q2_K', '11 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q2_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q2_K.gguf', sizeGB: 10.9, ...IMAGE_PART['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Qwen 3.8 27B Abliterated Q5_K', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · Q5, higher quality. For 24 GB cards.', pulls: '635K+', tags: ['27B', 'Vision', 'Q5_K', '20 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q5_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q5_K.gguf', sizeGB: 19.5, ...IMAGE_PART['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Qwen 3.8 27B Abliterated Q6_K', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · Q6, near-lossless.', pulls: '635K+', tags: ['27B', 'Vision', 'Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q6_K.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q6_K.gguf', sizeGB: 22.4, ...IMAGE_PART['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Qwen 3.8 27B Abliterated Q8_0', group: 'Qwen 3.8 27B Abliterated', description: 'huihui Qwen 3.8 27B abliterated · Q8, full quality.', pulls: '635K+', tags: ['27B', 'Vision', 'Q8_0', '29 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF', 'Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf'), filename: 'Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf', sizeGB: 29, ...IMAGE_PART['huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    // Ollama ships the projector as a layer of the tag, so vision works there
    // without a second file.
    { name: 'Qwen 3.8 27B Uncensored (Ollama)', description: 'OrcaRouter Qwen 3.8 27B uncensored · one-command pull, projector included. Vision + tools + thinking out of the box. Needs Ollama 0.17.1 or newer.', pulls: '137K+', tags: ['27B', 'Vision', 'Tools', '18 GB'], updated: 'Hot', agent: true, released: '2026-08', ollamaModel: 'orcarouter/Qwen3.8-27B-Uncensored:q4_K_M', sizeGB: 18 },
    { name: 'Qwen 3.8 27B Abliterated (Ollama)', description: 'huihui Qwen 3.8 27B abliterated · one-command pull, projector included. Vision + tools + thinking out of the box.', pulls: '24K+', tags: ['27B', 'Vision', 'Tools', '18 GB'], updated: 'Hot', agent: true, released: '2026-08', ollamaModel: 'huihui_ai/Qwen3.8-abliterated:27b', sizeGB: 17.7 },
    // ── HOT: Qwen 3.6 Unfiltered (April 2026) ──
    { name: 'Qwen 3.6 35B MoE Abliterated', description: 'Qwen 3.6 35B MoE abliterated · brand new unfiltered. 3B active, vision + agentic coding + thinking. 256K context.', pulls: '1K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'huihui_ai/Qwen3.6-abliterated:35b', sizeGB: 24 },
    // Task #34 v2.5.0 · leon-recommended Heretic abliteration (GH #48 reply
    // pointed users with weak Ollama-side downloads at this LM-Studio-friendly
    // direct path). 21.2 GB single file, Q4_K_M. 3B-active MoE so it runs
    // surprisingly well on 24 GB cards with -ncmoe expert offload.
    { name: 'Qwen 3.6 35B MoE Abliterated Heretic', description: 'Qwen 3.6 35B MoE · Heretic abliteration (stronger unfiltered). 3B active expert MoE, runs on 24 GB GPUs.', pulls: '12K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '21 GB', 'Heretic'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF', 'Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M/Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M.gguf'), filename: 'Qwen3.6-35B-A3B-Abliterated-Heretic-Q4_K_M.gguf', sizeGB: 21, ...IMAGE_PART['Youssofal/Qwen3.6-35B-A3B-Abliterated-Heretic-GGUF/mmproj-Qwen3.6-35B-A3B-Abliterated-Heretic.gguf'] },
    // ── HOT: Gemma 4 Unfiltered Variants ──
    { name: 'Gemma 4 31B Unfiltered', description: 'Gemma 4 31B unfiltered · frontier dense model, native tool calling + vision. 256K context.', pulls: '400+', tags: ['31B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('TrevorJS/gemma-4-31B-it-uncensored-GGUF', 'gemma-4-31B-it-uncensored-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-uncensored-Q4_K_M.gguf', sizeGB: 17, ...IMAGE_PART['unsloth/gemma-4-31B-it-GGUF/mmproj-F16.gguf'] },
    { name: 'Gemma 4 26B MoE Heretic', description: 'Gemma 4 26B MoE HERETIC · 26B brain, 4B active. Unfiltered + tools + vision.', pulls: '43K+', tags: ['26B MoE', 'Vision', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('nohurry/gemma-4-26B-A4B-it-heretic-GUFF', 'gemma-4-26b-a4b-it-heretic.q4_k_m.gguf'), filename: 'gemma-4-26b-a4b-it-heretic.q4_k_m.gguf', sizeGB: 16, ...IMAGE_PART['nohurry/gemma-4-26B-A4B-it-heretic-GUFF/gemma-4-26B-A4B-it-heretic-mmproj.f16.gguf'] },
    { name: 'Gemma 4 31B Heretic', description: 'Gemma 4 31B HERETIC · full uncensor, native tool calling, 256K context.', pulls: '32K+', tags: ['31B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('Stabhappy/gemma-4-31B-it-heretic-Gguf', 'coder3101_gemma_4_31b_it_heretic-Q4_K_M.gguf'), filename: 'coder3101_gemma_4_31b_it_heretic-Q4_K_M.gguf', sizeGB: 17, ...IMAGE_PART['Stabhappy/gemma-4-31B-it-heretic-Gguf/mmproj-coder3101_gemma_4_31b_it_heretic-f16.gguf'] },
    { name: 'Gemma 4 31B Abliterated', description: 'Gemma 4 31B abliterated · strong reasoning, Apache 2.0.', pulls: '7K+', tags: ['31B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('LiconStudio/Gemma-4-31B-it-abliterated-GGUF', 'gemma-4-31B-it-abliterated-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-abliterated-Q4_K_M.gguf', sizeGB: 17, ...IMAGE_PART['LiconStudio/Gemma-4-31B-it-abliterated-GGUF/mmproj-F16.gguf'] },
    // ── HOT: GLM 4.7 Flash Unfiltered Heretic ──
    { name: 'GLM 4.7 Flash Heretic IQ2', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, fits 12GB VRAM. Strongest 30B class.', pulls: '5K+', tags: ['30B', 'IQ2_M', '10 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-IQ2_M.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-IQ2_M.gguf', sizeGB: 10 },
    { name: 'GLM 4.7 Flash Heretic Q4', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, best quality/size balance.', pulls: '5K+', tags: ['30B', 'Q4_K_M', '19 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q4_K_M.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q4_K_M.gguf', sizeGB: 19 },
    { name: 'GLM 4.7 Flash Heretic Q6', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, high quality quant.', pulls: '5K+', tags: ['30B', 'Q6_K', '25 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q6_K.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q6_K.gguf', sizeGB: 25 },
    { name: 'GLM 4.7 Flash Heretic Q8', group: 'GLM 4.7 Flash Heretic', description: 'GLM 4.7 Flash HERETIC · 30B unfiltered, near-lossless quality.', pulls: '5K+', tags: ['30B', 'Q8_0', '32 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q8_0.gguf'), filename: 'GLM-4.7-Flash-Uncen-Hrt-NEO-CODE-MAX-imat-D_AU-Q8_0.gguf', sizeGB: 32 },
    // ── Qwen 3.8 27B Heretic RVN ──────────────────────────────────────
    //
    // Nachgetragen am 02.09.2026, nachdem der Inhaber gesagt hatte „such mehr nach
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
    { name: 'Qwen 3.8 27B Heretic', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · twice-sharpened abliteration, 0–1 refusals per 100 prompts. Vision, multilingual. Recommended size.', pulls: '1.2M+', tags: ['27B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-Q4_K_M-multilingual.gguf'), filename: 'RVN-Q4_K_M-multilingual.gguf', sizeGB: 16.6, ...IMAGE_PART['0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/mmproj-Qwen3.8-27B-Q8_0.gguf'] },
    { name: 'Qwen 3.8 27B Heretic IQ2_M', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · the smallest usable quant, fits a 12 GB card.', pulls: '1.2M+', tags: ['27B', 'Vision', 'IQ2_M', '10 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-IQ2_M-multilingual.gguf'), filename: 'RVN-IQ2_M-multilingual.gguf', sizeGB: 10, ...IMAGE_PART['0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/mmproj-Qwen3.8-27B-Q8_0.gguf'] },
    { name: 'Qwen 3.8 27B Heretic Q5_K_M', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · Q5, higher quality. For 24 GB cards.', pulls: '1.2M+', tags: ['27B', 'Vision', 'Q5_K_M', '19 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-Q5_K_M-multilingual.gguf'), filename: 'RVN-Q5_K_M-multilingual.gguf', sizeGB: 19.2, ...IMAGE_PART['0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/mmproj-Qwen3.8-27B-Q8_0.gguf'] },
    { name: 'Qwen 3.8 27B Heretic Q6_K', group: 'Qwen 3.8 27B Heretic', description: 'Qwen 3.8 27B RVN Heretic · Q6, near-lossless. For high-VRAM setups.', pulls: '1.2M+', tags: ['27B', 'Vision', 'Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'RVN-Q6_K-multilingual.gguf'), filename: 'RVN-Q6_K-multilingual.gguf', sizeGB: 22.1, ...IMAGE_PART['0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/mmproj-Qwen3.8-27B-Q8_0.gguf'] },
    // ── Gemma 4 12B Heretic ───────────────────────────────────────────
    //
    // Die Luecke, die dem Katalog am meisten gefehlt hat: alles Unzensierte
    // hier ist Qwen oder GLM. Wer mit Gemma anders zurechtkommt — und viele
    // tun das —, hatte keine Wahl. 302K Downloads, Architektur `gemma4` am
    // 02.09.2026 aus dem Dateikopf gelesen, von b9949 getragen.
    { name: 'Gemma 4 12B Heretic', group: 'Gemma 4 12B Heretic', description: 'Gemma 4 12B heretic-abliterated · the uncensored counterpart to Qwen and GLM, with a different voice. Vision. Recommended size.', pulls: '300K+', tags: ['12B', 'Vision', 'Q4_K_M', '7 GB'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-Q4_K_M.gguf'), filename: 'gemma-4-12b-heretic-Q4_K_M.gguf', sizeGB: 7.4, ...IMAGE_PART['culturerevolt/gemma-4-12b-heretic-abliterated-GGUF/gemma-4-12b-heretic-mmproj-f16.gguf'] },
    { name: 'Gemma 4 12B Heretic IQ4_XS', group: 'Gemma 4 12B Heretic', description: 'Gemma 4 12B heretic · IQ4_XS, the cheapest 4-bit. For 8 GB cards.', pulls: '300K+', tags: ['12B', 'Vision', 'IQ4_XS', '7 GB'], updated: 'New', agent: true, released: '2026-06', downloadUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-IQ4_XS.gguf'), filename: 'gemma-4-12b-heretic-IQ4_XS.gguf', sizeGB: 6.6, ...IMAGE_PART['culturerevolt/gemma-4-12b-heretic-abliterated-GGUF/gemma-4-12b-heretic-mmproj-f16.gguf'] },
    { name: 'Gemma 4 12B Heretic Q6_K', group: 'Gemma 4 12B Heretic', description: 'Gemma 4 12B heretic · Q6, near-lossless.', pulls: '300K+', tags: ['12B', 'Vision', 'Q6_K', '10 GB'], updated: 'New', agent: true, released: '2026-06', downloadUrl: HF('culturerevolt/gemma-4-12b-heretic-abliterated-GGUF', 'gemma-4-12b-heretic-Q6_K.gguf'), filename: 'gemma-4-12b-heretic-Q6_K.gguf', sizeGB: 9.8, ...IMAGE_PART['culturerevolt/gemma-4-12b-heretic-abliterated-GGUF/gemma-4-12b-heretic-mmproj-f16.gguf'] },
    // ── Qwen3-VL 8B Abliterated ───────────────────────────────────────
    //
    // Die zweite echte Luecke: alles Unzensierte mit Bildverstehen ist hier
    // 27B aufwaerts. Wer eine 8-GB-Karte hat, konnte Bilder nur zensiert
    // ansehen lassen. Das hier laeuft in 5 GB. Architektur `qwen3vl`, am
    // 02.09.2026 aus dem Dateikopf gelesen, von b9949 getragen.
    { name: 'Qwen3-VL 8B Abliterated', group: 'Qwen3-VL 8B Abliterated', description: 'Qwen3-VL 8B abliterated · uncensored image understanding on an 8 GB card. Recommended size.', pulls: '650K+', tags: ['8B', 'Vision', 'Q4_K_M', '5 GB'], updated: 'Hot', agent: true, released: '2025-11', downloadUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Qwen3-VL-8B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 5, ...IMAGE_PART['mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF/Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf'] },
    { name: 'Qwen3-VL 8B Abliterated Q5_K_M', group: 'Qwen3-VL 8B Abliterated', description: 'Qwen3-VL 8B abliterated · Q5, higher quality.', pulls: '650K+', tags: ['8B', 'Vision', 'Q5_K_M', '6 GB'], updated: 'New', agent: true, released: '2025-11', downloadUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.Q5_K_M.gguf'), filename: 'Qwen3-VL-8B-Instruct-abliterated.Q5_K_M.gguf', sizeGB: 5.9, ...IMAGE_PART['mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF/Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf'] },
    { name: 'Qwen3-VL 8B Abliterated Q6_K', group: 'Qwen3-VL 8B Abliterated', description: 'Qwen3-VL 8B abliterated · Q6, near-lossless.', pulls: '650K+', tags: ['8B', 'Vision', 'Q6_K', '7 GB'], updated: 'New', agent: true, released: '2025-11', downloadUrl: HF('mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF', 'Qwen3-VL-8B-Instruct-abliterated.Q6_K.gguf'), filename: 'Qwen3-VL-8B-Instruct-abliterated.Q6_K.gguf', sizeGB: 6.7, ...IMAGE_PART['mradermacher/Qwen3-VL-8B-Instruct-abliterated-GGUF/Qwen3-VL-8B-Instruct-abliterated.mmproj-f16.gguf'] },
    // ── Lightweight pinned for CPU-only / ≤8 GB RAM (F4 GH#21) ──
    { name: 'Llama 3.2 3B Abliterated', description: 'Meta Llama 3.2 3B abliterated · proven small unfiltered, low resource footprint.', pulls: '50K+', tags: ['3B', 'Q4_K_M', '2 GB'], updated: 'Popular', agent: true, lightweight: true, released: '2024-09', downloadUrl: HF('mradermacher/Llama-3.2-3B-Instruct-abliterated-GGUF', 'Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf'), filename: 'Llama-3.2-3B-Instruct-abliterated.Q4_K_M.gguf', sizeGB: 2 },
    // ── Popular: Qwen 2.5 Abliterated ──
    { name: 'Qwen 2.5 7B Abliterated', description: 'Qwen 2.5 7B abliterated · proven and reliable.', pulls: '50K+', tags: ['7B', 'Q4_K_M', '5 GB'], updated: 'Popular', agent: true, released: '2024-09', downloadUrl: HF('QuantFactory/Qwen2.5-7B-Instruct-abliterated-v2-GGUF', 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf'), filename: 'Qwen2.5-7B-Instruct-abliterated-v2.Q4_K_M.gguf', sizeGB: 5 },
    // ── Popular: Single-size unfiltered ──
    { name: 'Llama 3.3 70B Abliterated', description: 'Llama 3.3 70B abliterated · maximum intelligence for high-VRAM setups.', pulls: '15K+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/Llama-3.3-70B-Instruct-abliterated-GGUF', 'Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf'), filename: 'Llama-3.3-70B-Instruct-abliterated-Q4_K_M.gguf', sizeGB: 42 },
    // ── 2026-07-17 catalog refresh (May to July 2026 wave, HF-API-verified
    //    repos/filenames/sizes; DL counts from HF at research time) ──
    { name: 'Qwen 3.6 40B Deckard Heretic', description: 'DavidAU Qwen 3.6 40B Deckard · Heretic uncensored thinking + code model, Claude-Opus-distill flavor. The top unfiltered release of mid-2026 (380K+ downloads).', pulls: '384K+', tags: ['40B', 'Vision', 'Q4_K_M', '23 GB', 'Heretic'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-NEO-CODE-Di-IMatrix-MAX-GGUF', 'Qwen3.6-40B-Deck-Opus-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf'), filename: 'Qwen3.6-40B-Deck-Opus-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf', sizeGB: 23, ...IMAGE_PART['DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-NEO-CODE-Di-IMatrix-MAX-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.6 27B Heretic Finetune', description: 'DavidAU Qwen 3.6 27B · Heretic uncensored finetune with NEO-CODE tuning. Strongest 27B-class unfiltered.', pulls: '156K+', tags: ['27B', 'Vision', 'Q4_K_M', '16 GB', 'Heretic'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('DavidAU/Qwen3.6-27B-Heretic-Uncensored-FINETUNE-NEO-CODE-Di-IMatrix-MAX-GGUF', 'Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf'), filename: 'Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q4_K_M.gguf', sizeGB: 16, ...IMAGE_PART['DavidAU/Qwen3.6-27B-Heretic-Uncensored-FINETUNE-NEO-CODE-Di-IMatrix-MAX-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.6 27B Abliterated', description: 'huihui Qwen 3.6 27B abliterated · clean uncensor of the newest Qwen dense model.', pulls: '95K+', tags: ['27B', 'Vision', 'Q4_K', '16 GB'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('huihui-ai/Huihui-Qwen3.6-27B-abliterated-MTP-GGUF', 'Huihui-Qwen3.6-27B-abliterated-ggml-model-Q4_K.gguf'), filename: 'Huihui-Qwen3.6-27B-abliterated-ggml-model-Q4_K.gguf', sizeGB: 16, ...IMAGE_PART['huihui-ai/Huihui-Qwen3.6-27B-abliterated-MTP-GGUF/mmproj-model-f16.gguf'] },
    { name: 'Qwen 3.6 35B MoE Opus Abliterated', description: 'huihui Qwen 3.6 35B MoE · Claude-4.7-Opus-distill flavor, abliterated. Fast 3B-active MoE.', pulls: '42K+', tags: ['35B MoE', 'Vision', 'Q4_K', '20 GB'], updated: 'New', agent: true, released: '2026-05', downloadUrl: HF('huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-MTP-GGUF', 'Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-ggml-model-Q4_K.gguf'), filename: 'Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-ggml-model-Q4_K.gguf', sizeGB: 20, ...IMAGE_PART['huihui-ai/Huihui-Qwen3.6-35B-A3B-Claude-4.7-Opus-abliterated-MTP-GGUF/mmproj-model-f16.gguf'] },
    { name: 'Qwythos 9B Mythos Abliterated', description: 'huihui Qwythos 9B · community Claude-Mythos distill on Qwen 3.5, abliterated. Creative-writing hit of June 2026.', pulls: '90K+', tags: ['9B', 'Vision', 'Q4_K', '5.4 GB'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF', 'Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-Q4_K.gguf'), filename: 'Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-Q4_K.gguf', sizeGB: 5.4, ...IMAGE_PART['huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Gemma 4 12B Abliterated', description: 'huihui Gemma 4 12B QAT abliterated · the first solid Gemma 4 uncensor, vision-capable base.', pulls: '33K+', tags: ['12B', 'Vision', 'Q4_K', '6.9 GB'], updated: 'New', released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF', 'Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf'), filename: 'Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf', sizeGB: 6.9, ...IMAGE_PART['huihui-ai/Huihui-gemma-4-12B-it-qat-q4_0-unquantized-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Agents A1 Abliterated', description: 'huihui abliterated Agents-A1 · uncensored 35B MoE (3B active) agent model, a rare combo. Apache-2.0.', pulls: '10K+', tags: ['35B MoE', 'Vision', 'Q4_K', '20 GB'], updated: 'New', agent: true, released: '2026-07', downloadUrl: HF('huihui-ai/Huihui-Agents-A1-abliterated-GGUF', 'Agents-A1-abliterated-Q4_K.gguf'), filename: 'Agents-A1-abliterated-Q4_K.gguf', sizeGB: 20, ...IMAGE_PART['huihui-ai/Huihui-Agents-A1-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Rocinante XL 16B', description: 'TheDrummer Rocinante XL · roleplay / creative-writing specialist, successor to the classic Rocinante.', pulls: '6K+', tags: ['16B', 'Q4_K_M', '9.1 GB', 'RP'], updated: 'New', released: '2026-04', downloadUrl: HF('TheDrummer/Rocinante-XL-16B-v1-GGUF', 'Rocinante-XL-16B-v1a-Q4_K_M.gguf'), filename: 'Rocinante-XL-16B-v1a-Q4_K_M.gguf', sizeGB: 9.1 },
    // DeepSeek V4 Flash 0731, abliterated by huihui. Replaces the two entries
    // that pointed at huihui-ai/Huihui-DeepSeek-V4-Flash-abliterated-GGUF, which
    // answered HTTP 401 from 2026-09-01 on. Repo and file read from the Hugging
    // Face tree on 2026-10-08, architecture deepseek4.
    //
    // The names end in `-0731.gguf`, so no quant can be read from them. Until
    // 2026-10-08 the download knew a file only by its quant, and every card of
    // this repo would have fetched the first file of the tree. Since then the
    // named file decides (`selectGgufFromTree`, exactPath), and Q4_K is listed
    // next to Q2. The repo also carries Q2_K (98 GB), not listed.
    { name: 'DeepSeek V4 Flash 0731 Abliterated', group: 'DeepSeek V4 Flash 0731 Abliterated', description: 'huihui abliterated DeepSeek V4-Flash-0731 · 284B MoE (13B active), the uncensored build of the official V4-Flash release. Single 87 GB file, needs about 96 GB of memory or more. MIT.', pulls: '354K+', tags: ['284B MoE', 'Q2', '87 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF', 'DeepSeek-V4-Flash-Q2-0731.gguf'), filename: 'DeepSeek-V4-Flash-Q2-0731.gguf', sizeGB: 86.72 },
    { name: 'DeepSeek V4 Flash 0731 Abliterated Q4_K', group: 'DeepSeek V4 Flash 0731 Abliterated', description: 'huihui abliterated DeepSeek V4-Flash-0731 · higher quality quant. Single 165 GB file, needs about 180 GB of memory or more.', pulls: '354K+', tags: ['284B MoE', 'Q4_K', '165 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('huihui-ai/Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF', 'DeepSeek-V4-Flash-Q4_K-0731.gguf'), filename: 'DeepSeek-V4-Flash-Q4_K-0731.gguf', sizeGB: 164.63 },
    { name: 'GLM 5.2 Abliterated', description: 'huihui abliterated GLM 5.2 · 744B MoE (40B active) uncensored frontier coder. Multi-part download, ~356 GB. MIT.', pulls: '13K+', tags: ['744B MoE', 'UD-Q3_K_M', '356 GB', 'Multi-part'], updated: 'New', agent: true, released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-GLM-5.2-abliterated-GGUF', 'UD-Q3_K_M/GLM-5.2-UD-Q3_K_M-00001-of-00009.gguf'), filename: 'GLM-5.2-UD-Q3_K_M-00001-of-00009.gguf', sizeGB: 356 },
    // 2026-10-08 catalog refresh. Repos, file names and sizes read from the
    // Hugging Face tree API on that day; every architecture is one the pinned
    // llama.cpp lists. Nothing here was loaded in the engine. The download
    // takes the file named here (`selectGgufFromTree`, exactPath), which
    // `katalog-datei-ist-die-geladene.test.ts` proves for every entry.
    //
    // HauhauCS names most of its quants Q*_K_P. No quant is read from that
    // suffix, so these files are reachable only by name. The Q4_K_P and Q8_K_P
    // cards came in on 2026-10-08, once the named file decided.
    { name: 'Qwen 3.8 27B HauhauCS Aggressive', group: 'Qwen 3.8 27B HauhauCS Aggressive', description: 'HauhauCS Qwen 3.8 27B uncensored, Aggressive variant · vision, tool calling and thinking. The files carry an MTP head. Recommended quant. The 0.9 GB vision projector comes with it.', pulls: '2.1M', tags: ['27B', 'Vision', 'IQ4_XS', '16 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf'), filename: 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf', sizeGB: 15.71, ...IMAGE_PART['HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf'] },
    { name: 'Qwen 3.8 27B HauhauCS Aggressive IQ2_M', group: 'Qwen 3.8 27B HauhauCS Aggressive', description: 'HauhauCS Qwen 3.8 27B uncensored, Aggressive variant · smallest quant.', pulls: '2.1M', tags: ['27B', 'Vision', 'IQ2_M', '10 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ2_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ2_M.gguf', sizeGB: 10.32, ...IMAGE_PART['HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf'] },
    { name: 'Qwen 3.8 27B HauhauCS Aggressive IQ3_M', group: 'Qwen 3.8 27B HauhauCS Aggressive', description: 'HauhauCS Qwen 3.8 27B uncensored, Aggressive variant · middle quant.', pulls: '2.1M', tags: ['27B', 'Vision', 'IQ3_M', '13 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ3_M.gguf'), filename: 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ3_M.gguf', sizeGB: 12.79, ...IMAGE_PART['HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf'] },
    { name: 'Qwen 3.8 27B HauhauCS Aggressive Q4_K_P', group: 'Qwen 3.8 27B HauhauCS Aggressive', description: 'HauhauCS Qwen 3.8 27B uncensored, Aggressive variant · higher quality quant.', pulls: '2.1M', tags: ['27B', 'Vision', 'Q4_K_P', '18 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf'), filename: 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf', sizeGB: 17.92, ...IMAGE_PART['HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf'] },
    { name: 'Qwen 3.8 27B HauhauCS Aggressive Q8_K_P', group: 'Qwen 3.8 27B HauhauCS Aggressive', description: 'HauhauCS Qwen 3.8 27B uncensored, Aggressive variant · largest quant, closest to the original weights.', pulls: '2.1M', tags: ['27B', 'Vision', 'Q8_K_P', '31 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf'), filename: 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf', sizeGB: 31.46, ...IMAGE_PART['HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF/mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf'] },
    { name: 'Gemma 4 12B QAT HauhauCS', description: 'HauhauCS Gemma 4 12B QAT uncensored, Balanced variant · built on Google\'s quantization-aware weights. Vision. The 0.2 GB vision projector comes with it.', pulls: '984K+', tags: ['12B', 'Vision', 'Q4_K_M', '7.4 GB'], updated: 'Hot', released: '2026-06', downloadUrl: HF('HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced', 'Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf'), filename: 'Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf', sizeGB: 7.38, ...IMAGE_PART['HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced/mmproj-Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf'] },
    { name: 'Gemma 4 E4B HauhauCS', group: 'Gemma 4 E4B HauhauCS', description: 'HauhauCS Gemma 4 E4B uncensored, Aggressive variant · small 4.5B model with vision. The 1 GB vision projector comes with it.', pulls: '1.4M', tags: ['4.5B', 'Vision', 'Q4_K_M', '5.3 GB'], updated: 'Hot', lightweight: true, released: '2026-04', downloadUrl: HF('HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive', 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf'), filename: 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf', sizeGB: 5.34, ...IMAGE_PART['HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf'] },
    { name: 'Gemma 4 E4B HauhauCS Q3_K_M', group: 'Gemma 4 E4B HauhauCS', description: 'HauhauCS Gemma 4 E4B uncensored, Aggressive variant · smaller quant.', pulls: '1.4M', tags: ['4.5B', 'Vision', 'Q3_K_M', '4.8 GB'], updated: 'New', lightweight: true, released: '2026-04', downloadUrl: HF('HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive', 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q3_K_M.gguf'), filename: 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q3_K_M.gguf', sizeGB: 4.85, ...IMAGE_PART['HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf'] },
    { name: 'Gemma 4 E4B HauhauCS Q5_K_M', group: 'Gemma 4 E4B HauhauCS', description: 'HauhauCS Gemma 4 E4B uncensored, Aggressive variant · higher quality quant.', pulls: '1.4M', tags: ['4.5B', 'Vision', 'Q5_K_M', '5.8 GB'], updated: 'New', lightweight: true, released: '2026-04', downloadUrl: HF('HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive', 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf'), filename: 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf', sizeGB: 5.76, ...IMAGE_PART['HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf'] },
    { name: 'Gemma 4 E4B HauhauCS Q8_K_P', group: 'Gemma 4 E4B HauhauCS', description: 'HauhauCS Gemma 4 E4B uncensored, Aggressive variant · largest quant, closest to the original weights.', pulls: '1.4M', tags: ['4.5B', 'Vision', 'Q8_K_P', '8.1 GB'], updated: 'New', lightweight: true, released: '2026-04', downloadUrl: HF('HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive', 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf'), filename: 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf', sizeGB: 8.13, ...IMAGE_PART['HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf'] },
    // Gemma 4 QAT abliterations by huihui: E2B for 8 GB machines, 31B on top
    { name: 'Gemma 4 E2B Abliterated', description: 'huihui Gemma 4 E2B QAT abliterated · small 2.3B model with vision for 8 GB machines. The 1 GB vision projector comes with it.', pulls: '6K+', tags: ['2.3B', 'Vision', 'Q4_K', '3.4 GB'], updated: 'New', lightweight: true, released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-gemma-4-E2B-it-qat-q4_0-unquantized-abliterated-GGUF', 'Huihui-gemma-4-E2B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf'), filename: 'Huihui-gemma-4-E2B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf', sizeGB: 3.42, ...IMAGE_PART['huihui-ai/Huihui-gemma-4-E2B-it-qat-q4_0-unquantized-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    { name: 'Gemma 4 31B QAT Abliterated', description: 'huihui Gemma 4 31B QAT abliterated · built on Google\'s quantization-aware weights, newer than the three April builds. Vision. The 1.2 GB vision projector comes with it.', pulls: '9K+', tags: ['31B', 'Vision', 'Q4_K', '19 GB'], updated: 'New', released: '2026-06', downloadUrl: HF('huihui-ai/Huihui-gemma-4-31B-it-qat-q4_0-unquantized-abliterated-GGUF', 'Huihui-gemma-4-31B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf'), filename: 'Huihui-gemma-4-31B-it-qat-q4_0-unquantized-abliterated-Q4_K.gguf', sizeGB: 18.69, ...IMAGE_PART['huihui-ai/Huihui-gemma-4-31B-it-qat-q4_0-unquantized-abliterated-GGUF/mmproj-model-bf16.gguf'] },
    // Ornith 1.5 uncensored (August 2026), in place of Ornith 1.0 35B Heretic
    { name: 'Ornith 1.5 9B Uncensored', group: 'Ornith 1.5 9B Uncensored', description: 'Ornith 1.5 9B uncensored · the coding and agent model without refusals, with vision and tool calling. Recommended quant. The 0.9 GB vision projector comes with it.', pulls: '1.3M', tags: ['9B', 'Vision', 'Q4_K_M', '5.6 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('mradermacher/Ornith-1.5-9B-uncensored-GGUF', 'Ornith-1.5-9B-uncensored.Q4_K_M.gguf'), filename: 'Ornith-1.5-9B-uncensored.Q4_K_M.gguf', sizeGB: 5.63, ...IMAGE_PART['mradermacher/Ornith-1.5-9B-uncensored-GGUF/Ornith-1.5-9B-uncensored.mmproj-f16.gguf'] },
    { name: 'Ornith 1.5 9B Uncensored Q2_K', group: 'Ornith 1.5 9B Uncensored', description: 'Ornith 1.5 9B uncensored · smallest quant, for 8 GB machines.', pulls: '1.3M', tags: ['9B', 'Vision', 'Q2_K', '3.8 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('mradermacher/Ornith-1.5-9B-uncensored-GGUF', 'Ornith-1.5-9B-uncensored.Q2_K.gguf'), filename: 'Ornith-1.5-9B-uncensored.Q2_K.gguf', sizeGB: 3.83, ...IMAGE_PART['mradermacher/Ornith-1.5-9B-uncensored-GGUF/Ornith-1.5-9B-uncensored.mmproj-f16.gguf'] },
    { name: 'Ornith 1.5 9B Uncensored Q8_0', group: 'Ornith 1.5 9B Uncensored', description: 'Ornith 1.5 9B uncensored · largest quant, closest to the original weights.', pulls: '1.3M', tags: ['9B', 'Vision', 'Q8_0', '9.5 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('mradermacher/Ornith-1.5-9B-uncensored-GGUF', 'Ornith-1.5-9B-uncensored.Q8_0.gguf'), filename: 'Ornith-1.5-9B-uncensored.Q8_0.gguf', sizeGB: 9.53, ...IMAGE_PART['mradermacher/Ornith-1.5-9B-uncensored-GGUF/Ornith-1.5-9B-uncensored.mmproj-f16.gguf'] },
    { name: 'Ornith 1.5 35B MoE Abliterated', group: 'Ornith 1.5 35B MoE Abliterated', description: 'huihui Ornith 1.5 35B MoE abliterated · the larger Ornith 1.5 without refusals, 3B active parameters. Vision and tool calling. Recommended quant. The 0.9 GB vision projector comes with it. MIT.', pulls: '4K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF', 'Huihui-Ornith-1.5-35B-A3B-abliterated.Q4_K_M.gguf'), filename: 'Huihui-Ornith-1.5-35B-A3B-abliterated.Q4_K_M.gguf', sizeGB: 21.71, ...IMAGE_PART['mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF/Huihui-Ornith-1.5-35B-A3B-abliterated.mmproj-f16.gguf'] },
    { name: 'Ornith 1.5 35B MoE Abliterated Q2_K', group: 'Ornith 1.5 35B MoE Abliterated', description: 'huihui Ornith 1.5 35B MoE abliterated · smallest quant, for 16 GB machines.', pulls: '4K+', tags: ['35B MoE', 'Vision', 'Q2_K', '13 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF', 'Huihui-Ornith-1.5-35B-A3B-abliterated.Q2_K.gguf'), filename: 'Huihui-Ornith-1.5-35B-A3B-abliterated.Q2_K.gguf', sizeGB: 13.25, ...IMAGE_PART['mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF/Huihui-Ornith-1.5-35B-A3B-abliterated.mmproj-f16.gguf'] },
    { name: 'Ornith 1.5 35B MoE Abliterated Q8_0', group: 'Ornith 1.5 35B MoE Abliterated', description: 'huihui Ornith 1.5 35B MoE abliterated · largest quant, closest to the original weights.', pulls: '4K+', tags: ['35B MoE', 'Vision', 'Q8_0', '38 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF', 'Huihui-Ornith-1.5-35B-A3B-abliterated.Q8_0.gguf'), filename: 'Huihui-Ornith-1.5-35B-A3B-abliterated.Q8_0.gguf', sizeGB: 37.8, ...IMAGE_PART['mradermacher/Huihui-Ornith-1.5-35B-A3B-abliterated-GGUF/Huihui-Ornith-1.5-35B-A3B-abliterated.mmproj-f16.gguf'] },
    // Qwen 3.5 9B The Defiant Fable (DavidAU). The repo carries every K quant
    // twice, plain and with an MTP head, and the MTP file sorts first. A quant
    // alone would therefore fetch the MTP build. The download takes the named
    // file, so the plain Q4_K_M and Q8_0 are listed since 2026-10-08.
    { name: 'Qwen 3.5 9B Defiant Fable Heretic', group: 'Qwen 3.5 9B Defiant Fable Heretic', description: 'DavidAU Qwen 3.5 9B The Defiant Fable · Heretic uncensored finetune with vision and thinking. Recommended quant. The 0.9 GB vision projector comes with it. Apache-2.0.', pulls: '2.0M', tags: ['9B', 'Vision', 'IQ4_XS', '6.4 GB', 'Heretic'], updated: 'Hot', released: '2026-07', downloadUrl: HF('DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ4_XS.gguf'), filename: 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ4_XS.gguf', sizeGB: 6.4, ...IMAGE_PART['DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.5 9B Defiant Fable Heretic IQ2_M', group: 'Qwen 3.5 9B Defiant Fable Heretic', description: 'DavidAU Qwen 3.5 9B The Defiant Fable · smallest quant, for 8 GB machines.', pulls: '2.0M', tags: ['9B', 'Vision', 'IQ2_M', '4.9 GB', 'Heretic'], updated: 'New', released: '2026-07', downloadUrl: HF('DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ2_M.gguf'), filename: 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ2_M.gguf', sizeGB: 4.94, ...IMAGE_PART['DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.5 9B Defiant Fable Heretic IQ3_M', group: 'Qwen 3.5 9B Defiant Fable Heretic', description: 'DavidAU Qwen 3.5 9B The Defiant Fable · middle quant.', pulls: '2.0M', tags: ['9B', 'Vision', 'IQ3_M', '5.6 GB', 'Heretic'], updated: 'New', released: '2026-07', downloadUrl: HF('DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ3_M.gguf'), filename: 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ3_M.gguf', sizeGB: 5.62, ...IMAGE_PART['DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.5 9B Defiant Fable Heretic Q4_K_M', group: 'Qwen 3.5 9B Defiant Fable Heretic', description: 'DavidAU Qwen 3.5 9B The Defiant Fable · higher quality quant, without the MTP head.', pulls: '2.0M', tags: ['9B', 'Vision', 'Q4_K_M', '6.8 GB', 'Heretic'], updated: 'New', released: '2026-07', downloadUrl: HF('DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_M.gguf'), filename: 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_M.gguf', sizeGB: 6.83, ...IMAGE_PART['DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.5 9B Defiant Fable Heretic Q8_0', group: 'Qwen 3.5 9B Defiant Fable Heretic', description: 'DavidAU Qwen 3.5 9B The Defiant Fable · largest quant, closest to the original weights, without the MTP head.', pulls: '2.0M', tags: ['9B', 'Vision', 'Q8_0', '10 GB', 'Heretic'], updated: 'New', released: '2026-07', downloadUrl: HF('DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q8_0.gguf'), filename: 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q8_0.gguf', sizeGB: 10.48, ...IMAGE_PART['DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF/mmproj-F16.gguf'] },
    // Small uncensored models for 8 GB machines (below the 7B chat minimum)
    { name: 'Qwen 3.5 4B Abliterated', group: 'Qwen 3.5 4B Abliterated', description: 'huihui Qwen 3.5 4B abliterated · small unfiltered model with vision and tool calling. The 0.7 GB vision projector comes with it. Apache-2.0.', pulls: '32K+', tags: ['4B', 'Vision', 'Q4_K_M', '2.7 GB'], updated: 'New', agent: true, lightweight: true, released: '2026-03', downloadUrl: HF('mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF', 'Huihui-Qwen3.5-4B-abliterated.Q4_K_M.gguf'), filename: 'Huihui-Qwen3.5-4B-abliterated.Q4_K_M.gguf', sizeGB: 2.71, ...IMAGE_PART['mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/Huihui-Qwen3.5-4B-abliterated.mmproj-f16.gguf'] },
    { name: 'Qwen 3.5 4B Abliterated Q2_K', group: 'Qwen 3.5 4B Abliterated', description: 'huihui Qwen 3.5 4B abliterated · smallest quant.', pulls: '32K+', tags: ['4B', 'Vision', 'Q2_K', '1.8 GB'], updated: 'New', agent: true, lightweight: true, released: '2026-03', downloadUrl: HF('mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF', 'Huihui-Qwen3.5-4B-abliterated.Q2_K.gguf'), filename: 'Huihui-Qwen3.5-4B-abliterated.Q2_K.gguf', sizeGB: 1.8, ...IMAGE_PART['mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/Huihui-Qwen3.5-4B-abliterated.mmproj-f16.gguf'] },
    { name: 'Qwen 3.5 4B Abliterated Q8_0', group: 'Qwen 3.5 4B Abliterated', description: 'huihui Qwen 3.5 4B abliterated · largest quant, closest to the original weights.', pulls: '32K+', tags: ['4B', 'Vision', 'Q8_0', '4.5 GB'], updated: 'New', agent: true, lightweight: true, released: '2026-03', downloadUrl: HF('mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF', 'Huihui-Qwen3.5-4B-abliterated.Q8_0.gguf'), filename: 'Huihui-Qwen3.5-4B-abliterated.Q8_0.gguf', sizeGB: 4.48, ...IMAGE_PART['mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF/Huihui-Qwen3.5-4B-abliterated.mmproj-f16.gguf'] },
    { name: 'LFM 2.5 2.6B Heretic', group: 'LFM 2.5 2.6B Heretic', description: 'Liquid AI LFM 2.5 2.6B, Heretic abliterated · the smallest uncensored model here, text only. Few downloads so far.', pulls: '3K+', tags: ['2.6B', 'Q4_K_M', '1.7 GB', 'Heretic'], updated: 'New', lightweight: true, released: '2026-08', downloadUrl: HF('Abiray/LFM2.5-2.6B-Heretic-Abliterated-GGUF', 'LFM2.5-2.6B-heretic-Q4_K_M.gguf'), filename: 'LFM2.5-2.6B-heretic-Q4_K_M.gguf', sizeGB: 1.67 },
    { name: 'LFM 2.5 2.6B Heretic Q3_K_M', group: 'LFM 2.5 2.6B Heretic', description: 'Liquid AI LFM 2.5 2.6B, Heretic abliterated · smallest quant.', pulls: '3K+', tags: ['2.6B', 'Q3_K_M', '1.4 GB', 'Heretic'], updated: 'New', lightweight: true, released: '2026-08', downloadUrl: HF('Abiray/LFM2.5-2.6B-Heretic-Abliterated-GGUF', 'LFM2.5-2.6B-heretic-Q3_K_M.gguf'), filename: 'LFM2.5-2.6B-heretic-Q3_K_M.gguf', sizeGB: 1.37 },
    { name: 'LFM 2.5 2.6B Heretic Q8_0', group: 'LFM 2.5 2.6B Heretic', description: 'Liquid AI LFM 2.5 2.6B, Heretic abliterated · largest quant, closest to the original weights.', pulls: '3K+', tags: ['2.6B', 'Q8_0', '2.9 GB', 'Heretic'], updated: 'New', lightweight: true, released: '2026-08', downloadUrl: HF('Abiray/LFM2.5-2.6B-Heretic-Abliterated-GGUF', 'LFM2.5-2.6B-heretic-Q8_0.gguf'), filename: 'LFM2.5-2.6B-heretic-Q8_0.gguf', sizeGB: 2.87 },
    // TheDrummer on Gemma 4 (September 2026), in place of Cydonia 24B v4.3.
    // The repos name no license.
    { name: 'Artemis 31B v1.2', group: 'Artemis 31B v1.2', description: 'TheDrummer Artemis 31B · roleplay and creative-writing finetune on a Gemma 4 base, with vision. Recommended quant. The 1.2 GB vision projector comes with it.', pulls: '26K+', tags: ['31B', 'Vision', 'Q4_K_M', '20 GB', 'RP'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/TheDrummer_Artemis-31B-v1.2-GGUF', 'TheDrummer_Artemis-31B-v1.2-Q4_K_M.gguf'), filename: 'TheDrummer_Artemis-31B-v1.2-Q4_K_M.gguf', sizeGB: 19.52, ...IMAGE_PART['bartowski/TheDrummer_Artemis-31B-v1.2-GGUF/mmproj-TheDrummer_Artemis-31B-v1.2-f16.gguf'] },
    { name: 'Artemis 31B v1.2 IQ2_M', group: 'Artemis 31B v1.2', description: 'TheDrummer Artemis 31B · smallest quant, for 16 GB machines.', pulls: '26K+', tags: ['31B', 'Vision', 'IQ2_M', '11 GB', 'RP'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/TheDrummer_Artemis-31B-v1.2-GGUF', 'TheDrummer_Artemis-31B-v1.2-IQ2_M.gguf'), filename: 'TheDrummer_Artemis-31B-v1.2-IQ2_M.gguf', sizeGB: 11.34, ...IMAGE_PART['bartowski/TheDrummer_Artemis-31B-v1.2-GGUF/mmproj-TheDrummer_Artemis-31B-v1.2-f16.gguf'] },
    { name: 'Artemis 31B v1.2 Q8_0', group: 'Artemis 31B v1.2', description: 'TheDrummer Artemis 31B · largest quant, closest to the original weights.', pulls: '26K+', tags: ['31B', 'Vision', 'Q8_0', '33 GB', 'RP'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/TheDrummer_Artemis-31B-v1.2-GGUF', 'TheDrummer_Artemis-31B-v1.2-Q8_0.gguf'), filename: 'TheDrummer_Artemis-31B-v1.2-Q8_0.gguf', sizeGB: 32.64, ...IMAGE_PART['bartowski/TheDrummer_Artemis-31B-v1.2-GGUF/mmproj-TheDrummer_Artemis-31B-v1.2-f16.gguf'] },
    { name: 'Orion 26B MoE v1.1', group: 'Orion 26B MoE v1.1', description: 'TheDrummer Orion 26B MoE · roleplay finetune on the Gemma 4 MoE base, 4B active parameters, with vision. Recommended quant. The 1.2 GB vision projector comes with it.', pulls: '36K+', tags: ['26B MoE', 'Vision', 'Q4_K_M', '18 GB', 'RP'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF', 'TheDrummer_Orion-26B-A4B-v1.1-Q4_K_M.gguf'), filename: 'TheDrummer_Orion-26B-A4B-v1.1-Q4_K_M.gguf', sizeGB: 17.97, ...IMAGE_PART['bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF/mmproj-TheDrummer_Orion-26B-A4B-v1.1-f16.gguf'] },
    { name: 'Orion 26B MoE v1.1 IQ2_M', group: 'Orion 26B MoE v1.1', description: 'TheDrummer Orion 26B MoE · smallest quant, for 16 GB machines.', pulls: '36K+', tags: ['26B MoE', 'Vision', 'IQ2_M', '11 GB', 'RP'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF', 'TheDrummer_Orion-26B-A4B-v1.1-IQ2_M.gguf'), filename: 'TheDrummer_Orion-26B-A4B-v1.1-IQ2_M.gguf', sizeGB: 10.9, ...IMAGE_PART['bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF/mmproj-TheDrummer_Orion-26B-A4B-v1.1-f16.gguf'] },
    { name: 'Orion 26B MoE v1.1 Q8_0', group: 'Orion 26B MoE v1.1', description: 'TheDrummer Orion 26B MoE · largest quant, closest to the original weights.', pulls: '36K+', tags: ['26B MoE', 'Vision', 'Q8_0', '27 GB', 'RP'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF', 'TheDrummer_Orion-26B-A4B-v1.1-Q8_0.gguf'), filename: 'TheDrummer_Orion-26B-A4B-v1.1-Q8_0.gguf', sizeGB: 26.86, ...IMAGE_PART['bartowski/TheDrummer_Orion-26B-A4B-v1.1-GGUF/mmproj-TheDrummer_Orion-26B-A4B-v1.1-f16.gguf'] },
    // GPT-OSS 120B abliterated. The base is wangzhang's abliteration, not huihui's.
    { name: 'GPT-OSS 120B Abliterated', group: 'GPT-OSS 120B Abliterated', description: 'GPT-OSS 120B abliterated · wangzhang\'s abliteration of the large open-weight GPT model, with tool calling. Single 88 GB file, for 128 GB machines. Few downloads so far. Apache-2.0.', pulls: '3K+', tags: ['120B', 'Q4_K_M', '88 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('mradermacher/gpt-oss-120b-abliterated-GGUF', 'gpt-oss-120b-abliterated.Q4_K_M.gguf'), filename: 'gpt-oss-120b-abliterated.Q4_K_M.gguf', sizeGB: 87.85 },
    { name: 'GPT-OSS 120B Abliterated Q2_K', group: 'GPT-OSS 120B Abliterated', description: 'GPT-OSS 120B abliterated · smallest quant, single 66 GB file, for 96 GB machines and up.', pulls: '3K+', tags: ['120B', 'Q2_K', '66 GB'], updated: 'New', agent: true, released: '2026-04', downloadUrl: HF('mradermacher/gpt-oss-120b-abliterated-GGUF', 'gpt-oss-120b-abliterated.Q2_K.gguf'), filename: 'gpt-oss-120b-abliterated.Q2_K.gguf', sizeGB: 66.15 },
  ])
}

/** Mainstream GGUF models · not unfiltered but excellent for specific tasks. All URLs verified. */
export function getMainstreamTextModels(): DiscoverModel[] {
  return sortByRelease([
    // ── 2026 SOTA sub-4GB TOOL CALLERS (deep-researched + adversarially
    //    verified 2026-06-06). All run in UNDER 4GB VRAM/RAM (Ultra-Lightweight
    //    weight class), commercially licensed (Apache-2.0 / MIT), native tool
    //    calling. The curated "good tool calls on weak hardware" set. ──
    { name: 'Phi-4 Mini', description: 'Microsoft Phi-4-mini (3.8B) · disciplined JSON-schema function calling, 128K context. Different tool format (<|tool|> tokens) than the Qwen/Granite trio, adds diversity. MIT.', pulls: '500K+', tags: ['3.8B', 'Q4_K_M', '2.4 GB', 'Tools'], updated: 'Hot', agent: true, lightweight: true, released: '2025-02', downloadUrl: HF('lmstudio-community/Phi-4-mini-instruct-GGUF', 'Phi-4-mini-instruct-Q4_K_M.gguf'), filename: 'Phi-4-mini-instruct-Q4_K_M.gguf', sizeGB: 2.4 },
    // ── Gemma 4 (April 2026) ──
    { name: 'Gemma 4 31B', description: 'Google Gemma 4 31B · frontier dense model, native tools + vision. 256K context.', pulls: '100K+', tags: ['31B', 'Vision', 'Q4_K_M', '17 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-31B-it-GGUF', 'gemma-4-31B-it-Q4_K_M.gguf'), filename: 'gemma-4-31B-it-Q4_K_M.gguf', sizeGB: 17, ...IMAGE_PART['unsloth/gemma-4-31B-it-GGUF/mmproj-F16.gguf'] },
    { name: 'Gemma 4 26B MoE', description: 'Gemma 4 26B MoE · 26B brain, runs like 4B. Tools + vision. Apache 2.0.', pulls: '100K+', tags: ['26B', 'Vision', 'Q4_K_XL', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/gemma-4-26B-A4B-it-GGUF', 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf'), filename: 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf', sizeGB: 16, ...IMAGE_PART['unsloth/gemma-4-26B-A4B-it-GGUF/mmproj-F16.gguf'] },
    { name: 'Gemma 4 12B (Q4)', group: 'Gemma 4 12B', description: 'Google Gemma 4 12B · Q4_K_M, ~7 GB, fits 8 GB GPUs. Native tools + vision, 128K context. lmstudio-community build (LM-Studio-curated) with a fixed tool-template, so tool calling works. Best on LM Studio (Ollama cannot load the gemma4 vision projector yet).', pulls: '100K+', tags: ['12B', 'Vision', 'Q4_K_M', '7 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('lmstudio-community/gemma-4-12b-it-GGUF', 'gemma-4-12B-it-Q4_K_M.gguf'), filename: 'gemma-4-12B-it-Q4_K_M.gguf', sizeGB: 7, ...IMAGE_PART['lmstudio-community/gemma-4-12b-it-GGUF/mmproj-gemma-4-12B-it-BF16.gguf'] },
    { name: 'Gemma 4 12B (Q6)', group: 'Gemma 4 12B', description: 'Google Gemma 4 12B · Q6_K, ~10 GB, fits 12 GB GPUs. Native tools + vision, 128K context. lmstudio-community build (LM-Studio-curated) with a fixed tool-template, so tool calling works. Best on LM Studio (Ollama cannot load the gemma4 vision projector yet).', pulls: '100K+', tags: ['12B', 'Vision', 'Q6_K', '10 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('lmstudio-community/gemma-4-12b-it-GGUF', 'gemma-4-12B-it-Q6_K.gguf'), filename: 'gemma-4-12B-it-Q6_K.gguf', sizeGB: 10, ...IMAGE_PART['lmstudio-community/gemma-4-12b-it-GGUF/mmproj-gemma-4-12B-it-BF16.gguf'] },
    { name: 'Gemma 4 12B (Q8)', group: 'Gemma 4 12B', description: 'Google Gemma 4 12B · Q8_0, near-lossless full quality. Native tools + vision, 128K context, ~13 GB. lmstudio-community build (LM-Studio-curated) with a fixed tool-template, so tool calling works out of the box. Best on LM Studio (Ollama cannot load the gemma4 vision projector yet).', pulls: '100K+', tags: ['12B', 'Vision', 'Q8_0', '13 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('lmstudio-community/gemma-4-12b-it-GGUF', 'gemma-4-12B-it-Q8_0.gguf'), filename: 'gemma-4-12B-it-Q8_0.gguf', sizeGB: 13, ...IMAGE_PART['lmstudio-community/gemma-4-12b-it-GGUF/mmproj-gemma-4-12B-it-BF16.gguf'] },
    { name: 'Gemma 4 E4B', description: 'Gemma 4 E4B · lightweight 4.5B, great for small GPUs.', pulls: '100K+', tags: ['4.5B', 'Vision', 'Q4_K_M', '5 GB'], updated: 'Hot', released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E4B-it-GGUF', 'gemma-4-E4B-it-Q4_K_M.gguf'), filename: 'gemma-4-E4B-it-Q4_K_M.gguf', sizeGB: 5, ...IMAGE_PART['unsloth/gemma-4-E4B-it-GGUF/mmproj-F16.gguf'] },
    { name: 'Gemma 4 E2B', description: 'Gemma 4 E2B · ultra-light 2.3B, runs on anything.', pulls: '100K+', tags: ['2.3B', 'Vision', 'Q4_K_M', '3 GB'], updated: 'New', released: '2026-04', downloadUrl: HF('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf'), filename: 'gemma-4-E2B-it-Q4_K_M.gguf', sizeGB: 3, ...IMAGE_PART['unsloth/gemma-4-E2B-it-GGUF/mmproj-F16.gguf'] },
    // ── Qwen 3.8 (August 2026) ──
    // Qwen shipped no GGUF of its own, so the 27B rides on unsloth's dynamic
    // quants (the most-downloaded conversion by a wide margin). Every 27B entry
    // pairs with the repo's mmproj so vision works on the built-in engine and in
    // LM Studio; the Ollama tag brings its own projector layer. The 9B distill
    // has no projector upstream and is therefore text-only.
    { name: 'Qwen 3.8 27B', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B dense · vision + tools + switchable thinking, 262K context. Unsloth dynamic Q4, the recommended default.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q4_K_M.gguf'), filename: 'Qwen3.8-27B-UD-Q4_K_M.gguf', sizeGB: 16.5, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B UD-IQ2_XXS', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · smallest dynamic quant, runs on an 8 GB card.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-IQ2_XXS', '7 GB'], updated: 'New', released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-IQ2_XXS.gguf'), filename: 'Qwen3.8-27B-UD-IQ2_XXS.gguf', sizeGB: 7.3, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B UD-IQ3_XXS', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · 3 bit dynamic, fits 12 GB with context to spare.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-IQ3_XXS', '11 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-IQ3_XXS.gguf'), filename: 'Qwen3.8-27B-UD-IQ3_XXS.gguf', sizeGB: 10.9, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B UD-Q3_K_XL', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q3 dynamic, the 12 GB sweet spot.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q3_K_XL', '13 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q3_K_XL.gguf'), filename: 'Qwen3.8-27B-UD-Q3_K_XL.gguf', sizeGB: 13.1, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B UD-Q4_K_XL', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · better quality per GB than plain Q4. For 20 GB+ cards.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q4_K_XL', '18 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q4_K_XL.gguf'), filename: 'Qwen3.8-27B-UD-Q4_K_XL.gguf', sizeGB: 17.6, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B UD-Q5_K_M', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q5 dynamic, higher quality. For 24 GB cards.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q5_K_M', '20 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q5_K_M.gguf'), filename: 'Qwen3.8-27B-UD-Q5_K_M.gguf', sizeGB: 19.8, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B UD-Q6_K', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q6 dynamic, near-lossless.', pulls: '6M+', tags: ['27B', 'Vision', 'UD-Q6_K', '22 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-Q6_K.gguf'), filename: 'Qwen3.8-27B-UD-Q6_K.gguf', sizeGB: 22, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B Q8_0', group: 'Qwen 3.8 27B', description: 'Qwen 3.8 27B · Q8, full quality. 32 GB+ or CPU with lots of RAM.', pulls: '6M+', tags: ['27B', 'Vision', 'Q8_0', '29 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-Q8_0.gguf'), filename: 'Qwen3.8-27B-Q8_0.gguf', sizeGB: 29, ...IMAGE_PART['unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.8 27B (Ollama)', description: 'Qwen 3.8 27B · one-command pull, projector included. Vision + tools + thinking out of the box.', pulls: '570K+', tags: ['27B', 'Vision', 'Tools', '18 GB'], updated: 'Hot', agent: true, released: '2026-08', ollamaModel: 'qwen3.8', sizeGB: 17.7 },
    { name: 'Qwen 3.8 9B Distill', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · the 27B reasoning in a size that fits an 8 GB card. Text only, the repo ships no vision projector.', pulls: '126K+', tags: ['9B', 'Q4_K_M', '6 GB'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q4_K_M.gguf'), filename: 'Qwen3.8-9B-Q4_K_M.gguf', sizeGB: 5.8, noImagePart: NO_PART_UPSTREAM },
    { name: 'Qwen 3.8 9B Distill Q5_K_M', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · Q5, higher quality. Text only.', pulls: '126K+', tags: ['9B', 'Q5_K_M', '7 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q5_K_M.gguf'), filename: 'Qwen3.8-9B-Q5_K_M.gguf', sizeGB: 6.6, noImagePart: NO_PART_UPSTREAM },
    { name: 'Qwen 3.8 9B Distill Q6_K', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · Q6, near-lossless. Text only.', pulls: '126K+', tags: ['9B', 'Q6_K', '8 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q6_K.gguf'), filename: 'Qwen3.8-9B-Q6_K.gguf', sizeGB: 7.6, noImagePart: NO_PART_UPSTREAM },
    { name: 'Qwen 3.8 9B Distill Q8_0', group: 'Qwen 3.8 9B Distill', description: 'Qwen 3.8 9B distill · Q8, full quality. Text only.', pulls: '126K+', tags: ['9B', 'Q8_0', '10 GB'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8-9B-Q8_0.gguf'), filename: 'Qwen3.8-9B-Q8_0.gguf', sizeGB: 9.8, noImagePart: NO_PART_UPSTREAM },
    // ── Qwen 3.6 27B DENSE (April 21, 2026 · new release) ──
    { name: 'Qwen 3.6 27B', group: 'Qwen 3.6 27B', description: 'Qwen 3.6 27B dense · vision + agentic coding + thinking preservation. 256K context. Recommended default.', pulls: 'New', tags: ['27B', 'Vision', 'Q4_K_M', '16 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Qwen3.6-27B-GGUF', 'Qwen3.6-27B-Q4_K_M.gguf'), filename: 'Qwen3.6-27B-Q4_K_M.gguf', sizeGB: 16, ...IMAGE_PART['unsloth/Qwen3.6-27B-GGUF/mmproj-F16.gguf'] },
    // ── Qwen 3.6 35B MoE (April 2026) · power user MoE variants ──
    // The NVFP4, MXFP8 and MLX tags are Ollama's MLX builds (labelled "MLX" on
    // ollama.com/library/qwen3.6/tags, sizes from there, read 08.10.2026).
    // Ollama's MLX announcement (ollama.com/blog/mlx, 30.03.2026) is about
    // Apple Silicon and asks for a Mac with more than 32 GB of unified memory
    // for the 35B-A3B NVFP4 build. Outside macOS the MLX engine is not
    // officially supported (ollama/ollama issues 16019 and 16265): a standard
    // Windows or Linux install has no MLX runtime and the pull is refused.
    // The format names are NVIDIA's, the builds are not for NVIDIA cards.
    { name: 'Qwen 3.6 35B MoE', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 · 35B MoE (3B active), vision + agentic coding + thinking preservation. 256K context. Power users.', pulls: 'New', tags: ['35B MoE', 'Vision', 'Q4_K_M', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6', sizeGB: 24 },
    { name: 'Qwen 3.6 35B MoE NVFP4', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · NVFP4, an MLX build in Ollama made for Apple Silicon Macs. Ollama asks for a Mac with more than 32 GB of memory. Not officially supported on Windows or Linux, take Q4_K_M there.', pulls: 'New', tags: ['35B MoE', 'Vision', 'NVFP4', 'MLX', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-nvfp4', sizeGB: 24 },
    { name: 'Qwen 3.6 35B MoE Coding NVFP4', group: 'Qwen 3.6 35B MoE Coding', description: 'Qwen 3.6 coding-specialized · NVFP4, an MLX build in Ollama made for Apple Silicon Macs. Ollama asks for a Mac with more than 32 GB of memory. Not officially supported on Windows or Linux.', pulls: 'New', tags: ['35B MoE', 'Coding', 'NVFP4', 'MLX', '24 GB'], updated: 'Hot', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-nvfp4', sizeGB: 24 },
    { name: 'Qwen 3.6 35B MoE Q8_0', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · Q8 quant, near-lossless quality. For high-VRAM setups.', pulls: 'New', tags: ['35B MoE', 'Vision', 'Q8_0', '39 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-q8_0', sizeGB: 39 },
    { name: 'Qwen 3.6 35B MoE MXFP8', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · MXFP8 (MicroScaling FP8), an MLX build in Ollama made for Apple Silicon Macs. The weights alone are 38 GB, so it needs a Mac with more memory than that. Not officially supported on Windows or Linux, take Q8_0 there.', pulls: 'New', tags: ['35B MoE', 'MXFP8', 'MLX', '38 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-mxfp8', sizeGB: 38 },
    { name: 'Qwen 3.6 35B MoE Coding MXFP8', group: 'Qwen 3.6 35B MoE Coding', description: 'Qwen 3.6 coding-specialized · MXFP8 (MicroScaling FP8), an MLX build in Ollama made for Apple Silicon Macs. The weights alone are 38 GB, so it needs a Mac with more memory than that. Not officially supported on Windows or Linux.', pulls: 'New', tags: ['35B MoE', 'Coding', 'MXFP8', 'MLX', '38 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-mxfp8', sizeGB: 38 },
    { name: 'Qwen 3.6 35B MoE BF16', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · BF16 full precision. Reference quality, big VRAM only.', pulls: 'New', tags: ['35B MoE', 'Vision', 'BF16', '71 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-bf16', sizeGB: 71 },
    { name: 'Qwen 3.6 35B MoE Coding BF16', group: 'Qwen 3.6 35B MoE Coding', description: 'Qwen 3.6 coding specialist · BF16 full precision. Reference coding quality.', pulls: 'New', tags: ['35B MoE', 'Coding', 'BF16', '70 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-coding-bf16', sizeGB: 70 },
    { name: 'Qwen 3.6 35B MoE MLX BF16', group: 'Qwen 3.6 35B MoE', description: 'Qwen 3.6 35B MoE · MLX BF16. Optimized for Apple Silicon (M2/M3/M4).', pulls: 'New', tags: ['35B MoE', 'MLX', 'BF16', '72 GB'], updated: 'New', agent: true, released: '2026-04', ollamaModel: 'qwen3.6:35b-a3b-mlx-bf16', sizeGB: 72 },
    // ── Qwen 3.5 (March 2026) ──
    { name: 'Qwen 3.5 9B', description: 'Qwen 3.5 9B · excellent balance of speed and quality.', pulls: '100K+', tags: ['9B', 'Vision', 'Q4_K_M', '5 GB'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-9B-GGUF', 'Qwen3.5-9B-Q4_K_M.gguf'), filename: 'Qwen3.5-9B-Q4_K_M.gguf', sizeGB: 5, ...IMAGE_PART['unsloth/Qwen3.5-9B-GGUF/mmproj-F16.gguf'] },
    // ── Holo 3.1 (H Company) · the model that looks at the screen ──
    // A Qwen 3.5 fine-tune for operating a computer from screenshots, for the
    // `computer_task` tool (api/computer-executor.ts picks its output format by
    // the name). Apache-2.0 on the model card and on this GGUF repo (read at
    // the source on 06.10.2026). H Company publishes its own GGUF only for the
    // 35B size (21 GB), which does not fit a 12 GB card, so the 9B comes from
    // mradermacher's conversion. Run on 06.10.2026 in llama-server with the
    // projector: 16 of 16 targets hit on the stored screens. On an RTX 3060
    // with 12 GB (06.10.2026) it never fits next to a 9B chat model (7.7 GB
    // plus 6.9 GB), so the entry says from when it is worth it.
    { name: 'Holo 3.1 9B', description: 'H Company Holo 3.1 9B · for computer control. Looks at screenshots and picks the next click. Choose it in Settings under Computer control. Beta: in our test on Windows it finished a simple typing task in 1 of 3 runs. Recommended from 16 GB VRAM, or next to a small chat model: on 12 GB it does not fit next to a 9B chat model, LU swaps the two for every task and each swap takes about 20 seconds. The 0.6 GB vision projector comes with it. Apache-2.0.', pulls: 'New', tags: ['9B', 'Vision', 'Q4_K_M', '6 GB', 'Computer control', 'Beta'], updated: 'New', released: '2026-05', downloadUrl: HF('mradermacher/Holo-3.1-9B-GGUF', 'Holo-3.1-9B.Q4_K_M.gguf'), filename: 'Holo-3.1-9B.Q4_K_M.gguf', sizeGB: 5.24, sha256: 'e667aadce4ffd17cd351c5228bc5dd10bd4f362875c9bd4163ff2dee58249ff0', ...IMAGE_PART['mradermacher/Holo-3.1-9B-GGUF/Holo-3.1-9B.mmproj-Q8_0.gguf'] },
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
    // ── Llama 3.3 ──
    { name: 'Llama 3.3 70B', description: 'Meta Llama 3.3 70B · maximum intelligence for high-end setups.', pulls: '1M+', tags: ['70B', 'Q4_K_M', '42 GB'], updated: 'Popular', agent: true, released: '2024-12', downloadUrl: HF('bartowski/Llama-3.3-70B-Instruct-GGUF', 'Llama-3.3-70B-Instruct-Q4_K_M.gguf'), filename: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf', sizeGB: 42 },
    // ── 2026-07-17 catalog refresh (May to July 2026 wave, HF-API-verified
    //    repos/filenames/sizes; DL counts from HF at research time).
    //    Negative findings from the same research pass: "Llama 5" and
    //    "Qwen 4" claims circulating in SEO blogs are fabrications (verified
    //    against the live meta-llama / Qwen HF orgs); Kimi K3 weights land
    //    July 27; Qwen 3.7 is API-only · all watchlist, not catalog. ──
    { name: 'Agents A1 35B', description: 'InternScience Agents-A1 · 35B MoE (3B active) built for long-horizon agent work. Apache-2.0.', pulls: '34K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '20 GB'], updated: 'Hot', agent: true, released: '2026-07', downloadUrl: HF('InternScience/Agents-A1-Q4_K_M-GGUF', 'Agents-A1-Q4_K_M.gguf'), filename: 'Agents-A1-Q4_K_M.gguf', sizeGB: 20, ...IMAGE_PART['InternScience/Agents-A1-Q4_K_M-GGUF/Agents-A1-mmproj.gguf'] },
    { name: 'Agents A1 4B', description: 'Agents-A1 distilled to 4B · small agentic model from the hyped 35B, fits tiny GPUs. Apache-2.0.', pulls: '10K+', tags: ['4B', 'Vision', 'Q4_K_M', '2.5 GB'], updated: 'New', agent: true, released: '2026-07', downloadUrl: HF('InternScience/Agents-A1-4B-Q4_K_M-GGUF', 'Agents-A1-4B-Q4_K_M.gguf'), filename: 'Agents-A1-4B-Q4_K_M.gguf', sizeGB: 2.5, ...IMAGE_PART['InternScience/Agents-A1-4B-Q4_K_M-GGUF/Agents-A1-4B-mmproj.gguf'] },
    { name: 'LFM 2.5 8B MoE', description: 'Liquid AI LFM 2.5 · 8B MoE (1.5B active), extremely fast on-device model. 128K context, native tools.', pulls: '50K+', tags: ['8B MoE', 'Q4_K_M', '4.8 GB', 'Fast'], updated: 'New', agent: true, released: '2026-05', downloadUrl: HF('LiquidAI/LFM2.5-8B-A1B-GGUF', 'LFM2.5-8B-A1B-Q4_K_M.gguf'), filename: 'LFM2.5-8B-A1B-Q4_K_M.gguf', sizeGB: 4.8 },
    { name: 'MiniCPM-V 4.6', description: 'MiniCPM-V 4.6 · pocket vision model (1.3B) that reads images and video in ~2 GB. Ollama pulls the vision projector automatically. Apache-2.0.', pulls: '100K+', tags: ['1.3B', 'Vision', '2 GB'], updated: 'New', released: '2026-05', ollamaModel: 'openbmb/minicpm-v4.6', sizeGB: 2 },
    { name: 'Nemotron 3 Nano 4B', description: 'NVIDIA Nemotron 3 Nano · 4B hybrid reasoner for edge GPUs. Native tool calling.', pulls: '30K+', tags: ['4B', 'Q4_K_M', '2.7 GB', 'Tools'], updated: 'New', agent: true, released: '2026-01', downloadUrl: HF('unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF', 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf'), filename: 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf', sizeGB: 2.7 },
    { name: 'Qwen 3.5 9B DeepSeek V4 Distill', description: 'DeepSeek V4-Flash reasoning distilled into Qwen 3.5 9B · the "R1 moment" for V4, in 6 GB. Apache-2.0.', pulls: '118K+', tags: ['9B', 'Vision', 'Q4_K_M', '5.3 GB', 'Reasoning'], updated: 'Hot', agent: true, released: '2026-05', downloadUrl: HF('Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF', 'Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf'), filename: 'Qwen3.5-9B-DeepSeek-V4-Flash-Q4_K_M.gguf', sizeGB: 5.3, ...IMAGE_PART['Jackrong/Qwen3.5-9B-DeepSeek-V4-Flash-GGUF/mmproj.gguf'] },
    { name: 'Mistral Medium 3.5 128B', description: 'Mistral Medium 3.5 · frontier-class 128B dense drop with reasoning-effort control. Custom Mistral license (check terms for commercial use).', pulls: '222K+', tags: ['128B', 'Vision', 'UD-Q2_K_XL', '45 GB'], updated: 'Hot', agent: true, released: '2026-04', downloadUrl: HF('unsloth/Mistral-Medium-3.5-128B-GGUF', 'Mistral-Medium-3.5-128B-UD-Q2_K_XL.gguf'), filename: 'Mistral-Medium-3.5-128B-UD-Q2_K_XL.gguf', sizeGB: 45, ...IMAGE_PART['unsloth/Mistral-Medium-3.5-128B-GGUF/mmproj-F16.gguf'] },
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
    // NACHGEPRUEFT am 02.09.2026, weil der Inhaber gesagt hatte „such mehr nach
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
    // b9949 — ein gehobener Tag im Skript haette den
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
    // Kimi K3 2.8T: fertig in api/kimi-k3-catalog.ts, erscheint aber erst, wenn
    // die gepinnte Engine die Architektur `kimi-k3` oeffnet (b9949 kann es nicht).
    ...kimiK3CatalogEntries(),
    { name: 'Kimi K2.7 Code 1T', description: 'Moonshot Kimi K2.7-Code · 1T MoE (32B active) coding flagship. Even the 2-bit quant is ~370 GB · multi-GPU / Mac-cluster territory. The newer Kimi K3 uses an architecture the LU Engine cannot open yet.', pulls: '392K+', tags: ['1T MoE', 'Vision', 'UD-Q2_K_XL', '371 GB', 'Multi-part'], updated: 'Hot', agent: true, released: '2026-06', downloadUrl: HF('unsloth/Kimi-K2.7-Code-GGUF', 'UD-Q2_K_XL/Kimi-K2.7-Code-UD-Q2_K_XL-00001-of-00008.gguf'), filename: 'Kimi-K2.7-Code-UD-Q2_K_XL-00001-of-00008.gguf', sizeGB: 371, ...IMAGE_PART['unsloth/Kimi-K2.7-Code-GGUF/mmproj-F16.gguf'] },
    // 2026-10-08 catalog refresh. Repos, file names and sizes read from the
    // Hugging Face tree API on that day; every architecture is one the pinned
    // llama.cpp lists. Nothing here was loaded in the engine. The download
    // takes the file named here (`selectGgufFromTree`, exactPath).
    // Ornith 1.5 (August 2026), successor to Ornith 1.0
    { name: 'Ornith 1.5 9B', group: 'Ornith 1.5 9B', description: 'Ornith 1.5 9B · successor to Ornith 1.0, a coding and agent model with vision and tool calling. Recommended quant. The 0.9 GB vision projector comes with it. MIT.', pulls: '5.1M', tags: ['9B', 'Vision', 'Q4_K_M', '5.8 GB', 'Coding'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('ornith-ai/Ornith-1.5-9B-GGUF', 'Ornith-1.5-9B-Q4_K_M.gguf'), filename: 'Ornith-1.5-9B-Q4_K_M.gguf', sizeGB: 5.78, ...IMAGE_PART['ornith-ai/Ornith-1.5-9B-GGUF/mmproj-Ornith-1.5-9B-BF16.gguf'] },
    { name: 'Ornith 1.5 9B Q6_K', group: 'Ornith 1.5 9B', description: 'Ornith 1.5 9B · higher quality quant.', pulls: '5.1M', tags: ['9B', 'Vision', 'Q6_K', '7.6 GB', 'Coding'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ornith-ai/Ornith-1.5-9B-GGUF', 'Ornith-1.5-9B-Q6_K.gguf'), filename: 'Ornith-1.5-9B-Q6_K.gguf', sizeGB: 7.56, ...IMAGE_PART['ornith-ai/Ornith-1.5-9B-GGUF/mmproj-Ornith-1.5-9B-BF16.gguf'] },
    { name: 'Ornith 1.5 9B Q8_0', group: 'Ornith 1.5 9B', description: 'Ornith 1.5 9B · largest quant, closest to the original weights.', pulls: '5.1M', tags: ['9B', 'Vision', 'Q8_0', '9.8 GB', 'Coding'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ornith-ai/Ornith-1.5-9B-GGUF', 'Ornith-1.5-9B-Q8_0.gguf'), filename: 'Ornith-1.5-9B-Q8_0.gguf', sizeGB: 9.79, ...IMAGE_PART['ornith-ai/Ornith-1.5-9B-GGUF/mmproj-Ornith-1.5-9B-BF16.gguf'] },
    { name: 'Ornith 1.5 35B MoE', group: 'Ornith 1.5 35B MoE', description: 'Ornith 1.5 35B MoE · the larger Ornith 1.5, 3B active parameters. Vision and tool calling. Recommended quant. The 0.9 GB vision projector comes with it. MIT.', pulls: '3.7M', tags: ['35B MoE', 'Vision', 'Q4_K_M', '22 GB', 'Coding'], updated: 'Hot', agent: true, released: '2026-08', downloadUrl: HF('ornith-ai/Ornith-1.5-35B-A3B-GGUF', 'Ornith-1.5-35B-Q4_K_M.gguf'), filename: 'Ornith-1.5-35B-Q4_K_M.gguf', sizeGB: 21.71, ...IMAGE_PART['ornith-ai/Ornith-1.5-35B-A3B-GGUF/mmproj-Ornith-1.5-35B-BF16.gguf'] },
    { name: 'Ornith 1.5 35B MoE Q6_K', group: 'Ornith 1.5 35B MoE', description: 'Ornith 1.5 35B MoE · higher quality quant.', pulls: '3.7M', tags: ['35B MoE', 'Vision', 'Q6_K', '29 GB', 'Coding'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ornith-ai/Ornith-1.5-35B-A3B-GGUF', 'Ornith-1.5-35B-Q6_K.gguf'), filename: 'Ornith-1.5-35B-Q6_K.gguf', sizeGB: 29.21, ...IMAGE_PART['ornith-ai/Ornith-1.5-35B-A3B-GGUF/mmproj-Ornith-1.5-35B-BF16.gguf'] },
    { name: 'Ornith 1.5 35B MoE Q8_0', group: 'Ornith 1.5 35B MoE', description: 'Ornith 1.5 35B MoE · largest quant, closest to the original weights.', pulls: '3.7M', tags: ['35B MoE', 'Vision', 'Q8_0', '38 GB', 'Coding'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ornith-ai/Ornith-1.5-35B-A3B-GGUF', 'Ornith-1.5-35B-Q8_0.gguf'), filename: 'Ornith-1.5-35B-Q8_0.gguf', sizeGB: 37.8, ...IMAGE_PART['ornith-ai/Ornith-1.5-35B-A3B-GGUF/mmproj-Ornith-1.5-35B-BF16.gguf'] },
    // Qwen 3.8 35B MoE distill: community build (empero-ai), sibling of the 9B
    // distill above. Unlike the 9B this repo ships a vision projector.
    { name: 'Qwen 3.8 35B MoE Distill', group: 'Qwen 3.8 35B MoE Distill', description: 'Qwen 3.8 35B MoE distill · community distill by empero-ai, not an official Qwen release. 3B active parameters, vision and tool calling. Recommended quant. The 0.9 GB vision projector comes with it. Apache-2.0.', pulls: '717K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '22 GB'], updated: 'Hot', agent: true, released: '2026-09', downloadUrl: HF('empero-ai/Qwen3.8-35B-A3B-Distill-GGUF', 'Qwen3.8-35B-A3B-Q4_K_M.gguf'), filename: 'Qwen3.8-35B-A3B-Q4_K_M.gguf', sizeGB: 21.71, ...IMAGE_PART['empero-ai/Qwen3.8-35B-A3B-Distill-GGUF/mmproj-Qwen3.8-35B-A3B-F16.gguf'] },
    { name: 'Qwen 3.8 35B MoE Distill IQ2_M', group: 'Qwen 3.8 35B MoE Distill', description: 'Qwen 3.8 35B MoE distill · smallest quant, for 16 GB machines.', pulls: '717K+', tags: ['35B MoE', 'Vision', 'IQ2_M', '13 GB'], updated: 'New', agent: true, released: '2026-09', downloadUrl: HF('empero-ai/Qwen3.8-35B-A3B-Distill-GGUF', 'Qwen3.8-35B-A3B-IQ2_M.gguf'), filename: 'Qwen3.8-35B-A3B-IQ2_M.gguf', sizeGB: 12.56, ...IMAGE_PART['empero-ai/Qwen3.8-35B-A3B-Distill-GGUF/mmproj-Qwen3.8-35B-A3B-F16.gguf'] },
    { name: 'Qwen 3.8 35B MoE Distill Q8_0', group: 'Qwen 3.8 35B MoE Distill', description: 'Qwen 3.8 35B MoE distill · largest quant, closest to the original weights.', pulls: '717K+', tags: ['35B MoE', 'Vision', 'Q8_0', '38 GB'], updated: 'New', agent: true, released: '2026-09', downloadUrl: HF('empero-ai/Qwen3.8-35B-A3B-Distill-GGUF', 'Qwen3.8-35B-A3B-Q8_0.gguf'), filename: 'Qwen3.8-35B-A3B-Q8_0.gguf', sizeGB: 37.8, ...IMAGE_PART['empero-ai/Qwen3.8-35B-A3B-Distill-GGUF/mmproj-Qwen3.8-35B-A3B-F16.gguf'] },
    // IBM Granite 4.2 (August 2026), successor to Granite 4.0 Micro and 4.1 8B.
    // IBM publishes no GGUF of the 3B, so that one comes from lmstudio-community.
    { name: 'IBM Granite 4.2 3B', group: 'IBM Granite 4.2 3B', description: 'IBM Granite 4.2 3B · small model with native tool calling, successor to Granite 4.0 Micro. Fits 8 GB machines. Apache-2.0.', pulls: '700+', tags: ['3B', 'Q4_K_M', '2.2 GB', 'Tools'], updated: 'New', agent: true, lightweight: true, released: '2026-08', downloadUrl: HF('lmstudio-community/granite-4.2-3b-GGUF', 'granite-4.2-3b-Q4_K_M.gguf'), filename: 'granite-4.2-3b-Q4_K_M.gguf', sizeGB: 2.24 },
    { name: 'IBM Granite 4.2 3B Q8_0', group: 'IBM Granite 4.2 3B', description: 'IBM Granite 4.2 3B · largest quant, closest to the original weights.', pulls: '700+', tags: ['3B', 'Q8_0', '3.9 GB', 'Tools'], updated: 'New', agent: true, lightweight: true, released: '2026-08', downloadUrl: HF('lmstudio-community/granite-4.2-3b-GGUF', 'granite-4.2-3b-Q8_0.gguf'), filename: 'granite-4.2-3b-Q8_0.gguf', sizeGB: 3.89 },
    { name: 'IBM Granite 4.2 8B', group: 'IBM Granite 4.2 8B', description: 'IBM Granite 4.2 8B · enterprise model with native tool calling, successor to Granite 4.1 8B. Recommended quant. Apache-2.0.', pulls: '282K+', tags: ['8B', 'Q4_K_M', '5.3 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ibm-granite/granite-4.2-8b-GGUF', 'granite-4.2-8b-Q4_K_M.gguf'), filename: 'granite-4.2-8b-Q4_K_M.gguf', sizeGB: 5.35 },
    { name: 'IBM Granite 4.2 8B Q2_K', group: 'IBM Granite 4.2 8B', description: 'IBM Granite 4.2 8B · smallest quant, for 8 GB machines.', pulls: '282K+', tags: ['8B', 'Q2_K', '3.4 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ibm-granite/granite-4.2-8b-GGUF', 'granite-4.2-8b-Q2_K.gguf'), filename: 'granite-4.2-8b-Q2_K.gguf', sizeGB: 3.41 },
    { name: 'IBM Granite 4.2 8B Q8_0', group: 'IBM Granite 4.2 8B', description: 'IBM Granite 4.2 8B · largest quant, closest to the original weights.', pulls: '282K+', tags: ['8B', 'Q8_0', '9.3 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ibm-granite/granite-4.2-8b-GGUF', 'granite-4.2-8b-Q8_0.gguf'), filename: 'granite-4.2-8b-Q8_0.gguf', sizeGB: 9.35 },
    { name: 'IBM Granite 4.2 30B', group: 'IBM Granite 4.2 30B', description: 'IBM Granite 4.2 30B · the largest Granite 4.2. Native tool calling. Recommended quant. Apache-2.0.', pulls: '270K+', tags: ['30B', 'Q4_K_M', '18 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ibm-granite/granite-4.2-30b-GGUF', 'granite-4.2-30b-Q4_K_M.gguf'), filename: 'granite-4.2-30b-Q4_K_M.gguf', sizeGB: 17.72 },
    { name: 'IBM Granite 4.2 30B Q2_K', group: 'IBM Granite 4.2 30B', description: 'IBM Granite 4.2 30B · smallest quant, for 16 GB machines.', pulls: '270K+', tags: ['30B', 'Q2_K', '11 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ibm-granite/granite-4.2-30b-GGUF', 'granite-4.2-30b-Q2_K.gguf'), filename: 'granite-4.2-30b-Q2_K.gguf', sizeGB: 10.86 },
    { name: 'IBM Granite 4.2 30B Q8_0', group: 'IBM Granite 4.2 30B', description: 'IBM Granite 4.2 30B · largest quant, closest to the original weights.', pulls: '270K+', tags: ['30B', 'Q8_0', '31 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('ibm-granite/granite-4.2-30b-GGUF', 'granite-4.2-30b-Q8_0.gguf'), filename: 'granite-4.2-30b-Q8_0.gguf', sizeGB: 31.11 },
    // Nemotron 3.5 Lightning (August 2026), successor to Nemotron 3 Nano Omni
    { name: 'Nemotron 3.5 Lightning 30B', group: 'Nemotron 3.5 Lightning 30B', description: 'NVIDIA Nemotron 3.5 Lightning · 30B MoE with 3B active parameters, tool calling and thinking, 1M context. Successor to Nemotron 3 Nano Omni. NVIDIA license, check the terms for commercial use.', pulls: '55K+', tags: ['30B MoE', 'UD-Q4_K_M', '25 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF', 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_M.gguf'), filename: 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_M.gguf', sizeGB: 25.27 },
    { name: 'Nemotron 3.5 Lightning 30B UD-IQ2_M', group: 'Nemotron 3.5 Lightning 30B', description: 'NVIDIA Nemotron 3.5 Lightning · smallest dynamic quant.', pulls: '55K+', tags: ['30B MoE', 'UD-IQ2_M', '19 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF', 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-IQ2_M.gguf'), filename: 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-IQ2_M.gguf', sizeGB: 19.43 },
    { name: 'Nemotron 3.5 Lightning 30B Q8_0', group: 'Nemotron 3.5 Lightning 30B', description: 'NVIDIA Nemotron 3.5 Lightning · largest quant, closest to the original weights.', pulls: '55K+', tags: ['30B MoE', 'Q8_0', '35 GB', 'Tools'], updated: 'New', agent: true, released: '2026-08', downloadUrl: HF('unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF', 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q8_0.gguf'), filename: 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q8_0.gguf', sizeGB: 35 },
    // Gemma 4 12B QAT: Google's own quantization-aware file, one quant only
    { name: 'Gemma 4 12B QAT', description: 'Gemma 4 12B QAT · Google\'s own Q4 file from quantization-aware training, which is meant to hold quality at this size. Vision and tool calling. The 0.2 GB vision projector comes with it.', pulls: '780K+', tags: ['12B', 'Vision', 'QAT Q4_0', '7 GB'], updated: 'New', agent: true, released: '2026-06', downloadUrl: HF('google/gemma-4-12B-it-qat-q4_0-gguf', 'gemma-4-12b-it-qat-q4_0.gguf'), filename: 'gemma-4-12b-it-qat-q4_0.gguf', sizeGB: 6.98, ...IMAGE_PART['google/gemma-4-12B-it-qat-q4_0-gguf/mmproj-gemma-4-12b-it-qat-q4_0.gguf'] },
    // Small models for 8 GB machines (all below the 7B chat minimum)
    // LFM3 (Liquid AI, 28.10.2026): Text, VL, Omni and Audio as Ollama tags,
    // and below as GGUF for the LU Engine and LM Studio. The GGUF
    // header says `general.architecture = lfm3`, which llama.cpp knows from
    // b11960 on, the pin since E1 (scripts/build-llama.sh); before it a GGUF
    // entry would download and then not open
    // (src/api/__tests__/lfm3-nur-was-laeuft.test.ts holds that line). Ollama
    // runs it from 0.40.13 on all platforms (0.40.12 was Apple only; the
    // manifest config says `"requires":"0.40.13"`). The lfm3:1.7b model layer
    // is byte for byte LiquidAI/LFM3-1.7B-GGUF Q4_K_M (sha256 3793e1e6…).
    // Sizes are the manifest layer sums, read 30.10.2026. LFM Open License
    // v1.0, like LFM 2.5: commercial use is licensed below 10 million revenue a year.
    // GGUF for the LU Engine and LM Studio (N1 after E1): llama.cpp knows
    // `lfm3` from b11960, the pin E1 set. Bytes and SHA-256 are the LFS values
    // of the LiquidAI repositories, read 30.10.2026. LFM3 Audio and Omni hear
    // and speak in the engine too: llama-server b11960 answers
    // /v1/audio/transcriptions and /tts (lib/speech-route.ts).
    { name: 'LFM3 1.7B', group: 'LFM3 1.7B', blurb: "very small, fast model for quick answers, summaries and simple tool calls", description: 'Liquid AI LFM3 1.7B · very small, fast model for quick answers, summaries, extraction and simple tool calls, 256K context. Weaker at long reasoning than 7B+ models. Runs in the LU Engine from 3.0.9 (llama.cpp b11960) and in LM Studio with its llama.cpp runtime 2.65.1 or newer. LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: '97K+', tags: ['1.7B', 'Q4_K_M', '1.0 GB', 'Tools'], updated: 'New', agent: true, released: '2026-10', downloadUrl: HF('LiquidAI/LFM3-1.7B-GGUF', 'LFM3-1.7B-Q4_K_M.gguf'), filename: 'LFM3-1.7B-Q4_K_M.gguf', sizeGB: 1.02, sizeBytes: 1099627808, sha256: '3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4' },
    { name: 'LFM3 1.7B QAD Q4_0', group: 'LFM3 1.7B', blurb: "very small, fast model for quick answers, summaries and simple tool calls", description: 'Liquid AI LFM3 1.7B · Q4_0 from quantization-aware distillation, trained by Liquid AI to keep the quality of the full model at 4 bits.', pulls: '97K+', tags: ['1.7B', 'QAD Q4_0', '1.0 GB', 'Tools'], updated: 'New', agent: true, released: '2026-10', downloadUrl: HF('LiquidAI/LFM3-1.7B-GGUF', 'LFM3-1.7B-QAD-Q4_0.gguf'), filename: 'LFM3-1.7B-QAD-Q4_0.gguf', sizeGB: 0.98, sizeBytes: 1049615680, sha256: '43a7d09a0e9cba91b63eb7052488b9564569bddfd65754d2e426465e572a7452' },
    { name: 'LFM3 1.7B Q8_0', group: 'LFM3 1.7B', blurb: "very small, fast model for quick answers, summaries and simple tool calls", description: 'Liquid AI LFM3 1.7B · Q8_0, closest to the original weights.', pulls: '97K+', tags: ['1.7B', 'Q8_0', '1.7 GB', 'Tools'], updated: 'New', agent: true, released: '2026-10', downloadUrl: HF('LiquidAI/LFM3-1.7B-GGUF', 'LFM3-1.7B-Q8_0.gguf'), filename: 'LFM3-1.7B-Q8_0.gguf', sizeGB: 1.72, sizeBytes: 1846238496, sha256: '8f6b24182258205e9e01e21f1f24a1f208c1e8115578825d202ce39976af20b6' },
    { name: 'LFM3 VL 2B', group: 'LFM3 VL 2B', blurb: "small model with image input: photos, screenshots, documents", description: 'Liquid AI LFM3 VL 2B · LFM3 with image input: describe photos, read screenshots and documents. Small, so expect short and simple answers. The 0.2 GB image part comes with it. Runs in the LU Engine from 3.0.9 (llama.cpp b11960) and in LM Studio with its llama.cpp runtime 2.65.1 or newer. LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: '36K+', tags: ['2B', 'Vision', 'Q4_K_M', '1.0 GB'], updated: 'New', released: '2026-10', downloadUrl: HF('LiquidAI/LFM3-VL-2B-GGUF', 'LFM3-VL-2B-Q4_K_M.gguf'), filename: 'LFM3-VL-2B-Q4_K_M.gguf', sizeGB: 1.02, sizeBytes: 1099627808, sha256: '56dac2e192ff0d9ab8507f4f1aeb4aed0463449bbbefaac79497f041c95f21eb', ...IMAGE_PART['LiquidAI/LFM3-VL-2B-GGUF/mmproj-LFM3-VL-2B-Q8_0.gguf'] },
    { name: 'LFM3 VL 2B Q8_0', group: 'LFM3 VL 2B', blurb: "small model with image input: photos, screenshots, documents", description: 'Liquid AI LFM3 VL 2B · Q8_0, closest to the original weights. The 0.2 GB image part comes with it.', pulls: '36K+', tags: ['2B', 'Vision', 'Q8_0', '1.7 GB'], updated: 'New', released: '2026-10', downloadUrl: HF('LiquidAI/LFM3-VL-2B-GGUF', 'LFM3-VL-2B-Q8_0.gguf'), filename: 'LFM3-VL-2B-Q8_0.gguf', sizeGB: 1.72, sizeBytes: 1846238496, sha256: 'e138e54189a751d90ea8c0b236360490613ecd465d28d68fa6094d3db7fa6727', ...IMAGE_PART['LiquidAI/LFM3-VL-2B-GGUF/mmproj-LFM3-VL-2B-Q8_0.gguf'] },
    { name: 'LFM3 Omni 2B', group: 'LFM3 Omni 2B', blurb: "text, images and sound in one small model", description: 'Liquid AI LFM3 Omni 2B · text, images and sound in one small model. Chats with image input; in the LU Engine it also hears and speaks (Settings, Voice, "LU Engine" for dictation and read-aloud). The 0.5 GB image and sound part comes with it. Runs in the LU Engine from 3.0.9 (llama.cpp b11960) and in LM Studio with its llama.cpp runtime 2.65.1 or newer. LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: 'New', tags: ['2B', 'Vision', 'Q4_K_M', '1.0 GB'], updated: 'New', released: '2026-10', downloadUrl: HF('LiquidAI/LFM3-Omni-2B-GGUF', 'LFM3-Omni-2B-Q4_K_M.gguf'), filename: 'LFM3-Omni-2B-Q4_K_M.gguf', sizeGB: 1.02, sizeBytes: 1099630080, sha256: '9f8d30e9d4fd7a9349d586e077988229b3ca0a0e4ad730897563d1eccc9893e2', ...IMAGE_PART['LiquidAI/LFM3-Omni-2B-GGUF/mmproj-LFM3-Omni-2B-Q8_0.gguf'] },
    { name: 'LFM3 Audio 2B', group: 'LFM3 Audio 2B', blurb: "speech in and out for LU's dictation and read-aloud, 18 languages", description: 'Liquid AI LFM3 Audio 2B · speech recognition, translation and text-to-speech. Load it in the LU Engine and pick "LU Engine" for dictation and read-aloud in Settings, Voice. The 0.3 GB sound part comes with it. Runs in the LU Engine from 3.0.9 (llama.cpp b11960). LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: 'New', tags: ['2B', 'Audio', 'Q4_K_M', '1.0 GB'], updated: 'New', released: '2026-10', downloadUrl: HF('LiquidAI/LFM3-Audio-2B-GGUF', 'LFM3-Audio-2B-Q4_K_M.gguf'), filename: 'LFM3-Audio-2B-Q4_K_M.gguf', sizeGB: 1.02, sizeBytes: 1099626016, sha256: '9a773289bd321ed879cd3a76545f6aca506e403851a45fb315420aee45625be2', ...IMAGE_PART['LiquidAI/LFM3-Audio-2B-GGUF/mmproj-LFM3-Audio-2B-Q8_0.gguf'] },
    { name: 'LFM3 1.7B (Ollama)', group: 'LFM3 1.7B (Ollama)', blurb: "very small, fast model for quick answers, summaries and simple tool calls", description: 'Liquid AI LFM3 1.7B · very small, fast model for quick answers, summaries, extraction and simple tool calls, 256K context. Weaker at long reasoning than 7B+ models. Needs Ollama 0.40.13 or newer. LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: 'New', tags: ['1.7B', 'Q4_K_M', '1.0 GB', 'Tools'], updated: 'New', agent: true, released: '2026-10', ollamaModel: 'lfm3:1.7b', sizeGB: 1.02 },
    { name: 'LFM3 1.7B (Ollama) NVFP4', group: 'LFM3 1.7B (Ollama)', blurb: "very small, fast model for quick answers, summaries and simple tool calls", description: 'Liquid AI LFM3 1.7B · NVFP4, an MLX build in Ollama made for Apple Silicon Macs. Needs Ollama 0.40.13 or newer. Not officially supported on Windows or Linux, take the Q4_K_M tag there.', pulls: 'New', tags: ['1.7B', 'NVFP4', 'MLX', '1.6 GB', 'Tools'], updated: 'New', agent: true, released: '2026-10', ollamaModel: 'lfm3:1.7b-nvfp4', sizeGB: 1.57 },
    { name: 'LFM3 VL 2B (Ollama)', group: 'LFM3 VL 2B (Ollama)', blurb: "small model with image input: photos, screenshots, documents", description: 'Liquid AI LFM3 VL 2B · LFM3 with image input: describe photos, read screenshots and documents. Small, so expect short and simple answers. Projector included. Needs Ollama 0.40.13 or newer. LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: 'New', tags: ['2B', 'Vision', 'Q4_K_M', '1.4 GB'], updated: 'New', released: '2026-10', ollamaModel: 'lfm3-vl:2b', sizeGB: 1.38 },
    { name: 'LFM3 VL 2B (Ollama) NVFP4', group: 'LFM3 VL 2B (Ollama)', blurb: "small model with image input: photos, screenshots, documents", description: 'Liquid AI LFM3 VL 2B · NVFP4, an MLX build in Ollama made for Apple Silicon Macs. Needs Ollama 0.40.13 or newer. Not officially supported on Windows or Linux, take the Q4_K_M tag there.', pulls: 'New', tags: ['2B', 'Vision', 'NVFP4', 'MLX', '1.6 GB'], updated: 'New', released: '2026-10', ollamaModel: 'lfm3-vl:2b-nvfp4', sizeGB: 1.63 },
    // Omni and Audio take sound as well. Ollama hears through its
    // /v1/audio/transcriptions route and speaks through /v1/audio/speech, not
    // through chat, so in LU the sound side runs in Settings, Voice
    // ("Use LFM3 Audio in Ollama"). The Omni manifest names the capabilities
    // vision, audio, speech and tools; Audio names audio, speech and tools.
    { name: 'LFM3 Omni 2B (Ollama)', group: 'LFM3 Omni 2B (Ollama)', blurb: "text, images and sound in one small model", description: 'Liquid AI LFM3 Omni 2B · text, images and sound in one small model. Chats with image input, and can also transcribe the microphone and read answers aloud (set it in Settings, Voice). Needs Ollama 0.40.13 or newer. LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: 'New', tags: ['2B', 'Vision', 'Audio', 'Q4_K_M', '1.9 GB'], updated: 'New', released: '2026-10', ollamaModel: 'lfm3-omni:2b', sizeGB: 1.91 },
    { name: 'LFM3 Omni 2B (Ollama) NVFP4', group: 'LFM3 Omni 2B (Ollama)', blurb: "text, images and sound in one small model", description: 'Liquid AI LFM3 Omni 2B · NVFP4, an MLX build in Ollama made for Apple Silicon Macs. Needs Ollama 0.40.13 or newer. Not officially supported on Windows or Linux, take the Q4_K_M tag there.', pulls: 'New', tags: ['2B', 'Vision', 'Audio', 'NVFP4', 'MLX', '2.2 GB'], updated: 'New', released: '2026-10', ollamaModel: 'lfm3-omni:2b-nvfp4', sizeGB: 2.23 },
    { name: 'LFM3 Audio 2B (Ollama)', group: 'LFM3 Audio 2B (Ollama)', blurb: "speech in and out for LU's dictation and read-aloud, 18 languages", description: 'Liquid AI LFM3 Audio 2B · speech recognition, translation and text-to-speech in 18 languages. In LU it is the voice and the ear: Settings, Voice, "Use LFM3 Audio in Ollama" for dictation and read-aloud. Needs Ollama 0.40.13 or newer. LFM Open License: commercial use is licensed only below a revenue limit of 10 million a year.', pulls: 'New', tags: ['2B', 'Audio', 'Q4_K_M', '1.6 GB'], updated: 'New', released: '2026-10', ollamaModel: 'lfm3-audio:2b', sizeGB: 1.56 },
    { name: 'LFM3 Audio 2B (Ollama) NVFP4', group: 'LFM3 Audio 2B (Ollama)', blurb: "speech in and out for LU's dictation and read-aloud, 18 languages", description: 'Liquid AI LFM3 Audio 2B · NVFP4, an MLX build in Ollama made for Apple Silicon Macs. Needs Ollama 0.40.13 or newer. Not officially supported on Windows or Linux, take the Q4_K_M tag there.', pulls: 'New', tags: ['2B', 'Audio', 'NVFP4', 'MLX', '1.9 GB'], updated: 'New', released: '2026-10', ollamaModel: 'lfm3-audio:2b-nvfp4', sizeGB: 1.92 },
    { name: 'LFM 2.5 2.6B', group: 'LFM 2.5 2.6B', description: 'Liquid AI LFM 2.5 2.6B · small on-device model with native tool calling, fits 8 GB machines. Liquid AI license, check the terms for commercial use.', pulls: '1.0M', tags: ['2.6B', 'Q4_K_M', '1.7 GB', 'Tools'], updated: 'New', agent: true, lightweight: true, released: '2026-08', downloadUrl: HF('LiquidAI/LFM2.5-2.6B-GGUF', 'LFM2.5-2.6B-Q4_K_M.gguf'), filename: 'LFM2.5-2.6B-Q4_K_M.gguf', sizeGB: 1.67 },
    { name: 'LFM 2.5 2.6B Q8_0', group: 'LFM 2.5 2.6B', description: 'Liquid AI LFM 2.5 2.6B · largest quant, closest to the original weights.', pulls: '1.0M', tags: ['2.6B', 'Q8_0', '2.9 GB', 'Tools'], updated: 'New', agent: true, lightweight: true, released: '2026-08', downloadUrl: HF('LiquidAI/LFM2.5-2.6B-GGUF', 'LFM2.5-2.6B-Q8_0.gguf'), filename: 'LFM2.5-2.6B-Q8_0.gguf', sizeGB: 2.87 },
    { name: 'FrogNano 4B', group: 'FrogNano 4B', description: 'Microsoft FrogNano 4B · Microsoft\'s small model from September 2026, successor to Phi-4 Mini. Vision. The 0.7 GB vision projector comes with it. MIT.', pulls: '21K+', tags: ['4B', 'Vision', 'Q4_K_M', '2.8 GB'], updated: 'New', lightweight: true, released: '2026-09', downloadUrl: HF('bartowski/FrogNano-4B-2609-GGUF', 'FrogNano-4B-2609-Q4_K_M.gguf'), filename: 'FrogNano-4B-2609-Q4_K_M.gguf', sizeGB: 2.8, ...IMAGE_PART['bartowski/FrogNano-4B-2609-GGUF/mmproj-FrogNano-4B-2609-f16.gguf'] },
    { name: 'FrogNano 4B IQ2_M', group: 'FrogNano 4B', description: 'Microsoft FrogNano 4B · smallest quant.', pulls: '21K+', tags: ['4B', 'Vision', 'IQ2_M', '1.6 GB'], updated: 'New', lightweight: true, released: '2026-09', downloadUrl: HF('bartowski/FrogNano-4B-2609-GGUF', 'FrogNano-4B-2609-IQ2_M.gguf'), filename: 'FrogNano-4B-2609-IQ2_M.gguf', sizeGB: 1.65, ...IMAGE_PART['bartowski/FrogNano-4B-2609-GGUF/mmproj-FrogNano-4B-2609-f16.gguf'] },
    { name: 'FrogNano 4B Q8_0', group: 'FrogNano 4B', description: 'Microsoft FrogNano 4B · largest quant, closest to the original weights.', pulls: '21K+', tags: ['4B', 'Vision', 'Q8_0', '4.6 GB'], updated: 'New', lightweight: true, released: '2026-09', downloadUrl: HF('bartowski/FrogNano-4B-2609-GGUF', 'FrogNano-4B-2609-Q8_0.gguf'), filename: 'FrogNano-4B-2609-Q8_0.gguf', sizeGB: 4.62, ...IMAGE_PART['bartowski/FrogNano-4B-2609-GGUF/mmproj-FrogNano-4B-2609-f16.gguf'] },
    { name: 'Qwen 3.5 4B', group: 'Qwen 3.5 4B', description: 'Qwen 3.5 4B · small Qwen 3.5 with vision, tool calling and switchable thinking, successor to Qwen3 4B. The 0.7 GB vision projector comes with it. Apache-2.0.', pulls: '1.1M', tags: ['4B', 'Vision', 'Q4_K_M', '2.7 GB', 'Tools'], updated: 'Hot', agent: true, lightweight: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_K_M.gguf'), filename: 'Qwen3.5-4B-Q4_K_M.gguf', sizeGB: 2.74, ...IMAGE_PART['unsloth/Qwen3.5-4B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.5 4B UD-IQ2_M', group: 'Qwen 3.5 4B', description: 'Qwen 3.5 4B · smallest dynamic quant.', pulls: '1.1M', tags: ['4B', 'Vision', 'UD-IQ2_M', '1.8 GB', 'Tools'], updated: 'New', agent: true, lightweight: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-UD-IQ2_M.gguf'), filename: 'Qwen3.5-4B-UD-IQ2_M.gguf', sizeGB: 1.76, ...IMAGE_PART['unsloth/Qwen3.5-4B-GGUF/mmproj-F16.gguf'] },
    { name: 'Qwen 3.5 4B Q8_0', group: 'Qwen 3.5 4B', description: 'Qwen 3.5 4B · largest quant, closest to the original weights.', pulls: '1.1M', tags: ['4B', 'Vision', 'Q8_0', '4.5 GB', 'Tools'], updated: 'New', agent: true, lightweight: true, released: '2026-03', downloadUrl: HF('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q8_0.gguf'), filename: 'Qwen3.5-4B-Q8_0.gguf', sizeGB: 4.48, ...IMAGE_PART['unsloth/Qwen3.5-4B-GGUF/mmproj-F16.gguf'] },
    // MiMo V2.6 distill (Xiaomi, September 2026). The model card names no license.
    { name: 'MiMo V2.6 Distill 9B', group: 'MiMo V2.6 Distill 9B', description: 'Xiaomi MiMo V2.6 Distill 9B · MiMo V2.6 distilled onto a Qwen 9B base, with vision. The 0.9 GB vision projector comes with it. The model card states no license, check before commercial use.', pulls: '496K+', tags: ['9B', 'Vision', 'Q4_K_M', '5.8 GB'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF', 'MiMo-V2.6-Distill-Qwen-9B-Q4_K_M.gguf'), filename: 'MiMo-V2.6-Distill-Qwen-9B-Q4_K_M.gguf', sizeGB: 5.84, ...IMAGE_PART['bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF/mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf'] },
    { name: 'MiMo V2.6 Distill 9B IQ2_M', group: 'MiMo V2.6 Distill 9B', description: 'Xiaomi MiMo V2.6 Distill 9B · smallest quant.', pulls: '496K+', tags: ['9B', 'Vision', 'IQ2_M', '3.5 GB'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF', 'MiMo-V2.6-Distill-Qwen-9B-IQ2_M.gguf'), filename: 'MiMo-V2.6-Distill-Qwen-9B-IQ2_M.gguf', sizeGB: 3.54, ...IMAGE_PART['bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF/mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf'] },
    { name: 'MiMo V2.6 Distill 9B Q8_0', group: 'MiMo V2.6 Distill 9B', description: 'Xiaomi MiMo V2.6 Distill 9B · largest quant, closest to the original weights.', pulls: '496K+', tags: ['9B', 'Vision', 'Q8_0', '9.6 GB'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF', 'MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf'), filename: 'MiMo-V2.6-Distill-Qwen-9B-Q8_0.gguf', sizeGB: 9.55, ...IMAGE_PART['bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF/mmproj-MiMo-V2.6-Distill-Qwen-9B-f16.gguf'] },
    // Mistral: Ministral 3 (December 2025) takes the place of Mistral Nemo,
    // Devstral Small 2 that of Mistral Small 24B (2501). Mistral Small 4 is the
    // newest general model. Its UD-Q4_K_M is split into three parts; the
    // multi-part download path fetches no vision projector, so that quant is
    // listed as text only.
    { name: 'Ministral 3 3B', group: 'Ministral 3 3B', description: 'Mistral Ministral 3 3B · small Mistral model from December 2025 with vision and tool calling. Fits 8 GB machines. The 0.8 GB vision projector comes with it. Apache-2.0.', pulls: '41K+', tags: ['3B', 'Vision', 'Q4_K_M', '2.1 GB'], updated: 'New', agent: true, lightweight: true, released: '2025-12', downloadUrl: HF('mistralai/Ministral-3-3B-Instruct-2512-GGUF', 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf'), filename: 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf', sizeGB: 2.15, ...IMAGE_PART['mistralai/Ministral-3-3B-Instruct-2512-GGUF/Ministral-3-3B-Instruct-2512-BF16-mmproj.gguf'] },
    { name: 'Ministral 3 3B Q8_0', group: 'Ministral 3 3B', description: 'Mistral Ministral 3 3B · largest quant, closest to the original weights.', pulls: '41K+', tags: ['3B', 'Vision', 'Q8_0', '3.6 GB'], updated: 'New', agent: true, lightweight: true, released: '2025-12', downloadUrl: HF('mistralai/Ministral-3-3B-Instruct-2512-GGUF', 'Ministral-3-3B-Instruct-2512-Q8_0.gguf'), filename: 'Ministral-3-3B-Instruct-2512-Q8_0.gguf', sizeGB: 3.65, ...IMAGE_PART['mistralai/Ministral-3-3B-Instruct-2512-GGUF/Ministral-3-3B-Instruct-2512-BF16-mmproj.gguf'] },
    { name: 'Ministral 3 8B', group: 'Ministral 3 8B', description: 'Mistral Ministral 3 8B · small Mistral model from December 2025 with vision and tool calling. Successor to Mistral Nemo 12B. The 0.9 GB vision projector comes with it. Apache-2.0.', pulls: '38K+', tags: ['8B', 'Vision', 'Q4_K_M', '5.2 GB'], updated: 'New', agent: true, released: '2025-12', downloadUrl: HF('mistralai/Ministral-3-8B-Instruct-2512-GGUF', 'Ministral-3-8B-Instruct-2512-Q4_K_M.gguf'), filename: 'Ministral-3-8B-Instruct-2512-Q4_K_M.gguf', sizeGB: 5.2, ...IMAGE_PART['mistralai/Ministral-3-8B-Instruct-2512-GGUF/Ministral-3-8B-Instruct-2512-BF16-mmproj.gguf'] },
    { name: 'Ministral 3 8B Q8_0', group: 'Ministral 3 8B', description: 'Mistral Ministral 3 8B · largest quant, closest to the original weights.', pulls: '38K+', tags: ['8B', 'Vision', 'Q8_0', '9 GB'], updated: 'New', agent: true, released: '2025-12', downloadUrl: HF('mistralai/Ministral-3-8B-Instruct-2512-GGUF', 'Ministral-3-8B-Instruct-2512-Q8_0.gguf'), filename: 'Ministral-3-8B-Instruct-2512-Q8_0.gguf', sizeGB: 9.03, ...IMAGE_PART['mistralai/Ministral-3-8B-Instruct-2512-GGUF/Ministral-3-8B-Instruct-2512-BF16-mmproj.gguf'] },
    { name: 'Ministral 3 14B', group: 'Ministral 3 14B', description: 'Mistral Ministral 3 14B · small Mistral model from December 2025 with vision and tool calling. The largest Ministral 3. The 0.9 GB vision projector comes with it. Apache-2.0.', pulls: '44K+', tags: ['14B', 'Vision', 'Q4_K_M', '8.2 GB'], updated: 'New', agent: true, released: '2025-12', downloadUrl: HF('mistralai/Ministral-3-14B-Instruct-2512-GGUF', 'Ministral-3-14B-Instruct-2512-Q4_K_M.gguf'), filename: 'Ministral-3-14B-Instruct-2512-Q4_K_M.gguf', sizeGB: 8.24, ...IMAGE_PART['mistralai/Ministral-3-14B-Instruct-2512-GGUF/Ministral-3-14B-Instruct-2512-BF16-mmproj.gguf'] },
    { name: 'Ministral 3 14B Q8_0', group: 'Ministral 3 14B', description: 'Mistral Ministral 3 14B · largest quant, closest to the original weights.', pulls: '44K+', tags: ['14B', 'Vision', 'Q8_0', '14 GB'], updated: 'New', agent: true, released: '2025-12', downloadUrl: HF('mistralai/Ministral-3-14B-Instruct-2512-GGUF', 'Ministral-3-14B-Instruct-2512-Q8_0.gguf'), filename: 'Ministral-3-14B-Instruct-2512-Q8_0.gguf', sizeGB: 14.36, ...IMAGE_PART['mistralai/Ministral-3-14B-Instruct-2512-GGUF/Ministral-3-14B-Instruct-2512-BF16-mmproj.gguf'] },
    { name: 'Devstral Small 2 24B', group: 'Devstral Small 2 24B', description: 'Mistral Devstral Small 2 · 24B coding model with tool calling and vision. Recommended quant. The 0.9 GB vision projector comes with it. Check the license terms for commercial use.', pulls: '50K+', tags: ['24B', 'Vision', 'Q4_K_M', '14 GB', 'Coding'], updated: 'New', agent: true, released: '2025-12', downloadUrl: HF('unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF', 'Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf'), filename: 'Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf', sizeGB: 14.33, ...IMAGE_PART['unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF/mmproj-F16.gguf'] },
    { name: 'Devstral Small 2 24B UD-IQ2_M', group: 'Devstral Small 2 24B', description: 'Mistral Devstral Small 2 · smallest dynamic quant.', pulls: '50K+', tags: ['24B', 'Vision', 'UD-IQ2_M', '8.2 GB', 'Coding'], updated: 'New', agent: true, released: '2025-12', downloadUrl: HF('unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF', 'Devstral-Small-2-24B-Instruct-2512-UD-IQ2_M.gguf'), filename: 'Devstral-Small-2-24B-Instruct-2512-UD-IQ2_M.gguf', sizeGB: 8.24, ...IMAGE_PART['unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF/mmproj-F16.gguf'] },
    { name: 'Devstral Small 2 24B Q8_0', group: 'Devstral Small 2 24B', description: 'Mistral Devstral Small 2 · largest quant, closest to the original weights.', pulls: '50K+', tags: ['24B', 'Vision', 'Q8_0', '25 GB', 'Coding'], updated: 'New', agent: true, released: '2025-12', downloadUrl: HF('unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF', 'Devstral-Small-2-24B-Instruct-2512-Q8_0.gguf'), filename: 'Devstral-Small-2-24B-Instruct-2512-Q8_0.gguf', sizeGB: 25.06, ...IMAGE_PART['unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF/mmproj-F16.gguf'] },
    { name: 'Mistral Small 4 119B', group: 'Mistral Small 4 119B', description: 'Mistral Small 4 · 119B, Mistral\'s newest general model (March 2026), with tool calling and vision. Single 40 GB file, for 64 GB machines. The 0.9 GB vision projector comes with it. Apache-2.0.', pulls: '14K+', tags: ['119B', 'Vision', 'UD-Q2_K_XL', '40 GB'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Mistral-Small-4-119B-2603-GGUF', 'Mistral-Small-4-119B-2603-UD-Q2_K_XL.gguf'), filename: 'Mistral-Small-4-119B-2603-UD-Q2_K_XL.gguf', sizeGB: 40.2, ...IMAGE_PART['unsloth/Mistral-Small-4-119B-2603-GGUF/mmproj-F16.gguf'] },
    { name: 'Mistral Small 4 119B UD-IQ2_M', group: 'Mistral Small 4 119B', description: 'Mistral Small 4 · smallest dynamic quant, single file.', pulls: '14K+', tags: ['119B', 'Vision', 'UD-IQ2_M', '38 GB'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Mistral-Small-4-119B-2603-GGUF', 'Mistral-Small-4-119B-2603-UD-IQ2_M.gguf'), filename: 'Mistral-Small-4-119B-2603-UD-IQ2_M.gguf', sizeGB: 37.57, ...IMAGE_PART['unsloth/Mistral-Small-4-119B-2603-GGUF/mmproj-F16.gguf'] },
    { name: 'Mistral Small 4 119B UD-Q4_K_M', group: 'Mistral Small 4 119B', description: 'Mistral Small 4 · higher quality quant for 96 GB machines and up. Multi-part download, text only: LU fetches no vision projector for split files.', pulls: '14K+', tags: ['119B', 'UD-Q4_K_M', '74 GB', 'Multi-part'], updated: 'New', agent: true, released: '2026-03', downloadUrl: HF('unsloth/Mistral-Small-4-119B-2603-GGUF', 'UD-Q4_K_M/Mistral-Small-4-119B-2603-UD-Q4_K_M-00001-of-00003.gguf'), filename: 'Mistral-Small-4-119B-2603-UD-Q4_K_M-00001-of-00003.gguf', sizeGB: 73.76 },
    // GPT-OSS 120B: still OpenAI's newest open model. Two parts, 63 GB in all.
    { name: 'GPT-OSS 120B', description: 'OpenAI GPT-OSS 120B · the large open-weight GPT model, with tool calling and thinking. Multi-part download, about 63 GB, for 96 GB machines and up. Apache-2.0.', pulls: '73K+', tags: ['120B', 'Q4_K_M', '63 GB', 'Multi-part'], updated: 'New', agent: true, released: '2025-08', downloadUrl: HF('unsloth/gpt-oss-120b-GGUF', 'Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf'), filename: 'gpt-oss-120b-Q4_K_M-00001-of-00002.gguf', sizeGB: 62.77 },
    // Hermes 3 3B: an official NousResearch model, not abliterated, so it lists with Hermes 4.3
    // Bug Z/b v2.5.0 · GH #48. Pre-v2.5.0 these pointed at
    // `bartowski/Hermes-3-Llama-*-GGUF`. leon's 2026-05-26 CLI repro
    // `ollama pull hf.co/bartowski/Hermes-3-Llama-3.1-8B-GGUF:Q4_K_M`
    // returned HTTP 400 "Repository is not GGUF or is not compatible with
    // llama.cpp" on current Ollama. Switched to `mradermacher/...-GGUF`
    // mirrors which produce llama.cpp-compatible quants (verified all
    // three repos host Q4_K_M files of the expected size). Note the
    // filename convention: mradermacher uses `.` between model name and
    // quant (e.g. `Hermes-3-Llama-3.1-8B.Q4_K_M.gguf`), bartowski uses `-`.
    { name: 'Hermes 3 Llama 3.2 3B', description: 'NousResearch Hermes 3 · small and fast with native tool calling. Runs on 8 GB RAM, CPU-only.', pulls: '500K+', tags: ['3B', 'Q4_K_M', '2 GB'], updated: 'Hot', agent: true, lightweight: true, released: '2024-08', downloadUrl: HF('mradermacher/Hermes-3-Llama-3.2-3B-GGUF', 'Hermes-3-Llama-3.2-3B.Q4_K_M.gguf'), filename: 'Hermes-3-Llama-3.2-3B.Q4_K_M.gguf', sizeGB: 2 },
    // Hermes 4.3 36B (NousResearch, November 2025), on the Seed-OSS 36B base
    { name: 'Hermes 4.3 36B', group: 'Hermes 4.3 36B', description: 'NousResearch Hermes 4.3 · 36B on the Seed-OSS base, the successor to Hermes 3. Native tool calling. Recommended quant. Apache-2.0.', pulls: '16K+', tags: ['36B', 'Q4_K_M', '22 GB', 'Tools'], updated: 'New', agent: true, released: '2025-11', downloadUrl: HF('NousResearch/Hermes-4.3-36B-GGUF', 'hermes-4_3_36b-Q4_K_M.gguf'), filename: 'hermes-4_3_36b-Q4_K_M.gguf', sizeGB: 21.76 },
    { name: 'Hermes 4.3 36B Q3_K_M', group: 'Hermes 4.3 36B', description: 'NousResearch Hermes 4.3 · smaller quant.', pulls: '16K+', tags: ['36B', 'Q3_K_M', '18 GB', 'Tools'], updated: 'New', agent: true, released: '2025-11', downloadUrl: HF('NousResearch/Hermes-4.3-36B-GGUF', 'hermes-4_3_36b-Q3_K_M.gguf'), filename: 'hermes-4_3_36b-Q3_K_M.gguf', sizeGB: 17.62 },
    { name: 'Hermes 4.3 36B Q8_0', group: 'Hermes 4.3 36B', description: 'NousResearch Hermes 4.3 · largest quant, closest to the original weights.', pulls: '16K+', tags: ['36B', 'Q8_0', '38 GB', 'Tools'], updated: 'New', agent: true, released: '2025-11', downloadUrl: HF('NousResearch/Hermes-4.3-36B-GGUF', 'hermes-4_3_36b-Q8_0.gguf'), filename: 'hermes-4_3_36b-Q8_0.gguf', sizeGB: 38.42 },
    // Holo4 (H Company, September 2026), successor to Holo 3.1. Not run in LU:
    // the measurements in the Holo 3.1 entry above do not carry over.
    { name: 'Holo4 35B MoE', group: 'Holo4 35B MoE', description: 'H Company Holo4 35B MoE · successor to Holo 3.1 for computer control, 3B active parameters. Looks at screenshots and picks the next click. Beta: not yet tested in LU. The 0.9 GB vision projector comes with it. Apache-2.0.', pulls: '3K+', tags: ['35B MoE', 'Vision', 'Q4_K_M', '22 GB', 'Computer control', 'Beta'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/Hcompany_Holo4-35B-A3B-GGUF', 'Hcompany_Holo4-35B-A3B-Q4_K_M.gguf'), filename: 'Hcompany_Holo4-35B-A3B-Q4_K_M.gguf', sizeGB: 22.32, ...IMAGE_PART['bartowski/Hcompany_Holo4-35B-A3B-GGUF/mmproj-Hcompany_Holo4-35B-A3B-f16.gguf'] },
    { name: 'Holo4 35B MoE IQ2_M', group: 'Holo4 35B MoE', description: 'H Company Holo4 35B MoE · smallest quant. Beta: not yet tested in LU.', pulls: '3K+', tags: ['35B MoE', 'Vision', 'IQ2_M', '13 GB', 'Computer control', 'Beta'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/Hcompany_Holo4-35B-A3B-GGUF', 'Hcompany_Holo4-35B-A3B-IQ2_M.gguf'), filename: 'Hcompany_Holo4-35B-A3B-IQ2_M.gguf', sizeGB: 13.23, ...IMAGE_PART['bartowski/Hcompany_Holo4-35B-A3B-GGUF/mmproj-Hcompany_Holo4-35B-A3B-f16.gguf'] },
    { name: 'Holo4 35B MoE Q8_0', group: 'Holo4 35B MoE', description: 'H Company Holo4 35B MoE · largest quant, closest to the original weights. Beta: not yet tested in LU.', pulls: '3K+', tags: ['35B MoE', 'Vision', 'Q8_0', '37 GB', 'Computer control', 'Beta'], updated: 'New', released: '2026-09', downloadUrl: HF('bartowski/Hcompany_Holo4-35B-A3B-GGUF', 'Hcompany_Holo4-35B-A3B-Q8_0.gguf'), filename: 'Hcompany_Holo4-35B-A3B-Q8_0.gguf', sizeGB: 36.91, ...IMAGE_PART['bartowski/Hcompany_Holo4-35B-A3B-GGUF/mmproj-Hcompany_Holo4-35B-A3B-f16.gguf'] },
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

/**
 * The HuggingFace search could not answer: no connection, the free rate limit,
 * or a reply that is not a list of repos. Thrown instead of an empty list so
 * the page can tell "nothing matches" from "nobody answered".
 */
export class HfSearchError extends Error {
  readonly kind: 'offline' | 'rate-limit'
  constructor(kind: 'offline' | 'rate-limit', detail: string) {
    super(detail)
    this.name = 'HfSearchError'
    this.kind = kind
  }
}

/** The sentence the user reads when the HuggingFace search failed. */
export function hfSearchFailureText(err: unknown): string {
  if (err instanceof HfSearchError && err.kind === 'rate-limit') {
    return 'Hugging Face is limiting searches right now. Wait a minute and search again.'
  }
  return 'Hugging Face could not be reached. Check the connection and search again.'
}

const RATE_LIMIT = /rate.?limit|too many requests|\b429\b/i

export async function searchHuggingFaceModels(query: string): Promise<DiscoverModel[]> {
  let repos: Array<{ id: string; downloads?: number; modelId?: string }>
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
      if (res.status === 429) throw new HfSearchError('rate-limit', `HTTP 429: ${json.slice(0, 200)}`)
    }

    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) {
      // HF answers a limit or an outage with {"error": "..."} instead of a list.
      const said = isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : json.slice(0, 200)
      throw new HfSearchError(RATE_LIMIT.test(said) ? 'rate-limit' : 'offline', said)
    }
    repos = parsed
  } catch (err) {
    log.warn('[discover] HF search failed', { err })
    if (err instanceof HfSearchError) throw err
    throw new HfSearchError(RATE_LIMIT.test(String(err)) ? 'rate-limit' : 'offline', String(err))
  }

  const models: DiscoverModel[] = []
  for (const repo of repos) {
    if (typeof repo?.id !== 'string') continue
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
  /** The image part the same repository ships, when it ships one. For a model
   *  the catalog does not know, this is what is offered with it. */
  imagePart?: ImagePartSource
  /** Set when the chosen file is a split set the repository holds only some
   *  parts of (an upload still running). `files` is empty then: llama.cpp
   *  cannot load the set, so nothing of it is downloaded. */
  incomplete?: ShardGap
}

// 5-digit llama.cpp split convention: `<name>-00001-of-00002.gguf`. A few
// uploaders pad to 4, so accept 4-5.
const GGUF_SHARD_RE = /-(\d{4,5})-of-(\d{4,5})\.gguf$/i
// Broad quant token matcher (covers Q2_K, Q3_K_S/M/L, Q4_0/1, Q4_K_S/M/L,
// Q5_K_*, Q6_K(_L), Q8_0, IQ1..IQ4 variants, F16/BF16/F32). Used only to LABEL
// and PICK a group · grouping itself never depends on it.
const GGUF_QUANT_TOKEN = /(IQ\d_[A-Z0-9]+|Q\d_K(?:_[A-Z]+)?|Q\d_[01]|BF16|F16|F32)/i

/** One downloadable unit of a repo tree: a single file, or every part of a
 *  split set. */
interface GgufGroup { key: string; quant?: string; parts: HfTreeEntry[]; gap?: ShardGap | null }

/**
 * The group that holds the file the caller named, or undefined.
 *
 * The full path decides first. Only when no entry has that path does the bare
 * file name count, and then only if exactly one entry carries it: a repo that
 * moved the file into a folder still resolves, and two folders with the same
 * leaf name stay undecided and go to the quant fallback.
 */
function groupOfNamedFile(groups: GgufGroup[], exactPath?: string): GgufGroup | undefined {
  if (!exactPath) return undefined
  const byPath = groups.find(g => g.parts.some(p => p.path === exactPath))
  if (byPath) return byPath
  const leaf = exactPath.split('/').pop()
  const byLeaf = groups.filter(g => g.parts.some(p => p.path.split('/').pop() === leaf))
  return byLeaf.length === 1 ? byLeaf[0] : undefined
}

/**
 * Pure: given a HuggingFace repo file tree, pick the GGUF file-set to download.
 * Returns every part of a sharded set (sorted) or the single matching file.
 * Exported for unit testing without a network round-trip.
 *
 * `exactPath` is the file the caller already names (the path behind
 * `/resolve/main/` of a catalog address). When the tree holds that file, its
 * group is the answer and the quant is never consulted. The quant is only a
 * way to find a file nobody named, and it is a lossy one: it cannot tell two
 * model families in one repo apart (`RVN-...-Q4_K_M-multilingual.gguf` next to
 * an older `...-Heretic-Q4_K_M.gguf`), and it reads nothing from names that do
 * not end on the quant (`...-Q4_K-0731.gguf`, `...-Q4_K_P.gguf`). Until
 * 2026-10-08 the quant was the only key, so those cards fetched a neighbour.
 */
export function selectGgufFromTree(
  entries: HfTreeEntry[],
  repoId: string,
  preferredQuant?: string,
  exactPath?: string,
): HfGgufResolution | null {
  const allGguf = entries.filter(e => e.type === 'file' && /\.gguf$/i.test(e.path))
  // An image part is a GGUF too and carries a quant token of its own
  // (`mmproj-F16.gguf`), so it has to leave before the groups are formed: a
  // repository without a Q4_K_M would otherwise hand the part out as the model.
  const ggufs = allGguf.filter(e => !isUpstreamImagePart(e.path))
  if (ggufs.length === 0) return null
  const upstreamPart = pickUpstreamImagePart(allGguf)

  // Group by the path with the shard suffix stripped. Single files keep their
  // full path (their own group of one); all parts of a split set collapse to
  // the same key regardless of whether the quant sits in the folder or the leaf.
  const groups = new Map<string, GgufGroup>()
  for (const f of ggufs) {
    const key = f.path.replace(GGUF_SHARD_RE, '')
    const leaf = (f.path.split('/').pop() || '').replace(GGUF_SHARD_RE, '.gguf')
    const quant = (GGUF_QUANT_TOKEN.exec(leaf)?.[1] || GGUF_QUANT_TOKEN.exec(f.path)?.[1])?.toUpperCase()
    let g = groups.get(key)
    if (!g) { g = { key, quant, parts: [] }; groups.set(key, g) }
    g.parts.push(f)
  }

  const all = [...groups.values()]
  for (const g of all) g.gap = shardSetGap(g.parts.map(p => p.path))
  // A split set with parts missing never loads. A loadable group is taken
  // over it wherever the choice is ours; when the caller's own file or quant
  // is only there incomplete, the answer says so instead of fetching another.
  const complete = all.filter(g => !g.gap)
  const wanted = preferredQuant?.toUpperCase()
  const byQuant = (g: GgufGroup) => g.quant === wanted
  const byKey = (g: GgufGroup) => !!wanted && g.key.toUpperCase().includes(wanted)
  const picked =
    groupOfNamedFile(all, exactPath) ||
    (wanted ? complete.find(byQuant) || all.find(byQuant) : undefined) ||
    (wanted ? complete.find(byKey) || all.find(byKey) : undefined) ||
    complete.find(g => g.quant === 'Q4_K_M') ||
    complete[0] ||
    all[0]
  if (!picked) return null
  if (picked.gap) {
    return { sharded: true, files: [], totalBytes: 0, quant: picked.quant, incomplete: picked.gap }
  }

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
    ...(upstreamPart
      ? {
          imagePart: {
            url: `https://huggingface.co/${repoId}/resolve/main/${upstreamPart.path}`,
            sizeBytes: upstreamPart.size || undefined,
            sha256: lfsSha256(upstreamPart),
          },
        }
      : {}),
  }
}

/** What the download asks the repo tree for one entry. */
export interface GgufRequest {
  repoId: string
  /** The path the entry's address names. Decides when the tree holds it. */
  exactPath?: string
  /** Read from the file name. Only the fallback, see `selectGgufFromTree`. */
  preferredQuant?: string
}

/**
 * The question a catalog or search entry puts to its repo tree, or null when
 * its address is not a HuggingFace file address. One place, so the Models tab
 * and the test that walks the whole catalog ask the same thing.
 */
export function ggufRequestFor(model: Pick<DiscoverModel, 'downloadUrl' | 'filename'>): GgufRequest | null {
  if (!model.downloadUrl) return null
  const parsed = parseHfUrl(model.downloadUrl)
  if (!parsed) return null
  return {
    repoId: `${parsed.user}/${parsed.repo}`,
    exactPath: hfUrlToTreePath(model.downloadUrl) ?? undefined,
    preferredQuant: model.filename ? extractGgufQuant(model.filename) : undefined,
  }
}

/**
 * The image part to fetch with `model`: the catalog's when the entry names one,
 * otherwise the one its repository ships, for a model the catalog does not
 * know. A catalog entry without a part stays without one, whatever the
 * repository lists today: the catalog is where a part is checked before it is
 * offered.
 */
export function imagePartFor(model: DiscoverModel, resolution: HfGgufResolution | null | undefined): ImagePartSource | null {
  const own = imagePartOf(model)
  if (own) return own
  if (model.noImagePart || isCatalogChatModel(model)) return null
  return resolution?.imagePart ?? null
}

/** Is this the address of a chat model the catalog lists? */
function isCatalogChatModel(model: DiscoverModel): boolean {
  if (!model.downloadUrl) return false
  return [...getUncensoredTextModels(), ...getMainstreamTextModels()].some((m) => m.downloadUrl === model.downloadUrl)
}

/**
 * Resolve the real downloadable GGUF file(s) for a HuggingFace repo by querying
 * its file tree. Returns null if the tree can't be fetched · callers then fall
 * back to their guessed single-file URL (no regression, just no improvement).
 */
export async function resolveHfGgufFiles(
  repoId: string,
  preferredQuant?: string,
  exactPath?: string,
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
    return selectGgufFromTree(entries as HfTreeEntry[], repoId, preferredQuant, exactPath)
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
 * Der Ordner, den der Nutzer unter Storage gesetzt hat, wenn er einen
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

/**
 * Phone only: how a download is called in the notification of the system.
 * The shell of the phone sets this once at its start (mobile/boot), with the
 * name its pages show for the file. Nobody sets it on a desktop, so the call
 * below carries exactly what it always carried there.
 */
let downloadTitleOf: ((filename: string) => string | undefined) | null = null
export function setDownloadTitleResolver(resolver: ((filename: string) => string | undefined) | null): void {
  downloadTitleOf = resolver
}

/** The name as an argument of the call, or nothing at all (every desktop). */
function titleArg(filename: string): { title?: string } {
  try {
    const title = downloadTitleOf?.(filename)?.trim()
    return title ? { title } : {}
  } catch {
    // A name is a nicety. Without one the notification shows the file name.
    return {}
  }
}

/** Download a GGUF model to a specific directory (for non-Ollama providers) */
export async function startModelDownloadToPath(url: string, destDir: string, filename: string, expectedBytes?: number, sha256?: string): Promise<{ status: string; id: string; error?: string }> {
  // The CivitAI key goes along for a CivitAI address and no other (a LoRA
  // from the CivitAI search into the Mac's LoRA folder). Every other caller
  // sends what it sent before.
  const authToken = civitaiAuthToken(url)
  return backendCall('download_model_to_path', {
    url, destDir, filename, expectedBytes: expectedBytes ?? null, expectedSha256: sha256 ?? null,
    ...(authToken ? { authToken } : {}),
    ...titleArg(filename),
  })
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
  for (const bundle of [...getImageBundles(), ...getVideoBundles(), ...getAudioBundles(), ...getLipsyncBundles(), ...getMotionBundles(), ...getUpscaleBundles()]) {
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
        expectedBytes: m.sizeGB ? Math.round(m.sizeGB * 1_073_741_824) : undefined,
        sha256: m.sha256,
      }
    }
  }
  return null
}

/** The catalog's digest and byte count for `filename`, but only when the catalog
 *  names the SAME address. For callers that build a download from a registry
 *  entry and would otherwise start it without the digest. */
export function catalogDigestFor(filename: string, url: string): { sha256?: string; expectedBytes?: number } {
  const cat = lookupFileMeta(filename)
  return cat && cat.url === url ? { sha256: cat.sha256, expectedBytes: cat.expectedBytes } : {}
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
    add(req.audioVae?.downloadUrl, `COMPONENT_REGISTRY.${type}.audioVae`)
    add(req.upscaler?.downloadUrl, `COMPONENT_REGISTRY.${type}.upscaler`)
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
  /** The file's byte count as CivitAI states it (sizeKB times 1024), for the
   *  Installed check. `sizeGB` is rounded to a tenth and says nothing exact. */
  sizeBytes?: number
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

/**
 * Das Vorschaubild eines CivitAI-Treffers als kleines Standbild.
 *
 * Discord #bug-reports, 29.10.2026 (Ubuntu): „when searching for models in app
 * from civitai searchbox, the app crashes". Die API nennt als erstes Bild einer
 * Version die Originaldatei (`…/original=true/123.mp4`). Gemessen für „wan“,
 * 20 Treffer mit 19 Vorschaubildern: 13 davon MP4-Videos, zusammen 68 MB (das größte 15,9 MB) für
 * Kärtchen von 56 px. Auf Linux dekodiert WebKitGTK ein Video im `<img>` mit
 * GStreamer (WebView2 unter Windows zeigt es gar nicht), also
 * zwanzig Videodekoder auf einmal, mit echter GPU über VA-API/GL.
 *
 * Der Bild-CDN von CivitAI liefert dieselbe Datei verkleinert, und mit
 * `anim=false` auch ein Video als einzelnes JPEG (gemessen: 111 KB statt
 * 695 KB bis 16 MB, image/jpeg statt video/mp4; alle 19 zusammen
 * 1,89 MB). Dieselbe Angabe benutzt die CivitAI-Seite selbst. Ein Video, das
 * nicht auf diesem CDN liegt, bekommt KEIN Vorschaubild: ein Video gehört nicht
 * in ein `<img>`.
 */
const CIVITAI_THUMB_PARAMS = 'anim=false,width=450,optimized=true'

export function civitaiThumbUrl(url: string | undefined, type?: string): string | undefined {
  if (!url) return undefined
  const isVideo = type === 'video' || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'image.civitai.com') {
    return isVideo ? undefined : url
  }
  // /<Schlüssel>/<uuid>/<Angaben>/<Name>, ältere Antworten ohne Angaben-Teil.
  const segs = parsed.pathname.split('/').filter(Boolean)
  if (segs.length === 4 && segs[2].includes('=')) segs[2] = CIVITAI_THUMB_PARAMS
  else if (segs.length === 3) segs.splice(2, 0, CIVITAI_THUMB_PARAMS)
  else return isVideo ? undefined : url
  // `pathname` ist schon kodiert, die Teile gehen unverändert zurück.
  parsed.pathname = '/' + segs.join('/')
  return parsed.toString()
}

/**
 * Eine CivitAI-Beschreibung als Text, nicht als Markup.
 *
 * Befund am echten Windows-Bau (21.09.2026, C4-search-pixel-results.png): in
 * der Trefferliste stand woertlich „High quality in promt &amp; negative low
 * quality". Das Feld ist HTML, und abgeschnitten wurden bisher nur die Tags;
 * die Entitaeten blieben stehen und wurden als Zeichen gezeigt.
 *
 * Gerendert wird das Ergebnis als gewoehnlicher React-Textknoten
 * (CivitaiSearchPanel.tsx), also NICHT ueber `dangerouslySetInnerHTML`. Genau
 * deshalb darf hier dekodiert werden: ein `<script>` aus einer fremden
 * Beschreibung ist nach dem Tag-Schnitt kein Tag mehr, und was React
 * ausgibt, ist in jedem Fall Text. `&amp;` kommt ZULETZT dran, sonst wuerde
 * aus dem doppelt kodierten `&amp;lt;` am Ende ein `<`.
 */
export function civitaiDescriptionToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
}

/** A GGUF quant, read by the ComfyUI-GGUF pack and by nothing else. */
export function isGgufFile(filename: string | undefined): boolean {
  return /\.gguf$/i.test(filename ?? '')
}

/**
 * Download a CivitAI hit, and for a GGUF quant make sure ComfyUI can read it.
 *
 * A curated bundle installs the ComfyUI-GGUF pack along with its files; a
 * CivitAI hit had no such step, so a GGUF from the search downloaded fine and
 * stayed invisible. The pack is installed only when this ComfyUI lacks its
 * loader (installing restarts ComfyUI, which a running render would not
 * survive), in the background so the download is never held up, and never
 * for a ComfyUI on another machine, whose packs this one cannot touch.
 */
export async function startCivitaiDownload(model: { downloadUrl?: string; filename?: string; subfolder?: string }): Promise<void> {
  if (!model.downloadUrl || !model.filename || !model.subfolder) return
  await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
  if (!isGgufFile(model.filename)) return
  const target = await comfyModelTarget()
  if (target.remote) return
  const nodes = await getAllNodeInfo().catch(() => null)
  if (nodes && 'UnetLoaderGGUF' in nodes) return
  void installCustomNodes(['gguf'], { keepGoing: true, restart: true })
    .catch((err) => log.warn('[discover] ComfyUI-GGUF install for a CivitAI GGUF failed', { err }))
}

/** How far a file on disk may be off CivitAI's sizeKB and still be that file.
 *  sizeKB is a fraction of a KiB, so the byte count it gives is exact up to a
 *  rounding of the last digits; another version is megabytes apart. */
const CIVITAI_SIZE_SLACK = 1024

/** Is this file on disk the CivitAI hit? The same name in the folder the
 *  download writes to (that much is the caller's question) and, where CivitAI
 *  states a size, that size. A file of the same name and another size is
 *  another version or another upload, so Download stays offered for it. */
function civitaiFileMatches(model: { sizeBytes?: number }, actualBytes: number): boolean {
  if (actualBytes <= 0) return false
  return model.sizeBytes == null || Math.abs(actualBytes - model.sizeBytes) <= CIVITAI_SIZE_SLACK
}

/** The CivitAI hits whose file is already in its ComfyUI folder, by id
 *  (Discord #feature-requests, 3.0.7: an installed model offered Download).
 *  One question to `check_model_sizes`, the per-file check the bundle cards
 *  use, which looks in exactly the folder `download_model` writes into: a file
 *  of that name in another folder does not count. When the check cannot run,
 *  nothing counts as installed and every hit keeps its button. */
export async function checkCivitaiInstalled(models: readonly CivitAIModelResult[]): Promise<Set<number>> {
  const installed = new Set<number>()
  const asked = models.filter((m) => m.filename && m.subfolder)
  if (asked.length === 0) return installed
  try {
    const results: Array<{ filename: string; exists: boolean; actualBytes: number }> = await backendCall('check_model_sizes', {
      files: asked.map((m) => ({ subfolder: m.subfolder!, filename: m.filename!, expectedBytes: m.sizeBytes ?? 0 })),
    })
    // One answer per file and in order: two hits may share a file name and
    // differ only in their folder, so the name alone cannot pair them up.
    asked.forEach((m, i) => {
      const r = results[i]
      if (r && r.filename === m.filename && r.exists && civitaiFileMatches(m, r.actualBytes)) installed.add(m.id)
    })
  } catch (err) {
    log.warn('[discover] CivitAI installed check failed', { err })
  }
  return installed
}

/** The same question for a folder the caller has listed already, the Mac's
 *  LoRA folder (`useMlxLoras`). A download lands at the top of that folder, so
 *  a file of that name in a subfolder of it is not the hit. */
export function civitaiInstalledInFolder(
  models: readonly CivitAIModelResult[],
  files: readonly { name: string; sizeBytes: number }[],
): Set<number> {
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f.sizeBytes]))
  const installed = new Set<number>()
  for (const m of models) {
    const bytes = m.filename ? byName.get(m.filename.toLowerCase()) : undefined
    if (bytes != null && civitaiFileMatches(m, bytes)) installed.add(m.id)
  }
  return installed
}

export async function searchCivitaiModels(
  query: string,
  type: 'Checkpoint' | 'LORA' | 'VAE' | 'TextualInversion' = 'Checkpoint',
  apiKey?: string,
  host: string = CIVITAI_DEFAULT_HOST,
  /** For the Mac's LoRA folder. `baseModel` narrows the search to LoRAs made
   *  for one base model, by CivitAI's own name for it ("Qwen 2.1").
   *  `safetensorsOnly` takes the first .safetensors file of a hit, since that
   *  is the one kind the folder lists, and leaves out a hit that has none
   *  (some carry a ComfyUI workflow as their first file). Without it nothing
   *  about the search changes. */
  only?: { baseModel?: string; safetensorsOnly?: boolean },
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
    if (only?.baseModel) params.set('baseModels', only.baseModel)
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

    const isSafetensors = (f: Record<string, unknown>) => /\.safetensors$/i.test(asString(prop(f, 'name')) ?? '')
    const wanted = only?.safetensorsOnly
      ? items.filter((item) => asRecordArray(prop(asRecordArray(prop(item, 'modelVersions'))[0], 'files')).some(isSafetensors))
      : items

    return wanted.map((item) => {
      const version = asRecordArray(prop(item, 'modelVersions'))[0]
      const files = asRecordArray(prop(version, 'files'))
      const file = only?.safetensorsOnly ? files.find(isSafetensors) : files[0]
      const firstImage = asRecordArray(prop(version, 'images'))[0]
      const thumb = civitaiThumbUrl(asString(prop(firstImage, 'url')), asString(prop(firstImage, 'type')))
      // The version's own address is that of its first file. Where a later
      // file was picked, only that file's address fetches it.
      const downloadUrl = only?.safetensorsOnly
        ? asString(prop(file, 'downloadUrl')) ?? asString(prop(version, 'downloadUrl'))
        : asString(prop(version, 'downloadUrl')) ?? asString(prop(file, 'downloadUrl'))
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
      // Check if it's a diffusion model (FLUX, Wan, etc.). Only for a
      // checkpoint search: the name of a LORA, a VAE or an embedding says
      // which base model it was trained against, not what kind of file it is,
      // so "Flux Realism LoRA" used to be written into diffusion_models, where
      // the LoRA loader does not look and the LoRA stack in Create could never
      // offer it.
      const name = (itemName ?? '').toLowerCase()
      if (type === 'Checkpoint' && (name.includes('flux') || name.includes('wan') || name.includes('hunyuan'))) {
        subfolder = 'diffusion_models'
      }

      const filename = asString(prop(file, 'name'))
        || `${(itemName ?? '').replace(/[^a-zA-Z0-9._-]/g, '_')}.safetensors`
      // A GGUF quant is a bare diffusion model whatever its name says, and the
      // only loader that lists .gguf (ComfyUI-GGUF's UnetLoaderGGUF) reads
      // diffusion_models/unet. In checkpoints/ nothing ever saw it (a user,
      // Discord 2026-09-23: qwenImageEdit2511_q50.gguf "Complete", Installed 0).
      if (type === 'Checkpoint' && isGgufFile(filename)) subfolder = 'diffusion_models'

      const descParts: string[] = []
      const rawDesc = civitaiDescriptionToText(asString(prop(item, 'description')) ?? '')
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
        sizeBytes: sizeKB > 0 ? Math.round(sizeKB * 1024) : undefined,
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
