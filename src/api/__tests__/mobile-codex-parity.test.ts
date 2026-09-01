/**
 * Mobile ↔ Desktop parity for Codex and Agent.
 *
 * ── 01.09.2026 (T-75): this file used to be a grep ──
 *
 * Every assertion here read src-tauri/src/commands/remote.rs as one string and
 * asked whether a substring appeared in it. `expect(REMOTE_RS).toContain(
 * "'file_read'")` is green whether the name is in CODEX_TOOLS, in a comment,
 * in a Rust test, or in a paragraph of prose — and the file was 7 483 lines
 * long, so it was in several of those at once. The test for the tools that
 * were REMOVED in 2.6.6 had already been narrowed to a CODEX_TOOLS-scoped
 * regex for exactly that reason; the positive half never was.
 *
 * The mobile client is real source now (mobile-client/), so the lists and the
 * helpers are imported and asserted on directly: `CODEX_TOOLS` is an array
 * here, not a substring. What genuinely lives inside the 2 100-line client
 * shell — the agent loop, the renderer — still has to be read as text, and
 * those tests say so and read mobile-client/client.js rather than the Rust
 * file that no longer contains it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AGENT_ALL_TOOLS,
  AGENT_TOOLS,
  CODEX_TOOLS,
  buildToolDefs,
  extractToolCallsFromContent,
  isSystemPromptEcho,
  repairToolCallArgs,
  stripRanges,
  stripThinkTags,
} from '../../../mobile-client/agent-core.js'

/** The agent loop and the renderer live in the client shell. */
const CLIENT = readFileSync(
  resolve(__dirname, '..', '..', '..', 'mobile-client', 'client.js'),
  'utf8',
)
/** The Rust half — the permission defaults are genuinely server-side. */
const REMOTE_RS = readFileSync(
  resolve(__dirname, '..', '..', '..', 'src-tauri', 'src', 'commands', 'remote.rs'),
  'utf8',
)

describe('Mobile CODEX_TOOLS', () => {
  it('is the exact list Codex may call', () => {
    // The whole list, in order, rather than seven independent "contains"
    // checks: a tool added without being thought about shows up here.
    expect(CODEX_TOOLS).toEqual([
      'file_read',
      'file_write',
      'file_list',
      'file_search',
      'shell_execute',
      'web_search',
      'web_fetch',
    ])
  })

  it('does NOT include the tools retired by the 2.6.6 merge', () => {
    // code_execute / system_info / get_current_time left CODEX_TOOLS when the
    // typed wrappers folded into shell_execute plus the environment block.
    for (const gone of ['code_execute', 'system_info', 'get_current_time']) {
      expect(CODEX_TOOLS).not.toContain(gone)
    }
  })

  it('names only tools the agent actually has', () => {
    // A Codex tool that is not in AGENT_TOOLS is a name buildToolDefs will
    // silently drop, and Codex would then be told about a tool it cannot call.
    for (const name of CODEX_TOOLS) {
      expect(AGENT_ALL_TOOLS).toContain(name)
    }
  })
})

describe('Mobile AGENT_TOOLS', () => {
  it('AGENT_ALL_TOOLS is every registered tool, in registration order', () => {
    expect(AGENT_ALL_TOOLS).toEqual(AGENT_TOOLS.map((t) => t.name))
  })

  it('covers the desktop roster', () => {
    for (const name of [
      'todo_write',
      'web_search',
      'web_fetch',
      'file_read',
      'file_write',
      'file_list',
      'file_search',
      'shell_execute',
      'screenshot',
      'image_generate',
    ]) {
      expect(AGENT_ALL_TOOLS).toContain(name)
    }
  })

  it('every tool carries a description and typed parameters', () => {
    for (const t of AGENT_TOOLS) {
      expect(typeof t.name).toBe('string')
      expect(t.description.length).toBeGreaterThan(40)
      expect(Array.isArray(t.parameters)).toBe(true)
      for (const p of t.parameters) {
        expect(typeof p.name).toBe('string')
        expect(['string', 'number', 'boolean', 'array', 'object']).toContain(p.type)
        expect(typeof p.description).toBe('string')
      }
    }
  })
})

describe('Mobile buildToolDefs', () => {
  it('emits Ollama function schemas for exactly the whitelisted names', () => {
    const defs = buildToolDefs(['file_read', 'web_fetch'])
    expect(defs.map((d) => d.function.name)).toEqual(['web_fetch', 'file_read'])
    expect(defs.every((d) => d.type === 'function')).toBe(true)
  })

  it('marks required parameters as required and optional ones as not', () => {
    const [def] = buildToolDefs(['file_read'])
    expect(def.function.parameters.type).toBe('object')
    expect(Object.keys(def.function.parameters.properties)).toEqual(['path', 'offset', 'limit'])
    expect(def.function.parameters.required).toEqual(['path'])
  })

  it('an unknown name yields nothing rather than a half-built schema', () => {
    expect(buildToolDefs(['no_such_tool'])).toEqual([])
  })

  it('a zero-parameter tool still gets a valid object schema', () => {
    const [def] = buildToolDefs(['screenshot'])
    expect(def.function.parameters).toEqual({ type: 'object', properties: {}, required: [] })
  })
})

describe('Mobile tool-call repair', () => {
  it('passes an object through untouched', () => {
    const o = { path: 'a.txt' }
    expect(repairToolCallArgs(o)).toBe(o)
  })

  it('parses the JSON string Ollama sometimes sends instead', () => {
    // This is the bug: the Rust agent-tool endpoint saw args = "{...}" and
    // file_write answered "needs argument".
    expect(repairToolCallArgs('{"path":"a.txt"}')).toEqual({ path: 'a.txt' })
  })

  /**
   * FINDING (01.09.2026, first real test of this function): the
   * double-encoding branch below the first `JSON.parse` is unreachable.
   *
   * The source reads:
   *
   *     try{ var parsed = JSON.parse(trimmed);
   *          return (parsed && typeof parsed === 'object') ? parsed : {}; }catch(_){}
   *     if(trimmed.charAt(0) === '"' && …)   // ← double-decode lives here
   *
   * A double-encoded argument IS valid JSON — a JSON string — so the first
   * parse succeeds, `typeof parsed` is 'string', and the function returns `{}`
   * before it ever reaches the unwrapping it was written for. The branch can
   * only be entered by input that both fails to parse and is quoted at both
   * ends, and that input fails the inner parse too.
   *
   * This test pins what the shipped client really does rather than what the
   * comment above the branch says. It is deliberately NOT fixed here: T-75
   * moves this code out of a Rust string without changing a byte of it, and
   * the page this repository serves is proven identical to the one it served
   * before. The fix is its own change.
   */
  it('does NOT unwrap a double-encoded string — the repair branch is dead code', () => {
    expect(repairToolCallArgs(JSON.stringify('{"path":"a.txt"}'))).toEqual({})
  })

  it('answers {} for null, empty and unparseable input rather than throwing', () => {
    expect(repairToolCallArgs(null)).toEqual({})
    expect(repairToolCallArgs('')).toEqual({})
    expect(repairToolCallArgs('not json')).toEqual({})
    expect(repairToolCallArgs(7)).toEqual({})
  })
})

describe('Mobile fenced tool-call extraction', () => {
  const known = ['file_write', 'shell_execute']

  it('finds a fenced call and reports where it sat', () => {
    const content = 'sure\n```json\n{"name":"file_write","arguments":{"path":"a"}}\n```\ndone'
    const { calls, ranges } = extractToolCallsFromContent(content, known)
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('file_write')
    expect(calls[0].function.arguments).toEqual({ path: 'a' })
    expect(content.slice(ranges[0].start, ranges[0].end)).toContain('file_write')
  })

  it('ignores a fenced object that is not a known tool', () => {
    const content = '```json\n{"name":"rm_rf","arguments":{}}\n```'
    expect(extractToolCallsFromContent(content, known).calls).toEqual([])
  })

  it('stripRanges removes the JSON from the visible text', () => {
    const content = 'before\n```json\n{"name":"file_write","arguments":{}}\n```\nafter'
    const { ranges } = extractToolCallsFromContent(content, known)
    expect(stripRanges(content, ranges)).toBe('before\n\nafter')
  })

  it('non-string content is not a crash', () => {
    expect(extractToolCallsFromContent(null, known)).toEqual({ calls: [], ranges: [] })
  })
})

describe('Mobile system-prompt echo guard', () => {
  it('catches the openings that used to reach the chat', () => {
    for (const echo of [
      'I am the Coding Agent, ready to help.',
      "Hello! I'm the Coding Agent and I can read files.",
      'I am ready to receive the task.',
      'You are an autonomous coding agent.',
    ]) {
      expect(isSystemPromptEcho(echo)).toBe(true)
    }
  })

  it('leaves a real answer alone', () => {
    for (const real of [
      'I read src/main.ts and the bug is on line 40.',
      'Done — three files written.',
      '',
    ]) {
      expect(isSystemPromptEcho(real)).toBe(false)
    }
  })
})

describe('Mobile thinking support', () => {
  it('strips <think> blocks out of the answer', () => {
    const out = stripThinkTags('<think>plan</think>the answer', false)
    expect(out.content).toBe('the answer')
    expect(out.thinking).toBe('')
  })

  it('keeps the reasoning when asked to', () => {
    const out = stripThinkTags('<think>plan</think>answer', true)
    expect(out.thinking).toBe('plan')
    expect(out.content).toBe('answer')
  })

  it('also strips the non-canonical formats Gemma and GPT-OSS emit', () => {
    expect(stripThinkTags('<reasoning>x</reasoning>real', false).content).toBe('real')
    expect(stripThinkTags('<|channel|>a<|message|>real', false).content).toBe('real')
  })

  it('handles Ollama native thinking field alongside the tags', () => {
    expect(CLIENT).toContain('res.thinking')
  })
})

describe('Mobile agent loop — read as source, because it lives in the shell', () => {
  // These are the parts of the client that touch the DOM and the network on
  // every line, so they are not importable. The assertions are on
  // mobile-client/client.js, i.e. on the file that becomes the page, and they
  // are string matches: they say the call is written down, not that it runs.
  it('runToolLoop exists', () => {
    expect(CLIENT).toContain('function runToolLoop')
  })

  it('has a max iteration guard', () => {
    expect(CLIENT).toMatch(/maxIter|MAX_ITER|iter\s*>=\s*\d+|iter\s*<\s*\d+/)
  })

  it('terminates on an empty tool_calls list', () => {
    expect(CLIENT).toMatch(/toolCalls.*length\s*===?\s*0|!res\.toolCalls/)
  })

  it('supports user abort', () => {
    expect(CLIENT).toContain('agentAbort')
  })

  it('routes Codex to CODEX_TOOLS and Agent to AGENT_ALL_TOOLS', () => {
    expect(CLIENT).toContain('isCodexChat ? CODEX_TOOLS : AGENT_ALL_TOOLS')
  })

  it('nativeToolChat posts to the Ollama proxy with a tools array', () => {
    expect(CLIENT).toContain('function nativeToolChat')
    expect(CLIENT).toContain("fetch('/api/chat'")
    expect(CLIENT).toMatch(/tools:\s*tools/)
  })

  it('renderChat skips hidden messages, which are still in msgs for the model', () => {
    expect(CLIENT).toContain('m.hidden')
    expect(CLIENT).toContain('hidden: true')
  })

  it('falls back to a written summary when the model answers empty', () => {
    expect(CLIENT).toContain('file(s) written')
    expect(CLIENT).toContain('finishToolLoop')
  })
})

describe('Mobile permissions (server side, so still Rust)', () => {
  // RA-1: this used to assert "all permissions default to ON" — and it passed
  // for the wrong reason, because it matched `filesystem: true` ANYWHERE in the
  // file (the merge tests contain that literal). The default it was guarding
  // was itself the bug: the desktop panel renders every toggle off on a fresh
  // start, so a server that starts filesystem/downloads/process_control at
  // `true` hands a paired phone workspace read/write, model pull/delete and
  // ComfyUI start/stop that the user never granted. Now scoped to the actual
  // `impl Default` block, and asserting the conservative default.
  const defaultBlock = REMOTE_RS.match(
    /impl\s+Default\s+for\s+RemotePermissions\s*\{[\s\S]*?\n\}/,
  )?.[0]

  it('has an impl Default for RemotePermissions', () => {
    expect(defaultBlock).toBeTruthy()
  })

  it('defaults every permission to OFF, matching what the desktop panel shows', () => {
    expect(defaultBlock).toMatch(/filesystem:\s*false/)
    expect(defaultBlock).toMatch(/downloads:\s*false/)
    expect(defaultBlock).toMatch(/process_control:\s*false/)
    expect(defaultBlock).toMatch(/shell:\s*false/)
    expect(defaultBlock).not.toMatch(/:\s*true/)
  })

  it('reports the effective permissions back to the desktop', () => {
    // Without a read-back the panel is decoration: it can only ever show its
    // own local guess. Both the start response and the status command carry
    // them, and the store maps them in.
    expect(REMOTE_RS).toContain('"permissions": permissions')
  })
})
