// Audit #01 — the app log file, surfaced to the user.
//
// The Rust side now writes a rolling log (one file per day, seven kept) and
// the frontend mirrors its warn/error lines into it. None of that helps a
// support request unless the user can find the file, so this block sits in
// Settings → Troubleshoot, right under the diagnostic probe that is already
// the "something is wrong, what do I send you" panel.
//
// Two actions, because both fail in different places: "Open folder" is the
// fast path but does nothing useful over a remote desktop or on a Linux box
// without xdg-utils, and "Copy path" always works and can be pasted into a
// bug report as text.

import { useEffect, useState } from 'react'
import { FileText, FolderOpen, Check, Copy } from 'lucide-react'
import { backendCall, isTauri } from '../../api/backend'

interface LogLocation {
  dir: string
  file: string
  exists: boolean
  size_bytes: number
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function LogFileSettings() {
  const [loc, setLoc] = useState<LogLocation | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One flag for both buttons' "it worked" tick — they are never pressed in
  // the same 1.5 s, and two timers would be two things to clean up.
  const [done, setDone] = useState<'copied' | 'opened' | null>(null)

  useEffect(() => {
    // Browser dev mode has no Rust side and therefore no log file; asking
    // would only produce an "Unknown backend command" error to render.
    if (!isTauri()) return
    let alive = true
    backendCall<LogLocation>('log_file_path', {})
      .then((r) => alive && setLoc(r))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(null), 1500)
    return () => clearTimeout(t)
  }, [done])

  if (!isTauri()) {
    return (
      <div className="rounded-lg border border-white/[0.06] p-2.5">
        <div className="text-[0.55rem] uppercase tracking-widest text-gray-500 mb-1.5">Log file</div>
        <p className="text-[0.6rem] text-gray-500">
          Written by the desktop app only. In the browser the console is the log.
        </p>
      </div>
    )
  }

  const copyPath = async () => {
    if (!loc) return
    try {
      await navigator.clipboard.writeText(loc.dir)
      setDone('copied')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openFolder = async () => {
    try {
      await backendCall('log_reveal', {})
      setDone('opened')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="rounded-lg border border-white/[0.06] p-2.5 space-y-2">
      <div className="text-[0.55rem] uppercase tracking-widest text-gray-500 flex items-center gap-1.5">
        <FileText size={10} /> Log file
      </div>

      <p className="text-[0.6rem] text-gray-500 leading-relaxed">
        LU writes a log every day and keeps the last seven. Attach today's file
        to a bug report — it holds what the app was doing right before the
        problem, which a screenshot cannot show.
      </p>

      {loc && (
        <>
          {/* Breaks anywhere: a Windows path under a long user name does not
              fit the panel, and truncating it would make it uncopyable by eye. */}
          <div className="text-[0.6rem] font-mono text-gray-300 break-all leading-relaxed">
            {loc.file}
          </div>
          <div className="text-[0.55rem] text-gray-500">
            {loc.exists
              ? `today's file: ${prettySize(loc.size_bytes)}`
              : 'nothing logged yet today'}
          </div>
        </>
      )}

      {error && (
        <div className="text-[0.6rem] text-red-400 break-all">{error}</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={openFolder}
          className="flex-1 px-3 py-1.5 rounded-md text-[0.65rem] font-medium bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-gray-800 dark:text-gray-200 transition-colors flex items-center justify-center gap-1.5"
        >
          {done === 'opened' ? <Check size={11} /> : <FolderOpen size={11} />}
          {done === 'opened' ? 'Opened' : 'Open folder'}
        </button>
        <button
          onClick={copyPath}
          disabled={!loc}
          className="flex-1 px-3 py-1.5 rounded-md text-[0.65rem] font-medium bg-gray-100 dark:bg-white/[0.06] hover:bg-gray-200 dark:hover:bg-white/10 text-gray-800 dark:text-gray-200 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
        >
          {done === 'copied' ? <Check size={11} /> : <Copy size={11} />}
          {done === 'copied' ? 'Copied' : 'Copy path'}
        </button>
      </div>
    </div>
  )
}
