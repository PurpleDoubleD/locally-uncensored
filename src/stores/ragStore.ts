import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { DocumentMeta, TextChunk, VectorSearchResult } from "../types/rag"

interface RAGState {
  documents: Record<string, DocumentMeta[]>
  chunks: TextChunk[]
  ragEnabled: Record<string, boolean>
  embeddingModel: string
  isIndexing: boolean
  indexingProgress: { current: number; total: number } | null
  lastRetrievedChunks: { chunk: TextChunk; score: number }[]
  contextWarning: string | null
  pullingEmbeddingModel: boolean

  addDocument: (conversationId: string, meta: DocumentMeta) => void
  removeDocument: (conversationId: string, docId: string) => void
  addChunks: (newChunks: TextChunk[]) => void
  getConversationChunks: (conversationId: string) => TextChunk[]
  setRagEnabled: (conversationId: string, enabled: boolean) => void
  setEmbeddingModel: (model: string) => void
  setIndexing: (indexing: boolean) => void
  setIndexingProgress: (progress: { current: number; total: number } | null) => void
  clearConversationDocs: (conversationId: string) => void
  setLastRetrievedChunks: (chunks: { chunk: TextChunk; score: number }[]) => void
  setContextWarning: (warning: string | null) => void
  setPullingEmbeddingModel: (pulling: boolean) => void
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
      pullingEmbeddingModel: false,

      addDocument: (conversationId, meta) =>
        set((state) => ({
          documents: {
            ...state.documents,
            [conversationId]: [...(state.documents[conversationId] || []), meta],
          },
        })),

      removeDocument: (conversationId, docId) =>
        set((state) => ({
          documents: {
            ...state.documents,
            [conversationId]: (state.documents[conversationId] || []).filter(
              (d) => d.id !== docId
            ),
          },
          chunks: state.chunks.filter((c) => c.documentId !== docId),
        })),

      addChunks: (newChunks) =>
        set((state) => ({
          chunks: [...state.chunks, ...newChunks],
        })),

      getConversationChunks: (conversationId) => {
        const { documents, chunks } = get()
        const docIds = (documents[conversationId] || []).map((d) => d.id)
        return chunks.filter((c) => docIds.includes(c.documentId))
      },

      setRagEnabled: (conversationId, enabled) =>
        set((state) => ({
          ragEnabled: { ...state.ragEnabled, [conversationId]: enabled },
        })),

      setEmbeddingModel: (model) => set({ embeddingModel: model }),

      setIndexing: (indexing) => set({ isIndexing: indexing }),

      setIndexingProgress: (progress) => set({ indexingProgress: progress }),

      clearConversationDocs: (conversationId) =>
        set((state) => {
          const docIds = (state.documents[conversationId] || []).map((d) => d.id)
          return {
            documents: {
              ...state.documents,
              [conversationId]: [],
            },
            chunks: state.chunks.filter((c) => !docIds.includes(c.documentId)),
          }
        }),

      setLastRetrievedChunks: (chunks) => set({ lastRetrievedChunks: chunks }),

      setContextWarning: (warning) => set({ contextWarning: warning }),

      setPullingEmbeddingModel: (pulling) => set({ pullingEmbeddingModel: pulling }),
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
