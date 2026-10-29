/**
 * @vitest-environment jsdom
 *
 * Jaeger B, B13: "Context window (Ollama)" and "Max Tokens" took any number,
 * and 999999999 went out unchanged as num_ctx (a KV-cache reservation of that
 * size) and as the answer budget. The fields now clamp on blur and say so,
 * and the request paths clamp again for a value that reached the store by
 * any other way.
 *
 * Run: npx vitest run src/lib/__tests__/context-and-answer-limits-are-bounded.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../constants'
import { ollamaNumCtx } from '../../api/ollama'
import { effectiveSampling } from '../sampling'
import { CONTEXT_WINDOW_MAX, MAX_TOKENS_MAX } from '../number-limits'
import { BoundedNumberInput } from '../../components/settings/BoundedNumberInput'

beforeEach(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } }))
afterEach(() => cleanup())

describe('B13: context window and max tokens have an upper bound', () => {
  it('num_ctx never carries more than the cap, whatever the store holds', async () => {
    useSettingsStore.getState().updateSettings({ contextWindowOverride: 999_999_999 })
    expect(await ollamaNumCtx('llama3:8b', 'chat')).toBe(CONTEXT_WINDOW_MAX)
    useSettingsStore.getState().updateSettings({ contextWindowOverride: 16_384 })
    expect(await ollamaNumCtx('llama3:8b', 'chat')).toBe(16_384)
  })

  it('the answer budget sent is clamped, 0 stays model default', () => {
    expect(effectiveSampling({ temperature: 0.7, topP: 0.9, maxTokens: 2_000_000_000 }).maxTokens).toBe(MAX_TOKENS_MAX)
    expect(effectiveSampling({ temperature: 0.7, topP: 0.9, maxTokens: 0 }).maxTokens).toBe(0)
    expect(effectiveSampling({ temperature: 0.7, topP: 0.9, maxTokens: 999 }).maxTokens).toBe(999)
  })

  it('the field keeps the draft while typing, clamps on blur and says so', () => {
    let saved = -1
    render(createElement(BoundedNumberInput, { ariaLabel: 'Context window (Ollama)', value: 0, max: CONTEXT_WINDOW_MAX, onCommit: (v: number) => { saved = v } }))
    const el = screen.getByLabelText('Context window (Ollama)') as HTMLInputElement
    fireEvent.change(el, { target: { value: '999999999' } })
    expect(saved).toBe(-1)
    expect(el.value).toBe('999999999')
    fireEvent.blur(el)
    expect(saved).toBe(CONTEXT_WINDOW_MAX)
    expect(screen.getByRole('status').textContent).toContain('1,048,576')
    fireEvent.change(el, { target: { value: '8192' } })
    fireEvent.keyDown(el, { key: 'Enter' })
    expect(saved).toBe(8192)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
