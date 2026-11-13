/**
 * A22 (Discord, 12.11.2026): a vision model said "This model
 * can't read images".
 *
 * Gemma 4 12B Abliterated can read images, and its image part (the mmproj
 * GGUF llama.cpp needs for that) was on disk. The LU Engine was running the
 * model WITHOUT it: either the start found no room for the part on the
 * graphics card (engine.rs IMAGE_PART_NO_ROOM_NOTE), the part could not be
 * loaded, or the engine was started before the part was downloaded. The
 * server then refused the picture, and the chat blamed the model. A restart
 * of the engine fixed it, which nobody could guess from that sentence.
 *
 * So, for the managed LU Engine only:
 *   1. Before a send that carries a picture, the loaded model is asked
 *      whether it runs with its image part. When the part is on disk but not
 *      loaded, the engine is restarted with it first (a fresh start plans
 *      the memory again and takes the part when it fits).
 *   2. When the server still refuses, the message names the true reason:
 *      the part is not loaded (and why), or it is not installed at all.
 *
 * Everything else (Ollama, LM Studio, cloud models) keeps the old message.
 */
import { backendCall } from './backend'
import { listBundledModels, stopBundledEngine, swapBundledModel } from './engine'
import { bareBuiltinModelName } from '../lib/builtin-model-identity'
import { preservedSwapCtx } from '../lib/builtin-ctx'
import { useSettingsStore } from '../stores/settingsStore'
import { MULTIMODAL_UNSUPPORTED_MESSAGE } from '../lib/ollama-errors'
import { imagePartNotLoadedSentence, imagePartReloadedSentence, noImagePartSentence } from '../lib/image-part-notes'
import { useProviderStore } from '../stores/providerStore'
import { log } from '../lib/logger'

export type ImagePartState =
  /** Not the managed LU Engine, not loaded, or a backend too old to say. */
  | { kind: 'unknown' }
  | { kind: 'sees'; model: string }
  /** The model has no image part installed next to it. */
  | { kind: 'no-part'; model: string }
  /** The part is on disk, the running engine was started without it. */
  | { kind: 'not-loaded'; model: string; path: string; note: string | null; ctx: number | null; ctxTrain: number | null }

/**
 * A reload that did not bring the part up, per model file. The next picture
 * within this time does not restart the engine again: the card has no more
 * room than a minute ago, and a restart per picture would be a loop.
 */
const RETRY_AFTER_MS = 10 * 60_000
const failedReloads = new Map<string, number>()

/** Test-only. */
export function __resetImagePartReloads(): void {
  failedReloads.clear()
}

function managedEngineModel(modelName: string): string | null {
  const parts = modelName.split('::')
  if (parts.length === 2 && parts[0] !== 'openai') return null
  const cfg = useProviderStore.getState().providers.openai
  if (!cfg?.enabled || cfg.managed !== true) return null
  return bareBuiltinModelName(modelName) || null
}

export async function imagePartState(modelName: string | null | undefined): Promise<ImagePartState> {
  const bare = modelName ? managedEngineModel(modelName) : null
  if (!bare) return { kind: 'unknown' }
  try {
    const models = await listBundledModels()
    const m = models.find((x) => x.name === bare)
    if (!m || !m.loaded || typeof m.vision !== 'boolean' || typeof m.imagePart !== 'boolean') return { kind: 'unknown' }
    if (m.vision) return { kind: 'sees', model: m.name }
    if (!m.imagePart) return { kind: 'no-part', model: m.name }
    const status = await backendCall<{ imageNote?: string | null; ctx?: number | null; ctxRequested?: number | null }>('bundled_engine_status').catch(() => null)
    return {
      kind: 'not-loaded',
      model: m.name,
      path: m.path,
      note: status?.imageNote ?? null,
      ctx: status?.ctxRequested ?? status?.ctx ?? null,
      ctxTrain: m.ctx_train ?? null,
    }
  } catch {
    return { kind: 'unknown' }
  }
}

/**
 * Restart the engine with the same model so it takes its image part again.
 * Returns the state after the restart: `sees` when it worked.
 */
export async function reloadWithImagePart(state: Extract<ImagePartState, { kind: 'not-loaded' }>): Promise<ImagePartState> {
  const failedAt = failedReloads.get(state.path)
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_MS) return state
  log.info('engine.image_part_reload', { model: state.model, note: state.note })
  // The same tuning a self-heal uses, and the context the engine holds now,
  // so the reload changes nothing but the image part (lib/builtin-ctx).
  const settingsTuning = useSettingsStore.getState().settings.builtinEngine
  const keepCtx = preservedSwapCtx({
    tuningCtx: settingsTuning?.ctx,
    tuningChosen: settingsTuning?.ctxChosen,
    currentCtx: state.ctx,
    ctxTrain: state.ctxTrain,
  })
  const tuning = keepCtx ? { ...(settingsTuning ?? {}), ctx: keepCtx } : settingsTuning
  try {
    // An engine pinned as running without its part answers a start for the
    // same model with "already running" (engine.rs, argv idempotence). Only a
    // stopped engine plans the memory again and takes the part when it fits.
    if (state.note) await stopBundledEngine()
    await swapBundledModel(state.path, tuning)
  } catch (err) {
    log.warn('engine.image_part_reload_failed', { model: state.model, err: String(err) })
    failedReloads.set(state.path, Date.now())
    return state
  }
  const after = await imagePartState(state.model)
  log.info('engine.image_part_reloaded', { model: state.model, sees: after.kind === 'sees' })
  if (after.kind === 'sees') {
    failedReloads.delete(state.path)
    return after
  }
  failedReloads.set(state.path, Date.now())
  return after.kind === 'not-loaded' ? after : state
}

/**
 * Before a send with a picture: make sure the loaded model runs with its
 * image part. Quiet and cheap when there is nothing to do; never throws.
 * `onReload` is told before the restart starts, so the caller can say so.
 */
export async function ensureImagePartLoaded(modelName: string | null | undefined, onReload?: (model: string) => void): Promise<ImagePartState> {
  const state = await imagePartState(modelName)
  if (state.kind !== 'not-loaded') return state
  onReload?.(state.model)
  return reloadWithImagePart(state)
}

/** The sentence a refused picture gets, with the true reason when we know it. */
export function imagePartRefusalMessage(state: ImagePartState): string {
  switch (state.kind) {
    case 'no-part':
      return noImagePartSentence(state.model)
    case 'not-loaded':
      return imagePartNotLoadedSentence(state.model, state.note)
    case 'sees':
      return imagePartReloadedSentence(state.model)
    default:
      return MULTIMODAL_UNSUPPORTED_MESSAGE
  }
}

/**
 * After the server refused a picture: find out why, try the reload once,
 * and return the sentence for the chat.
 */
export async function explainImageRefusal(modelName: string | null | undefined): Promise<string> {
  const state = await imagePartState(modelName)
  if (state.kind === 'not-loaded') return imagePartRefusalMessage(await reloadWithImagePart(state))
  if (state.kind === 'sees') return MULTIMODAL_UNSUPPORTED_MESSAGE
  return imagePartRefusalMessage(state)
}
