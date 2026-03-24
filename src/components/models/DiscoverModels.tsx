import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, RefreshCw, ExternalLink, Search } from 'lucide-react'
import { fetchAbliteratedModels, type DiscoverModel } from '../../api/discover'
import { useModels } from '../../hooks/useModels'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'

export function DiscoverModels() {
  const [models, setModels] = useState<DiscoverModel[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const { pullModel, isPulling, pullProgress, models: installedModels } = useModels()

  const loadModels = async () => {
    setLoading(true)
    const result = await fetchAbliteratedModels()
    setModels(result)
    setLoading(false)
  }

  useEffect(() => {
    loadModels()
  }, [])

  const filtered = search
    ? models.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()))
    : models

  const isInstalled = (name: string) => {
    return installedModels.some((m) => m.name.startsWith(name.split(':')[0]))
  }

  const progress =
    pullProgress?.total && pullProgress?.completed
      ? (pullProgress.completed / pullProgress.total) * 100
      : 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Discover Uncensored Models</h2>
        <GlowButton variant="secondary" onClick={loadModels} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </GlowButton>
      </div>

      <p className="text-sm text-gray-500">
        Latest abliterated (uncensored) models from the Ollama registry. Click to install.
      </p>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter models..."
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-white/30"
        />
      </div>

      {isPulling && pullProgress && (
        <GlassCard className="p-3">
          <p className="text-sm text-gray-300 mb-2">{pullProgress.status}</p>
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

      {loading ? (
        <div className="text-center py-8 text-gray-500">Loading models...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((model, i) => (
            <motion.div
              key={model.name}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
            >
              <GlassCard className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-white truncate">{model.name}</h3>
                    {model.description && (
                      <p className="text-xs text-gray-500 mt-0.5">{model.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {model.tags.map((tag) => (
                        <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">
                          {tag}
                        </span>
                      ))}
                      {model.pulls && (
                        <span className="text-[10px] text-gray-500">{model.pulls} pulls</span>
                      )}
                      {model.updated && (
                        <span className="text-[10px] text-gray-600">{model.updated}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {isInstalled(model.name) ? (
                      <span className="text-xs text-green-400 px-2 py-1">Installed</span>
                    ) : (
                      <button
                        onClick={() => pullModel(model.name)}
                        disabled={isPulling}
                        className="p-2 rounded-lg bg-white/10 hover:bg-white/15 text-white disabled:opacity-30 transition-all"
                        title="Install model"
                      >
                        <Download size={14} />
                      </button>
                    )}
                    <a
                      href={`https://ollama.com/${model.name}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg hover:bg-white/10 text-gray-500 transition-all"
                      title="View on Ollama"
                    >
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </div>
              </GlassCard>
            </motion.div>
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <p className="text-center text-gray-500 py-4">No models found</p>
      )}
    </div>
  )
}
