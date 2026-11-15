import { useCallback, useEffect, useState } from 'react'
import { Check, Download, Loader2, X } from 'lucide-react'
import { backendCall } from '../../api/backend'
import { parakeetStatus, type ParakeetStatus } from '../../api/voice'
import { HINWEIS_TEXT } from '../../lib/hinweis'
import { useVoiceStore } from '../../stores/voiceStore'

/**
 * Parakeet dictation (GitHub #233), one line under the dictation switch:
 * what it is, and either its download or that it is ready. The download is
 * NVIDIA's runtime for this machine plus the model, verified by checksum in
 * commands/parakeet.rs.
 */

export function sizeText(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/** The percentage of a running download, 0 to 100. */
export function percentOf(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0
}

export function ParakeetSetting() {
  const [status, setStatus] = useState<ParakeetStatus | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const setReady = useVoiceStore((s) => s.setParakeetReady)

  const refresh = useCallback(
    () => parakeetStatus().then((s) => {
      setStatus(s)
      setReady(!!s?.installed)
    }),
    [setReady],
  )

  // Look once on mount, and every second while the download runs.
  const downloading = !!status?.job.running
  const doneBytes = status?.job.done_bytes ?? 0
  useEffect(() => {
    const t = setTimeout(() => void refresh(), downloading ? 1000 : 0)
    return () => clearTimeout(t)
  }, [downloading, doneBytes, refresh])

  const install = async () => {
    setStartError(null)
    try {
      await backendCall('parakeet_install')
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e))
    }
    await refresh()
  }

  const cancel = async () => {
    await backendCall('parakeet_cancel').catch(() => {})
    await refresh()
  }

  if (!status) return null
  const job = status.job
  const error = startError ?? job.error

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 t-micro">
        <span className="flex items-center gap-1.5 min-w-0">
          {job.running
            ? <Loader2 size={11} className="animate-spin text-gray-500 shrink-0" />
            : status.installed ? <Check size={11} className="text-green-500 shrink-0" /> : <X size={11} className="text-red-500 shrink-0" />}
          <span className="text-gray-700 dark:text-gray-200 font-medium">{status.model}</span>
          <span className="text-gray-500 truncate">NVIDIA</span>
        </span>
        {status.supported && !status.installed && !job.running && (
          <button
            onClick={() => void install()}
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded t-micro font-medium bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors"
            title="Download Parakeet and NVIDIA's runtime for it, checked by checksum"
          >
            <Download size={9} />
            {`Download ${sizeText(status.download_bytes)}`}
          </button>
        )}
        {job.running && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-gray-500 tabular-nums">
            {`${percentOf(job.done_bytes, job.total_bytes)} %`}
            <button onClick={() => void cancel()} title="Stop the download" aria-label="Stop the download" className="text-gray-500 hover:text-gray-300">
              <X size={10} />
            </button>
          </span>
        )}
      </div>
      {!status.supported && status.reason && <p className={`t-micro leading-snug ${HINWEIS_TEXT.fehler}`}>{status.reason}</p>}
      {error && <p className={`t-micro leading-snug ${HINWEIS_TEXT.fehler}`}>{error}</p>}
      <p className="t-micro text-gray-500 leading-snug">
        {`Fast and accurate dictation in 25 European languages, English and German included. It finds the language by itself and runs on this machine. ${status.attribution} Runs on ${status.runtime} by NVIDIA, ${status.runtime_license}.`}
      </p>
    </div>
  )
}
