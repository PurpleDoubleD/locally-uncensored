/**
 * Prompt / registry drift guard (2026-08-05).
 *
 * Five system prompts used to type their tool list out by hand, and by the time
 * anyone looked, the Agent prompt named 15 of the 30 registered builtins. It
 * had never heard of file_edit, the git set, run_tests, the background shell or
 * todo_write. A tool the prompt does not name is a tool the model does not
 * reach for, whatever the request payload carries, so that drift was silent
 * capability loss, and it grows every time a tool is added.
 *
 * Two rules, both cheap to keep:
 *   1. a prompt may not name a tool that does not exist
 *   2. the tools we force into every request (ALWAYS_INCLUDE) must be named
 *
 * Prompts are read out of the source rather than imported: they live inside
 * React hooks whose module graph pulls in Tauri. Same approach the mobile
 * parity test takes.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToolRoster, renderToolNames } from '../tool-roster'
import { ALWAYS_INCLUDE } from '../tool-selection'
import type { MCPToolDefinition, ToolCategory } from '../../api/mcp/types'
import { CODEX_PROMPT } from '../../../mobile-client/personas.js'
import { AGENT_ALL_TOOLS } from '../../../mobile-client/agent-core.js'

const SRC = resolve(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(resolve(SRC, ...p), 'utf8')

const TOOL_NAMES: string[] = (() => {
  // BUILTIN_TOOLS is the registry, but not every entry is spelled out in it:
  // delegate_task is defined in sub-agent.ts and spread into the array, so
  // reading only builtin-tools.ts would report a real tool as nonexistent.
  const sources = [read('api', 'mcp', 'builtin-tools.ts'), read('api', 'agents', 'sub-agent.ts')]
  const names = sources.flatMap((ts) =>
    [...ts.matchAll(/^\s+name: '([a-z0-9_]+)',$/gm)].map((m) => m[1]),
  )
  return [...new Set(names)]
})()

/**
 * The snake_case words a prompt may use that are NOT tool names. Every entry is
 * a deliberate exception; a NEW unknown word failing this test is the point.
 */
const NOT_TOOLS = new Set([
  'old_string', 'new_string', 'in_progress', 'tool_call', 'tool_response',
  'input_image', 'text_to_video', 'function_name', 'args_json',
])

/** A `const X = \`…\`` literal, cut at its closing backtick. */
function sliceTemplate(src: string, header: string): string {
  const start = src.indexOf(header)
  expect(start, `template not found: ${header}`).toBeGreaterThan(-1)
  const body = src.slice(start + header.length)
  const end = body.indexOf('`')
  expect(end, `unterminated template: ${header}`).toBeGreaterThan(-1)
  return body.slice(0, end)
}

/** A function body, cut at the first line that is exactly `}`. */
function sliceFunction(src: string, header: string): string {
  const start = src.indexOf(header)
  expect(start, `function not found: ${header}`).toBeGreaterThan(-1)
  const rest = src.slice(start)
  const end = rest.search(/\n\}\n/)
  return end === -1 ? rest : rest.slice(0, end)
}

const agentChat = read('hooks', 'useAgentChat.ts')
const codex = read('hooks', 'useCodex.ts')
const hermes = read('api', 'hermes-tool-calling.ts')
// The mobile relay ships its own copy of the coding prompt. It drifted the
// same way and is the surface where a visible plan counts for most, so it is
// held to the same rule.
//
// 01.09.2026 (T-75): until today the prompt was recovered by finding
// `var CODEX_PROMPT = '` in src-tauri/src/commands/remote.rs and slicing to
// the next `';`, and the relay's tool list by a regex over the same file. The
// client is real source now, so both are imported.

const PROMPTS: Record<string, string> = {
  agent: sliceFunction(agentChat, 'function buildAgentSystemPrompt('),
  agentLean: sliceFunction(agentChat, 'function buildAgentSystemPromptLean('),
  chatTools: sliceFunction(agentChat, 'function buildChatToolsSystemPrompt('),
  codex: sliceTemplate(codex, 'const CODEX_SYSTEM_PROMPT = `'),
  codexLean: sliceTemplate(codex, 'const CODEX_SYSTEM_PROMPT_LEAN = `'),
  // Review mode hands the model an explicit MUST NOT list. A stale name there
  // is worse than elsewhere: it forbids a tool that no longer exists while
  // leaving a real mutating one unmentioned.
  codexReview: sliceTemplate(codex, 'const CODEX_REVIEW_SYSTEM_PROMPT = `'),
  hermes: sliceFunction(hermes, 'export function buildHermesToolPrompt('),
  mobileCodex: CODEX_PROMPT,
}

/**
 * The tools the mobile relay actually declares.
 *
 * This used to be a regex over remote.rs, anchored on `description:` because
 * parameters use the same `{name:'…'` shape — match the name alone and the
 * subset check below becomes a tautology. The array is imported now, so the
 * distinction is made by the language instead of by an anchor.
 */
const RELAY_TOOL_NAMES: string[] = AGENT_ALL_TOOLS

/** snake_case words, which is what every tool name looks like. */
function candidateToolWords(text: string): string[] {
  const words = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []
  return [...new Set(words)].filter((w) => !NOT_TOOLS.has(w))
}

describe('no prompt names a tool that does not exist', () => {
  it('the registry parsed cleanly, so the rest of this file means something', () => {
    // 15 since the 2.6.6 merge folded the typed shell wrappers away.
    expect(TOOL_NAMES.length).toBeGreaterThan(12)
    expect(TOOL_NAMES).toContain('todo_write')
    expect(TOOL_NAMES).toContain('file_edit')
  })

  for (const [label, body] of Object.entries(PROMPTS)) {
    // The relay ships a deliberately smaller set (no git, no run_tests, no
    // file_edit), so its prompt is measured against ITS list. Checking it
    // against the desktop registry would pass a prompt that promises the phone
    // a tool the phone does not have, which is exactly what happened when
    // this test was first written.
    const known = label === 'mobileCodex' ? RELAY_TOOL_NAMES : TOOL_NAMES
    it(`${label}`, () => {
      const unknown = candidateToolWords(body).filter((w) => !known.includes(w))
      expect(unknown, `${label} names tools it cannot call`).toEqual([])
    })
  }

  it('the relay list parsed, and is genuinely a subset of the desktop one', () => {
    expect(RELAY_TOOL_NAMES.length).toBeGreaterThan(8)
    expect(RELAY_TOOL_NAMES.length).toBeLessThan(TOOL_NAMES.length)
    expect(RELAY_TOOL_NAMES.filter((n) => !TOOL_NAMES.includes(n))).toEqual([])
  })
})

describe('the tools forced into every request are named in the prompts', () => {
  // ALWAYS_INCLUDE survives the small-model cap, so these are the ones the
  // model is guaranteed to have and the ones it most needs to be told about.
  // The full Agent prompt gets its list generated, so it is covered by
  // construction; these are the hand-written ones.
  it('the coding agent prompt names todo_write and file_edit', () => {
    expect(PROMPTS.codex).toContain('todo_write')
    expect(PROMPTS.codex).toContain('file_edit')
  })

  it('both lean prompts name todo_write, the tool a weak model needs most', () => {
    expect(PROMPTS.codexLean).toContain('todo_write')
    expect(PROMPTS.agentLean).toContain('todo_write')
  })

  it('the hermes prompt mentions the plan when the tool is offered', () => {
    expect(PROMPTS.hermes).toContain('todo_write')
  })

  it('the full agent prompt says the request carries a subset', () => {
    // The roster lists every permitted tool, but the keyword/embedding router
    // sends fewer on a local model. Without saying so, the prompt promises
    // capabilities the request does not carry and the model burns a step on an
    // unknown tool. Both prompts that list names have to say this.
    expect(PROMPTS.agent).toMatch(/request carries/i)
    expect(PROMPTS.agentLean).toMatch(/request carries/i)
  })

  it('the mobile coding prompt names the plan tool it ships with', () => {
    // The relay declares todo_write in its own AGENT_TOOLS list, so a prompt
    // that never names it ships a tool nothing can trigger.
    expect(PROMPTS.mobileCodex).toContain('todo_write')
  })
})

// ── the roster itself ────────────────────────────────────────────

const mk = (name: string, category: ToolCategory): MCPToolDefinition => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object', properties: {}, required: [] },
  category,
  source: 'builtin',
})

describe('renderToolRoster', () => {
  it('groups by what a prompt reader cares about, not by permission category', () => {
    const out = renderToolRoster([
      mk('file_read', 'filesystem'),
      mk('shell_execute', 'terminal'),
      mk('git_status', 'terminal'),
      mk('web_search', 'web'),
      mk('screenshot', 'desktop'),
      mk('system_info', 'system'),
      mk('image_generate', 'image'),
    ])
    expect(out).toContain('- Files: file_read')
    expect(out).toContain('- Shell and git: shell_execute, git_status')
    expect(out).toContain('- Web: web_search')
    // desktop and system share one line: the model has no use for the split.
    expect(out).toMatch(/- System: .*system_info.*screenshot|- System: .*screenshot.*system_info/)
    expect(out).toContain('- Creative: image_generate')
  })

  it('omits a group whose tools were all filtered out by permissions', () => {
    const out = renderToolRoster([mk('file_read', 'filesystem')])
    expect(out).toBe('- Files: file_read')
  })

  it('a tool in a category no group claims still reaches the model', () => {
    // A new ToolCategory must never make a tool invisible; it lands in Other.
    const out = renderToolRoster([mk('odd_one', 'quantum' as ToolCategory)])
    expect(out).toContain('- Other: odd_one')
  })

  it('lists every tool it is given exactly once', () => {
    const tools = [
      mk('file_read', 'filesystem'),
      mk('todo_write', 'system'),
      mk('run_workflow', 'workflow'),
    ]
    const out = renderToolRoster(tools)
    for (const t of tools) expect(out.match(new RegExp(t.name, 'g'))).toHaveLength(1)
  })
})

describe('renderToolNames', () => {
  it('is the flat form the lean prompts use', () => {
    expect(renderToolNames([mk('a_one', 'system'), mk('b_two', 'system')])).toBe('a_one, b_two')
  })

  it('every ALWAYS_INCLUDE tool is a real tool', () => {
    for (const name of ALWAYS_INCLUDE) expect(TOOL_NAMES).toContain(name)
  })
})
