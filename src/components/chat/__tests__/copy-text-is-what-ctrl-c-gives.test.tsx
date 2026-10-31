// @vitest-environment jsdom
/**
 * Discord #bug-reports, 30.10.2026: right-click on an answer, "Copy text",
 * paste: "**bold** words", Markdown and all. Ctrl+C on the same answer gives
 * the plain text. "Copy text" now gives what Ctrl+C gives: the selection
 * inside the message, or the text as shown. The Markdown source is one entry
 * further down, "Copy as Markdown", the same as the Copy button.
 *
 * Run: npx vitest run src/components/chat/__tests__/copy-text-is-what-ctrl-c-gives.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import type { Message } from '../../../types/chat'

const SOURCE = 'The **capital** of France is *Paris*.\n\n- one\n- two'
const answer: Message = { id: 'a1', role: 'assistant', content: SOURCE, timestamp: 1, modelId: 'ollama::qwen2.5:0.5b' }

const written: string[] = []
beforeEach(() => {
  written.length = 0
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (t: string) => { written.push(t) }) }, configurable: true })
})
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges() })

function openMenu() {
  const words = screen.getByText('capital')
  fireEvent.contextMenu(words)
  return screen.getByRole('menu')
}

describe('right-click "Copy text" on an answer', () => {
  it('copies the shown text, no Markdown marks', () => {
    render(<MessageBubble message={answer} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))
    expect(written).toHaveLength(1)
    expect(written[0]).not.toContain('**')
    expect(written[0]).not.toContain('*Paris*')
    expect(written[0]).toContain('The capital of France is Paris.')
    expect(written[0]).toContain('one')
  })

  it('copies the selection when words in the message are selected', () => {
    render(<MessageBubble message={answer} />)
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('capital'))
    window.getSelection()!.addRange(range)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }))
    expect(written).toEqual(['capital'])
  })

  it('"Copy as Markdown" keeps the source, like the Copy button', () => {
    render(<MessageBubble message={answer} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy as Markdown' }))
    expect(written).toEqual([SOURCE])
  })
})
