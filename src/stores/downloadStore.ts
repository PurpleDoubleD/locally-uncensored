import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  getDownloadProgress, pauseDownload, cancelDownload, clearDownloadEntry, resumeDownload,
  startModelDownload, startModelDownloadToPath, lookupFileMeta, modelsNotVisibleInComfy,
  isPermanentDownloadError, findOrphanDownloads, deleteOrphanDownload, orphanFilename,
  catalogFilenames, ENUM_SUBFOLDERS, comfyModelTarget, removeImagePart, type DownloadProgress, type OrphanDownload,
} from '../api/discover'
import { imagePartFileName, isImagePartFile } from '../lib/image-part'
import { isTauri } from '../api/backend'
import { isMobileHost } from '../lib/mobile-host'
import { coalescedJSONStorage } from '../lib/coalescedStorage'
import { waitForModelsVisible } from '../lib/bundle-install'
import { log } from '../lib/logger'

/** Files whose visibility wait is already running. The poller ticks once a
 *  second and a wait lives for up to a minute, so without this the same file
 *  would start a fresh wait on every tick. */
const awaitingVisibility = new Set<string>()

/** Tell everyone a model arrived, and keep telling them until ComfyUI can
 *  actually see it.
 *
 *  The Model Manager half of C8. A finished download is not a finished
 *  install: ComfyUI serves what its own directory scan has picked up, and on
 *  the big files that scan is still running when the last byte lands. Create
 *  learned to wait for that on 2026-08-13 (a user AI, a user). This
 *  path never did. It fired one event, useModels ran one fetch against a
 *  stale /object_info, and the model was simply absent from the Installed tab
 *  and every picker until the user reloaded by hand. Same slow scan, same too
 *  short window, quieter symptom.
 *
 *  Deliberately NOT the healing engine restart Create does. That decision
 *  belongs to a surface that knows whether a render is in flight; a background
 *  poller must never stop the engine under somebody's job.
 *
 *  Best effort throughout: a file we cannot judge, an engine that is not up
 *  and a probe that throws all leave the single event that was already there. */
async function announceUntilVisible(filename: string, subfolder: string | undefined): Promise<void> {
  // Only the enumerated subfolders can be judged at all. loras, upscale models
  // and the GGUF text downloads never show up in these lists, so waiting on
  // them would be a minute of certain failure.
  if (!subfolder || !ENUM_SUBFOLDERS.has(subfolder)) return
  if (awaitingVisibility.has(filename)) return
  awaitingVisibility.add(filename)
  try {
    const { checkComfyConnection, refreshComfyModels } = await import('../api/comfyui')
    // One cheap probe first: with the engine down the wait would spend its
    // whole budget on requests that cannot be answered.
    if (!(await checkComfyConnection())) return
    // A ComfyUI on another machine cannot see a file on this one until the
    // user copies it over (GH #143); the Model Manager already said so.
    if ((await comfyModelTarget()).remote) return
    const left = await waitForModelsVisible({
      missing: () => modelsNotVisibleInComfy([filename]),
      refresh: async () => {
        await refreshComfyModels().catch(() => false)
        window.dispatchEvent(new CustomEvent('comfyui-model-downloaded', { detail: { filename } }))
      },
    })
    if (left.length > 0) {
      log.warn('[downloads] ComfyUI still does not list the finished download', { filename })
    }
  } catch (err) {
    log.warn('[downloads] visibility wait failed', { filename, err })
  } finally {
    awaitingVisibility.delete(filename)
  }
}

/**
 * What to tell the user about a file that is on disk while the running ComfyUI
 * does not list it.
 *
 * The old text named one cause, a model folder LU and ComfyUI do not share
 *. For a .gguf that is almost never the cause. UNETLoader does not
 * enumerate .gguf at all: the file is read by ComfyUI-GGUF's own loader, so a
 * pack that is missing, or that failed to import because its gguf dependency
 * landed in a different Python environment, leaves ComfyUI with no loader that
 * can see the file even though the folder is exactly right. Every Unfiltered
 * video bundle we ship is a GGUF, which is what a user and Blahx were looking at.
 *
 * English on purpose, like every error text in the product.
 */
export function invisibleFileMessage(filename: string): string {
  if (filename.toLowerCase().endsWith('.gguf')) {
    return `${filename} is on disk, but the running ComfyUI does not list it. GGUF models are read by the ComfyUI-GGUF node pack, so this usually means that pack is missing or failed to load. Install this model again from the Model Manager: that installs the pack and restarts ComfyUI. If it is still missing afterwards, LU and ComfyUI are pointed at different model folders, so set the right ComfyUI install under Settings, AI Backends.`
  }
  return `${filename} is on disk, but the running ComfyUI does not list it, so LU and ComfyUI are pointed at different model folders. Set the right ComfyUI install under Settings, AI Backends, or restart ComfyUI from LU, then try again.`
}

// Maps filename → bundle name for grouped display
type BundleMap = Record<string, string>

/**
 * Everything needed to start the same transfer a second time.
 *
 * `destDir` is the part that used to die with the process: a GGUF text model is
 * downloaded by path, not by ComfyUI subfolder, and a retry without the destDir
 * falls back to the subfolder branch and writes the file into a directory no
 * backend looks in — downloaded, invisible, and no error anywhere.
 */
export interface DownloadMeta {
  url: string
  subfolder: string
  destDir?: string
  /** Catalog estimate. Plans the space guard, never decides completeness. */
  expectedBytes?: number
  /** Content digest, when the catalog states one. */
  sha256?: string
}

/** One file of a download that goes to a folder by path (every GGUF of the built-in engine). */
export interface PathDownload {
  url: string
  filename: string
  expectedBytes?: number
  sha256?: string
}

/**
 * How a start by path ended. The backend answers "exists", "already_running"
 * and "error" as values, not as exceptions, and every caller used to read
 * them for itself (or not at all).
 */
export type PathStartAnswer =
  | { answer: 'started' }
  /** The file is already there, complete. The row is marked done. */
  | { answer: 'exists' }
  /** A transfer of this file is already running. It keeps running. */
  | { answer: 'running' }
  | { answer: 'error'; error?: string }

/**
 * Files that are downloaded by path and that the desktop catalog does not
 * list: the phone catalog. Registered by whoever owns such a list, so this
 * store can name a partial of theirs after a restart without importing them
 * (the desktop bundle must not pull the phone catalog in).
 */
const pathCatalog = new Map<string, PathDownload>()

/** Make files known to the orphan scan. Calling it again with the same list changes nothing. */
export function registerPathCatalog(files: readonly PathDownload[]): void {
  for (const f of files) if (f.filename && f.url) pathCatalog.set(f.filename, { ...f })
}

/** For tests. */
export function clearPathCatalog(): void {
  pathCatalog.clear()
}

/** A `.download` file from an earlier run, plus what we could work out about it. */
export interface OrphanEntry extends OrphanDownload {
  /** The download id, when the stem could be matched back to a known file.
   *  `null` means it can be shown and deleted but not resumed. */
  filename: string | null
}

interface DownloadStoreState {
  downloads: Record<string, DownloadProgress>
  /** Rows this side wrote itself: a bundle file that was on disk already, a
   *  file ComfyUI does not list. Rust has no entry for them, so a poll that
   *  takes Rust's list as the whole picture wiped them a second later, and a
   *  bundle of five showed three files (the box, 03.10.2026). They are merged
   *  under Rust's rows and go when the user clears, cancels or restarts them. */
  ownRows: Record<string, DownloadProgress>
  downloadMeta: Record<string, DownloadMeta>
  bundleMap: BundleMap  // filename → bundle name
  /** Partials found on disk with no transfer behind them, keyed by stem. */
  orphans: Record<string, OrphanEntry>
  /** Files the user cancelled and has not started again. The tray keeps them
   *  with their bundle, so a bundle with cancelled files never reads as
   *  complete (lib/download-tray). This session only. */
  cancelled: string[]
  /** Finished files the user cleared from the badge. Rust keeps finished
   *  entries in its map, so without this list the next poll brought the row
   *  straight back. A new start of the same file takes it off the list. This
   *  session only. */
  dismissed: string[]
  polling: boolean
  pollInterval: ReturnType<typeof setInterval> | null
  pollCount: number

  refresh: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  setMeta: (filename: string, url: string, subfolder: string, destDir?: string, extra?: { expectedBytes?: number; sha256?: string }) => void
  /** Start one file into a folder: remember how to start it again, save that at
   *  once, start, and say how the start ended. */
  startToPath: (file: PathDownload, destDir: string) => Promise<PathStartAnswer>
  setBundleGroup: (bundleName: string, filenames: string[]) => void
  markComplete: (filename: string) => void
  markInvisible: (filename: string) => void
  pause: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  /** Continue where the transfer stopped. False when nothing is known about
   *  the file any more, or when the start by path was refused. */
  resume: (id: string) => Promise<boolean>
  retry: (id: string) => Promise<void>
  dismiss: (id: string) => void
  /** The user cleared the bundle's row: its cancelled files go with it. */
  forgetCancelled: (ids: string[]) => void
  scanOrphans: () => Promise<void>
  resumeOrphan: (stem: string) => Promise<void>
  discardOrphan: (stem: string) => Promise<void>
}

/**
 * The rows an orphaned partial contributes to the download list.
 *
 * Shown as `paused`, because that is exactly what it is: bytes on disk waiting
 * for the rest. Rendering them through the normal list is what gives a partial
 * that survived a restart a Cancel button at all — before this the file was
 * simply unreachable from inside the app.
 *
 * Only resolvable orphans get a row. One whose stem matches nothing known can
 * be listed and deleted, but a row promising Resume that cannot resume is worse
 * than no row.
 */
export function orphanRows(
  orphans: Record<string, OrphanEntry>,
  meta: Record<string, DownloadMeta>,
): Record<string, DownloadProgress> {
  const rows: Record<string, DownloadProgress> = {}
  for (const o of Object.values(orphans)) {
    if (!o.filename) continue
    rows[o.filename] = {
      progress: o.bytes,
      // The catalog estimate only sizes the bar. It is never the truth about
      // completeness — that question is settled against the server.
      total: meta[o.filename]?.expectedBytes ?? 0,
      speed: 0,
      filename: o.filename,
      status: 'paused',
    }
  }
  return rows
}

// Listen for "exists" events from installBundleComplete — mark files as complete immediately
if (typeof window !== 'undefined') {
  window.addEventListener('comfyui-download-exists', ((e: CustomEvent<{ filename: string }>) => {
    useDownloadStore.getState().markComplete(e.detail.filename)
  }) as EventListener)
  // File exists on disk but the RUNNING ComfyUI does not list it — LU and
  // ComfyUI are looking at different model folders. Shown as an error row so
  // the user gets an explanation instead of a silent "already installed".
  window.addEventListener('comfyui-model-invisible', ((e: CustomEvent<{ filename: string }>) => {
    useDownloadStore.getState().markInvisible(e.detail.filename)
  }) as EventListener)
}

/**
 * Where the retry information survives a restart.
 *
 * Both sides of the download used to keep everything in RAM. Quitting the app
 * during a 40 GB transfer therefore left the `.download` file on disk with no
 * row, no button and — worse — no `destDir`, so even starting the same model
 * again wrote it somewhere no backend looks.
 *
 * Coalesced, because the poller writes into this store once a second while a
 * download runs and zustand persists on EVERY set(): without it that is a
 * serialise-and-write per tick for state that changes maybe twice an hour.
 */
const downloadStorage = coalescedJSONStorage<DownloadStoreState>(
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
)

/** Push the pending write out now instead of waiting for the coalescing
 *  window. The point of persisting this store is surviving a close, so the
 *  close is where it has to be on disk. */
export function flushDownloadPersist(): Promise<void> {
  return downloadStorage.flush()
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', () => { void downloadStorage.flush() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void downloadStorage.flush()
  })
}

/** Ceiling on remembered meta. Each entry is a URL and a folder — tiny — but
 *  the catalog has ~150 files and a user can add their own, so the map is
 *  trimmed rather than grown forever inside a 5 MB origin quota. */
const META_LIMIT = 400

/** Rows whose cancel is on its way, so that one click cannot cancel a file twice. */
const cancelling = new Set<string>()

export const useDownloadStore = create<DownloadStoreState>()(persist((set, get) => ({
  downloads: {},
  ownRows: {},
  downloadMeta: {},
  bundleMap: {},
  orphans: {},
  cancelled: [],
  dismissed: [],
  polling: false,
  pollInterval: null,

  pollCount: 0,

  refresh: async () => {
    try {
      const raw = await getDownloadProgress()
      const prev = get().downloads
      // A finished row the user cleared stays cleared. An entry that is no
      // longer finished is a new run of that file and shows again.
      const dismissed = get().dismissed.filter((id) => raw[id]?.status === 'complete')
      const prog = Object.fromEntries(Object.entries(raw).filter(([id]) => !dismissed.includes(id)))

      // Detect newly completed downloads and dispatch event. The filename
      // rides along now so a listener can tell WHICH model arrived; every
      // existing listener ignores the detail, so nothing had to change.
      for (const [id, d] of Object.entries(prog)) {
        if (d.status === 'complete' && prev[id]?.status !== 'complete') {
          window.dispatchEvent(new CustomEvent('comfyui-model-downloaded', { detail: { filename: id } }))
          // And then keep saying it until ComfyUI lists the file, because one
          // event against a scan that has not finished reaches nobody.
          const meta = get().downloadMeta[id] ?? lookupFileMeta(id) ?? undefined
          void announceUntilVisible(id, meta?.subfolder)
        }
      }

      const count = get().pollCount + 1
      // Rust owns the live rows; an adopted orphan only fills a gap Rust has
      // nothing for. The moment a resume starts, the real entry takes over and
      // the orphan stops being one.
      const { orphans, downloadMeta, ownRows } = get()
      const stillOrphaned = Object.fromEntries(
        Object.entries(orphans).filter(([, o]) => !o.filename || !prog[o.filename]),
      )
      set({
        downloads: { ...orphanRows(stillOrphaned, downloadMeta), ...ownRows, ...prog },
        orphans: stillOrphaned,
        dismissed,
        pollCount: count,
      })

      // Auto-stop polling when no active downloads
      // BUT wait at least 5 polls before stopping — gives Rust time to register new downloads
      const hasActive = Object.values(prog).some(d =>
        d.status === 'downloading' || d.status === 'connecting' || d.status === 'pausing'
      )
      if (!hasActive && count >= 5) {
        get().stopPolling()
      }
    } catch {
      // Keep polling on transient errors
    }
  },

  startPolling: () => {
    const state = get()
    if (state.polling) return
    const interval = setInterval(() => get().refresh(), 1000)
    set({ polling: true, pollInterval: interval, pollCount: 0 })
    // Immediate first fetch
    get().refresh()
  },

  stopPolling: () => {
    const state = get()
    if (state.pollInterval) clearInterval(state.pollInterval)
    set({ polling: false, pollInterval: null })
  },

  setMeta: (filename, url, subfolder, destDir?, extra?) => {
    set(s => {
      // Defence in depth: a caller that forgot the digest or the byte count gets
      // the catalog's, when the catalog names the SAME address. Retry and resume
      // read only this record, so a hole here is a download that installs a
      // swapped file unchecked.
      const filled = fillFromCatalog({ url, subfolder, destDir, ...extra }, filename)
      const next = { ...s.downloadMeta, [filename]: filled }
      const keys = Object.keys(next)
      if (keys.length > META_LIMIT) {
        // Oldest first — insertion order is the only age we have, and the
        // entries that matter are the ones just started.
        for (const k of keys.slice(0, keys.length - META_LIMIT)) delete next[k]
      }
      // Every start goes through here first, so a file that is started
      // again stops counting as cancelled, and what this side said about
      // it before (already there, not listed) is no longer the news.
      return {
        downloadMeta: next,
        cancelled: s.cancelled.filter((f) => f !== filename),
        dismissed: s.dismissed.filter((f) => f !== filename),
        ownRows: without(s.ownRows, filename),
      }
    })
  },

  startToPath: async (file, destDir) => {
    get().setMeta(file.filename, file.url, 'gguf', destDir, { expectedBytes: file.expectedBytes, sha256: file.sha256 })
    // This record is what a restart resumes from. It must not wait for the
    // next write window: an app that is closed a second after the tap would
    // leave a partial nobody can name.
    void flushDownloadPersist().catch(() => { /* the next window writes it */ })
    const res = await startModelDownloadToPath(file.url, destDir, file.filename, file.expectedBytes, file.sha256)
    if (res?.status === 'exists') {
      get().markComplete(file.filename)
      return { answer: 'exists' }
    }
    if (res?.status === 'error') return { answer: 'error', error: res.error }
    set(s => ({ orphans: withoutFilename(s.orphans, file.filename) }))
    get().startPolling()
    return res?.status === 'already_running' ? { answer: 'running' } : { answer: 'started' }
  },

  setBundleGroup: (bundleName, filenames) => {
    set(s => {
      const updated = { ...s.bundleMap }
      for (const f of filenames) updated[f] = bundleName
      return { bundleMap: updated }
    })
  },

  markComplete: (filename: string) => {
    const row: DownloadProgress = { progress: 1, total: 1, speed: 0, filename, status: 'complete' }
    set(s => ({
      downloads: { ...s.downloads, [filename]: row },
      ownRows: { ...s.ownRows, [filename]: row },
    }))
  },

  markInvisible: (filename: string) => {
    const row: DownloadProgress = {
      progress: 0, total: 0, speed: 0, filename, status: 'error',
      error: invisibleFileMessage(filename),
    }
    set(s => ({
      downloads: { ...s.downloads, [filename]: row },
      ownRows: { ...s.ownRows, [filename]: row },
    }))
  },

  pause: async (id: string) => {
    await pauseDownload(id)
    await get().refresh()
  },

  /** The user aborting: the transfer stops AND the partial file goes. The one
   *  path that is allowed to throw bytes away. */
  cancel: async (id: string) => {
    // A finished file has nothing to cancel. "Cancel all" on a bundle used to
    // drop its row too, and the next poll brought it straight back.
    if (get().downloads[id]?.status === 'complete') return
    // "Cancel all" calls this once per row, in one go. A model takes its image
    // part along (below), so the part's own call would cancel it a second
    // time. Whoever is already being cancelled is left to the call that has it.
    if (cancelling.has(id)) return
    // A model and its image part are one download, so cancelling the model
    // takes the part along: a part that is still running is cancelled like
    // the model, and one that already finished is removed from disk, because
    // without its model it belongs to nothing and no list shows it. The other
    // direction does not hold: cancelling only the part leaves the model.
    const candidate = /\.gguf$/i.test(id) && !isImagePartFile(id) ? imagePartFileName(id) : null
    const part = candidate && !cancelling.has(candidate) ? candidate : null
    const partRow = part ? get().downloads[part] : undefined
    const partMeta = part ? get().downloadMeta[part] : undefined
    const mine = part && partRow ? [id, part] : [id]
    for (const f of mine) cancelling.add(f)
    const gone = [id]
    try {
      await cancelDownload(id)
      if (part && partRow && partRow.status !== 'complete') {
        await cancelDownload(part)
        gone.push(part)
      } else if (part && partRow && partMeta?.destDir) {
        await removeImagePart(partMeta.destDir, part)
        gone.push(part)
      }
    } finally {
      for (const f of mine) cancelling.delete(f)
    }
    set(s => {
      const updated = { ...s.downloads }
      let ownRows = s.ownRows
      let orphans = s.orphans
      for (const f of gone) {
        delete updated[f]
        // An adopted orphan must go from BOTH places or the next poll
        // re-adopts the row the user just cancelled.
        ownRows = without(ownRows, f)
        orphans = withoutFilename(orphans, f)
      }
      return {
        downloads: updated,
        ownRows,
        orphans,
        cancelled: [...s.cancelled, ...gone.filter((f) => !s.cancelled.includes(f))],
      }
    })
    // A finished part has a row on the Rust side too, and the next poll would
    // bring it straight back.
    for (const f of gone.slice(1)) await clearDownloadEntry(f).catch(() => {})
  },

  resume: async (id: string) => {
    const meta = ensureMeta(get, id)
    if (!meta) return false
    if (meta.destDir) {
      // A file that was downloaded by path (every GGUF of the built-in engine,
      // a chat model, its image part) has no ComfyUI subfolder, and
      // `resume_download` resolves its folder from one: it found no half file
      // there, began at zero and wrote the 0.9 GB of an image part into
      // ComfyUI's models folder, where no engine looks for it (box,
      // 09.10.2026). Starting the same download by path again IS the resume:
      // the backend finds the `.download` next to the target and asks the
      // source for the rest.
      if (get().downloads[id]?.status === 'error') {
        // A settled failure keeps its row on the backend, and the next poll
        // would bring the red card back over the running transfer.
        await clearDownloadEntry(id).catch(() => { /* best effort */ })
      }
      const res = await startModelDownloadToPath(meta.url, meta.destDir, id, meta.expectedBytes, meta.sha256)
      if (res?.status === 'exists') {
        // The whole file is there already (the partial was the last step away).
        get().markComplete(id)
        set(s => ({ orphans: withoutFilename(s.orphans, id) }))
        return true
      }
      if (res?.status === 'error') return false
    } else {
      await resumeDownload(id, meta.url, meta.subfolder, meta.expectedBytes, meta.sha256)
    }
    set(s => ({ orphans: withoutFilename(s.orphans, id) }))
    get().startPolling()
    return true
  },

  /**
   * Start the same download again after it failed.
   *
   * This must NOT delete the partial file. It used to: the error path handed
   * the id to `cancelDownload`, and cancel removes `<dest>.download` for a
   * paused or errored entry. So the sequence the UI recommends — "Download
   * ended early ... start it again to resume" next to a Retry button — deleted
   * the bytes it was about to resume from and restarted at zero. On a 40 GB
   * bundle over a shaky line that never finishes, and every attempt costs the
   * user everything the last one achieved.
   *
   * The Rust row still has to be cleared, or `download_model` short-circuits on
   * the file already on disk without touching the map and the next poll
   * resurrects the error card. `clearDownloadEntry` is that
   * bookkeeping without the collateral damage.
   */
  retry: async (id: string) => {
    const current = get().downloads[id]
    // A renamed, gated or deleted repository answers the same way forever.
    // Restarting is not a fix, it is the same failure a second time, and the
    // partial that is on disk stays where it is.
    if (current?.status === 'error' && isPermanentDownloadError(current.error)) {
      log.warn('[downloadStore] retry refused · the address itself is dead', { id, error: current.error })
      return
    }
    const meta = ensureMeta(get, id)
    if (!meta) {
      log.warn('[downloadStore] retry: no meta found for', { id })
      return
    }
    if (current?.status === 'error') {
      await clearDownloadEntry(id).catch(() => { /* best effort — a restart clears it */ })
    }
    set(s => ({
      downloads: without(s.downloads, id),
      ownRows: without(s.ownRows, id),
      orphans: withoutFilename(s.orphans, id),
    }))
    // Re-start the download — use path-based for GGUF text models, subfolder-based for ComfyUI
    if (meta.destDir) {
      await startModelDownloadToPath(meta.url, meta.destDir, id, meta.expectedBytes, meta.sha256)
    } else {
      await startModelDownload(meta.url, meta.subfolder, id, meta.expectedBytes, meta.sha256)
    }
    get().startPolling()
  },

  dismiss: (id: string) => {
    // Errored entries also live in the Rust download map; drop them there
    // too or the next refresh() (Models-tab remount) resurrects the error
    // card the user just cleared. Only for 'error' —
    // cancelling an active transfer or a completed entry is not dismiss's
    // job (the badge dismisses completed entries FE-only by design).
    //
    // Clearing the row, NOT cancelling: closing a red card is not a decision
    // to throw away the gigabytes it downloaded before it failed. The partial
    // stays and shows up as a resumable orphan on the next start; Cancel is
    // the button that deletes.
    const status = get().downloads[id]?.status
    if (status === 'error') {
      clearDownloadEntry(id).catch(() => { /* app restart clears it anyway */ })
    }
    // The phone shell clears a finished row for good: its list polls again on
    // every visit, and a row the backend still holds came back a second after
    // it was cleared. The desktop badge keeps dismissing finished rows on this
    // side only, as before, and remembers them so the next poll of the Rust
    // map does not bring them back.
    const remember = status === 'complete' && !isMobileHost()
    if (status === 'complete' && !remember) {
      clearDownloadEntry(id).catch(() => { /* app restart clears it anyway */ })
    }
    set(s => ({
      dismissed: remember && !s.dismissed.includes(id) ? [...s.dismissed, id] : s.dismissed,
      downloads: without(s.downloads, id),
      ownRows: without(s.ownRows, id),
      orphans: withoutFilename(s.orphans, id),
    }))
  },

  forgetCancelled: (ids: string[]) => {
    set(s => ({ cancelled: s.cancelled.filter((f) => !ids.includes(f)) }))
  },

  /**
   * Find `.download` files left behind by an earlier run and make them
   * reachable again.
   *
   * The disk is the only place that still knows what was in flight when the app
   * was closed, so it is what gets asked. The persisted `destDir`s go along:
   * a GGUF for LM Studio lives outside the ComfyUI tree and the Rust side has
   * no way to guess where.
   */
  scanOrphans: async () => {
    const meta = get().downloadMeta
    const extraDirs = [...new Set(Object.values(meta).map(m => m.destDir).filter((d): d is string => !!d))]
    const found = await findOrphanDownloads(extraDirs)
    if (found.length === 0) {
      if (Object.keys(get().orphans).length > 0) set({ orphans: {} })
      return
    }
    // Meta first: it is the only source that also knows the destDir. The
    // catalog is the fallback for a partial from before this store persisted
    // anything.
    const known = [...Object.keys(meta), ...catalogFilenames(), ...pathCatalog.keys()]
    const orphans: Record<string, OrphanEntry> = {}
    for (const o of found) {
      const filename = orphanFilename(o.stem, known)
      orphans[o.stem] = { ...o, filename }
      // Backfill what the catalog knows for a partial from before this store
      // persisted anything — the size so the bar means something, the url and
      // subfolder so Resume has somewhere to go.
      if (filename && !get().downloadMeta[filename]) {
        const cat = lookupFileMeta(filename)
        const byPath = pathCatalog.get(filename)
        if (cat) {
          get().setMeta(filename, cat.url, cat.subfolder, undefined, {
            expectedBytes: cat.expectedBytes,
            sha256: cat.sha256,
          })
        } else if (byPath) {
          // A file that is fetched by path resumes into the folder its partial
          // lies in. That folder is the one thing the disk still knows.
          get().setMeta(filename, byPath.url, 'gguf', o.dir, {
            expectedBytes: byPath.expectedBytes,
            sha256: byPath.sha256,
          })
        }
      }
    }
    const unresolved = Object.values(orphans).filter(o => !o.filename)
    if (unresolved.length > 0) {
      log.warn('[downloads] partial files that match no known model', {
        files: unresolved.map(o => o.path),
      })
    }
    log.info('[downloads] adopted partial downloads from an earlier run', {
      count: found.length,
      bytes: found.reduce((s, o) => s + o.bytes, 0),
    })
    set(s => ({ orphans, downloads: { ...orphanRows(orphans, s.downloadMeta), ...s.downloads } }))
  },

  /** Continue an orphan where it stopped. Needs the meta that now survives a
   *  restart — without `destDir` a GGUF would land in the wrong folder. */
  resumeOrphan: async (stem: string) => {
    const o = get().orphans[stem]
    if (!o?.filename) return
    await get().resume(o.filename)
  },

  /** Throw an orphaned partial away, on the user's say-so. */
  discardOrphan: async (stem: string) => {
    const o = get().orphans[stem]
    if (!o) return
    const extraDirs = o.dir ? [o.dir] : []
    await deleteOrphanDownload(o.path, extraDirs).catch(err => {
      log.warn('[downloads] could not remove orphaned partial', { path: o.path, err })
    })
    set(s => {
      const orphans = { ...s.orphans }
      delete orphans[stem]
      const downloads = { ...s.downloads }
      if (o.filename && downloads[o.filename]?.status === 'paused') delete downloads[o.filename]
      return { orphans, downloads }
    })
  },
}), {
  name: 'locally-uncensored-downloads',
  storage: downloadStorage,
  version: 1,
  // Only what a RESTART cannot rebuild. `downloads` is Rust's to report and
  // would come back as a lie ("downloading" with nothing running); `orphans` is
  // re-derived from the disk, which is the only honest source; `pollInterval`
  // is a live timer handle.
  partialize: (s) => ({ downloadMeta: s.downloadMeta, bundleMap: s.bundleMap }) as DownloadStoreState,
  migrate: (persisted) => persisted as DownloadStoreState,
  onRehydrateStorage: () => (state) => {
    // The scan needs the Rust side, so it only runs in the app. In a browser
    // dev build or a test there is no disk to ask.
    if (state && isTauri()) void state.scanOrphans()
  },
}))

/** Add the catalog's sha256 and byte count to a record that lacks them, but only
 *  when the catalog entry is the same address: a Civitai file or a user's own
 *  GGUF that happens to share a name must never inherit a foreign digest. */
export function fillFromCatalog(meta: DownloadMeta, filename: string): DownloadMeta {
  if (meta.sha256 && meta.expectedBytes) return meta
  const cat = lookupFileMeta(filename)
  if (!cat || cat.url !== meta.url) return meta
  const sha256 = meta.sha256 ?? cat.sha256
  const expectedBytes = meta.expectedBytes ?? cat.expectedBytes
  if (sha256 === meta.sha256 && expectedBytes === meta.expectedBytes) return meta
  return { ...meta, sha256, expectedBytes }
}

/** Meta for `id`, filling in from the catalog and remembering what it found.
 *  Retry and resume both need it and both used to lose the destDir. */
function ensureMeta(get: () => DownloadStoreState, id: string): DownloadMeta | null {
  const known = get().downloadMeta[id]
  if (known) {
    // A record written without the digest (older callers, a persisted one) is
    // completed from the catalog before retry or resume reads it.
    const filled = fillFromCatalog(known, id)
    if (filled !== known) {
      get().setMeta(id, filled.url, filled.subfolder, filled.destDir, {
        expectedBytes: filled.expectedBytes, sha256: filled.sha256,
      })
    }
    return filled
  }
  const found = lookupFileMeta(id)
  if (!found) return null
  const meta: DownloadMeta = {
    url: found.url,
    subfolder: found.subfolder,
    expectedBytes: found.expectedBytes,
    sha256: found.sha256,
  }
  get().setMeta(id, meta.url, meta.subfolder, undefined, {
    expectedBytes: meta.expectedBytes,
    sha256: meta.sha256,
  })
  return meta
}

/** `rows` without `id`; the same object when `id` is not in it. */
function without<T>(rows: Record<string, T>, id: string): Record<string, T> {
  if (!(id in rows)) return rows
  const next = { ...rows }
  delete next[id]
  return next
}

/** Drop the orphan that resolved to `filename`, whatever its stem was. */
function withoutFilename(
  orphans: Record<string, OrphanEntry>,
  filename: string,
): Record<string, OrphanEntry> {
  const hit = Object.entries(orphans).find(([, o]) => o.filename === filename)
  if (!hit) return orphans
  const next = { ...orphans }
  delete next[hit[0]]
  return next
}
