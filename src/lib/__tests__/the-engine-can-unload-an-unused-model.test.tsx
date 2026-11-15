// @vitest-environment jsdom
/**
 * Discord 21.10.2026 ("Is it normal behavior to some models use this much ram
 * even when not doing anything?"): the LU Engine keeps the chat model loaded
 * for as long as the app runs. Settings, LU Engine now offers to unload it
 * after a while without use. The minutes go to Rust at boot and on every
 * change (the watch itself is tested in engine_idle.rs), and an unload is said
 * in the standing line.
 *
 * Run: npx vitest run src/lib/__tests__/the-engine-can-unload-an-unused-model.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const backendCall = vi.fn(async () => null)
vi.mock('../../api/backend', async (o) => ({
  ...(await o<typeof import('../../api/backend')>()),
  isTauri: () => true,
  isWindows: () => true,
  backendCall: (...a: unknown[]) => backendCall(...(a as [])),
}))
const listeners = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>())
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => { listeners.set(name, fn); return () => {} },
}))

import { idleUnloadLabel, idleUnloadMinutes, idleUnloadedNote, startEngineIdleUnloadSync, ENGINE_IDLE_UNLOADED_EVENT } from '../engine-idle-unload'
import { BuiltinEngineSettings } from '../../components/settings/BuiltinEngineSettings'
import { IdleUnloadSetting } from '../../components/settings/IdleUnloadSetting'
import { useSettingsStore } from '../../stores/settingsStore'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'
import { DEFAULT_SETTINGS } from '../constants'

const idleCalls = () => backendCall.mock.calls.filter((c) => (c as unknown[])[0] === 'set_engine_idle_unload').map((c) => (c as unknown[])[1])

beforeEach(() => {
  cleanup()
  backendCall.mockClear()
  useSettingsStore.getState().updateSettings({ engineIdleUnloadMinutes: 0 })
})

describe('unloading an unused model', () => {
  it('is off by default, and a profile without the key reads as off', () => {
    expect(DEFAULT_SETTINGS.engineIdleUnloadMinutes).toBe(0)
    expect(idleUnloadMinutes(undefined)).toBe(0)
    expect(idleUnloadMinutes(-5)).toBe(0)
    expect(idleUnloadMinutes(Number.NaN)).toBe(0)
    expect(idleUnloadMinutes(30)).toBe(30)
  })

  it('names its choices in plain words', () => {
    expect(idleUnloadLabel(0)).toBe('Never')
    expect(idleUnloadLabel(10)).toBe('After 10 minutes')
    expect(idleUnloadLabel(60)).toBe('After 1 hour')
    expect(idleUnloadLabel(120)).toBe('After 2 hours')
  })

  it('picked in Settings, it reaches Rust at boot and on every change', async () => {
    useSettingsStore.getState().updateSettings({ engineIdleUnloadMinutes: 30 })
    await startEngineIdleUnloadSync()
    expect(idleCalls()).toEqual([{ minutes: 30 }])

    render(<IdleUnloadSetting />)
    fireEvent.change(screen.getByTestId('engine-idle-unload'), { target: { value: '10' } })
    expect(useSettingsStore.getState().settings.engineIdleUnloadMinutes).toBe(10)
    await vi.waitFor(() => expect(idleCalls()).toContainEqual({ minutes: 10 }))
  })

  it('says the unload in the standing line', async () => {
    await startEngineIdleUnloadSync()
    await vi.waitFor(() => expect(listeners.has(ENGINE_IDLE_UNLOADED_EVENT)).toBe(true))
    listeners.get(ENGINE_IDLE_UNLOADED_EVENT)!({ payload: { minutes: 60, model: '/m/gemma.gguf' } })
    expect(useLuEngineSwitchStore.getState().note).toBe(idleUnloadedNote(60))
    expect(idleUnloadedNote(60)).toBe('The LU Engine unloaded the model after 1 hour without use, so its memory is free. The next message loads it again.')
  })

  it('tells a Windows user that mmap is already off with layers on the card', () => {
    render(<BuiltinEngineSettings />)
    expect(screen.getByText(/On Windows LU already loads without mmap whenever layers go to the graphics card/)).toBeTruthy()
  })
})
