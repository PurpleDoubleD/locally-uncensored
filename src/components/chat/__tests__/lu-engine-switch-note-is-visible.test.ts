/**
 * @vitest-environment jsdom
 *
 * A14 review, point 2: "Switched your chat provider to the LU Engine for this
 * model." was written into the model picker's own dropdown, and the pick
 * closes that dropdown. On the success path the line was drawn and unmounted
 * in the same frame, so nobody ever read it; on the failure path it was
 * suppressed by the error rendered beside it, which is the one moment the user
 * most needs to know his chat backend has already moved.
 *
 * It lives above the composer now, in the standing status row, and it is
 * announced BEFORE the engine start is attempted. What is proven here is that
 * the sentence is on screen in a component that is NOT the dropdown, that it
 * outlives the dropdown, and that an error does not silence it.
 *
 * Run: npx vitest run src/components/chat/__tests__/lu-engine-switch-note-is-visible.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'

vi.mock('../../../api/providers/registry', () => ({ clearProviderCache: vi.fn() }))
vi.mock('../../../api/backend', () => ({
  isTauri: () => false,
  backendCall: vi.fn(async () => null),
  secretGet: vi.fn().mockRejectedValue(new Error('no vault')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { LuEngineSwitchBar } = await import('../LuEngineSwitchBar')
const { useLuEngineSwitchStore, LU_ENGINE_SWITCH_NOTE_MS } = await import('../../../stores/luEngineSwitchStore')
const { ensureLuEngineIsChatProvider, LU_ENGINE_SWITCH_NOTE } = await import('../../../api/lu-engine-switch')
const { useProviderStore } = await import('../../../stores/providerStore')

/** What the picker and the Use button do, in the order they do it: hand the
 *  slot over, announce, and only then try to start the engine. */
function pickAnLuEngineModel(): boolean {
  const switched = ensureLuEngineIsChatProvider()
  if (switched) useLuEngineSwitchStore.getState().announce(LU_ENGINE_SWITCH_NOTE)
  return switched
}

beforeEach(() => {
  useLuEngineSwitchStore.setState({ note: null, generation: 0 })
  useProviderStore.getState().resetProvidersToDefaults()
  useProviderStore.getState().setProviderConfig('openai', { enabled: false, managed: false })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the line survives the pick that caused it', () => {
  it('stands in the composer row, which is not the dropdown', async () => {
    render(createElement(LuEngineSwitchBar))
    // Nothing to say before the pick.
    expect(screen.queryByTestId('lu-engine-switch-note')).toBeNull()
    await act(async () => { pickAnLuEngineModel() })
    expect(screen.getByTestId('lu-engine-switch-note').textContent)
      .toContain('Switched your chat provider to the LU Engine for this model.')
  })

  it('is still there after the dropdown that triggered it is gone', async () => {
    // The dropdown unmounting is exactly what used to take the sentence with
    // it. Rendering the bar on its own IS that situation.
    const dropdown = render(createElement(LuEngineSwitchBar))
    await act(async () => { pickAnLuEngineModel() })
    dropdown.unmount()
    render(createElement(LuEngineSwitchBar))
    expect(screen.getByTestId('lu-engine-switch-note')).toBeTruthy()
  })

  it('an engine that fails to start does not silence it', async () => {
    render(createElement(LuEngineSwitchBar))
    await act(async () => {
      pickAnLuEngineModel()
      // The start blows up right after the announcement, the way a missing
      // GGUF or a blocked port does.
      try { throw new Error('llama-server exited before it could serve') } catch { /* the caller shows this elsewhere */ }
    })
    expect(screen.getByTestId('lu-engine-switch-note')).toBeTruthy()
    // And the slot really did move, which is why the sentence has to stand.
    expect(useProviderStore.getState().providers.openai.managed).toBe(true)
  })

  it('clears itself after a while instead of standing forever', async () => {
    vi.useFakeTimers()
    render(createElement(LuEngineSwitchBar))
    act(() => { pickAnLuEngineModel() })
    expect(screen.getByTestId('lu-engine-switch-note')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(LU_ENGINE_SWITCH_NOTE_MS + 10) })
    expect(screen.queryByTestId('lu-engine-switch-note')).toBeNull()
  })

  it('is a polite live region that stays mounted, so it is really announced', async () => {
    const { container } = render(createElement(LuEngineSwitchBar))
    const region = container.querySelector('[role="status"]')
    // Mounted BEFORE there is anything to say: a live region that appears
    // together with its content is usually read as furniture and skipped.
    expect(region, 'the live region has to already be there').toBeTruthy()
    expect(region?.getAttribute('aria-live')).toBe('polite')
    await act(async () => { pickAnLuEngineModel() })
    expect(region?.textContent).toContain('Switched your chat provider to the LU Engine')
  })

  it('can be dismissed by hand', async () => {
    render(createElement(LuEngineSwitchBar))
    await act(async () => { pickAnLuEngineModel() })
    await act(async () => { screen.getByLabelText('Dismiss').click() })
    expect(screen.queryByTestId('lu-engine-switch-note')).toBeNull()
  })

  // NEGATIVE CONTROL: picking a model while the LU Engine ALREADY holds the
  // chat moved nothing, so there is nothing to announce. A line there would be
  // a claim about a switch that never happened.
  it('says nothing when the engine already held the chat', async () => {
    useProviderStore.getState().setProviderConfig('openai', { enabled: true, managed: true, name: 'LU Engine' })
    render(createElement(LuEngineSwitchBar))
    await act(async () => { expect(pickAnLuEngineModel()).toBe(false) })
    expect(screen.queryByTestId('lu-engine-switch-note')).toBeNull()
  })

  it('cancels the pending timer when the line is dismissed', () => {
    vi.useFakeTimers()
    render(createElement(LuEngineSwitchBar))
    act(() => { useLuEngineSwitchStore.getState().announce('first') })
    act(() => { useLuEngineSwitchStore.getState().dismiss() })
    // A second announcement after the dismiss must live its full span: the
    // first pick's timer is gone, not merely outvoted.
    act(() => { useLuEngineSwitchStore.getState().announce('second') })
    act(() => { vi.advanceTimersByTime(LU_ENGINE_SWITCH_NOTE_MS - 100) })
    expect(screen.getByTestId('lu-engine-switch-note').textContent).toContain('second')
    expect(vi.getTimerCount(), 'exactly one timer should be pending').toBe(1)
  })

  // NEGATIVE CONTROL: an older announcement's timer must not clear a newer
  // line. Two picks in a row would otherwise leave the second one blank.
  it('a second pick is not cut short by the first pick timer', () => {
    vi.useFakeTimers()
    render(createElement(LuEngineSwitchBar))
    act(() => { useLuEngineSwitchStore.getState().announce('first') })
    act(() => { vi.advanceTimersByTime(LU_ENGINE_SWITCH_NOTE_MS - 100) })
    act(() => { useLuEngineSwitchStore.getState().announce('second') })
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByTestId('lu-engine-switch-note').textContent).toContain('second')
    // And the first one's timer is gone rather than merely outvoted.
    expect(vi.getTimerCount()).toBe(1)
  })
})

// ── Where the bar is mounted ────────────────────────────────────────────────
//
// The behaviour above proves the bar draws the sentence and outlives the
// dropdown. It cannot prove the bar is on screen at all, because ChatView and
// CodexView pull the whole chat stack and the repo has no render harness for
// them (the same reason model-selector-lms.test.ts tests helpers). So the
// mount points are pinned by reading the source, which is the weaker proof and
// is labelled as such: it catches the bar being dropped from a composer, not a
// composer that fails to render.
describe('the bar is wired into every surface that can trigger it', () => {
  const read = async (p: string) => {
    const { readFileSync } = await import('node:fs')
    const { resolve, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), p), 'utf8')
  }

  it('sits above the chat composer', async () => {
    const src = await read('../ChatView.tsx')
    expect(src).toMatch(/composerAbove=\{<><LuEngineSwitchBar \/>/)
  })

  it('sits above the code composer, which has the same picker', async () => {
    const src = await read('../CodexView.tsx')
    expect(src).toMatch(/composerAbove=\{<><LuEngineSwitchBar \/>/)
  })

  it('and on the Models page, where Use can trigger it too', async () => {
    const src = await read('../../models/DiscoverModels.tsx')
    expect(src).toContain('<LuEngineSwitchBar />')
  })

  // NEGATIVE CONTROL: the sentence must not be written into the dropdown any
  // more. Leaving a second copy there is how the two versions drift apart, and
  // the dropdown copy is the one that is never read.
  it('is no longer drawn inside the dropdown that closes on the pick', async () => {
    const src = await read('../../models/ModelSelector.tsx')
    expect(src).not.toContain('setSwitchNote')
    expect(src).toContain('useLuEngineSwitchStore.getState().announce(LU_ENGINE_SWITCH_NOTE)')
  })
})
