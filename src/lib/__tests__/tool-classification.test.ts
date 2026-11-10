/**
 * The read-only gate is a BLOCKLIST: a turn strips MUTATING_TOOLS and lets
 * everything else through. That means a tool nobody classified is allowed by
 * default, which is exactly how pr_resume sat inside /review and /plan while it
 * still had a shell injection in it (2026-07-26 security pass).
 *
 * This test closes the gap the other way round: every built-in tool must appear
 * in one of the two lists. Add a tool without deciding, and this fails.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { MUTATING_TOOLS } from '../mutating-tools'

// Read the names out of the source. Importing the module pulls in the
// builtin-tools → tool-registry → mcp/index cycle, which throws on load.
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../api/mcp/builtin-tools.ts'),
  'utf8',
)
const arrayStart = src.indexOf('const BUILTIN_TOOLS')
const arrayEnd = src.indexOf('export function registerBuiltinTools')
const BUILTIN_TOOL_NAMES = [
  ...new Set(
    [...src.slice(arrayStart, arrayEnd).matchAll(/^\s{4}name: '([a-z0-9_]+)',$/gm)].map((m) => m[1]),
  ),
]

/**
 * Safe to run in a read-only turn. Every name here is a decision: it either
 * only reads, or it only reports on work that is already running.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Writes the plan the user sees, and nothing else. It must stay available in
  // a read-only turn on purpose: /plan asking for a plan and then having no
  // tool to write one with would be absurd.
  'todo_write',
  // 3.1.0 (P-L): searches and reads pages, GET only, nothing leaves but the query.
  'web_research',
  'file_read',
  'file_list',
  'file_search',
  // Reads a PR through `gh pr view` / `gh pr diff`. Owner and repo are
  // validated to GitHub's own character set before they reach a shell.
  'pr_resume',
  'web_search',
  'web_fetch',
])

describe('every built-in tool is classified', () => {
  it('found the tool list to check', () => {
    // Guard the parsing itself, so a refactor that breaks the regex fails loudly
    // instead of quietly asserting over an empty list.
    expect(arrayStart).toBeGreaterThanOrEqual(0)
    expect(arrayEnd).toBeGreaterThan(arrayStart)
    // 14 since the 2.6.6 merge folded the twelve typed shell wrappers away.
    expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThan(12)
    expect(BUILTIN_TOOL_NAMES).toContain('shell_execute')
    expect(BUILTIN_TOOL_NAMES).toContain('pr_resume')
  })

  it('appears in exactly one of the two lists', () => {
    const unclassified: string[] = []
    const both: string[] = []
    for (const name of BUILTIN_TOOL_NAMES) {
      const mutating = MUTATING_TOOLS.has(name)
      const readOnly = READ_ONLY_TOOLS.has(name)
      if (!mutating && !readOnly) unclassified.push(name)
      if (mutating && readOnly) both.push(name)
    }
    expect(
      unclassified,
      'new tool with no decision: add it to MUTATING_TOOLS if it can change '
        + 'anything outside the conversation, otherwise to READ_ONLY_TOOLS here',
    ).toEqual([])
    expect(both, 'a tool cannot be both').toEqual([])
  })

  it('nothing that spawns a shell is read-only unless its arguments are constrained', () => {
    // pr_resume is the one read-only tool that reaches a shell. It is allowed
    // there only because parsePrUrl rejects every metacharacter, which
    // shell-injection.test.ts pins. The typed git readers left with the 2.6.6
    // merge; their read-only path is shell_execute, whose command classifier
    // (isReadOnlyCommand) carries the same proof in its own tests.
    const shellReaders = [...READ_ONLY_TOOLS].filter((n) =>
      ['pr_resume', 'shell_execute'].includes(n),
    )
    expect(shellReaders).toEqual(['pr_resume'])
  })
})
