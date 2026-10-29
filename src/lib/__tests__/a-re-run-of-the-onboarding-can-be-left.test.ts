/**
 * Jaeger B, B6: Settings, General, Onboarding, "Re-run onboarding", then
 * closing the wizard window quit LU ("onboarding window closed before setup
 * finished") and every later start forced the wizard with no way back. The
 * button flipped settings.onboardingDone to false in the persisted store, so
 * the store backup said "not set up" as well and nothing could tell the
 * abandoned re-run from a first install.
 *
 * Expected: with the wizard in its own window the store keeps
 * onboardingDone: true (Rust restores the marker when that window closes,
 * see `on_close` in onboarding_window.rs); only without that window does the
 * store flip, so the main window draws the wizard itself as before.
 *
 * Run: npx vitest run src/lib/__tests__/a-re-run-of-the-onboarding-can-be-left.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const backend = vi.hoisted(() => ({ backendCall: vi.fn() }))
vi.mock('../../api/backend', async () => {
  const actual = await vi.importActual<typeof import('../../api/backend')>('../../api/backend')
  return { ...actual, backendCall: backend.backendCall }
})

import { rerunOnboarding } from '../onboarding-rerun'
import { useSettingsStore } from '../../stores/settingsStore'

const calls: string[] = []
function rust(ownWindow: boolean | Error) {
  backend.backendCall.mockImplementation(async (cmd: string) => {
    calls.push(cmd)
    if (cmd === 'onboarding_window_open') {
      if (ownWindow instanceof Error) throw ownWindow
      return ownWindow
    }
    return undefined
  })
}

beforeEach(() => {
  calls.length = 0
  backend.backendCall.mockReset()
  useSettingsStore.getState().updateSettings({ onboardingDone: true })
})

describe('Re-run onboarding', () => {
  it('with its own window the store stays set up, so closing the wizard can lead back', async () => {
    rust(true)
    const reload = vi.fn()
    await rerunOnboarding(reload)
    expect(calls).toEqual(['set_onboarding_done', 'onboarding_window_open'])
    expect(backend.backendCall).toHaveBeenCalledWith('set_onboarding_done', { done: false })
    expect(useSettingsStore.getState().settings.onboardingDone).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('without its own window the main window draws the wizard, as before', async () => {
    rust(false)
    const reload = vi.fn()
    await rerunOnboarding(reload)
    expect(useSettingsStore.getState().settings.onboardingDone).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a Rust that does not answer counts as no window', async () => {
    rust(new Error('no tauri'))
    await rerunOnboarding(vi.fn())
    expect(useSettingsStore.getState().settings.onboardingDone).toBe(false)
  })

  it('Rust tells a closed re-run from an abandoned first install', () => {
    const rs = readFileSync(resolve(__dirname, '../../../src-tauri/src/onboarding_window.rs'), 'utf8')
    const rule = rs.slice(rs.indexOf('pub fn on_close('), rs.indexOf('fn back_to_the_app('))
    expect(rule).toContain('(false, false) => OnClose::Quit')
    expect(rule).toContain('(false, true) => OnClose::BackToTheApp')
  })
})
