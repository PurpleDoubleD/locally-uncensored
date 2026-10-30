// @vitest-environment jsdom
/**
 * B26 (3.0.9): Discord 28.10.2026, a 27B IQ2_M on an 8 GB RTX 4060 sat on
 * "Reading the conversation" without a word. The line now says why: still
 * loading, or partly on the CPU, with a smaller model that fits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { firstWaitActivity, smallerModelThatFits, watchFirstWait } from '../first-wait-vram'
import { readingActivity, useRunActivityStore, type RunActivity } from '../../stores/runActivityStore'
import { WorkingAnchor } from '../../components/chat/WorkingAnchor'

const GB = 1_073_741_824
const reading = readingActivity(5600)
// Measured shape of the report: Ollama put 6.9 of 11.2 GB on the 8 GB card.
const bigOnCpu = { name: 'qwen3.8-27b:iq2_m', size: 11.2 * GB, sizeVram: 6.9 * GB, contextLength: 8192 }
const installed = [
  { name: 'qwen3.8-27b:iq2_m', size: 9.8 * GB },
  { name: 'gemma4:e4b', size: 5.1 * GB },
  { name: 'qwen3.5:4b', size: 3.4 * GB },
  { name: 'mistral-small:24b', size: 14 * GB },
]

describe('what the first wait says', () => {
  it('a model not yet in /api/ps is still loading', () => {
    expect(firstWaitActivity({ reading, model: 'qwen3.8-27b:iq2_m', loaded: [], installed }))
      .toEqual({ label: 'Loading the model', kind: 'reading', detail: 'qwen3.8-27b:iq2_m' })
  })

  it('a model partly on the CPU gets the share, the sizes and a smaller installed model that fits', () => {
    const out = firstWaitActivity({ reading, model: 'qwen3.8-27b:iq2_m', loaded: [bigOnCpu], installed })
    expect(out).toMatchObject({ label: 'Reading the conversation', kind: 'reading', detail: '5.6k tokens' })
    expect(out?.hint).toContain('Only 6.9 GB of qwen3.8-27b:iq2_m\'s 11 GB fit on your graphics card')
    expect(out?.hint).toContain('38% runs on the CPU')
    expect(out?.hint).toContain('gemma4:e4b (5.1 GB)')
  })

  it('with nothing smaller installed, it names the size that would fit', () => {
    const out = firstWaitActivity({ reading, model: 'qwen3.8-27b:iq2_m', loaded: [bigOnCpu], installed: installed.slice(0, 1) })
    expect(out?.hint).toContain('A model under 5.9 GB fits on your card')
  })

  it('all of it on the CPU says so', () => {
    const out = firstWaitActivity({ reading, model: 'big', loaded: [{ name: 'big', size: 20 * GB, sizeVram: 0, contextLength: 0 }], installed })
    expect(out?.hint).toContain('runs entirely on the CPU (20 GB)')
  })

  it('a model that fits, or an unreadable /api/ps, adds nothing', () => {
    expect(firstWaitActivity({ reading, model: 'gemma4:e4b', loaded: [{ name: 'gemma4:e4b', size: 6 * GB, sizeVram: 6 * GB, contextLength: 0 }], installed })).toBeNull()
    expect(firstWaitActivity({ reading, model: 'gemma4:e4b', loaded: null, installed })).toBeNull()
  })

  it('":latest" names the same model', () => {
    expect(firstWaitActivity({ reading, model: 'llama3', loaded: [{ name: 'llama3:latest', size: 5 * GB, sizeVram: 5 * GB, contextLength: 0 }], installed })).toBeNull()
    expect(smallerModelThatFits([{ name: 'llama3:latest', size: 1 }], 'llama3', 10 * GB)).toBeNull()
  })
})

describe('the watch', () => {
  beforeEach(() => { vi.useFakeTimers(); useRunActivityStore.setState({ activity: {} }) })
  afterEach(() => { vi.useRealTimers() })

  const store = {
    get: () => useRunActivityStore.getState().activity.c1,
    set: (a: RunActivity) => useRunActivityStore.getState().setActivity('c1', a),
  }

  it('looks after the first wait, says loading, then the CPU share, and stops at the first word', async () => {
    useRunActivityStore.getState().setActivity('c1', reading)
    const answers = [[], [bigOnCpu]]
    const readLoaded = vi.fn(async () => answers.shift() ?? [bigOnCpu])
    watchFirstWait({ conversationId: 'c1', model: 'qwen3.8-27b:iq2_m', readLoaded, readInstalled: async () => installed, getActivity: store.get, setActivity: store.set, firstLookMs: 10_000, everyMs: 5_000 })

    await vi.advanceTimersByTimeAsync(9_000)
    expect(readLoaded).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.get()).toMatchObject({ label: 'Loading the model' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.get()).toMatchObject({ label: 'Reading the conversation', detail: '5.6k tokens' })
    expect(store.get()?.hint).toContain('fit on your graphics card')
    // Sizes from Ollama's own list: the model store has none (Mac run 30.10.).
    expect(store.get()?.hint).toContain('for example gemma4:e4b (5.1 GB)')

    // The first word takes the line back (endFirstWait): the watch stops.
    useRunActivityStore.getState().setActivity('c1', null)
    const calls = readLoaded.mock.calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(readLoaded.mock.calls.length).toBe(calls)
    expect(store.get()).toBeUndefined()
  })

  it('keeps the sentence through hidden thinking, which is just as slow on the CPU (Mac run 30.10.)', async () => {
    useRunActivityStore.getState().setActivity('c1', reading)
    const readLoaded = vi.fn(async () => [bigOnCpu])
    watchFirstWait({ conversationId: 'c1', model: 'qwen3.8-27b:iq2_m', readLoaded, readInstalled: async () => installed, getActivity: store.get, setActivity: store.set, firstLookMs: 10_000, everyMs: 5_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.get()?.hint).toContain('fit on your graphics card')
    // hiddenThoughtArrived: the run says "Thinking", without the sentence.
    useRunActivityStore.getState().setActivity('c1', { label: 'Thinking', kind: 'thinking' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.get()).toMatchObject({ label: 'Thinking', kind: 'thinking' })
    expect(store.get()?.hint).toContain('fit on your graphics card')
  })

  it('Stop ends it before the first look', async () => {
    useRunActivityStore.getState().setActivity('c1', reading)
    const abort = new AbortController()
    const readLoaded = vi.fn(async () => [bigOnCpu])
    watchFirstWait({ conversationId: 'c1', model: 'm', signal: abort.signal, readLoaded, readInstalled: async () => [], getActivity: store.get, setActivity: store.set })
    abort.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readLoaded).not.toHaveBeenCalled()
  })
})

describe('the status line shows the sentence', () => {
  it('under "Reading the conversation" while that is the line', () => {
    useRunActivityStore.setState({ activity: { c9: { ...reading, hint: 'Only 6.9 GB of x fit on your graphics card.' } } })
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c9', message: { content: '', agentBlocks: [] } }))
    expect(screen.getByTestId('working-anchor-hint').textContent).toContain('fit on your graphics card')
  })

  it('under the chat\'s own "Loading model" too, which a local model keeps until its first token', () => {
    useRunActivityStore.setState({ activity: { c9: { ...reading, hint: 'Only 6.9 GB of x fit on your graphics card.' } } })
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c9', loadingModel: true, message: { content: '', agentBlocks: [] } }))
    expect(screen.getByTestId('working-anchor').textContent).toContain('Loading model')
    expect(screen.getByTestId('working-anchor-hint').textContent).toContain('fit on your graphics card')
  })

  it('not once the model answers', () => {
    useRunActivityStore.setState({ activity: { c9: { ...reading, hint: 'Only 6.9 GB of x fit on your graphics card.' } } })
    render(createElement(WorkingAnchor, { isRunning: true, conversationId: 'c9', message: { content: 'Hallo' } }))
    expect(screen.queryByTestId('working-anchor-hint')).toBeNull()
  })
})
