/**
 * @vitest-environment jsdom
 *
 * A17 (Windows counter-check 03.09.), the second durchfaller: "Der Picker sagt
 * nichts, wenn LM Studio gerade laedt."
 *
 * Click an LM Studio row, click a second row 150 ms later, and watch for
 * eighteen seconds. Nothing appears. The markup says why: while a pick is in
 * flight every row carries `role="button" tabindex="-1" aria-disabled="true"`,
 * and the row's click read
 *
 *     onClick={() => { if (!rowDisabled) void handleSelectModel(model) }}
 *
 * Both busy sentences live INSIDE `handleSelectModel`, so they sat behind the
 * one door that cannot open while the condition that would say them is true.
 *
 * This file mounts the real picker rather than reading its source, because the
 * bug was never in what the source says: `announceLmStudioLoadBusy()` was
 * there, spelled correctly, unreachable. Only a click on a rendered row can
 * tell those two apart.
 *
 * Run: npx vitest run src/components/models/__tests__/a-switched-off-row-still-names-the-wait.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { AIModel } from '../../../types/models'

// The picker's own list hook reaches for Tauri on mount. The models are the
// fixture below; nothing else about the hook is under test here.
const setActiveModel = vi.fn()
vi.mock('../../../hooks/useModels', () => ({
  useModels: () => ({
    models: MODELS,
    activeModel: 'openai::model-a',
    setActiveModel,
    fetchModels: vi.fn(),
  }),
}))

// The load that never finishes. This is the whole point: `selectingLms` stays
// set, so every row is switched off for as long as the test needs.
let releaseLoad: (() => void) | null = null
const loadLmStudioModel = vi.fn(() => new Promise<void>((resolve) => { releaseLoad = () => resolve() }))
vi.mock('../../../api/lmstudio', () => ({
  loadLmStudioModel: (...a: unknown[]) => loadLmStudioModel(...(a as [])),
  unloadLmStudioModel: vi.fn(async () => {}),
  listLoadedLmStudioModels: vi.fn(async () => [] as string[]),
}))
vi.mock('../../../api/ollama', () => ({
  listRunningModels: vi.fn(async () => [] as string[]),
  loadModel: vi.fn(async () => {}),
  unloadModel: vi.fn(async () => {}),
  unloadAllModels: vi.fn(async () => {}),
}))
vi.mock('../../../api/backend', () => ({ backendCall: vi.fn(async () => null) }))
vi.mock('../../../api/builtin-ensure', () => ({ diagnoseBuiltinEngine: vi.fn(async () => null) }))

const lmsModel = (name: string): AIModel => ({
  name, model: name, size: 0, type: 'text',
  provider: 'openai', providerName: 'LM Studio',
} as AIModel)

const MODELS: AIModel[] = [lmsModel('openai::model-a'), lmsModel('openai::model-b')]

const { ModelSelector } = await import('../ModelSelector')
const { useLuEngineSwitchStore } = await import('../../../stores/luEngineSwitchStore')
const { useModelStore } = await import('../../../stores/modelStore')
const { LM_STUDIO_LOAD_BUSY_NOTE, LU_ENGINE_SWAP_BUSY_NOTE } = await import('../../../api/lu-engine-switch')
const { __resetLuEngineSwapLockForTests, tryAcquireLuEngineSwap } = await import('../../../api/lu-engine-swap-lock')

function note() { return useLuEngineSwitchStore.getState().note }

/** Open the picker and hand back its rows, in list order. */
function openPicker(): HTMLElement[] {
  render(createElement(ModelSelector))
  fireEvent.click(screen.getByLabelText('Select chat model'))
  return screen.getAllByRole('button').filter((el) => el.getAttribute('aria-disabled') !== null)
}

beforeEach(() => {
  useLuEngineSwitchStore.setState({ note: null, tone: 'info', generation: 0 })
  useModelStore.setState({ models: MODELS })
  __resetLuEngineSwapLockForTests()
  releaseLoad = null
  loadLmStudioModel.mockClear()
})
afterEach(() => {
  cleanup()
  releaseLoad?.()
  useLuEngineSwitchStore.getState().dismiss()
  __resetLuEngineSwapLockForTests()
})

describe('a row that is switched off because a pick is running', () => {
  it('names the LM Studio wait when the second click lands', async () => {
    const rows = openPicker()
    expect(rows.length, 'both rows are on screen').toBe(2)

    // First click: LM Studio starts warming a model and never finishes.
    await act(async () => { fireEvent.click(rows[0]) })
    expect(loadLmStudioModel).toHaveBeenCalledTimes(1)
    expect(rows[1].getAttribute('aria-disabled'), 'the list is switched off').toBe('true')
    expect(note(), 'nothing is said until the second click').toBeNull()

    // Second click, on the switched-off row. This is the click that used to
    // disappear without a word.
    await act(async () => { fireEvent.click(rows[1]) })
    expect(note()).toBe(LM_STUDIO_LOAD_BUSY_NOTE)
    expect(note()).toBe('LM Studio is still loading a model, one moment.')
    // And it stayed a refusal: no second load went out.
    expect(loadLmStudioModel, 'the blocked click queued a pick').toHaveBeenCalledTimes(1)
    expect(setActiveModel, 'the blocked click activated a model').not.toHaveBeenCalled()
  })

  it('names the LU Engine wait instead while a swap of ours is running', async () => {
    const rows = openPicker()
    await act(async () => { fireEvent.click(rows[0]) })
    // The bolt is the only thing that can tell an LM Studio load from a swap
    // of our own engine, exactly as the open door decides it.
    tryAcquireLuEngineSwap()
    await act(async () => { fireEvent.click(rows[1]) })
    expect(note()).toBe(LU_ENGINE_SWAP_BUSY_NOTE)
  })

  it('answers a keyboard activation of the switched-off row too', async () => {
    const rows = openPicker()
    await act(async () => { fireEvent.click(rows[0]) })
    await act(async () => { fireEvent.keyDown(rows[1], { key: 'Enter' }) })
    expect(note()).toBe(LM_STUDIO_LOAD_BUSY_NOTE)
    expect(loadLmStudioModel).toHaveBeenCalledTimes(1)
  })

  // NEGATIVE CONTROL: with nothing running there is no wait, so there is
  // nothing to say. A click on a live row picks, in silence, as it always did.
  it('says nothing when no pick is in flight', async () => {
    const rows = openPicker()
    expect(rows[0].getAttribute('aria-disabled')).toBe('false')
    expect(note()).toBeNull()
  })
})

describe('blockedPickWait, the rule the row asks', () => {
  it('is silent unless a pick is actually in flight', async () => {
    const { blockedPickWait } = await import('../ModelSelector')
    expect(blockedPickWait(false, false), 'a dead row invented a wait').toBeNull()
    // A row switched off for some other reason while our engine happens to be
    // swapping elsewhere is still not a row anyone is waiting on.
    expect(blockedPickWait(false, true)).toBeNull()
  })

  it('lets the bolt pick which of the two waits it is', async () => {
    const { blockedPickWait } = await import('../ModelSelector')
    expect(blockedPickWait(true, false)).toBe('lm-studio')
    expect(blockedPickWait(true, true)).toBe('lu-engine')
  })
})
