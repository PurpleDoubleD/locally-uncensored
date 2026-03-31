import { useCallback, useEffect } from "react"
import { useRAGStore } from "../stores/ragStore"
import { indexDocument, retrieveContext } from "../api/rag"
import { getModelContext, listModels, pullModel } from "../api/ollama"
import { useModelStore } from "../stores/modelStore"
import type { DocumentMeta, RAGContext } from "../types/rag"

export function useRAG(conversationId: string | null) {
  const documents = useRAGStore((s) =>
    conversationId ? s.documents[conversationId] || [] : []
  )
  const isEnabled = useRAGStore((s) =>
    conversationId ? s.ragEnabled[conversationId] ?? false : false
  )
  const isIndexing = useRAGStore((s) => s.isIndexing)
  const indexingProgress = useRAGStore((s) => s.indexingProgress)
  const contextWarning = useRAGStore((s) => s.contextWarning)
  const pullingEmbeddingModel = useRAGStore((s) => s.pullingEmbeddingModel)

  // Check context window when RAG is toggled on or documents change
  useEffect(() => {
    if (!isEnabled || !conversationId) {
      useRAGStore.getState().setContextWarning(null)
      return
    }

    const checkContextWindow = async () => {
      const activeModel = useModelStore.getState().activeModel
      if (!activeModel) return

      try {
        const ctxLen = await getModelContext(activeModel)
        if (ctxLen <= 2048) {
          useRAGStore.getState().setContextWarning(
            `Your model's context window is only ${ctxLen} tokens. RAG works best with 4096+ tokens. Run: ollama run ${activeModel} /set parameter num_ctx 8192`
          )
        } else {
          useRAGStore.getState().setContextWarning(null)
        }
      } catch {
        // Silently fail context check
      }
    }

    checkContextWindow()
  }, [isEnabled, conversationId, documents.length])

  const uploadDocument = useCallback(
    async (file: File): Promise<DocumentMeta | null> => {
      if (!conversationId) return null

      const { embeddingModel, setIndexing, setIndexingProgress, addDocument, addChunks, setPullingEmbeddingModel } =
        useRAGStore.getState()

      try {
        // Check if embedding model exists, auto-pull if missing
        const models = await listModels()
        const hasEmbedding = models.some(
          (m) => m.name === embeddingModel || m.name === embeddingModel + ":latest"
        )

        if (!hasEmbedding) {
          const shouldPull = window.confirm(
            `The embedding model "${embeddingModel}" is not installed. Download it now? (~274MB)`
          )
          if (!shouldPull) {
            throw new Error("Embedding model not available")
          }

          setPullingEmbeddingModel(true)
          try {
            const pullRes = await pullModel(embeddingModel)
            const reader = pullRes.body?.getReader()
            if (reader) {
              const decoder = new TextDecoder()
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                // Parse streaming pull progress (for logging)
                const text = decoder.decode(value, { stream: true })
                for (const line of text.split("\n").filter(Boolean)) {
                  try {
                    const json = JSON.parse(line)
                    if (json.status) console.log("[EmbeddingPull]", json.status)
                  } catch { /* skip non-JSON lines */ }
                }
              }
            }
          } finally {
            setPullingEmbeddingModel(false)
          }
        }

        setIndexing(true)
        setIndexingProgress({ current: 0, total: 1 })

        const { meta, chunks } = await indexDocument(file, embeddingModel)

        addDocument(conversationId, meta)
        addChunks(chunks)
        setIndexingProgress({ current: 1, total: 1 })

        return meta
      } catch (err) {
        console.error("Failed to index document:", err)
        throw err
      } finally {
        setIndexing(false)
        setIndexingProgress(null)
      }
    },
    [conversationId]
  )

  const removeDoc = useCallback(
    (docId: string) => {
      if (!conversationId) return
      useRAGStore.getState().removeDocument(conversationId, docId)
    },
    [conversationId]
  )

  const toggleRAG = useCallback(() => {
    if (!conversationId) return
    const { ragEnabled, setRagEnabled } = useRAGStore.getState()
    setRagEnabled(conversationId, !ragEnabled[conversationId])
  }, [conversationId])

  const getContextForQuery = useCallback(
    async (query: string): Promise<RAGContext | null> => {
      if (!conversationId) return null

      const { getConversationChunks, embeddingModel } = useRAGStore.getState()
      const chunks = getConversationChunks(conversationId)

      if (chunks.length === 0) return null

      const { context } = await retrieveContext(query, chunks, embeddingModel)
      return context
    },
    [conversationId]
  )

  return {
    documents,
    isEnabled,
    isIndexing,
    indexingProgress,
    contextWarning,
    pullingEmbeddingModel,
    uploadDocument,
    removeDocument: removeDoc,
    toggleRAG,
    getContextForQuery,
  }
}
