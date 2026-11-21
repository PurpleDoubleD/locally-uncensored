import { create } from 'zustand'
import { backendCall, isTauri } from '../api/backend'
import { isMobileHost } from '../lib/mobile-host'
import { isLiveJob, visibleJobs, type InstallJob, type JobMemory } from '../lib/install-jobs'
import { log } from '../lib/logger'

const POLL_MS = 1500

interface InstallJobsState {
  jobs: InstallJob[]
  memory: JobMemory
  /** Ids whose stop is on its way, so the row answers before the next poll. */
  stopping: string[]
  /** The sentence of a stop the backend refused. */
  stopError: string | null
  refresh: () => Promise<void>
  start: () => () => void
  cancel: (id: string) => Promise<void>
  dismiss: (id: string) => void
  dismissFinished: () => void
}

let timer: ReturnType<typeof setInterval> | null = null

export const useInstallJobsStore = create<InstallJobsState>((set, get) => ({
  jobs: [],
  memory: { seen: [], dismissed: [] },
  stopping: [],
  stopError: null,

  refresh: async () => {
    try {
      const raw = await backendCall<InstallJob[]>('install_jobs')
      const { jobs, memory } = visibleJobs(raw, get().memory)
      const live = jobs.filter(isLiveJob).map((j) => j.id)
      set((s) => ({ jobs, memory, stopping: s.stopping.filter((id) => live.includes(id)) }))
    } catch {
      // The next poll asks again.
    }
  },

  // Only the desktop app has these installs. A phone has no such command.
  start: () => {
    if (!isTauri() || isMobileHost()) return () => {}
    if (!timer) {
      void get().refresh()
      timer = setInterval(() => void get().refresh(), POLL_MS)
    }
    return () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  },

  cancel: async (id) => {
    if (get().stopping.includes(id)) return
    set((s) => ({ stopping: [...s.stopping, id], stopError: null }))
    try {
      await backendCall('cancel_install_job', { id })
    } catch (err) {
      log.warn('[install-jobs] stop refused', { id, err })
      set((s) => ({
        stopping: s.stopping.filter((x) => x !== id),
        stopError: err instanceof Error ? err.message : String(err),
      }))
    }
    await get().refresh()
  },

  dismiss: (id) => set((s) => ({
    jobs: s.jobs.filter((j) => j.id !== id),
    memory: { ...s.memory, dismissed: [...new Set([...s.memory.dismissed, id])] },
  })),

  dismissFinished: () => set((s) => ({
    jobs: s.jobs.filter(isLiveJob),
    memory: {
      ...s.memory,
      dismissed: [...new Set([...s.memory.dismissed, ...s.jobs.filter((j) => !isLiveJob(j)).map((j) => j.id)])],
    },
    stopError: null,
  })),
}))
