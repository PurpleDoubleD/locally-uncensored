/**
 * C59 A2: local models up to ~35B get a short tool list with one-line
 * descriptions and reach every other tool through tool_search.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentProfileFor, paramsBillions, resultCharsFor, COMPACT_MAX_TOOLS } from '../agent-profile'
import {
  CORE_BRIEFS, TOOL_SEARCH, TOOL_SEARCH_DEF, briefDescription, briefFor, clearUnlockedTools,
  runToolSearch, searchTools, unlockedTools, withToolSearch,
} from '../tool-search'
import { resolveApprovalLevel } from '../agent-approval-policy'
import { ALWAYS_INCLUDE } from '../tool-selection'
import type { MCPToolDefinition } from '../../api/mcp/types'

const tool = (name: string, description: string): MCPToolDefinition => ({
  name, description, inputSchema: { type: 'object', properties: {}, required: [] }, category: 'system', source: 'builtin',
})

const CATALOG = [
  tool('file_read', 'Read a file.'),
  tool('file_write', 'Write a whole file.'),
  tool('shell_execute', 'THE terminal. Run a shell command.'),
  tool('video_generate', 'Make one short clip on this computer.'),
  tool('image_generate', 'Make one picture on this computer.'),
  tool('delegate_task', 'Spawn a focused sub-agent to work on a sub-goal autonomously.'),
  tool('get_settings', 'Read LU app settings: key, current value, allowed values.'),
]

describe('which profile a model gets', () => {
  it('reads the size from the name or the metadata', () => {
    expect(paramsBillions('hf.co/DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF:Q4_K_M')).toBe(9)
    expect(paramsBillions('hf.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF:Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf')).toBe(27)
    expect(paramsBillions('qwen3-coder:30b-a3b')).toBe(30)
    expect(paramsBillions('gpt-oss:20b')).toBe(20)
    expect(paramsBillions('llama3.3:70b')).toBe(70)
    expect(paramsBillions('mystery-model', '8.0B')).toBe(8)
    // "Qwen3.5" is a version, not 3.5 billion.
    expect(paramsBillions('Qwen3.5-instruct')).toBeNull()
  })

  it('local up to 35B is compact, bigger or cloud is full, Small-Model Mode wins', () => {
    expect(agentProfileFor({ local: true, modelName: 'qwen3.5:9b' })).toBe('compact')
    expect(agentProfileFor({ local: true, modelName: 'qwen3-coder:30b-a3b' })).toBe('compact')
    expect(agentProfileFor({ local: true, modelName: 'llama3.3:70b' })).toBe('full')
    expect(agentProfileFor({ local: false, modelName: 'glm-5.3-flash-9b' })).toBe('full')
    expect(agentProfileFor({ local: true, modelName: 'unknown-local' })).toBe('compact')
    expect(agentProfileFor({ local: true, modelName: 'qwen3.5:9b', compactAuto: false })).toBe('full')
    expect(agentProfileFor({ local: true, modelName: 'llama3.3:70b', smallModelMode: true })).toBe('tiny')
  })

  it('a compact result is capped between the tiny and the full one', () => {
    expect(resultCharsFor('tiny')).toBe(1500)
    expect(resultCharsFor('compact')).toBe(16000)
    expect(resultCharsFor('full')).toBe(60000)
  })
})

describe('tool_search', () => {
  beforeEach(() => clearUnlockedTools('c1'))

  it('finds a tool by what it does, name words first', () => {
    expect(searchTools('make a video', CATALOG).map((t) => t.name)[0]).toBe('video_generate')
    expect(searchTools('settings', CATALOG).map((t) => t.name)).toEqual(['get_settings'])
    expect(searchTools('sub agent', CATALOG).map((t) => t.name)).toContain('delegate_task')
    expect(searchTools('the a of', CATALOG)).toEqual([])
  })

  it('a search unlocks its hits for the next step of the same conversation', () => {
    const offered = new Set(['file_read', 'file_write', TOOL_SEARCH])
    const text = runToolSearch('c1', { query: 'generate a video clip' }, CATALOG, offered)
    expect(text).toMatch(/video_generate/)
    expect(unlockedTools('c1').has('video_generate')).toBe(true)
    expect(unlockedTools('c2').size).toBe(0)
    const next = withToolSearch([CATALOG[0], CATALOG[1]], CATALOG, 'c1', TOOL_SEARCH_DEF)
    expect(next.map((t) => t.name)).toEqual(['file_read', 'file_write', 'video_generate', TOOL_SEARCH])
  })

  it('names a tool that is already there instead of unlocking nothing', () => {
    const text = runToolSearch('c1', { query: 'read a file' }, CATALOG, new Set(['file_read', TOOL_SEARCH]))
    expect(text).toMatch(/Already in your list: file_read/)
    expect(runToolSearch('c1', {}, CATALOG, new Set())).toMatch(/needs a `query`/)
  })

  it('is only offered when the list left something out', () => {
    expect(withToolSearch(CATALOG, CATALOG, 'c1', TOOL_SEARCH_DEF).map((t) => t.name)).not.toContain(TOOL_SEARCH)
  })

  it('runs without asking: it only reads the catalog', () => {
    expect(resolveApprovalLevel(TOOL_SEARCH, { categoryLevel: 'confirm', codexMode: null, readOnlyRun: false })).toBe('auto')
    expect(resolveApprovalLevel(TOOL_SEARCH, { categoryLevel: 'confirm', codexMode: 'plan', readOnlyRun: true })).toBe('auto')
  })
})

describe('one-line descriptions', () => {
  it('every core tool has its own line, short and with the rule that matters', () => {
    for (const name of [...ALWAYS_INCLUDE, 'shell_execute', 'file_list', 'file_search', 'web_search', 'web_fetch']) {
      expect(CORE_BRIEFS[name], name).toBeTruthy()
      expect(CORE_BRIEFS[name].length, name).toBeLessThanOrEqual(160)
    }
    expect(CORE_BRIEFS.todo_write).toMatch(/COMPLETE list.*never on its own/)
    expect(CORE_BRIEFS.file_edit).toMatch(/old_string/)
  })

  it('other tools keep their first sentence', () => {
    expect(briefFor(tool('pr_resume', 'Pick up where a GitHub PR left off. Long text follows.'))).toBe('Pick up where a GitHub PR left off.')
    expect(briefDescription('x'.repeat(300)).length).toBe(160)
  })

  it('the compact list stays within the planned size', () => {
    expect(COMPACT_MAX_TOOLS).toBeGreaterThanOrEqual(ALWAYS_INCLUDE.length + 2)
  })
})

describe('the loops use it', () => {
  const src = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8')
  it('Agent and Code decide the profile and cap results from it', () => {
    for (const p of ['hooks/useAgentChat.ts', 'hooks/useCodex.ts']) {
      const s = src(p)
      expect(s, p).toMatch(/agentProfileFor\(/)
      expect(s, p).toMatch(/resultCharsFor\(/)
      expect(s, p).toMatch(/withToolSearch\(/)
      expect(s, p).toMatch(/runToolSearch\(/)
      expect(s, p).not.toMatch(/settings\.smallModelMode \? 1500 : 60000/)
    }
  })
})
