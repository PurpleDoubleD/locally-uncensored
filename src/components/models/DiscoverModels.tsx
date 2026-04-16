import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, RefreshCw, ExternalLink, Search, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { X } from 'lucide-react'
import {
  searchHuggingFaceModels,
  getImageBundles, getVideoBundles,
  getUncensoredTextModels, getMainstreamTextModels,
  detectProviderModelPath, startModelDownloadToPath,
  startModelDownload, searchCivitaiModels,
  installBundleComplete, checkBundlesInstalled,
  type DiscoverModel, type DownloadProgress, type ModelBundle, type CivitAIModelResult,
} from '../../api/discover'
import { getSystemVRAM } from '../../api/comfyui'
import { openExternal } from '../../api/backend'
import { useModels } from '../../hooks/useModels'
import { useDownloadStore } from '../../stores/downloadStore'
import { useProviderStore } from '../../stores/providerStore'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'
import type { ModelCategory } from '../../types/models'
import { proxyImageUrl } from '../../lib/privacy'

interface Props {
  category: ModelCategory
}

function ModelDiscoverCard({ model, index, isText, getModelDownloadState, isModelFullyInstalled, handleDownload }: {
  model: DiscoverModel
  index: number
  isText: boolean
  getModelDownloadState: (m: DiscoverModel) => DownloadProgress | null
  isModelFullyInstalled: (model: DiscoverModel) => boolean
  handleDownload: (m: DiscoverModel) => void
}) {
  const dlState = getModelDownloadState(model)
  const isDownloading = dlState?.status === 'downloading' || dlState?.status === 'connecting'
  const isComplete = dlState?.status === 'complete'
  const isError = dlState?.status === 'error'
  const canDirectDownload = (!!model.downloadUrl && !!model.filename) || !!model.ollamaModel

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
    >
      <GlassCard className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5 flex-wrap">
              {isModelFullyInstalled(model) && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">INSTALLED</span>}
              {model.hot && !isModelFullyInstalled(model) && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-500 font-bold border border-orange-500/30 shrink-0">HOT</span>}
              {model.agent && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">AGENT</span>}
              <span>{model.description || model.name}</span>
            </h3>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">{model.name}</p>
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

            {/* Download progress shown exclusively in DownloadBadge (header) */}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isText && model.canPull === false ? (
              <span className="text-xs text-green-500 px-2 py-1 rounded bg-green-500/10">Available</span>
            ) : isText && canDirectDownload ? (
              /* HuggingFace GGUF: direct download button */
              isComplete ? (
                <span className="flex items-center gap-1 text-xs text-green-500 px-2 py-1">
                  <CheckCircle size={12} /> Downloaded
                </span>
              ) : isDownloading ? (
                <span className="p-2 text-gray-400">
                  <Loader2 size={14} className="animate-spin" />
                </span>
              ) : (
                <button
                  onClick={() => handleDownload(model)}
                  className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                  title={`Download ${model.sizeGB ? model.sizeGB + ' GB' : ''}`}
                >
                  <Download size={14} />
                </button>
              )
            ) : !isText ? (
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
                  <button onClick={() => openExternal(model.url!)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on website">
                    <ExternalLink size={14} />
                  </button>
                )}
              </>
            ) : null}
          </div>
        </div>
      </GlassCard>
    </motion.div>
  )
}

export function DiscoverModels({ category }: Props) {
  const [civitaiResults, setCivitaiResults] = useState<CivitAIModelResult[]>([])
  const [civitaiSearching, setCivitaiSearching] = useState(false)
  const [civitaiQuery, setCivitaiQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [systemVRAM, setSystemVRAM] = useState<number | null>(null)
  const [subTab, setSubTab] = useState<'uncensored' | 'mainstream'>('uncensored')
  const [vramTier, setVramTier] = useState<'all' | 'lightweight' | 'mid' | 'highend'>('all')
  const downloads = useDownloadStore(s => s.downloads)
  const dlStore = useDownloadStore

  // Provider state for model path detection
  const providers = useProviderStore(s => s.providers)
  const [hfModelPath, setHfModelPath] = useState<string | null>(null)
  const { pullModel } = useModels()

  // Auto-detect provider model path for GGUF downloads
  useEffect(() => {
    if (category !== 'text') return
    const providerName = providers.openai?.name || 'LM Studio'
    detectProviderModelPath(providerName).then(path => setHfModelPath(path))
  }, [category])

  // Detect system VRAM
  useEffect(() => {
    getSystemVRAM().then(v => setSystemVRAM(v))
  }, [])

  // Check which bundles are REALLY installed (file size validated, not just file existence)
  const [bundleStatuses, setBundleStatuses] = useState<Record<string, boolean>>({})
  const refreshBundleStatuses = () => {
    if (category !== 'image' && category !== 'video') return
    const allBundles = [...getImageBundles(), ...getVideoBundles()]
    checkBundlesInstalled(allBundles).then(statuses => setBundleStatuses(statuses))
  }
  useEffect(() => {
    refreshBundleStatuses()
  }, [category])

  // Re-check bundle statuses when a download completes
  useEffect(() => {
    const handler = () => refreshBundleStatuses()
    window.addEventListener('comfyui-model-downloaded', handler)
    return () => window.removeEventListener('comfyui-model-downloaded', handler)
  }, [category])

  // Start polling on mount if there are active downloads
  useEffect(() => {
    dlStore.getState().refresh()
  }, [])

  const isText = category === 'text'
  const isImage = category === 'image'
  const isVideo = category === 'video'
  const bundles = isImage ? getImageBundles() : isVideo ? getVideoBundles() : []

  // Parse VRAM requirement string to minimum GB needed
  // "6-8 GB" → 8 (need at least the upper bound)
  // "12+ GB" → 13 (+ means MORE than that number)
  // "8 GB" → 8
  const parseVRAM = (s: string): number => {
    if (s.includes('+')) {
      const match = s.match(/(\d+)\+/)
      return match ? parseInt(match[1]) + 2 : 99 // "12+" means realistically 14+ GB needed
    }
    // Range like "6-8 GB" → take the upper number
    const range = s.match(/(\d+)\s*-\s*(\d+)/)
    if (range) return parseInt(range[2])
    const match = s.match(/(\d+)/)
    return match ? parseInt(match[1]) : 99
  }

  // Sort bundles: verified first, then HOT, then fits VRAM, then by size
  const sortedBundles = [...bundles].sort((a, b) => {
    // Verified models always first
    if (a.verified && !b.verified) return -1
    if (!a.verified && b.verified) return 1
    // HOT models next
    if (a.hot && !b.hot) return -1
    if (!a.hot && b.hot) return 1
    if (systemVRAM) {
      const aFits = parseVRAM(a.vramRequired) <= systemVRAM
      const bFits = parseVRAM(b.vramRequired) <= systemVRAM
      if (aFits && !bFits) return -1
      if (!aFits && bFits) return 1
    }
    return parseVRAM(a.vramRequired) - parseVRAM(b.vramRequired)
  })

  const tabFilteredBundles = sortedBundles.filter(b => subTab === 'uncensored' ? b.uncensored : !b.uncensored)

  // VRAM tier filtering for bundles
  const vramFilteredBundles = tabFilteredBundles.filter(b => {
    if (vramTier === 'all') return true
    const vram = parseVRAM(b.vramRequired)
    if (vramTier === 'lightweight') return vram <= 10
    if (vramTier === 'mid') return vram > 10 && vram <= 16
    return vram > 16 // highend
  })

  const filteredBundles = search
    ? vramFilteredBundles.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()) || b.description.toLowerCase().includes(search.toLowerCase()))
    : vramFilteredBundles

  // GGUF installed check: model is installed if download completed in this session
  const isModelFullyInstalled = (model: DiscoverModel) => {
    if (!model.filename) return false
    return downloads[model.filename]?.status === 'complete'
  }

  const handleDownload = async (model: DiscoverModel) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    dlStore.getState().setMeta(model.filename, model.downloadUrl, model.subfolder)
    await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
    dlStore.getState().startPolling()
  }

  const [installingBundle, setInstallingBundle] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  const handleBundleInstall = async (bundle: ModelBundle) => {
    if (installingBundle === bundle.name) return // Prevent duplicate installs
    setInstallingBundle(bundle.name)
    setInstallError(null)
    const filenames: string[] = []
    for (const file of bundle.files) {
      if (file.downloadUrl && file.filename && file.subfolder) {
        dlStore.getState().setMeta(file.filename, file.downloadUrl, file.subfolder)
        filenames.push(file.filename)
      }
    }
    dlStore.getState().setBundleGroup(bundle.name, filenames)
    // Start polling BEFORE install so progress is tracked immediately
    dlStore.getState().startPolling()
    try {
      await installBundleComplete(bundle)
    } catch (err) {
      console.error('[DiscoverModels] Bundle install failed:', err)
      setInstallError(`${bundle.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Wait for polling to pick up at least one active download before clearing spinner
    // This prevents the "disappearing" UI — spinner stays until downloads are visible
    const waitForDownloads = () => {
      const active = filenames.some(fn => {
        const dl = dlStore.getState().downloads[fn]
        return dl && (dl.status === 'downloading' || dl.status === 'connecting' || dl.status === 'complete')
      })
      if (active) {
        setInstallingBundle(null)
      } else {
        setTimeout(waitForDownloads, 500)
      }
    }
    setTimeout(waitForDownloads, 1000)
  }

  const handleCivitaiSearch = async () => {
    if (!civitaiQuery.trim()) return
    setCivitaiSearching(true)
    const results = await searchCivitaiModels(civitaiQuery, 'Checkpoint')
    setCivitaiResults(results)
    setCivitaiSearching(false)
  }

  const handleCivitaiDownload = async (model: CivitAIModelResult) => {
    if (!model.downloadUrl || !model.filename || !model.subfolder) return
    dlStore.getState().setMeta(model.filename, model.downloadUrl, model.subfolder)
    await startModelDownload(model.downloadUrl, model.subfolder, model.filename)
    dlStore.getState().startPolling()
  }

  const isBundleComplete = (bundle: ModelBundle): boolean => {
    // If any file has error status, bundle is NOT complete
    const hasError = bundle.files.some(f => f.filename && downloads[f.filename]?.status === 'error')
    if (hasError) return false
    // Check 1: Download store says all files complete (current session downloads)
    const dlComplete = bundle.files.every(f => f.filename && downloads[f.filename]?.status === 'complete')
    if (dlComplete) return true
    // Check 2: Disk check says all files are complete (size validated)
    return bundleStatuses[bundle.name] === true
  }

  const isBundleDownloading = (bundle: ModelBundle): boolean => {
    return bundle.files.some(f => f.filename && (downloads[f.filename]?.status === 'downloading' || downloads[f.filename]?.status === 'connecting'))
  }

  const hasBundleErrors = (bundle: ModelBundle): boolean => {
    // Check for explicit error status in download store
    if (bundle.files.some(f => f.filename && downloads[f.filename]?.status === 'error')) return true
    // Also check: some files show complete in store but bundle is NOT fully installed on disk
    // This catches the case where error entries were dismissed but the bundle is still incomplete
    const hasAnyDownloadEntry = bundle.files.some(f => f.filename && downloads[f.filename])
    if (hasAnyDownloadEntry && !bundleStatuses[bundle.name]) {
      const someComplete = bundle.files.some(f => f.filename && downloads[f.filename]?.status === 'complete')
      const allComplete = bundle.files.every(f => f.filename && downloads[f.filename]?.status === 'complete')
      if (someComplete && !allComplete) return true
    }
    return false
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

  // Progress calculation moved to DownloadBadge in Header

  const [hfSearchResults, setHfSearchResults] = useState<DiscoverModel[]>([])

  const handleSearch = async () => {
    if (!search.trim() || !isText) return
    setLoading(true)
    try {
      const results = await searchHuggingFaceModels(search.trim())
      setHfSearchResults(results)
    } catch { /* keep existing */ }
    setLoading(false)
  }

  const uncensoredModels = isText ? getUncensoredTextModels() : []
  const mainstreamModels = isText ? getMainstreamTextModels() : []

  const filteredUncensored = search
    ? uncensoredModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
    : uncensoredModels
  const filteredMainstream = search
    ? mainstreamModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
    : mainstreamModels

  const title = 'Discover LUncensored'
  const subtitle = isText
    ? `Download GGUF models from HuggingFace.${hfModelPath ? ` Saves to: ${hfModelPath}` : ''}`
    : isImage
      ? 'Browse image generation models for ComfyUI.'
      : 'Browse video generation models for ComfyUI.'

  const handleRefresh = () => {
    setLoading(true)
    setHfSearchResults([])
    const providerName = providers.openai?.name || 'LM Studio'
    detectProviderModelPath(providerName).then(path => { setHfModelPath(path); setLoading(false) })
  }

  const handleTextDownload = async (model: DiscoverModel) => {
    // Ollama-native models: use ollama pull instead of GGUF download
    if (model.ollamaModel) {
      try {
        await pullModel(model.ollamaModel)
      } catch (e) {
        console.error('Ollama pull failed:', e)
        setInstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    if (!model.downloadUrl || !model.filename) return
    const destDir = hfModelPath || (await detectProviderModelPath(providers.openai?.name || 'LM Studio'))
    if (!destDir) {
      setInstallError('Could not determine model directory. Please check app permissions.')
      return
    }
    setHfModelPath(destDir)
    try {
      dlStore.getState().setMeta(model.filename, model.downloadUrl, 'gguf', destDir)
      const expectedBytes = model.sizeGB ? Math.round(model.sizeGB * 1_073_741_824) : undefined
      await startModelDownloadToPath(model.downloadUrl, destDir, model.filename, expectedBytes)
      dlStore.getState().startPolling()
    } catch (e) {
      console.error('GGUF download failed:', e)
      setInstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="space-y-4 scale-[0.87] origin-top-left w-[115%]">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        {isText && (
          <GlowButton variant="secondary" onClick={handleRefresh} disabled={loading} aria-label="Refresh">
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
          onKeyDown={(e) => { if (e.key === 'Enter' && isText) handleSearch() }}
          placeholder={isText ? 'Search HuggingFace GGUF models... (Enter to search)' : 'Filter models...'}
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/30"
        />
      </div>

      {/* All download progress is shown exclusively in the DownloadBadge (header) */}

      {!isText && (
        <p className="text-[0.65rem] text-gray-500">
          Downloads install directly into ComfyUI. Requires ComfyUI path configured in Model Manager.
        </p>
      )}

      {/* Sub-tabs: Uncensored / Mainstream — for all text sources and image/video */}
      {(isText || isImage || isVideo) && (
        <div className="flex gap-4 mb-4">
          <button
            onClick={() => setSubTab('uncensored')}
            className={`flex items-center gap-2 transition-all ${
              subTab === 'uncensored' ? 'opacity-100' : 'opacity-40 hover:opacity-70'
            }`}
          >
            <div className={`w-1 h-5 rounded-full ${subTab === 'uncensored' ? 'bg-red-500' : 'bg-red-500/50'}`} />
            <span className="text-[0.75rem] font-semibold text-gray-900 dark:text-white uppercase tracking-wider">Uncensored</span>
            <span className="text-[0.55rem] text-gray-500">{isText ? 'No filters, no limits' : 'No content filter'}</span>
          </button>
          <button
            onClick={() => setSubTab('mainstream')}
            className={`flex items-center gap-2 transition-all ${
              subTab === 'mainstream' ? 'opacity-100' : 'opacity-40 hover:opacity-70'
            }`}
          >
            <div className={`w-1 h-5 rounded-full ${subTab === 'mainstream' ? 'bg-blue-500' : 'bg-blue-500/50'}`} />
            <span className="text-[0.75rem] font-semibold text-gray-900 dark:text-white uppercase tracking-wider">Mainstream</span>
            <span className="text-[0.55rem] text-gray-500">{isText ? 'Tool calling + vision' : 'Popular + high quality'}</span>
          </button>
        </div>
      )}

      {/* VRAM Tier Filter — for image/video bundles */}
      {(isImage || isVideo) && sortedBundles.length > 0 && (
        <div className="flex gap-1.5">
          {([
            { key: 'all', label: 'All', desc: '' },
            { key: 'lightweight', label: 'Lightweight', desc: '6-10 GB' },
            { key: 'mid', label: 'Mid-Range', desc: '12-16 GB' },
            { key: 'highend', label: 'High-End', desc: '20+ GB' },
          ] as const).map(tier => (
            <button
              key={tier.key}
              onClick={() => setVramTier(tier.key)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-all ${
                vramTier === tier.key
                  ? 'bg-white/15 text-white border border-white/20'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              {tier.label}
              {tier.desc && <span className="text-[9px] text-gray-500 ml-1">{tier.desc}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Install error banner */}
      {installError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <XCircle size={16} className="shrink-0" />
          <span className="flex-1">{installError}</span>
          <button onClick={() => setInstallError(null)} className="text-red-400 hover:text-red-300 shrink-0">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Model Bundles (Image + Video) — same grid style as text models */}
      {(isImage || isVideo) && filteredBundles.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredBundles.map((bundle, bi) => {
            const complete = isBundleComplete(bundle)
            const downloading = isBundleDownloading(bundle) || installingBundle === bundle.name
            const bundleProgress = getBundleProgress(bundle)
            const isComingSoon = !bundle.verified && !complete

            return (
              <motion.div key={bundle.name} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: bi * 0.03 }}>
                <GlassCard className={`p-3 relative overflow-hidden ${isComingSoon ? 'opacity-50' : ''}`}>
                  {isComingSoon && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 backdrop-blur-[1px] rounded-xl">
                      <span className="px-3 py-1.5 rounded-full bg-white/10 border border-white/20 text-white text-xs font-semibold tracking-wider">
                        COMING SOON
                      </span>
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-medium text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                        {complete && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-bold border border-green-500/30 shrink-0">INSTALLED</span>}
                        {bundle.hot && !complete && <span className="text-[0.55rem] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-500 font-bold border border-orange-500/30 shrink-0">HOT</span>}
                        <span className="truncate">{bundle.name}</span>
                      </h3>
                      {bundle.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{bundle.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {bundle.tags.map(t => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-400">{t}</span>
                        ))}
                        {bundle.totalSizeGB && (
                          <span className="text-[10px] text-gray-400">{bundle.totalSizeGB} GB</span>
                        )}
                        <span className="text-[10px] text-gray-400">{bundle.files.length} files</span>
                        {systemVRAM && parseVRAM(bundle.vramRequired) <= systemVRAM && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">Fits GPU</span>
                        )}
                      </div>

                      {/* Progress shown exclusively in DownloadBadge (header) */}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {complete ? null : downloading ? (
                        <span className="p-2 text-gray-400">
                          <Loader2 size={14} className="animate-spin" />
                        </span>
                      ) : hasBundleErrors(bundle) ? (
                        <button
                          onClick={() => {
                            // Retry only the files that are NOT complete
                            for (const f of bundle.files) {
                              if (!f.filename || !f.downloadUrl || !f.subfolder) continue
                              const dl = downloads[f.filename]
                              // Retry if: explicit error, OR no download entry and not on disk
                              if (dl?.status === 'error') {
                                dlStore.getState().retry(f.filename)
                              } else if (!dl || (dl.status !== 'complete' && dl.status !== 'downloading' && dl.status !== 'connecting')) {
                                // File has no active download — start fresh
                                dlStore.getState().setMeta(f.filename, f.downloadUrl, f.subfolder)
                                startModelDownload(f.downloadUrl, f.subfolder, f.filename, f.sizeGB ? Math.round(f.sizeGB * 1_073_741_824) : undefined)
                                dlStore.getState().startPolling()
                              }
                            }
                          }}
                          className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-red-100 dark:bg-red-500/15 hover:bg-red-200 dark:hover:bg-red-500/25 text-red-700 dark:text-red-400 transition-all text-xs"
                          title="Retry failed downloads"
                        >
                          <RefreshCw size={12} />
                          <span>Retry</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => handleBundleInstall(bundle)}
                          className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all"
                          title={`Install all ${bundle.files.length} files (${bundle.totalSizeGB} GB)`}
                        >
                          <Download size={14} />
                        </button>
                      )}
                      {bundle.url && (
                        <button onClick={() => openExternal(bundle.url!)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on HuggingFace">
                          <ExternalLink size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </GlassCard>
              </motion.div>
            )
          })}
        </div>
      )}

      {(isImage || isVideo) && sortedBundles.length > 0 && filteredBundles.length === 0 && (
        <p className="text-center text-gray-500 py-4 text-sm">No models match this VRAM tier. Try a different filter.</p>
      )}

      {/* CivitAI Search (Image & Video) */}
      {(isImage || isVideo) && (
        <GlassCard className="p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Search CivitAI</h3>
          <div className="flex gap-2">
            <input
              value={civitaiQuery}
              onChange={(e) => setCivitaiQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCivitaiSearch()}
              placeholder="e.g. flux, sdxl realistic, anime..."
              className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:border-gray-400 dark:focus:border-white/20"
            />
            <button
              onClick={handleCivitaiSearch}
              disabled={civitaiSearching || !civitaiQuery.trim()}
              className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 disabled:opacity-50 text-gray-700 dark:text-white transition-colors"
            >
              {civitaiSearching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </div>

          {civitaiResults.length > 0 && (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {civitaiResults.map((model) => {
                const dlState = model.filename ? downloads[model.filename] : null
                const isDl = dlState?.status === 'downloading' || dlState?.status === 'connecting'
                const isDone = dlState?.status === 'complete'

                return (
                  <div key={model.id} className="flex gap-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
                    {model.thumbnailUrl && (
                      <img src={proxyImageUrl(model.thumbnailUrl)} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" loading="lazy" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">{model.name}</span>
                        {model.sizeGB && <span className="text-[10px] text-gray-400 flex-shrink-0">{model.sizeGB} GB</span>}
                      </div>
                      {model.description && <p className="text-[11px] text-gray-500 line-clamp-1 mt-0.5">{model.description}</p>}
                      {isDl && dlState && dlState.total > 0 && (
                        <div className="mt-1.5">
                          <ProgressBar progress={(dlState.progress / dlState.total) * 100} />
                          <span className="text-[10px] text-gray-400">{formatBytes(dlState.progress)} / {formatBytes(dlState.total)}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isDone ? (
                        <CheckCircle size={16} className="text-green-500" />
                      ) : isDl ? (
                        <Loader2 size={16} className="animate-spin text-gray-400" />
                      ) : model.downloadUrl ? (
                        <button onClick={() => handleCivitaiDownload(model)} className="p-2 rounded-lg bg-green-100 dark:bg-green-500/15 hover:bg-green-200 dark:hover:bg-green-500/25 text-green-700 dark:text-green-400 transition-all" title="Download" aria-label="Download">
                          <Download size={14} />
                        </button>
                      ) : null}
                      <button onClick={() => openExternal(model.sourceUrl)} className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 text-gray-500 transition-all" title="View on CivitAI" aria-label="View on CivitAI">
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {civitaiSearching && <div className="text-center py-4 text-gray-500 text-sm">Searching CivitAI...</div>}
        </GlassCard>
      )}

      {/* GGUF model path info */}
      {isText && hfModelPath && (
        <p className="text-[0.65rem] text-gray-500 truncate">
          Downloads save to: {hfModelPath}
        </p>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading models...</div>
      ) : isText ? (
        <>
          {subTab === 'uncensored' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredUncensored.map((model, i) => (
                <ModelDiscoverCard key={model.name} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} isModelFullyInstalled={isModelFullyInstalled} handleDownload={handleTextDownload} />
              ))}
              {filteredUncensored.length === 0 && (
                <p className="text-center text-gray-500 py-4 col-span-2">No uncensored models match your search</p>
              )}
            </div>
          )}
          {subTab === 'mainstream' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredMainstream.map((model, i) => (
                <ModelDiscoverCard key={model.name} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} isModelFullyInstalled={isModelFullyInstalled} handleDownload={handleTextDownload} />
              ))}
              {filteredMainstream.length === 0 && (
                <p className="text-center text-gray-500 py-4 col-span-2">No mainstream models match your search</p>
              )}
            </div>
          )}

          {/* HuggingFace Search Results */}
          {hfSearchResults.length > 0 && (
            <div className="space-y-3 mt-6">
              <h3 className="text-[0.7rem] font-semibold text-gray-500 uppercase tracking-wider">HuggingFace Search Results</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {hfSearchResults.map((model, i) => (
                  <ModelDiscoverCard key={model.name + i} model={model} index={i} isText={isText} getModelDownloadState={getModelDownloadState} isModelFullyInstalled={isModelFullyInstalled} handleDownload={handleTextDownload} />
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}

      {!loading && filteredBundles.length === 0 && filteredUncensored.length === 0 && filteredMainstream.length === 0 && (
        <p className="text-center text-gray-500 py-4">No models found</p>
      )}
    </div>
  )
}
