import { useEffect, useRef, useState } from 'react'
import { Check, Download, Loader2 } from 'lucide-react'
import { backendCall } from '../../api/backend'
import { gitInstallLine, type GitInstallStatus } from '../../lib/git-missing'

/**
 * "Install Git" (3.1.3): a button and one status line, at the place where
 * LU says that git is missing. Windows fetches LU's own MinGit, a Mac opens
 * the dialog for its Command Line Tools, Linux shows the package command to
 * copy. `onReady` runs once git is there, so the install that needed it can
 * go on by itself.
 */
export function GitInstallButton({ onReady, className }: { onReady?: () => void; className?: string }) {
  const [state, setState] = useState<GitInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)
  const done = useRef(false)
  const readyRef = useRef(onReady)
  useEffect(() => { readyRef.current = onReady }, [onReady])

  const stop = () => {
    if (poll.current) clearInterval(poll.current)
    poll.current = null
  }
  useEffect(() => stop, [])

  const take = (s: GitInstallStatus) => {
    setState(s)
    if (s.status === 'complete' || (s.installed && s.status !== 'downloading' && s.status !== 'installing')) {
      stop()
      setBusy(false)
      setState({ ...s, status: 'complete' })
      if (!done.current) {
        done.current = true
        readyRef.current?.()
      }
    } else if (s.status === 'error' || s.status === 'manual') {
      stop()
      setBusy(false)
    }
  }

  const check = async () => {
    try {
      take(await backendCall<GitInstallStatus>('install_git_status'))
    } catch { /* the next tick asks again */ }
  }

  const start = async () => {
    setBusy(true)
    done.current = false
    try {
      const first = await backendCall<GitInstallStatus>('install_git')
      take({ ...first, logs: [] })
      if (first.status === 'manual' || first.status === 'error' || first.status === 'complete') return
      stop()
      // A Mac waits for its own dialog, which takes minutes: ask less often.
      poll.current = setInterval(check, first.status === 'installing' ? 3000 : 1000)
    } catch (e) {
      setBusy(false)
      setState({ status: 'error', logs: [e instanceof Error ? e.message : 'Installing Git could not start.'] })
    }
  }

  const ready = state?.status === 'complete'
  const line = state ? gitInstallLine(state) : ''
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        {ready ? (
          <span className="flex items-center gap-1 t-micro text-green-600 dark:text-green-400">
            <Check size={11} /> {line}
          </span>
        ) : (
          <>
            <button onClick={() => void start()} disabled={busy} className="lu-control flex items-center gap-1">
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />} Install Git
            </button>
            {line && <span className="t-micro text-gray-500 dark:text-gray-400 whitespace-pre-line">{line}</span>}
          </>
        )}
      </div>
      {state?.status === 'manual' && state.command && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="t-micro font-mono select-all">{state.command}</code>
          <button onClick={() => void navigator.clipboard?.writeText(state.command ?? '')} className="lu-control">Copy</button>
          <button onClick={() => void check()} className="lu-control">Check again</button>
        </div>
      )}
    </div>
  )
}
