/**
 * What happens to the backend that was in the `openai` slot when Add Provider
 * puts another one there.
 *
 * Nebenbefund 3 of the R10 re-measure on the 2.6.7 Windows build
 * (2026-08-30), and the only path found on which a provider card really does
 * disappear without a trace:
 *
 *   Settings, AI Backends, Add Provider, entry "Jan"
 *   (http://localhost:1337/v1). Afterwards the providers list holds Jan
 *   (LOCAL) and LU Cloud. The Built-in Engine card is gone, together with the
 *   BUILT-IN ENGINE (EXPERT) section. Nothing on the Jan card says where the
 *   built-in engine went.
 *
 * And then the sharp edge: switching Jan off leaves the Jan card standing with
 * its Enable button, but now there is no local backend at all. The picker says
 * "No models available" and lists none of the three installed local models,
 * although the user never switched the built-in engine off.
 *
 * The way back exists and is unlabelled: Add Provider, entry "Built-in
 * Engine". That is what the user who wrote "the card was completely gone, no
 * way back" almost certainly missed. R9's Disable button, which the report was
 * first read against, is clean.
 *
 * Why the card vanishes at all: `ProviderId` is a fixed set of four slots and
 * every OpenAI-protocol backend lives in the single `openai` one. The list
 * holds one local OpenAI-compatible backend at a time, which is a design
 * decision, not a bug. Losing the previous one without a word is the bug.
 *
 * The answer reuses the mechanic R10 built for Disable: the backend that was
 * pushed out keeps a card, greyed, with an Enable button that hands the slot
 * back. It is remembered as `displaced` ON the slot config, so it survives a
 * restart the same way the slot itself does, and the handback swaps rather
 * than forgets, so the backend the user just added does not vanish silently in
 * its turn either.
 *
 * Deliberately NOT touched, these are the counter-poles from R10 and their
 * tests must stay green:
 *  - a fresh install: nothing was ever pushed out, so there is no extra card,
 *  - onboarding handing the slot to Ollama: it parks the slot disabled without
 *    anyone pressing anything, and a slot that was already off is not being
 *    taken away from the user. Only an ENABLED occupant is remembered.
 */

import type { ProviderConfig } from '../api/providers/types'

/** The part of a backend that is enough to put it back where it was. */
export interface SlotOccupant {
  name: string
  baseUrl: string
  isLocal: boolean
  managed?: boolean
  /**
   * This backend is waiting beside the slot because the USER switched it off,
   * not because something else took the slot from it.
   *
   * Nebenbefund 3 of the R12/R13 re-measure (2026-08-30): Disable on the slot
   * holder gives the slot back correctly, but then labelled Jan STANDBY. The
   * button says Disable and the user pressed it, so the card has to say the
   * backend is off. Parked and switched off are two different states and only
   * the card can tell them apart, because the slot itself looks identical.
   */
  disabledByUser?: boolean
}

/** The part of the `openai` slot this decision reads. */
export interface HandoverSlot extends SlotOccupant {
  enabled: boolean
  /** The occupant this one pushed out, kept so it has a card and a way back. */
  displaced?: SlotOccupant
}

/** Trailing slashes and case are not a different server. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => (u || '').trim().replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Is the incoming backend a different one from what the slot holds. */
export function isDifferentBackend(slot: SlotOccupant, incoming: SlotOccupant): boolean {
  if (!sameUrl(slot.baseUrl, incoming.baseUrl)) return true
  if (slot.name !== incoming.name) return true
  return !!slot.managed !== !!incoming.managed
}

/**
 * The patch Add Provider writes into the `openai` slot, including the memory
 * of who was pushed out.
 *
 * `displaced` is only written when there was something to lose: a DIFFERENT
 * backend that was switched ON. Re-selecting what is already there changes
 * nothing, and a slot the user (or onboarding) had already parked is not being
 * taken from anybody.
 */
export function slotTakeoverUpdate(
  slot: HandoverSlot,
  incoming: SlotOccupant,
): Partial<ProviderConfig> {
  const base = {
    enabled: true,
    name: incoming.name,
    baseUrl: incoming.baseUrl,
    isLocal: incoming.isLocal,
    // Must be set explicitly in both directions: left at true the model list
    // would keep reading the bundled GGUFs while the URL points elsewhere.
    managed: !!incoming.managed,
    // Taking the slot on purpose is not the same as the user switching this
    // backend off, so the Disable mark never survives a takeover.
    disabledByUser: false,
  }
  if (!slot.enabled || !isDifferentBackend(slot, incoming)) {
    // Nothing was lost, so nothing new is remembered. Whatever was already
    // remembered stays remembered: re-enabling a slot must not quietly drop a
    // standby card that is still owed.
    return base
  }
  return {
    ...base,
    displaced: {
      name: slot.name,
      baseUrl: slot.baseUrl,
      isLocal: slot.isLocal,
      managed: slot.managed,
    },
  }
}

/** The standby card the providers list owes, or null when it owes none. */
export function standbyOccupant(slot: HandoverSlot): SlotOccupant | null {
  const d = slot.displaced
  if (!d) return null
  // A slot that has come back to the remembered backend by some other route
  // (Reset AI Backends, Add Provider on the same entry) owes no card.
  if (!isDifferentBackend(slot, d)) return null
  return d
}

/**
 * The patch Enable on the standby card writes: the remembered backend goes
 * back into the slot, and the one it displaces takes its place on standby.
 *
 * The swap is what keeps this honest in both directions. Handing the slot back
 * to the built-in engine used to make the added provider disappear exactly as
 * silently as the built-in engine had disappeared before it.
 */
export function slotHandbackUpdate(slot: HandoverSlot): Partial<ProviderConfig> | null {
  const back = standbyOccupant(slot)
  if (!back) return null
  // `enabled: true` on the synthetic slot, so the swap remembers the outgoing
  // backend even when it was sitting switched off. That is the state the
  // re-measure ended in: Jan added, then Jan disabled, and no local backend
  // left at all. Handing the slot back there must not also lose Jan.
  return slotTakeoverUpdate({ ...slot, enabled: true, displaced: undefined }, back)
}

/**
 * The patch DISABLE on the slot holder writes.
 *
 * Same swap as the handback, because that is the part R11 got right: switching
 * a backend off is not a wish to be left without one, and the engine waiting
 * beside the slot takes it back. The one difference is the label the leaving
 * backend gets, which is Nebenbefund 3 of the R12/R13 re-measure:
 *
 *   "Disable auf dem Slot-Inhaber setzt den Anbieter nicht auf DISABLED,
 *    sondern auf STANDBY. Das ist die freundlichere Auslegung ... Es weicht
 *    aber von der Beschriftung ab: der Knopf heisst Disable, das Ergebnis ist
 *    ein Rollentausch."
 *
 * So the card says DISABLED and carries the same `disabledByUser` mark every
 * other switched-off row carries. Enable and Remove stay on it either way: the
 * way back must not depend on how the backend got there.
 *
 * Null when there is nobody to hand the slot to, and then the plain Disable
 * path applies unchanged (the row goes greyed DISABLED where it always did).
 */
export function slotDisableOccupantUpdate(slot: HandoverSlot): Partial<ProviderConfig> | null {
  const patch = slotHandbackUpdate(slot)
  const leaving = (patch as { displaced?: SlotOccupant } | null)?.displaced
  if (!patch || !leaving) return patch
  return { ...patch, displaced: { ...leaving, disabledByUser: true } }
}

/**
 * Whether the backend SITTING IN the slot may be removed, and whether the one
 * waiting beside it may be.
 *
 * Nebenbefund (b) of the R11 re-measure (2026-08-30): a provider added through
 * Add Provider could not be taken off the list again. The card offers Endpoint,
 * Test and Disable, and nothing else, in every state, so the only way back to
 * the shipped list was `Reset AI Backends to defaults`, which also throws away
 * every other backend the user had set up.
 *
 * Remove is not a new mechanic, it is the handover read the other way round.
 * The four slot ids (`ollama`, `openai`, `anthropic`, `lu-cloud`) are the fixed
 * shape of the store and none of them can be deleted; what a user really added
 * is a BACKEND placed into the shared `openai` slot on top of something else,
 * and removing it means putting the slot back the way it was before the
 * takeover. That is exactly what `displaced` remembers, so Remove is offered
 * where, and only where, there is a remembered state to return to:
 *
 *  - on the occupant, when it is not the app's own engine. The built-in engine
 *    is the floor everybody else stands on; removing it would leave the slot
 *    with nothing to fall back to and re-open the hole R10 closed.
 *  - on the standby card, for the same reason in the other direction: after a
 *    handback the added backend is the one waiting there, and forgetting it is
 *    the same wish as removing it. The built-in engine on standby is never
 *    forgotten, because that card IS the way back.
 */
export function occupantIsRemovable(slot: HandoverSlot): boolean {
  if (slot.managed) return false
  return standbyOccupant(slot) !== null
}

/** True when the backend on the standby card may be forgotten. */
export function standbyIsRemovable(slot: HandoverSlot): boolean {
  const waiting = standbyOccupant(slot)
  return !!waiting && !waiting.managed
}

/**
 * The patch Remove on the occupant writes: the slot goes back to the state it
 * was in before the takeover, and the backend that is leaving is forgotten
 * rather than parked.
 *
 * That is the whole difference to Enable on the standby card, which swaps. A
 * user who presses Remove is not asking for a card in the other corner.
 */
export function slotRemoveOccupantUpdate(slot: HandoverSlot): Partial<ProviderConfig> | null {
  const back = standbyOccupant(slot)
  if (!back || !occupantIsRemovable(slot)) return null
  return {
    enabled: true,
    name: back.name,
    baseUrl: back.baseUrl,
    isLocal: back.isLocal,
    managed: !!back.managed,
    // The slot is being handed back on purpose, so it carries neither the
    // Disable mark nor a memory of the backend that just left.
    disabledByUser: false,
    displaced: undefined,
  }
}

/** The patch Remove on the standby card writes: forget the backend waiting
 *  there, and leave the occupant of the slot alone. */
export function slotForgetStandbyUpdate(slot: HandoverSlot): Partial<ProviderConfig> | null {
  if (!standbyIsRemovable(slot)) return null
  return { displaced: undefined }
}
