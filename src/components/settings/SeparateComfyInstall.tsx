/**
 * C80 (3.1.0, GitHub #230): "Install a separate ComfyUI…" next to a ComfyUI
 * LU already found. Pick a folder, see where the new install goes, confirm.
 * Used in Settings → ComfyUI and in the onboarding's ComfyUI step.
 */
import { useState } from 'react'
import { FolderPlus } from 'lucide-react'
import { backendCall, isWindows } from '../../api/backend'
import { separateComfyTarget } from '../../lib/separate-comfy-target'
import { withDetail } from '../../lib/error-text'

interface Props {
  /** The ComfyUI LU uses now, shown as the one that stays untouched. */
  currentPath?: string | null
  /** Start the install into `target` (the caller owns progress and errors). */
  onInstall: (target: string) => void
  disabled?: boolean
  /** Classes for the opening button, so each screen keeps its own look. */
  buttonClassName?: string
  /** Classes for the explanatory text. */
  textClassName?: string
}

export function SeparateComfyInstall({ currentPath, onInstall, disabled, buttonClassName, textClassName }: Props) {
  const [target, setTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = async () => {
    setError(null)
    setTarget(null)
    let chosen: string | null = null
    try {
      chosen = await backendCall<string | null>('pick_folder')
    } catch (e) {
      setError(withDetail('The folder picker did not open.', e))
      return
    }
    if (!chosen) return
    const answer = separateComfyTarget(chosen, currentPath, isWindows())
    if (answer.ok) setTarget(answer.target)
    else setError(answer.reason)
  }

  const text = textClassName ?? 't-micro text-gray-500'
  return (
    <div className="w-full space-y-1.5" data-testid="separate-comfy-install">
      {target === null && (
        <button type="button" onClick={pick} disabled={disabled} className={buttonClassName} data-testid="separate-comfy-open">
          <FolderPlus size={12} className="shrink-0" /> Install a separate ComfyUI…
        </button>
      )}
      {target !== null && (
        <div className="space-y-1.5 text-left">
          <p className={`${text} leading-relaxed`} data-testid="separate-comfy-target">
            A new ComfyUI goes to <code className="font-mono break-all">{target}</code>.
            {currentPath ? <> Your current one at <code className="font-mono break-all">{currentPath}</code> stays as it is.</> : null}{' '}
            When the install finishes, LU uses the new one; switch back any time with Path and Connect. If that folder already holds a ComfyUI, it is updated and used.
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={disabled}
              onClick={() => { const t = target; setTarget(null); onInstall(t) }}
              className="px-2 py-1 rounded t-micro bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors disabled:opacity-30"
              data-testid="separate-comfy-confirm"
            >
              Install here
            </button>
            <button
              type="button"
              onClick={() => setTarget(null)}
              className="px-2 py-1 rounded t-micro bg-white/5 text-gray-400 hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="t-micro text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </div>
  )
}

/** The line under a ComfyUI path field: typing alone changes nothing. */
export const COMFY_PATH_CONNECT_HINT = 'Typing a path changes nothing yet: click Connect to use it. The folder needs ComfyUI\u2019s main.py.'
