/**
 * @vitest-environment jsdom
 *
 * The effort control, rendered for real.
 *
 * Every other test around this feature reads source text. That proves the code
 * SAYS the right thing; it cannot prove the button appears for the right model,
 * disappears for the wrong one, or writes anything when clicked. This one
 * mounts the composer, swaps the active model underneath it, and clicks.
 *
 * Four claims, one per model shape the catalogue really produces
 * (ops/wissen/deepinfra-modellmatrix-2026-09-02.md):
 *
 *   think 'always' with a ladder  (GLM 5.3 Flash) -> control visible
 *   think 'never'  without one    (Llama 3.1 8B)  -> nothing at all
 *   think 'toggle' with a ladder, Think switched off -> nothing, because
 *                                    nothing is being spent on reasoning
 *   a click -> the next rung, in the store, where every surface reads it
 *
 * Run: npx vitest run src/components/chat/__tests__/effort-control-renders.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatInput } from '../ChatInput'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useModelStore } from '../../../stores/modelStore'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import type { AIModel } from '../../../types/models'

// The composer's dictation button reaches for the microphone and the Tauri
// bridge on mount. Neither exists here and neither is what this file is about.
vi.mock('../VoiceButton', () => ({ VoiceButton: () => null }))

const cloudModel = (over: Partial<AIModel> & { name: string }): AIModel =>
  ({
    model: over.name, size: 0, type: 'text', provider: 'lu-cloud',
    providerName: 'LU Cloud', contextLength: 128000, supportsTools: true,
    ...over,
  }) as AIModel

/** GLM 5.3 Flash: reasons no matter what, and declares four rungs. */
const ALWAYS = cloudModel({
  name: 'lu-cloud::zai-org/GLM-5.3-Flash',
  thinkMode: 'always',
  effortLevels: ['low', 'medium', 'high', 'max'],
  effortDefault: 'high',
})
/** Llama 3.1 8B: an instruct model, so the server declares no ladder. */
const NEVER = cloudModel({ name: 'lu-cloud::meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', thinkMode: 'never' })
/** Qwen3 30B: the switch works, and the rungs only matter while it is on. */
const TOGGLE = cloudModel({
  name: 'lu-cloud::Qwen/Qwen3-30B-A3B',
  thinkMode: 'toggle',
  effortLevels: ['low', 'medium', 'high'],
  effortDefault: 'high',
})

function show(model: AIModel) {
  useModelStore.setState({ models: [ALWAYS, NEVER, TOGGLE], activeModel: model.name })
  return render(createElement(ChatInput, { onSend: () => {}, onStop: () => {}, isGenerating: false }))
}

const effortButton = () => screen.queryByTestId('effort-toggle')

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})
afterEach(() => cleanup())

describe('the effort control appears exactly where it is true', () => {
  it('a model that always reasons shows it, with the Think button locked on beside it', () => {
    show(ALWAYS)
    expect(effortButton()).not.toBeNull()
    expect(effortButton()!.textContent).toBe('High')
  })

  it('a model that never reasons shows nothing, there is no ladder and no thought to spend', () => {
    show(NEVER)
    expect(effortButton()).toBeNull()
  })

  it('a toggle model shows it while thinking is on', () => {
    show(TOGGLE)
    expect(effortButton()).not.toBeNull()
  })

  it('and hides it the moment thinking is switched off', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, thinkingEnabled: false } })
    show(TOGGLE)
    expect(effortButton()).toBeNull()
  })

  it('the label is the CLAMPED rung, so it cannot promise a rung the model has not got', () => {
    // Global wish 'max', and this model tops out at 'high'.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, reasoningEffort: 'max' } })
    show(TOGGLE)
    expect(effortButton()!.textContent).toBe('High')
  })
})

describe('a click moves the rung, in the store every surface reads', () => {
  it('THE GESTURE: one click is one rung up', () => {
    show(ALWAYS)
    fireEvent.click(effortButton()!)
    expect(useSettingsStore.getState().settings.reasoningEffort).toBe('max')
    expect(effortButton()!.textContent).toBe('Max')
  })

  it('and it wraps at the top of the model ladder rather than running off it', () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, reasoningEffort: 'max' } })
    show(ALWAYS)
    fireEvent.click(effortButton()!)
    expect(useSettingsStore.getState().settings.reasoningEffort).toBe('low')
    expect(effortButton()!.textContent).toBe('Low')
  })

  it('a click on a narrow ladder writes the CLAMPED rung globally, the same as the web app', () => {
    // Deliberate and confirmed behaviour, not an oversight: the wish is one
    // global setting, so cycling on a three-rung model leaves 'high' behind
    // rather than the 'max' the user last had on a four-rung one.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, reasoningEffort: 'max' } })
    show(TOGGLE)
    fireEvent.click(effortButton()!)
    expect(useSettingsStore.getState().settings.reasoningEffort).toBe('low')
  })

  it('the tooltip says the rung, the gesture and the price', () => {
    show(ALWAYS)
    expect(effortButton()!.getAttribute('title')).toBe(
      'Reasoning effort: High. Click to cycle. Higher effort spends more output tokens.',
    )
  })
})
