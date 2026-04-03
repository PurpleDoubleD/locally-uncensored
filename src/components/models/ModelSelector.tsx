import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Check, Loader2, Power } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { unloadAllModels } from '../../api/ollama'
import { displayModelName } from '../../api/providers'
import { formatBytes } from '../../lib/formatters'
import type { AIModel } from '../../types/models'

// ── Provider + Type Badges ─────────────────────────────────────

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  text: { label: 'Text', color: 'bg-blue-500/15 text-blue-300' },
  image: { label: 'Image', color: 'bg-purple-500/15 text-purple-300' },
  video: { label: 'Video', color: 'bg-green-500/15 text-green-300' },
}

const PROVIDER_BADGE: Record<string, { label: string; color: string }> = {
  ollama: { label: 'Ollama', color: 'bg-emerald-500/15 text-emerald-300' },
  openai: { label: 'Cloud', color: 'bg-sky-500/15 text-sky-300' },
  anthropic: { label: 'Claude', color: 'bg-violet-500/15 text-violet-300' },
}

function getProviderBadge(model: AIModel) {
  const provider = ('provider' in model && model.provider) || 'ollama'
  const providerName = ('providerName' in model && model.providerName) || 'Ollama'

  // Use provider-specific name if not just "Ollama"
  if (providerName && providerName !== 'Ollama' && providerName !== 'OpenAI-Compatible' && providerName !== 'Anthropic') {
    return { label: providerName, color: PROVIDER_BADGE[provider]?.color || PROVIDER_BADGE.ollama.color }
  }
  return PROVIDER_BADGE[provider] || PROVIDER_BADGE.ollama
}

// ── Group models by provider ───────────────────────────────────

function groupByProvider(models: AIModel[]): { provider: string; models: AIModel[] }[] {
  const groups: Record<string, AIModel[]> = {}
  for (const m of models) {
    const providerName = ('providerName' in m && m.providerName) || 'Ollama'
    if (!groups[providerName]) groups[providerName] = []
    groups[providerName].push(m)
  }

  // Sort: Ollama first, then alphabetical
  return Object.entries(groups)
    .sort(([a], [b]) => {
      if (a === 'Ollama') return -1
      if (b === 'Ollama') return 1
      return a.localeCompare(b)
    })
    .map(([provider, models]) => ({ provider, models }))
}

// ── Component ──────────────────────────────────────────────────

export function ModelSelector() {
  const { models, activeModel, setActiveModel, fetchModels } = useModels()
  const [open, setOpen] = useState(false)
  const [unloading, setUnloading] = useState(false)
  const [unloadDone, setUnloadDone] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const activeDisplayName = activeModel ? displayModelName(activeModel).split(':')[0] : 'Select Model'
  const activeModelObj = models.find((m) => m.name === activeModel)
  const groups = groupByProvider(models)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 hover:bg-gray-200 dark:hover:bg-white/10 transition-all text-sm"
      >
        {activeModelObj && (
          <>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${TYPE_BADGE[activeModelObj.type]?.color || TYPE_BADGE.text.color}`}>
              {TYPE_BADGE[activeModelObj.type]?.label || 'Text'}
            </span>
            {('provider' in activeModelObj && activeModelObj.provider && activeModelObj.provider !== 'ollama') && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${getProviderBadge(activeModelObj).color}`}>
                {getProviderBadge(activeModelObj).label}
              </span>
            )}
          </>
        )}
        <span className="text-gray-700 dark:text-gray-300 max-w-[180px] truncate">{activeDisplayName}</span>
        <ChevronDown size={14} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-80 rounded-xl overflow-hidden z-50 bg-white dark:bg-[#2a2a2a] border border-gray-200 dark:border-white/10 shadow-xl"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
          >
            <div className="p-2 max-h-80 overflow-y-auto scrollbar-thin">
              {models.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-4">No models available</p>
              )}

              {groups.map(({ provider, models: groupModels }) => (
                <div key={provider}>
                  {/* Provider section header (only if multiple providers) */}
                  {groups.length > 1 && (
                    <div className="px-2 pt-2 pb-1">
                      <span className="text-[0.55rem] font-semibold uppercase tracking-wider text-gray-500">{provider}</span>
                    </div>
                  )}

                  {groupModels.map((model: AIModel) => {
                    const badge = TYPE_BADGE[model.type] || TYPE_BADGE.text
                    const modelDisplayName = displayModelName(model.name)
                    const providerBadge = getProviderBadge(model)
                    const modelProvider = ('provider' in model && model.provider) || 'ollama'

                    return (
                      <button
                        key={model.name}
                        onClick={() => {
                          setActiveModel(model.name)
                          setOpen(false)
                        }}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
                          model.name === activeModel
                            ? 'bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white'
                            : 'hover:bg-gray-50 dark:hover:bg-white/5 text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{modelDisplayName}</p>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.color}`}>
                              {badge.label}
                            </span>
                            {modelProvider !== 'ollama' && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${providerBadge.color}`}>
                                {providerBadge.label}
                              </span>
                            )}
                            {model.type === 'text' && 'details' in model && (model as any).details && (
                              <span className="text-[10px] text-gray-400">
                                {(model as any).details.parameter_size} · {(model as any).details.quantization_level}
                              </span>
                            )}
                            {model.size > 0 && (
                              <span className="text-[10px] text-gray-400">{formatBytes(model.size)}</span>
                            )}
                            {'contextLength' in model && (model as any).contextLength && (
                              <span className="text-[10px] text-gray-500">{Math.round((model as any).contextLength / 1000)}K ctx</span>
                            )}
                          </div>
                        </div>
                        {model.name === activeModel && <Check size={16} className="text-blue-500 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              ))}

              {/* Unload All text models button */}
              {models.some(m => m.type === 'text' && (('provider' in m && m.provider === 'ollama') || !('provider' in m))) && (
                <>
                  <div className="border-t border-gray-200 dark:border-white/10 my-1" />
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (unloading) return
                      setUnloading(true)
                      setUnloadDone(false)
                      try {
                        await unloadAllModels()
                        setUnloadDone(true)
                        setTimeout(() => setUnloadDone(false), 2000)
                      } catch { /* ignore */ }
                      finally { setUnloading(false) }
                    }}
                    disabled={unloading}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-xs text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    {unloading ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                    <span>{unloadDone ? 'Models unloaded!' : unloading ? 'Unloading...' : 'Unload all Ollama models'}</span>
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
