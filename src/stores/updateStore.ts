import { create } from 'zustand'
import { detailOf, withDetail } from '../lib/error-text'
import { log } from '../lib/logger'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { version as currentVersion } from '../../package.json'
import { isTauri, isLinux, backendCall, openExternal } from '../api/backend'
import { asBoolean, asString, prop } from '../types/json-guards'
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

// ── How this copy of LU was installed ─────────────────────────
//
// The updater plugin decides between AppImage, deb and rpm by reading a string
// the bundler patched into the binary, not by looking at the machine
// (tauri-utils platform.rs:349, and UPDATER-LINUX-BEFUND.md for the whole
// trace). A repackaged install therefore lies to it. The AUR package
// locally-uncensored-bin unpacks our .deb into /usr, so on Arch the updater
// downloads a Debian package and runs `pkexec dpkg -i` on a box with no dpkg:
// polkit asks for the password, the command fails afterwards, and the user is
// left thinking their password was wrong. That is the customer report this
// exists for.
//
// The Rust command asks the package managers that are installed who owns the
// running file. Where the answer means the plugin cannot deliver, the same
// Download and Restart buttons run LU's own install instead: it fetches the
// AppImage, checks its signature, puts it in the user's own data folder with a
// start menu entry and starts it. Nothing to read, nothing to do by hand, and
// from the next update on the plugin's ordinary in place swap works.

export type InstallKind =
  | 'appimage' | 'deb' | 'rpm' | 'pacman' | 'msi' | 'unknown'

export interface InstallMethod {
  kind: InstallKind
  exePath: string
  /** Whether the folder holding the executable can be written to. Only the
   *  AppImage path cares: replacing it is a rename inside that folder. */
  writable: boolean
}

const INSTALL_KINDS: readonly string[] = [
  'appimage', 'deb', 'rpm', 'pacman', 'msi', 'unknown',
]

/** Anything that is not a recognisable answer is no answer: null means "we
 *  could not find out", which leaves the updater exactly as it was. */
export function parseInstallMethod(raw: unknown): InstallMethod | null {
  const kind = asString(prop(raw, 'kind'))
  if (!kind || !INSTALL_KINDS.includes(kind)) return null
  return {
    kind: kind as InstallKind,
    exePath: asString(prop(raw, 'exe_path')) ?? '',
    writable: asBoolean(prop(raw, 'writable')) ?? false,
  }
}

/** Whether the update runs through LU's own install instead of the plugin.
 *
 *  The mirror of self_migrate::migrates_itself, plus the one question the Rust
 *  side leaves to its caller: off Linux there is nothing to migrate to. A
 *  macOS app in /Applications reports 'unknown' as well, and there the plugin
 *  works. */
export function installsItself(method: InstallMethod | null): boolean {
  if (!method || !isLinux()) return false
  switch (method.kind) {
    // pacman owns the files; writing past its database is never allowed. And
    // a binary no package manager claims is our deb, hand unpacked.
    case 'pacman':
    case 'unknown':
      return true
    // The plugin replaces an AppImage with a rename INSIDE its folder.
    case 'appimage':
      return !method.writable
    // deb and rpm run a package install with the system's own password
    // prompt, and Windows has its installer. Both work.
    default:
      return false
  }
}

/** What the backend says while it is installing LU itself. The download half
 *  fills the same progress bar the plugin does; the short steps after it get a
 *  word instead of a percentage, because they have no length to show. */
const MIGRATION_NOTE: Record<string, string> = {
  verify: 'Checking the signature',
  install: 'Putting the new version in place',
  start: 'Starting the new version',
}

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
  /** The step LU is on while it installs itself, for the line that otherwise
   *  shows a percentage. Null on the plugin's own lane, which has nothing but
   *  a download to report. */
  progressNote: string | null

  /** How this copy got onto the machine. Null until the probe has answered,
   *  and null forever on a build whose backend does not know the command:
   *  in both cases the updater behaves exactly as it did before. */
  installMethod: InstallMethod | null

  /** Reads the install method once and caches it. */
  refreshInstallMethod: () => Promise<InstallMethod | null>

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

/** The version LU downloaded for its own install, and the sign that the
 *  staged AppImage from `self_migrate_stage` is still lying next to the app.
 *  Module level for the same reason `_pendingUpdate` is: it does not survive
 *  the process, and a rehydrated 'downloaded' would offer a Restart with
 *  nothing behind it. */
let _stagedSelfInstall: string | null = null

/** In flight or already answered, so a startup check and a click on Download
 *  do not run the same three subprocesses twice. Cleared again when the probe
 *  came back empty, so a later attempt can still get an answer. */
let _methodProbe: Promise<InstallMethod | null> | null = null

/** Test seam: forget everything that only lives in this process, which is the
 *  cached probe and the AppImage staged for LU's own install. */
export function resetUpdateSession() {
  _methodProbe = null
  _stagedSelfInstall = null
}

async function readInstallMethod(): Promise<InstallMethod | null> {
  if (!isTauri()) return null
  try {
    return parseInstallMethod(await backendCall('install_method'))
  } catch (e) {
    // An older backend without the command, or a probe that threw. Not being
    // able to ask must never be a reason to withhold an update.
    log.warn('[update] could not read the install method, leaving the updater as it was', { err: detailOf(e) })
    return null
  }
}

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
      progressNote: null,
      installMethod: null,

      refreshInstallMethod: async () => {
        const known = get().installMethod
        if (known) return known
        if (!_methodProbe) _methodProbe = readInstallMethod()
        const method = await _methodProbe
        if (method) set({ installMethod: method })
        else _methodProbe = null
        return method
      },

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
                      progressNote: null,
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
        // Where the plugin cannot deliver, LU fetches its own AppImage
        // instead. Same button, same progress bar, and nothing on screen says
        // which of the two lanes ran.
        if (installsItself(await get().refreshInstallMethod())) {
          await downloadOwnInstall(set)
          return
        }

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
        // The install method decides the lane, not whichever handle happens to
        // be lying around. checkForUpdate fills `_pendingUpdate` on every
        // install, this one included, so asking it instead would send an Arch
        // box back into `pkexec dpkg -i` the moment our own download failed.
        const ownInstall = installsItself(await get().refreshInstallMethod())
        const handle = _pendingUpdate
        if (ownInstall ? _stagedSelfInstall === null : !handle) {
          // Nothing was downloaded in THIS process, same dead-button problem
          // as in downloadUpdate, and here a re-check would not help.
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

          if (ownInstall) {
            // Puts the checked AppImage in place, gives it a start menu entry
            // of its own and starts it. The new process waits for this one to
            // be gone before it opens a window, because single instance would
            // otherwise send it straight back here.
            const stop = await followMigration(set)
            try {
              await backendCall('self_migrate_finish')
            } finally {
              stop()
            }
          } else if (handle) {
            await handle.install()
          }
          // Exit so the installer can overwrite the binary
          await backendCall('exit_app')
        } catch (e) {
          set({
            downloadStatus: 'error',
            errorMessage: withDetail('The update could not be installed.', e),
            progressNote: null,
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

/** One patch of update state, the shape zustand's `set` takes. */
type Patch = (partial: Partial<UpdateState>) => void

/** Follow the backend while it installs LU itself.
 *
 *  The plugin reports its download through a callback; this one reports the
 *  same thing through an event, because the work happens in Rust. Everything
 *  lands in the same three fields, so the progress bar does not know the
 *  difference. Losing the events costs a moving bar and nothing else, which is
 *  why nothing here can fail the update. */
async function followMigration(set: Patch): Promise<() => void> {
  if (!isTauri()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    return await listen<{ phase: string; downloaded: number; total: number }>(
      'update-migration',
      ({ payload }) => {
        if (payload.phase === 'download') {
          const total = payload.total ?? 0
          set({
            downloadedBytes: payload.downloaded ?? 0,
            totalBytes: total,
            downloadProgress: total > 0 ? Math.round(((payload.downloaded ?? 0) / total) * 100) : 0,
            progressNote: null,
          })
          return
        }
        set({ progressNote: MIGRATION_NOTE[payload.phase] ?? null })
      },
    )
  } catch (e) {
    log.warn('[update] the self install runs without progress events', { err: detailOf(e) })
    return () => {}
  }
}

/** Fetch and check the AppImage LU will install into the home folder.
 *
 *  Stops at the checked file: installing it restarts the app, and nothing
 *  restarts the app without a click, auto-download or not. */
async function downloadOwnInstall(set: Patch): Promise<void> {
  set({
    downloadStatus: 'downloading',
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    errorMessage: null,
    progressNote: null,
  })
  const stop = await followMigration(set)
  try {
    const staged = await backendCall('self_migrate_stage')
    _stagedSelfInstall = asString(prop(staged, 'version')) ?? ''
    set({ downloadStatus: 'downloaded', downloadProgress: 100, progressNote: null })
  } catch (e) {
    _stagedSelfInstall = null
    set({
      downloadStatus: 'error',
      errorMessage: withDetail('The update could not be downloaded.', e),
      progressNote: null,
    })
  } finally {
    stop()
  }
}


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
