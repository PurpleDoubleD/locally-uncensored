/**
 * Point 3 of the mobile groundwork: on a phone the shell, code, screenshot,
 * process, git and local image/video tools do not exist. Not in the catalog,
 * not through an old name, not in the sub agent, not in the prompts.
 *
 * The audit (section 3.3) found no central filter: toolRegistry.getAll() is
 * read in ten places with ten different filters, and the sub agent offered
 * everything. The one place that covers all of them is the registration, and
 * the redirect for retired names is the back door that a catalog-only filter
 * leaves open.
 *
 * Every phone assertion has a desktop twin.
 *
 * Run: npx vitest run src/api/mcp/__tests__/mobile-tool-filter.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DESKTOPS, HANDHELDS, standOn } from '../../../test-support/devices'
import { ToolRegistry } from '../tool-registry'
import { registerBuiltinTools, RETIRED_TOOL_NAMES } from '../builtin-tools'
import { DEFAULT_PERMISSIONS, defaultPermissionsForDevice } from '../types'
import {
  MOBILE_REMOVED_TOOLS, localMediaToolsExist, workflowsForThisDevice,
} from '../../../lib/mobile-tools'
import { AGENT_COMMANDS, matchAgentCommands, parseAgentCommand } from '../../../lib/agent-commands'
import { BUILT_IN_WORKFLOWS } from '../../../lib/built-in-workflows'
import { renderToolRoster } from '../../../lib/tool-roster'
import { resolveWorkspace } from '../../agents/workspace-resolve'
import { useAgentModeStore } from '../../../stores/agentModeStore'
import {
  buildAgentSystemPrompt, buildAgentSystemPromptLean, buildChatToolsSystemPrompt,
} from '../../../hooks/useAgentChat'
import type { AgentWorkflow } from '../../../types/agent-workflows'

const src = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function registryHere(): ToolRegistry {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry)
  return registry
}

const GONE = ['shell_execute', 'pr_resume', 'screenshot', 'image_generate', 'video_generate']
/** The settings tools of A11 (3.0.8): desktop only, see MOBILE_UNBUILT_TOOLS. */
const SETTINGS = ['get_settings', 'set_setting']
const STAYS = [
  'todo_write', 'web_search', 'web_fetch', 'file_read', 'file_write', 'file_edit', 'file_list',
  'file_search', 'run_workflow', 'delegate_task', 'check_tasks', 'message_agent',
]
const DESKTOP_WORDS = /this computer|shell_execute|image_generate|video_generate|PowerShell|drive letter|uname|Get-ComputerInfo|ComfyUI|Finder/

afterEach(() => { vi.unstubAllGlobals() })

describe('the catalog on a phone', () => {
  for (const device of HANDHELDS) {
    it(`${device}: shell, screenshot and local media tools are not registered`, () => {
      standOn(device)
      const names = registryHere().getAll().map((t) => t.name)
      for (const name of [...GONE, ...SETTINGS]) expect(names).not.toContain(name)
      expect(names.sort()).toEqual([...STAYS].sort())
    })
  }

  it('what the sub agent offers is what is registered, so it offers none of them either', () => {
    // api/agents/sub-agent.ts builds its tool list from toolRegistry.getAll()
    // minus delegate_task and the settings tools (A11), and applies no device
    // filter of its own.
    standOn('android')
    const offered = registryHere().getAll().map((t) => t.name).filter((n) => n !== 'delegate_task')
    for (const name of GONE) expect(offered).not.toContain(name)
    expect(src('api/agents/sub-agent.ts')).toMatch(/toolRegistry\s*\.getAll\(\)\s*(\/\/[^\n]*\s*)?\.filter\(\(t\) => t\.name !== DELEGATE_TASK_TOOL_DEF\.name && !isSettingsToolName\(t\.name\)\)/)
  })

  it('the old names are no back door: all but the clock are unknown', async () => {
    standOn('iphone')
    const registry = registryHere()
    for (const name of RETIRED_TOOL_NAMES) {
      if (name === 'get_current_time') continue
      expect(registry.resolveExecutable(name), name).toBeUndefined()
      expect(await registry.execute(name, { command: 'id' }), name).toBe(`Error: Unknown tool "${name}"`)
    }
    expect(registry.resolveExecutable('get_current_time')).toEqual({ name: 'get_current_time' })
    expect(await registry.execute('get_current_time', {})).not.toMatch(/Unknown tool/)
    // And the removed catalog names themselves.
    for (const name of GONE) {
      expect(registry.resolveExecutable(name)).toBeUndefined()
      expect(await registry.execute(name, {})).toBe(`Error: Unknown tool "${name}"`)
    }
  })

  it('the descriptions of the tools that stay name the working folder, not absolute paths', () => {
    standOn('android')
    const registry = registryHere()
    for (const name of ['file_read', 'file_write', 'file_list']) {
      const tool = registry.getToolByName(name)!
      expect(tool.description, name).toMatch(/working folder/)
      expect(tool.description, name).not.toMatch(/absolute|home or drive/)
      expect(JSON.stringify(tool.inputSchema), name).not.toMatch(/absolute preferred/)
    }
    expect(registry.getToolByName('run_workflow')!.description).not.toMatch(/Code Review/)
    // The roster in the prompt is rendered from these, so it is clean as well.
    expect(renderToolRoster(registry.getAll())).not.toMatch(DESKTOP_WORDS)
  })
})

describe('the catalog on a desktop is what it was', () => {
  for (const device of DESKTOPS) {
    it(`${device}: all nineteen tools, the old names redirect`, () => {
      standOn(device)
      const registry = registryHere()
      const names = registry.getAll().map((t) => t.name)
      expect(names.sort()).toEqual([...STAYS, ...GONE, ...SETTINGS].sort())
      for (const name of RETIRED_TOOL_NAMES) {
        expect(registry.resolveExecutable(name), name).toEqual({ name })
      }
      expect(registry.getToolByName('file_read')!.description).toMatch(/PREFER absolute paths/)
      expect(registry.getToolByName('run_workflow')!.description).toMatch(/Code Review/)
    })
  }

  it('the removed set is exactly the five the audit named', () => {
    expect([...MOBILE_REMOVED_TOOLS].sort()).toEqual([...GONE].sort())
  })
})

describe('slash commands and workflows', () => {
  it('phone: the menu offers compact, goal and loop, the rest is plain text', () => {
    standOn('android')
    expect(matchAgentCommands('/').map((c) => c.name).sort()).toEqual(['compact', 'goal', 'loop'])
    expect(matchAgentCommands('/', 'chat').map((c) => c.name)).toEqual(['compact'])
    expect(parseAgentCommand('/commit fix it')).toBeNull()
    expect(parseAgentCommand('/test')).toBeNull()
    expect(parseAgentCommand('/loop 30s tidy the notes')?.command.name).toBe('loop')
  })

  it('phone: the loop instruction does not send the model to run tests or a build', () => {
    standOn('iphone')
    const text = parseAgentCommand('/loop tidy the notes')!.expanded
    expect(text).not.toMatch(/run the tests|the build|the command/)
    expect(text).toMatch(/read the result back/)
  })

  it('desktop: every command is offered and the loop text is unchanged', () => {
    standOn('windows')
    expect(matchAgentCommands('/').length).toBe(AGENT_COMMANDS.length)
    expect(parseAgentCommand('/commit')?.command.name).toBe('commit')
    expect(parseAgentCommand('/loop x')!.expanded).toContain(
      '2) VERIFY it — run the tests, the build, the command, whatever actually proves it. Reading your own change back is not verification.',
    )
  })

  it('phone: Code Review is not offered, a user workflow with a shell step is not either', () => {
    standOn('android')
    const own = (id: string, toolName?: string): AgentWorkflow => ({
      id, name: id, description: '', icon: 'X', isBuiltIn: false, createdAt: 1, updatedAt: 1, variables: {},
      steps: [{ id: 's', type: toolName ? 'tool' : 'prompt', label: 's', toolName }],
    } as unknown as AgentWorkflow)
    const all = [...BUILT_IN_WORKFLOWS, own('mine-web', 'web_fetch'), own('mine-shell', 'shell_execute'), own('mine-git', 'git_status'), own('mine-prompt')]
    expect(workflowsForThisDevice(all).map((w) => w.id)).toEqual([
      'builtin-research-topic', 'builtin-summarize-url', 'mine-web', 'mine-prompt',
    ])
    standOn('linux')
    expect(workflowsForThisDevice(all)).toHaveLength(all.length)
  })

  it('run_workflow and the chat trigger look workflows up through the device list', () => {
    expect(src('api/mcp/builtin-tools.ts')).toContain('const offered = workflowsForThisDevice(useAgentWorkflowStore.getState().workflows)')
    expect(src('hooks/useAgentChat.ts')).toContain('workflowsForThisDevice(useAgentWorkflowStore.getState().workflows)')
  })
})

describe('the prompt builders', () => {
  const roster = '- web_search: search\n- file_write: write'

  for (const device of HANDHELDS) {
    it(`${device}: no computer, no shell, no media tools, no dashes`, () => {
      standOn(device)
      for (const prompt of [
        buildAgentSystemPrompt('', roster),
        buildAgentSystemPromptLean('', 'file_read, file_write'),
        buildChatToolsSystemPrompt(''),
      ]) {
        expect(prompt).not.toMatch(DESKTOP_WORDS)
        expect(prompt).toMatch(/phone or tablet|Create in this app/)
        expect(prompt).not.toMatch(/[\u2013\u2014]/)
      }
      expect(buildAgentSystemPrompt('', roster)).toContain(roster)
      expect(buildAgentSystemPrompt('BASE', roster).endsWith('\n\nBASE')).toBe(true)
      expect(buildAgentSystemPrompt('', roster)).toMatch(/working folder/)
    })
  }

  // The three hashes were taken from the builders at 0448401e, the commit
  // before the mobile groundwork, and are identical to today's desktop output.
  it('desktop: the three prompts are byte for byte the ones from before this change', () => {
    standOn('windows')
    expect(sha(buildAgentSystemPrompt('BASE', roster))).toBe('77aaeb9e2b171556fec07ba6e45ac202f5a5ed971ac77286ce512ba8ffb8b4db')
    expect(sha(buildAgentSystemPromptLean('BASE', 'file_read, file_write'))).toBe('28489a4807fe126dbef27f057b0414996a7618ca58d3c822cd51f7e6796184fd')
    expect(sha(buildChatToolsSystemPrompt('BASE'))).toBe('926d2c3e5a07a832f89af62d849248c3e4c01baa5ae73031ca7fdf257a4dc498')
    expect(buildAgentSystemPrompt('', roster)).toContain('with full access to this computer')
    expect(buildChatToolsSystemPrompt('')).toContain('- image_generate, create an image')
  })
})

describe('media, permissions and the working folder', () => {
  it('the local media tools exist on a desktop only', () => {
    standOn('android'); expect(localMediaToolsExist()).toBe(false)
    standOn('iphone'); expect(localMediaToolsExist()).toBe(false)
    standOn('mac'); expect(localMediaToolsExist()).toBe(true)
    standOn('windows'); expect(localMediaToolsExist()).toBe(true)
  })

  it('chat tools and the media synthesis ask that question', () => {
    expect(src('hooks/useChat.ts')).toContain("const cloudMode = settings.appMode === 'cloud' || !localMediaToolsExist()")
    expect(src('hooks/useAgentChat.ts')).toMatch(/settings\.appMode !== 'cloud' &&\s*localMediaToolsExist\(\) &&/)
  })

  it('phone: terminal, desktop, image and video start blocked', () => {
    standOn('android')
    expect(defaultPermissionsForDevice()).toEqual({
      ...DEFAULT_PERMISSIONS, terminal: 'blocked', desktop: 'blocked', image: 'blocked', video: 'blocked',
    })
  })

  it('desktop: the defaults are the old ones, value for value', () => {
    standOn('mac')
    expect(defaultPermissionsForDevice()).toEqual(DEFAULT_PERMISSIONS)
    expect(DEFAULT_PERMISSIONS).toEqual({
      filesystem: 'confirm', terminal: 'confirm', desktop: 'confirm', web: 'auto',
      system: 'auto', image: 'confirm', video: 'confirm', workflow: 'confirm', mcp: 'confirm',
    })
  })

  it('phone: the working folder is always the sandbox, a folder pick is never stored', () => {
    standOn('iphone')
    const folder = { kind: 'folder' as const, path: '/Users/x/project' }
    expect(resolveWorkspace({ perChat: folder, defaultWorkspace: folder })).toBeNull()
    useAgentModeStore.setState({ workspaces: {}, lastFolder: undefined })
    useAgentModeStore.getState().setWorkspace('c1', folder)
    expect(useAgentModeStore.getState().workspaces).toEqual({})
    expect(useAgentModeStore.getState().lastFolder).toBeUndefined()
  })

  it('desktop: a picked folder is resolved and remembered as before', () => {
    standOn('windows')
    const folder = { kind: 'folder' as const, path: 'C:/work/project' }
    expect(resolveWorkspace({ perChat: folder, defaultWorkspace: null })).toEqual(folder)
    useAgentModeStore.setState({ workspaces: {}, lastFolder: undefined })
    useAgentModeStore.getState().setWorkspace('c1', folder)
    expect(useAgentModeStore.getState().workspaces.c1).toEqual(folder)
    expect(useAgentModeStore.getState().lastFolder).toBe('C:/work/project')
  })
})
