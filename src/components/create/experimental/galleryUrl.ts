import { getImageUrl } from '../../../api/comfyui'
import { fetchLocalhostBytes, isComfyLocal, isTauri } from '../../../api/backend'
import { refreshResultUrl } from '../../../api/cloud/jobs'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'

/** Resolve a gallery item's display URL. Priority mirrors MediaViewer/Gallery:
 *  remoteUrl (cloud signed URL) → dataUrl (in-memory self-contained fallback)
 *  → ComfyUI /view path (filename/subfolder). */
export function galleryItemUrl(item: GalleryItem): string {
  return item.remoteUrl ?? item.dataUrl ?? getImageUrl(item.filename, item.subfolder)
}

// ── Remote-ComfyUI media resolution ────────────────────────────────────────
// The WebView CSP (tauri.conf.json) only whitelists localhost/127.0.0.1 for
// img-src/media-src, so an <img>/<video> src pointed at a user-configured
// REMOTE ComfyUI host (LAN IP, Tailscale, homelab) is blocked before the
// request leaves the app — even though generation and downloads work, because
// those go through the Rust IPC proxy (proxy_localhost_stream), which CSP does
// not gate. The fix: pull the bytes through that same proxy (fetchLocalhostBytes)
// and hand the WebView a blob: URL, which the CSP already allows. No CSP change.
//
// item.id → live object URL. Kept in-memory; revoke via revokeGalleryBlob when
// an item leaves the gallery so a long session doesn't leak blob URLs.
const blobCache = new Map<string, string>()
// item.id → in-flight fetch, so concurrent renders don't refetch the same item.
const blobInflight = new Map<string, Promise<string>>()

/** True for a remote-ComfyUI item that must be proxied to display: Tauri, a
 *  non-local host, a real /view file, and no cloud/in-memory URL already set. */
export function needsProxyResolve(item: GalleryItem): boolean {
  return isTauri() && !isComfyLocal() && !!item.filename && !item.remoteUrl && !item.dataUrl
}

/** Synchronously read an already-resolved blob URL (empty string if none). */
export function getCachedGalleryBlob(id: string): string {
  return blobCache.get(id) ?? ''
}

/** Fetch a remote-ComfyUI item's bytes through the Rust proxy and cache a
 *  blob: URL for it. Marks the item available on success; on failure delegates
 *  to recoverGalleryUrl (flags `unavailable` — the honest "engine unreachable"
 *  signal here) and rethrows. */
export function resolveGalleryBlobUrl(item: GalleryItem): Promise<string> {
  const cached = blobCache.get(item.id)
  if (cached) return Promise.resolve(cached)
  const pending = blobInflight.get(item.id)
  if (pending) return pending
  const p = (async () => {
    try {
      const bytes = await fetchLocalhostBytes(getImageUrl(item.filename, item.subfolder))
      const type = item.type === 'video' ? 'video/mp4' : 'image/png'
      const url = URL.createObjectURL(new Blob([bytes], { type }))
      blobCache.set(item.id, url)
      markGalleryItemAvailable(item)
      return url
    } catch (err) {
      recoverGalleryUrl(item)
      throw err
    } finally {
      blobInflight.delete(item.id)
    }
  })()
  blobInflight.set(item.id, p)
  return p
}

/** Revoke and forget an item's cached blob URL (call when it leaves the gallery). */
export function revokeGalleryBlob(id: string): void {
  const url = blobCache.get(id)
  if (url) URL.revokeObjectURL(url)
  blobCache.delete(id)
  blobInflight.delete(id)
}

// Cloud signed URLs expire ~1 h after the last read, so a persisted item's
// media errors on the next session. Re-sign lazily and patch the gallery
// entry so every surface re-renders with the fresh URL. The per-item guard
// stops an error → refresh → error loop when the job's file is gone for good
// (a successful re-sign yields a NEW URL each time, so onError would re-fire
// every cycle): after a success the item stays blocked for RESIGN_TTL_MS —
// long sessions can re-sign a second expiry — while a FAILED refresh (offline
// launch, transient 5xx) releases the guard so the next remount retries
// instead of leaving the media broken for the whole session.
const RESIGN_TTL_MS = 50 * 60_000
/** item.id → last successful re-sign epoch ms; 0 = refresh in flight. */
const recovered = new Map<string, number>()

export function recoverGalleryUrl(item: GalleryItem): void {
  if (!item.jobId) {
    // Local ComfyUI item whose /view fetch failed (engine not running /
    // output pruned) — nothing to re-sign. Flag it so the tiles can render
    // an honest "engine offline" state instead of a silently dead <img>.
    if (!item.unavailable) useCreateStore.getState().updateGalleryItem(item.id, { unavailable: true })
    return
  }
  const last = recovered.get(item.id)
  if (last !== undefined && (last === 0 || Date.now() - last < RESIGN_TTL_MS)) return
  recovered.set(item.id, 0)
  void refreshResultUrl(item.jobId).then((url) => {
    if (url) {
      recovered.set(item.id, Date.now())
      useCreateStore.getState().updateGalleryItem(item.id, { remoteUrl: url, unavailable: undefined })
    } else {
      recovered.delete(item.id)
    }
  })
}

/** Clear a tile's offline flag once its media actually loads (onLoad). */
export function markGalleryItemAvailable(item: GalleryItem): void {
  if (item.unavailable) useCreateStore.getState().updateGalleryItem(item.id, { unavailable: undefined })
}

/** Fetch a gallery item's media bytes for adoption as an op source.
 *
 *  The naive `fetch(galleryItemUrl(item))` was the "failed to fetch" behind
 *  every source-needing op in cloud mode (David 2026-07-10): a cloud item's
 *  signed URL expires ~1 h after issue, and a local ComfyUI item's /view URL
 *  is dead whenever the local engine isn't running — both surface as a bare
 *  TypeError. Re-sign expired cloud media once via the job id, and turn the
 *  unrecoverable cases into actionable messages. */
export async function fetchGalleryItemBlob(item: GalleryItem): Promise<Blob> {
  const tryFetch = async (url: string) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`media request failed (${res.status})`)
    return res.blob()
  }
  try {
    return await tryFetch(galleryItemUrl(item))
  } catch (err) {
    if (item.jobId) {
      const fresh = await refreshResultUrl(item.jobId).catch(() => null)
      if (fresh) {
        useCreateStore.getState().updateGalleryItem(item.id, { remoteUrl: fresh, unavailable: undefined })
        return tryFetch(fresh)
      }
      throw new Error('The cloud copy of this render is no longer available — pick another image or upload one from disk.')
    }
    if (!item.remoteUrl && !item.dataUrl) {
      throw new Error('This image lives in your local ComfyUI output, which is not running right now — switch to Local (or start ComfyUI) to use it, or upload the file from disk.')
    }
    throw err
  }
}
