import { useEffect, useState } from 'react'
import type { GalleryItem } from '../../../stores/createStore'
import { galleryItemUrl, getCachedGalleryBlob, needsProxyResolve, resolveGalleryBlobUrl } from './galleryUrl'

/**
 * Display URL for a gallery item, resolving remote-ComfyUI media through the
 * Rust proxy into a CSP-allowed blob: URL (see galleryUrl.ts for the why).
 *
 * - Local ComfyUI / cloud (remoteUrl) / in-memory (dataUrl): returns
 *   galleryItemUrl(item) synchronously — unchanged, already works today.
 * - Remote ComfyUI: returns a cached blob URL, or '' until the proxy fetch
 *   resolves (then re-renders with the blob URL). On failure the item is
 *   flagged `unavailable` by resolveGalleryBlobUrl and this stays ''.
 */
export function useResolvedMediaUrl(item: GalleryItem): string {
  const needsProxy = needsProxyResolve(item)
  const [blobUrl, setBlobUrl] = useState<string>(() => (needsProxy ? getCachedGalleryBlob(item.id) : ''))

  useEffect(() => {
    if (!needsProxy) return
    let cancelled = false
    // resolveGalleryBlobUrl returns the cached blob URL immediately (as a
    // resolved promise) if present, so this never refetches an already-resolved
    // item; setState only fires in the async callback (never synchronously).
    void resolveGalleryBlobUrl(item)
      .then((url) => { if (!cancelled) setBlobUrl(url) })
      .catch(() => { /* recoverGalleryUrl already flagged the item */ })
    return () => { cancelled = true }
  }, [needsProxy, item])

  return needsProxy ? blobUrl : galleryItemUrl(item)
}
