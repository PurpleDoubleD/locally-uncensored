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
import { useModelStore } from '../stores/modelStore'
import {
  slotHandbackUpdate, standbyOccupant,
  type HandoverSlot, type SlotOccupant,
} from '../lib/openai-slot-handover'
import { isRowOfBackend, type InstalledModelLike } from '../lib/lmstudio-match'
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
 * The other wait behind the same blocked pick.
 *
 * A16 counter-check follow-up: the picker answers "something is already going
 * on" with one sentence, and one of the three conditions it asks about is not
 * about our engine at all. `selectingLms` / `togglingLms` with no LU Engine
 * swap running is LM Studio warming a model of its own, and telling the user
 * that "The LU Engine is still switching" then describes something that is not
 * happening. Someone who reads it goes looking for an engine swap he never
 * started.
 *
 * No `holdWhile` here: the condition it describes lives in the picker's own
 * component state, which this module cannot see, and an LM Studio load is a
 * request over a socket rather than a cold GGUF off disk, so the ordinary
 * twelve second clock is the right length for it.
 */
export const LM_STUDIO_LOAD_BUSY_NOTE = 'LM Studio is still loading a model, one moment.'

export function announceLmStudioLoadBusy(): void {
  useLuEngineSwitchStore.getState().announce(LM_STUDIO_LOAD_BUSY_NOTE, 'info')
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

/**
 * Write that sentence where it survives, and hand it back for the door it
 * came through.
 *
 * Persona P5 measured this on the real Windows build on 03.09.2026: a click on
 * a broken GGUF, then the picker closed after two seconds, the way a person
 * uses it. The chat was without an engine for 7,4 seconds, two processes
 * started and died, and for 75 seconds the page did not gain a single line of
 * text. The failure was written into the dropdown only, and the dropdown was
 * gone. The answer arrives 12 to 21 seconds after the click, so "the user is
 * still looking at it" is not an assumption this app may make.
 *
 * The standing row above the composer is where it goes now, the same row the
 * switch note uses, and an 'error' there has no self-clearing timer.
 * `switched` folds in the sentence about the moved backend, because a start
 * that failed after the slot was handed over is exactly when both facts
 * matter.
 */
export function announceLuEngineStartFailure(
  modelName: string, reason: unknown, switched: boolean,
): string {
  const line = luEngineStartFailureNote(modelName, reason)
  const full = switched ? `${LU_ENGINE_SWITCH_NOTE} ${line}` : line
  useLuEngineSwitchStore.getState().announce(full, 'error')
  return full
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

/**
 * What the standing row says when the app picked a different chat model on its
 * own, because the one that was active left the list (G1, 04.09.2026: taking
 * the LM Studio provider back out).
 */
export function chatModelReplacedNote(gone: string, now: string): string {
  return `"${displayModelName(gone)}" is gone from the model list, so the chat switched to "${displayModelName(now)}".`
}

export function announceChatModelReplaced(gone: string, now: string): void {
  useLuEngineSwitchStore.getState().announce(chatModelReplacedNote(gone, now), 'info')
}

/** What the pick says when it moved the chat backend to `name`. */
export function chatProviderSwitchNote(name: string): string {
  return `Switched your chat provider to ${name} for this model.`
}

/**
 * Wie lange die Zeile hoechstens auf ihre eigene Wahrheit wartet.
 *
 * Der Halt endet normalerweise damit, dass die Wahl ankommt. Kommt sie nie an,
 * weil das Laden im fremden Backend gescheitert ist, darf die Zeile trotzdem
 * nicht ewig stehen bleiben. Grosszuegig gegenueber jedem echten Ladevorgang,
 * gemessen wurden 12,4 s auf der Box, und weit unter einer Sitzung.
 */
export const CHAT_PROVIDER_SWITCH_HOLD_MS = 45_000

/**
 * Den Providerwechsel ansagen, und zwar so lange, bis er auch stimmt.
 *
 * Gegenprobe G1, 04.09.2026, gemessen im echten Windows-Build: Klick auf eine
 * LM-Studio-Zeile, waehrend die LU Engine bedient. Der Satz erscheint nach
 * 0,17 s, ist bis 12,04 s zu sehen und ist bei 12,44 s weg. Bei 12,44 s
 * springt der Waehlerknopf auf das neue Modell und Port 8127 schliesst. Der
 * Satz stand also genau so lange auf dem Schirm, wie er noch nicht stimmte,
 * und verschwand in der Sekunde, in der er wahr wurde.
 *
 * Der Grund war die gewoehnliche Zwoelf-Sekunden-Uhr auf einem Vorgang, der
 * laenger dauert als sie. `holdWhile` haelt die Zeile stehen, solange die
 * Wahl noch nicht angekommen ist, und laesst danach die normale Uhr laufen,
 * sodass der Nutzer sie liest, wenn sie zutrifft.
 */
export function announceChatProviderSwitch(name: string, modelName: string): void {
  useLuEngineSwitchStore.getState().announce(
    chatProviderSwitchNote(name), 'info',
    haltenBis(() => useModelStore.getState().activeModel !== modelName),
  )
}

/**
 * Eine Zeile halten, solange sie noch nicht stimmt, aber nicht ewig.
 *
 * Die Frist wird beim Ansagen festgelegt, nicht bei jeder Abfrage, sonst
 * verschiebt sie sich mit jedem Blick und die Zeile bliebe fuer immer stehen.
 */
function haltenBis(pruefung: () => boolean): () => boolean {
  const frist = Date.now() + CHAT_PROVIDER_SWITCH_HOLD_MS
  return () => Date.now() < frist && pruefung()
}

/**
 * Den Wechsel auf die LU Engine ansagen, und zwar so lange, bis er stimmt.
 *
 * Nachpruefung G3, 04.09.2026, zweimal am echten Build gemessen: der Satz kam
 * nach 15 bzw. 18 ms, ging nach 12,3 s, und wahr wurde er erst nach 16,4 bzw.
 * 16,8 s. Also verschwand er rund vier Sekunden BEVOR er zutraf. Der Grund war
 * dieselbe Zwoelf-Sekunden-Uhr, die `announceChatProviderSwitch` schon einmal
 * zu frueh eingeholt hat, nur auf dem anderen Weg.
 *
 * Was hier die Wahrheit sagt, ist der Riegel: er wird genommen, bevor der Swap
 * beginnt, und erst freigegeben, wenn `activateBuiltinModel` zurueck ist. Die
 * Wahl im Store taugt dafuer NICHT, die steht schon nach Millisekunden.
 */
export function announceLuEngineSwitch(): void {
  useLuEngineSwitchStore.getState().announce(
    LU_ENGINE_SWITCH_NOTE, 'info', haltenBis(luEngineSwapInFlight),
  )
}

/**
 * Eine stehende Fehlerzeile raeumen, weil der Nutzer sich daraus befreit hat.
 *
 * Eine Fehlerzeile hat absichtlich keine Uhr: sie verlangt eine Handlung, und
 * eine Zeile, die vor der Handlung weggeht, hat ihre Aufgabe verfehlt. Nur
 * hatte sie danach auch keinen Ausgang ausser dem x. Die Nachpruefung G3 hat
 * am 04.09.2026 ein Banner ueber zwoelf Minuten stehen sehen, ueber jeden
 * Ansichtswechsel hinweg, lange nachdem der Nutzer laengst ein gesundes Modell
 * gewaehlt hatte. Ein geglueckter Start IST die verlangte Handlung, also
 * raeumt er sie weg. Eine Info-Zeile bleibt unberuehrt, die hat ihre eigene Uhr.
 */
export function clearEngineErrorAfterSuccess(): void {
  const zustand = useLuEngineSwitchStore.getState()
  if (zustand.tone === 'error' && zustand.note) zustand.dismiss()
}

/**
 * The local backend waiting beside the slot while the LU Engine holds it, or
 * null when there is none to go back to.
 *
 * Local only, and never a managed one: a cloud backend on standby has nothing
 * to list from a machine that may be offline, and "managed" is us.
 */
export function standbyChatBackend(): SlotOccupant | null {
  return standbyBackendOf(useProviderStore.getState().providers.openai as HandoverSlot)
}

/**
 * Dieselbe Frage an einen Steckplatz, den der Aufrufer schon hat.
 *
 * Der Waehler braucht die Antwort REAKTIV: die Gruppierung muss neu zeichnen,
 * sobald ein Klick den Steckplatz weiterreicht, und ein Blick in
 * `getState()` benachrichtigt niemanden. Deshalb steht die Regel hier, wo
 * beide Wege sie holen, statt ein zweites Mal im Bauteil.
 */
export function standbyBackendOf(slot: HandoverSlot): SlotOccupant | null {
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
  return isRowOfBackend(row, standbyChatBackend()?.name)
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
 * How long the standby server gets to answer before it is treated as silent.
 *
 * A16 counter-check follow-up: this call is awaited in the middle of
 * `fetchModels`, so a standby server that accepts the connection and then
 * never answers held up the WHOLE model list, on every refresh, for as long as
 * the platform's own timeout allowed. A local server that has hung is not an
 * exotic case (LM Studio loading a large model on a busy disk does it), and
 * the cost of guessing wrong here is one missing heading until the next
 * refresh, against an empty Models page for minutes.
 *
 * Three seconds because the server is on this machine: `/v1/models` is a
 * directory listing off local disk, and anything that has not answered in
 * three seconds is not about to.
 */
export const STANDBY_MODEL_LIST_TIMEOUT_MS = 3_000

/**
 * The standby backend's own model list, read straight from its server.
 *
 * A one-off client rather than the registry's cached one: the registry is
 * keyed on the slot, and the slot is currently the LU Engine. Nothing is
 * cached, so a server that has gone away since simply throws and the caller
 * adds no rows, which is exactly the old behaviour.
 *
 * A server that hangs instead of refusing gets the same treatment after
 * `STANDBY_MODEL_LIST_TIMEOUT_MS`: an empty list, not an error, because there
 * is nothing here for the user to act on and the rest of the list must go up.
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
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.listModels(),
      new Promise<ProviderModel[]>((resolve) => {
        timer = setTimeout(() => resolve([]), STANDBY_MODEL_LIST_TIMEOUT_MS)
      }),
    ])
  } finally {
    // Whichever side won, the timer goes. Left running it would hold this
    // closure for three seconds after every single model refresh.
    if (timer) clearTimeout(timer)
  }
}
