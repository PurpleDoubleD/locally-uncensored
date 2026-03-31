import { useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FileText,
  File,
  Upload,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Download,
} from 'lucide-react'
import { useRAG } from '../../hooks/useRAG'
import { useRAGStore } from '../../stores/ragStore'

interface Props {
  conversationId: string | null
}

const ACCEPT = '.pdf,.docx,.txt'

function ScoreBadge({ score }: { score: number }) {
  const color =
    score > 0.8
      ? 'bg-green-500/20 text-green-400 border-green-500/30'
      : score > 0.6
        ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
        : 'bg-red-500/20 text-red-400 border-red-500/30'

  return (
    <span
      className={'inline-flex items-center px-1.5 py-0.5 rounded text-[0.55rem] font-mono font-medium border ' + color}
    >
      {score.toFixed(3)}
    </span>
  )
}

export function RAGPanel({ conversationId }: Props) {
  const {
    documents,
    isEnabled,
    isIndexing,
    indexingProgress,
    contextWarning,
    pullingEmbeddingModel,
    uploadDocument,
    removeDocument,
    toggleRAG,
  } = useRAG(conversationId)

  const embeddingModel = useRAGStore((s) => s.embeddingModel)
  const lastRetrievedChunks = useRAGStore((s) => s.lastRetrievedChunks)
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chunksExpanded, setChunksExpanded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null)
      const fileArray = Array.from(files)

      for (const file of fileArray) {
        const ext = file.name.split('.').pop()?.toLowerCase()
        if (!ext || !['pdf', 'docx', 'txt'].includes(ext)) {
          setError('Unsupported file type: .' + ext)
          continue
        }
        try {
          await uploadDocument(file)
        } catch (err) {
          setError('Failed to index ' + file.name)
        }
      }
    },
    [uploadDocument]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files)
      }
    },
    [handleFiles]
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFiles(e.target.files)
        e.target.value = ''
      }
    },
    [handleFiles]
  )

  const typeIcon = (type: string) => {
    if (type === 'txt') return <FileText size={14} className="text-blue-400" />
    return <File size={14} className="text-orange-400" />
  }

  const getDocName = (documentId: string): string => {
    for (const doc of documents) {
      if (doc.id === documentId) return doc.name
    }
    return 'Unknown'
  }

  if (!conversationId) return null

  const progressPercent = indexingProgress
    ? String((indexingProgress.current / indexingProgress.total) * 100) + '%'
    : '0%'

  return (
    <motion.div
      className="w-[280px] shrink-0 h-full border-l border-gray-200 dark:border-white/5 bg-white dark:bg-[#2a2a2a] flex flex-col"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 280, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Header with toggle */}
      <div className="px-3 py-2.5 border-b border-gray-200 dark:border-white/5 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200">Document Chat</span>
        <button
          onClick={toggleRAG}
          className="flex items-center gap-1 text-xs"
          title={isEnabled ? 'Disable RAG' : 'Enable RAG'}
        >
          {isEnabled ? (
            <ToggleRight size={20} className="text-green-500" />
          ) : (
            <ToggleLeft size={20} className="text-gray-400" />
          )}
        </button>
      </div>

      {/* Context window warning */}
      <AnimatePresence>
        {contextWarning && (
          <motion.div
            className="px-3 py-2"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="flex items-start gap-1.5 p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle size={12} className="text-yellow-500 shrink-0 mt-0.5" />
              <span className="text-[0.6rem] text-yellow-400 leading-tight">
                {contextWarning}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Embedding model pull progress */}
      <AnimatePresence>
        {pullingEmbeddingModel && (
          <motion.div
            className="px-3 py-2"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="flex items-center gap-1.5 p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <Download size={12} className="text-blue-400 animate-bounce" />
              <span className="text-[0.6rem] text-blue-400 leading-tight">
                Downloading embedding model (nomic-embed-text)...
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Drop zone */}
      <div className="px-3 pt-3 pb-1">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={
            'border-2 border-dashed rounded-lg p-4 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition-colors ' +
            (isDragging
              ? 'border-green-400 bg-green-50 dark:bg-green-500/10'
              : 'border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20')
          }
        >
          <Upload size={18} className={isDragging ? 'text-green-500' : 'text-gray-400'} />
          <span className="text-[0.65rem] text-gray-500 dark:text-gray-400 text-center">
            Drop files here or click to upload
          </span>
          <span className="text-[0.55rem] text-gray-400 dark:text-gray-500">
            PDF, DOCX, TXT
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>

      {/* Indexing progress */}
      <AnimatePresence>
        {isIndexing && indexingProgress && (
          <motion.div
            className="px-3 py-2"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Loader2 size={12} className="text-green-500 animate-spin" />
              <span className="text-[0.6rem] text-gray-500 dark:text-gray-400">
                Indexing... {indexingProgress.current}/{indexingProgress.total}
              </span>
            </div>
            <div className="w-full h-1 bg-gray-100 dark:bg-white/5 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-green-500 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: progressPercent }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      <AnimatePresence>
        {error && (
          <motion.div
            className="px-3 py-1.5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="flex items-center gap-1.5 text-[0.6rem] text-red-500">
              <AlertCircle size={11} />
              <span>{error}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Document list */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 scrollbar-thin">
        <AnimatePresence>
          {documents.map((doc) => (
            <motion.div
              key={doc.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-white/5 group"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.15 }}
            >
              {typeIcon(doc.type)}
              <div className="flex-1 min-w-0">
                <p className="text-[0.65rem] text-gray-700 dark:text-gray-200 truncate">
                  {doc.name}
                </p>
                <p className="text-[0.55rem] text-gray-400">
                  {doc.chunkCount} chunks
                </p>
              </div>
              <button
                onClick={() => removeDocument(doc.id)}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-500/15 text-gray-400 hover:text-red-500 transition-all"
              >
                <Trash2 size={12} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>

        {documents.length === 0 && !isIndexing && (
          <p className="text-[0.6rem] text-gray-400 text-center py-4">
            No documents added yet
          </p>
        )}
      </div>

      {/* Retrieved Chunks section */}
      {lastRetrievedChunks.length > 0 && isEnabled && (
        <div className="border-t border-gray-200 dark:border-white/5">
          <button
            onClick={() => setChunksExpanded(!chunksExpanded)}
            className="w-full px-3 py-2 flex items-center gap-1.5 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          >
            {chunksExpanded ? (
              <ChevronDown size={12} className="text-gray-400" />
            ) : (
              <ChevronRight size={12} className="text-gray-400" />
            )}
            <span className="text-[0.6rem] font-medium text-gray-600 dark:text-gray-300">
              Retrieved Chunks ({lastRetrievedChunks.length})
            </span>
          </button>

          <AnimatePresence>
            {chunksExpanded && (
              <motion.div
                className="px-3 pb-2 space-y-1.5 max-h-[200px] overflow-y-auto scrollbar-thin"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                {lastRetrievedChunks.map((result, idx) => (
                  <div
                    key={result.chunk.id + '-' + idx}
                    className="p-2 rounded-lg bg-gray-50 dark:bg-white/5 space-y-1"
                  >
                    <div className="flex items-center gap-1.5">
                      <ScoreBadge score={result.score} />
                      <span className="text-[0.55rem] text-gray-500 dark:text-gray-400 truncate">
                        {getDocName(result.chunk.documentId)}
                      </span>
                    </div>
                    <p className="text-[0.55rem] text-gray-600 dark:text-gray-300 leading-relaxed">
                      {result.chunk.content.slice(0, 80)}
                      {result.chunk.content.length > 80 ? '...' : ''}
                    </p>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Footer: embedding model */}
      <div className="px-3 py-2 border-t border-gray-200 dark:border-white/5">
        <p className="text-[0.55rem] text-gray-400 dark:text-gray-500 truncate">
          Embedding: {embeddingModel}
        </p>
      </div>
    </motion.div>
  )
}
