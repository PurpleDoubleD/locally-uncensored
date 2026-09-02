import { useState, useCallback, useEffect, useRef } from 'react'
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
  ChevronsRight,
  AlertTriangle,
  Download,
  MessageSquarePlus,
  Eraser,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useRAG } from '../../hooks/useRAG'
import { useRAGStore } from '../../stores/ragStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useEmbedLane } from '../../hooks/useEmbedLane'
import { laneIsOnThisMachine } from '../../api/embed-availability'
import { formatBytes } from '../../lib/formatters'

interface Props {
  conversationId: string | null
  onClose?: () => void
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

export function RAGPanel({ conversationId, onClose }: Props) {
  // Show placeholder when no conversation is active
  if (!conversationId) {
    return (
      <motion.div
        className="w-[280px] shrink-0 h-full border-l border-gray-200 dark:border-white/5 bg-white dark:bg-[#363636] flex flex-col"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: 280, opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        <div className="px-3 py-2.5 border-b border-gray-200 dark:border-white/5 flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700 dark:text-gray-200">Document Chat</span>
          {onClose && (
            <button
              onClick={onClose}
              className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
              title="Collapse panel"
              aria-label="Collapse panel"
            >
              <ChevronsRight size={14} />
            </button>
          )}
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          <MessageSquarePlus size={32} className="text-gray-300 dark:text-gray-600 mb-3" />
          <p className="text-sm text-gray-400 dark:text-gray-500 text-center px-6">
            Start a conversation first
          </p>
          <p className="text-[0.6rem] text-gray-300 dark:text-gray-600 text-center px-6 mt-1">
            Document chat will be available once a conversation is active.
          </p>
        </div>
      </motion.div>
    )
  }

  return <RAGPanelInner conversationId={conversationId} onClose={onClose} />
}

function RAGPanelInner({ conversationId, onClose }: { conversationId: string; onClose?: () => void }) {
  const cloudMode = useSettingsStore((s) => s.settings.appMode) === 'cloud'
  // Same one measurement the composer's Docs button reads (hooks/useEmbedLane),
  // so the button's tooltip and this paragraph can never say different things.
  const lane = useEmbedLane(cloudMode)
  const rag = useRAG(conversationId)
  const documents = rag.documents ?? []
  const isEnabled = rag.isEnabled ?? false
  const isIndexing = rag.isIndexing ?? false
  const indexingProgress = rag.indexingProgress ?? null
  const contextWarning = rag.contextWarning ?? null
  const pullingEmbeddingModel = rag.pullingEmbeddingModel ?? false
  const chunksLoaded = rag.chunksLoaded ?? false
  const uploadDocument = rag.uploadDocument
  const removeDocument = rag.removeDocument
  const toggleRAG = rag.toggleRAG
  const clearAll = rag.clearAll
  const installEmbeddingAndDrainQueue = rag.installEmbeddingAndDrainQueue
  const cancelEmbeddingInstall = rag.cancelEmbeddingInstall
  const ensureEmbeddingModel = rag.ensureEmbeddingModel

  // Proactively probe for nomic-embed-text the first time the user opens the
  // Document Chat panel. If it's missing we flip embeddingInstallPrompt right
  // here so the install card shows before any upload attempt — user clicks
  // the Docs button, sees the offer, can install or cancel. This is the path
  // the user explicitly asked for over a global top-of-app banner. The probe
  // runs only when the prompt isn't already up and we aren't mid-pull, so
  // re-opening the panel doesn't fight an in-flight install.
  useEffect(() => {
    let cancelled = false
    if (embeddingInstallPrompt || pullingEmbeddingModel) return
    ;(async () => {
      try {
        const has = await ensureEmbeddingModel()
        if (cancelled) return
        if (!has) {
          useRAGStore.getState().setEmbeddingInstallPrompt(true)
        }
      } catch {
        /* ollama probe failed — silent; user can still drop a file later */
      }
    })()
    return () => { cancelled = true }
    // intentionally NOT depending on prompt/pulling flags — we want a single
    // mount-time probe per panel open, not a re-fire on every flag change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureEmbeddingModel])

  const { embeddingModelReactive, lastRetrievedChunksReactive, embeddingPullProgress, embeddingInstallPrompt, embeddingQueuedCount, retrievalError } = useRAGStore(
    useShallow((s) => ({
      embeddingModelReactive: s.embeddingModel,
      lastRetrievedChunksReactive: s.lastRetrievedChunks,
      embeddingPullProgress: s.embeddingPullProgress,
      embeddingInstallPrompt: s.embeddingInstallPrompt,
      embeddingQueuedCount: s.embeddingQueuedFiles.length,
      retrievalError: s.retrievalError,
    }))
  )

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
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg)
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

  const safeChunks = Array.isArray(lastRetrievedChunksReactive) ? lastRetrievedChunksReactive : []

  const progressPercent = indexingProgress
    ? String((indexingProgress.current / indexingProgress.total) * 100) + '%'
    : '0%'

  return (
    <motion.div
      className="w-[280px] shrink-0 h-full border-l border-gray-200 dark:border-white/5 bg-white dark:bg-[#363636] flex flex-col"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 280, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Header: Title + on/off toggle + Clear-all + Collapse */}
      <div className="px-3 py-2.5 border-b border-gray-200 dark:border-white/5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-200 flex-1">Document Chat</span>
        <button
          onClick={toggleRAG}
          className="flex items-center text-xs"
          title={isEnabled ? 'Disable RAG (keeps files)' : 'Enable RAG'}
          aria-label={isEnabled ? 'Disable RAG' : 'Enable RAG'}
        >
          {isEnabled ? (
            <ToggleRight size={20} className="text-green-500" />
          ) : (
            <ToggleLeft size={20} className="text-gray-400" />
          )}
        </button>
        {documents.length > 0 && (
          <button
            onClick={() => {
              if (confirm(`Remove all ${documents.length} document${documents.length === 1 ? '' : 's'} from this chat? This cannot be undone.`)) {
                clearAll()
              }
            }}
            className="p-1 rounded hover:bg-red-500/15 text-gray-500 dark:text-gray-400 hover:text-red-500 transition-colors"
            title="Clear all documents from this chat"
            aria-label="Clear all documents"
          >
            <Eraser size={13} />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors"
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            <ChevronsRight size={14} />
          </button>
        )}
      </div>

      {/* Where the text actually goes, said in Cloud mode because in Cloud mode
          it is a fair question (A9). The sentence follows the measured lane:
          promising "stays on this computer" while indexing ships every chunk to
          a LAN Ollama would be a comfortable lie (review B2). */}
      {cloudMode && lane && lane.lane !== 'none' && (
        <div className="px-3 pt-2">
          {laneIsOnThisMachine(lane.lane) ? (
            <p
              data-testid="rag-cloud-privacy"
              className="text-[0.6rem] leading-snug text-gray-500 dark:text-gray-400"
            >
              Your documents are indexed on this computer and stay here. Only the passages
              that match your question are sent to the cloud model as context.
            </p>
          ) : (
            <p
              data-testid="rag-cloud-privacy-remote"
              className="flex items-start gap-1.5 text-[0.6rem] leading-snug text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              <span>
                Indexing runs on {lane.endpoint ?? 'your configured Ollama host'}, so the full
                text of every document you add is sent there. The passages that match your
                question are then sent to the cloud model as context.
              </span>
            </p>
          )}
        </div>
      )}

      {/* The last turn went out without the documents (review S4). */}
      {retrievalError && (
        <div className="px-3 pt-2">
          <div className="flex items-start gap-1.5 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <span data-testid="rag-retrieval-error" className="text-[0.6rem] text-amber-600 dark:text-amber-400 leading-tight">
              {retrievalError}
            </span>
          </div>
        </div>
      )}

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

      {/* In-app install prompt (Bug F45-followup) — replaces window.confirm()
          so the user stays in app chrome. Triggered by either:
            (a) Opening the Document Chat panel while nomic-embed-text is
                missing — RAGPanelInner's mount-time `ensureEmbeddingModel`
                check below flips the prompt proactively, so the user sees
                the install offer the moment they click the Docs button.
            (b) Dropping a file when the model is missing — uploadDocument
                queues the file + flips the prompt; queued files replay
                after the pull succeeds.
          Neutral white/gray chrome (no blue tint) — matches the v2.4.8 Q-
          polish pattern. */}
      <AnimatePresence>
        {embeddingInstallPrompt && !pullingEmbeddingModel && (
          <motion.div
            className="px-3 py-2"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Download size={12} className="text-gray-500 dark:text-gray-300 shrink-0" />
                <span className="text-[0.65rem] font-medium text-gray-700 dark:text-gray-200">Embedding model needed</span>
              </div>
              <p className="text-[0.6rem] text-gray-500 dark:text-gray-400 leading-snug">
                Document Chat needs <code className="font-mono px-1 rounded bg-gray-200 dark:bg-white/5">{embeddingModelReactive ?? 'nomic-embed-text'}</code> (274 MB). One-time download.
                {embeddingQueuedCount > 0 && (
                  <span className="block mt-0.5 text-gray-400 dark:text-gray-500">
                    {embeddingQueuedCount} file{embeddingQueuedCount === 1 ? '' : 's'} queued, they will index after install.
                  </span>
                )}
              </p>
              <div className="flex gap-1.5 pt-0.5">
                <button
                  onClick={() => installEmbeddingAndDrainQueue()}
                  className="flex-1 px-2 py-1 rounded text-[0.6rem] font-medium bg-gray-200 hover:bg-gray-300 dark:bg-white/10 dark:hover:bg-white/15 text-gray-800 dark:text-gray-100 transition-colors flex items-center justify-center gap-1"
                >
                  <Download size={11} /> Download
                </button>
                <button
                  onClick={() => cancelEmbeddingInstall()}
                  className="px-2 py-1 rounded text-[0.6rem] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Embedding model pull progress — real bytes-level progress bar replacing
          the pre-v2.4.9 bouncing-icon banner. Reads embeddingPullProgress
          which useRAG.pullEmbeddingModel populates per Ollama stream chunk.
          Neutral chrome to match the install prompt above. */}
      <AnimatePresence>
        {pullingEmbeddingModel && (
          <motion.div
            className="px-3 py-2"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Loader2 size={12} className="text-gray-500 dark:text-gray-300 animate-spin shrink-0" />
                <span className="text-[0.6rem] text-gray-600 dark:text-gray-300 leading-tight truncate">
                  {embeddingPullProgress?.status?.startsWith('downloading')
                    ? 'Downloading nomic-embed-text…'
                    : embeddingPullProgress?.status === 'success'
                      ? 'Almost done…'
                      : (embeddingPullProgress?.status || 'Preparing pull…')}
                </span>
              </div>
              {embeddingPullProgress && embeddingPullProgress.total > 0 ? (
                <>
                  <div className="w-full h-1 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-gray-500 dark:bg-gray-300 rounded-full"
                      initial={{ width: 0 }}
                      animate={{
                        width: `${Math.min(100, (embeddingPullProgress.completed / embeddingPullProgress.total) * 100)}%`,
                      }}
                      transition={{ duration: 0.2 }}
                    />
                  </div>
                  <p className="text-[0.55rem] text-gray-500 dark:text-gray-400 font-mono">
                    {formatBytes(embeddingPullProgress.completed)} / {formatBytes(embeddingPullProgress.total)} · {Math.round((embeddingPullProgress.completed / embeddingPullProgress.total) * 100)}%
                  </p>
                </>
              ) : (
                <div className="w-full h-1 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gray-500 dark:bg-gray-300 rounded-full w-1/3"
                    animate={{ x: ['-100%', '300%'] }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
                  />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* RAG explanation when disabled */}
      {!isEnabled && documents.length === 0 && (
        <div className="px-3 pt-2">
          <div className="p-2 rounded-lg bg-gray-50 dark:bg-white/5 border border-gray-200 dark:border-white/10">
            <p className="text-[0.6rem] text-gray-500 dark:text-gray-400 leading-relaxed">
              Upload documents and enable the toggle to chat with your files. The AI will use document content to answer your questions.
            </p>
          </div>
        </div>
      )}

      {/* Loading chunks from IndexedDB */}
      {documents.length > 0 && !chunksLoaded && (
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5 p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
            <Loader2 size={12} className="text-blue-400 animate-spin" />
            <span className="text-[0.6rem] text-blue-400">Loading indexed documents...</span>
          </div>
        </div>
      )}

      {/* Drop zone */}
      <div className="px-3 pt-3 pb-1">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={
            'border-2 rounded-lg p-4 flex flex-col items-center justify-center gap-1.5 cursor-pointer transition-colors ' +
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
                aria-label="Remove document"
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
      {safeChunks.length > 0 && isEnabled && (
        <div className="border-t border-gray-200 dark:border-white/5">
          <button
            onClick={() => setChunksExpanded(!chunksExpanded)}
            className="w-full px-3 py-2 flex items-center gap-1.5 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
            aria-label="Toggle retrieved chunks"
          >
            {chunksExpanded ? (
              <ChevronDown size={12} className="text-gray-400" />
            ) : (
              <ChevronRight size={12} className="text-gray-400" />
            )}
            <span className="text-[0.6rem] font-medium text-gray-600 dark:text-gray-300">
              Retrieved Chunks ({safeChunks.length})
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
                {safeChunks.map((result, idx) => (
                  <div
                    key={(result?.chunk?.id ?? idx) + '-' + idx}
                    className="p-2 rounded-lg bg-gray-50 dark:bg-white/5 space-y-1"
                  >
                    <div className="flex items-center gap-1.5">
                      <ScoreBadge score={result?.score ?? 0} />
                      <span className="text-[0.55rem] text-gray-500 dark:text-gray-400 truncate">
                        {getDocName(result?.chunk?.documentId ?? '')}
                      </span>
                    </div>
                    <p className="text-[0.55rem] text-gray-600 dark:text-gray-300 leading-relaxed">
                      {(result?.chunk?.content ?? '').slice(0, 80)}
                      {(result?.chunk?.content ?? '').length > 80 ? '...' : ''}
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
          Embedding: {embeddingModelReactive ?? 'nomic-embed-text'}
        </p>
      </div>
    </motion.div>
  )
}
