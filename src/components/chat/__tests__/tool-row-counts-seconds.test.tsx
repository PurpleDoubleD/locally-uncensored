/**
 * @vitest-environment jsdom
 *
 * CA U1: a call that is still going shows its seconds after 3 s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { ToolCallBlock } from '../ToolCallBlock'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('a running tool row (CA U1)', () => {
  it('stays quiet at first, then counts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const tc = { id: 't', toolName: 'shell_execute', args: { command: 'npm install' }, status: 'running', timestamp: 10_000, startedAt: 10_000 }
    const v = render(<ToolCallBlock toolCall={tc as never} />)
    expect(v.queryByTestId('tool-running-for')).toBeNull()
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(v.getByTestId('tool-running-for').textContent).toBe('5s')
  })
})
