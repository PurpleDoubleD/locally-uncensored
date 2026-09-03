import { describe, it, expect } from 'vitest'
import {
  AGENT_TOOL_DEFS,
  getOllamaTools,
  getToolByName,
  getToolPermission,
} from '../tool-registry'
import { toolRegistry, DEFAULT_PERMISSIONS } from '../mcp'

// Tools whose category is BLOCKED by default are intentionally dropped from
// getOllamaTools (it passes DEFAULT_PERMISSIONS, which excludes blocked
// categories). video_generate is OFF by default as of v2.5.0-polish
// (2026-06-04), so it must not be offered to the model.
const blockedByDefaultNames = new Set(
  toolRegistry
    .getAll()
    .filter((t) => DEFAULT_PERMISSIONS[t.category] === 'blocked')
    .map((t) => t.name),
)
const offeredDefNames = AGENT_TOOL_DEFS
  .map((t) => t.name)
  .filter((n) => !blockedByDefaultNames.has(n))
  .sort()

// ── AGENT_TOOL_DEFS ─────────────────────────────────────────────

describe('AGENT_TOOL_DEFS', () => {
  it('contains exactly 17 tool definitions', () => {
    // 2.6.6 tool merge (plan section E): the twelve typed shell wrappers,
    // system_info, process_list and get_current_time folded into
    // shell_execute plus the environment block in the system prompt, so the
    // catalog went from 31 definitions to 15. The old names still execute
    // via the retired-name redirect in mcp/builtin-tools.ts.
    //
    // 2.6.8: +2 fuer die Hintergrundagenten (check_tasks, message_agent).
    // Diese Zahl steigt absichtlich schwer — jedes weitere Werkzeug ist
    // Katalogtext in JEDEM Prompt und eine Wahl mehr, die ein kleines Modell
    // treffen muss. Wer hier hochzaehlt, soll begruenden, warum sein Fall
    // nicht in ein vorhandenes Werkzeug passt.
    expect(AGENT_TOOL_DEFS).toHaveLength(17)
  })

  const expectedTools = [
    'check_tasks',
    'message_agent',
    'todo_write',
    'web_search',
    'web_fetch',
    'file_read',
    'file_write',
    'file_edit',
    'file_list',
    'file_search',
    'shell_execute',
    'pr_resume',
    'image_generate',
    'video_generate',
    'run_workflow',
    'screenshot',
    'delegate_task',
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

  it('auto-permission tools are the read-only probes plus todo_write', () => {
    const autoTools = AGENT_TOOL_DEFS.filter((t) => t.permission === 'auto')
    const autoNames = autoTools.map((t) => t.name).sort()
    // todo_write is category 'system' (auto) because it only writes the plan
    // shown in the UI. Prompting for approval to write a to-do list would make
    // the feature useless on a long unattended run.
    // 2.6.8: check_tasks und message_agent aus demselben Grund wie todo_write.
    // Beide bewegen nur App-Zustand, den der Agent selbst erzeugt hat; das
    // Werkzeug, das wirklich etwas STARTET, ist delegate_task, und das bleibt
    // unter 'confirm'. Eine Rueckfrage fuer "zaehl deine eigenen Aufgaben auf"
    // waere Zeremonie, und Zeremonie stumpft die echten Rueckfragen ab.
    expect(autoNames).toEqual([
      'check_tasks', 'message_agent', 'todo_write', 'web_fetch', 'web_search',
    ])
  })

  it('confirm-permission tools include file ops, code, shell, image, workflow, screenshot, delegate_task, sprint A/B/C tools', () => {
    const confirmTools = AGENT_TOOL_DEFS.filter((t) => t.permission === 'confirm')
    const confirmNames = confirmTools.map((t) => t.name).sort()
    // Phase 13 v2.4.0: delegate_task added under workflow category (confirm default).
    // v2.5.0 sprint A/B/C from uselu: codex tools default to confirm (writes,
    // shell, git, gh, project_init, run_tests — all touch the user's machine).
    // v2.5.0 Feature EE: video_generate (image category → confirm default).
    expect(confirmNames).toEqual([
      'delegate_task',
      'file_edit', 'file_list', 'file_read', 'file_search',
      'file_write', 'image_generate', 'pr_resume',
      'run_workflow', 'screenshot', 'shell_execute',
      'video_generate',
    ])
  })
})

// ── getOllamaTools ──────────────────────────────────────────────

describe('getOllamaTools', () => {
  it('returns one tool per NON-blocked AGENT_TOOL_DEFS entry', () => {
    const ollamaTools = getOllamaTools()
    // getOllamaTools filters out default-blocked categories (video), so it
    // returns AGENT_TOOL_DEFS minus those.
    expect(ollamaTools).toHaveLength(AGENT_TOOL_DEFS.length - blockedByDefaultNames.size)
  })

  it('includes video_generate (live since v2.5.3) alongside image_generate', () => {
    const names = getOllamaTools().map((t) => t.function.name)
    expect(blockedByDefaultNames.has('video_generate')).toBe(false)
    expect(names).toContain('video_generate')
    expect(names).toContain('image_generate')
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

  it('preserves (non-blocked) tool names from AGENT_TOOL_DEFS', () => {
    const ollamaTools = getOllamaTools()
    const ollamaNames = ollamaTools.map((t) => t.function.name).sort()
    expect(ollamaNames).toEqual(offeredDefNames)
  })

  it('does not include permission field (Ollama format excludes it)', () => {
    const ollamaTools = getOllamaTools()
    for (const tool of ollamaTools) {
      // The permission field should not leak into the Ollama format.
      // `in` statt `(tool as any).permission === undefined`: der Cast hat die
      // Frage "gibt es den Schluessel" in "ist der Wert undefined" verwandelt,
      // und ein durchgereichtes `permission: undefined` waere gruen gewesen.
      expect('permission' in tool).toBe(false)
      expect('permission' in tool.function).toBe(false)
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
    expect(getToolPermission('todo_write')).toBe('auto')
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
