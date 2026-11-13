/**
 * T1: the text rules of the terminal tool's result (agents/shell-result.ts).
 *
 * Run: npx vitest run src/api/agents/__tests__/shell-result.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  cutShellOutput,
  joinShellStreams,
  renderHandedOver,
  SHELL_HEAD_CHARS,
  SHELL_TAIL_CHARS,
} from '../shell-result'
import { truncateToolResult } from '../../../lib/truncate-tool-result'
import { resultCharsFor } from '../../../lib/agent-profile'

describe('cutShellOutput', () => {
  it('leaves an output up to head plus tail alone', () => {
    const text = 'a'.repeat(SHELL_HEAD_CHARS + SHELL_TAIL_CHARS)
    expect(cutShellOutput(text, 'id')).toBe(text)
  })

  it('keeps exactly the head and the tail and says what is missing', () => {
    const head = 'H'.repeat(SHELL_HEAD_CHARS)
    const middle = 'm\n'.repeat(500)
    const tail = 'T'.repeat(SHELL_TAIL_CHARS)
    const out = cutShellOutput(head + middle + tail)
    expect(out.startsWith(head)).toBe(true)
    expect(out.endsWith(tail)).toBe(true)
    expect(out).toContain(`[… ${middle.length} characters (500 lines) cut …]`)
    expect(out).not.toContain('task_id')
  })

  it('names where the full output is when there is an id', () => {
    const out = cutShellOutput('x'.repeat(20000), 'abc')
    expect(out).toContain('Full output: shell_execute with task "status" and task_id "abc".')
  })

  it('the compact profile cap still applies on top and keeps the end', () => {
    const text = `${'a'.repeat(30000)}END`
    const cut = cutShellOutput(text, 'abc')
    // The profile caps in the run loop; the tool result fits under the
    // compact cap, so the cap leaves it whole.
    expect(truncateToolResult(cut, resultCharsFor('compact'))).toBe(cut)
    // The tiny profile cuts further, and the end still survives.
    expect(truncateToolResult(cut, resultCharsFor('tiny')).endsWith('END')).toBe(true)
  })
})

describe('joinShellStreams', () => {
  it('marks stderr only when both streams have something', () => {
    expect(joinShellStreams('out\n', '')).toBe('out')
    expect(joinShellStreams('', 'err\n')).toBe('[stderr]\nerr')
    expect(joinShellStreams('out', 'err')).toBe('out\n[stderr]\nerr')
  })
})

describe('renderHandedOver', () => {
  it('says the command still runs, under which id, and how to read and stop it', () => {
    const out = renderHandedOver({ taskId: 't-1', timeoutMs: 120000, stdout: 'step 1\n', stderr: 'warn\n' })
    expect(out).toContain('Still running after 120 s, so it was not stopped')
    expect(out).toContain('in the background as task t-1.')
    expect(out).toContain('Output so far:\nstep 1\n[stderr]\nwarn')
    expect(out).toContain('Use check_tasks to read its output, or shell_execute with task "kill" and task_id "t-1" to stop it.')
  })

  it('a command that printed nothing yet says so', () => {
    expect(renderHandedOver({ taskId: 't-2', stdout: '', stderr: '' })).toContain('(no output so far)')
  })

  it('cuts a long output so far to head and tail', () => {
    const out = renderHandedOver({ taskId: 't-3', stdout: `${'z'.repeat(20000)}LAST`, stderr: '' })
    expect(out).toContain('LAST')
    expect(out).toContain('characters (')
    expect(out.length).toBeLessThan(SHELL_HEAD_CHARS + SHELL_TAIL_CHARS + 500)
  })
})
