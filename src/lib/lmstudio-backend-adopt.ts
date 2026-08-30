/**
 * Adopting LM Studio as the local chat backend.
 *
 * Round 9 of the 2.6.7 run, Nebenbefund 4 of the R8 re-measure: the chat model
 * picker offers "Start LM Studio Server" over the sentence "Start it to pick
 * LM Studio models here". The button really does start the server (port 1234
 * listens, /v1/models answers), and then nothing appears in the picker,
 * because no provider slot points at LM Studio. The user is left in a dead
 * end with a promise that was only half kept.
 *
 * The picker lists models from the ENABLED provider slots. LM Studio speaks
 * the OpenAI protocol, so it lives in the `openai` slot, exactly like every
 * other openai-compatible local backend. That slot holds the app's built-in
 * engine by default (`managed: true`), which is why the startup auto-detect in
 * AppShell refuses to take it: nobody asked for a backend swap there.
 *
 * Here somebody did ask. Pressing a button labelled "Start LM Studio Server"
 * under a sentence about picking LM Studio models is the user saying what they
 * want, so the click carries the slot with it, through the same
 * setProviderConfig('openai', ...) call the BackendSelector modal uses. No
 * second mechanism, no LM-Studio-only path.
 *
 * The one thing that must not happen quietly is the built-in engine losing its
 * slot without the user knowing. `adoptionReplacesBuiltinEngine` is what the
 * banner asks so it can say so BEFORE the click, and name the way back.
 */

import { PROVIDER_PRESETS, type ProviderConfig } from '../api/providers/types'

/** The shipped LM Studio preset: name and default URL come from one place. */
export const LM_STUDIO_PRESET = PROVIDER_PRESETS.find((p) => p.id === 'lmstudio')!

/** The part of the `openai` slot this decision reads. */
export interface OpenAiSlotView {
  enabled: boolean
  baseUrl: string
  managed?: boolean
}

/** Trailing slashes and case are not a different server. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => (u || '').trim().replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b) && norm(a) !== ''
}

/** Is the slot already pointing at LM Studio (whether enabled or not). */
export function slotPointsAtLmStudio(slot: OpenAiSlotView): boolean {
  return !slot.managed && sameUrl(slot.baseUrl, LM_STUDIO_PRESET.baseUrl)
}

/**
 * Would adopting LM Studio push the app-managed built-in engine out of the
 * slot. The banner states this before the click; nothing else depends on it.
 */
export function adoptionReplacesBuiltinEngine(slot: OpenAiSlotView): boolean {
  return slot.managed === true
}

/**
 * What the `openai` slot has to become so the picker can list LM Studio
 * models. `null` means it already can and the click has nothing to change.
 */
export function lmStudioSlotUpdate(slot: OpenAiSlotView): Partial<ProviderConfig> | null {
  if (slotPointsAtLmStudio(slot)) {
    // Right URL already. Only the enabled flag can still be in the way, and
    // rewriting name/baseUrl here would throw away a user's own label for a
    // second LM Studio port.
    return slot.enabled ? null : { enabled: true }
  }
  return {
    enabled: true,
    name: LM_STUDIO_PRESET.name,
    baseUrl: LM_STUDIO_PRESET.baseUrl,
    isLocal: true,
    // Must be cleared explicitly: left at true the model list would keep
    // reading the bundled GGUFs while the URL points at LM Studio.
    managed: false,
  }
}
