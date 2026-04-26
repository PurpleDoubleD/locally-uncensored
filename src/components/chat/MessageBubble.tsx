import { motion } from 'framer-motion'
import { User, Bot, Copy, Check, Pencil, RefreshCw, X } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ReflectionBlock } from './ReflectionBlock'
import { SpeakerButton } from './SpeakerButton'
import type { Message } from '../../types/chat'

interface Props {
  message: Message
  onRegenerate?: () => void
  onEdit?: (messageId: string, newContent: string) => void
  /** Tool-call id awaiting user approval. When the matching block in
   *  this message has that id, ToolCallBlock renders Approve/Reject
   *  inline instead of a popup over the chat input. */
  pendingApprovalId?: string | null
  onApprove?: () => void
  onReject?: () => void
}

export function MessageBubble({ message, onRegenerate, onEdit, pendingApprovalId, onApprove, onReject }: Props) {
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)
  const isUser = message.role === 'user'

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus()
      editRef.current.style.height = 'auto'
      editRef.current.style.height = editRef.current.scrollHeight + 'px'
    }
  }, [isEditing])

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEdit = () => {
    setEditContent(message.content)
    setIsEditing(true)
  }

  const confirmEdit = () => {
    if (editContent.trim() && editContent !== message.content && onEdit) {
      onEdit(message.id, editContent.trim())
    }
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditContent('')
  }

  return (
    <motion.div
      className={'flex gap-2 px-3 py-1 group ' + (isUser ? 'flex-row-reverse' : '')}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {/* Avatar */}
      <div
        className={
          'w-6 h-6 rounded-md flex items-center justify-center shrink-0 ' +
          (isUser
            ? 'bg-gray-100 dark:bg-white/8 border border-gray-200 dark:border-white/10'
            : 'bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/[0.06]')
        }
      >
        {isUser ? <User size={11} className="text-gray-400" /> : <Bot size={11} className="text-gray-500" />}
      </div>

      <div className="max-w-[80%] space-y-0.5">
        {/* Thinking block */}
        {!isUser && message.thinking && (
          <ThinkingBlock thinking={message.thinking} />
        )}

        {/* Agent Mode: render tool_call + reflection blocks chronologically.
            Reflection blocks were added for #29 follow-up — narration the
            model emitted between tool calls used to be wiped on the next
            iteration; now it persists as a collapsible block, in the
            order the model produced it. */}
        {!isUser && message.agentBlocks && message.agentBlocks.length > 0 && (
          <>
            {[...message.agentBlocks]
              .filter((b) => b.phase === 'tool_call' || b.phase === 'reflection')
              .sort((a, b) => a.timestamp - b.timestamp)
              .map((block) => {
                if (block.phase === 'tool_call' && block.toolCall) {
                  const isPending = !!pendingApprovalId && block.toolCall.id === pendingApprovalId
                  return (
                    <ToolCallBlock
                      key={block.id}
                      toolCall={block.toolCall}
                      onApprove={isPending ? onApprove : undefined}
                      onReject={isPending ? onReject : undefined}
                    />
                  )
                }
                if (block.phase === 'reflection') {
                  return <ReflectionBlock key={block.id} content={block.content} />
                }
                return null
              })}
          </>
        )}

        {/* Image attachments */}
        {message.images && message.images.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {message.images.map((img, i) => (
              <a
                key={i}
                href={`data:${img.mimeType};base64,${img.data}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name}
                  className="max-w-[180px] max-h-[120px] object-cover rounded-md border border-white/10 hover:border-white/25 transition-colors cursor-pointer"
                />
              </a>
            ))}
          </div>
        )}

        {/* Main content — assistant messages drop the bubble entirely
            (per user feedback: "die graue Blase komplett weghaben"). User
            messages keep theirs because they're right-aligned and need
            the visual anchor against the chat background. */}
        <div
          className={
            'relative ' +
            (isUser
              ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
              : 'px-1 py-0.5')
          }
        >
          {isUser && isEditing ? (
            <div className="space-y-1">
              <textarea
                ref={editRef}
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = e.target.scrollHeight + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit() }
                  if (e.key === 'Escape') cancelEdit()
                }}
                className="w-full bg-transparent text-[0.78rem] leading-relaxed text-gray-800 dark:text-gray-200 resize-none focus:outline-none"
              />
              <div className="flex items-center gap-1 justify-end">
                <button onClick={confirmEdit} className="p-0.5 rounded hover:bg-green-500/20 text-green-500 transition-colors"><Check size={11} /></button>
                <button onClick={cancelEdit} className="p-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"><X size={11} /></button>
              </div>
            </div>
          ) : isUser ? (
            <p className="text-[0.78rem] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="text-[0.78rem] leading-relaxed">
              <MarkdownRenderer content={message.content} />
            </div>
          )}

          {!isEditing && (
            <div className="absolute top-1 right-1 flex items-center gap-0.5">
              {isUser && onEdit && (
                <button onClick={startEdit} className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-500 hover:text-white transition-all" aria-label="Edit message"><Pencil size={10} /></button>
              )}
              {!isUser && onRegenerate && (
                <button onClick={onRegenerate} className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-500 hover:text-white transition-all" aria-label="Regenerate response"><RefreshCw size={10} /></button>
              )}
              <button onClick={handleCopy} className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-500 hover:text-white transition-all" aria-label="Copy message">
                {copied ? <Check size={10} /> : <Copy size={10} />}
              </button>
              {!isUser && <SpeakerButton text={message.content} />}
            </div>
          )}
        </div>

        {/* RAG sources */}
        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="pt-1 border-t border-white/[0.04]">
            <p className="text-[0.5rem] text-gray-500 mb-0.5">Sources:</p>
            {message.sources.map((s, i) => (
              <p key={i} className="text-[0.5rem] text-gray-600 truncate">
                [{i + 1}] {s.documentName} — {s.preview.slice(0, 60)}...
              </p>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}
