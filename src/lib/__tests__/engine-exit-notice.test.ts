/**
 * C81 (3.1.0): an engine that dies on its own is named, with its cause, on the
 * LU Engine line. Negative control: return null from engineStoppedMessage and
 * the first case turns red.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { engineStoppedMessage, noteSidecarGone } from '../engine-exit-notice'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'

const SENTENCE = 'The LU Engine stopped unexpectedly (signal 6, SIGABRT). The graphics card ran out of memory.'

beforeEach(() => useLuEngineSwitchStore.getState().dismiss())

describe('C81: the engine death reaches the engine line', () => {
  it('announces the sentence Rust sent for the chat engine, as an error', () => {
    noteSidecarGone({ sidecar: 'engine', port: 8127, signal: 6, message: SENTENCE })
    const s = useLuEngineSwitchStore.getState()
    expect(s.note).toBe(SENTENCE)
    expect(s.tone).toBe('error')
  })

  it('says nothing for the embeddings server, an old payload or garbage', () => {
    noteSidecarGone({ sidecar: 'embed', port: 8128, message: null })
    noteSidecarGone({ sidecar: 'engine', port: 8127 })
    noteSidecarGone(null)
    noteSidecarGone('engine')
    expect(useLuEngineSwitchStore.getState().note).toBeNull()
    expect(engineStoppedMessage({ sidecar: 'engine', message: '   ' })).toBeNull()
  })
})
