import { useState, useRef, useEffect } from 'react'
import { withInstallerOutput } from '../../lib/error-text'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowDownToLine, Pause, Play, X, CheckCircle, RotateCcw } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { useDownloadStore } from '../../stores/downloadStore'
import { isPermanentDownloadError } from '../../api/discover'
import { useMlxInstallStore } from '../../stores/mlxInstallStore'
import { isMlxImageHost } from '../../api/mlx-image'
import { formatBytes, countLabel } from '../../lib/formatters'
import { trayAfterPulse, TRAY_CLOSED, NO_PULSE } from '../../lib/download-tray'

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
  // Whether the tray is open, and whether it was the TRAY that opened it —
  // one value, because the two are only ever decided together. `auto` used
  // to be a ref written from effects; see the transition block further down
  // for why both moved out of effects.
  const [tray, setTray] = useState(TRAY_CLOSED)
  const open = tray.open
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

  // MLX installs (macOS image/video engines + models), fed by the Rust
  // install slots via mlxInstallStore.
  const mlxEntryMap = useMlxInstallStore(s => s.entries)
  const mlxEntries = Object.values(mlxEntryMap)
  const mlxActiveCount = mlxEntries.filter(e => e.status === 'installing').length

  // An install can already be running with no page watching it (started in
  // Settings, view unmounted). The badge is always mounted, so it adopts.
  useEffect(() => {
    if (isMlxImageHost()) void useMlxInstallStore.getState().adopt()
  }, [])

  const totalActive = textActiveCount + comfyActiveCount + mlxActiveCount
  const hasAny = textEntries.length > 0 || comfyEntries.length > 0 || mlxEntries.length > 0

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setTray((t) => ({ ...t, open: false }))
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // The tray opens and closes itself with the downloads; trayAfterPulse
  // (lib/download-tray) holds the rule and says why. Both halves used to be
  // effects writing state back into React on every change of the download
  // picture (React 19 `set-state-in-effect`), one paint too late. The same two
  // transitions are applied here off the previous render's numbers, in React's
  // documented "adjust state while rendering" shape: it re-runs this component
  // and only this component, before anything paints.
  const [seen, setSeen] = useState(NO_PULSE)
  if (seen.active !== totalActive || seen.any !== hasAny) {
    const now = { active: totalActive, any: hasAny }
    setSeen(now)
    const next = trayAfterPulse(tray, seen, now)
    if (next !== tray) setTray(next)
  }

  // Self-heal polling: comfy download progress comes from a polled Rust/bridge
  // endpoint, and polling was only ever kicked off from the Discover page. So a
  // download watched from anywhere else — or after the idle auto-stop fired —
  // showed a frozen progress bar until the user opened the Models page, which
  // restarted polling (konata, web build, 2026-06-22). The global badge is
  // always mounted, so let it keep polling alive whenever a comfy download is
  // active. Strictly additive: it only starts polling, never stops it.
  const polling = useDownloadStore(s => s.polling)
  useEffect(() => {
    if (comfyActiveCount > 0 && !polling) {
      useDownloadStore.getState().startPolling()
    }
  }, [comfyActiveCount, polling])

  return (
    <div ref={ref} className="relative">
      {/* Icon trigger */}
      <button
        onClick={() => setTray({ open: !open, auto: false })}
        className={`relative p-1 rounded-md transition-colors ${
          hasAny
            ? 'text-blue-400 hover:bg-blue-500/10'
            : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5'
        }`}
        title="Downloads"
      >
        <ArrowDownToLine size={14} />
        {totalActive > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-blue-500 text-[0.5rem] font-bold text-white leading-none px-0.5">
            {totalActive}
          </span>
        )}
        {totalActive === 0 && (textEntries.some(([, s]) => s.paused) || comfyEntries.some(([, d]) => d.status === 'paused')) && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-yellow-500" />
        )}
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute right-0 top-full mt-1.5 w-72 rounded-lg overflow-hidden z-50 bg-white dark:bg-[#363636] border border-gray-200 dark:border-white/[0.08] shadow-2xl shadow-black/50"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
              <span className="text-[0.65rem] font-semibold uppercase tracking-widest text-gray-500">
                Downloads {hasAny && `(${textEntries.length + comfyEntries.length + mlxEntries.length})`}
              </span>
              {(textEntries.some(([, s]) => s.complete) || comfyEntries.some(([, d]) => d.status === 'complete') || mlxEntries.some(e => e.status === 'complete')) && (
                <button
                  onClick={() => {
                    textEntries.filter(([, s]) => s.complete).forEach(([n]) => dismissPull(n))
                    comfyEntries.filter(([, d]) => d.status === 'complete').forEach(([id]) => useDownloadStore.getState().dismiss(id))
                    mlxEntries.filter(e => e.status === 'complete').forEach(e => useMlxInstallStore.getState().dismiss(e.kind))
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
                            <p className="text-[0.55rem] text-gray-500 mt-0.5 lu-hud-num">
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
                const failed = files.filter(f => f.d.status === 'error')
                // Der Grund, aus dem ein Download stehen blieb, in Worten. Eine
                // abgelehnte Uebertragung zeigte frueher nur einen Retry-Knopf,
                // also sah die CivitAI-Absage, der bloss ein API-Key fehlte, wie
                // ein toter Link aus (goonerforporn, Discord #bug-reports,
                // 28.08.2026). Deshalb bekommt JEDE Absage mit Begruendung ihre
                // Zeile, nicht nur die endgueltige. Gleiche Begruendungen in
                // einem Bundle werden zu einer Zeile zusammengelegt.
                const reasons = Array.from(new Set(failed.map(f => f.d.error).filter((e): e is string => !!e)))
                // Ein umbenanntes, gesperrtes oder geloeschtes Repository
                // antwortet jedes Mal gleich, Retry ist da kein Ausweg, sondern
                // eine Schleife ohne Ausgang. Den Knopf bekommen nur die
                // Fehlschlaege, die beim naechsten Mal anders ausgehen koennen,
                // die uebrigen behalten die Begruendung, die sagt was stattdessen
                // zu tun ist.
                const retryable = failed.filter(f => !isPermanentDownloadError(f.d.error))
                // Bytes auf der Platte, die auf den Rest warten: eine pausierte
                // Uebertragung, oder ein Fragment, das diese Sitzung aus einem
                // frueheren Lauf uebernommen hat. Ohne ein Resume an dieser
                // Stelle kamen diese Dateien gar nicht mehr weiter.
                const resumable = files.filter(f => f.d.status === 'paused')
                const anyActive = files.some(f => f.d.status === 'downloading' || f.d.status === 'connecting' || f.d.status === 'pausing')

                return (
                  <div key={bundleName} className="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04] first:border-t-0">
                    {/* Bundle header */}
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className={`${isBundle ? 'text-[0.7rem] font-medium' : 'text-[0.7rem] font-mono'} text-gray-700 dark:text-gray-300 truncate`}>{bundleName}</p>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {resumable.length > 0 && !anyActive && (
                          <button onClick={() => resumable.forEach(f => useDownloadStore.getState().resume(f.id))} className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors" title="Resume"><Play size={11} /></button>
                        )}
                        {retryable.length > 0 && (
                          <button onClick={() => retryable.forEach(f => useDownloadStore.getState().retry(f.id))} className="p-0.5 rounded hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors" title="Retry failed"><RotateCcw size={11} /></button>
                        )}
                        {allComplete ? (
                          <button onClick={() => files.forEach(f => useDownloadStore.getState().dismiss(f.id))} className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors" title={files.length === 1 ? 'Dismiss' : 'Dismiss all'}><X size={11} /></button>
                        ) : (
                          <button onClick={() => files.forEach(f => useDownloadStore.getState().cancel(f.id))} className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors" title={files.length === 1 ? 'Cancel' : 'Cancel all'}><X size={11} /></button>
                        )}
                      </div>
                    </div>

                    {allComplete ? (
                      <div className="flex items-center gap-1.5 text-green-400"><CheckCircle size={11} /><span className="text-[0.65rem]">Complete ({countLabel(files.length, 'file')})</span></div>
                    ) : (
                      <>
                        {totalBytes > 0 && <ProgressBar progress={bundleProg} />}
                        <div className="flex items-center justify-between mt-0.5">
                          <p className="text-[0.55rem] text-gray-500 lu-hud-num">
                            {totalBytes > 0 ? `${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}` : 'Starting...'}
                            {bundleProg > 0 && <span className="ml-1.5 text-blue-400">{Math.round(bundleProg)}%</span>}
                            {bundleSpeed > 0 && <span className="ml-1.5 text-gray-400">{formatBytes(bundleSpeed)}/s</span>}
                          </p>
                          {/* Retry all failed files in bundle */}
                          {retryable.length > 0 && (
                            <button
                              onClick={() => retryable.forEach(f => useDownloadStore.getState().retry(f.id))}
                              className="flex items-center gap-1 text-[0.55rem] text-red-400 hover:text-red-300 transition-colors"
                              title="Retry failed downloads"
                            >
                              <RotateCcw size={9} />
                              <span>Retry failed</span>
                            </button>
                          )}
                        </div>
                        {/* Eine tote Adresse hat keinen Knopf, also muss sie die
                            Begruendung haben: was passiert ist und was
                            stattdessen zu tun ist. Eine Absage, die man wirklich
                            beheben kann, bekommt sie ebenso, sonst steht neben
                            dem Retry-Knopf wieder nur eine nackte Zahl. */}
                        {reasons.map(reason => (
                          <p key={reason} className="mt-1 text-[0.55rem] text-red-400 leading-relaxed break-words whitespace-pre-line">
                            {reason}
                          </p>
                        ))}
                        {/* Individual file rows */}
                        {isBundle && (
                          <div className="mt-1.5 space-y-0.5">
                            {files.map(({ id, d }) => (
                              <div key={id} className="flex items-center justify-between text-[0.55rem] text-gray-500">
                                <span className="truncate flex-1 font-mono">{d.filename || id}</span>
                                <span className="shrink-0 ml-2 flex items-center gap-1 lu-hud-num">
                                  {d.status === 'complete' ? <span className="text-green-400">Done</span>
                                    : d.status === 'error' && isPermanentDownloadError(d.error) ? (
                                      <span className="text-red-400" title={d.error}>Unavailable</span>
                                    )
                                    : d.status === 'error' ? (
                                      <button
                                        onClick={() => useDownloadStore.getState().retry(id)}
                                        className="flex items-center gap-0.5 text-red-400 hover:text-red-300 transition-colors"
                                        title={d.error || 'Download failed, click to retry'}
                                      >
                                        <RotateCcw size={8} />
                                        <span>Retry</span>
                                      </button>
                                    )
                                    : d.status === 'paused' ? (
                                      <button
                                        onClick={() => useDownloadStore.getState().resume(id)}
                                        className="flex items-center gap-0.5 text-yellow-400 hover:text-yellow-300 transition-colors"
                                        title="Resume this download"
                                      >
                                        <Play size={8} />
                                        <span>Resume</span>
                                      </button>
                                    )
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

              {/* MLX installs (macOS image/video engines + models) */}
              {mlxEntries.map((e) => {
                const prog = e.total > 0 ? (e.progress / e.total) * 100 : 0
                return (
                  <div key={e.kind} className="px-3 py-2 border-t border-gray-100 dark:border-white/[0.04] first:border-t-0">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-[0.7rem] text-gray-700 dark:text-gray-300 truncate">{e.label}</p>
                      {e.status !== 'installing' && (
                        <button onClick={() => useMlxInstallStore.getState().dismiss(e.kind)} className="p-0.5 rounded hover:bg-white/10 text-gray-500 hover:text-gray-300 transition-colors shrink-0" title="Dismiss"><X size={11} /></button>
                      )}
                    </div>
                    {e.status === 'complete' ? (
                      <div className="flex items-center gap-1.5 text-green-400"><CheckCircle size={11} /><span className="text-[0.65rem]">Complete</span></div>
                    ) : e.status === 'error' ? (
                      <p className="text-[0.6rem] text-red-400 break-words whitespace-pre-line">{withInstallerOutput('The install did not finish.', e.error)}</p>
                    ) : e.total > 0 ? (
                      <>
                        <ProgressBar progress={prog} />
                        <p className="text-[0.55rem] text-gray-500 mt-0.5 lu-hud-num">
                          {formatBytes(e.progress)} / {formatBytes(e.total)}
                          {prog > 0 && <span className="ml-1.5 text-blue-400">{Math.round(prog)}%</span>}
                          {e.speed > 0 && <span className="ml-1.5 text-gray-400">{formatBytes(e.speed)}/s</span>}
                        </p>
                      </>
                    ) : (
                      <p className="text-[0.6rem] text-gray-500 truncate">{e.lastLog || 'Preparing…'}</p>
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
