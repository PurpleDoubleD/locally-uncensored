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
import {
  slotHandbackUpdate, standbyOccupant,
  type HandoverSlot, type SlotOccupant,
} from '../lib/openai-slot-handover'
import { isBuiltinEngineEntry, type InstalledModelLike } from '../lib/lmstudio-match'
import { OpenAIProvider } from './providers/openai-provider'
import type { ProviderModel } from './providers/types'
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

// ── The way back (A16, A14-3a) ──────────────────────────────────────────────
//
// Windows counter-check 02.09.: start the LM Studio server from the picker,
// chat with an LM Studio model, then click an LU Engine tile. From that moment
// the picker shows LU Engine models and nothing else, although LM Studio's
// server is still up on 1234. The card that offers to start it is gone too,
// correctly, because the server is running. The only way back is Settings, AI
// Backends, Providers, Enable on the standby card, and no line anywhere says
// so. The trip out took one click.
//
// So the trip back takes one click as well. While our engine holds the slot,
// the backend it displaced is asked for its models, they keep their own
// heading in the list, and picking one hands the slot back the way the
// standby card's Enable does, with the same sentence in the same status row
// the outward trip uses.

/** What the pick says when it moved the chat backend to `name`. */
export function chatProviderSwitchNote(name: string): string {
  return `Switched your chat provider to ${name} for this model.`
}

/**
 * The local backend waiting beside the slot while the LU Engine holds it, or
 * null when there is none to go back to.
 *
 * Local only, and never a managed one: a cloud backend on standby has nothing
 * to list from a machine that may be offline, and "managed" is us.
 */
export function standbyChatBackend(): SlotOccupant | null {
  const slot = useProviderStore.getState().providers.openai as HandoverSlot
  if (!(slot.enabled && slot.managed === true)) return null
  const waiting = standbyOccupant(slot)
  if (!waiting || !waiting.isLocal || waiting.managed) return null
  return waiting
}

/**
 * Is this row served by the backend on standby rather than by our engine.
 *
 * Both wear `provider: 'openai'`, because that is the one slot every
 * OpenAI-protocol backend shares. The display name is what tells them apart,
 * and it is the same name the standby card carries.
 */
export function isStandbyBackendRow(row: InstalledModelLike | null | undefined): boolean {
  if (!row || row.provider !== 'openai') return false
  if (isBuiltinEngineEntry(row)) return false
  const waiting = standbyChatBackend()
  if (!waiting) return false
  return (row.providerName || '').toLowerCase() === waiting.name.toLowerCase()
}

/**
 * Hand the slot back when the picked row belongs to the backend on standby.
 *
 * Returns the name it went back to, so the caller can say it, or null when
 * this row had nothing to do with the standby backend and everything stays
 * where it is.
 */
export function handBackChatProviderForRow(row: InstalledModelLike | null | undefined): string | null {
  if (!isStandbyBackendRow(row)) return null
  const { providers, setProviderConfig } = useProviderStore.getState()
  const slot = providers.openai as HandoverSlot
  const update = slotHandbackUpdate(slot)
  if (!update) return null
  setProviderConfig('openai', update)
  return update.name ?? null
}

/**
 * The standby backend's own model list, read straight from its server.
 *
 * A one-off client rather than the registry's cached one: the registry is
 * keyed on the slot, and the slot is currently the LU Engine. Nothing is
 * cached, so a server that has gone away since simply throws and the caller
 * adds no rows, which is exactly the old behaviour.
 */
export async function listStandbyBackendModels(occupant: SlotOccupant): Promise<ProviderModel[]> {
  const client = new OpenAIProvider({
    id: 'openai',
    name: occupant.name,
    enabled: true,
    baseUrl: occupant.baseUrl,
    apiKey: '',
    isLocal: occupant.isLocal,
  })
  return client.listModels()
}
