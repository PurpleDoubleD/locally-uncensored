import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUpCircle, Download, RefreshCw, RotateCcw, X, Loader2 } from 'lucide-react'
import { useUpdateStore, initUpdateChecker } from '../../stores/updateStore'
import { formatBytes } from '../../lib/formatters'
import { isTauri } from '../../api/backend'

export function UpdateBadge() {
  const {
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseNotes,
    dismissed,
    downloadStatus,
    downloadProgress,
    downloadedBytes,
    totalBytes,
    errorMessage,
    downloadUpdate,
    installAndRestart,
    dismissUpdate,
  } = useUpdateStore()

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { initUpdateChecker() }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const showBadge = updateAvailable && latestVersion && dismissed !== latestVersion
  if (!showBadge) return null

  const isDownloading = downloadStatus === 'downloading'
  const isDownloaded = downloadStatus === 'downloaded'
  const isInstalling = downloadStatus === 'installing'
  const isError = downloadStatus === 'error'
  const canDownload = isTauri() && downloadStatus === 'idle'

  // A bare 20px icon in the corner is easy to never notice: on 2026-08-05 the
  // in-app waitlist was still logging sign-ups from 2.5.5 and 2.5.6 builds,
  // weeks after 2.5.7 shipped, on installs whose updater was working fine. So
  // the badge says what it wants in words. It still collapses to the icon on a
  // narrow window, where the header has no room for a label.
  const label = isDownloaded
    ? 'Restart to update'
    : isDownloading
      ? `Updating ${downloadProgress}%`
      : isInstalling
        ? 'Installing'
        : isError
          ? 'Update failed'
          : `Update to v${latestVersion}`

  return (
    <div ref={ref} className="relative">
      {/* Badge button */}
      <button
        onClick={() => setOpen(!open)}
        className={`relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.7rem] font-medium transition-colors ${
          isDownloaded
            ? 'text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25'
            : isDownloading
              ? 'text-blue-700 dark:text-blue-400 hover:bg-blue-500/10'
              : isError
                ? 'text-red-700 dark:text-red-400 hover:bg-red-500/10'
                : 'text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10'
        }`}
        title={
          isDownloaded ? 'Update ready, click to restart'
            : isDownloading ? `Downloading update... ${downloadProgress}%`
              : `Update available: v${latestVersion}`
        }
      >
        <span className="relative">
          {isDownloading || isInstalling ? (
            <Loader2 size={20} strokeWidth={1.8} className="animate-spin" />
          ) : (
            <ArrowUpCircle size={20} strokeWidth={1.8} />
          )}
          {/* Status dot */}
          <span className={`absolute top-0 right-0 w-2.5 h-2.5 rounded-full ${
            isDownloaded ? 'bg-emerald-600 dark:bg-emerald-400'
              : isDownloading ? 'bg-blue-600 dark:bg-blue-400'
                : isError ? 'bg-red-600 dark:bg-red-400'
                  : 'bg-emerald-600 dark:bg-emerald-400'
          }`}>
            {!isDownloaded && !isError && (
              <span className={`absolute inset-0 rounded-full animate-ping opacity-75 ${
                isDownloading ? 'bg-blue-600 dark:bg-blue-400' : 'bg-emerald-600 dark:bg-emerald-400'
              }`} />
            )}
          </span>
        </span>
        <span className="hidden md:inline whitespace-nowrap pr-0.5">{label}</span>
      </button>

      {/* Dropdown.
          Hellmodus-Luecke aus Welle 2, in f336b91e gemeldet statt geaendert:
          „nur die Flaeche umzustellen waere eine Verschlimmbesserung, das
          Innere ist durchgehend dunkelmodus-only gefaerbt". Genau deshalb
          geht hier BEIDES zusammen — die Flaeche auf Tokens (`bg-white
          dark:bg-lu-overlay`) UND jeder Akzent darin auf ein Hell-Pendant.
          Vorher im Hellmodus: der Rescue-Layer drehte die Schrift nach unten
          (`.light .text-gray-500 → #374151`), die Flaeche blieb #363636 →
          1,17:1. Nachher 10,31:1. Emerald 1,92:1 → 5,48:1.
          Die Statuspunkte und der Fortschrittsbalken sind Nicht-Text und
          zaehlen gegen 1.4.11 (3:1): emerald-400 stand auf Weiss bei
          1,92:1, emerald-600 steht bei 3,77:1. */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-0 top-full mt-1.5 w-72 rounded-lg overflow-hidden z-50 bg-white dark:bg-lu-overlay border border-gray-200 dark:border-white/[0.08] shadow-2xl shadow-black/10 dark:shadow-black/50"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <span className={`text-[0.65rem] font-semibold uppercase tracking-widest ${
                isDownloaded ? 'text-emerald-700 dark:text-emerald-400/70'
                  : isDownloading ? 'text-blue-700 dark:text-blue-400/70'
                    : isError ? 'text-red-700 dark:text-red-400/70'
                      : 'text-emerald-700 dark:text-emerald-400/70'
              }`}>
                {isDownloaded ? 'Ready to Install'
                  : isDownloading ? 'Downloading Update'
                    : isInstalling ? 'Installing...'
                      : isError ? 'Update Error'
                        : 'Update Available'}
              </span>
              {!isDownloading && !isInstalling && (
                <button
                  onClick={(e) => { e.stopPropagation(); dismissUpdate(); setOpen(false) }}
                  className="p-0.5 rounded text-gray-600 hover:text-gray-300 transition-colors"
                  title="Dismiss"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Version info */}
            <div className="px-3 py-2">
              <div className="flex items-center gap-2 text-[0.7rem]">
                <span className="text-gray-500">v{currentVersion}</span>
                <span className="text-gray-600">&rarr;</span>
                <span className="text-emerald-700 dark:text-emerald-400 font-medium">v{latestVersion}</span>
              </div>
            </div>

            {/* Download progress */}
            {(isDownloading || isDownloaded) && (
              <div className="px-3 pb-2">
                <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <motion.div
                    className={`h-full rounded-full ${isDownloaded ? 'bg-emerald-600 dark:bg-emerald-500' : 'bg-blue-600 dark:bg-blue-500'}`}
                    initial={{ width: 0 }}
                    animate={{ width: `${downloadProgress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[0.55rem] text-gray-500">
                    {isDownloaded ? 'Download complete' : `${downloadProgress}%`}
                  </span>
                  {totalBytes > 0 && (
                    <span className="text-[0.55rem] text-gray-600">
                      {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Error message */}
            {isError && errorMessage && (
              <div className="px-3 pb-2">
                <p className="text-[0.6rem] text-red-700 dark:text-red-400/80 leading-relaxed">{errorMessage}</p>
              </div>
            )}

            {/* Release notes */}
            {releaseNotes && !isDownloading && !isDownloaded && (
              <div className="px-3 pb-2">
                <p className="text-[0.6rem] text-gray-500 leading-relaxed line-clamp-4 whitespace-pre-line">
                  {releaseNotes}
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="border-t border-white/[0.04] p-2 flex gap-1.5">
              {/* State: idle — show Download button */}
              {canDownload && (
                <>
                  <button
                    onClick={() => downloadUpdate()}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                  >
                    <Download size={11} />
                    Download Update
                  </button>
                  <button
                    onClick={() => { dismissUpdate(); setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Later
                  </button>
                </>
              )}

              {/* State: downloading — show progress info */}
              {isDownloading && (
                <div className="flex-1 text-center text-[0.6rem] text-blue-700 dark:text-blue-400/70 py-1">
                  Downloading...
                </div>
              )}

              {/* State: downloaded — Restart + Later */}
              {isDownloaded && (
                <>
                  <button
                    onClick={() => installAndRestart()}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                  >
                    <RefreshCw size={11} />
                    Restart Now
                  </button>
                  <button
                    onClick={() => { setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Later
                  </button>
                </>
              )}

              {/* State: installing */}
              {isInstalling && (
                <div className="flex-1 flex items-center justify-center gap-1.5 text-[0.6rem] text-emerald-700 dark:text-emerald-400/70 py-1">
                  <Loader2 size={11} className="animate-spin" />
                  Installing...
                </div>
              )}

              {/* State: error — Retry */}
              {isError && (
                <>
                  <button
                    onClick={() => downloadUpdate()}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-red-500/15 text-red-700 dark:text-red-400 hover:bg-red-500/25 transition-colors"
                  >
                    <RotateCcw size={11} />
                    Retry
                  </button>
                  <button
                    onClick={() => { dismissUpdate(); setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Dismiss
                  </button>
                </>
              )}

              {/* Dev mode: no in-app install, link to GitHub */}
              {!isTauri() && downloadStatus === 'idle' && (
                <>
                  <button
                    onClick={() => {
                      window.open(`https://github.com/purpledoubled/locally-uncensored/releases/latest`, '_blank')
                      setOpen(false)
                    }}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[0.65rem] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 transition-colors"
                  >
                    <Download size={11} />
                    View Release
                  </button>
                  <button
                    onClick={() => { dismissUpdate(); setOpen(false) }}
                    className="px-2 py-1.5 rounded-md text-[0.65rem] text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-colors"
                  >
                    Later
                  </button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
