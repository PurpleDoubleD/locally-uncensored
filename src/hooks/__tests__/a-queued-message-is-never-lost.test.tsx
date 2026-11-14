/**
 * @vitest-environment jsdom
 *
 * CA (13.11.2026), support case "the app answers once, then never again": a
 * line queued while a run went was sent only if THIS view saw the run end.
 * Switch chats or tabs in between and it stayed in the queue for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useSteerQueue } from '../useSteerQueue'
import { useSteerStore } from '../../stores/steerStore'

beforeEach(() => useSteerStore.setState({ queue: {} } as never))
afterEach(() => cleanup())

describe('useSteerQueue', () => {
  it('holds the line while the run goes, sends it when it ends', () => {
    const send = vi.fn()
    const h = renderHook(({ running }) => useSteerQueue('c1', running, true, send), { initialProps: { running: true } })
    h.result.current.steer!('also add a test')
    h.rerender({ running: true })
    expect(send).not.toHaveBeenCalled()
    h.rerender({ running: false })
    expect(send).toHaveBeenCalledWith('also add a test')
    expect(useSteerStore.getState().queue.c1).toEqual([])
  })

  it('a view that mounts on an idle chat with a leftover line sends it', () => {
    useSteerStore.getState().add('c2', 'left behind while I was in another tab')
    const send = vi.fn()
    renderHook(() => useSteerQueue('c2', false, true, send))
    expect(send).toHaveBeenCalledWith('left behind while I was in another tab')
  })

  it('switching back to a chat whose run ended elsewhere sends its line', () => {
    useSteerStore.getState().add('c3', 'queued in c3')
    const send = vi.fn()
    const h = renderHook(({ conv }) => useSteerQueue(conv, false, true, send), { initialProps: { conv: 'other' } })
    expect(send).not.toHaveBeenCalled()
    h.rerender({ conv: 'c3' })
    expect(send).toHaveBeenCalledWith('queued in c3')
  })

  it('sends each line once', () => {
    useSteerStore.getState().add('c4', 'once')
    const send = vi.fn()
    const h = renderHook(() => useSteerQueue('c4', false, true, send))
    h.rerender()
    h.rerender()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
