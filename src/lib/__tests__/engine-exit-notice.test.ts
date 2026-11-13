/**
 * C81 (3.1.0): an engine that dies on its own is named, with its cause, above
 * the chat. Negative control: return null from engineStoppedMessage and the
 * first case turns red.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { engineStoppedMessage, noteSidecarGone, ENGINE_STOPPED_NOTICE_MS } from '../engine-exit-notice'
import { useChatNoticeStore } from '../../stores/chatNoticeStore'

const SENTENCE = 'The LU Engine stopped unexpectedly (signal 6 (SIGABRT, …)). The graphics card ran out of memory.'

beforeEach(() => useChatNoticeStore.getState().clear())

describe('C81: the engine death reaches the chat', () => {
  it('shows the sentence Rust sent for the chat engine', () => {
    noteSidecarGone({ sidecar: 'engine', port: 8127, signal: 6, message: SENTENCE })
    const n = useChatNoticeStore.getState().notices
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ id: 'engine-stopped', text: SENTENCE, ton: 'fehler' })
    expect(ENGINE_STOPPED_NOTICE_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('says nothing for the embeddings server, an old payload or garbage', () => {
    noteSidecarGone({ sidecar: 'embed', port: 8128, message: null })
    noteSidecarGone({ sidecar: 'engine', port: 8127 })
    noteSidecarGone(null)
    noteSidecarGone('engine')
    expect(useChatNoticeStore.getState().notices).toHaveLength(0)
    expect(engineStoppedMessage({ sidecar: 'engine', message: '   ' })).toBeNull()
  })

  it('a second death replaces the line instead of stacking', () => {
    noteSidecarGone({ sidecar: 'engine', message: 'first' })
    noteSidecarGone({ sidecar: 'engine', message: 'second' })
    const n = useChatNoticeStore.getState().notices
    expect(n.map((x) => x.text)).toEqual(['second'])
  })
})
