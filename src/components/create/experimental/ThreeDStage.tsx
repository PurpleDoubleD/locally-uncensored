// What the Stage of the 3D tab shows before there is anything to show: the
// one-time setup of the local engine, and the hint for a video.
//
// Local 3D has its own setup, not the starter-bundle gate of requiresModels:
// on a Mac it is an engine of its own (TripoSR, commands/mesh3d.rs, through
// api/mlx-3d.ts), on Windows and Linux a ComfyUI bundle (TRELLIS.2,
// lib/local-3d-comfy.ts).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Film } from 'lucide-react'
import { isMlxImageHost } from '../../../api/mlx-image'
import { THREE_D_TEXT as T } from '../../../lib/three/three-d-text'
import { useCreateExp } from './CreateContext'
import { Button } from '../ui/Button'

export const SETUP_TEXT = {
  macTitle: '3D on this Mac needs a one-time download',
  macBody: 'This sets up the 3D engine and the TripoSR model, about 1.7 GB. It turns one picture into a 3D model on this Mac. Local 3D is never filtered.',
  pcTitle: 'Local 3D needs a one-time download',
  pcBody: 'This sets up ComfyUI itself if it is missing, plus the TRELLIS.2 model files, about 9 GB. Local 3D is never filtered.',
  install: 'Download & install',
  cancel: 'Cancel',
  checking: 'Checking for the 3D engine…',
}

export interface ThreeDSetup {
  /** null while the check runs. */
  ready: boolean | null
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
  const { installModelBundle } = useCreateExp()
  const [ready, setReady] = useState<boolean | null>(null)
  const [installing, setInstalling] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const check = useCallback(async () => {
    try {
      if (mac) {
        const { getMesh3dStatus } = await import('../../../api/mlx-3d')
        const st = await getMesh3dStatus()
        return !!st.installed
      }
      const { comfyThreeDReady } = await import('../../../lib/local-3d-comfy')
      return await comfyThreeDReady()
    } catch {
      return false
    }
  }, [mac])

  useEffect(() => {
    if (!active) return
    let alive = true
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
          await api.installMesh3d()
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
  }, [installing, mac, check, installModelBundle])

  const cancel = useCallback(() => abort.current?.abort(), [])

  return { ready, needsSetup: active && ready === false, installing, line, error, install, cancel }
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
  return (
    <div className="flex flex-col items-center gap-3 max-w-[440px] text-center p-6" data-testid="three-d-setup">
      <Box size={30} className="text-gray-400" />
      <h3 className="t-title text-gray-100">{mac ? SETUP_TEXT.macTitle : SETUP_TEXT.pcTitle}</h3>
      <p className="t-body text-gray-400">{mac ? SETUP_TEXT.macBody : SETUP_TEXT.pcBody}</p>
      {setup.installing ? (
        <>
          <p className="t-meta text-gray-300" data-testid="three-d-setup-line">{setup.line ?? T.phases.ready}</p>
          <Button variant="secondary" onClick={setup.cancel}>{SETUP_TEXT.cancel}</Button>
        </>
      ) : (
        <Button onClick={setup.install} data-testid="three-d-setup-install">{SETUP_TEXT.install}</Button>
      )}
      {setup.error && <p className="t-meta text-red-300" role="alert">{setup.error}</p>}
    </div>
  )
}

/** The empty Stage of "From video": the video goes in the Composer, and the
 *  first still frame will stand here. */
export function ThreeDVideoHint() {
  return (
    <div className="flex flex-col items-center gap-2 max-w-[420px] text-center p-6" data-testid="three-d-video-hint">
      <Film size={28} className="text-gray-400" />
      <p className="t-body text-gray-300">{T.dropVideo}</p>
      <p className="t-meta text-gray-500">{T.dropVideoSub}</p>
    </div>
  )
}
