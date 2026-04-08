import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowDownToLine, Pause, Play, X, CheckCircle, RotateCcw } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useDownloadStore } from '../../stores/downloadStore'
import { formatBytes } from '../../lib/formatters'

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div className="w-full h-1 rounded-full bg-white/[0.06] overflow-hidden">
      <div className="h-full rounded-full bg-blue-500 transition-all duration-300" style={{ width: `${Math.min(100, progress)}%` }} />
    </div>
  )
}

export function DownloadBadge() {
  const { activePulls, pullModel, pausePull, dismissPull } = useModels()
  const comfyDownloads = useDownloadStore(s => s.downloads)
  const bundleMap = useDownloadStore(s => s.bundleMap)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Text model entries
  const textEntries = Object.entries(activePulls)
  const textActiveCount = textEntries.filter(([, s]) => !s.paused && !s.complete).length

  // ComfyUI (image/video) entries — group by bundle
  const comfyEntries = Object.entries(comfyDownloads).filter(([, d]) =>
    d.status === 'downloading' || d.status === 'connecting' || d.status === 'pausing' || d.status === 'paused' || d.status === 'complete' || d.status === 'error'
  )
  const comfyActiveCount = comfyEntries.filter(([, d]) => d.status === 'downloading' || d.status === 'connecting').length

  // Group comfyUI downloads by bundle name
  const comfyBundles = new Map<string, { id: string; d: typeof comfyDownloads[string] }[]>()
  for (const [id, d] of comfyEntries) {
    const bundleName = bundleMap[id] || id // Ungrouped files show as individual
    if (!comfyBundles.has(bundleName)) comfyBundles.set(bundleName, [])
    comfyBundles.get(bundleName)!.push({ id, d })
  }

  const totalActive = textActiveCount + comfyActiveCount
  const hasAny = textEntries.length > 0 || comfyEntries.length > 0

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Auto-open when a new download starts
  useEffect(() => {
    if (totalActive > 0) setOpen(true)
  }, [totalActive])

  return (
    <div ref={ref} className="relative">
      {/* Icon button */}
      <button
        onClick={() => setOpen(!open)}
        className={`relative p-1.5 rounded-md transition-colors ${
          hasAny
            ? 'text-blue-400 hover:bg-blue-500/10'
            : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
        }`}
        title="Downloads"
      >
        <ArrowDownToLine size={14} />
        {/* Badge */}
        {totalActive > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-blue-500 text-[0.5rem] font-bold text-white leading-none px-0.5">
            {totalActive}
            <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-40" />
          </span>
        )}
        {/* Paused indicator */}
        {totalActive === 0 && (textEntries.some(([, s]) => s.paused) || comfyEntries.some(([, d]) => d.status === 'paused')) && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-yellow-500" />
        )}
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-0 top-full mt-1.5 w-72 rounded-lg overflow-hidden z-50 bg-white dark:bg-[#0f0f0f] border border-gray-200 dark:border-white/[0.06] shadow-2xl shadow-black/50"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
              <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-gray-500">
                Downloads {hasAny && `(${textEntries.length + comfyEntries.length})`}
              </span>
              {(textEntries.some(([, s]) => s.complete) || comfyEntries.some(([, d]) => d.status === 'complete')) && (
                <button
                  onClick={() => {
                    textEntries.filter(([, s]) => s.complete).forEach(([n]) => dismissPull(n))
                    comfyEntries.filter(([, d]) => d.status === 'complete').forEach(([id]) => useDownloadStore.getState().dismiss(id))
                  }}
                  className="text-[0.6rem] text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Clear completed
                </button>
              )}
            </div>

            {/* Download list */}
            <div className="max-h-[300px] overflow-y-auto">
              {!hasAny && (
                <p className="text-center text-[0.7rem] text-gray-500 py-6">No active downloads</p>
              )}

              {/* Text model downloads (Ollama) */}
              {textEntries.map(([name, state]) => {
                const prog = state.progress.total && state.progress.completed
                  ? (state.progress.completed / state.progress.total) * 100 : 0

                return (
                  <div key={name} className="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04] first:border-t-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-[0.7rem] font-mono text-gray-700 dark:text-gray-300 truncate">{name}</p>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {!state.complete && !state.paused && (
                          <button onClick={() => pausePull(name)} className="p-0.5 rounded hover:bg-yellow-500/20 text-gray-400 hover:text-yellow-400 transition-colors" title="Pause"><Pause size={11} /></button>
                        )}
                        {state.paused && (
                          <button onClick={() => pullModel(name)} className="p-0.5 rounded hover:bg-green-500/20 text-gray-400 hover:text-green-400 transition-colors" title="Resume"><Play size={11} /></button>
                        )}
                        <button onClick={() => dismissPull(name)} className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors" title="Dismiss"><X size={11} /></button>
                      </div>
                    </div>
                    {state.complete ? (
                      <div className="flex items-center gap-1.5 text-green-400"><CheckCircle size={11} /><span className="text-[0.65rem]">Complete</span></div>
                    ) : state.paused ? (
                      <span className="text-[0.65rem] text-yellow-400">Paused</span>
                    ) : (
                      <>
                        <p className="text-[0.6rem] text-gray-500 mb-1 truncate">{state.progress.status}</p>
                        {state.progress.total && state.progress.completed !== undefined && (
                          <>
                            <ProgressBar progress={prog} />
                            <p className="text-[0.55rem] text-gray-500 mt-0.5">
                              {formatBytes(state.progress.completed || 0)} / {formatBytes(state.progress.total)}
                              {prog > 0 && <span className="ml-1.5 text-blue-400">{Math.round(prog)}%</span>}
                            </p>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )
              })}

              {/* ComfyUI downloads (image/video models) — grouped by bundle */}
              {Array.from(comfyBundles.entries()).map(([bundleName, files]) => {
                const allComplete = files.every(f => f.d.status === 'complete')
                const totalBytes = files.reduce((s, f) => s + f.d.total, 0)
                const doneBytes = files.reduce((s, f) => s + f.d.progress, 0)
                const bundleProg = totalBytes > 0 ? (doneBytes / totalBytes) * 100 : 0
                const bundleSpeed = files.reduce((s, f) => s + (f.d.status === 'downloading' ? (f.d.speed || 0) : 0), 0)
                const isBundle = files.length > 1

                return (
                  <div key={bundleName} className="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04] first:border-t-0">
                    {/* Bundle header */}
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className={`${isBundle ? 'text-[0.7rem] font-medium' : 'text-[0.7rem] font-mono'} text-gray-700 dark:text-gray-300 truncate`}>{bundleName}</p>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {files.some(f => f.d.status === 'error') && (
                          <button onClick={() => files.filter(f => f.d.status === 'error').forEach(f => useDownloadStore.getState().retry(f.id))} className="p-0.5 rounded hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors" title="Retry failed"><RotateCcw size={11} /></button>
                        )}
                        {allComplete ? (
                          <button onClick={() => files.forEach(f => useDownloadStore.getState().dismiss(f.id))} className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors" title="Dismiss"><X size={11} /></button>
                        ) : (
                          <button onClick={() => files.forEach(f => useDownloadStore.getState().cancel(f.id))} className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors" title="Cancel all"><X size={11} /></button>
                        )}
                      </div>
                    </div>

                    {allComplete ? (
                      <div className="flex items-center gap-1.5 text-green-400"><CheckCircle size={11} /><span className="text-[0.65rem]">Complete ({files.length} files)</span></div>
                    ) : (
                      <>
                        {totalBytes > 0 && <ProgressBar progress={bundleProg} />}
                        <div className="flex items-center justify-between mt-0.5">
                          <p className="text-[0.55rem] text-gray-500">
                            {totalBytes > 0 ? `${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}` : 'Starting...'}
                            {bundleProg > 0 && <span className="ml-1.5 text-blue-400">{Math.round(bundleProg)}%</span>}
                            {bundleSpeed > 0 && <span className="ml-1.5 text-gray-400">{formatBytes(bundleSpeed)}/s</span>}
                          </p>
                          {/* Retry all failed files in bundle */}
                          {files.some(f => f.d.status === 'error') && (
                            <button
                              onClick={() => files.filter(f => f.d.status === 'error').forEach(f => useDownloadStore.getState().retry(f.id))}
                              className="flex items-center gap-1 text-[0.55rem] text-red-400 hover:text-red-300 transition-colors"
                              title="Retry failed downloads"
                            >
                              <RotateCcw size={9} />
                              <span>Retry failed</span>
                            </button>
                          )}
                        </div>
                        {/* Individual file rows */}
                        {isBundle && (
                          <div className="mt-1.5 space-y-0.5">
                            {files.map(({ id, d }) => (
                              <div key={id} className="flex items-center justify-between text-[0.55rem] text-gray-500">
                                <span className="truncate flex-1 font-mono">{d.filename || id}</span>
                                <span className="shrink-0 ml-2 flex items-center gap-1">
                                  {d.status === 'complete' ? <span className="text-green-400">Done</span>
                                    : d.status === 'error' ? (
                                      <button
                                        onClick={() => useDownloadStore.getState().retry(id)}
                                        className="flex items-center gap-0.5 text-red-400 hover:text-red-300 transition-colors"
                                        title={d.error || 'Download failed — click to retry'}
                                      >
                                        <RotateCcw size={8} />
                                        <span>Retry</span>
                                      </button>
                                    )
                                    : d.status === 'paused' ? <span className="text-yellow-400">Paused</span>
                                    : d.total > 0 ? <>{Math.round((d.progress / d.total) * 100)}%{d.speed > 0 && <span className="ml-1 text-gray-400">{formatBytes(d.speed)}/s</span>}</>
                                    : d.status === 'connecting' ? 'Connecting' : '...'}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
