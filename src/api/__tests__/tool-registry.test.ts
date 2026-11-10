import { describe, it, expect } from 'vitest'
import { BROWSER_TOOL_NAMES, browserExistsHere } from '../../lib/browser-tools'
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
  it('contains exactly 23 tool definitions', () => {
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
    //
    // 3.0.8 (A11): +2, get_settings und set_setting. Sie stehen in keinem
    // Prompt, der nicht nach Einstellungen fragt: im Chat und in Agent nur
    // ueber SETTINGS_KEYWORDS, in Code hinter dem Tor (GATE_KEYWORDS).
    //
    // 3.1.0 (P-L): +1, web_research. Es ersetzt fuer kleine Modelle das Paar
    // web_search+web_fetch in einem Aufruf (lib/tool-selection.ts). Dazu die
    // fuenf Werkzeuge des LU-Browsers, nur auf macOS und Windows registriert.
    // 3.1.0 (C60): +5, set_settings, lu_models, lu_service, lu_download und
    // lu_open_settings. LU bedient sich selbst; eine Aktion (Modell, Dienst,
    // Download) hat Nebenwirkungen und eine eigene Karte und passt deshalb
    // nicht in set_setting. Alle fuenf stehen hinter demselben Tor wie
    // get_settings und fahren nur auf einer Nachricht ueber LU selbst mit.
    // 3.1.0 (C60-S5): +4 (zusammen mit C60: 28, mit P-L 29 plus Browser), workflow_find/_inspect/_install/_assign. Kein
    // vorhandenes Werkzeug passt: run_workflow startet LUs eigene Ablaeufe,
    // set_setting aendert Werte, das hier holt fremde Dateien mit Ampel und
    // Karte. Sie fahren nur auf einer Nachricht ueber einen Workflow mit
    // (WORKFLOW_GATE_WORDS), nie im Plain Chat, nie im Unteragenten.
    // C59 A6–A8: +4, memory, skill_view, skill_save, session_search. Keines
    // passt in ein vorhandenes: sie schreiben bzw. lesen LUs eigene Speicher
    // (Gedaechtnis, Skills, Chats), nicht den Arbeitsordner. Im Katalog fahren
    // sie nur mit, wenn sie gefragt sind: memory und session_search ueber ihre
    // Woerter (TOOL_GROUPS, GATE_KEYWORDS), die Skill-Werkzeuge ueber
    // withSkillTools, wenn es Skills gibt bzw. ein grosses Modell vorschlagen darf.
    expect(AGENT_TOOL_DEFS).toHaveLength(33 + (browserExistsHere() ? BROWSER_TOOL_NAMES.length : 0))
  })

  const expectedTools = [
    'check_tasks',
    'message_agent',
    'todo_write',
    'web_search',
    'web_research',
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
    // 3.0.8 (A11): get_settings liest nur, set_setting fragt mit seiner
    // eigenen Karte (alt -> neu), auch im Bypass. Eine zweite Rueckfrage
    // davor fragte doppelt, wie bei create_order.
    // 3.1.0 (P-L): web_research and the browser read only, like web_fetch.
    // 3.1.0 (C60): die fuenf Selbststeuerungswerkzeuge aus demselben Grund
    // wie set_setting: jede Aenderung fragt mit ihrer eigenen Karte.
    // C59 A6–A8: memory schreibt nur LUs Gedaechtnis (sichtbarer Hinweis im
    // Lauf, Geheimnisse abgelehnt), skill_save legt nur einen Vorschlag ab,
    // den allein der Nutzer in den Einstellungen speichert, skill_view und
    // session_search lesen nur.
    expect(autoNames).toEqual([
      ...(browserExistsHere() ? [...BROWSER_TOOL_NAMES] : []),
      'check_tasks', 'get_settings', 'lu_download', 'lu_models', 'lu_open_settings', 'lu_service', 'memory', 'message_agent',
      'session_search', 'set_setting', 'set_settings', 'skill_save', 'skill_view', 'todo_write', 'web_fetch', 'web_research', 'web_search',
      'workflow_assign', 'workflow_find', 'workflow_inspect', 'workflow_install',
    ].sort())
  })

  it('confirm-permission tools include file ops, code, shell, image, workflow, screenshot, delegate_task, sprint A/B/C tools', () => {
    const confirmTools = AGENT_TOOL_DEFS.filter((t) => t.permission === 'confirm')
    const confirmNames = confirmTools.map((t) => t.name).sort()
    // Phase 13 v2.4.0: delegate_task added under workflow category (confirm default).
    // v2.5.0 sprint A/B/C from the web app: codex tools default to confirm (writes,
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
