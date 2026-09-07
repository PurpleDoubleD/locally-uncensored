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

/** 'unavailable' is not a failure: the update exists, it is fine, and this
 *  copy of LU is simply not one the in-app updater is allowed to replace. */
type DownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'unavailable'

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
// running file, and the answer decides whether the in-app updater may run.

export type InstallKind =
  | 'appimage' | 'deb' | 'rpm' | 'pacman' | 'homebrew' | 'msi' | 'unknown'

export interface InstallMethod {
  kind: InstallKind
  exePath: string
  /** Whether the folder holding the executable can be written to. Only the
   *  AppImage path cares: replacing it is a rename inside that folder. */
  writable: boolean
  hint: string
}

const INSTALL_KINDS: readonly string[] = [
  'appimage', 'deb', 'rpm', 'pacman', 'homebrew', 'msi', 'unknown',
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
    hint: asString(prop(raw, 'hint')) ?? '',
  }
}

/** Why the in-app updater must not touch this copy, or null when it may.
 *
 *  Kept as a plain function so the badge, the settings page and the tests all
 *  read the same sentence from the same place. */
export function updateBlockedBecause(method: InstallMethod | null): string | null {
  if (!method) return null
  switch (method.kind) {
    case 'pacman':
      return 'This copy was installed with your package manager (AUR package '
        + 'locally-uncensored-bin). Update it with your AUR helper, for example '
        + 'yay -Syu locally-uncensored-bin. The AUR package is maintained by a '
        + 'community member and can lag a few days behind the GitHub release.'
    case 'appimage':
      if (method.writable) return null
      return `The AppImage sits in a folder you cannot write to (${method.exePath}). `
        + 'Move it to your home folder or download the new AppImage from the release page.'
    case 'unknown':
      // A .app in /Applications and a dev build both land here, and on those
      // the updater is fine. On Linux it means the binary is somewhere no
      // package manager claims it, which is the hand-unpacked install.
      if (!isLinux()) return null
      return 'This copy was installed by a package manager or script LU does not '
        + 'recognise. Download the new version from the release page.'
    default:
      return null
  }
}

/** The sentence that has to stand next to the install button on deb and rpm,
 *  where the update really does run a package install. The password prompt
 *  comes from polkit or sudo, and a prompt nobody warned about reads like the
 *  app asking for an account password. */
export function installPasswordNotice(method: InstallMethod | null): string | null {
  if (!method) return null
  if (method.kind !== 'deb' && method.kind !== 'rpm') return null
  return 'Your system will ask for your password to install the package. '
    + 'That is the normal Linux package install, not an LU login.'
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

  /** How this copy got onto the machine. Null until the probe has answered,
   *  and null forever on a build whose backend does not know the command:
   *  in both cases the updater behaves exactly as it did before. */
  installMethod: InstallMethod | null

  /** Reads the install method once and caches it. */
  refreshInstallMethod: () => Promise<InstallMethod | null>
  /** Parks the badge on 'unavailable' when this copy must not be updated in
   *  place, and answers with the reason. Null means carry on. */
  refuseUpdate: () => Promise<string | null>

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

/** In flight or already answered, so a startup check and a click on Download
 *  do not run the same three subprocesses twice. Cleared again when the probe
 *  came back empty, so a later attempt can still get an answer. */
let _methodProbe: Promise<InstallMethod | null> | null = null

/** Test seam: drop the cached probe. */
export function resetInstallMethodProbe() {
  _methodProbe = null
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

      refuseUpdate: async () => {
        const reason = updateBlockedBecause(await get().refreshInstallMethod())
        if (reason) {
          set({
            downloadStatus: 'unavailable',
            errorMessage: reason,
            downloadProgress: 0,
            downloadedBytes: 0,
          })
        }
        return reason
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
                    }
                  : {}),
              })

              // Ask who owns this copy before anything is fetched. On the
              // installs where the updater would fail (or would have to walk
              // past a package database) this parks the badge on a sentence
              // that says what to do instead, and nothing is downloaded.
              if (await get().refuseUpdate()) return

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
        // Nothing is fetched for a copy that must not be updated in place.
        // 100 MB that can never be installed is worse than no download at all.
        if (await get().refuseUpdate()) return

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
        // Second gate, because a download that started before the probe
        // answered must still not end in an install. This is the one that
        // catches the AppImage in /opt: the plugin's first move there is a
        // rename it has no right to make.
        if (await get().refuseUpdate()) return

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
