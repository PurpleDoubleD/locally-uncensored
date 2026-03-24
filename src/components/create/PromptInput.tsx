import { useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, Square, ChevronDown, ChevronUp } from 'lucide-react'
import { useCreateStore } from '../../stores/createStore'

interface Props {
  onGenerate: () => void
  onCancel: () => void
}

export function PromptInput({ onGenerate, onCancel }: Props) {
  const { prompt, negativePrompt, isGenerating, setPrompt, setNegativePrompt } = useCreateStore()
  const [showNegative, setShowNegative] = useState(false)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      onGenerate()
    }
  }

  return (
    <div className="space-y-3">
      <div className="glass-card rounded-xl p-4">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to create..."
          rows={3}
          className="w-full bg-transparent resize-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none text-sm leading-relaxed"
          disabled={isGenerating}
        />
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-200 dark:border-white/5">
          <button
            onClick={() => setShowNegative(!showNegative)}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            {showNegative ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            Negative prompt
          </button>
          {isGenerating ? (
            <motion.button
              onClick={onCancel}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 text-sm font-medium"
              whileTap={{ scale: 0.95 }}
            >
              <Square size={14} /> Cancel
            </motion.button>
          ) : (
            <motion.button
              onClick={onGenerate}
              disabled={!prompt.trim()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 dark:bg-white/10 text-white text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gray-700 dark:hover:bg-white/15 transition-all"
              whileTap={{ scale: 0.95 }}
            >
              <Sparkles size={14} /> Generate
            </motion.button>
          )}
        </div>
      </div>

      {showNegative && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="glass-card rounded-xl p-4"
        >
          <textarea
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            placeholder="What to avoid (e.g. blurry, low quality, watermark)..."
            rows={2}
            className="w-full bg-transparent resize-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none text-sm leading-relaxed"
            disabled={isGenerating}
          />
        </motion.div>
      )}

      <p className="text-xs text-gray-400 text-center">Ctrl+Enter to generate</p>
    </div>
  )
}
