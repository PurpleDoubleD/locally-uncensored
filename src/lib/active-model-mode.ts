import type { AppMode } from '../types/settings'

/**
 * Which chat model may stay selected under the current Local/Cloud switch.
 *
 * Lifted out of AppShell so it can be tested, because it is what lost the
 * user's pick across a restart (Befund 3 of the abnahme counter-check,
 * 2026-08-29: Qwen3 4B was active before the restart, and the picker came
 * back on Hermes). The pick was persisted and rehydrated correctly. The rule
 * then ran on mount against an EMPTY model list, could not find the pick in
 * it, called it out of mode and cleared it. The store's own auto-select then
 * put the first chat model in its place.
 *
 * An empty list is not evidence that a model is gone. It is the absence of
 * evidence, and this rule is re-run the moment the real list lands.
 */
export interface ModeCandidate {
  name: string
  type?: string
  provider?: string
}

export interface ModePick {
  /** Whether the caller has to write anything at all. */
  change: boolean
  /** What to write when it does. null clears the selection on purpose: a
   *  lu-cloud model left active in Local mode kept spending credits after the
   *  switch said Local (Discord 2026-08-09, helpslowlydying). */
  next: string | null
}

/** ComfyUI image/video checkpoints share the model list but are never a chat
 *  model. An unprefixed checkpoint name routes to Ollama and every send
 *  fails with model-not-found. */
function chatCapable(m: ModeCandidate): boolean {
  return m.type !== 'image' && m.type !== 'video'
}

export function pickForMode(
  activeModel: string | null,
  models: ModeCandidate[],
  appMode: AppMode,
): ModePick {
  // Nothing to judge against. THE guard: without it, the mount-time run of
  // this rule wipes a perfectly good persisted pick.
  if (models.length === 0) return { change: false, next: activeModel }

  const wanted = (m: ModeCandidate) =>
    chatCapable(m) && (appMode === 'cloud' ? m.provider === 'lu-cloud' : m.provider !== 'lu-cloud')

  const current = activeModel ? models.find((m) => m.name === activeModel) : undefined
  if (current && wanted(current)) return { change: false, next: activeModel }

  const fallback = models.find(wanted)
  if (activeModel === null && !fallback) return { change: false, next: null }
  return { change: true, next: fallback ? fallback.name : null }
}
