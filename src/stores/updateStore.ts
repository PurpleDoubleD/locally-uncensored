import { create } from 'zustand'
import { withDetail } from '../lib/error-text'
import { log } from '../lib/logger'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { version as currentVersion } from '../../package.json'
import { isTauri, backendCall, openExternal } from '../api/backend'
import { stopBundledEngine, stopBundledEmbed } from '../api/engine'
import { flushChatPersist } from './chatStore'
import { flushStagedPersist } from './stagedChangesStore'
import { settledOrTimedOut } from './durability'
// Static on purpose. The next thing that happens after this is called is an
// installer overwriting the binary, which is the worst imaginable moment to be
// fetching a chunk off disk for the first time.
import { backupStoresNow } from '../lib/store-backup'
import type { Update } from '@tauri-apps/plugin-updater'

/** Quiet time between the last persisted write and handing the process to
 *  the installer. See installAndRestart for why it is a hedge. */
const UPDATE_SETTLE_MS = 250

/** How long the update waits for the persistence layer before it gives up and
 *  hands over anyway.
 *
 *  flush() resolves when the IndexedDB put has landed, and an IndexedDB put
 *  does not always land. A blocked upgrade, a database Chromium has already
 *  decided is broken, a disk that is full: in every one of those the promise
 *  simply never settles, and `await` on it is forever. Without a deadline the
 *  update button turns into a spinner that never comes back, on exactly the
 *  machines whose storage is in trouble, which is to say on aldrich's. Ten
 *  seconds is far beyond a healthy multi megabyte write and short enough that
 *  nobody thinks the app has died.
 *
 *  Same reasoning for the pre-update backup: it is worth waiting for, it is
 *  not worth waiting for forever. */
const UPDATE_FLUSH_TIMEOUT_MS = 10_000

// `settledOrTimedOut` used to be defined here. It moved to ./durability when
// the end of a chat turn needed the same deadline, because a second copy of
// "wait, but not forever" is exactly how two paths that should agree stop
// agreeing. Still re-exported under the old name: this is where its test and
// every existing reader look for it.
export { settledOrTimedOut } from './durability'

// ── Types ─────────────────────────────────────────────────────

type DownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error'

interface UpdateState {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseNotes: string | null
  isChecking: boolean
  lastChecked: number | null
  dismissed: string | null
  /** Fetch the update in the background as soon as it is found, so the badge
   *  offers a one-click Restart instead of a download the user has to sit
   *  through. Never auto-INSTALLS: nothing restarts without a click. */
  autoDownload: boolean

  downloadStatus: DownloadStatus
  downloadProgress: number
  downloadedBytes: number
  totalBytes: number
  errorMessage: string | null

  /** `force` skips the 6h cooldown — for a user-triggered check, and for
   *  the download path when the Update handle is missing. */
  checkForUpdate: (force?: boolean) => Promise<void>
  downloadUpdate: () => Promise<void>
  installAndRestart: () => Promise<void>
  dismissUpdate: () => void
  clearDismiss: () => void
  setAutoDownload: (on: boolean) => void
  openReleasePage: () => void
}

// ── Config ────────────────────────────────────────────────────

const GITHUB_REPO = 'purpledoubled/locally-uncensored'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
const INITIAL_DELAY = 5_000

// ── Non-serializable update object (module-level) ─────────────

let _pendingUpdate: Update | null = null

// ── Semver compare (kept for dev mode fallback) ───────────────

export function isNewerVersion(latest: string, current: string): boolean {
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
      releaseNotes: null,
      isChecking: false,
      lastChecked: null,
      dismissed: null,
      autoDownload: true,

      downloadStatus: 'idle',
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      errorMessage: null,

      checkForUpdate: async (force = false) => {
        const state = get()
        if (state.isChecking) return
        if (!force && state.lastChecked && Date.now() - state.lastChecked < CHECK_INTERVAL) return

        set({ isChecking: true })

        try {
          if (isTauri()) {
            // Production: use Tauri updater plugin
            const { check } = await import('@tauri-apps/plugin-updater')
            const update = await check()

            if (update) {
              _pendingUpdate = update
              // This check repeats every 6h for as long as the user stays on the
              // old build. Resetting the download state unconditionally would
              // throw away a finished download and, with autoDownload on, pull
              // the same 100 MB again on every tick. Only a DIFFERENT version
              // invalidates what we already have.
              const isNewTarget = get().latestVersion !== update.version
              set({
                updateAvailable: true,
                latestVersion: update.version,
                releaseNotes: update.body ? truncateNotes(update.body) : null,
                isChecking: false,
                lastChecked: Date.now(),
                ...(isNewTarget
                  ? {
                      downloadStatus: 'idle' as DownloadStatus,
                      downloadProgress: 0,
                      downloadedBytes: 0,
                      totalBytes: 0,
                      errorMessage: null,
                    }
                  : {}),
              })

              // Fetch it now rather than waiting for a click. Sign-ups in the
              // app were still arriving from 2.5.5 and 2.5.6 builds weeks after
              // 2.5.7 shipped: people were not refusing the update, they were
              // never getting far enough to start it. Not awaited — the check
              // must not block on a 100 MB download. Only from 'idle', so a
              // finished, running or failed download is never restarted behind
              // the user's back.
              if (get().autoDownload && get().downloadStatus === 'idle') {
                void get().downloadUpdate()
              }
            } else {
              // Nothing on offer, so nothing may be left standing either. Only
              // clearing the flag kept the last known version in the store, and
              // the Updates section shows that row whenever it is newer than the
              // running build: "Latest Version v2.9.9" right next to the green
              // "You are on the latest version.". A withdrawn release is the
              // real path there, and it leaves people hunting for an update
              // that no longer exists.
              set({
                isChecking: false,
                lastChecked: Date.now(),
                updateAvailable: false,
                latestVersion: null,
                releaseNotes: null,
              })
            }
          } else {
            // Dev mode: check GitHub releases API (no install capability)
            const res = await fetch(
              `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
              { headers: { 'Accept': 'application/vnd.github.v3+json' } }
            )
            if (!res.ok) {
              set({ isChecking: false, lastChecked: Date.now() })
              return
            }
            const data = await res.json()
            const latestVersion = (data.tag_name as string).replace(/^v/, '')
            const updateAvailable = isNewerVersion(latestVersion, currentVersion)

            set({
              latestVersion,
              updateAvailable,
              releaseNotes: data.body ? truncateNotes(data.body) : null,
              isChecking: false,
              lastChecked: Date.now(),
            })
          }
        } catch {
          set({ isChecking: false, lastChecked: Date.now() })
        }
      },

      downloadUpdate: async () => {
        // The Update handle lives in this process only. `updateAvailable` is
        // persisted, so after a relaunch — or when the startup check has not
        // landed yet, or ran while offline — the badge offers a Download button
        // with nothing behind it. This used to `return` silently: the user
        // clicked and NOTHING happened, no spinner, no error. Re-check first
        // (forced, or the 6h cooldown a failed check just armed would block
        // it), and if the handle still is not there, say so.
        if (!_pendingUpdate) {
          await get().checkForUpdate(true)
        }
        if (!_pendingUpdate) {
          set({
            downloadStatus: 'error',
            errorMessage: 'Could not reach the update server. Check your connection and try again.',
          })
          return
        }

        set({ downloadStatus: 'downloading', downloadProgress: 0, downloadedBytes: 0, errorMessage: null })
        let downloaded = 0

        try {
          await _pendingUpdate.download((event) => {
            switch (event.event) {
              case 'Started':
                set({ totalBytes: event.data.contentLength ?? 0 })
                break
              case 'Progress': {
                downloaded += event.data.chunkLength
                const total = get().totalBytes
                const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0
                set({ downloadedBytes: downloaded, downloadProgress: progress })
                break
              }
              case 'Finished':
                set({ downloadStatus: 'downloaded', downloadProgress: 100 })
                break
            }
          })
        } catch (e) {
          set({
            downloadStatus: 'error',
            errorMessage: withDetail('The update could not be downloaded.', e),
          })
        }
      },

      installAndRestart: async () => {
        if (!_pendingUpdate) {
          // Nothing was downloaded in THIS process — same dead-button problem
          // as above, and here a re-check would not help.
          set({
            downloadStatus: 'error',
            errorMessage: 'The downloaded update was lost when the app restarted. Download it again.',
          })
          return
        }

        set({ downloadStatus: 'installing' })

        try {
          // Free our own sidecars BEFORE the installer runs. Windows locks a
          // running image against writes, and llama-server.exe lives in the
          // install directory, which is why aldrich_ironhart's update stopped at
          // "Error opening file for writing" (C4). The NSIS hook handles that
          // case, but it is the only installer that has one: a machine that
          // installed the .msi takes the WiX path, where nothing frees the
          // sidecar. And the exit below is no help either, it runs AFTER
          // install() has already handed over.
          // Both stops are lazy-restart no-ops when nothing is running, and the
          // next thing to happen here is an installer, so there is nothing to
          // lose by being early. Best effort: a failure here must not stop the
          // update, the installer still has its own recovery.
          await Promise.allSettled([stopBundledEngine(), stopBundledEmbed()])

          // Put the chats on disk and go quiet BEFORE handing over. install()
          // does not return: the installer takes the process down, and both
          // coalesced stores can have a multi megabyte IndexedDB write in
          // flight at that moment because the window only closes 250 ms after
          // the last change. A LevelDB killed mid write is the most plausible
          // mechanism behind aldrich_ironhart losing every chat across a 2.6.5
          // update while sockenmonster on the same build lost none, and the
          // bigger the history the wider that window.
          //
          // flush() resolves when the put has landed, so awaiting it is the
          // real work. The pause after it is a hedge, not a guarantee: what
          // the engine does with its own log and compaction after a commit is
          // not something a page can await. A quarter second of an update the
          // user already agreed to costs nothing.
          //
          // Under a deadline, though. An IndexedDB write that never settles is
          // not a hypothetical on a database that is already in trouble, and
          // `await` on it would leave the user staring at "installing" until
          // they kill the app, which is the very kill this path exists to
          // avoid (Bug A1, 2.6.7).
          const flushed = await settledOrTimedOut(
            Promise.allSettled([flushChatPersist(), flushStagedPersist()]),
            UPDATE_FLUSH_TIMEOUT_MS,
          )
          if (flushed === 'timeout') {
            log.warn('[update] the persisted stores did not finish writing before the install, going ahead with the file backup')
          }

          // Then put a copy on disk that does NOT live in the WebView2 profile.
          // The backup triad writes one every 5 s, so what survives an update
          // is whatever the interval last caught, up to a whole answer old.
          // This is the moment that copy is worth the most, because the next
          // thing that happens is a process kill, and it is the one moment
          // nothing used to ask for one. Awaited, so the file is on disk
          // before the installer arrives, and under the same deadline.
          await settledOrTimedOut(backupStoresNow(), UPDATE_FLUSH_TIMEOUT_MS)

          await new Promise((r) => setTimeout(r, UPDATE_SETTLE_MS))

          await _pendingUpdate.install()
          // Exit so the installer can overwrite the binary
          await backendCall('exit_app')
        } catch (e) {
          set({
            downloadStatus: 'error',
            errorMessage: withDetail('The update could not be installed.', e),
          })
        }
      },

      dismissUpdate: () => {
        const { latestVersion } = get()
        set({ dismissed: latestVersion })
      },

      clearDismiss: () => {
        set({ dismissed: null })
      },

      setAutoDownload: (on: boolean) => {
        set({ autoDownload: on })
        // Turning it on with an update already waiting should act immediately,
        // not at the next 6h tick.
        if (on && get().updateAvailable && get().downloadStatus === 'idle') {
          void get().downloadUpdate()
        }
      },

      openReleasePage: () => {
        void openExternal(`https://github.com/${GITHUB_REPO}/releases/latest`)
      },
    }),
    {
      name: 'lu-update-checker-v2',
      storage: safeJSONStorage(),
      // downloadStatus is deliberately NOT persisted: the Update handle lives
      // in module-level `_pendingUpdate`, which dies with the process — a
      // rehydrated 'downloaded'/'downloading'/'error' state would render badge
      // buttons whose actions early-return on the null handle.
      partialize: (state) => ({
        lastChecked: state.lastChecked,
        latestVersion: state.latestVersion,
        updateAvailable: state.updateAvailable,
        releaseNotes: state.releaseNotes,
        autoDownload: state.autoDownload,
      }),
      // Reset stale persisted state when the binary has been updated out-of-band
      // (e.g. user manually installed a newer .deb / .exe than what the persisted
      // "latest" snapshot remembers). Without this, the Updates tab can show
      // `Current: 2.4.1 | Latest: 2.3.8` indefinitely because checkForUpdate has
      // a 6h cooldown and a stale `latestVersion` survives in localStorage.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        if (state.latestVersion && !isNewerVersion(state.latestVersion, currentVersion)) {
          state.latestVersion = null
          state.updateAvailable = false
          state.releaseNotes = null
          state.lastChecked = null
        } else if (state.updateAvailable) {
          // Update still pending across a relaunch: any transient download
          // state is dead (`_pendingUpdate` is null in the new process), and a
          // persisted `lastChecked` would let the 6h cooldown block the startup
          // check that repopulates it. Reset so the badge re-offers a working
          // Download immediately.
          state.downloadStatus = 'idle'
          state.lastChecked = null
        }
      },
    }
  )
)

// ── Helpers ───────────────────────────────────────────────────

function truncateNotes(notes: string): string {
  const lines = notes.split('\n').filter(l => l.trim()).slice(0, 5)
  const text = lines.join('\n')
  return text.length > 300 ? text.substring(0, 300) + '...' : text
}

// ── Auto-check on app start ───────────────────────────────────

let _initDone = false
export function initUpdateChecker() {
  if (_initDone) return
  _initDone = true

  setTimeout(() => {
    useUpdateStore.getState().checkForUpdate()
  }, INITIAL_DELAY)

  setInterval(() => {
    useUpdateStore.getState().checkForUpdate()
  }, CHECK_INTERVAL)
}
