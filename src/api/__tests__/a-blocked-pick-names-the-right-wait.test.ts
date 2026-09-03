/**
 * @vitest-environment jsdom
 *
 * A16 counter-check follow-up 02.09.: the composer's picker answers a blocked
 * LU Engine pick with one sentence, and one of the three conditions it asks
 * about is not about our engine at all.
 *
 *   if (selectingLms || togglingLms || !tryAcquireLuEngineSwap())
 *
 * The first two are the picker's own in-flight state and are also set while LM
 * STUDIO warms a model of its own. "The LU Engine is still switching, one
 * moment." was then a sentence about something that was not happening, and the
 * person who read it went looking for an engine swap he never started.
 *
 * The bolt is what knows whether a swap of ours is running, so it decides
 * which of the two waits the user is actually in.
 *
 * Run: npx vitest run src/api/__tests__/a-blocked-pick-names-the-right-wait.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const {
  LU_ENGINE_SWAP_BUSY_NOTE, announceLuEngineSwapBusy,
  LM_STUDIO_LOAD_BUSY_NOTE, announceLmStudioLoadBusy,
} = await import('../lu-engine-switch')
const { useLuEngineSwitchStore, LU_ENGINE_SWITCH_NOTE_MS } = await import('../../stores/luEngineSwitchStore')
const { __resetLuEngineSwapLockForTests, tryAcquireLuEngineSwap } = await import('../lu-engine-swap-lock')

function note() { return useLuEngineSwitchStore.getState().note }

beforeEach(() => {
  useLuEngineSwitchStore.setState({ note: null, tone: 'info', generation: 0 })
  __resetLuEngineSwapLockForTests()
})
afterEach(() => {
  useLuEngineSwitchStore.getState().dismiss()
  __resetLuEngineSwapLockForTests()
})

describe('the sentence a blocked pick gets', () => {
  it('names LM Studio when LM Studio is the one loading', () => {
    announceLmStudioLoadBusy()
    expect(note()).toBe('LM Studio is still loading a model, one moment.')
    expect(note(), 'it still blames the LU Engine').not.toBe(LU_ENGINE_SWAP_BUSY_NOTE)
    expect(useLuEngineSwitchStore.getState().tone, 'a wait is not a failure').toBe('info')
  })

  it('and the two sentences are not the same sentence', () => {
    expect(LM_STUDIO_LOAD_BUSY_NOTE).not.toBe(LU_ENGINE_SWAP_BUSY_NOTE)
    expect(LM_STUDIO_LOAD_BUSY_NOTE.toLowerCase()).not.toContain('lu engine')
  })

  // NEGATIVE CONTROL: the LU Engine line is untouched, holdWhile included. It
  // is the one that has to outlive a cold GGUF load (A14-6).
  it('leaves the LU Engine line saying what it always said', () => {
    tryAcquireLuEngineSwap()
    announceLuEngineSwapBusy()
    expect(note()).toBe(LU_ENGINE_SWAP_BUSY_NOTE)
  })

  // The picker has no render harness (see model-selector-lms.test.ts), so its
  // half is pinned by reading the source. The weaker proof, and labelled as
  // such: it catches the one sentence for both waits coming back, not a picker
  // that fails to render.
  it('and the picker asks the bolt which of the two waits it is in', () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../components/models/ModelSelector.tsx'),
      'utf8',
    )
    // The condition from A14-6 is unchanged: one condition, one answer, bolt
    // asked last so a blocked pick does not take it.
    expect(src).toContain('if (selectingLms || togglingLms || !tryAcquireLuEngineSwap()) {')
    // And inside it, the split. `luEngineSwapInFlight()` is the only thing
    // that can tell an LM Studio load from a swap of ours.
    expect(src, 'the picker still says one sentence for both waits')
      .toContain('if ((selectingLms || togglingLms) && !luEngineSwapInFlight()) {')
    expect(src).toContain('announceLmStudioLoadBusy()')
    expect(src).toContain('announceLuEngineSwapBusy()')
  })

  // NEGATIVE CONTROL: the LM Studio line is on the ordinary clock. It
  // describes a condition the picker holds in component state, which this
  // module cannot watch, so a hold here would be a line that never leaves.
  it('lets the LM Studio line clear itself', async () => {
    const { vi } = await import('vitest')
    vi.useFakeTimers()
    try {
      announceLmStudioLoadBusy()
      await vi.advanceTimersByTimeAsync(LU_ENGINE_SWITCH_NOTE_MS + 100)
      expect(note(), 'the line never left').toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
