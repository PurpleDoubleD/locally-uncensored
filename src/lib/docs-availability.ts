/**
 * Who gets the Docs button, how it looks, and what its tooltip may honestly say.
 *
 * A9 (aldrich_ironhart, Discord #general 2026-09-01): "There's no document tab
 * in cloud chat to add documents and audio clips". He was right, and the
 * reason it was missing did not hold up. Document Chat needs an EMBEDDING
 * backend, not a chat backend, and the embedding backend is the bundled
 * llama-server on 127.0.0.1:8128, which the app starts and resumes without ever
 * asking what appMode says (useModels.resumeEmbedServer). Retrieval then puts
 * the matching passages into the system prompt (lib/rag-prompt.ts), and a
 * system prompt is the one thing every provider takes. So nothing about Cloud
 * mode stops Document Chat; the button was hidden on the wrong question.
 *
 * Two things the first cut got wrong, both from the review of 2026-09-02:
 *
 * B1. A missing embedding lane disabled the button, and the RAG panel is the
 *     only place that can INSTALL an embedding lane (its install card drives
 *     useRAG.installEmbeddingAndDrainQueue). Disabling the only door to the
 *     repair shop left anyone who onboarded the built-in engine without the
 *     embeddings step in a cloud-mode dead end, while local mode let them in.
 *     So the button stays pressable and carries a third state instead:
 *     `needsSetup`, damped, and a click opens the panel with the install card.
 *
 * B2. "Your documents stay on this computer" is not true on every lane.
 *     Ollama's base URL is user-configurable, and indexing sends EVERY chunk of
 *     a document to it, not just the passages a question matches. On a LAN or
 *     remote Ollama the sentence has to name the host instead of promising the
 *     opposite of what happens.
 */
import type { AppMode } from '../types/settings'
import type { EmbedLane, EmbedLaneInfo } from '../api/embed-availability'

export interface DocsAvailability {
  /** Render the button at all. Always true now, which is the fix. */
  visible: boolean
  /** Pressable. Also always true: the panel behind it is the repair shop (B1). */
  enabled: boolean
  /** No embedding lane yet. Damped look, and the click goes to the install card. */
  needsSetup: boolean
  /** The measured lane, or null in local mode and while the probe is running. */
  lane: EmbedLane | null
  /** The button's tooltip. */
  title: string
}

/** Local mode, and Cloud mode before the probe answers. */
export const DOCS_TITLE_PLAIN = 'Document Chat (RAG)'

/** Cloud mode, indexing on this machine. Short on purpose (review N2); the
 *  panel carries the full statement once it is open. */
export const DOCS_TITLE_CLOUD_LOCAL =
  'Document Chat (RAG). Files stay on this computer, only matching passages go to the cloud model.'

/** Cloud mode, indexing on a remote Ollama. Names the host, because that is
 *  where whole documents would go (B2). */
export function docsTitleRemote(endpoint: string | null): string {
  return `Document Chat (RAG). Indexing runs on ${endpoint ?? 'your configured Ollama host'}, so whole documents are sent there. Matching passages then go to the cloud model.`
}

/** No embedding lane. The wording David asked for, plus the way out. */
export const DOCS_TITLE_NO_EMBEDDINGS =
  'Documents need the local embeddings engine. Click to install it.'

/**
 * @param appMode  the global Local/Cloud switch
 * @param info  the measured embedding lane, or `null` while the probe is still
 *   running (and always in local mode, which does not measure). Unknown counts
 *   as fine on purpose: a button that starts damped and settles a moment later
 *   reads as flicker, and nothing is lost because the panel behind it is the
 *   same panel either way.
 */
export function docsAvailability(
  appMode: AppMode,
  info: EmbedLaneInfo | null,
): DocsAvailability {
  if (appMode !== 'cloud') {
    return { visible: true, enabled: true, needsSetup: false, lane: null, title: DOCS_TITLE_PLAIN }
  }
  if (info === null) {
    return { visible: true, enabled: true, needsSetup: false, lane: null, title: DOCS_TITLE_PLAIN }
  }
  const base = { visible: true as const, enabled: true as const, lane: info.lane }
  switch (info.lane) {
    case 'none':
      return { ...base, needsSetup: true, title: DOCS_TITLE_NO_EMBEDDINGS }
    case 'ollama-remote':
      return { ...base, needsSetup: false, title: docsTitleRemote(info.endpoint) }
    default:
      return { ...base, needsSetup: false, title: DOCS_TITLE_CLOUD_LOCAL }
  }
}
