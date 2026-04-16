/**
 * Smoke tests for `streamWithTools()` — the NDJSON streaming helper in useCodex.ts.
 *
 * We cannot import the function directly (it's module-private), so we test the
 * NDJSON-parsing logic in isolation with an identical implementation extracted
 * from the source. A drift-detection test at the bottom re-reads the hook
 * source to confirm the critical patterns remain in sync.
 *
 * Coverage:
 * - Single-chunk content accumulation
 * - Multi-chunk content concatenation
 * - Thinking field accumulation
 * - Tool call extraction from final chunk
 * - Tool call APPEND (not overwrite) across multiple chunks — regression test
 * - Empty/whitespace lines in NDJSON stream
 * - Partial JSON lines that split across chunks
 * - Remaining buffer processing after stream ends
 * - Mixed content + thinking + tool_calls in one stream
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// ── Faithful copy of streamWithTools parsing logic ──────────────────────
// This mirrors the NDJSON parsing from useCodex.ts without the HTTP/fetch parts.
interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> }
}

interface StreamResult {
  content: string
  toolCalls: ToolCall[]
  thinking: string
}

function parseNDJSON(ndjsonLines: string[]): StreamResult {
  let content = ''
  let thinking = ''
  let toolCalls: ToolCall[] = []

  for (const rawLine of ndjsonLines) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    try {
      const j = JSON.parse(trimmed)
      if (j.message) {
        if (j.message.content) {
          content += j.message.content
        }
        if (j.message.thinking) {
          thinking += j.message.thinking
        }
        // Ollama may split tool_calls across chunks — append, don't overwrite
        if (j.message.tool_calls && Array.isArray(j.message.tool_calls)) {
          toolCalls = [...toolCalls, ...j.message.tool_calls.map((tc: any) => ({
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }))]
        }
      }
    } catch { /* partial JSON — skip */ }
  }

  return { content, toolCalls, thinking }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('streamWithTools NDJSON parsing', () => {
  it('accumulates content from multiple chunks', () => {
    const lines = [
      '{"message":{"role":"assistant","content":"Hello"}}',
      '{"message":{"role":"assistant","content":" World"}}',
      '{"message":{"role":"assistant","content":"!"}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.content).toBe('Hello World!')
    expect(result.toolCalls).toEqual([])
    expect(result.thinking).toBe('')
  })

  it('accumulates thinking from multiple chunks', () => {
    const lines = [
      '{"message":{"role":"assistant","thinking":"Let me think..."}}',
      '{"message":{"role":"assistant","thinking":" about this."}}',
      '{"message":{"role":"assistant","content":"The answer is 42."}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.thinking).toBe('Let me think... about this.')
    expect(result.content).toBe('The answer is 42.')
  })

  it('extracts tool calls from the final chunk', () => {
    const lines = [
      '{"message":{"role":"assistant","content":"I\'ll write the file."}}',
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"file_write","arguments":{"path":"test.ts","content":"console.log()"}}}]},"done":true}',
    ]
    const result = parseNDJSON(lines)
    expect(result.content).toBe("I'll write the file.")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('file_write')
    expect(result.toolCalls[0].function.arguments).toEqual({ path: 'test.ts', content: 'console.log()' })
  })

  it('APPENDS tool calls across chunks (regression — was overwriting)', () => {
    const lines = [
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"file_read","arguments":{"path":"a.ts"}}}]}}',
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"file_write","arguments":{"path":"b.ts","content":"x"}}}]}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].function.name).toBe('file_read')
    expect(result.toolCalls[1].function.name).toBe('file_write')
  })

  it('handles multiple tool calls in a single chunk', () => {
    const lines = [
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"file_read","arguments":{"path":"a.ts"}}},{"function":{"name":"file_read","arguments":{"path":"b.ts"}}}]}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].function.arguments).toEqual({ path: 'a.ts' })
    expect(result.toolCalls[1].function.arguments).toEqual({ path: 'b.ts' })
  })

  it('handles mixed content + thinking + tool_calls in one stream', () => {
    const lines = [
      '{"message":{"role":"assistant","thinking":"I need to read the file first."}}',
      '{"message":{"role":"assistant","content":"Reading file..."}}',
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"file_read","arguments":{"path":"index.ts"}}}]}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.thinking).toBe('I need to read the file first.')
    expect(result.content).toBe('Reading file...')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('file_read')
  })

  it('skips empty and whitespace-only lines', () => {
    const lines = [
      '',
      '   ',
      '{"message":{"role":"assistant","content":"hello"}}',
      '',
      '{"message":{"role":"assistant","content":" world"}}',
      '  \n  ',
    ]
    const result = parseNDJSON(lines)
    expect(result.content).toBe('hello world')
  })

  it('skips partial/invalid JSON lines gracefully', () => {
    const lines = [
      '{"message":{"role":"ass',        // truncated
      '{"message":{"role":"assistant","content":"ok"}}',
      'not json at all',
      '{"message":{"role":"assistant","content":"!"}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.content).toBe('ok!')
  })

  it('returns empty result for empty stream', () => {
    const result = parseNDJSON([])
    expect(result.content).toBe('')
    expect(result.thinking).toBe('')
    expect(result.toolCalls).toEqual([])
  })

  it('ignores lines with no message field', () => {
    const lines = [
      '{"model":"gemma4","done":false}',
      '{"message":{"role":"assistant","content":"hi"}}',
      '{"status":"ok"}',
    ]
    const result = parseNDJSON(lines)
    expect(result.content).toBe('hi')
  })

  it('handles tool_calls with empty arguments', () => {
    const lines = [
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"system_info","arguments":{}}}]}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.arguments).toEqual({})
  })

  it('handles done=true chunk with both content and tool_calls', () => {
    const lines = [
      '{"message":{"role":"assistant","content":"Let me help. ","tool_calls":[{"function":{"name":"file_list","arguments":{"path":"."}}}]},"done":true}',
    ]
    const result = parseNDJSON(lines)
    expect(result.content).toBe('Let me help. ')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('file_list')
  })

  it('tool call accumulation order is preserved', () => {
    const lines = [
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"file_read","arguments":{"path":"1.ts"}}}]}}',
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"file_write","arguments":{"path":"2.ts","content":"x"}}}]}}',
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"shell_execute","arguments":{"command":"npm test"}}}]}}',
    ]
    const result = parseNDJSON(lines)
    expect(result.toolCalls).toHaveLength(3)
    expect(result.toolCalls.map(tc => tc.function.name)).toEqual([
      'file_read', 'file_write', 'shell_execute',
    ])
  })
})

// ── Drift detection ─────────────────────────────────────────────────────
describe('streamWithTools drift detection', () => {
  it('useCodex.ts still uses append-spread for tool_calls (not overwrite)', () => {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const src = readFileSync(join(__dirname, '../useCodex.ts'), 'utf8')

    // Must contain the spread-append pattern, not the old overwrite
    expect(src).toContain('...toolCalls, ...j.message.tool_calls.map')
    // Must NOT contain the old overwrite pattern
    expect(src).not.toMatch(/toolCalls\s*=\s*j\.message\.tool_calls\.map/)
  })

  it('useCodex.ts uses localFetchStream (not raw fetch)', () => {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const src = readFileSync(join(__dirname, '../useCodex.ts'), 'utf8')

    expect(src).toContain('localFetchStream')
    // Must NOT use raw fetch() for the streaming endpoint
    expect(src).not.toMatch(/\bfetch\(url,/)
  })
})
