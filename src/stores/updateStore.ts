import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { version as currentVersion } from '../../package.json'
import { openExternal } from '../api/backend'

// ── Types ─────────────────────────────────────────────────────

interface UpdateState {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  downloadUrl: string | null
  releaseUrl: string | null
  releaseNotes: string | null
  isChecking: boolean
  lastChecked: number | null
  dismissed: string | null // dismissed version (so new versions still show)

  checkForUpdate: () => Promise<void>
  dismissUpdate: () => void
  clearDismiss: () => void
  openReleasePage: () => void
}

// ── Config ────────────────────────────────────────────────────

const GITHUB_REPO = 'purpledoubled/locally-uncensored'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
const INITIAL_DELAY = 5_000 // 5 seconds after app start

// ── Semver compare ────────────────────────────────────────────

function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
  const [lMajor, lMinor = 0, lPatch = 0] = parse(latest)
  const [cMajor, cMinor = 0, cPatch = 0] = parse(current)

  if (lMajor !== cMajor) return lMajor > cMajor
  if (lMinor !== cMinor) return lMinor > cMinor
  return lPatch > cPatch
}

// ── Store ─────────────────────────────────────────────────────

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      downloadUrl: null,
      releaseUrl: null,
      releaseNotes: null,
      isChecking: false,
      lastChecked: null,
      dismissed: null,

      checkForUpdate: async () => {
        const state = get()

        // Skip if already checking
        if (state.isChecking) return

        // Skip if checked recently (within interval)
        if (state.lastChecked && Date.now() - state.lastChecked < CHECK_INTERVAL) {
          return
        }

        set({ isChecking: true })

        try {
          const res = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
            {
              headers: { 'Accept': 'application/vnd.github.v3+json' },
            }
          )

          if (!res.ok) {
            set({ isChecking: false, lastChecked: Date.now() })
            return
          }

          const data = await res.json()
          const tagName = data.tag_name as string // e.g. "v2.0.2"
          const latestVersion = tagName.replace(/^v/, '')

          // Find .exe asset
          const exeAsset = (data.assets || []).find(
            (a: any) => a.name?.endsWith('.exe') || a.name?.endsWith('.msi')
          )

          const updateAvailable = isNewerVersion(latestVersion, currentVersion)

          set({
            latestVersion,
            updateAvailable,
            downloadUrl: exeAsset?.browser_download_url || null,
            releaseUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
            releaseNotes: data.body ? truncateNotes(data.body) : null,
            isChecking: false,
            lastChecked: Date.now(),
          })
        } catch {
          // Network error — silently fail (user might be offline)
          set({ isChecking: false, lastChecked: Date.now() })
        }
      },

      dismissUpdate: () => {
        const { latestVersion } = get()
        set({ dismissed: latestVersion })
      },

      clearDismiss: () => {
        set({ dismissed: null })
      },

      openReleasePage: () => {
        openExternal('https://locallyuncensored.com')
      },
    }),
    {
      name: 'lu-update-checker',
      partialize: (state) => ({
        lastChecked: state.lastChecked,
        // dismissed is NOT persisted — resets on app restart
        latestVersion: state.latestVersion,
        updateAvailable: state.updateAvailable,
        releaseUrl: state.releaseUrl,
        downloadUrl: state.downloadUrl,
        releaseNotes: state.releaseNotes,
      }),
    }
  )
)

// ── Helpers ───────────────────────────────────────────────────

function truncateNotes(notes: string): string {
  // Take first 3 lines or 300 chars, whichever is shorter
  const lines = notes.split('\n').filter(l => l.trim()).slice(0, 5)
  const text = lines.join('\n')
  return text.length > 300 ? text.substring(0, 300) + '...' : text
}

// ── Auto-check on app start ───────────────────────────────────

let _initDone = false
export function initUpdateChecker() {
  if (_initDone) return
  _initDone = true

  // Initial check after delay
  setTimeout(() => {
    useUpdateStore.getState().checkForUpdate()
  }, INITIAL_DELAY)

  // Periodic checks
  setInterval(() => {
    useUpdateStore.getState().checkForUpdate()
  }, CHECK_INTERVAL)
}
