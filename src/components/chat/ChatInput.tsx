import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Send, Square } from 'lucide-react'

interface Props {
  onSend: (content: string) => void
  onStop: () => void
  isGenerating: boolean
}

export function ChatInput({ onSend, onStop, isGenerating }: Props) {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [input])

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed || isGenerating) return
    onSend(trimmed)
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="p-3 border-t border-gray-200 dark:border-white/5">
      <div className="flex items-end gap-2.5 glass-card rounded-xl px-3 py-2.5">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          className="flex-1 bg-transparent resize-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none text-[0.8rem] leading-relaxed max-h-[200px]"
        />
        {isGenerating ? (
          <motion.button
            onClick={onStop}
            className="p-2 rounded-lg bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30 transition-all shrink-0"
            whileTap={{ scale: 0.9 }}
          >
            <Square size={15} />
          </motion.button>
        ) : (
          <motion.button
            onClick={handleSend}
            disabled={!input.trim()}
            className="p-2 rounded-lg bg-gray-800 dark:bg-white/10 border border-gray-700 dark:border-white/15 text-white hover:bg-gray-700 dark:hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0"
            whileTap={{ scale: 0.9 }}
          >
            <Send size={15} />
          </motion.button>
        )}
      </div>
      <p className="text-[0.65rem] text-gray-400 dark:text-gray-600 mt-1.5 text-center">
        Enter to send · Shift+Enter for new line
      </p>
    </div>
  )
}
