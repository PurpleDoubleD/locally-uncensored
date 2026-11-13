/**
 * @vitest-environment jsdom
 *
 * 3.0.4 box run: an opened failed step showed "Error: Path escapes the allowed
 * workspace." twice, once in the result and once more in the error box below.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ToolCallBlock } from '../ToolCallBlock'
import type { AgentToolCall } from '../../../types/agent-mode'

afterEach(() => cleanup())

const open = (toolCall: AgentToolCall) => {
  const view = render(createElement(ToolCallBlock, { toolCall }))
  // CA U1: the row reads as words; the tool's own name is its tooltip.
  fireEvent.click(view.getByTitle(toolCall.toolName))
  return view.container.textContent ?? ''
}
const count = (text: string, needle: string) => text.split(needle).length - 1

describe('a failed step says its error once', () => {
  it('error already in the result: shown once', () => {
    const text = open({
      id: 't1', toolName: 'file_read', args: { path: 'C:\\Users\\Public\\secret-notes.txt' }, status: 'failed', timestamp: 1,
      result: 'Error: Path escapes the allowed workspace.\n  workspace root: C:\\ws\n  requested path: C:\\Users\\Public\\secret-notes.txt',
      error: 'Error: Path escapes the allowed workspace.',
    } as AgentToolCall)
    expect(count(text, 'Path escapes the allowed workspace')).toBe(1)
    expect(text).toContain('requested path')
  })

  it('NEGATIVE CONTROL: an error the result does not carry still shows', () => {
    const text = open({
      id: 't2', toolName: 'file_read', args: { path: 'a.txt' }, status: 'failed', timestamp: 1,
      error: 'File not found: a.txt',
    } as AgentToolCall)
    expect(count(text, 'File not found: a.txt')).toBe(1)
  })
})
