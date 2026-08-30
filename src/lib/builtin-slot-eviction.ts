/**
 * What happens to the built-in engine's RAM and VRAM when it loses the shared
 * local slot.
 *
 * Nebenbefund 2 of the R12/R13 re-measure on the real 2.6.7 Windows build
 * (2026-08-30, ergebnis-r1213-nachmessung.md):
 *
 *   "Der eingebaute Motor laeuft weiter, waehrend ein fremder Anbieter den
 *    Slot haelt. Nach dem Anlegen von Jan blieb lu-llama-server.exe PID 7516
 *    am Leben, samt geladenem Modell im Speicher. Erst ein App-Neustart
 *    raeumt ihn weg: nach dem Neustart mit Jan im Slot startete gar kein
 *    lu-llama-server mehr."
 *
 * The same shape as round 7's close-to-tray finding, one door further along:
 * the app agrees the engine has nothing left to do, and the model sits in
 * memory anyway until the process is restarted. Round 7 answered it by routing
 * the hide through `offload_local_models`, the call the switch into Cloud mode
 * already made, after a short grace period so a mis-click costs nothing. This
 * is the same answer for the same question, so it is the same call and the same
 * grace period, not a second mechanism.
 *
 * The trigger is narrow on purpose. Only a slot the app's OWN engine was
 * holding can leave a `lu-llama-server` behind, so only that transition fires:
 * LM Studio replacing Jan frees nothing of ours and must not evict anybody's
 * Ollama residents for nothing.
 *
 * Nothing is lost by unloading. Everything comes back lazily on first use, the
 * way `builtin-ensure.ts` already revives the engine after a Create render did
 * exactly this call.
 */

import { backendCall, isTauri } from '../api/backend'
import { log } from './logger'

/** The part of the `openai` slot this decision reads. */
export interface BuiltinSlotView {
  enabled: boolean
  /** True only for the app's own bundled llama.cpp engine. */
  managed?: boolean
}

/**
 * Mis-click insurance, same idea and same length as round 7's
 * `HIDE_OFFLOAD_GRACE`: swap the slot away and straight back and nothing was
 * ever unloaded.
 */
export const BUILTIN_SLOT_OFFLOAD_GRACE_MS = 30_000

/** Is the app's own engine the backend serving the shared local slot. */
export function builtinHoldsLocalSlot(slot: BuiltinSlotView | null | undefined): boolean {
  return !!slot && slot.enabled === true && slot.managed === true
}

/**
 * What the slot change means for the engine's memory.
 *
 *  'schedule' the engine just lost the slot, start the grace timer
 *  'cancel'   it holds the slot again, a pending unload is void
 *  'none'     nothing about our engine changed
 *
 * Pure, so the rule can be read without a timer or a backend.
 */
export function builtinSlotOffloadDecision(
  before: BuiltinSlotView | null | undefined,
  after: BuiltinSlotView | null | undefined,
): 'schedule' | 'cancel' | 'none' {
  const had = builtinHoldsLocalSlot(before)
  const has = builtinHoldsLocalSlot(after)
  if (has) return 'cancel'
  return had ? 'schedule' : 'none'
}

// The pending unload. A generation counter rather than a bare handle for the
// same reason the Rust side keeps one: a timer whose grace period belongs to an
// older change must not fire under a newer one.
let pending: ReturnType<typeof setTimeout> | null = null
let generation = 0

/** Drop a pending unload without performing it. */
function cancelPending(): void {
  generation++
  if (pending !== null) {
    clearTimeout(pending)
    pending = null
  }
}

/**
 * Wire the decision to the call. Safe to invoke on every write to the `openai`
 * slot: it does nothing unless the app's own engine actually lost the slot, and
 * nothing at all outside the desktop build.
 *
 * `includeComfyui: false` for the same reason a local render passes it: the
 * image checkpoint has no part in a chat backend change, and freeing it here
 * would buy a slow reload on the next generate for nothing. That is the flag
 * the Create hand-off has always used.
 */
export function onLocalSlotChanged(
  before: BuiltinSlotView | null | undefined,
  after: BuiltinSlotView | null | undefined,
): void {
  const decision = builtinSlotOffloadDecision(before, after)
  if (decision === 'none') return
  if (decision === 'cancel') {
    cancelPending()
    return
  }
  if (!isTauri()) return
  cancelPending()
  const mine = generation
  pending = setTimeout(() => {
    if (mine !== generation) return
    pending = null
    backendCall('offload_local_models', { includeComfyui: false })
      .then(() => log.info('[builtin-slot] engine lost the local slot, released its model'))
      .catch((e) => log.warn('[builtin-slot] could not release the displaced engine', { err: e }))
  }, BUILTIN_SLOT_OFFLOAD_GRACE_MS)
}

/** Test-only: forget a pending unload so tests stay isolated. */
export function __resetBuiltinSlotOffloadForTests(): void {
  cancelPending()
}
