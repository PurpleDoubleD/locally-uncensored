import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Download, RefreshCw, ExternalLink, Search, Info, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import {
  fetchAbliteratedModels, getImageModelsDiscover, getVideoBundles,
  startModelDownload, getDownloadProgress,
  type DiscoverModel, type DownloadProgress, type ModelBundle,
} from '../../api/discover'
import { useModels } from '../../hooks/useModels'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'
import type { ModelCategory } from '../../types/models'

interface Props {
  category: ModelCategory
}

export function DiscoverModels({ category }: Props) {
  const [textModels, setTextModels] = useState<DiscoverModel[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({})
  const { pullModel, isPulling, pullProgress, models: installedModels } = useModels()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Load text models from Ollama search
  useEffect(() => {
    if (category === 'text') {
      setLoading(true)
      fetchAbliteratedModels().then(m => { setTextModels(m); setLoading(false) })
    }
  }, [category])

  // Poll download progress
  useEffect(() => {
    const hasActive = Object.values(downloads).some(d => d.status === 'downloading' || d.status === 'connecting')
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const prog = await getDownloadProgress()
        setDownloads(prog)
        const stillActive = Object.values(prog).some(d => d.status === 'downloading' || d.status === 'connecting')
        if (!stillActive && pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, 1000)
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [downloads])

  const isText = category === 'text'
  const isImage = category === 'image'
  const isVideo = category === 'video'
  const allModels = isText ? textModels : isImage ? getImageModelsDiscover() : []
  const videoBundles = isVideo ? getVideoBundles() : []

  const filtered = search
    ? allModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
    : allModels

  const filteredBundles = search
    ? videoBundles.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()) || b.description.toLowerCase().includes(search.toLowerCase()))
    : videoBundles

  const isInstalled = (name: string) => installedModels.some((m) => m.name.startsWith(name.split(':')[0]))

  const handleDownload = async (model: DiscoverModel) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    const result = await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
    if (result.status === 'started' || result.status === 'already_exists') {
      const prog = await getDownloadProgress()
      setDownloads(prog)
    }
  }

  const handleBundleInstall = async (bundle: ModelBundle) => {
    for (const file of bundle.files) {
      if (file.downloadUrl && file.filename && file.subfolder) {
        await startModelDownload(file.downloadUrl, file.subfolder, file.filename)
      }
    }
    const prog = await getDownloadProgress()
    setDownloads(prog)
  }

  const isBundleComplete = (bundle: ModelBundle): boolean => {
    return bundle.files.every(f => f.filename && downloads[f.filename]?.status === 'complete')
  }

  const isBundleDownloading = (bundle: ModelBundle): boolean => {
    return bundle.files.some(f => f.filename && (downloads[f.filename]?.status === 'downloading' || downloads[f.filename]?.status === 'connecting'))
  }

  const getBundleProgress = (bundle: ModelBundle): number => {
    let totalBytes = 0, downloadedBytes = 0
    for (const f of bundle.files) {
      if (f.filename && downloads[f.filename]) {
        totalBytes += downloads[f.filename].total
        downloadedBytes += downloads[f.filename].progress
      }
    }
    return totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0
  }

  const getModelDownloadState = (model: DiscoverModel): DownloadProgress | null => {
    if (!model.filename) return null
    return downloads[model.filename] ?? null
  }

  const progress = pullProgress?.total && pullProgress?.completed
    ? (pullProgress.completed / pullProgress.total) * 100
    : 0

  const title = isText ? 'Uncensored Text Models' : isImage ? 'Image Models (ComfyUI)' : 'Video Models (ComfyUI)'
  const subtitle = isText
    ? 'Abliterated models from the Ollama registry. Click to install.'
    : isImage
      ? 'Download checkpoints directly into your ComfyUI models folder.'
      : 'Download video models directly into your ComfyUI models folder.'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        {isText && (
          <GlowButton variant="secondary" onClick={() => { setLoading(true); fetchAbliteratedModels().then(m => { setTextModels(m); setLoading(false) }) }} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </GlowButton>
        )}
      </div>

      <p className="text-sm text-gray-500">{subtitle}</p>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter models..."
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/30"
        />
      </div>

      {/* Active downloads summary */}
      {Object.values(downloads).some(d => d.status === 'downloading' || d.status === 'connecting') && (
        <GlassCard className="p-3 space-y-2">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Active Downloads
          </h3>
          {Object.entries(downloads).filter(([, d]) => d.status === 'downloading' || d.status === 'connecting').map(([id, d]) => (
            <div key={id} className="space-y-1">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span className="truncate">{d.filename}</span>
                <span>
                  {d.total > 0 ? `${formatBytes(d.progress)} / ${formatBytes(d.total)}` : 'Connecting...'}
                  {d.speed > 0 && ` · ${formatBytes(d.speed)}/s`}
                </span>
              </div>
              {d.total > 0 && <ProgressBar progress={(d.progress / d.total) * 100} />}
            </div>
          ))}
        </GlassCard>
      )}

      {/* Ollama pull progress */}
      {isText && isPulling && pullProgress && (
        <GlassCard className="p-3">
          <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">{pullProgress.status}</p>
          {pullProgress.total && pullProgress.completed !== undefined && (
            <>
              <ProgressBar progress={progress} />
              <p className="text-xs text-gray-500 mt-1">
                {formatBytes(pullProgress.completed || 0)} / {formatBytes(pullProgress.total)}
              </p>
            </>
          )}
        </GlassCard>
      )}

      {!isText && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-400 text-xs">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            Models with a download button will be installed directly into ComfyUI. Models without need to be downloaded manually from the link.
          </span>
        </div>
      )}

      {/* Video Bundles */}
      {isVideo && filteredBundles.length > 0 && (
        <div className="space-y-4">
          {filteredBundles.map((bundle, bi) => {
            const complete = isBundleComplete(bundle)
            const downloading = isBundleDownloading(bundle)
            const bundleProgress = getBundleProgress(bundle)

            return (
              <motion.div key={bundle.name} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: bi * 0.05 }}>
                <GlassCard className="p-4">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{bundle.name}</h3>
                      <p className="text-xs text-gray-500 mt-0.5">{bundle.description}</p>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {bundle.tags.map(t => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">{t}</span>
                        ))}
                        <span className="text-[10px] text-gray-400">Total: {bundle.totalSizeGB} GB</span>
                        <span className="text-[10px] text-orange-500">Requires {bundle.vramRequired} VRAM</span>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {complete ? (
                        <span className="flex items-center gap-1 text-xs text-green-500 px-3 py-1.5 rounded-lg bg-green-50 dark:bg-green-500/10">
                          <CheckCircle size={14} /> Ready
                        </span>
                      ) : downloading ? (
                        <span className="flex items-center gap-1 text-xs text-blue-500 px-3 py-1.5">
                          <Loader2 size={14} className="animate-spin" /> Installing...
                        </span>
                      ) : (
                        <button
                          onClick={() => handleBundleInstall(bundle)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-medium transition-colors"
                        >
                          <Download size={14} /> Install All ({bundle.totalSizeGB} GB)
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Bundle progress */}
                  {downloading && (
                    <div className="mb-3">
                      <ProgressBar progress={bundleProgress} />
                      <p className="text-[10px] text-gray-400 mt-1">{Math.round(bundleProgress)}% complete</p>
                    </div>
                  )}

                  {/* Individual files */}
                  <div className="space-y-2 border-t border-gray-200 dark:border-white/5 pt-3">
                    <p className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">Included files ({bundle.files.length})</p>
                    {bundle.files.map((file) => {
                      const dlState = file.filename ? downloads[file.filename] : null
                      const fileDl = dlState?.status === 'downloading' || dlState?.status === 'connecting'
                      const fileDone = dlState?.status === 'complete'
                      const fileErr = dlState?.status === 'error'

                      return (
                        <div key={file.filename} className="flex items-center justify-between gap-2 py-1">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{file.name}</span>
                              {file.sizeGB && <span className="text-[10px] text-gray-400 shrink-0">{file.sizeGB} GB</span>}
                            </div>
                            {fileDl && dlState && dlState.total > 0 && (
                              <div className="mt-1">
                                <ProgressBar progress={(dlState.progress / dlState.total) * 100} />
                                <span className="text-[10px] text-gray-400">{formatBytes(dlState.progress)} / {formatBytes(dlState.total)}{dlState.speed > 0 ? ` · ${formatBytes(dlState.speed)}/s` : ''}</span>
                              </div>
                            )}
                            {fileErr && <span className="text-[10px] text-red-500">Failed: {dlState?.error}</span>}
                          </div>
                          <div className="shrink-0">
                            {fileDone ? (
                              <CheckCircle size={14} className="text-green-500" />
                            ) : fileDl ? (
                              <Loader2 size={14} className="animate-spin text-blue-400" />
                            ) : (
                              <button onClick={() => handleDownload(file)} className="p-1 rounded text-gray-400 hover:text-green-500 transition-colors" title="Download this file">
                                <Download size={14} />
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {bundle.url && (
                    <a href={bundle.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-2 transition-colors">
                      <ExternalLink size={10} /> View on HuggingFace
                    </a>
                  )}
                </GlassCard>
              </motion.div>
            )
          })}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading models...</div>
      ) : !isVideo && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((model, i) => {
            const dlState = getModelDownloadState(model)
            const isDownloading = dlState?.status === 'downloading' || dlState?.status === 'connecting'
            const isComplete = dlState?.status === 'complete'
            const isError = dlState?.status === 'error'
            const canDirectDownload = !!model.downloadUrl && !!model.filename && !!model.subfolder

            return (
              <motion.div
                key={model.name}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
              >
                <GlassCard className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate">{model.name}</h3>
                      {model.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{model.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {model.tags.map((tag) => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">
                            {tag}
                          </span>
                        ))}
                        {model.sizeGB && (
                          <span className="text-[10px] text-gray-400">{model.sizeGB} GB</span>
                        )}
                        {model.pulls && (
                          <span className="text-[10px] text-gray-500">{model.pulls}</span>
                        )}
                      </div>

                      {/* Download progress inline */}
                      {isDownloading && dlState && (
                        <div className="mt-2 space-y-1">
                          <ProgressBar progress={dlState.total > 0 ? (dlState.progress / dlState.total) * 100 : 0} />
                          <div className="flex items-center justify-between text-[10px] text-gray-400">
                            <span>{dlState.total > 0 ? `${formatBytes(dlState.progress)} / ${formatBytes(dlState.total)}` : 'Connecting...'}</span>
                            {dlState.speed > 0 && <span>{formatBytes(dlState.speed)}/s</span>}
                          </div>
                        </div>
                      )}
                      {isError && dlState && (
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-red-500">
                          <XCircle size={10} /> {dlState.error || 'Download failed'}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {isText ? (
                        // Ollama: direct install
                        isInstalled(model.name) ? (
                          <span className="text-xs text-green-500 px-2 py-1">Installed</span>
                        ) : (
                          <button
                            onClick={() => pullModel(model.name)}
                            disabled={isPulling}
                            className="p-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 text-gray-700 dark:text-white disabled:opacity-30 transition-all"
                            title="Install model"
                          >
                            <Download size={14} />
                          </button>
                        )
                      ) : (
                        // ComfyUI models
                        <>
                          {isComplete ? (
                            <span className="flex items-center gap-1 text-xs text-green-500 px-2 py-1">
                              <CheckCircle size={12} /> Installed
                            </span>
                          ) : isDownloading ? (
                            <span className="p-2 text-gray-400">
                              <Loader2 size={14} className="animate-spin" />
                            </span>
                          ) : canDirectDownload ? (
                            <button
                              onClick={() => handleDownload(model)}
                              className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                              title={`Download ${model.sizeGB ? model.sizeGB + ' GB' : ''} to ComfyUI`}
                            >
                              <Download size={14} />
                            </button>
                          ) : null}
                          {model.url && (
                            <a
                              href={model.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all"
                              title="View on website"
                            >
                              <ExternalLink size={14} />
                            </a>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </GlassCard>
              </motion.div>
            )
          })}
        </div>
      )}

      {!loading && filtered.length === 0 && filteredBundles.length === 0 && (
        <p className="text-center text-gray-500 py-4">No models found</p>
      )}
    </div>
  )
}
