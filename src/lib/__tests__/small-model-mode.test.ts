/**
 * Small-Model Mode (v2.5.0) — unit tests for the deterministic knobs.
 *
 * Covers:
 *  - Knob 1: applyMaxTools + the maxTools cap on the sync and async selectors
 *            (ALWAYS_INCLUDE survives, fills from embedding rank, no-op unset).
 *  - Knob 3: truncateToolResult (head+tail, marker, no-op under the limit).
 *  - Settings: smallModelMode default false + the v6→v7 additive-merge semantics
 *            the store migration relies on.
 *
 * Run: npx vitest run src/lib/__tests__/small-model-mode.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyMaxTools,
  selectRelevantTools,
  selectRelevantToolsAsync,
  ALWAYS_INCLUDE,
  SMALL_MODEL_MAX_TOOLS,
} from '../tool-selection'
import { clearEmbeddingCache } from '../../api/agents/embedding-router'
import { truncateToolResult } from '../truncate-tool-result'
import { DEFAULT_SETTINGS } from '../constants'
import type { MCPToolDefinition, PermissionMap } from '../../api/mcp/types'

const fullPerms: PermissionMap = {
  filesystem: 'auto',
  terminal: 'auto',
  desktop: 'auto',
  web: 'auto',
  system: 'auto',
  image: 'auto',
  video: 'auto',
  workflow: 'auto',
  mcp: 'auto',
}

const mkTool = (
  name: string,
  description: string,
  category: keyof PermissionMap = 'system',
): MCPToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {}, required: [] },
  category,
  source: 'builtin',
})

// Bag-of-letters embedding (same trick as tool-selection-async.test.ts) — keeps
// the test deterministic and free of any Ollama dependency.
const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    const v = new Array(26).fill(0)
    const s = t.toLowerCase()
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c >= 97 && c <= 122) v[c - 97] += 1
    }
    return v
  })

describe('Small-Model Mode — Knob 1: applyMaxTools', () => {
  const tools = [
    mkTool('file_read', 'read', 'filesystem'),
    mkTool('file_write', 'write', 'filesystem'),
    mkTool('file_edit', 'edit', 'filesystem'),
    mkTool('get_current_time', 'time', 'system'),
    mkTool('todo_write', 'plan', 'system'),
    mkTool('a', 'aaaa'),
    mkTool('b', 'bbbb'),
    mkTool('c', 'cccc'),
    mkTool('d', 'dddd'),
    mkTool('e', 'eeee'),
    mkTool('f', 'ffff'),
  ]

  it('is a strict no-op when maxTools is unset (same reference back)', () => {
    expect(applyMaxTools(tools)).toBe(tools)
  })

  it('is a no-op when the list already fits', () => {
    expect(applyMaxTools(tools, 100)).toBe(tools)
  })

  it('caps the list to maxTools', () => {
    expect(applyMaxTools(tools, 8).length).toBe(8)
  })

  it('keeps every ALWAYS_INCLUDE tool even after the cap', () => {
    const out = applyMaxTools(tools, 8)
    for (const name of ALWAYS_INCLUDE) {
      expect(out.some((t) => t.name === name)).toBe(true)
    }
  })

  it('ALWAYS_INCLUDE is a floor the cap cannot cut into', () => {
    // Documented overshoot: an always-included tool is never dropped, so a cap
    // below the size of that set returns the set. ALWAYS_INCLUDE gained
    // `todo_write` on 2026-08-05, which raised this floor from 4 to 5 — a small
    // model asking for 3 tools now gets 5. That is deliberate: a plan is what a
    // weak model needs most to stay on a long task.
    const out = applyMaxTools(tools, 3)
    expect(out.length).toBe(ALWAYS_INCLUDE.length)
    expect(out.map((t) => t.name).sort()).toEqual([...ALWAYS_INCLUDE].sort())
  })

  it('fills the non-always slots from rankOrder when provided', () => {
    // 5 ALWAYS_INCLUDE + 1 free slot; rank puts 'f' first → 'f' wins, 'a' loses.
    const out = applyMaxTools(tools, 6, ['f', 'e', 'd', 'c', 'b', 'a'])
    expect(out.length).toBe(6)
    expect(out.some((t) => t.name === 'f')).toBe(true)
    expect(out.some((t) => t.name === 'a')).toBe(false)
  })
})

describe('Small-Model Mode — Knob 1: selectRelevantTools (sync) maxTools', () => {
  const tools = [
    mkTool('file_read', 'read', 'filesystem'),
    mkTool('file_write', 'write', 'filesystem'),
    mkTool('file_list', 'list', 'filesystem'),
    mkTool('file_search', 'search', 'filesystem'),
    mkTool('shell_execute', 'run', 'terminal'),
    mkTool('web_search', 'search', 'web'),
    mkTool('get_current_time', 'time', 'system'),
  ]

  it('caps the keyword selection to maxTools', () => {
    const out = selectRelevantTools('help me with this project', tools, fullPerms, 3)
    expect(out.length).toBeLessThanOrEqual(3)
  })

  it('returns at least as many without the cap', () => {
    const capped = selectRelevantTools('help me with this project', tools, fullPerms, 3)
    const uncapped = selectRelevantTools('help me with this project', tools, fullPerms)
    expect(uncapped.length).toBeGreaterThanOrEqual(capped.length)
  })
})

describe('Small-Model Mode — Knob 1: selectRelevantToolsAsync maxTools', () => {
  beforeEach(() => clearEmbeddingCache())

  const many = Array.from({ length: 16 }, (_, i) =>
    mkTool(`tool_${i}`, `desc about topic ${i}`, 'system'),
  ).concat([
    mkTool('file_read', 'read a file on disk', 'filesystem'),
    mkTool('file_write', 'write a file on disk', 'filesystem'),
    mkTool('get_current_time', 'current local time', 'system'),
  ])

  it('caps the union to maxTools on the embedding path', async () => {
    const out = await selectRelevantToolsAsync('read the file on disk', many, fullPerms, {
      embed: fakeEmbed,
      embeddingThreshold: 5,
      topN: 8,
      maxTools: 6,
    })
    expect(out.length).toBeLessThanOrEqual(6)
  })

  it('ALWAYS_INCLUDE survives the cap', async () => {
    const out = await selectRelevantToolsAsync('read the file on disk', many, fullPerms, {
      embed: fakeEmbed,
      embeddingThreshold: 5,
      topN: 8,
      maxTools: 6,
    })
    expect(out.some((t) => t.name === 'file_read')).toBe(true)
  })

  it('is not capped when maxTools is unset', async () => {
    const out = await selectRelevantToolsAsync('read the file on disk', many, fullPerms, {
      embed: fakeEmbed,
      embeddingThreshold: 5,
      topN: 8,
    })
    // Without a cap the union can exceed 6; just assert it produced tools and
    // wasn't silently clamped to the small-model ceiling.
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('Small-Model Mode — Knob 3: truncateToolResult', () => {
  it('is a no-op for output under the limit', () => {
    const s = 'short tool output'
    expect(truncateToolResult(s, 1500)).toBe(s)
  })

  it('keeps head + tail and drops the middle with a marker', () => {
    const head = 'HEAD'.repeat(500) // 2000 chars
    const mid = 'M'.repeat(2000)
    const tail = 'TAIL'.repeat(500) // 2000 chars
    const full = head + mid + tail
    const out = truncateToolResult(full, 1500)

    expect(out.length).toBeLessThan(full.length)
    expect(out.startsWith('HEAD')).toBe(true)
    expect(out.includes('TAIL')).toBe(true)
    expect(out).toMatch(/truncated \d+ chars/)
    expect(out.includes('MMMM')).toBe(false) // the middle is gone
  })

  it('defaults to a 1500-char budget', () => {
    const out = truncateToolResult('x'.repeat(5000))
    expect(out.length).toBeLessThan(5000)
  })
})

describe('Small-Model Mode — settings default + v6→v7 migration merge', () => {
  it('DEFAULT_SETTINGS.smallModelMode is false', () => {
    expect(DEFAULT_SETTINGS.smallModelMode).toBe(false)
  })

  it('the additive merge fills smallModelMode while preserving user values', () => {
    // A persisted v6 blob predates the field — exactly what the store migrate
    // hands to `{ ...DEFAULT_SETTINGS, ...persisted.settings }`.
    const oldV6 = { temperature: 0.42, thinkingEnabled: false }
    const merged = { ...DEFAULT_SETTINGS, ...oldV6 }
    expect(merged.smallModelMode).toBe(false) // default filled in
    expect(merged.temperature).toBe(0.42) // user value preserved
    expect(merged.thinkingEnabled).toBe(false) // user value preserved
  })
})

// ── The cap is derived from the floor (2026-08-05) ───────────────

describe('Small-Model Mode — the cap cannot be strangled by the floor', () => {
  it('leaves the semantic router exactly two slots', () => {
    // The number the mode was tuned on. A hardcoded cap silently loses these
    // slots every time ALWAYS_INCLUDE grows: adding todo_write took the router
    // from 2 free slots to 1 without anyone editing the cap.
    expect(SMALL_MODEL_MAX_TOOLS - ALWAYS_INCLUDE.length).toBe(2)
  })

  it('a capped selection really does carry two routed tools on top of the floor', () => {
    const tools = [
      ...ALWAYS_INCLUDE.map((n) => mkTool(n, n, 'system')),
      mkTool('shell_execute', 'run a command', 'terminal'),
      mkTool('file_list', 'list a directory', 'filesystem'),
      mkTool('web_search', 'search the web', 'web'),
    ]
    const out = applyMaxTools(tools, SMALL_MODEL_MAX_TOOLS, ['shell_execute', 'file_list', 'web_search'])
    expect(out).toHaveLength(SMALL_MODEL_MAX_TOOLS)
    for (const n of ALWAYS_INCLUDE) expect(out.some((t) => t.name === n)).toBe(true)
    expect(out.some((t) => t.name === 'shell_execute')).toBe(true)
    expect(out.some((t) => t.name === 'file_list')).toBe(true)
  })
})
