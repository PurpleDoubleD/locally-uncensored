/**
 * @vitest-environment jsdom
 *
 * Watchers above the composer (David's Ok to sketch v2, 14.11.2026): the line
 * stands on the right, a click opens the list, and Pause, Resume and Delete
 * are icons with a tooltip and a name for a screen reader.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const calls: Array<[string, unknown]> = []
vi.mock('../../../api/backend', () => ({
  backendCall: vi.fn(async (cmd: string, args: unknown) => { calls.push([cmd, args]); return null }),
  isTauri: () => true,
}))

import { WatcherStrip } from '../WatcherStrip'
import { useWatcherStore } from '../../../stores/watcherStore'
import { NO_RIGHTS, type Watcher } from '../../../lib/watchers/types'

const at18 = (() => { const d = new Date(); d.setHours(23, 59, 0, 0); return d.getTime() })()
const w = (over: Partial<Watcher> = {}): Watcher => ({
  id: 'w1', name: 'Prices', task: 'Check.', schedule: { kind: 'daily', hour: 23, minute: 59, days: [] }, rights: NO_RIGHTS,
  folder: null, model: null, paused: false, created_at: 0, next_at: at18, running_since: null, conversation_id: null,
  origin_conversation_id: null, runs: [], ...over,
})

afterEach(() => { cleanup(); calls.length = 0; useWatcherStore.setState({ watchers: [], hints: [] }) })

describe('the watcher line above the composer', () => {
  it('shows nothing without watchers', () => {
    const { container } = render(createElement(WatcherStrip))
    expect(container.innerHTML).toBe('')
  })

  it('stands on the right and opens a list with icon actions', () => {
    useWatcherStore.setState({ watchers: [w(), w({ id: 'w2', name: 'News', paused: true })], hints: [] })
    render(createElement(WatcherStrip))
    const toggle = screen.getByTitle('Show the watchers')
    expect(toggle.parentElement?.className).toContain('justify-end')
    fireEvent.click(toggle)
    const pause = screen.getByLabelText('Pause Prices')
    expect(pause.getAttribute('title')).toBe('Pause')
    expect(pause.textContent).toBe('')
    expect(screen.getByLabelText('Resume News').getAttribute('title')).toBe('Resume')
    fireEvent.click(pause)
    expect(calls).toContainEqual(['watchers_update', { id: 'w1', patch: { paused: true } }])
  })

  it('deletes only on the second click', () => {
    useWatcherStore.setState({ watchers: [w()], hints: [] })
    render(createElement(WatcherStrip))
    fireEvent.click(screen.getByTitle('Show the watchers'))
    fireEvent.click(screen.getByLabelText('Delete Prices'))
    expect(calls).toEqual([])
    fireEvent.click(screen.getByLabelText('Click again to delete Prices'))
    expect(calls).toContainEqual(['watchers_delete', { id: 'w1' }])
  })
})
