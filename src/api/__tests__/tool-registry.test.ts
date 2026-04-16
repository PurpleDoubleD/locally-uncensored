import { describe, it, expect } from 'vitest'
import {
  AGENT_TOOL_DEFS,
  getOllamaTools,
  getToolByName,
  getToolPermission,
} from '../tool-registry'

// ── AGENT_TOOL_DEFS ─────────────────────────────────────────────

describe('AGENT_TOOL_DEFS', () => {
  it('contains exactly 15 tool definitions', () => {
    // Phase 13 v2.4.0: delegate_task added as a builtin.
    expect(AGENT_TOOL_DEFS).toHaveLength(15)
  })

  const expectedTools = [
    'web_search',
    'web_fetch',
    'file_read',
    'file_write',
    'file_list',
    'file_search',
    'code_execute',
    'shell_execute',
    'image_generate',
    'run_workflow',
    'screenshot',
    'process_list',
    'system_info',
    'get_current_time',
  ]

  it.each(expectedTools)('includes the "%s" tool', (name) => {
    const tool = AGENT_TOOL_DEFS.find((t) => t.name === name)
    expect(tool).toBeDefined()
  })

  it('every tool has name, description, parameters, and permission', () => {
    for (const tool of AGENT_TOOL_DEFS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.parameters).toBeDefined()
      expect(tool.parameters.type).toBe('object')
      expect(tool.parameters.properties).toBeDefined()
      expect(Array.isArray(tool.parameters.required)).toBe(true)
      expect(['auto', 'confirm']).toContain(tool.permission)
    }
  })

  it('auto-permission tools are get_current_time, process_list, system_info, web_fetch, web_search', () => {
    const autoTools = AGENT_TOOL_DEFS.filter((t) => t.permission === 'auto')
    const autoNames = autoTools.map((t) => t.name).sort()
    expect(autoNames).toEqual(['get_current_time', 'process_list', 'system_info', 'web_fetch', 'web_search'])
  })

  it('confirm-permission tools include file ops, code, shell, image, workflow, screenshot, delegate_task', () => {
    const confirmTools = AGENT_TOOL_DEFS.filter((t) => t.permission === 'confirm')
    const confirmNames = confirmTools.map((t) => t.name).sort()
    // Phase 13 v2.4.0: delegate_task added under workflow category (confirm default).
    expect(confirmNames).toEqual([
      'code_execute', 'delegate_task', 'file_list', 'file_read', 'file_search',
      'file_write', 'image_generate', 'run_workflow', 'screenshot', 'shell_execute',
    ])
  })
})

// ── getOllamaTools ──────────────────────────────────────────────

describe('getOllamaTools', () => {
  it('returns same number of tools as AGENT_TOOL_DEFS', () => {
    const ollamaTools = getOllamaTools()
    expect(ollamaTools).toHaveLength(AGENT_TOOL_DEFS.length)
  })

  it('each tool has type "function" at the top level', () => {
    const ollamaTools = getOllamaTools()
    for (const tool of ollamaTools) {
      expect(tool.type).toBe('function')
    }
  })

  it('each tool has function.name, function.description, function.parameters', () => {
    const ollamaTools = getOllamaTools()
    for (const tool of ollamaTools) {
      expect(tool.function).toBeDefined()
      expect(tool.function.name).toBeTruthy()
      expect(tool.function.description).toBeTruthy()
      expect(tool.function.parameters).toBeDefined()
    }
  })

  it('preserves tool names from AGENT_TOOL_DEFS', () => {
    const ollamaTools = getOllamaTools()
    const ollamaNames = ollamaTools.map((t) => t.function.name).sort()
    const defNames = AGENT_TOOL_DEFS.map((t) => t.name).sort()
    expect(ollamaNames).toEqual(defNames)
  })

  it('does not include permission field (Ollama format excludes it)', () => {
    const ollamaTools = getOllamaTools()
    for (const tool of ollamaTools) {
      // The permission field should not leak into the Ollama format
      expect((tool as any).permission).toBeUndefined()
      expect((tool.function as any).permission).toBeUndefined()
    }
  })
})

// ── getToolByName ───────────────────────────────────────────────

describe('getToolByName', () => {
  it('returns the correct tool definition for a known name', () => {
    const tool = getToolByName('web_search')
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('web_search')
    expect(tool!.description).toBeTruthy()
  })

  it('returns undefined for an unknown name', () => {
    expect(getToolByName('nonexistent_tool')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(getToolByName('')).toBeUndefined()
  })

  it('is case-sensitive', () => {
    expect(getToolByName('Web_Search')).toBeUndefined()
    expect(getToolByName('WEB_SEARCH')).toBeUndefined()
  })
})

// ── getToolPermission ───────────────────────────────────────────

describe('getToolPermission', () => {
  it('returns "auto" for auto-permission tools', () => {
    expect(getToolPermission('web_search')).toBe('auto')
    expect(getToolPermission('web_fetch')).toBe('auto')
    expect(getToolPermission('process_list')).toBe('auto')
    expect(getToolPermission('system_info')).toBe('auto')
  })

  it('returns "confirm" for confirm-permission tools', () => {
    expect(getToolPermission('file_read')).toBe('confirm')
    expect(getToolPermission('file_write')).toBe('confirm')
    expect(getToolPermission('code_execute')).toBe('confirm')
    expect(getToolPermission('image_generate')).toBe('confirm')
    expect(getToolPermission('shell_execute')).toBe('confirm')
  })

  it('defaults to "confirm" for unknown tools', () => {
    expect(getToolPermission('unknown_tool')).toBe('confirm')
    expect(getToolPermission('')).toBe('confirm')
  })
})
