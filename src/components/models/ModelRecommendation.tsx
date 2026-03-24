import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, Download, X, Zap, Brain, Image, Video } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { GlassCard } from '../ui/GlassCard'
import { GlowButton } from '../ui/GlowButton'
import { ProgressBar } from '../ui/ProgressBar'

interface SystemInfo {
  vram: number | null
  ram: number | null
  gpu: string | null
}

interface Recommendation {
  name: string
  pullName: string
  description: string
  vramNeeded: string
  category: 'text' | 'image' | 'video'
  icon: typeof Brain
}

function getRecommendations(sys: SystemInfo): Recommendation[] {
  const vram = sys.vram || 0
  const recs: Recommendation[] = []

  // Text models
  if (vram >= 10) {
    recs.push({
      name: 'Mistral Nemo 12B (Uncensored)',
      pullName: 'krith/mistral-nemo-instruct-2407-abliterated:IQ4_XS',
      description: 'Very smart, uncensored, fits your GPU',
      vramNeeded: '~7 GB VRAM',
      category: 'text',
      icon: Brain,
    })
  }
  if (vram >= 6) {
    recs.push({
      name: 'Llama 3.1 8B (Uncensored)',
      pullName: 'mannix/llama3.1-8b-abliterated:q5_K_M',
      description: 'Fast & uncensored, ideal to get started',
      vramNeeded: '~5.5 GB VRAM',
      category: 'text',
      icon: Zap,
    })
  }
  if (vram >= 8) {
    recs.push({
      name: 'DeepSeek R1 8B (Uncensored)',
      pullName: 'huihui_ai/deepseek-r1-abliterated:8b',
      description: 'Thinks before it answers, uncensored',
      vramNeeded: '~6 GB VRAM',
      category: 'text',
      icon: Brain,
    })
  }

  // Image models (ComfyUI)
  if (vram >= 8) {
    recs.push({
      name: 'SDXL / Juggernaut XL',
      pullName: '',
      description: 'Photorealistic, uncensored. Install in ComfyUI.',
      vramNeeded: '~8 GB VRAM',
      category: 'image',
      icon: Image,
    })
  }

  // Video models
  if (vram >= 10) {
    recs.push({
      name: 'Wan2.2 1.3B (Video)',
      pullName: '',
      description: 'Text-to-Video, 480p. Install in ComfyUI.',
      vramNeeded: '~8-10 GB VRAM',
      category: 'video',
      icon: Video,
    })
  }

  return recs
}

export function ModelRecommendation() {
  const { models, pullModel, isPulling, pullProgress } = useModels()
  const [dismissed, setDismissed] = useState(false)
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({ vram: null, ram: null, gpu: null })
  const [loading, setLoading] = useState(true)

  // Check if we should show this at all
  const hasTextModels = models.some((m) => m.type === 'text')

  useEffect(() => {
    // Try to detect system info via Ollama's ps endpoint
    async function detectSystem() {
      try {
        // We'll use a simple heuristic based on known GPU info
        // Since we can't directly query GPU from browser, use stored info or defaults
        const stored = localStorage.getItem('system-info')
        if (stored) {
          setSystemInfo(JSON.parse(stored))
        } else {
          // Default: assume 8GB VRAM (most common consumer GPU)
          const info: SystemInfo = { vram: 8, ram: 16, gpu: null }
          setSystemInfo(info)
        }
      } catch {
        setSystemInfo({ vram: 8, ram: 16, gpu: null })
      }
      setLoading(false)
    }
    detectSystem()
  }, [])

  if (loading || dismissed || hasTextModels) return null

  const recommendations = getRecommendations(systemInfo)
  const textRecs = recommendations.filter((r) => r.category === 'text')

  const progress = pullProgress?.total && pullProgress?.completed
    ? (pullProgress.completed / pullProgress.total) * 100
    : 0

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="max-w-2xl mx-auto p-6"
      >
        <GlassCard className="p-6 relative">
          <button
            onClick={() => setDismissed(true)}
            className="absolute top-3 right-3 p-1 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
          >
            <X size={16} />
          </button>

          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <Cpu size={20} className="text-blue-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white">Welcome to Locally Uncensored</h2>
              <p className="text-sm text-gray-500">
                {systemInfo.gpu ? `${systemInfo.gpu} (${systemInfo.vram} GB VRAM)` : 'No model installed — here are some recommendations:'}
              </p>
            </div>
          </div>

          {isPulling && pullProgress && (
            <div className="mb-4 p-3 rounded-lg bg-gray-100 dark:bg-white/5">
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">{pullProgress.status}</p>
              {pullProgress.total && pullProgress.completed !== undefined && (
                <ProgressBar progress={progress} />
              )}
            </div>
          )}

          <div className="space-y-3">
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Recommended Text Models</h3>
            {textRecs.map((rec) => {
              const Icon = rec.icon
              return (
                <div
                  key={rec.pullName}
                  className="flex items-center gap-3 p-3 rounded-lg bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/8 transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                    <Icon size={16} className="text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{rec.name}</p>
                    <p className="text-xs text-gray-500">{rec.description} — {rec.vramNeeded}</p>
                  </div>
                  {rec.pullName && (
                    <GlowButton
                      onClick={() => pullModel(rec.pullName)}
                      disabled={isPulling}
                      className="shrink-0 flex items-center gap-1 text-xs"
                    >
                      <Download size={14} /> Install
                    </GlowButton>
                  )}
                </div>
              )
            })}
          </div>

          <p className="text-xs text-gray-500 mt-4 text-center">
            You can install more models in the Model Manager anytime.
          </p>
        </GlassCard>
      </motion.div>
    </AnimatePresence>
  )
}
