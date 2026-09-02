/**
 * @vitest-environment jsdom
 *
 * The rule in lib/docs-availability.ts is only worth anything if the composer
 * feeds it a real measurement. This file checks the wiring, which is the part a
 * pure-function test cannot see:
 *
 *   local  -> no probe at all, and the button is plain
 *   cloud  -> one probe for ALL consumers, and its answer decides
 *   cloud  -> a cold start that measured too early recovers by itself (S1)
 *
 * The probe itself (api/embed-availability.ts) is stubbed here on purpose. What
 * it asks the sidecar is covered by api/__tests__/embed-lane-readiness.test.ts
 * and api/__tests__/embed-lane-names-the-host.test.ts; what the composer does
 * with the answer is covered here.
 *
 * Run: npx vitest run src/hooks/__tests__/docs-availability-asks-the-embed-lane.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { useDocsAvailability } from '../useDocsAvailability'
import { __resetEmbedLaneForTests, EMBED_LANE_RETRY_MS } from '../useEmbedLane'
import { useSettingsStore } from '../../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { DOCS_TITLE_NO_EMBEDDINGS, DOCS_TITLE_CLOUD_LOCAL } from '../../lib/docs-availability'
import type { EmbedLaneInfo } from '../../api/embed-availability'

const probe = vi.fn<() => Promise<EmbedLaneInfo>>()
vi.mock('../../api/embed-availability', async (orig) => ({
  ...(await orig<typeof import('../../api/embed-availability')>()),
  embeddingLane: () => probe(),
}))

function Probe({ tag = 'state' }: { tag?: string }) {
  const a = useDocsAvailability()
  return createElement('div', {
    'data-testid': tag,
    'data-needs-setup': String(a.needsSetup),
    'data-enabled': String(a.enabled),
    'data-visible': String(a.visible),
    'data-lane': String(a.lane),
    title: a.title,
  })
}

const state = (tag = 'state') => screen.getByTestId(tag)

beforeEach(() => {
  probe.mockReset()
  __resetEmbedLaneForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'local' } })
})
afterEach(() => {
  cleanup()
  __resetEmbedLaneForTests()
  vi.useRealTimers()
})

const cloud = () =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, appMode: 'cloud' } })

describe('the composer asks the embedding lane, not the app mode', () => {
  it('local mode never probes and never damps the button', async () => {
    probe.mockResolvedValue({ lane: 'none', endpoint: null })
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-visible')).toBe('true'))
    expect(state().getAttribute('data-needs-setup')).toBe('false')
    // Negative control: a probe that would say no was never even asked.
    expect(probe).not.toHaveBeenCalled()
  })

  it('cloud mode with a bundled lane keeps the button plain and pressable', async () => {
    cloud()
    probe.mockResolvedValue({ lane: 'bundled', endpoint: null })
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-lane')).toBe('bundled'))
    expect(state().getAttribute('data-needs-setup')).toBe('false')
    expect(state().getAttribute('title')).toBe(DOCS_TITLE_CLOUD_LOCAL)
  })

  it('cloud mode without a lane damps it, says what is missing, and stays pressable', async () => {
    cloud()
    probe.mockResolvedValue({ lane: 'none', endpoint: null })
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-needs-setup')).toBe('true'))
    expect(state().getAttribute('data-enabled')).toBe('true')
    expect(state().getAttribute('title')).toBe(DOCS_TITLE_NO_EMBEDDINGS)
  })

  it('cloud mode on a remote Ollama names the host in the tooltip', async () => {
    cloud()
    probe.mockResolvedValue({ lane: 'ollama-remote', endpoint: 'http://192.168.0.54:11434' })
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-lane')).toBe('ollama-remote'))
    expect(state().getAttribute('title')).toContain('192.168.0.54')
  })

  it('a probe that throws is reported as missing, not as working', async () => {
    cloud()
    probe.mockRejectedValue(new Error('tauri bridge missing'))
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-needs-setup')).toBe('true'))
  })

  it('two mounted consumers share ONE measurement', async () => {
    cloud()
    probe.mockResolvedValue({ lane: 'bundled', endpoint: null })
    render(createElement('div', null, createElement(Probe, { tag: 'a' }), createElement(Probe, { tag: 'b' })))
    await waitFor(() => expect(state('a').getAttribute('data-lane')).toBe('bundled'))
    expect(state('b').getAttribute('data-lane')).toBe('bundled')
    // The composer and the RAG panel both ask; the sidecar is asked once.
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('a cold start does not strand the button (S1)', () => {
  it('re-measures when the embed install announces itself', async () => {
    cloud()
    probe.mockResolvedValueOnce({ lane: 'none', endpoint: null })
    render(createElement(Probe))
    await waitFor(() => expect(state().getAttribute('data-needs-setup')).toBe('true'))

    probe.mockResolvedValue({ lane: 'bundled', endpoint: null })
    // Exactly the event api/embed-install.ts fires when the GGUF has landed
    // and the server is up.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('lu-models-refresh'))
    })
    await waitFor(() => expect(state().getAttribute('data-lane')).toBe('bundled'))
    expect(state().getAttribute('data-needs-setup')).toBe('false')
  })

  it('asks again by itself a few seconds after a no, because resumeEmbedServer is async', async () => {
    vi.useFakeTimers()
    cloud()
    probe.mockResolvedValueOnce({ lane: 'none', endpoint: null })
    render(createElement(Probe))
    await vi.waitFor(() => expect(state().getAttribute('data-needs-setup')).toBe('true'))

    probe.mockResolvedValue({ lane: 'bundled', endpoint: null })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EMBED_LANE_RETRY_MS + 50)
    })
    await vi.waitFor(() => expect(state().getAttribute('data-lane')).toBe('bundled'))
  })

  it('does not keep re-asking once the answer is good', async () => {
    // Negative control on the retry: it exists for the boot race, not as a poll.
    vi.useFakeTimers()
    cloud()
    probe.mockResolvedValue({ lane: 'bundled', endpoint: null })
    render(createElement(Probe))
    await vi.waitFor(() => expect(state().getAttribute('data-lane')).toBe('bundled'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EMBED_LANE_RETRY_MS * 4)
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
