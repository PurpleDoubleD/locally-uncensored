// @vitest-environment jsdom
/**
 * The box, 03.10.2026: closing the Cloud sheet ("Not now", Escape, a click
 * beside it) switched "Show Cloud features in Local mode" off, and the LU
 * Cloud group was gone from the model picker without a word. Closing is only
 * closing. The one control on the sheet that turns the setting off says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

const openExternal = vi.hoisted(() => vi.fn())
vi.mock('../../../api/backend', async () => ({
  ...(await vi.importActual<typeof import('../../../api/backend')>('../../../api/backend')),
  openExternal,
}))
vi.mock('../../../lib/hardware', () => ({ getMaxVramGb: () => Promise.resolve(12) }))

import { CloudTeaserModal } from '../CloudTeaserModal'
import { useUIStore } from '../../../stores/uiStore'
import { useSettingsStore } from '../../../stores/settingsStore'

const enabled = () => useSettingsStore.getState().settings.cloudTeasersEnabled
const open = () => useUIStore.getState().cloudTeaser !== null

beforeEach(async () => {
  openExternal.mockReset()
  useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: true })
  useUIStore.getState().setCloudTeaser({ surface: 'intent', intent: 'upscale' })
  await act(async () => { render(<CloudTeaserModal />) })
})
afterEach(() => cleanup())

describe('closing the Cloud sheet', () => {
  it('"Not now" closes it and leaves the setting on', () => {
    fireEvent.click(screen.getByText('Not now'))
    expect(open()).toBe(false)
    expect(enabled()).toBe(true)
  })

  it('Escape closes it and leaves the setting on', () => {
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(open()).toBe(false)
    expect(enabled()).toBe(true)
  })

  it('a click beside it closes it and leaves the setting on', () => {
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(open()).toBe(false)
    expect(enabled()).toBe(true)
  })

  it('the X closes it and leaves the setting on', () => {
    fireEvent.click(screen.getByLabelText('Close'))
    expect(open()).toBe(false)
    expect(enabled()).toBe(true)
  })

  it('"Subscribe" opens the checkout and leaves the setting on', () => {
    fireEvent.click(screen.getByTestId('buy-sub'))
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(open()).toBe(false)
    expect(enabled()).toBe(true)
  })

  it('a click inside the sheet does not close it', () => {
    fireEvent.click(screen.getByRole('dialog'))
    expect(open()).toBe(true)
  })
})

describe('the link that turns the Cloud features off', () => {
  it('says what it does, turns the setting off and closes the sheet', () => {
    const link = screen.getByText("Don't show Cloud features in Local mode")
    expect(link.getAttribute('title')).toContain('Settings, General')
    fireEvent.click(link)
    expect(enabled()).toBe(false)
    expect(open()).toBe(false)
  })
})
