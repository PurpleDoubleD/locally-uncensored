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
  extractToolCallsWithRanges,
  stripRanges,
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
      expect(result?.name).toBe('web_search')
      expect(result?.arguments).toEqual({})
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
      expect(repairToolCallArgs(42)).toEqual({})
    })

    it('returns empty object for boolean input', () => {
      expect(repairToolCallArgs(true)).toEqual({})
    })

    it('returns array if args parse to array', () => {
      // Arrays are objects, so they pass the typeof check
      const arr = [1, 2, 3]
      expect(repairToolCallArgs(arr)).toEqual(arr)
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

    // v2.5.0 regression test: qwen2.5-coder:3b emits tool calls wrapped
    // in a markdown code-fence instead of Ollama's native tool_calls
    // array. The extractor MUST find the call so useCodex can fall back.
    it('extracts tool call from markdown code-fence (qwen2.5-coder pattern)', () => {
      const content = '```json\n{\n  "name": "file_read",\n  "arguments": {\n    "path": "demo.js"\n  }\n}\n```'
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('file_read')
      expect(calls[0].arguments).toEqual({ path: 'demo.js' })
    })

    it('extracts multiline tool call with whitespace between keys', () => {
      const content = `Some text before.
\`\`\`json
{
  "name": "shell_execute",
  "arguments": { "command": "ls -la" }
}
\`\`\`
And after.`
      const calls = extractToolCallsFromContent(content)
      expect(calls).toHaveLength(1)
      expect(calls[0].name).toBe('shell_execute')
      expect(calls[0].arguments.command).toBe('ls -la')
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

// Live Agent run on the ship exe, 2026-07-25: a model wrapped its call in the
// Hermes tags, stripRanges removed only the JSON, and the leftover `<tool_call>`
// rendered as a stray `ool_call>` in the transcript (the renderer eats the first
// two chars of an unknown tag).
describe('stripRanges clears the tool-call wrapper, not just the JSON', () => {
  const strip = (content: string) => {
    const { ranges } = extractToolCallsWithRanges(content)
    return stripRanges(content, ranges)
  }

  it('leaves no Hermes tag behind', () => {
    const out = strip('Let me look.\n<tool_call>\n{"name": "file_list", "arguments": {"path": "."}}\n</tool_call>')
    expect(out).not.toContain('tool_call')
    expect(out).toBe('Let me look.')
  })

  it('handles the pipe and bracket spellings too', () => {
    expect(strip('<|tool_call|>{"name": "file_read", "arguments": {"path": "a"}}<|/tool_call|>')).toBe('')
    expect(strip('[TOOL_CALL]{"name": "file_read", "arguments": {"path": "a"}}[/TOOL_CALL]')).toBe('')
  })

  it('does not touch ordinary prose that merely mentions the words', () => {
    const prose = 'the tool call failed, try again'
    expect(stripRanges(prose, [])).toBe(prose)
  })
})

// Measured 2026-07-28: repairJson rewrote the whole text blindly, so the repairs
// destroyed the payloads they were meant to rescue. Every case below produced
// `null` before the string-aware rewrite — the tool call was dropped and the
// model got no error it could react to.
describe('repairJson does not corrupt the payload it repairs', () => {
  it('keeps single-quoted code inside a double-quoted string', () => {
    expect(repairJson(`{"path":"hello.py","content":"print('hello')",}`)).toEqual({
      path: 'hello.py',
      content: "print('hello')",
    })
  })

  it('keeps an apostrophe in prose', () => {
    expect(repairJson(`{"path":"note.md","content":"It doesn't matter",}`)).toEqual({
      path: 'note.md',
      content: "It doesn't matter",
    })
  })

  it('keeps a CSS block that looks like a bare key', () => {
    expect(repairJson(`{"path":"a.css","content":"a { color: red }",}`)).toEqual({
      path: 'a.css',
      content: 'a { color: red }',
    })
  })

  it('counts only structural braces when closing an unterminated object', () => {
    expect(repairJson(`{"path":"a.js","content":"const re = /\\\\{/"`)).toEqual({
      path: 'a.js',
      content: 'const re = /\\{/',
    })
  })

  it('closes nested containers innermost first', () => {
    expect(repairJson('{"a": [1, 2')).toEqual({ a: [1, 2] })
  })

  it('still converts genuinely single-quoted JSON', () => {
    expect(repairJson(`{'name': 'web_search', 'arguments': {'query': "it's fine"}}`)).toEqual({
      name: 'web_search',
      arguments: { query: "it's fine" },
    })
  })

  it('picks the first balanced object out of prose instead of spanning both', () => {
    const out = repairJson('First {"name":"a","arguments":{"x":1}} then {"name":"b"}')
    expect(out).toEqual({ name: 'a', arguments: { x: 1 } })
  })
})
