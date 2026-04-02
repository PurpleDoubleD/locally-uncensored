import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Square, ChevronDown, ChevronUp, History, X } from 'lucide-react'
import { useCreateStore } from '../../stores/createStore'

interface Props {
  onGenerate: () => void
  onCancel: () => void
  disabled?: boolean
}

export function PromptInput({ onGenerate, onCancel, disabled }: Props) {
  const { prompt, negativePrompt, isGenerating, promptHistory, setPrompt, setNegativePrompt } = useCreateStore()
  const [showNegative, setShowNegative] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isMac = navigator.platform.toUpperCase().includes('MAC')

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      if (!isGenerating && prompt.trim()) onGenerate()
    }
  }

  const selectFromHistory = (p: string) => {
    setPrompt(p)
    setShowHistory(false)
    textareaRef.current?.focus()
  }

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#2a2a2a] overflow-hidden">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you want to create..."
            rows={3}
            className="w-full bg-transparent resize-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none text-sm leading-relaxed p-4"
            disabled={isGenerating || disabled}
            aria-label="Image or video generation prompt"
          />
          {/* Prompt history button */}
          {promptHistory.length > 0 && (
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="absolute top-2 right-2 p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
              title="Prompt history"
              aria-label="Prompt history"
            >
              <History size={14} />
            </button>
          )}
        </div>

        {/* Prompt history dropdown */}
        <AnimatePresence>
          {showHistory && promptHistory.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="border-t border-gray-200 dark:border-white/10 max-h-32 overflow-y-auto"
            >
              {promptHistory.map((p, i) => (
                <button
                  key={i}
                  onClick={() => selectFromHistory(p)}
                  className="w-full text-left px-4 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 truncate transition-colors"
                >
                  {p}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 dark:border-white/5">
          <button
            onClick={() => setShowNegative(!showNegative)}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            {showNegative ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            Negative prompt
          </button>
          <div className="flex items-center gap-2">
            {prompt.trim() && !isGenerating && (
              <button onClick={() => setPrompt('')} className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" aria-label="Clear prompt">
                <X size={14} />
              </button>
            )}
            {isGenerating ? (
              <motion.button
                onClick={onCancel}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 text-sm font-medium"
                whileTap={{ scale: 0.95 }}
              >
                <Square size={14} /> Cancel
              </motion.button>
            ) : (
              <motion.button
                onClick={onGenerate}
                disabled={!prompt.trim() || disabled}
                className="flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gray-800 dark:bg-white/10 text-white text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gray-700 dark:hover:bg-white/15 transition-all"
                whileTap={{ scale: 0.95 }}
              >
                <Sparkles size={14} /> Generate
              </motion.button>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showNegative && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#2a2a2a] overflow-hidden"
          >
            <textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="What to avoid (e.g. blurry, low quality, watermark)..."
              rows={2}
              className="w-full bg-transparent resize-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none text-sm leading-relaxed p-4"
              disabled={isGenerating}
              aria-label="Negative prompt"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <p className="text-xs text-gray-400 text-center">{isMac ? 'Cmd' : 'Ctrl'}+Enter to generate</p>
    </div>
  )
}
