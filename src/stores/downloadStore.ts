import { create } from 'zustand'
import { getDownloadProgress, pauseDownload, cancelDownload, resumeDownload, startModelDownload, type DownloadProgress } from '../api/discover'

// Maps filename → bundle name for grouped display
type BundleMap = Record<string, string>

interface DownloadStoreState {
  downloads: Record<string, DownloadProgress>
  downloadMeta: Record<string, { url: string; subfolder: string }>
  bundleMap: BundleMap  // filename → bundle name
  polling: boolean
  pollInterval: ReturnType<typeof setInterval> | null

  refresh: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
  setMeta: (filename: string, url: string, subfolder: string) => void
  setBundleGroup: (bundleName: string, filenames: string[]) => void
  markComplete: (filename: string) => void
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

      // Detect newly completed downloads and dispatch event
      for (const [id, d] of Object.entries(prog)) {
        if (d.status === 'complete' && prev[id]?.status !== 'complete') {
          window.dispatchEvent(new CustomEvent('comfyui-model-downloaded'))
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

  setMeta: (filename, url, subfolder) => {
    set(s => ({ downloadMeta: { ...s.downloadMeta, [filename]: { url, subfolder } } }))
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
    const meta = get().downloadMeta[id]
    if (!meta) return
    await resumeDownload(id, meta.url, meta.subfolder)
    get().startPolling()
  },

  retry: async (id: string) => {
    const meta = get().downloadMeta[id]
    if (!meta) return
    // Clear the error state first
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      return { downloads: updated }
    })
    // Re-start the download from scratch
    await startModelDownload(meta.url, meta.subfolder, id)
    get().startPolling()
  },

  dismiss: (id: string) => {
    set(s => {
      const updated = { ...s.downloads }
      delete updated[id]
      return { downloads: updated }
    })
  },
}))
