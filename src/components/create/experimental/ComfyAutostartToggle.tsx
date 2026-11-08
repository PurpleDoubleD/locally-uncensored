import { useEffect, useState } from 'react'
import { backendCall } from '../../../api/backend'

interface ComfyAutostartStatus {
  found?: boolean
  isLocal?: boolean
  autostart?: boolean
}

/**
 * C50 (3.1.0, Discord 06.11.): since 3.0.9 LU only starts ComfyUI at launch
 * when the user said so, and the switch for that sat folded away in Settings
 * → AI Backends → ComfyUI. The Create card that says "Start ComfyUI" carries
 * the same switch, so the person who just had to start it by hand finds it
 * where the question comes up. Same command and config key as Settings
 * (`set_comfyui_autostart`), so both always show the same answer.
 *
 * Shown only for a ComfyUI LU can start on this machine: none for a remote
 * host or before LU knows the install, and none on a Mac (MLX only, the
 * card never asks to start ComfyUI there).
 */
export function ComfyAutostartToggle() {
  const [status, setStatus] = useState<ComfyAutostartStatus | null>(null)
  useEffect(() => {
    let live = true
    backendCall<ComfyAutostartStatus>('comfyui_status')
      .then((st) => { if (live) setStatus(st ?? null) })
      .catch(() => {})
    return () => { live = false }
  }, [])
  if (!status || !status.found || status.isLocal === false || typeof status.autostart !== 'boolean') return null
  return (
    <label className="flex items-center gap-2 t-control text-gray-400 cursor-pointer select-none" title="Also in Settings → AI Backends → ComfyUI">
      <input
        type="checkbox"
        aria-label="Start ComfyUI when LU starts"
        checked={status.autostart}
        onChange={async (e) => {
          const enabled = e.target.checked
          setStatus((prev) => prev ? { ...prev, autostart: enabled } : prev)
          try {
            await backendCall('set_comfyui_autostart', { enabled })
          } catch {
            setStatus((prev) => prev ? { ...prev, autostart: !enabled } : prev)
          }
        }}
        className="accent-emerald-500"
      />
      <span>Start ComfyUI when LU starts</span>
    </label>
  )
}
