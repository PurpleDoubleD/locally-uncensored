/**
 * @vitest-environment jsdom
 *
 * 3.0.8, A25. Discord, 22.10.2026 (RTX 5070 Ti 16 GB): gemma-4-31B at a 64K
 * context put 22 of 60 layers on the card, and nothing on screen said that
 * the context was what cost them. The engine now works the numbers out from
 * the model's head (Rust, vram_plan.rs) and the status carries the sentence
 * with the changes that would help, as buttons. These tests hold:
 *
 *   - the sentence and its buttons stand in the model menu's line, on the
 *     Models page and in Settings, LU Engine;
 *   - a button saves the change and restarts the engine with it, through the
 *     same swap Settings' Apply & Restart uses;
 *   - a context from a button is a choice (GH #129), a quantized cache never
 *     leaves Flash Attention off;
 *   - nothing from the status that is not a known button is drawn as one;
 *   - a context typed into Settings is a choice too;
 *   - an MoE model with its experts on the processor says so.
 *
 * Run: npx vitest run src/components/settings/__tests__/engine-fit-advice-with-buttons.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

const backendCall = vi.fn()
vi.mock('../../../api/backend', () => ({
  backendCall: (cmd: string, args?: unknown) => backendCall(cmd, args),
  isTauri: () => true,
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
  openExternal: vi.fn(),
  secretGet: vi.fn().mockRejectedValue(new Error('no keychain here')),
  secretSet: vi.fn(),
  secretDelete: vi.fn(),
}))

const { engineOffloadLine, announceEngineCpuFallback, __resetEngineCpuFallbackNote } = await import('../../../lib/engine-offload')
const { fitActionsOf, tuningAfter } = await import('../../../lib/engine-fit')
const { applyFitAction } = await import('../../../api/engine-fit-apply')
const { useLuEngineSwitchStore } = await import('../../../stores/luEngineSwitchStore')
const { useSettingsStore } = await import('../../../stores/settingsStore')
const { BuiltinEngineSettings } = await import('../BuiltinEngineSettings')
const { LuEngineSwitchBar } = await import('../../chat/LuEngineSwitchBar')

const ADVICE = 'With 64K context, 24 of 60 layers fit on the graphics card; the rest run on the processor, which is slower. With 16K, 30 fit. With KV q8_0, 30 fit.'
const ACTIONS: Array<{ label: string; ctx?: number; kv?: 'q8_0' | 'q4_0' }> = [
  { label: 'Context 16K', ctx: 16384 },
  { label: 'KV q8_0', kv: 'q8_0' },
]

/** The engine of the Discord report, as `bundled_engine_status` answers. */
const STATUS = {
  running: true, healthy: true, port: 8127,
  model_path: 'C:/models/gemma-4-31B-it-Q4_K_M.gguf', ctx: 65536,
  cpuOnly: false, gpuLayers: 25, sanityNote: null, imageNote: null,
  memoryNote: ADVICE, fitActions: ACTIONS, cpuMoe: 0,
}

const DEFAULTS = { ...useSettingsStore.getState().settings.builtinEngine }

beforeEach(() => {
  backendCall.mockReset()
  backendCall.mockImplementation(async (cmd: string) => (cmd === 'bundled_engine_status' ? STATUS : { status: 'started', port: 8127 }))
  __resetEngineCpuFallbackNote()
  useLuEngineSwitchStore.getState().dismiss()
  useSettingsStore.getState().updateSettings({ builtinEngine: { ...DEFAULTS, ctx: 65536, ctxChosen: true } })
})
afterEach(() => { cleanup() })

function swaps(): Array<{ modelPath: string; tuning: Record<string, unknown> }> {
  return backendCall.mock.calls.filter(([cmd]) => cmd === 'swap_bundled_model').map(([, args]) => args)
}

describe('the buttons Rust sends', () => {
  it('are kept only when they are buttons LU knows', () => {
    expect(fitActionsOf(ACTIONS)).toHaveLength(2)
    expect(fitActionsOf(null)).toEqual([])
    expect(fitActionsOf([{ label: 'x' }, { label: '', ctx: 8192 }, { label: 'KV', kv: 'q2' }, { label: 'Huge', ctx: 1e9 }, 'Context 8K'])).toEqual([])
  })

  it('make a context a choice and never leave a quantized cache without Flash Attention', () => {
    const base = { ...DEFAULTS, flashAttn: 'off' as const, ctxChosen: false }
    expect(tuningAfter(base, { label: 'Context 16K', ctx: 16384 })).toMatchObject({ ctx: 16384, ctxChosen: true, flashAttn: 'off' })
    expect(tuningAfter(base, { label: 'KV q8_0', kv: 'q8_0' })).toMatchObject({ cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', flashAttn: 'auto' })
  })

  it('save the change and restart the engine with it', async () => {
    await applyFitAction({ label: 'Context 16K', ctx: 16384 }, STATUS.model_path)
    expect(useSettingsStore.getState().settings.builtinEngine).toMatchObject({ ctx: 16384, ctxChosen: true })
    expect(swaps()).toHaveLength(1)
    expect(swaps()[0].modelPath).toBe(STATUS.model_path)
    expect(swaps()[0].tuning).toMatchObject({ ctx: 16384, ctxChosen: true })
  })

  it('only save when no engine runs to restart', async () => {
    await applyFitAction({ label: 'KV q8_0', kv: 'q8_0' }, null)
    expect(useSettingsStore.getState().settings.builtinEngine).toMatchObject({ cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' })
    expect(swaps()).toHaveLength(0)
  })
})

describe('the standing line', () => {
  it('carries the sentence with its buttons, and a click restarts with the change', async () => {
    announceEngineCpuFallback(STATUS)
    expect(useLuEngineSwitchStore.getState().note).toBe(ADVICE)
    expect(useLuEngineSwitchStore.getState().actions.map((a) => a.label)).toEqual(['Context 16K', 'KV q8_0'])
    render(createElement(LuEngineSwitchBar))
    const bar = screen.getByTestId('lu-engine-switch-note')
    expect(bar.textContent).toContain('24 of 60 layers fit')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'KV q8_0' })) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(swaps()).toHaveLength(1)
    expect(swaps()[0].tuning).toMatchObject({ cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' })
    // Done: the line about the old settings goes.
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
  })

  it('has no buttons for a line that is not the fit sentence', () => {
    useLuEngineSwitchStore.getState().announce('Switched your chat provider to the LU Engine for this model.')
    render(createElement(LuEngineSwitchBar))
    expect(screen.queryByTestId('fit-actions')).toBeNull()
  })
})

describe('Settings, LU Engine', () => {
  it('shows the same sentence and buttons while the engine runs', async () => {
    render(createElement(BuiltinEngineSettings))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const fit = screen.getByTestId('builtin-engine-fit')
    expect(fit.textContent).toContain(ADVICE)
    expect(screen.getByRole('button', { name: 'Context 16K' })).toBeTruthy()
  })

  it('marks a context typed into the field as chosen', async () => {
    useSettingsStore.getState().updateSettings({ builtinEngine: { ...DEFAULTS } })
    render(createElement(BuiltinEngineSettings))
    await act(async () => { await Promise.resolve() })
    const field = screen.getByPlaceholderText('8192')
    fireEvent.change(field, { target: { value: '16384' } })
    expect(useSettingsStore.getState().settings.builtinEngine).toMatchObject({ ctx: 16384, ctxChosen: true })
    fireEvent.change(field, { target: { value: '0' } })
    expect(useSettingsStore.getState().settings.builtinEngine).toMatchObject({ ctx: 0, ctxChosen: false })
  })
})

describe('an MoE model with its experts on the processor', () => {
  it('says every layer is on the card and how many layers keep their experts on the CPU', () => {
    expect(engineOffloadLine({ running: true, gpuLayers: null, cpuMoe: 12 })).toBe('GPU layers: all, experts of 12 on the CPU')
    expect(engineOffloadLine({ running: true, gpuLayers: null, cpuMoe: 0 })).toBeNull()
    expect(engineOffloadLine({ running: true, gpuLayers: null, cpuFfn: 9 })).toBe('GPU layers: all, FFN of 9 on the CPU')
    expect(engineOffloadLine({ running: true, gpuLayers: null, cpuFfn: 0 })).toBeNull()
  })
})
