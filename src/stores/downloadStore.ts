import { create } from 'zustand'
import { getDownloadProgress, pauseDownload, cancelDownload, resumeDownload, startModelDownload, startModelDownloadToPath, lookupFileMeta, modelsNotVisibleInComfy, ENUM_SUBFOLDERS, type DownloadProgress } from '../api/discover'
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

interface DownloadStoreState {
  downloads: Record<string, DownloadProgress>
  downloadMeta: Record<string, { url: string; subfolder: string; destDir?: string }>
  bundleMap: BundleMap  // filename → bundle name
  polling: boolean
  pollInterval: ReturnType<typeof setInterval> | null

  refresh: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  setMeta: (filename: string, url: string, subfolder: string, destDir?: string) => void
  setBundleGroup: (bundleName: string, filenames: string[]) => void
  markComplete: (filename: string) => void
  markInvisible: (filename: string) => void
  pause: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  retry: (id: string) => Promise<void>
  dismiss: (id: string) => void
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

export const useDownloadStore = create<DownloadStoreState>()((set, get) => ({
  downloads: {},
  downloadMeta: {},
  bundleMap: {},
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
      set({ downloads: prog, pollCount: count })

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

  setMeta: (filename, url, subfolder, destDir?) => {
    set(s => ({ downloadMeta: { ...s.downloadMeta, [filename]: { url, subfolder, destDir } } }))
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

  cancel: async (id: string) => {
    await cancelDownload(id)
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      return { downloads: updated }
    })
  },

  resume: async (id: string) => {
    let meta = get().downloadMeta[id]
    if (!meta) {
      const found = lookupFileMeta(id)
      if (found) {
        meta = { url: found.url, subfolder: found.subfolder }
        get().setMeta(id, found.url, found.subfolder)
      } else return
    }
    await resumeDownload(id, meta.url, meta.subfolder)
    get().startPolling()
  },

  retry: async (id: string) => {
    let meta = get().downloadMeta[id]
    // If meta is missing (e.g. after error/restart), try to recover from bundle definitions
    if (!meta) {
      const found = lookupFileMeta(id)
      if (found) {
        meta = { url: found.url, subfolder: found.subfolder }
        get().setMeta(id, found.url, found.subfolder)
      } else {
        log.warn('[downloadStore] retry: no meta found for', { id })
        return
      }
    }
    // Clear the error state — on BOTH sides. The errored entry also lives in
    // the Rust download map, and download_model short-circuits with "exists"
    // when the file is already on disk, never touching that map. So a retry
    // that hits the short-circuit left the old error row in place and the next
    // refresh() resurrected the card the user had just retried, making the
    // model look permanently broken. Same reason dismiss() clears it there.
    if (get().downloads[id]?.status === 'error') {
      await cancelDownload(id).catch(() => { /* best effort — a restart clears it */ })
    }
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      return { downloads: updated }
    })
    // Re-start the download — use path-based for GGUF text models, subfolder-based for ComfyUI
    if (meta.destDir) {
      await startModelDownloadToPath(meta.url, meta.destDir, id)
    } else {
      await startModelDownload(meta.url, meta.subfolder, id)
    }
    get().startPolling()
  },

  dismiss: (id: string) => {
    // Errored entries also live in the Rust download map; drop them there
    // too or the next refresh() (Models-tab remount) resurrects the error
    // card the user just cleared (the_mr_pickles). Only for 'error' —
    // cancelling an active transfer or a completed entry is not dismiss's
    // job (the badge dismisses completed entries FE-only by design).
    if (get().downloads[id]?.status === 'error') {
      cancelDownload(id).catch(() => { /* app restart clears it anyway */ })
    }
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      return { downloads: updated }
    })
  },
}))
