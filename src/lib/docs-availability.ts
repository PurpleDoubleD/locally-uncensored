/**
 * Who gets the Docs button, and when it can be pressed.
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
 * The rule below asks the right one. Local mode is untouched. Cloud mode shows
 * the button and lets the missing part, if any, say so in a tooltip instead of
 * hiding the feature and leaving the user to guess.
 */
import type { AppMode } from '../types/settings'

export interface DocsAvailability {
  /** Render the button at all. Always true now, which is the fix. */
  visible: boolean
  /** Clickable. False only in Cloud mode with no embedding backend on the box. */
  enabled: boolean
  /** The button's tooltip. Carries the reason when disabled, and the privacy
   *  statement when Cloud mode is about to send passages upstream. */
  title: string
}

/** Local mode, and Cloud mode before the probe answers. */
export const DOCS_TITLE_PLAIN = 'Document Chat (RAG)'

/**
 * Cloud mode with a working embedding lane. It says where the files stay,
 * because in Cloud mode that is a fair question and the answer is good news:
 * indexing runs on this machine, and only the passages that match the question
 * travel with the prompt.
 */
export const DOCS_TITLE_CLOUD =
  'Document Chat (RAG). Your files are indexed on this computer and stay here. ' +
  'Only the passages that match your question are sent to the cloud model as context.'

/** Cloud mode with no embedding backend. The exact wording David asked for. */
export const DOCS_TITLE_NO_EMBEDDINGS = 'Documents need the local embeddings engine'

/**
 * @param appMode  the global Local/Cloud switch
 * @param embedReady  result of the embedding-lane probe, or `null` while it is
 *   still running. Unknown counts as available on purpose: a button that starts
 *   dead and comes alive a moment later reads as broken, and the RAG panel
 *   carries its own install card for the case the probe then says no.
 */
export function docsAvailability(appMode: AppMode, embedReady: boolean | null): DocsAvailability {
  if (appMode !== 'cloud') {
    return { visible: true, enabled: true, title: DOCS_TITLE_PLAIN }
  }
  if (embedReady === false) {
    return { visible: true, enabled: false, title: DOCS_TITLE_NO_EMBEDDINGS }
  }
  return {
    visible: true,
    enabled: true,
    title: embedReady === true ? DOCS_TITLE_CLOUD : DOCS_TITLE_PLAIN,
  }
}
