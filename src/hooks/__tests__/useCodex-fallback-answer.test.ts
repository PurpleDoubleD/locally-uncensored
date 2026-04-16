/**
 * Smoke tests for the Codex fallback final answer logic.
 *
 * When the model's last turn returns empty content (all work happened via
 * tool calls), useCodex.ts builds a summary from AgentBlock[] so the
 * assistant message bubble is never blank.
 *
 * We test the identical fallback logic in isolation and add drift detection.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// ── Mirror of the fallback logic from useCodex.ts ───────────────────────
interface MockBlock {
  phase: string
  toolCall?: { toolName: string; status: string }
}

function buildFallbackAnswer(blocks: MockBlock[]): string {
  const completed = blocks.filter(b => b.phase === 'tool_call' && b.toolCall?.status === 'completed')
  const failed = blocks.filter(b => b.phase === 'tool_call' && b.toolCall?.status === 'failed')
  const writes = completed.filter(b => b.toolCall?.toolName === 'file_write')
  const reads = completed.filter(b => b.toolCall?.toolName === 'file_read')

  const parts: string[] = []
  if (writes.length) parts.push(`${writes.length} file(s) written`)
  if (reads.length) parts.push(`${reads.length} file(s) read`)
  const otherCompleted = completed.length - writes.length - reads.length
  if (otherCompleted > 0) parts.push(`${otherCompleted} other operation(s) completed`)
  if (failed.length) parts.push(`${failed.length} operation(s) failed`)

  return parts.length > 0 ? `Task completed: ${parts.join(', ')}.` : 'Task completed.'
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Codex fallback final answer', () => {
  it('produces summary for file_write operations', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
    ]
    expect(buildFallbackAnswer(blocks)).toBe('Task completed: 3 file(s) written.')
  })

  it('produces summary for file_read operations', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } },
    ]
    expect(buildFallbackAnswer(blocks)).toBe('Task completed: 2 file(s) read.')
  })

  it('produces summary for mixed operations', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_list', status: 'completed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer).toContain('2 file(s) written')
    expect(answer).toContain('1 file(s) read')
    expect(answer).toContain('2 other operation(s) completed')
  })

  it('reports failed operations', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'failed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer).toContain('1 file(s) written')
    expect(answer).toContain('2 operation(s) failed')
  })

  it('returns generic message when no blocks exist', () => {
    expect(buildFallbackAnswer([])).toBe('Task completed.')
  })

  it('ignores non-tool_call phases', () => {
    const blocks: MockBlock[] = [
      { phase: 'thinking', toolCall: undefined },
      { phase: 'streaming', toolCall: undefined },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
    ]
    expect(buildFallbackAnswer(blocks)).toBe('Task completed: 1 file(s) written.')
  })

  it('ignores running operations (not yet completed or failed)', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'running' } },
    ]
    // 'running' is neither 'completed' nor 'failed', so it's not counted
    expect(buildFallbackAnswer(blocks)).toBe('Task completed: 1 file(s) written.')
  })

  it('handles all-failed scenario', () => {
    const blocks: MockBlock[] = [
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
    ]
    expect(buildFallbackAnswer(blocks)).toBe('Task completed: 2 operation(s) failed.')
  })

  it('handles large batch with diverse tools', () => {
    const blocks: MockBlock[] = [
      ...Array(5).fill(null).map(() => ({ phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'completed' } })),
      ...Array(3).fill(null).map(() => ({ phase: 'tool_call', toolCall: { toolName: 'file_read', status: 'completed' } })),
      ...Array(2).fill(null).map(() => ({ phase: 'tool_call', toolCall: { toolName: 'shell_execute', status: 'completed' } })),
      { phase: 'tool_call', toolCall: { toolName: 'file_search', status: 'completed' } },
      { phase: 'tool_call', toolCall: { toolName: 'file_write', status: 'failed' } },
    ]
    const answer = buildFallbackAnswer(blocks)
    expect(answer).toContain('5 file(s) written')
    expect(answer).toContain('3 file(s) read')
    expect(answer).toContain('3 other operation(s) completed')
    expect(answer).toContain('1 operation(s) failed')
  })
})

// ── Drift detection ─────────────────────────────────────────────────────
describe('fallback answer drift detection', () => {
  it('useCodex.ts contains the fallback summary builder', () => {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const src = readFileSync(join(__dirname, '../useCodex.ts'), 'utf8')

    // Must contain the fallback trigger
    expect(src).toContain("if (!fullContent.trim())")
    // Must build parts array with file write/read counts
    expect(src).toContain("file(s) written")
    expect(src).toContain("file(s) read")
    expect(src).toContain("Task completed:")
  })
})
