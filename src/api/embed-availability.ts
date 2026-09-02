/**
 * Can this machine embed a document right now.
 *
 * One question, one answer, for every surface that needs it: the RAG upload
 * pre-flight (hooks/useRAG), the RAG panel's install card, and the Docs button
 * in the composer (hooks/useDocsAvailability). It lived inside useRAG before
 * A9, which is why the composer could not ask it and hid the button on
 * `appMode === 'cloud'` instead.
 *
 * It asks the lane that will ACTUALLY run (api/rag.ts routes the same way):
 * the bundled embeddings server whenever it is up or the built-in engine is the
 * backend, Ollama otherwise. Asking Ollama on a built-in-engine box was the
 * 2026-08-15 bug. Ollama had nomic-embed-text pulled, the bundled lane had no
 * embedding GGUF at all, and nobody asked the lane that ran.
 *
 * Nothing here reads appMode. The embeddings server is a local sidecar and the
 * app resumes it in Cloud mode too (useModels.resumeEmbedServer).
 */
import {
  isManagedBuiltinActive,
  bundledEmbedStatus,
  bundledEmbedLaneReady,
} from './engine'
import { checkConnection, listModels } from './ollama'

/**
 * True when the bundled lane can serve indexing without Ollama: its server is
 * up, or the built-in engine is active and an embedding GGUF is installed for
 * it (`bundledEmbedLaneReady`, the same question rag.ts answers when it routes).
 */
export async function builtinEmbedReady(): Promise<boolean> {
  if (!isManagedBuiltinActive()) {
    try {
      return (await bundledEmbedStatus()).running
    } catch {
      return false
    }
  }
  return bundledEmbedLaneReady()
}

/**
 * True when SOME embedding backend on this machine can index a document.
 *
 * False when missing, and callers then surface the in-app install prompt (RAG panel) or
 * a tooltip (Docs button) rather than blocking.
 */
export async function embeddingBackendReady(embeddingModel: string): Promise<boolean> {
  if (await builtinEmbedReady()) return true
  // The bundled lane is the only one rag.ts will use here, so a pulled Ollama
  // model is not an answer to this question.
  if (isManagedBuiltinActive()) return false
  if (!(await checkConnection())) return false
  try {
    const models = await listModels()
    return models.some(
      (m) => m.name === embeddingModel || m.name === embeddingModel + ':latest',
    )
  } catch {
    return false
  }
}
