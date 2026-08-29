import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Cloud, X } from 'lucide-react'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { useCloudNoticeStore, CLOUD_RETENTION_DAYS, shouldShowRetentionNotice } from '../../../stores/cloudNoticeStore'
import { useWorkflowStore } from '../../../stores/workflowStore'
import { CreateExpProvider, useCreateExp } from './CreateContext'
import { IntentBar } from './IntentBar'
import { Stage } from './Stage'
import { Composer } from './Composer'
import { CreatePanel } from './CreatePanel'
import { Lightbox } from './Lightbox'
import { AdvancedDrawer } from './AdvancedDrawer'
import { WorkflowsModal } from '../WorkflowsModal'
import { MaskEditor } from './MaskEditor'
import { VhsInstallModal } from './VhsInstallModal'
import { INTENT_MAP, isIntentAvailable } from './intents'
import { isMlxImageHost } from '../../../api/mlx-image'
import { isLinux } from '../../../api/backend'
import { fetchGalleryItemBlob } from './galleryUrl'
import { loadImageRef } from './loadImage'

/** The redesigned Create surface. Mounted by AppShell for currentView==='create'. */
export function CreateExperimental() {
  return (
    <CreateExpProvider>
      <CreateExperimentalInner />
    </CreateExpProvider>
  )
}

function CreateExperimentalInner() {
  const gallery = useCreateStore((s) => s.gallery)
  const error = useCreateStore((s) => s.error)
  const setError = useCreateStore((s) => s.setError)
  const backend = useCreateStore((s) => s.backend)
  const comfyCorsBlocked = useCreateStore((s) => s.comfyCorsBlocked)
  const setComfyCorsBlocked = useCreateStore((s) => s.setComfyCorsBlocked)
  const isGenerating = useCreateStore((s) => s.isGenerating)
  const retentionNoticeSeen = useCloudNoticeStore((s) => s.retentionNoticeSeen)
  const setRetentionNoticeSeen = useCloudNoticeStore((s) => s.setRetentionNoticeSeen)
  const setManagerNoticeSeen = useWorkflowStore((s) => s.setManagerNoticeSeen)
  const { modelLoadError, connected, comfyOnCpu } = useCreateExp()

  const [shownId, setShownId] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [maskOpen, setMaskOpen] = useState(false)
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [workflowsOpen, setWorkflowsOpen] = useState(false)

  // One-click CORS fix (David 2026-07-17): restart the user-managed ComfyUI
  // under LU's management so it carries --enable-cors-header. On success the
  // banner clears; if LU can't do it (unknown path / remote host) the backend
  // error explains the manual route and stays visible in the banner.
  const [corsFixing, setCorsFixing] = useState(false)
  const [corsFixError, setCorsFixError] = useState<string | null>(null)
  const fixCorsForMe = useCallback(async () => {
    setCorsFixing(true)
    setCorsFixError(null)
    try {
      const { backendCall } = await import('../../../api/backend')
      await backendCall('fix_comfyui_cors')
      // ComfyUI is relaunching with the flag — direct loads work from here on.
      useCreateStore.getState().setComfyCorsBlocked(false)
    } catch (err) {
      setCorsFixError(err instanceof Error ? err.message : String(err))
    } finally {
      setCorsFixing(false)
    }
  }, [])

  // David 2026-07-11: the Stage starts EMPTY and never auto-surfaces a persisted
  // gallery item — not on mount, not on a mode/intent switch. It fills only on an
  // explicit pick (a gallery tile, or a result's "Edit" action) or a fresh
  // generation made in THIS session. Seed prevTop with whatever is already on top
  // so a persisted item is never mistaken for a just-made result; only a genuinely
  // new top id (an in-session generation) auto-shows.
  const prevTop = useRef<string | undefined>(gallery[0]?.id)
  useEffect(() => {
    const top = gallery[0]?.id
    if (top && top !== prevTop.current) { setShownId(top); prevTop.current = top }
  }, [gallery])

  // Switching intent/mode returns the Stage to empty — the newest gallery item
  // must not reappear just because the axis changed.
  const intent = useCreateStore((s) => s.intent())
  useEffect(() => { setShownId(null) }, [intent])

  const displayed = shownId ? gallery.find((g) => g.id === shownId) : undefined
  const banner = error ?? modelLoadError

  // "Edit with mask" on a finished image force-sets the 'edit' intent. On the
  // MLX Mac that lane does not exist (no ComfyUI inpaint nodes, and MLX
  // generate DROPS the source + mask — it silently produced an unrelated fresh
  // text-to-image instead of an edit). Hide the action where the lane can't
  // run, using the same rule the IntentBar renders from.
  const editAvailable = isIntentAvailable('edit', backend, isMlxImageHost())

  // Pull a finished result back in as the working source (ImageRef). Needed
  // because a text-to-image run leaves `source` empty — without this, "Edit
  // with mask" on a result and switching to Edit/Upscale/Eraser/Animate were
  // no-ops that demanded a download + re-upload of the app's own output.
  const adoptResult = useCallback(async (item: GalleryItem) => {
    const blob = await fetchGalleryItemBlob(item)
    const file = new File([blob], item.filename || 'result.png', { type: blob.type || 'image/png' })
    return loadImageRef(file)
  }, [])

  const editResultWithMask = useCallback(async (item: GalleryItem) => {
    useCreateStore.getState().setIntent('edit')
    try {
      useCreateStore.getState().setSource(await adoptResult(item))
      setMaskOpen(true)
    } catch (err) {
      setError(`Could not load the result for editing: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [adoptResult, setError])

  // David 2026-07-10: source-needing ops must start EMPTY — never silently
  // adopt a gallery image as the input. Adoption is always explicit: the
  // InputSlot's "pick from gallery" strip, drag&drop, the file picker, or a
  // result's "Edit" action. While an op intent owns the stage, clicking a
  // gallery tile opens the Lightbox (view it, videos play) instead of
  // showing it in a stage that can't display it.
  const openGalleryItem = useCallback((id: string) => {
    const item = useCreateStore.getState().gallery.find((g) => g.id === id)
    if (!item) return
    if (INTENT_MAP[intent].needsSource) setLightbox(item)
    else setShownId(id)
  }, [intent])

  return (
    <div className="relative h-full w-full flex flex-col bg-white dark:bg-[#141414] text-gray-200 overflow-hidden">
      <IntentBar />

      <AnimatePresence>
        {banner && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden shrink-0"
          >
            <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-red-200 t-body">
              <AlertTriangle size={14} className="shrink-0" />
              <span className="flex-1 min-w-0 truncate">{banner}</span>
              {error && (
                <button onClick={() => setError(null)} className="shrink-0 text-red-300/70 hover:text-red-100" title="Dismiss">
                  <X size={14} />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CPU-mode warning — persistent while LU's ComfyUI runs with --cpu.
          Without it an AMD/non-NVIDIA user sees "Ready to generate" and then
          a bare 20-minute timeout (shd_scorpion, RX 7900 XTX). Local renders
          only — cloud jobs never touch the local ComfyUI. */}
      {backend === 'local' && connected === true && comfyOnCpu && (
        <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/5 border-b border-yellow-500/10 text-yellow-300 text-xs shrink-0">
          <AlertTriangle size={12} className="shrink-0" />
          <span>
            ComfyUI is running on the CPU (no usable GPU detected). Generation will be extremely slow and may time out.
            {/* The right AMD path differs per OS — three users followed the
                generic ZLUDA pointer on Linux, where ZLUDA guides are
                Windows-only dead ends (numbrain/lapbo/suraj3014, 2026-08-02).
                Linux AMD wants a ROCm torch inside ComfyUI's own venv.
                Since 2.6.7 the ComfyUI installer picks the ROCm wheels itself
                on an AMD Linux box, so the fix is a reinstall and not a pip
                line the user has to type by hand. Windows has no ROCm wheel at
                all, so it gets the honest version instead of a channel that
                does not exist there. */}
            {isLinux()
              ? ' AMD GPU? LU installs the ROCm build of PyTorch for AMD cards now. Reinstall the ComfyUI environment from Settings → ComfyUI, then set Settings → Hardware → ComfyUI GPU to Auto.'
              : ' AMD GPU? PyTorch ships no ROCm wheels for Windows, so this card needs a DirectML or ZLUDA ComfyUI of your own. Point LU at it and set Settings → Hardware → ComfyUI GPU to force GPU.'}
          </span>
        </div>
      )}

      {/* Cross-origin block (#75, cinemazverev): a user-managed ComfyUI 0.19+
          answers the WebView's media/WS requests with a Sec-Fetch 403, so results
          couldn't be viewed. LU proxies the bytes so they still display, but the
          live progress bar + native video seeking degrade. David 2026-07-17: keep
          the message short and offer a one-click fix — LU restarts ComfyUI under
          its own management, which always passes the CORS flag. Local only,
          dismissible; the long manual-flag hint only appears if the fix fails. */}
      {backend === 'local' && comfyCorsBlocked && (
        <div className="flex items-start gap-2 px-4 py-2 bg-yellow-500/5 border-b border-yellow-500/10 text-yellow-300 text-xs shrink-0">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0">
            {corsFixError
              ? corsFixError
              : corsFixing
                ? 'Restarting ComfyUI with the fix… this takes a moment.'
                : 'Your ComfyUI blocks direct loads (v0.19+), so previews use a slower fallback.'}
          </span>
          {!corsFixing && (
            <button
              onClick={() => { void fixCorsForMe() }}
              disabled={isGenerating}
              title={isGenerating ? 'Waiting for the current generation to finish' : 'LU restarts ComfyUI with the CORS flag for you'}
              className="shrink-0 px-2 py-0.5 rounded bg-yellow-500/15 hover:bg-yellow-500/25 text-yellow-200 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Let me do it for you!
            </button>
          )}
          <button onClick={() => { setComfyCorsBlocked(false); setCorsFixError(null) }} className="shrink-0 text-yellow-300/70 hover:text-yellow-100" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Cloud gallery retention (David 2026-07-24). Cloud renders live on our
          servers, not on this machine, so the gallery is not permanent storage.
          Cloud mode only. One time ever: no close X and no auto-hide, the only
          way out is the explicit "Do not show again", and it stays dismissed
          across updates (persisted in lu_cloud_notice). */}
      {shouldShowRetentionNotice(backend, retentionNoticeSeen) && (
        <div className="flex items-start gap-2 px-4 py-2 bg-purple-500/5 border-b border-purple-500/10 text-purple-200 text-xs shrink-0">
          <Cloud size={12} className="shrink-0 mt-0.5" />
          <span className="flex-1 min-w-0">
            Cloud results are stored for {CLOUD_RETENTION_DAYS} days and then deleted.
            Download anything you want to keep from the gallery.
          </span>
          <button
            onClick={() => setRetentionNoticeSeen(true)}
            className="shrink-0 px-2 py-0.5 rounded bg-purple-500/15 hover:bg-purple-500/25 text-purple-100 transition-colors whitespace-nowrap"
          >
            Do not show again
          </button>
        </div>
      )}

      {/* The viewer (Stage) and the Gallery bubble share ONE row, so they're
          always the exact same height; the prompt window spans the full width
          beneath them. (Previously the Gallery ran full-height alongside both the
          viewer AND the composer, so it was taller than the viewer.) */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <Stage
          displayed={displayed}
          onOpenMaskEditor={() => setMaskOpen(true)}
          onEditResult={editAvailable ? (it) => { void editResultWithMask(it) } : undefined}
          onFullscreen={(it) => setLightbox(it)}
        />
        <CreatePanel open={panelOpen} onOpenChange={setPanelOpen} activeId={shownId} onSelect={openGalleryItem} />
      </div>

      {/* Prompt window — full width, beneath the viewer + gallery. */}
      <Composer
        onOpenAdvanced={() => setAdvancedOpen(true)}
        onOpenWorkflows={() => { setWorkflowsOpen(true); setManagerNoticeSeen(true) }}
      />

      <AdvancedDrawer open={advancedOpen} onClose={() => setAdvancedOpen(false)} />
      <WorkflowsModal open={workflowsOpen} onClose={() => setWorkflowsOpen(false)} />
      <MaskEditor open={maskOpen} onClose={() => setMaskOpen(false)} />

      <Lightbox item={lightbox} onClose={() => setLightbox(null)} />
      <VhsInstallModal />
    </div>
  )
}
