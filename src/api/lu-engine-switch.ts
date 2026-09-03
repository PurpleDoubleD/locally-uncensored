/**
 * Handing the shared local slot to the LU Engine because the user picked one
 * of its models.
 *
 * A14 (2.6.8), David: on a Mac with Ollama as the chat backend, a GGUF in the
 * LU Engine folder is listed now, and Use on it has to do the whole job. Half
 * a job would be worse than the old invisibility: a tile that starts an engine
 * nothing routes to, or a picked model that answers from Ollama.
 *
 * "The LU Engine is not set up at all" is not a separate case. `ProviderId` is
 * a fixed set of four slots and every OpenAI-protocol backend shares the
 * `openai` one, so there is no such thing as adding a fifth entry: taking the
 * slot IS setting the engine up. That is why this goes through the same
 * `slotTakeoverUpdate` the provider card uses, which also leaves the backend
 * it displaces on a standby card with an Enable button, so the way back is the
 * one the user already knows.
 */

import { useLuEngineSwitchStore } from '../stores/luEngineSwitchStore'
import { luEngineSwapInFlight } from './lu-engine-swap-lock'
import { useProviderStore } from '../stores/providerStore'
import { PROVIDER_PRESETS } from './providers/types'
import { slotTakeoverUpdate } from '../lib/openai-slot-handover'
import { LU_ENGINE_NAME } from '../lib/engine-name'
import { displayModelName } from './providers'

/** What the user is told when the pick moved his chat backend. */
export const LU_ENGINE_SWITCH_NOTE = 'Switched your chat provider to the LU Engine for this model.'

/**
 * What a click that ran into the swap bolt says (api/lu-engine-swap-lock).
 *
 * A14 fourth review: the blocked click returned in silence, which reads as a
 * dead button, and a dead button gets clicked again. One short sentence, the
 * same one on the card and in the picker, saying it is a wait and not a
 * refusal.
 */
export const LU_ENGINE_SWAP_BUSY_NOTE = 'The LU Engine is still switching, one moment.'

/**
 * Say it, from whichever door was blocked.
 *
 * A16 (A14-6): the Windows counter-check clicked two LU Engine tiles 150 ms
 * apart and reported that the second click vanished without a word. Two things
 * were behind that. The composer's picker checked its own `selectingLms` first
 * and returned in silence BEFORE it ever reached the bolt that has this
 * sentence, so on that door the line could not appear at all. And the line, on
 * the door where it did appear, was on the ordinary twelve second clock, so it
 * could be gone again while the swap it describes was still running, which is
 * exactly the moment someone looks.
 *
 * One call for both doors now, and the line stands while the swap does.
 */
export function announceLuEngineSwapBusy(): void {
  useLuEngineSwitchStore.getState().announce(LU_ENGINE_SWAP_BUSY_NOTE, 'info', luEngineSwapInFlight)
}

/**
 * The reason behind an `activateBuiltinModel` that answered false.
 *
 * It resolves the GGUF path from the last `list_bundled_models`, refreshes
 * that list once, and only then gives up, so a false here means the file the
 * row stands for is not in the folder any more.
 */
export const LU_ENGINE_FILE_GONE =
  'the file behind that row is not in the LU Engine folder any more. Check Settings, AI Backends, Model Storage.'

/**
 * The one sentence a failed engine start gets, wherever it was triggered.
 *
 * A14 third review: the picker said this and the Installed card said nothing.
 * The card swallowed the failure with `.catch(() => {})`, so a dead
 * llama-server left the slot handed over, the Ollama model already unloaded,
 * and one cheerful line on screen saying the chat provider had moved. Both
 * doors read from here now, so the two cannot drift apart.
 */
export function luEngineStartFailureNote(modelName: string, reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason)
  return `Couldn't start the LU Engine with "${displayModelName(modelName)}": ${text}`
}

/** The shipped address of the engine. The real port is written back by
 *  `syncBuiltinEnginePort` as soon as it starts, exactly as it is for a
 *  takeover from the provider card. */
const FALLBACK_BASE_URL = 'http://127.0.0.1:8127/v1'

/**
 * Make the LU Engine the backend of the shared local slot.
 *
 * Returns true when it was NOT already, which is precisely when the user has
 * to be told. An engine that already holds the slot is left completely alone:
 * writing the same config again would restart the standby bookkeeping and
 * could drop a card that is still owed.
 */
export function ensureLuEngineIsChatProvider(): boolean {
  const { providers, setProviderConfig } = useProviderStore.getState()
  const slot = providers.openai
  if (slot.enabled && slot.managed === true) return false
  const preset = PROVIDER_PRESETS.find((p) => p.id === 'builtin')
  setProviderConfig('openai', slotTakeoverUpdate(slot, {
    name: LU_ENGINE_NAME,
    baseUrl: preset?.baseUrl || FALLBACK_BASE_URL,
    isLocal: true,
    managed: true,
  }))
  return true
}
