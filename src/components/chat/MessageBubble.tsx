import { motion } from 'framer-motion'
import { User, Bot, Copy, Check } from 'lucide-react'
import { useState } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ThinkingBlock } from './ThinkingBlock'
import type { Message } from '../../types/chat'

interface Props {
  message: Message
}

export function MessageBubble({ message }: Props) {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <motion.div
      className={`flex gap-2.5 px-3 py-2 group ${isUser ? 'flex-row-reverse' : ''}`}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isUser
            ? 'bg-gray-200 dark:bg-white/10 border border-gray-300 dark:border-white/15'
            : 'bg-gray-100 dark:bg-[#2f2f2f] border border-gray-200 dark:border-white/10'
          }`}
      >
        {isUser ? <User size={13} className="text-gray-600 dark:text-gray-300" /> : <Bot size={13} className="text-gray-500 dark:text-gray-400" />}
      </div>

      <div className="max-w-[80%] space-y-1.5">
        {/* Thinking block (collapsible, lighter blue, italic, smaller) */}
        {!isUser && message.thinking && (
          <ThinkingBlock thinking={message.thinking} />
        )}

        {/* Main answer bubble */}
        <div
          className={`rounded-xl px-3 py-2 relative ${isUser
              ? 'bg-gray-100 dark:bg-[#2f2f2f] border border-gray-200 dark:border-white/10'
              : 'bg-white dark:bg-[#2a2a2a] border border-gray-200 dark:border-white/5'
            }`}
        >
          {isUser ? (
            <p className="text-[0.8rem] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="text-[0.8rem] leading-relaxed">
              <MarkdownRenderer content={message.content} />
            </div>
          )}

          <button
            onClick={handleCopy}
            className="absolute top-1.5 right-1.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-all"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    </motion.div>
  )
}
