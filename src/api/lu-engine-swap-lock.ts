/**
 * One bolt for the LU Engine model swap, shared by every door that can fire one.
 *
 * A14 third review put a bolt on the Installed card, because two cards clicked
 * in quick succession sent two `swap_bundled_model` calls at one engine and the
 * second one landed on a process the first was still restarting. The fourth
 * review found that the bolt only ever held that one door. It was a module
 * variable inside `useModels`, while the composer's picker calls
 * `activateBuiltinModel` itself and guards it with its own component state
 * (`selectingLms`), which knows nothing about the card and dies with the
 * dropdown. Card and picker are two doors into ONE llama-server: pick a model
 * in the composer, then click a card on the Models page a second later, and the
 * crash the third review fixed is back, arrived at from the side the fix never
 * covered.
 *
 * The state lives on globalThis for the same reason api/engine-swap-gate.ts
 * parks its own there: the bundler duplicates small modules, and two copies of
 * this bolt would each see an idle engine.
 *
 * This is NOT api/engine-swap-gate.ts and does not replace it. That gate lets
 * the SEND path wait for a swap it can see, so a message is not fired into the
 * hole a restart leaves. This one stops a second swap from being started at
 * all. One is a queue, the other is a door.
 */

/**
 * How long the bolt may stand without being released.
 *
 * Every holder releases in a `finally`, so this only matters when a swap never
 * settles at all: a Tauri command whose answer is lost, a promise that neither
 * resolves nor rejects. Without a limit that would lock the card and the picker
 * for the rest of the session and the only way back would be a restart, which
 * breaks the house rule that the app heals itself before it complains. Well
 * over any real swap: the send path waits 90 s for one (ENGINE_SWAP_WAIT_MS),
 * but that wait covers a cold GGUF load, while this only has to cover the UI
 * call handing the work over.
 */
export const LU_ENGINE_SWAP_LOCK_MS = 60_000

const KEY = '__lu_engine_swap_lock__'

interface Bolt {
  /** Wall clock at which an unreleased bolt gives up by itself. 0 when open. */
  heldUntil: number
}

function bolt(): Bolt {
  const g = globalThis as unknown as Record<string, Bolt>
  if (!g[KEY]) g[KEY] = { heldUntil: 0 }
  return g[KEY]
}

/** Test-only: open the bolt and forget any deadline. */
export function __resetLuEngineSwapLockForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[KEY]
}

/** True while a swap started anywhere in the app is still running. */
export function luEngineSwapInFlight(): boolean {
  return bolt().heldUntil > Date.now()
}

/**
 * Take the bolt for a swap that is about to start.
 *
 * True when the caller may go ahead, and then the caller OWNS it and must
 * release it in a `finally`. False when someone else is mid swap, and then the
 * caller must not touch the engine and should say so: a click that returns in
 * silence reads as a broken button.
 */
export function tryAcquireLuEngineSwap(): boolean {
  const b = bolt()
  if (b.heldUntil > Date.now()) return false
  b.heldUntil = Date.now() + LU_ENGINE_SWAP_LOCK_MS
  return true
}

/** Give the bolt back. Called from a `finally`, so a rejected swap frees the
 *  next click as surely as a successful one does. */
export function releaseLuEngineSwap(): void {
  bolt().heldUntil = 0
}
