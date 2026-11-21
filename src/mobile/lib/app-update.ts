/**
 * "Update to X" for the open Android package.
 *
 * The APK comes from GitHub, so no store tells its users about a new version.
 * At most once a day the app asks for the newest published release (Rust,
 * commands/app_update.rs): a version number and the address of the APK, no
 * user data. A store build and iOS never ask.
 *
 * The button opens the official download in the browser. The app does not
 * install anything itself: that would take REQUEST_INSTALL_PACKAGES, and the
 * one manifest is also the one of the Play package. Android checks the
 * signature when the APK is installed over this one, and the data stays.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { backendCall } from '../../api/backend'
import { safeJSONStorage } from '../../lib/storage-quota'
import type { StorePreset } from '../policy/storePolicy'

export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000
// The repository is fixed by the number in commands/app_update.rs. Its name stays out of a phone package.
const DOWNLOAD_PREFIX = 'https://github.com/PurpleDoubleD/'

export interface AppUpdate {
  version: string
  url: string
  /** The SHA-256 GitHub states for the APK, when it does. */
  sha256: string | null
}

/** Pure: only a plain x.y.z counts; a prerelease suffix does not. */
export function parseVersion(text: unknown): [number, number, number] | null {
  if (typeof text !== 'string') return null
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Pure: is `latest` newer than `current`. Anything unreadable is not. */
export function isNewer(latest: unknown, current: unknown): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** Pure: the owner's address, one repository segment, then exactly this release file. */
function isOfficialUrl(url: unknown, tail: string): url is string {
  if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX) || !url.endsWith(tail)) return false
  return /^[A-Za-z0-9._-]+$/.test(url.slice(DOWNLOAD_PREFIX.length, url.length - tail.length))
}

/** Pure: the update in an answer, or null. Not a draft, not a prerelease, and the APK at its exact official address. */
export function readRelease(raw: unknown): AppUpdate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { tag?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
  if (r.draft !== false || r.prerelease !== false || !Array.isArray(r.assets)) return null
  const parsed = parseVersion(r.tag)
  if (!parsed) return null
  const version = parsed.join('.')
  const name = `LU-${version}-Android.apk`
  const tail = `/releases/download/v${version}/${name}`
  const asset = r.assets.find((a: { name?: unknown; url?: unknown }) => a?.name === name && isOfficialUrl(a?.url, tail)) as { digest?: unknown; url: string } | undefined
  if (!asset) return null
  const url = asset.url
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] ?? null : null
  return { version, url, sha256: digest }
}

/** Pure: does this build have the hint at all. */
export function updateHintOffered(preset: StorePreset, os: string | null | undefined): boolean {
  return preset === 'open' && os === 'android'
}

/** Pure: is a check due. A clock that went backwards counts as due. */
export function checkDue(lastAt: number, now: number): boolean {
  return !(lastAt > 0) || now < lastAt || now - lastAt >= UPDATE_EVERY_MS
}

interface UpdateState {
  checkedAt: number
  latest: AppUpdate | null
  /** The version the start hint was shown for: once per version. */
  announced: string | null
  set: (next: Partial<Pick<UpdateState, 'checkedAt' | 'latest' | 'announced'>>) => void
}

export const useAppUpdate = create<UpdateState>()(
  persist(
    (set) => ({ checkedAt: 0, latest: null, announced: null, set: (next) => set(next) }),
    {
      name: 'lu-mobile-app-update',
      storage: safeJSONStorage(),
      partialize: (s) => ({ checkedAt: s.checkedAt, latest: s.latest, announced: s.announced }),
    },
  ),
)

/** Pure: the update to show on this version. A stored one that is installed by now is none. */
export function shownUpdate(latest: AppUpdate | null, current: string): AppUpdate | null {
  return latest && isNewer(latest.version, current) ? latest : null
}

let running: Promise<void> | null = null

/** Ask if a day has passed. A failure says nothing and is asked again on the next start. */
export function checkForUpdate(now: number = Date.now()): Promise<void> {
  if (!checkDue(useAppUpdate.getState().checkedAt, now)) return Promise.resolve()
  running ??= backendCall<unknown>('app_latest_release')
    .then((raw) => {
      const latest = readRelease(raw)
      // An answer without a usable APK keeps what was known: a release can be up before its files are.
      useAppUpdate.getState().set(latest ? { checkedAt: now, latest } : { checkedAt: now })
    })
    .catch(() => {})
    .finally(() => {
      running = null
    })
  return running
}

/** Only for tests. */
export function __resetAppUpdateForTests(): void {
  running = null
  useAppUpdate.setState({ checkedAt: 0, latest: null, announced: null })
}
