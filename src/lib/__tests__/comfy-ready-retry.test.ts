/**
 * Meldung 2 of the R5 re-measure on the 2.6.7 Windows build
 * (2026-08-30, ergebnis-r5-nachmessung.md).
 *
 * Cold start, Model Manager opened while ComfyUI was still coming up:
 *
 *      1 ms | Chat:Chat
 *    233 ms | Chat··· Image··· Video··· || Installed···
 *   4469 ms | Chat:3   Image··· Video··· || Installed···
 *  11311 ms | Chat:3   Image     Video    || Installed0
 *
 * And there it stayed. Measured again minutes later, with port 8188 long
 * open, it still read `Installed 0` while the cards below it carried green
 * Installed ticks. Two independent reproductions. One click on Refresh
 * repaired it in two seconds.
 *
 * inventory-counter.ts already promised the fix: "a second pass is what brings
 * the ComfyUI lanes in: the engine is often not up yet on the first one".
 * There was no second pass. Nothing ever asked again.
 *
 * Run: npx vitest run src/lib/__tests__/comfy-ready-retry.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { inventoryOwesRetry, refetchWhenComfyReady } from '../comfy-ready-retry'

const here = dirname(fileURLToPath(import.meta.url))
const useModels = readFileSync(resolve(here, '../../hooks/useModels.ts'), 'utf8')

/** No real seconds are spent in here. */
const nowait = async () => {}

describe('a pass that could not ask the engine owes a second one', () => {
  it('THE FIX: an unreachable engine has counted nothing, so it owes a retry', () => {
    expect(inventoryOwesRetry(false)).toBe(true)
  })

  it('NEGATIVE CONTROL: an engine that answered and holds nothing owes nothing', () => {
    // A counted zero is the truth and must settle. Retrying it forever would
    // turn the loading mark into the new lie.
    expect(inventoryOwesRetry(true)).toBe(false)
  })
})

describe('the second pass runs the moment ComfyUI is there', () => {
  it('THE FIX: the exact cold-start frame, still starting and then up', async () => {
    const refetch = vi.fn(async () => {})
    // Three rounds of "the process is alive, the port is not open yet", which
    // is what the box showed for the first eleven seconds, then up.
    const answers = [
      { running: false, starting: true },
      { running: false, starting: true },
      { running: false, starting: true },
      { running: true, starting: false },
    ]
    const status = vi.fn(async () => answers.shift() ?? null)

    const outcome = await refetchWhenComfyReady({ status, refetch, wait: nowait })

    expect(outcome).toBe('refetched')
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('THE FIX: an engine already up is asked again straight away', async () => {
    const refetch = vi.fn(async () => {})
    const outcome = await refetchWhenComfyReady({
      status: async () => ({ running: true }),
      refetch,
      wait: nowait,
    })
    expect(outcome).toBe('refetched')
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('THE FIX: the refetch runs exactly once, never in a loop', async () => {
    const refetch = vi.fn(async () => {})
    await refetchWhenComfyReady({
      status: async () => ({ running: true }),
      refetch,
      wait: nowait,
      rounds: 50,
    })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE CONTROL: nothing is starting, so the zero is left alone', async () => {
    const refetch = vi.fn(async () => {})
    const status = vi.fn(async () => ({ running: false, starting: false }))

    const outcome = await refetchWhenComfyReady({ status, refetch, wait: nowait })

    expect(outcome).toBe('not-starting')
    expect(refetch).not.toHaveBeenCalled()
    // One look, not sixty. ComfyUI is not installed or was never started, and
    // the Installed tab has its own honest "Start ComfyUI" state for that.
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE CONTROL: a backend that cannot answer ends the wait', async () => {
    const refetch = vi.fn(async () => {})
    const outcome = await refetchWhenComfyReady({
      status: async () => { throw new Error('Unknown backend command') },
      refetch,
      wait: nowait,
    })
    expect(outcome).toBe('not-starting')
    expect(refetch).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL: a boot that never finishes gives up on a budget', async () => {
    const refetch = vi.fn(async () => {})
    const status = vi.fn(async () => ({ running: false, starting: true }))

    const outcome = await refetchWhenComfyReady({
      status, refetch, wait: nowait, rounds: 5,
    })

    expect(outcome).toBe('timeout')
    expect(status).toHaveBeenCalledTimes(5)
    expect(refetch).not.toHaveBeenCalled()
  })
})

describe('the model list arms that second pass, and holds the counter while it runs', () => {
  it('THE FIX: an unreachable ComfyUI marks the pass as unanswered', () => {
    expect(useModels).toMatch(/if \(!isMacOS\(\) && !comfyOk\) comfyAnswered = false/)
  })

  it('THE FIX: both lanes rejected marks the pass as unanswered too', () => {
    expect(useModels).toMatch(/imageResult\.status === 'rejected' && videoResult\.status === 'rejected'/)
    expect(useModels).toMatch(/comfyAnswered = false/)
  })

  it('THE FIX: the arm hangs on comfyui_status, the readiness signal that exists', () => {
    expect(useModels).toMatch(/backendCall<ComfyReadyStatus>\('comfyui_status'\)/)
  })

  it('THE FIX: the counter says counting for as long as the second pass is owed', () => {
    // beginInventoryRefresh is what counterView reads as "not counted yet".
    // Held from arming until the wait settles, or the page states a zero it
    // has not counted for the whole of a ComfyUI boot.
    const arm = useModels.slice(
      useModels.indexOf('function armComfyInventoryRetry'),
      useModels.indexOf('export function __resetComfyInventoryRetryForTests'),
    )
    expect(arm).toMatch(/beginInventoryRefresh\(\)/)
    expect(arm).toMatch(/endInventoryRefresh\(\)/)
  })

  it('NEGATIVE CONTROL: one arm at a time, not one per mounted component', () => {
    const arm = useModels.slice(
      useModels.indexOf('function armComfyInventoryRetry'),
      useModels.indexOf('export function __resetComfyInventoryRetryForTests'),
    )
    expect(arm).toMatch(/if \(comfyRetryRunning\) return/)
  })

  it('NEGATIVE CONTROL: the Mac never arms it, there is no ComfyUI to wait for', () => {
    const arm = useModels.slice(
      useModels.indexOf('function armComfyInventoryRetry'),
      useModels.indexOf('export function __resetComfyInventoryRetryForTests'),
    )
    expect(arm).toMatch(/if \(isMacOS\(\)\) return/)
  })
})
