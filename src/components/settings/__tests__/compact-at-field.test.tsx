/**
 * @vitest-environment jsdom
 *
 * Jaeger B, B1: Settings, General, Generation, "Compact at". Typing 50 saved
 * the 5 first, which the 0-or-30-95 rule turned into 0, and an arrow step
 * went 0, 5, 0. The field keeps a draft while typing and saves on blur or
 * Enter; a step jumps the gap between 0 and 30.
 *
 * Run: npx vitest run src/components/settings/__tests__/compact-at-field.test.tsx
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useSettingsStore } from '../../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../../lib/constants'
import { stepCompactPercent } from '../../../lib/settings-catalog'

const { CompactThresholdInput } = await import('../CompactThresholdInput')

const field = () => screen.getByLabelText('Auto-compact at') as HTMLInputElement
const stored = () => useSettingsStore.getState().settings.autoCompactThreshold

/** What a keystroke does: set the value and send an InputEvent that says it was typed. */
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value.slice(-1) }))
}

/** What a spin button does: the value moves by the step, with a plain input event. */
function spin(el: HTMLInputElement, value: string) {
  fireEvent.change(el, { target: { value } })
}

beforeEach(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, autoCompact: true, autoCompactThreshold: 0 } }))
afterEach(() => cleanup())

describe('Compact at', () => {
  it('typing 5 then 50 keeps the digits and saves 50 % on blur', () => {
    render(createElement(CompactThresholdInput))
    type(field(), '5')
    expect(field().value).toBe('5')
    type(field(), '50')
    expect(field().value).toBe('50')
    fireEvent.blur(field())
    expect(stored()).toBe(0.5)
    expect(field().value).toBe('50')
  })

  it('Enter saves what was typed; a value in the gap becomes 0', () => {
    render(createElement(CompactThresholdInput))
    type(field(), '80')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(stored()).toBe(0.8)
    type(field(), '12')
    fireEvent.blur(field())
    expect(stored()).toBe(0)
    expect(field().value).toBe('0')
  })

  it('arrow up goes 0, 30, 35 and arrow down comes back to 0', () => {
    render(createElement(CompactThresholdInput))
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(stored()).toBe(0.3)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(stored()).toBe(0.35)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(stored()).toBe(0)
    expect(field().value).toBe('0')
  })

  it('the spin buttons jump the gap too', () => {
    render(createElement(CompactThresholdInput))
    spin(field(), '5')
    expect(stored()).toBe(0.3)
    expect(field().value).toBe('30')
    spin(field(), '25')
    expect(stored()).toBe(0)
  })

  it('stepCompactPercent stays inside 0 and 30 to 95', () => {
    expect(stepCompactPercent(0, 1)).toBe(30)
    expect(stepCompactPercent(95, 1)).toBe(95)
    expect(stepCompactPercent(30, -1)).toBe(0)
    expect(stepCompactPercent(0, -1)).toBe(0)
    expect(stepCompactPercent(50, -1)).toBe(45)
  })
})
