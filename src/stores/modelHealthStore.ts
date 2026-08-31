import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'

/**
 * Tracks which installed Ollama models have stale manifests (rejected by
 * Ollama 0.20.7 with "does not support (chat|completion|generate)").
 *
 * Populated by the startup health scan (AppShell) and consumed by:
 *   - StaleModelsBanner — top-of-app notice with "Refresh All"
 *   - Header Lichtschalter — knows without a load attempt that the model is stale
 *   - DiscoverModels — shows "Needs Refresh" badge instead of green "Installed"
 *
 * `dismissed` is session-only so the banner reappears next launch if stale
 * models remain. `lastScanTime` is persisted so we can skip re-scan for a
 * cool-down window on app restart.
 */

interface ModelHealthState {
  staleModels: string[]
  lastScanTime: number
  scanning: boolean
  dismissed: boolean
  // actions
  setStaleModels: (models: string[]) => void
  markFresh: (name: string) => void
  setScanning: (scanning: boolean) => void
  dismiss: () => void
  reset: () => void
}

export const useModelHealthStore = create<ModelHealthState>()(
  persist(
    (set) => ({
      staleModels: [],
      lastScanTime: 0,
      scanning: false,
      dismissed: false,
      // Only un-dismiss when the stale set actually CHANGED. The health scan
      // runs once per launch, so clearing the flag unconditionally meant the
      // banner returned on every start over the same untouched model and
      // "dismiss" was decorative.
      setStaleModels: (models) =>
        set((s) => {
          const same =
            s.staleModels.length === models.length &&
            models.every((m) => s.staleModels.includes(m))
          return {
            staleModels: models,
            lastScanTime: Date.now(),
            dismissed: same ? s.dismissed : false,
          }
        }),
      markFresh: (name) =>
        set((s) => ({ staleModels: s.staleModels.filter((m) => m !== name) })),
      setScanning: (scanning) => set({ scanning }),
      dismiss: () => set({ dismissed: true }),
      reset: () =>
        set({ staleModels: [], scanning: false, dismissed: false, lastScanTime: 0 }),
    }),
    {
      name: 'locally-uncensored-model-health',
      storage: safeJSONStorage(),
      // `dismissed` persists as of 2.5.9: the banner re-ran its startup scan and
      // came back on EVERY launch while a stale model sat on disk, so closing it
      // meant nothing. A fresh scan that finds stale models clears the flag
      // again (setStaleModels), so a genuinely new problem still speaks up.
      // `scanning` stays session-only — a crash mid-scan must not persist as
      // "still scanning".
      partialize: (s) => ({ staleModels: s.staleModels, lastScanTime: s.lastScanTime, dismissed: s.dismissed }),
    }
  )
)
