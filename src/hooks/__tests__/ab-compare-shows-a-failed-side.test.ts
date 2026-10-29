/**
 * @vitest-environment jsdom
 *
 * C5 (funde-C.md): in Compare, a side whose request failed (engine 500,
 * model gone, Ollama down) kept an empty answer under "0.0 t/s · 0" with no
 * word of why. `useABCompare` swallowed abort and failure in one bare catch.
 *
 * Now a failure lands on the side's message as `error`, the stats stay null
 * (no fake result), and the column text says why. A stop by the user is
 * still no failure.
 *
 * Run: npx vitest run src/hooks/__tests__/ab-compare-shows-a-failed-side.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../lib/run-lane-of-model', () => ({
  laneOf: () => 'cloud',
  currentLaneFacts: () => ({ openaiSlotIsLocal: false, ollamaBaseIsLocal: false }),
}))

const OK = 'openai::qwen2.5-7b'
const BAD = 'openai::llama-3.2-3b'
const ENGINE_500 = 'HTTP 500: llama-server could not load the model (out of memory)'

vi.mock('../../api/providers', () => ({
  getProviderForModel: (model: string) => ({
    provider: {
      chatStream: (_m: string, _msgs: unknown, opts: { signal?: AbortSignal }) => (async function* () {
        if (model === BAD) throw new Error(ENGINE_500)
        if (model === 'openai::stopped') {
          await new Promise<void>((_res, rej) => opts.signal?.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
          }))
        }
        yield { content: 'hi', done: false }
        yield { content: '', done: true }
      })(),
    },
    modelId: model,
  }),
  getProviderIdFromModel: () => 'openai',
}))

import { useABCompare } from '../useABCompare'
import { useCompareStore } from '../../stores/compareStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { __resetRunLanesForTests } from '../../lib/run-lanes'
import { DEFAULT_SETTINGS } from '../../lib/constants'
import { compareFailureText } from '../../lib/compare-failure'

beforeEach(() => {
  __resetRunLanesForTests()
  useCompareStore.setState({
    isComparing: true, modelA: '', modelB: '',
    messagesA: [], messagesB: [], statsA: null, statsB: null,
    isStreamingA: false, isStreamingB: false,
  })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, contextDecay: false } })
})

describe('Compare: a side that failed says so', () => {
  it('B fails with an engine 500: B carries the error, no 0-stats; A is a normal result', async () => {
    useCompareStore.setState({ modelA: OK, modelB: BAD })
    const { result } = renderHook(() => useABCompare())
    await act(async () => { await result.current.sendCompare('Say hi') })

    const s = useCompareStore.getState()
    const lastA = s.messagesA[s.messagesA.length - 1]
    const lastB = s.messagesB[s.messagesB.length - 1]

    expect(lastA.content).toBe('hi')
    expect(lastA.error).toBeUndefined()
    expect(s.statsA?.tokens).toBe(1)

    expect(s.statsB).toBeNull()
    expect(s.isStreamingB).toBe(false)
    expect(lastB.content).toBe('')
    expect(lastB.error?.kind).toBe('engine')
    expect(lastB.error?.detail).toContain('out of memory')

    const text = compareFailureText(lastB.error!)
    expect(text).toMatch(/did not answer/)
    expect(text).toContain(ENGINE_500)
  })

  it('a stop by the user is no failure: no error on the message', async () => {
    useCompareStore.setState({ modelA: OK, modelB: 'openai::stopped' })
    const { result } = renderHook(() => useABCompare())
    let round: Promise<void> = Promise.resolve()
    await act(async () => {
      round = result.current.sendCompare('Say hi')
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })
    await act(async () => { result.current.stopCompare(); await round })

    const s = useCompareStore.getState()
    expect(s.messagesB[s.messagesB.length - 1].error).toBeUndefined()
  })
})
