import { useState, useRef, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Send, Square, Paperclip, X, Brain } from 'lucide-react'
import { VoiceButton } from './VoiceButton'
import { ApprovalDialog } from './ApprovalDialog'
import { useVoiceStore } from '../../stores/voiceStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useModelStore } from '../../stores/modelStore'
import { isThinkingCompatible } from '../../lib/model-compatibility'
import type { AgentToolCall } from '../../types/agent-mode'
import type { ImageAttachment } from '../../types/chat'

interface Props {
  onSend: (content: string, images?: ImageAttachment[]) => void
  onStop: () => void
  isGenerating: boolean
  pendingApproval?: AgentToolCall | null
  onApprove?: () => void
  onReject?: () => void
  disabled?: boolean
}

function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.split(',')[1]
      resolve({ data: base64, mimeType: file.type || 'image/png', name: file.name })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function ChatInput({ onSend, onStop, isGenerating, pendingApproval, onApprove, onReject, disabled }: Props) {
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isVoiceRecording, setIsVoiceRecording] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isTranscribing = useVoiceStore((s) => s.isTranscribing)
  const thinkingEnabled = useSettingsStore((s) => s.settings.thinkingEnabled)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const activeModel = useModelStore((s) => s.activeModel)
  const canThink = isThinkingCompatible(activeModel)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px'
    }
  }, [input])

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    const newImages = await Promise.all(imageFiles.map(fileToImageAttachment))
    setImages(prev => [...prev, ...newImages].slice(0, 5)) // max 5 images
  }, [])

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  const handleSend = () => {
    const trimmed = input.trim()
    if ((!trimmed && images.length === 0) || isGenerating || disabled) return
    onSend(trimmed || '(image)', images.length > 0 ? images : undefined)
    setInput('')
    setImages([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (isVoiceRecording || isTranscribing) return
      handleSend()
    }
  }

  // Paste handler for clipboard images (Ctrl+V screenshots)
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    const files = imageItems.map(item => item.getAsFile()).filter(Boolean) as File[]
    addFiles(files)
  }, [addFiles])

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer?.files?.length) {
      addFiles(e.dataTransfer.files)
    }
  }, [addFiles])

  return (
    <div className="px-3 pb-2 pt-1">
      {/* Approval dialog */}
      {pendingApproval && onApprove && onReject && (
        <ApprovalDialog toolCall={pendingApproval} onApprove={onApprove} onReject={onReject} />
      )}

      <div
        className={`flex flex-col rounded-lg border px-2.5 py-2 transition-colors ${
          isDragOver
            ? 'bg-blue-500/5 border-blue-500/30'
            : 'bg-gray-50 dark:bg-white/[0.03] border-gray-200 dark:border-white/[0.06]'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex gap-1.5 mb-1.5 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name}
                  className="w-14 h-14 object-cover rounded-lg border border-white/10"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={8} />
                </button>
                <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[0.4rem] text-gray-300 text-center rounded-b-lg truncate px-0.5">
                  {img.name}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Input row */}
        <div className="flex items-end gap-2">
          {/* Clip button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isGenerating}
            className="p-1.5 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/5 disabled:opacity-20 transition-all shrink-0"
            title="Attach images"
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
          />

          <VoiceButton
            onTranscript={(text) => { setInput(text); requestAnimationFrame(() => { if (textareaRef.current) { textareaRef.current.style.height = 'auto'; textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px' } }) }}
            onRecordingChange={(r) => setIsVoiceRecording(r)}
            disabled={isGenerating}
          />

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={disabled ? "Claude Code not installed" : isDragOver ? "Drop images here..." : isTranscribing ? "Transcribing..." : isVoiceRecording ? "Recording..." : "Message..."}
            disabled={disabled}
            rows={1}
            className="flex-1 bg-transparent resize-none text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none text-[0.75rem] leading-relaxed max-h-[200px] disabled:opacity-50"
          />

          {/* Think toggle */}
          <button
            onClick={() => {
              if (canThink) updateSettings({ thinkingEnabled: !thinkingEnabled })
            }}
            className={`flex items-center gap-1 px-1.5 py-1.5 rounded-md transition-all shrink-0 text-[0.6rem] font-medium ${
              thinkingEnabled && canThink
                ? 'bg-blue-500/15 text-blue-400 border border-blue-500/30'
                : !canThink
                  ? 'text-gray-600 opacity-40 cursor-default'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
            }`}
            title={canThink ? (thinkingEnabled ? 'Thinking ON' : 'Thinking OFF') : 'Model does not support thinking'}
          >
            <Brain size={11} />
            <span>Think</span>
          </button>

          {isGenerating ? (
            <motion.button
              onClick={onStop}
              className="p-1.5 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-all shrink-0"
              whileTap={{ scale: 0.9 }}
              aria-label="Stop generation"
            >
              <Square size={13} />
            </motion.button>
          ) : (
            <motion.button
              onClick={handleSend}
              disabled={(!input.trim() && images.length === 0) || isTranscribing}
              className="p-1.5 rounded-md bg-white/8 text-gray-300 hover:bg-white/12 disabled:opacity-20 disabled:cursor-not-allowed transition-all shrink-0"
              whileTap={{ scale: 0.9 }}
              aria-label="Send message"
            >
              <Send size={13} />
            </motion.button>
          )}
        </div>
      </div>
    </div>
  )
}
