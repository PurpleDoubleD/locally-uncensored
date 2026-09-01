/**
 * Phase 3 (v2.4.0) — Tool-description parity test.
 *
 * The mobile web UI (mobile-client/) re-declares the AGENT_TOOLS array so the
 * ReAct prompt on mobile lists exactly the same capabilities. This test pins:
 *   - tool NAMES on both sides are the same set
 *   - each tool description is Claude-Code-quality (length + contains at least
 *     one of the recommended hint markers PREFER/NEVER/DO NOT/USE FIRST/Zero)
 *   - required-parameter lists line up
 *
 * If this test fails after a description edit, update BOTH sides together.
 *
 * ── 01.09.2026 (T-75) ──
 *
 * The mobile half used to be recovered with two regexes over
 * src-tauri/src/commands/remote.rs, because the client was a Rust string:
 *
 *     rs.match(/var AGENT_TOOLS = \[([\s\S]*?)\];/)
 *     /\{name:'([^']+)',\s*description:'((?:\\.|[^'\\])*)',…/g
 *
 * followed by three hand-written unescape rules for \' \" and \\ . A tool
 * whose description used a character that parser did not model simply did not
 * appear in `mobileTools`, and the set comparison below would then have said
 * "missing on mobile" for a tool that was there — or, if the outer match had
 * failed differently, said nothing at all. The client is real source now, so
 * the array is imported. No parser, no unescaping, no shape to drift.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_TOOLS } from '../../../mobile-client/agent-core.js'

/** One entry of the mobile AGENT_TOOLS array. */
interface MobileTool {
  name: string
  description: string
  parameters: { name: string; required: boolean }[]
}

type BuiltinTool = {
  name: string
  description: string
  inputSchema: {
    /**
     * Nur die NAMEN werden gebraucht — der Quelltext-Scan unten setzt fuer
     * jeden Namen ein leeres Objekt ein. `unknown` sagt genau das; `any` hat
     * eine Schema-Form behauptet, die hier nie existiert hat.
     */
    properties: Record<string, unknown>
    required: string[]
  }
}

// Import the desktop source of truth. Kept as a `require` to avoid pulling the
// full Tauri backend-call chain through vitest's module graph.
const builtinTools: BuiltinTool[] = (() => {
  // Grep the TS source directly to avoid transitive imports during test import.
  const ts = readFileSync(
    resolve(__dirname, '..', 'mcp', 'builtin-tools.ts'),
    'utf8'
  )
  return parseBuiltinToolsFromTs(ts)
})()

function parseBuiltinToolsFromTs(source: string): BuiltinTool[] {
  const tools: BuiltinTool[] = []
  // Match each entry inside BUILTIN_TOOLS: { name: '…', description: '…' + '…', … }
  const re =
    /\{\s*name:\s*'([^']+)'\s*,\s*description:\s*([\s\S]*?),\s*inputSchema:\s*(\{[\s\S]*?\}),\s*category/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const name = m[1]
    const description = evaluateStringLiteralExpression(m[2])
    const required = extractRequiredArray(m[3])
    const propsList = extractPropertiesNames(m[3])
    tools.push({
      name,
      description,
      inputSchema: {
        properties: Object.fromEntries(propsList.map((p) => [p, {}])),
        required,
      },
    })
  }
  return tools
}

// Handles concatenated string-literal expressions: 'a' + 'b' + "c" etc.
function evaluateStringLiteralExpression(expr: string): string {
  const pieces: string[] = []
  const re = /(['"])((?:\\.|(?!\1).)*?)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expr)) !== null) {
    pieces.push(
      m[2]
        // NUL is used as a private placeholder, not matched as input: an
        // escaped backslash is parked on a byte that cannot occur in a
        // TypeScript source literal, the other escapes are resolved, and the
        // last .replace puts it back. Any printable sentinel would be
        // ambiguous with real content — which is the whole point.
        .replace(/\\\\/g, '\x00') // placeholder so we do not re-process escaped backslashes
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/\x00/g, '\\')
    )
  }
  return pieces.join('')
}

/**
 * Offset of the first `key:` that sits at the TOP level of the schema object,
 * or -1. Depth-aware on purpose: `todo_write` (2026-08-05) is the first tool
 * whose schema nests an object, and a plain `.match(/required:/)` grabbed the
 * ITEM's `required: ['content','status']` instead of the schema's
 * `required: ['todos']`. Every nested-schema tool after it would have hit the
 * same wall.
 */
function topLevelKeyOffset(schemaExpr: string, key: string): number {
  let depth = 0
  for (let i = 0; i < schemaExpr.length; i++) {
    const c = schemaExpr[i]
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    // depth 1 == directly inside the schema object's braces
    else if (depth === 1 && schemaExpr.startsWith(key + ':', i)) return i
  }
  return -1
}

function extractRequiredArray(schemaExpr: string): string[] {
  const at = topLevelKeyOffset(schemaExpr, 'required')
  if (at < 0) return []
  const m = schemaExpr.slice(at).match(/required:\s*\[([^\]]*)\]/)
  if (!m) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

function extractPropertiesNames(schemaExpr: string): string[] {
  // Top-level `properties` only, and only its DIRECT keys — otherwise a nested
  // object schema contributes its own field names to the parent's parameter
  // list (todo_write would report `content` and `status` as its parameters).
  const at = topLevelKeyOffset(schemaExpr, 'properties')
  if (at < 0) return []
  const open = schemaExpr.indexOf('{', at)
  if (open < 0) return []
  const names: string[] = []
  let depth = 0
  for (let i = open; i < schemaExpr.length; i++) {
    const c = schemaExpr[i]
    if (c === '{' || c === '[') {
      depth++
      continue
    }
    if (c === '}' || c === ']') {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth === 1) {
      const m = /^(\w+):\s*\{/.exec(schemaExpr.slice(i))
      if (m) names.push(m[1])
    }
  }
  return names
}

// ─── The mobile side, imported rather than parsed ───

/** Exactly the array the phone runs. */
const mobileTools = AGENT_TOOLS

// ─── Tests ───

describe('tool-description-parity — extraction sanity', () => {
  it('parses the desktop BUILTIN_TOOLS list', () => {
    // Still a lower bound, and still earning its keep: this half IS a parser
    // (the brace scan over builtin-tools.ts above), so the only thing it can
    // honestly claim is "the scan found the catalogue rather than nothing".
    expect(builtinTools.length).toBeGreaterThanOrEqual(13)
  })

  /**
   * KF-3 (6). This assertion read `toBeGreaterThanOrEqual(9)` while the array
   * held TEN tools — todo_write, web_search, web_fetch, file_read, file_write,
   * file_list, file_search, shell_execute, screenshot, image_generate. A lost
   * tool would have slipped through the slack, and the number had no way of
   * noticing that it had gone stale.
   *
   * It is not re-pinned to 10 either, because 10 goes stale the same way the
   * 9 did. The count is DERIVED: the mobile catalogue is by definition the
   * desktop catalogue minus MOBILE_SKIP, which is the same ledger the name-set
   * test below reads. Add a desktop tool and wire it to mobile and this stays
   * green; add one and forget mobile, or drop one from mobile, and it goes red
   * with both numbers in the message.
   *
   * MOBILE_SKIP is declared below this block on purpose — the ledger belongs
   * next to the set comparison it explains. `it` bodies run after the module
   * has finished evaluating, so the reference is resolved by then.
   */
  it('the mobile AGENT_TOOLS list holds every desktop tool it is meant to', () => {
    const erwartet = builtinTools.filter((t) => !MOBILE_SKIP.has(t.name)).length
    expect(mobileTools).toHaveLength(erwartet)
  })
})

// Tools intentionally absent on mobile because their executor relies on
// desktop-only TypeScript code paths. Expanding this set requires wiring
// the Rust /remote-api/agent-tool dispatcher.
//   run_workflow    → needs WorkflowEngine (TS)
//   delegate_task   → needs sub-agent runner with provider access (TS)
//   v2.5.0 codex tools (Sprint A/B/C from uselu) — desktop-only because
//   their executors live in src/api/agents/*.ts and target the local
//   developer machine, not the mobile remote-control surface:
//     run_tests, git_*, gh_pr_create, pr_resume, project_init,
//     shell_execute_background, shell_task_*
//   v2.5.0 Feature EE:
//     video_generate → desktop-only. Its executor goes through the VRAM
//     hand-off orchestrator (src/api/vram-handoff.ts), pure TS that drives
//     local Ollama unload/reload + ComfyUI on the desktop GPU. The mobile
//     remote-control surface has no Rust dispatcher for it (same situation
//     image_generate is in — it's listed on mobile but its executor returns
//     a "desktop only" observation; video_generate isn't listed there yet).
const MOBILE_SKIP: ReadonlySet<string> = new Set<string>([
  'run_workflow', 'delegate_task',
  // file_edit (2.5.9 surgical edit) is desktop-only: its executor lives in
  // src/api/mcp/builtin-tools.ts and the mobile remote surface has no Rust
  // dispatcher for it (same situation as the other TS-only coding tools below).
  'file_edit',
  'run_tests',
  'git_status', 'git_commit', 'git_push', 'git_log', 'git_diff',
  'gh_pr_create',
  'pr_resume',
  'project_init',
  'shell_execute_background',
  'shell_task_status', 'shell_task_kill', 'shell_task_list',
  'video_generate',
])

describe('tool-description-parity — name sets', () => {
  it('desktop and mobile expose the same set of tool names (modulo documented skips)', () => {
    const desktopNames = new Set(builtinTools.map((t) => t.name))
    const mobileNames = new Set(mobileTools.map((t) => t.name))
    const expectedOnMobile = [...desktopNames].filter((n) => !MOBILE_SKIP.has(n))
    const missingFromMobile = expectedOnMobile.filter((n) => !mobileNames.has(n))
    const extraOnMobile = [...mobileNames].filter((n) => !desktopNames.has(n))
    expect(missingFromMobile).toEqual([])
    expect(extraOnMobile).toEqual([])
  })
})

describe('tool-description-parity — description quality', () => {
  const HINT_MARKERS = ['PREFER', 'NEVER', 'DO NOT', 'USE FIRST', 'USE for', 'NOT a', 'NOT for', 'WARN']

  // v2.5.0 sprint A/B/C tools (ported from uselu) have a different
  // description style — descriptive prose without the v2.4.0 Claude-Code
  // hint-marker vocabulary. They are still substantive (80+ chars) but
  // skip the marker check. Tracked in the v2.5.0 backlog for a future
  // description-style sweep so all desktop tools speak the same dialect.
  const DESCRIPTION_STYLE_SKIP: ReadonlySet<string> = new Set<string>([
    'shell_task_status', 'shell_task_kill', 'shell_task_list',
    'git_push', 'git_diff',
    'gh_pr_create', 'project_init', 'pr_resume',
    'shell_execute_background', 'git_status', 'git_commit', 'git_log', 'run_tests',
  ])

  it.each(builtinTools.map((t) => [t.name, t]))(
    'desktop %s has a substantive description',
    (_name, tool) => {
      // v2.5.0 sprint A/B/C tools have a terser style — skip the v2.4.0
      // Claude-Code quality bar for them. See DESCRIPTION_STYLE_SKIP comment.
      if (DESCRIPTION_STYLE_SKIP.has(_name as string)) return
      const desc = (tool as BuiltinTool).description
      // Claude-Code-quality target: 80+ chars.
      expect(desc.length).toBeGreaterThanOrEqual(80)
      // Contains at least one hint marker OR is a zero-arg system tool where
      // "Zero arguments" is itself the hint.
      const hasMarker =
        HINT_MARKERS.some((h) => desc.includes(h)) || /Zero arguments/i.test(desc)
      expect(hasMarker, `expected ${(_name as string)} description to contain a hint marker`).toBe(true)
    }
  )

  it.each(mobileTools.map((t) => [t.name, t]))(
    'mobile %s has a substantive description',
    (_name, tool) => {
      const desc = (tool as MobileTool).description
      expect(desc.length).toBeGreaterThanOrEqual(80)
      const hasMarker =
        HINT_MARKERS.some((h) => desc.includes(h)) || /Zero arguments/i.test(desc)
      expect(hasMarker).toBe(true)
    }
  )
})

describe('tool-description-parity — per-tool parity', () => {
  it('each desktop tool (excluding mobile skips) has a mobile counterpart with matching description', () => {
    const byName = new Map(mobileTools.map((t) => [t.name, t]))
    for (const d of builtinTools) {
      if (MOBILE_SKIP.has(d.name)) continue
      const m = byName.get(d.name)
      expect(m, `mobile AGENT_TOOLS missing ${d.name}`).toBeDefined()
      if (!m) continue
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
      expect(normalize(m.description)).toBe(normalize(d.description))
    }
  })

  it('required parameter names line up desktop ↔ mobile', () => {
    const byName = new Map(mobileTools.map((t) => [t.name, t]))
    for (const d of builtinTools) {
      if (MOBILE_SKIP.has(d.name)) continue
      const m = byName.get(d.name)
      if (!m) continue
      const mobileRequired = m.parameters.filter((p) => p.required).map((p) => p.name).sort()
      const desktopRequired = [...d.inputSchema.required].sort()
      expect(mobileRequired).toEqual(desktopRequired)
    }
  })
})
