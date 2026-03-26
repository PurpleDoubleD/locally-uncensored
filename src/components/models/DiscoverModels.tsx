import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, RefreshCw, ExternalLink, Search, Info } from 'lucide-react'
import { fetchAbliteratedModels, type DiscoverModel } from '../../api/discover'
import { useModels } from '../../hooks/useModels'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'
import { formatBytes } from '../../lib/formatters'
import type { ModelCategory } from '../../types/models'

interface Props {
  category: ModelCategory
}

// Curated image model recommendations (ComfyUI checkpoints from CivitAI / HuggingFace)
const IMAGE_MODELS: DiscoverModel[] = [
  { name: 'Juggernaut XL V9', description: 'Best photorealistic SDXL checkpoint. Download from CivitAI and place in ComfyUI models/checkpoints/', pulls: 'Top Rated', tags: ['SDXL', '6.5 GB', 'Photorealistic'], updated: 'civitai.com', url: 'https://civitai.com/models/133005/juggernaut-xl' },
  { name: 'RealVisXL V5', description: 'Photorealistic SDXL model. Great for portraits and landscapes.', pulls: 'Popular', tags: ['SDXL', '6.5 GB', 'Photorealistic'], updated: 'civitai.com', url: 'https://civitai.com/models/139562/realvisxl' },
  { name: 'Pony Diffusion V6 XL', description: 'Anime/stylized art. Huge LoRA ecosystem on CivitAI.', pulls: 'Top Rated', tags: ['SDXL', '6.5 GB', 'Anime'], updated: 'civitai.com', url: 'https://civitai.com/models/257749/pony-diffusion-v6-xl' },
  { name: 'FLUX.1 [schnell]', description: 'Fast FLUX variant. 1-4 step generation. Place in models/diffusion_models/', pulls: 'State-of-art', tags: ['FLUX', '12 GB', 'Fast'], updated: 'huggingface.co', url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell' },
  { name: 'FLUX.1 [dev]', description: 'High quality FLUX. Needs FP8 quantization for 12GB VRAM.', pulls: 'State-of-art', tags: ['FLUX', '12B', 'Quality'], updated: 'huggingface.co', url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev' },
  { name: 'epiCRealism XL', description: 'Uncensored photorealistic SDXL checkpoint.', pulls: 'Popular', tags: ['SDXL', '6.5 GB', 'Uncensored'], updated: 'civitai.com', url: 'https://civitai.com/models/277058/epicrealism-xl' },
]

// Curated video model recommendations
const VIDEO_MODELS: DiscoverModel[] = [
  { name: 'Wan 2.1 T2V 1.3B', description: 'Lightweight text-to-video. Place in ComfyUI models/diffusion_models/', pulls: '8-10 GB VRAM', tags: ['Wan', '1.3B', '480p'], updated: 'huggingface.co', url: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B' },
  { name: 'Wan 2.1 T2V 14B', description: 'High quality text-to-video. Use FP8 quantization for 12GB GPUs.', pulls: '10-12 GB VRAM', tags: ['Wan', '14B', '720p'], updated: 'huggingface.co', url: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-14B' },
  { name: 'Hunyuan Video', description: 'Tencent video generation model. Compatible with Wan workflow.', pulls: '12+ GB VRAM', tags: ['Hunyuan', '13B', '720p'], updated: 'huggingface.co', url: 'https://huggingface.co/tencent/HunyuanVideo' },
  { name: 'AnimateDiff v3', description: 'Motion model for SD 1.5 checkpoints. Install via ComfyUI Manager.', pulls: '6-8 GB VRAM', tags: ['AnimateDiff', 'SD1.5', 'MP4'], updated: 'github.com', url: 'https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved' },
  { name: 'CogVideoX-5B', description: 'Text-to-video model from Tsinghua. Works with ComfyUI.', pulls: '12 GB VRAM', tags: ['CogVideo', '5B', '720p'], updated: 'huggingface.co', url: 'https://huggingface.co/THUDM/CogVideoX-5b' },
]

export function DiscoverModels({ category }: Props) {
  const [textModels, setTextModels] = useState<DiscoverModel[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const { pullModel, isPulling, pullProgress, models: installedModels } = useModels()

  // Load text models from Ollama search
  useEffect(() => {
    if (category === 'text') {
      setLoading(true)
      fetchAbliteratedModels().then(m => { setTextModels(m); setLoading(false) })
    }
  }, [category])

  const isText = category === 'text'
  const isImage = category === 'image'
  const isVideo = category === 'video'

  const allModels = isText ? textModels : isImage ? IMAGE_MODELS : VIDEO_MODELS

  const filtered = search
    ? allModels.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.description.toLowerCase().includes(search.toLowerCase()))
    : allModels

  const isInstalled = (name: string) => {
    return installedModels.some((m) => m.name.startsWith(name.split(':')[0]))
  }

  const progress =
    pullProgress?.total && pullProgress?.completed
      ? (pullProgress.completed / pullProgress.total) * 100
      : 0

  const title = isText ? 'Uncensored Text Models' : isImage ? 'Image Models (ComfyUI)' : 'Video Models (ComfyUI)'
  const subtitle = isText
    ? 'Abliterated models from the Ollama registry. Click to install.'
    : isImage
      ? 'Download these checkpoints and place them in your ComfyUI models folder.'
      : 'Download these models and place them in your ComfyUI models/diffusion_models folder.'

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

      {/* Pull progress (text models only) */}
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

      {/* Info box for Image/Video */}
      {!isText && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 text-blue-700 dark:text-blue-400 text-xs">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span>
            {isImage
              ? 'Image models are not installed through this app. Download them from the links below and place .safetensors files in your ComfyUI models/checkpoints/ or models/diffusion_models/ folder.'
              : 'Video models are not installed through this app. Download them from the links below and place them in your ComfyUI models/diffusion_models/ folder. Restart the app or click Refresh in the Create tab.'}
          </span>
        </div>
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
                      {model.pulls && (
                        <span className="text-[10px] text-gray-500">{model.pulls}</span>
                      )}
                      {model.updated && (
                        <span className="text-[10px] text-gray-400">{model.updated}</span>
                      )}
                    </div>
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
                      // Image/Video: link to download
                      <a
                        href={model.url || `https://huggingface.co/models?search=${encodeURIComponent(model.name)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/15 text-gray-700 dark:text-white transition-all"
                        title="Download from source"
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
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
