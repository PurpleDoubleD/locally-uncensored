import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { DocumentMeta, TextChunk } from "../types/rag"
import { saveChunks, loadChunks, deleteChunks } from "../lib/ragDB"
import { log } from "../lib/logger"

interface RAGState {
  documents: Record<string, DocumentMeta[]>
  chunks: TextChunk[]
  ragEnabled: Record<string, boolean>
  embeddingModel: string
  isIndexing: boolean
  indexingProgress: { current: number; total: number } | null
  lastRetrievedChunks: { chunk: TextChunk; score: number }[]
  contextWarning: string | null
  /** Retrieval failed on the last send, so the answer was written WITHOUT the
   *  documents (review S4). The old code only logged it, which meant the model
   *  answered from nothing while the user watched a green Docs badge and
   *  believed their PDF had been read. Cleared on the next successful turn. */
  retrievalError: string | null
  pullingEmbeddingModel: boolean
  /** Bytes-level progress for the embedding-model pull (Bug F45-followup,
   *  upgrade-path UX). Populated by useRAG.pullEmbeddingModel from each
   *  Ollama /api/pull stream chunk. `null` while idle. */
  embeddingPullProgress: { completed: number; total: number; status: string } | null
  /** Files the user dropped while the embedding model was still missing —
   *  RAGPanel surfaces an Install-card; after the pull succeeds we replay
   *  these through uploadDocument so the user doesn't have to drag again. */
  embeddingQueuedFiles: File[]
  /** Indicates the next document upload needs the user to confirm the
   *  embedding install first. RAGPanel renders the prompt card; uploads
   *  resume once `embeddingPullProgress` reaches completion. */
  embeddingInstallPrompt: boolean
  chunksLoaded: boolean

  addDocument: (conversationId: string, meta: DocumentMeta) => void
  removeDocument: (conversationId: string, docId: string) => void
  addChunks: (newChunks: TextChunk[]) => void
  getConversationChunks: (conversationId: string) => TextChunk[]
  loadChunksFromDB: (conversationId: string) => Promise<void>
  setRagEnabled: (conversationId: string, enabled: boolean) => void
  setEmbeddingModel: (model: string) => void
  setIndexing: (indexing: boolean) => void
  setIndexingProgress: (progress: { current: number; total: number } | null) => void
  clearConversationDocs: (conversationId: string) => void
  setLastRetrievedChunks: (chunks: { chunk: TextChunk; score: number }[]) => void
  setContextWarning: (warning: string | null) => void
  setRetrievalError: (message: string | null) => void
  setPullingEmbeddingModel: (pulling: boolean) => void
  setEmbeddingPullProgress: (p: { completed: number; total: number; status: string } | null) => void
  setEmbeddingInstallPrompt: (prompt: boolean) => void
  queueEmbeddingFile: (file: File) => void
  clearEmbeddingQueue: () => void
}

export const useRAGStore = create<RAGState>()(
  persist(
    (set, get) => ({
      documents: {},
      chunks: [],
      ragEnabled: {},
      embeddingModel: "nomic-embed-text",
      isIndexing: false,
      indexingProgress: null,
      lastRetrievedChunks: [],
      contextWarning: null,
      retrievalError: null,
      pullingEmbeddingModel: false,
      embeddingPullProgress: null,
      embeddingQueuedFiles: [],
      embeddingInstallPrompt: false,
      chunksLoaded: false,

      addDocument: (conversationId, meta) =>
        set((state) => ({
          documents: {
            ...state.documents,
            [conversationId]: [...(state.documents[conversationId] || []), meta],
          },
        })),

      removeDocument: (conversationId, docId) => {
        // Delete from IndexedDB (fire-and-forget, non-blocking)
        deleteChunks(docId).catch((err) =>
          log.error("Failed to delete chunks from IndexedDB", { err })
        )
        set((state) => ({
          documents: {
            ...state.documents,
            [conversationId]: (state.documents[conversationId] || []).filter(
              (d) => d.id !== docId
            ),
          },
          chunks: state.chunks.filter((c) => c.documentId !== docId),
        }))
      },

      addChunks: (newChunks) => {
        // Persist to IndexedDB grouped by documentId
        const byDoc = new Map<string, TextChunk[]>()
        for (const chunk of newChunks) {
          const existing = byDoc.get(chunk.documentId) || []
          existing.push(chunk)
          byDoc.set(chunk.documentId, existing)
        }
        for (const [docId, chunks] of byDoc) {
          saveChunks(docId, chunks).catch((err) =>
            log.error("Failed to save chunks to IndexedDB", { err })
          )
        }

        set((state) => ({
          chunks: [...state.chunks, ...newChunks],
        }))
      },

      getConversationChunks: (conversationId) => {
        const { documents, chunks } = get()
        const docIds = (documents[conversationId] || []).map((d) => d.id)
        return chunks.filter((c) => docIds.includes(c.documentId))
      },

      loadChunksFromDB: async (conversationId) => {
        const { documents, chunks, chunksLoaded: alreadyLoaded } = get()
        const docs = documents[conversationId] || []
        if (docs.length === 0) return

        // Only load docs whose chunks aren't already in memory
        const loadedDocIds = new Set(chunks.map((c) => c.documentId))
        const missingDocIds = docs
          .map((d) => d.id)
          .filter((id) => !loadedDocIds.has(id))

        if (missingDocIds.length === 0) {
          if (!alreadyLoaded) set({ chunksLoaded: true })
          return
        }

        try {
          const restored = await loadChunks(missingDocIds)
          if (restored.length > 0) {
            set((state) => ({
              chunks: [...state.chunks, ...restored],
              chunksLoaded: true,
            }))
          } else if (!alreadyLoaded) {
            set({ chunksLoaded: true })
          }
        } catch (err) {
          log.error("Failed to load chunks from IndexedDB", { err })
          if (!alreadyLoaded) set({ chunksLoaded: true })
        }
      },

      setRagEnabled: (conversationId, enabled) =>
        set((state) => ({
          ragEnabled: { ...state.ragEnabled, [conversationId]: enabled },
        })),

      setEmbeddingModel: (model) => set({ embeddingModel: model }),

      setIndexing: (indexing) => set({ isIndexing: indexing }),

      setIndexingProgress: (progress) => set({ indexingProgress: progress }),

      clearConversationDocs: (conversationId) => {
        const docIds = (get().documents[conversationId] || []).map((d) => d.id)
        // Delete all from IndexedDB
        for (const docId of docIds) {
          deleteChunks(docId).catch((err) =>
            log.error("Failed to delete chunks from IndexedDB", { err })
          )
        }
        set((state) => ({
          documents: {
            ...state.documents,
            [conversationId]: [],
          },
          chunks: state.chunks.filter((c) => !docIds.includes(c.documentId)),
        }))
      },

      setLastRetrievedChunks: (chunks) => set({ lastRetrievedChunks: chunks }),

      setContextWarning: (warning) => set({ contextWarning: warning }),

      setRetrievalError: (message) => set({ retrievalError: message }),

      setPullingEmbeddingModel: (pulling) => set({ pullingEmbeddingModel: pulling }),

      setEmbeddingPullProgress: (p) => set({ embeddingPullProgress: p }),

      setEmbeddingInstallPrompt: (prompt) => set({ embeddingInstallPrompt: prompt }),

      queueEmbeddingFile: (file) =>
        set((state) => ({ embeddingQueuedFiles: [...state.embeddingQueuedFiles, file] })),

      clearEmbeddingQueue: () => set({ embeddingQueuedFiles: [] }),
    }),
    {
      name: "rag-store",
      partialize: (state) => ({
        documents: state.documents,
        ragEnabled: state.ragEnabled,
        embeddingModel: state.embeddingModel,
      }),
    }
  )
)
