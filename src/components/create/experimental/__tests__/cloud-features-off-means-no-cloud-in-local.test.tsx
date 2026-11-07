// @vitest-environment jsdom
/**
 * The box, 04.10.2026: with "Show Cloud features in Local mode" off, the
 * Create bar kept "Enhance" and "Erase" with their cloud tag, and a click
 * still opened the Cloud sheet. The switch only took the LU Cloud rows out of
 * the model pickers. Off now means: no cloud tag and no Cloud sheet in Local
 * mode. A tool that cannot run on this machine is left out of the bar, the
 * way the Mac already leaves out what MLX cannot do.
 *
 * And the click on "Don't show Cloud features in Local mode" is answered: one
 * line says where to turn them back on.
 *
 * 3.0.7: Enhance runs on local ComfyUI (core upscale nodes), so it is a local
 * tab now and only Erase is the hosted-only tool these tests watch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

const mlx = vi.hoisted(() => ({ host: false }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => mlx.host }))
vi.mock('../../../../lib/hardware', () => ({ getMaxVramGb: () => Promise.resolve(12) }))

import { IntentBar } from '../IntentBar'
import { INTENTS, isIntentLocked, visibleIntents } from '../intents'
import { CloudTeaserModal } from '../../../cloud/CloudTeaserModal'
import { CloudHiddenNotice, CLOUD_HIDDEN_NOTICE, CLOUD_HIDDEN_NOTICE_MS } from '../../../cloud/CloudHiddenNotice'
import { useCreateStore } from '../../../../stores/createStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { useUIStore } from '../../../../stores/uiStore'

const setFeatures = (on: boolean) => useSettingsStore.getState().updateSettings({ cloudTeasersEnabled: on })
const pills = () => screen.getAllByRole('radio').map((b) => b.textContent)
const cloudTagged = () => screen.getAllByRole('radio').filter((b) => /runs on LU Cloud/.test(b.getAttribute('aria-label') ?? ''))

beforeEach(() => {
  mlx.host = false
  useCreateStore.setState({ backend: 'local' })
  useUIStore.setState({ cloudTeaser: null, cloudHiddenNotice: false })
  setFeatures(true)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('the rule', () => {
  it('on: every tool is in the local bar, the hosted-only ones as teasers', () => {
    expect(visibleIntents('local', false, true)).toEqual(INTENTS)
  })

  it('off: the local bar holds exactly the tools that run locally', () => {
    const ids = visibleIntents('local', false, false).map((m) => m.id)
    expect(ids).toContain('upscale')
    expect(ids).not.toContain('eraser')
    expect(ids).toEqual(INTENTS.filter((m) => !isIntentLocked(m, 'local', false)).map((m) => m.id))
    expect(ids).toEqual(expect.arrayContaining(['image', 'edit', 'removebg', 'upscale', 'video', 'animate', 'character', 'lipsync', 'music', 'extend', 'motion']))
  })

  it('off on a Mac: only what the Mac runs itself', () => {
    expect(visibleIntents('local', true, false).map((m) => m.id)).toEqual(['image', 'removebg', 'video', 'character'])
  })

  it('cloud mode shows everything, whatever the switch says', () => {
    expect(visibleIntents('cloud', false, false)).toEqual(INTENTS)
    expect(visibleIntents('cloud', true, false)).toEqual(INTENTS)
  })
})

describe('the bar', () => {
  it('on: Erase and Swap carry the cloud tag and open the Cloud sheet, Enhance is a local tab', () => {
    render(<IntentBar />)
    // Swap Character (07.11.2026) has no local lane either: a cloud pill.
    expect(cloudTagged().map((b) => b.textContent)).toEqual(['Erase', 'Swap'])
    fireEvent.click(screen.getByRole('radio', { name: /Swap Character/ }))
    expect(useUIStore.getState().cloudTeaser).toEqual({ surface: 'intent', intent: 'swap_character' })
    useUIStore.setState({ cloudTeaser: null })
    fireEvent.click(screen.getByRole('radio', { name: /Erase Object/ }))
    expect(useUIStore.getState().cloudTeaser).toEqual({ surface: 'intent', intent: 'eraser' })
    useUIStore.setState({ cloudTeaser: null })
    fireEvent.click(screen.getByRole('radio', { name: /Enhance Image/ }))
    expect(useUIStore.getState().cloudTeaser).toBeNull()
    expect(useCreateStore.getState().intent()).toBe('upscale')
  })

  it('off: no cloud tag, no Erase, nothing left that opens the Cloud sheet', () => {
    setFeatures(false)
    render(<IntentBar />)
    expect(cloudTagged()).toEqual([])
    expect(pills()).toContain('Enhance')
    expect(pills()).not.toContain('Erase')
    for (const b of screen.getAllByRole('radio')) fireEvent.click(b)
    expect(useUIStore.getState().cloudTeaser).toBeNull()
  })

  it('the switch acts on the bar that is on screen', () => {
    render(<IntentBar />)
    expect(pills()).toContain('Erase')
    act(() => setFeatures(false))
    expect(pills()).not.toContain('Erase')
    act(() => setFeatures(true))
    expect(pills()).toContain('Erase')
  })
})

describe('the link on the Cloud sheet is answered', () => {
  const clickLink = async () => {
    useUIStore.getState().setCloudTeaser({ surface: 'intent', intent: 'eraser' })
    await act(async () => { render(<><CloudHiddenNotice /><IntentBar /><CloudTeaserModal /></>) })
    fireEvent.click(screen.getByText("Don't show Cloud features in Local mode"))
  }

  it('says where to turn them back on, and the cloud tabs are gone', async () => {
    expect(screen.queryByText(CLOUD_HIDDEN_NOTICE)).toBeNull()
    await clickLink()
    expect(CLOUD_HIDDEN_NOTICE).toBe('Cloud features are hidden. Turn them back on in Settings, General.')
    expect(screen.getByRole('status').textContent).toContain(CLOUD_HIDDEN_NOTICE)
    expect(pills()).not.toContain('Erase')
  })

  it('closing the sheet any other way says nothing', async () => {
    useUIStore.getState().setCloudTeaser({ surface: 'intent', intent: 'upscale' })
    await act(async () => { render(<><CloudHiddenNotice /><CloudTeaserModal /></>) })
    fireEvent.click(screen.getByText('Not now'))
    expect(screen.queryByText(CLOUD_HIDDEN_NOTICE)).toBeNull()
  })

  it('leaves on its X', async () => {
    await clickLink()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText(CLOUD_HIDDEN_NOTICE)).toBeNull()
  })

  it('leaves by itself after a while', async () => {
    vi.useFakeTimers()
    await clickLink()
    expect(screen.queryByText(CLOUD_HIDDEN_NOTICE)).not.toBeNull()
    act(() => { vi.advanceTimersByTime(CLOUD_HIDDEN_NOTICE_MS + 10) })
    expect(screen.queryByText(CLOUD_HIDDEN_NOTICE)).toBeNull()
  })

  it('leaves at once when the switch is turned back on', async () => {
    await clickLink()
    act(() => setFeatures(true))
    expect(screen.queryByText(CLOUD_HIDDEN_NOTICE)).toBeNull()
    expect(useUIStore.getState().cloudHiddenNotice).toBe(false)
  })
})
