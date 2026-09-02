/**
 * @vitest-environment jsdom
 *
 * The rule in lib/docs-availability.ts is only worth anything if the composer
 * feeds it a real measurement. This file checks the wiring, which is the part a
 * pure-function test cannot see:
 *
 *   local  -> no probe at all, and the button is on
 *   cloud  -> exactly one probe, and its answer decides
 *
 * The probe itself (api/embed-availability.ts) is stubbed here on purpose. What
 * it asks the sidecar is covered by api/__tests__/embed-lane-readiness.test.ts;
 * what the composer does with the answer is covered here.
 *
 * Run: npx vitest run src/hooks/__tests__/docs-availability-asks-the-embed-lane.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { useDocsAvailability } from '../useDocsAvailability'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { DOCS_TITLE_NO_EMBEDDINGS } from '../../lib/docs-availability'

const probe = vi.fn<() => Promise<boolean>>()
vi.mock('../../api/embed-availability', () => ({
  embeddingBackendReady: () => probe(),
  builtinEmbedReady: async () => false,
}))

function Probe() {
  const a = useDocsAvailability()
  return createElement('div', {
    'data-testid': 'state',
    'data-enabled': String(a.enabled),
    'data-visible': String(a.visible),
    title: a.title,
  })
}

const state = () => screen.getByTestId('state')

beforeEach(() => {
  probe.mockReset()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'local' } })
})
afterEach(() => cleanup())

describe('the composer asks the embedding lane, not the app mode', () => {
  it('local mode never probes and never turns the button off', async () => {
    probe.mockResolvedValue(false)
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-visible')).toBe('true'))
    expect(state().getAttribute('data-enabled')).toBe('true')
    // Negative control: a probe that would say no was never even asked.
    expect(probe).not.toHaveBeenCalled()
  })

  it('cloud mode with an embedding lane keeps the button on', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud' } })
    probe.mockResolvedValue(true)
    render(createElement(Probe))
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(state().getAttribute('data-enabled')).toBe('true'))
    expect(state().getAttribute('title')).toContain('stay here')
  })

  it('cloud mode without one shows it and says what is missing', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud' } })
    probe.mockResolvedValue(false)
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-enabled')).toBe('false'))
    expect(state().getAttribute('data-visible')).toBe('true')
    expect(state().getAttribute('title')).toBe(DOCS_TITLE_NO_EMBEDDINGS)
  })

  it('a probe that throws is reported as missing, not as working', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud' } })
    probe.mockRejectedValue(new Error('tauri bridge missing'))
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-enabled')).toBe('false'))
    expect(state().getAttribute('title')).toBe(DOCS_TITLE_NO_EMBEDDINGS)
  })
})
