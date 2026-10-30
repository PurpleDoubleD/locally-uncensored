/**
 * @vitest-environment jsdom
 *
 * B27 (3.0.9): Discord .molot, 28.10.2026, "free RAM and unload the model
 * after rendering". ComfyUI kept every model on the card and in RAM after a
 * render until it was closed. Now a setting decides, and the default gives
 * the memory back five minutes after the last render.
 *
 * Run: npx vitest run src/lib/__tests__/free-after-render.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/backend')>()),
  isTauri: () => false,
  backendCall: vi.fn(async () => []),
}))
vi.mock('../../api/mlx-image', () => ({ isMlxImageHost: () => false }))

const {
  scheduleFreeAfterRender, cancelFreeAfterRender, freeAfterRenderMode, freeAfterRenderPending,
  FREE_AFTER_IDLE_MS, FREE_AFTER_NOW_GRACE_MS,
} = await import('../free-after-render')
const { DEFAULT_SETTINGS } = await import('../constants')
const { HardwareSettings } = await import('../../components/settings/HardwareSettings')
const { useSettingsStore } = await import('../../stores/settingsStore')

describe('when the memory goes back', () => {
  beforeEach(() => { vi.useFakeTimers(); cancelFreeAfterRender() })
  afterEach(() => { vi.useRealTimers() })

  it('the default frees five minutes after the render, and a profile without the key gets it', async () => {
    expect(DEFAULT_SETTINGS.freeAfterRender).toBe('idle')
    expect(freeAfterRenderMode(undefined)).toBe('idle')
    const free = vi.fn(async () => {})
    scheduleFreeAfterRender(freeAfterRenderMode(undefined), () => false, free)
    await vi.advanceTimersByTimeAsync(FREE_AFTER_IDLE_MS - 1000)
    expect(free).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(free).toHaveBeenCalledTimes(1)
    expect(FREE_AFTER_IDLE_MS).toBe(5 * 60_000)
  })

  it('a render that starts in between keeps the models', async () => {
    const free = vi.fn(async () => {})
    scheduleFreeAfterRender('idle', () => false, free)
    await vi.advanceTimersByTimeAsync(60_000)
    cancelFreeAfterRender()
    expect(freeAfterRenderPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(FREE_AFTER_IDLE_MS)
    expect(free).not.toHaveBeenCalled()
  })

  it('a render running elsewhere when the time comes keeps them too', async () => {
    const free = vi.fn(async () => {})
    scheduleFreeAfterRender('now', () => true, free)
    await vi.advanceTimersByTimeAsync(FREE_AFTER_NOW_GRACE_MS)
    expect(free).not.toHaveBeenCalled()
  })

  it('"now" frees after a short grace, "keep" never', async () => {
    const free = vi.fn(async () => {})
    scheduleFreeAfterRender('now', () => false, free)
    await vi.advanceTimersByTimeAsync(FREE_AFTER_NOW_GRACE_MS)
    expect(free).toHaveBeenCalledTimes(1)
    expect(FREE_AFTER_NOW_GRACE_MS).toBeLessThanOrEqual(15_000)
    scheduleFreeAfterRender('keep', () => false, free)
    expect(freeAfterRenderPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(FREE_AFTER_IDLE_MS * 2)
    expect(free).toHaveBeenCalledTimes(1)
  })
})

describe('both render paths plan it and call it off', () => {
  const src = (f: string) => readFileSync(resolve(__dirname, '..', '..', f), 'utf8')
  it('Create', () => {
    const create = src('hooks/useCreate.ts')
    expect(create).toMatch(/abortRef\.current = new AbortController\(\)\n\s+\/\/ B27[^\n]*\n\s+cancelFreeAfterRender\(\)/)
    expect(create).toMatch(/if \(renderEviction\) void restoreChatBackendsAfterRender\(renderEviction\)\n(.*\n){0,3}\s+\/\/ B27[^\n]*\n\s+scheduleFreeAfterRender\(/)
  })
  it('a picture or video the chat asked for', () => {
    const handoff = src('api/vram-handoff.ts')
    expect(handoff).toMatch(/_activeHandoffs\+\+\n\s+cancelFreeAfterRender\(\)/)
    expect(handoff).toMatch(/emitHandoff\('done', \{ kind \}\)\n(\s+\/\/[^\n]*\n)+\s+scheduleFreeAfterRender\(/)
  })
})

describe('the setting in Hardware', () => {
  afterEach(() => cleanup())
  it('shows the three choices with the default picked, and a click stores the choice', () => {
    useSettingsStore.getState().updateSettings({ freeAfterRender: undefined })
    render(<HardwareSettings />)
    const box = screen.getByTestId('free-after-render')
    const radios = box.querySelectorAll('input[type=radio]')
    expect(radios).toHaveLength(3)
    expect((radios[0] as HTMLInputElement).checked).toBe(true)
    expect(box.textContent).toContain('Free memory after 5 minutes (recommended)')
    fireEvent.click(radios[1])
    expect(useSettingsStore.getState().settings.freeAfterRender).toBe('now')
  })
})
