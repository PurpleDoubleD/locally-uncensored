import { describe, expect, it } from 'vitest'
import { diffStat, hasToolTitle, shellExitCode, stripAnsi, toolCallTitle } from '../tool-call-title'

describe('what a tool row says (CA U1)', () => {
  it('reads as a sentence, with the target in monospace', () => {
    expect(toolCallTitle('shell_execute', { command: 'npm test -- math' }, 'completed')).toEqual({ verb: 'Ran', target: 'npm test -- math', mono: true })
    expect(toolCallTitle('file_edit', { path: 'src/math.ts' }, 'running')).toEqual({ verb: 'Editing', target: 'src/math.ts', mono: true })
    expect(toolCallTitle('file_read', { path: 'a.ts' }, 'pending_approval').verb).toBe('Wants to read')
    expect(toolCallTitle('web_search', { query: 'vitest median' }, 'completed')).toEqual({ verb: 'Searched the web for', target: 'vitest median' })
    expect(toolCallTitle('web_fetch', { url: 'https://example.com/docs/a' }, 'completed').target).toBe('example.com/docs/a')
    expect(toolCallTitle('todo_write', { todos: [] }, 'completed')).toEqual({ verb: 'Updated the plan' })
  })

  it('says when the user declined', () => {
    expect(toolCallTitle('shell_execute', { command: 'rm x' }, 'rejected').verb).toBe('Declined: run')
  })

  it('never shows the internal name for an unknown tool, and keeps a server name', () => {
    expect(toolCallTitle('git_status', {}, 'completed').verb).toBe('Git status')
    expect(toolCallTitle('search_issues', {}, 'completed', 'github: search_issues').verb).toBe('github: search_issues')
    expect(toolCallTitle('Step 2 of 6: Upscale', {}, 'running').verb).toBe('Step 2 of 6: Upscale')
  })

  it('cuts a long or multi-line command to one line', () => {
    const t = toolCallTitle('shell_execute', { command: 'python3 -\nprint(1)' }, 'completed').target!
    expect(t).toBe('python3 - …')
    expect(toolCallTitle('shell_execute', { command: 'x'.repeat(200) }, 'completed').target!.length).toBeLessThanOrEqual(90)
  })

  it('counts a diff and reads an exit code', () => {
    expect(diffStat('--- a\n+++ b\n@@ -1 +1,2 @@\n-a\n+b\n+c')).toEqual({ added: 2, removed: 1 })
    expect(diffStat(undefined)).toBeNull()
    expect(shellExitCode('Error (2):\nboom')).toBe(2)
    expect(shellExitCode('ok')).toBeNull()
  })

  it('strips terminal colour codes', () => {
    expect(stripAnsi('\u001b[32m✓\u001b[0m 3 passed')).toBe('✓ 3 passed')
  })

  it('knows which tools need no raw-args block', () => {
    expect(hasToolTitle('shell_execute')).toBe(true)
    expect(hasToolTitle('some_mcp_tool')).toBe(false)
  })
})
