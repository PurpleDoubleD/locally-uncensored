import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  getDownloadProgress, pauseDownload, cancelDownload, clearDownloadEntry, resumeDownload,
  startModelDownload, startModelDownloadToPath, lookupFileMeta, modelsNotVisibleInComfy,
  isPermanentDownloadError, findOrphanDownloads, deleteOrphanDownload, orphanFilename,
  catalogFilenames, ENUM_SUBFOLDERS, type DownloadProgress, type OrphanDownload,
} from '../api/discover'
import { isTauri } from '../api/backend'
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
 *  learned to wait for that on 2026-08-13 (Voxyl AI, Aldrich Ironhart). This
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
 * (pnwpdr4519). For a .gguf that is almost never the cause. UNETLoader does not
 * enumerate .gguf at all: the file is read by ComfyUI-GGUF's own loader, so a
 * pack that is missing, or that failed to import because its gguf dependency
 * landed in a different Python environment, leaves ComfyUI with no loader that
 * can see the file even though the folder is exactly right. Every Unfiltered
 * video bundle we ship is a GGUF, which is what lapbo and Blahx were looking at.
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

/** A `.download` file from an earlier run, plus what we could work out about it. */
export interface OrphanEntry extends OrphanDownload {
  /** The download id, when the stem could be matched back to a known file.
   *  `null` means it can be shown and deleted but not resumed. */
  filename: string | null
}

interface DownloadStoreState {
  downloads: Record<string, DownloadProgress>
  downloadMeta: Record<string, DownloadMeta>
  bundleMap: BundleMap  // filename → bundle name
  /** Partials found on disk with no transfer behind them, keyed by stem. */
  orphans: Record<string, OrphanEntry>
  polling: boolean
  pollInterval: ReturnType<typeof setInterval> | null
  pollCount: number

  refresh: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  setMeta: (filename: string, url: string, subfolder: string, destDir?: string, extra?: { expectedBytes?: number; sha256?: string }) => void
  setBundleGroup: (bundleName: string, filenames: string[]) => void
  markComplete: (filename: string) => void
  markInvisible: (filename: string) => void
  pause: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  retry: (id: string) => Promise<void>
  dismiss: (id: string) => void
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

export const useDownloadStore = create<DownloadStoreState>()(persist((set, get) => ({
  downloads: {},
  downloadMeta: {},
  bundleMap: {},
  orphans: {},
  polling: false,
  pollInterval: null,

  pollCount: 0,

  refresh: async () => {
    try {
      const prog = await getDownloadProgress()
      const prev = get().downloads

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
      const { orphans, downloadMeta } = get()
      const stillOrphaned = Object.fromEntries(
        Object.entries(orphans).filter(([, o]) => !o.filename || !prog[o.filename]),
      )
      set({
        downloads: { ...orphanRows(stillOrphaned, downloadMeta), ...prog },
        orphans: stillOrphaned,
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
      const next = { ...s.downloadMeta, [filename]: { url, subfolder, destDir, ...extra } }
      const keys = Object.keys(next)
      if (keys.length > META_LIMIT) {
        // Oldest first — insertion order is the only age we have, and the
        // entries that matter are the ones just started.
        for (const k of keys.slice(0, keys.length - META_LIMIT)) delete next[k]
      }
      return { downloadMeta: next }
    })
  },

  setBundleGroup: (bundleName, filenames) => {
    set(s => {
      const updated = { ...s.bundleMap }
      for (const f of filenames) updated[f] = bundleName
      return { bundleMap: updated }
    })
  },

  markComplete: (filename: string) => {
    set(s => ({
      downloads: {
        ...s.downloads,
        [filename]: { progress: 1, total: 1, speed: 0, filename, status: 'complete' },
      },
    }))
  },

  markInvisible: (filename: string) => {
    set(s => ({
      downloads: {
        ...s.downloads,
        [filename]: {
          progress: 0, total: 0, speed: 0, filename, status: 'error',
          error: invisibleFileMessage(filename),
        },
      },
    }))
  },

  pause: async (id: string) => {
    await pauseDownload(id)
    await get().refresh()
  },

  /** The user aborting: the transfer stops AND the partial file goes. The one
   *  path that is allowed to throw bytes away. */
  cancel: async (id: string) => {
    await cancelDownload(id)
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      // An adopted orphan must go from BOTH places or the next poll re-adopts
      // the row the user just cancelled.
      return { downloads: updated, orphans: withoutFilename(s.orphans, id) }
    })
  },

  resume: async (id: string) => {
    const meta = ensureMeta(get, id)
    if (!meta) return
    await resumeDownload(id, meta.url, meta.subfolder, meta.expectedBytes, meta.sha256)
    set(s => ({ orphans: withoutFilename(s.orphans, id) }))
    get().startPolling()
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
   * resurrects the error card (the_mr_pickles). `clearDownloadEntry` is that
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
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      return { downloads: updated, orphans: withoutFilename(s.orphans, id) }
    })
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
    // card the user just cleared (the_mr_pickles). Only for 'error' —
    // cancelling an active transfer or a completed entry is not dismiss's
    // job (the badge dismisses completed entries FE-only by design).
    //
    // Clearing the row, NOT cancelling: closing a red card is not a decision
    // to throw away the gigabytes it downloaded before it failed. The partial
    // stays and shows up as a resumable orphan on the next start; Cancel is
    // the button that deletes.
    if (get().downloads[id]?.status === 'error') {
      clearDownloadEntry(id).catch(() => { /* app restart clears it anyway */ })
    }
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      return { downloads: updated, orphans: withoutFilename(s.orphans, id) }
    })
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
    const known = [...Object.keys(meta), ...catalogFilenames()]
    const orphans: Record<string, OrphanEntry> = {}
    for (const o of found) {
      const filename = orphanFilename(o.stem, known)
      orphans[o.stem] = { ...o, filename }
      // Backfill what the catalog knows for a partial from before this store
      // persisted anything — the size so the bar means something, the url and
      // subfolder so Resume has somewhere to go.
      if (filename && !get().downloadMeta[filename]) {
        const cat = lookupFileMeta(filename)
        if (cat) {
          get().setMeta(filename, cat.url, cat.subfolder, undefined, {
            expectedBytes: cat.expectedBytes,
            sha256: cat.sha256,
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

/** Meta for `id`, filling in from the catalog and remembering what it found.
 *  Retry and resume both need it and both used to lose the destDir. */
function ensureMeta(get: () => DownloadStoreState, id: string): DownloadMeta | null {
  const known = get().downloadMeta[id]
  if (known) return known
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
