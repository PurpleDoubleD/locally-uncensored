/**
 * Can this machine embed a document right now, and WHERE would the text go.
 *
 * One question, one answer, for every surface that needs it: the RAG upload
 * pre-flight (hooks/useRAG), the RAG panel's install card and privacy line, and
 * the Docs button in the composer (hooks/useEmbedLane). It lived inside useRAG
 * before A9, which is why the composer could not ask it and hid the button on
 * `appMode === 'cloud'` instead.
 *
 * It asks the lane that will ACTUALLY run (api/rag.ts routes the same way):
 * the bundled embeddings server whenever it is up or the built-in engine is the
 * backend, Ollama otherwise. Asking Ollama on a built-in-engine box was the
 * 2026-08-15 bug. Ollama had nomic-embed-text pulled, the bundled lane had no
 * embedding GGUF at all, and nobody asked the lane that ran.
 *
 * The lane, not just a yes/no, because the honest sentence depends on it.
 * Ollama's base URL is user-configurable (GUI `set_ollama_host`, or OLLAMA_HOST
 * at startup), so "your documents stay on this computer" is simply false when
 * the user pointed LU at a LAN box: indexing sends EVERY chunk of every
 * document to that host, not just the passages that match a question. Review
 * finding B2, 2026-09-02.
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
import { getOllamaBase, isOllamaLocal } from './backend'

/**
 * Where indexing would send the text.
 *
 * - `bundled`       the app's own llama-server on 127.0.0.1:8128. Never leaves the box.
 * - `ollama-local`  Ollama on loopback. Never leaves the box either.
 * - `ollama-remote` Ollama on a LAN or remote host the user configured. The
 *                   whole document goes there to be indexed.
 * - `none`          nothing can embed. The panel offers the install.
 */
export type EmbedLane = 'bundled' | 'ollama-local' | 'ollama-remote' | 'none'

export interface EmbedLaneInfo {
  lane: EmbedLane
  /** The host the text would travel to, set only for `ollama-remote`. */
  endpoint: string | null
}

/** True when the lane can index. The three working lanes all can. */
export function laneCanEmbed(lane: EmbedLane): boolean {
  return lane !== 'none'
}

/** True when the text never leaves this machine. */
export function laneIsOnThisMachine(lane: EmbedLane): boolean {
  return lane === 'bundled' || lane === 'ollama-local'
}

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
 * Which lane would index a document right now, and where it points.
 *
 * `none` when missing, and callers then surface the in-app install prompt (RAG
 * panel) or the needs-setup state on the Docs button, rather than blocking.
 */
export async function embeddingLane(embeddingModel: string): Promise<EmbedLaneInfo> {
  if (await builtinEmbedReady()) return { lane: 'bundled', endpoint: null }
  // The bundled lane is the only one rag.ts will use here, so a pulled Ollama
  // model is not an answer to this question.
  if (isManagedBuiltinActive()) return { lane: 'none', endpoint: null }
  if (!(await checkConnection())) return { lane: 'none', endpoint: null }
  try {
    const models = await listModels()
    const has = models.some(
      (m) => m.name === embeddingModel || m.name === embeddingModel + ':latest',
    )
    if (!has) return { lane: 'none', endpoint: null }
    return isOllamaLocal()
      ? { lane: 'ollama-local', endpoint: null }
      : { lane: 'ollama-remote', endpoint: getOllamaBase() }
  } catch {
    return { lane: 'none', endpoint: null }
  }
}

/**
 * True when SOME embedding backend on this machine can index a document.
 * Kept as the narrow question the upload pre-flight asks.
 */
export async function embeddingBackendReady(embeddingModel: string): Promise<boolean> {
  return laneCanEmbed((await embeddingLane(embeddingModel)).lane)
}
