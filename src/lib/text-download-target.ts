/**
 * Where a chat-model (GGUF) download from Models, Discover has to land, and
 * which backend has to load it afterwards.
 *
 * GH #118 (nayffy, 2026-08-27, fresh Windows 11 install, v2.6.6): the answer
 * used to be derived from the ACTIVE chat model alone. On a fresh install
 * there is no active chat model yet, so every branch missed and the code fell
 * through to the legacy "whichever backend is enabled" rule. With the shipped
 * defaults (built-in engine on, Ollama off, LM Studio absent) that rule picked
 * the LM Studio flow: the GGUF was written into
 * `<app models dir>/<user>/<repo>/`, and `list_bundled_models` scans the app
 * models dir NON-recursively, so the finished download was invisible to chat.
 * Nothing called `start_bundled_engine` either, so 127.0.0.1:8127 stayed dead
 * and the Built-in Engine test in Settings answered ERR_CONNECTION_REFUSED.
 * Three symptoms, one missing branch.
 *
 * Pure on purpose: the routing decision is the part that was wrong, so it is
 * the part that gets unit tests.
 */

export type TextDownloadTarget =
  /** `ollama pull` into Ollama's own blob store. */
  | 'ollama'
  /** Flat write into the app-owned models dir, then boot llama-server on it. */
  | 'builtin'
  /** Nested `<user>/<repo>` write into LM Studio's scan dir. */
  | 'lmstudio'
  /** Some other OpenAI-compatible server the user configured themselves. */
  | 'openai-compat'

export interface TextDownloadTargetInput {
  /** `useModelStore.activeModel`: `<providerId>::<id>`, a bare Ollama tag, or null. */
  activeChatModel?: string | null
  openai?: { enabled?: boolean; managed?: boolean; name?: string } | null
  ollamaEnabled?: boolean
}

function isLmStudioName(name?: string): boolean {
  return (name || '').toLowerCase().includes('lm studio')
}

/** Provider id encoded in an active model name, or null for a bare Ollama tag. */
function providerIdOf(activeChatModel?: string | null): string | null {
  if (!activeChatModel) return null
  return activeChatModel.includes('::') ? activeChatModel.split('::')[0] : 'ollama'
}

/**
 * Resolve the download target.
 *
 * Rule 1, unchanged: an active chat model on a LOCAL backend decides, because
 * the file has to land where the picker the user is already looking at can see
 * it (Bug Y/a, Aldrich Ironhart, v2.5.0).
 *
 * Rule 2, the #118 fix: with no active local chat model, the app's OWN engine
 * wins whenever its slot is enabled and managed. A GGUF only runs locally, and
 * the built-in engine is the one local backend that is guaranteed to be there.
 * Choosing Ollama in onboarding disables the managed slot, so an Ollama user
 * never reaches this branch.
 */
export function resolveTextDownloadTarget(input: TextDownloadTargetInput): TextDownloadTarget {
  const { openai, ollamaEnabled } = input
  const active = providerIdOf(input.activeChatModel)
  const managedBuiltin = !!openai?.enabled && openai?.managed === true

  if (active === 'ollama') return 'ollama'
  if (active === 'openai') {
    if (openai?.managed) return 'builtin'
    return isLmStudioName(openai?.name) ? 'lmstudio' : 'openai-compat'
  }

  // No active model, or an active CLOUD model (anthropic / lu-cloud): a GGUF
  // cannot run there, so the local destination is decided on its own.
  if (managedBuiltin) return 'builtin'
  if (openai?.enabled && isLmStudioName(openai?.name)) return 'lmstudio'
  if (ollamaEnabled) return 'ollama'
  if (openai?.enabled) return 'openai-compat'
  // Nothing local is enabled at all. The bundled engine is the only backend
  // this app can promise, so send the file to its folder rather than to a
  // directory no installed program reads.
  return 'builtin'
}
