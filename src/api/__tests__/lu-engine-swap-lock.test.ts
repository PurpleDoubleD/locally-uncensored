/**
 * The one bolt in front of the LU Engine model swap.
 *
 * A14 fourth review: the bolt existed but it was a module variable inside
 * `useModels`, so it held the Installed card and nothing else. The composer's
 * picker calls `activateBuiltinModel` itself and guards it with its own
 * component state, which knows nothing about the card. Two doors into one
 * llama-server, and the second swap lands on a process the first is still
 * restarting, which is the ENG-4 crash from the side the ENG-4 fix never
 * covered.
 *
 * The behaviour across the two real doors is proven in
 * hooks/__tests__/installed-card-click-switches-the-backend.test.ts. What is
 * proven here is the bolt itself, including the one thing no caller can prove:
 * that a swap which never answers cannot lock the model list until the app is
 * restarted.
 *
 * Run: npx vitest run src/api/__tests__/lu-engine-swap-lock.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  tryAcquireLuEngineSwap, releaseLuEngineSwap, luEngineSwapInFlight,
  __resetLuEngineSwapLockForTests, LU_ENGINE_SWAP_LOCK_MS,
} from '../lu-engine-swap-lock'

beforeEach(() => { __resetLuEngineSwapLockForTests() })
afterEach(() => { vi.useRealTimers() })

describe('one swap at a time', () => {
  it('lets the first caller through and turns the second one away', () => {
    expect(tryAcquireLuEngineSwap()).toBe(true)
    expect(tryAcquireLuEngineSwap(), 'the second door is not a second engine').toBe(false)
    expect(luEngineSwapInFlight()).toBe(true)
  })

  // NEGATIVE CONTROL: a bolt that never opens is a lock. The next click has to
  // get through the moment the swap is done.
  it('opens again on release', () => {
    tryAcquireLuEngineSwap()
    releaseLuEngineSwap()
    expect(luEngineSwapInFlight()).toBe(false)
    expect(tryAcquireLuEngineSwap()).toBe(true)
  })

  it('opens on release after a FAILED swap too', () => {
    tryAcquireLuEngineSwap()
    // What the callers do: release from a `finally`, so a rejected
    // activateBuiltinModel frees the next click exactly like a successful one.
    try { throw new Error('llama-server exited') } catch { /* the caller shows this */ }
    finally { releaseLuEngineSwap() }
    expect(tryAcquireLuEngineSwap(), 'a dead engine must not lock the list').toBe(true)
  })

  it('is one bolt across module copies, not one per import', async () => {
    // The bundler duplicates small modules, and two copies each seeing an idle
    // engine is the whole reason the state sits on globalThis. Re-importing is
    // as close as a test gets to that second copy.
    tryAcquireLuEngineSwap()
    vi.resetModules()
    const second = await import('../lu-engine-swap-lock')
    expect(second.tryAcquireLuEngineSwap(), 'a second copy saw an idle engine').toBe(false)
  })
})

describe('a swap that never answers', () => {
  it('gives the bolt up by itself instead of locking the app until a restart', () => {
    vi.useFakeTimers()
    expect(tryAcquireLuEngineSwap()).toBe(true)
    // A Tauri command whose answer is lost: no resolve, no reject, so the
    // `finally` that releases this never runs. Without a limit the card and
    // the picker are both dead for the rest of the session, and the house rule
    // is that the app heals itself before it complains.
    vi.advanceTimersByTime(LU_ENGINE_SWAP_LOCK_MS + 1)
    expect(luEngineSwapInFlight()).toBe(false)
    expect(tryAcquireLuEngineSwap()).toBe(true)
  })

  // NEGATIVE CONTROL: the limit is a last resort and must not cut a real swap
  // short. A cold GGUF load takes tens of seconds, and a bolt that opened
  // during one would let the second swap in, which is the crash this whole
  // module is against.
  it('still holds while a slow swap is running', () => {
    vi.useFakeTimers()
    tryAcquireLuEngineSwap()
    vi.advanceTimersByTime(LU_ENGINE_SWAP_LOCK_MS - 1_000)
    expect(luEngineSwapInFlight(), 'a slow start is not a dead one').toBe(true)
    expect(tryAcquireLuEngineSwap()).toBe(false)
  })
})
