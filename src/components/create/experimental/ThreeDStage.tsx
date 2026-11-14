// What the Stage of the 3D tab shows before there is anything to show: the
// one-time setup of the local engine, and the hint for a video.
//
// Local 3D has its own setup, not the starter-bundle gate of requiresModels:
// on a Mac it is an engine of its own per model (TripoSR in
// commands/mesh3d.rs, Stable Fast 3D in commands/mesh3d_sf3d.rs, through
// api/mlx-3d.ts), on Windows and Linux a ComfyUI bundle (TRELLIS.2,
// lib/local-3d-comfy.ts). A model with a licence to accept (Stable Fast 3D)
// says it on the card before anything is downloaded.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Film } from 'lucide-react'
import { isMlxImageHost } from '../../../api/mlx-image'
import { openExternal } from '../../../api/backend'
import type { Mesh3dModel } from '../../../api/mlx-3d'
import { mac3dModel } from '../../../lib/mac-3d'
import { THREE_D_TEXT as T } from '../../../lib/three/three-d-text'
import { useCreateStore } from '../../../stores/createStore'
import { useUIStore } from '../../../stores/uiStore'
import { useCreateExp } from './CreateContext'
import { Button } from '../ui/Button'

export const SETUP_TEXT = {
  macTitle: '3D on this Mac needs a one-time download',
  macBody: 'This sets up the 3D engine and the TripoSR model, about 1.7 GB. It turns one picture into a 3D model on this Mac. Local 3D is never filtered.',
  pcTitle: 'Local 3D needs a one-time download',
  pcBody: 'This sets up ComfyUI itself if it is missing, plus the TRELLIS.2 model files, about 9 GB. Local 3D is never filtered.',
  sf3dTitle: 'Stable Fast 3D needs a one-time download',
  sf3dBody: 'This sets up its own 3D engine and the Stable Fast 3D model, about 4 GB. It turns one picture into a 3D model with a painted texture, on this Mac.',
  licenseLink: 'Open the model page',
  tokenNeeded: 'Add your Hugging Face token first. Accept the licence on the model page with the same account.',
  tokenButton: 'Open Settings',
  install: 'Download & install',
  cancel: 'Cancel',
  checking: 'Checking for the 3D engine…',
}

export interface ThreeDSetup {
  /** null while the check runs. */
  ready: boolean | null
  /** The Mac model the card is for, with its licence when it has one. */
  card: Mesh3dModel | null
  needsSetup: boolean
  installing: boolean
  line: string | null
  error: string | null
  install: () => void
  cancel: () => void
}

/** Whether the local 3D engine of this machine is there, and the means to
 *  set it up. Asks nothing while `active` is false. */
export function useThreeDLocal(active: boolean): ThreeDSetup {
  const mac = isMlxImageHost()
  const macModel = mac3dModel(useCreateStore((s) => s.threeDMacModel)).id
  const { installModelBundle } = useCreateExp()
  const [ready, setReady] = useState<boolean | null>(null)
  const [card, setCard] = useState<Mesh3dModel | null>(null)
  const [installing, setInstalling] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const check = useCallback(async () => {
    try {
      if (mac) {
        const { getMesh3dStatus, mesh3dModelOf } = await import('../../../api/mlx-3d')
        const st = await getMesh3dStatus()
        const model = mesh3dModelOf(st, macModel)
        setCard(model)
        return !!model?.installed
      }
      const { comfyThreeDReady } = await import('../../../lib/local-3d-comfy')
      return await comfyThreeDReady()
    } catch {
      return false
    }
  }, [mac, macModel])

  useEffect(() => {
    if (!active) return
    let alive = true
    setReady(null)
    void check().then((ok) => { if (alive) setReady(ok) })
    return () => { alive = false }
  }, [active, check])

  const install = useCallback(() => {
    if (installing) return
    const controller = new AbortController()
    abort.current = controller
    setInstalling(true)
    setError(null)
    void (async () => {
      try {
        if (mac) {
          const api = await import('../../../api/mlx-3d')
          await api.installMesh3d(macModel)
          for (;;) {
            if (controller.signal.aborted) {
              await api.cancelMesh3dInstall().catch(() => undefined)
              break
            }
            const st = await api.getMesh3dInstallStatus()
            setLine(installLine(st))
            if (st.status === 'complete') break
            if (st.status === 'error') throw new Error(st.error ?? 'The 3D setup stopped.')
            await new Promise((r) => setTimeout(r, 1000))
          }
        } else {
          await installModelBundle('3d', (msg) => setLine(msg), controller.signal)
        }
        setReady(await check())
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstalling(false)
        setLine(null)
        abort.current = null
      }
    })()
  }, [installing, mac, macModel, check, installModelBundle])

  const cancel = useCallback(() => abort.current?.abort(), [])

  return { ready, card, needsSetup: active && ready === false, installing, line, error, install, cancel }
}

function installLine(st: { status: string; download_progress?: number; download_total?: number; logs?: string[] }): string | null {
  if (st.download_total && st.download_total > 0) {
    const pct = Math.min(100, Math.floor(((st.download_progress ?? 0) / st.download_total) * 100))
    return `Downloading… ${pct}%`
  }
  return st.logs?.length ? st.logs[st.logs.length - 1] : null
}

export function ThreeDSetupCard({ setup }: { setup: ThreeDSetup }) {
  const mac = isMlxImageHost()
  const openSettingsAt = useUIStore((s) => s.openSettingsAt)
  const gated = mac && !!setup.card?.gated
  const title = !mac ? SETUP_TEXT.pcTitle : gated ? SETUP_TEXT.sf3dTitle : SETUP_TEXT.macTitle
  const body = !mac ? SETUP_TEXT.pcBody : gated ? SETUP_TEXT.sf3dBody : SETUP_TEXT.macBody
  const tokenMissing = gated && !setup.card?.hasToken
  const licenseUrl = setup.card?.licenseUrl
  return (
    <div className="m-auto flex flex-col items-center gap-3 max-w-[440px] text-center p-6" data-testid="three-d-setup">
      <Box size={30} className="text-gray-400" />
      <h3 className="t-title text-gray-100">{title}</h3>
      <p className="t-body text-gray-400">{body}</p>
      {gated && setup.card?.licenseText && (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-2" data-testid="three-d-license">
          <p className="t-meta text-gray-400 text-left">{setup.card.licenseText}</p>
          {licenseUrl && (
            <button type="button" className="t-meta text-gray-300 underline" onClick={() => void openExternal(licenseUrl)}>
              {SETUP_TEXT.licenseLink}
            </button>
          )}
        </div>
      )}
      {tokenMissing && !setup.installing && (
        <>
          <p className="t-meta text-gray-300" data-testid="three-d-token-needed">{SETUP_TEXT.tokenNeeded}</p>
          <Button variant="secondary" onClick={() => openSettingsAt({ tab: 'backends' })}>{SETUP_TEXT.tokenButton}</Button>
        </>
      )}
      {setup.installing ? (
        <>
          <p className="t-meta text-gray-300" data-testid="three-d-setup-line">{setup.line ?? T.phases.ready}</p>
          <Button variant="secondary" onClick={setup.cancel}>{SETUP_TEXT.cancel}</Button>
        </>
      ) : (
        <Button variant="primary" onClick={setup.install} disabled={tokenMissing} data-testid="three-d-setup-install">{SETUP_TEXT.install}</Button>
      )}
      {setup.error && <p className="t-meta text-red-300" role="alert">{setup.error}</p>}
    </div>
  )
}

/** The empty Stage of "From video": the video goes in the Composer, and the
 *  first still frame will stand here. */
export function ThreeDVideoHint() {
  return (
    <div className="m-auto flex flex-col items-center gap-2 max-w-[420px] text-center p-6" data-testid="three-d-video-hint">
      <Film size={28} className="text-gray-400" />
      <p className="t-body text-gray-300">{T.dropVideo}</p>
      <p className="t-meta text-gray-500">{T.dropVideoSub}</p>
    </div>
  )
}
