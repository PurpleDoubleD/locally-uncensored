// @vitest-environment jsdom
/**
 * GH #264: the last answer lost Edit for good when it ended without token
 * numbers (Stop, an error, a provider that reports none). "Finished" was read
 * from `message.usage`. It is now read from the run that writes the bubble.
 *
 * Run: npx vitest run src/components/chat/__tests__/edit-after-a-stopped-answer.test.tsx
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import { beginReplyWrite, useReplyWriteStore } from '../../../stores/replyWriteStore'
import type { Message } from '../../../types/chat'

afterEach(() => {
  cleanup()
  useReplyWriteStore.setState({ open: {} })
})

const answer = (over: Partial<Message> = {}): Message => ({
  id: 'a1', role: 'assistant', content: 'A half written answer', timestamp: 1, ...over,
})
const pencil = () => screen.queryByLabelText('Edit response')

describe('Edit on the last answer', () => {
  it('is there after a Stop or an error, without token numbers', () => {
    render(<MessageBubble message={answer()} isLast />)
    expect(pencil()).not.toBeNull()
  })

  it('stays locked while the answer streams', () => {
    render(<MessageBubble message={answer()} isLast isStreaming />)
    expect(pencil()).toBeNull()
  })

  it('stays locked between Stop and the real end of the run', () => {
    // Stop clears the generating flag at once, so isStreaming is already
    // false here, while the run can still write its last text into the bubble.
    const end = beginReplyWrite('a1')
    render(<MessageBubble message={answer()} isLast />)
    expect(pencil()).toBeNull()
    act(() => end())
    expect(pencil()).not.toBeNull()
  })

  it('a stopped run that is still ending locks its answer even when it is no longer last', () => {
    const end = beginReplyWrite('a1')
    render(<MessageBubble message={answer()} />)
    expect(pencil()).toBeNull()
    act(() => end())
    expect(pencil()).not.toBeNull()
  })

  it('keeps the deliberate locks', () => {
    const blocks = [{ id: 'b', phase: 'answer', content: 'from a block', timestamp: 1 }] as unknown as Message['agentBlocks']
    const { unmount } = render(<MessageBubble message={answer({ agentBlocks: blocks })} isLast />)
    expect(pencil()).toBeNull()
    unmount()
    const empty = render(<MessageBubble message={answer({ content: '   ' })} isLast />)
    expect(pencil()).toBeNull()
    empty.unmount()
    render(<MessageBubble message={answer()} isLast readOnly />)
    expect(pencil()).toBeNull()
  })
})

describe('the write mark', () => {
  it('ending twice is harmless and two writers on one id both count', () => {
    const first = beginReplyWrite('a1')
    const second = beginReplyWrite('a1')
    first()
    first()
    expect(useReplyWriteStore.getState().open.a1).toBe(1)
    second()
    expect(useReplyWriteStore.getState().open.a1).toBeUndefined()
  })
})

describe('every path that streams into a bubble holds the mark to its very end', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../../../hooks', f), 'utf8')

  it('plain chat', () => {
    const src = read('useChat.ts')
    const start = src.indexOf('const sendMessage = useCallback')
    const opened = src.indexOf('endReplyWrite = beginReplyWrite(assistantMessage.id)', start)
    const released = src.indexOf('endReplyWrite()', opened)
    expect(opened).toBeGreaterThan(start)
    // After the turn's own finally, in the outermost one.
    expect(released).toBeGreaterThan(src.indexOf('await endTurnDurably', opened))
  })

  it('group round', () => {
    const src = read('useChat.ts')
    expect(src).toMatch(/async function runGroupTurn[\s\S]*?try \{[\s\S]*?writeGroupTurn\([\s\S]*?finally \{\s*endWrite\(\)/)
  })

  it('agent', () => {
    const src = read('useAgentChat.ts')
    const opened = src.indexOf('endReplyWrite = beginReplyWrite(assistantMessage.id)')
    expect(opened).toBeGreaterThan(0)
    expect(src.indexOf('endReplyWrite()', opened)).toBeGreaterThan(src.lastIndexOf('await endTurnDurably(() => {\n        // "true" means'))
  })
})
