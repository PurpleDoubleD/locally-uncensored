import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Check, MessageSquare, Image, Video } from 'lucide-react'
import { useModels } from '../../hooks/useModels'
import { formatBytes } from '../../lib/formatters'
import type { AIModel } from '../../types/models'

const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  text: { label: 'Text', color: 'bg-blue-500/15 text-blue-300' },
  image: { label: 'Image', color: 'bg-purple-500/15 text-purple-300' },
  video: { label: 'Video', color: 'bg-green-500/15 text-green-300' },
}

export function ModelSelector() {
  const { models, activeModel, setActiveModel, fetchModels } = useModels()
  const [open, setOpen] = useState(false)
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

  const activeModelShort = activeModel?.split(':')[0] || 'Select Model'
  const activeModelObj = models.find((m) => m.name === activeModel)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-300 dark:border-white/10 hover:bg-gray-200 dark:hover:bg-white/10 transition-all text-sm"
      >
        {activeModelObj && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${TYPE_BADGE[activeModelObj.type]?.color || TYPE_BADGE.text.color}`}>
            {TYPE_BADGE[activeModelObj.type]?.label || 'Text'}
          </span>
        )}
        <span className="text-gray-700 dark:text-gray-300 max-w-[180px] truncate">{activeModelShort}</span>
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
            <div className="p-2 max-h-72 overflow-y-auto scrollbar-thin">
              {models.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-4">No models installed</p>
              )}
              {models.map((model: AIModel) => {
                const badge = TYPE_BADGE[model.type] || TYPE_BADGE.text
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
                      <p className="text-sm font-medium truncate">{model.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.color}`}>
                          {badge.label}
                        </span>
                        {model.type === 'text' && 'details' in model && (
                          <span className="text-[10px] text-gray-400">
                            {model.details?.parameter_size} · {model.details?.quantization_level}
                          </span>
                        )}
                        {model.size > 0 && (
                          <span className="text-[10px] text-gray-400">{formatBytes(model.size)}</span>
                        )}
                      </div>
                    </div>
                    {model.name === activeModel && <Check size={16} className="text-blue-500 shrink-0" />}
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
