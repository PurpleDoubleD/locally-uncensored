/**
 * Tool Call Repair Tests
 *
 * Tests all exported functions from tool-call-repair.ts:
 * - repairJson() — broken JSON repair
 * - repairToolCallArgs() — argument normalization
 * - extractToolCallsFromContent() — tool call extraction from text
 *
 * Run: npx vitest run src/lib/__tests__/tool-call-repair.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  repairJson,
  repairToolCallArgs,
  extractToolCallsFromContent,
} from '../tool-call-repair'

describe('tool-call-repair', () => {
  // ── repairJson ───────────────────────────────────────────────

  describe('repairJson', () => {
    it('parses valid JSON directly', () => {
      expect(repairJson('{"key": "value"}')).toEqual({ key: 'value' })
    })

    it('parses valid JSON arrays', () => {
      expect(repairJson('[1, 2, 3]')).toEqual([1, 2, 3])
    })

    it('parses valid JSON with numbers and booleans', () => {
      expect(repairJson('{"a": 1, "b": true, "c": null}')).toEqual({
        a: 1,
        b: true,
        c: null,
      })
    })

    it('fixes single quotes to double quotes', () => {
      const result = repairJson("{'name': 'test'}")
      expect(result).toEqual({ name: 'test' })
    })

    it('fixes trailing commas in objects', () => {
      const result = repairJson('{"a": 1, "b": 2,}')
      expect(result).toEqual({ a: 1, b: 2 })
    })

    it('fixes trailing commas in arrays', () => {
      const result = repairJson('[1, 2, 3,]')
      expect(result).toEqual([1, 2, 3])
    })

    it('fixes unquoted keys', () => {
      const result = repairJson('{name: "test", value: 42}')
      expect(result).toEqual({ name: 'test', value: 42 })
    })

    it('fixes missing closing braces', () => {
      const result = repairJson('{"name": "test"')
      expect(result).toEqual({ name: 'test' })
    })

    it('fixes missing closing brackets', () => {
      const result = repairJson('[1, 2, 3')
      expect(result).toEqual([1, 2, 3])
    })

    it('extracts JSON from surrounding text', () => {
      const result = repairJson('Here is the result: {"query": "hello"} end')
      expect(result).toEqual({ query: 'hello' })
    })

    it('extracts JSON from model preamble text', () => {
      const result = repairJson('I will search for that. {"name": "web_search", "arguments": {"query": "test"}}')
      expect(result).toEqual({
        name: 'web_search',
        arguments: { query: 'test' },
      })
    })

    it('handles nested objects', () => {
      const result = repairJson('{"outer": {"inner": "value"}}')
      expect(result).toEqual({ outer: { inner: 'value' } })
    })

    it('handles combined fixes: single quotes + trailing comma + unquoted keys', () => {
      const result = repairJson("{name: 'test', value: 'hello',}")
      expect(result).toEqual({ name: 'test', value: 'hello' })
    })

    it('returns null for completely unparseable input', () => {
      expect(repairJson('not json at all')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(repairJson('')).toBeNull()
    })

    it('last-resort extraction: finds name/arguments key-value pattern', () => {
      // Input without braces so steps 2-7 fail, but last-resort regex matches
      const messy = 'name="web_search", arguments are unknown'
      const result = repairJson(messy)
      expect(result).not.toBeNull()
      expect(result.name).toBe('web_search')
      expect(result.arguments).toEqual({})
    })

    it('handles whitespace-only input', () => {
      expect(repairJson('   ')).toBeNull()
    })

    it('handles JSON with extra whitespace', () => {
      const result = repairJson('  {  "key"  :  "value"  }  ')
      expect(result).toEqual({ key: 'value' })
    })
  })

  // ── repairToolCallArgs ───────────────────────────────────────

  describe('repairToolCallArgs', () => {
    it('returns object args unchanged', () => {
      const args = { query: 'test', limit: 5 }
      expect(repairToolCallArgs(args)).toEqual(args)
    })

    it('returns empty object for null', () => {
      expect(repairToolCallArgs(null)).toEqual({})
    })

    it('parses string args as JSON', () => {
      const result = repairToolCallArgs('{"query": "hello"}')
      expect(result).toEqual({ query: 'hello' })
    })

    it('repairs broken string args', () => {
      const result = repairToolCallArgs("{query: 'hello'}")
      expect(result).toEqual({ query: 'hello' })
    })

    it('returns empty object for unparseable string', () => {
      expect(repairToolCallArgs('not json')).toEqual({})
    })

    it('returns empty object for undefined', () => {
      expect(repairToolCallArgs(undefined)).toEqual({})
    })

    it('returns empty object for number input', () => {
      expect(repairToolCallArgs(42 as any)).toEqual({})
    })

    it('returns empty object for boolean input', () => {
      expect(repairToolCallArgs(true as any)).toEqual({})
    })

    it('returns array if args parse to array', () => {
      // Arrays are objects, so they pass the typeof check
      const arr = [1, 2, 3]
      expect(repairToolCallArgs(arr as any)).toEqual(arr)
    })

    it('handles nested object args', () => {
      const args = { config: { key: 'value' }, items: [1, 2] }
      expect(repairToolCallArgs(args)).toEqual(args)
    })

    it('returns empty object for empty string', () => {
      expect(repairToolCallArgs('')).toEqual({})
    })
  })

  // ── extractToolCallsFromContent ──────────────────────────────

  describe('extractToolCallsFromContent', () => {
    it('extracts tool call with "name" and "arguments" keys', () => {
      const content = 'I will search: {"name": "web_search", "arguments": {"query": "test"}}'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('web_search')
      expect(calls[0].arguments).toEqual({ query: 'test' })
    })

    it('extracts tool call with "tool" and "args" keys', () => {
      const content = '{"tool": "file_read", "args": {"path": "/tmp/test.txt"}}'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('file_read')
      expect(calls[0].arguments).toEqual({ path: '/tmp/test.txt' })
    })

    it('extracts tool call with "function" and "parameters" keys', () => {
      const content = '{"function": "shell_execute", "parameters": {"command": "ls"}}'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('shell_execute')
      expect(calls[0].arguments).toEqual({ command: 'ls' })
    })

    it('extracts tool call with "input" key for arguments', () => {
      const content = '{"name": "web_fetch", "input": {"url": "https://example.com"}}'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('web_fetch')
    })

    it('extracts multiple tool calls from one string', () => {
      const content = '{"name": "web_search", "arguments": {"query": "a"}} then {"name": "web_fetch", "arguments": {"url": "b"}}'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(2)
      expect(calls[0].name).toBe('web_search')
      expect(calls[1].name).toBe('web_fetch')
    })

    it('returns empty array when no tool calls found', () => {
      expect(extractToolCallsFromContent('Hello, how are you?')).toEqual([])
    })

    it('returns empty array for empty string', () => {
      expect(extractToolCallsFromContent('')).toEqual([])
    })

    it('extracts function-call syntax: web_search("query")', () => {
      const content = 'Let me search: web_search("test query")'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('web_search')
      expect(calls[0].arguments).toHaveProperty('query')
    })

    it('extracts function-call syntax: file_read(path)', () => {
      const content = 'file_read("/tmp/test.txt")'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('file_read')
    })

    it('extracts function-call syntax: shell_execute with args', () => {
      const content = 'Running: shell_execute("command": "ls -la")'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('shell_execute')
    })

    it('extracts function-call syntax with empty args', () => {
      const content = 'system_info()'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('system_info')
      expect(calls[0].arguments).toEqual({})
    })

    it('does not extract unknown function names in call syntax', () => {
      // Only known tool names are matched for Pattern 2
      const content = 'unknown_tool("arg")'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(0)
    })

    it('prefers JSON pattern over function-call pattern', () => {
      // Pattern 2 only runs if Pattern 1 found nothing
      const content = '{"name": "web_search", "arguments": {"query": "test"}} also file_read("/tmp")'
      const calls = extractToolCallsFromContent(content)
      // Pattern 1 matches, so Pattern 2 is skipped
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('web_search')
    })

    it('handles mixed text with JSON tool call', () => {
      const content = 'Sure, I will look that up for you now. {"name": "web_search", "arguments": {"query": "weather today"}} Let me know if you need more.'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('web_search')
      expect(calls[0].arguments.query).toBe('weather today')
    })

    it('handles screenshot tool in function-call syntax', () => {
      const content = 'screenshot()'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('screenshot')
    })

    it('handles code_execute in function-call syntax', () => {
      const content = 'code_execute("print(42)")'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('code_execute')
    })

    it('handles process_list in function-call syntax', () => {
      const content = 'process_list()'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('process_list')
    })
  })
})
