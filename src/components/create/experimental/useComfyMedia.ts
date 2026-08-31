import { useState, useEffect, useRef, useCallback } from 'react'
import { galleryItemUrl, proxiedComfyBlobUrl, recoverGalleryUrl, markGalleryItemAvailable } from './galleryUrl'
import { isComfyLocal } from '../../../api/backend'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'

/**
 * Display src for a gallery item's `<img>`/`<video>` with a ComfyUI-0.19+
 * cross-origin fallback (#75). The direct /view load is fast but a user-managed
 * ComfyUI ≥0.19 answers the WebView's cross-origin request with a Sec-Fetch 403
 * (video especially — its Range requests carry an Origin), so the element errors
 * even though the render exists. On that error we re-fetch the bytes through the
 * Rust proxy (no Origin header → not blocked) and swap to a blob: URL, and flag
 * `comfyCorsBlocked` so the tab can surface the exact --enable-cors-header fix.
 * Only if the proxy ALSO fails do we fall back to the "engine offline" state.
 */
export function useComfyMedia(item: GalleryItem | null) {
  const base = item ? galleryItemUrl(item) : ''
  // The proxy fallback's blob: URL, tagged with the base URL it stands in for.
  // The tag is what turns the reset into a derivation: when the underlying URL
  // changes (a cloud re-sign swaps remoteUrl) the tag simply stops matching and
  // `src` falls back to the direct /view — no effect writing state back into
  // React on the way (React 19 `set-state-in-effect`).
  const [proxied, setProxied] = useState<{ base: string; url: string } | null>(null)
  const src = proxied && proxied.base === base ? proxied.url : base
  const blobRef = useRef<string | null>(null)
  const triedProxy = useRef(false)

  // Re-arm the proxy fallback for the new URL, and release the blob the old one
  // left behind — in the cleanup, so it is revoked at exactly the moment `src`
  // stops pointing at it, and on unmount too.
  useEffect(() => {
    triedProxy.current = false
    return () => {
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current)
        blobRef.current = null
      }
    }
  }, [base])

  const onError = useCallback(() => {
    if (!item) return
    if (triedProxy.current) {
      recoverGalleryUrl(item)
      return
    }
    triedProxy.current = true
    void proxiedComfyBlobUrl(item).then((blob) => {
      if (blob) {
        blobRef.current = blob
        setProxied({ base, url: blob })
        // Proxy rescued a /view the direct load couldn't reach. On a LOCAL
        // host that means ComfyUI 0.19+ rejected the cross-origin load and
        // the --enable-cors-header hint is actionable. On a REMOTE host
        // (#82, rx422) the block is LU's own CSP — expected, by design — and
        // the CORS hint would be wrong (the flag can't unblock a CSP'd
        // <img>), so the proxy path is simply the normal mode: no banner.
        if (isComfyLocal()) useCreateStore.getState().setComfyCorsBlocked(true)
      } else {
        recoverGalleryUrl(item)
      }
    })
  }, [item, base])

  const onLoad = useCallback(() => { if (item) markGalleryItemAvailable(item) }, [item])

  return { src, onError, onLoad }
}
