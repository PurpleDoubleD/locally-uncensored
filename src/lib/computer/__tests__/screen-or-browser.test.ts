/**
 * Computer Control on: the model gets the screen tools, and the word
 * "browser" no longer sends it to LU's own browser window.
 *
 * Run: npx vitest run src/lib/computer/__tests__/screen-or-browser.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { MCPToolDefinition, PermissionMap } from '../../../api/mcp/types'
import { selectRelevantTools, applyMaxTools } from '../../tool-selection'
import { browserStepsAside, isLuBrowserTool, namesTheLuBrowser, withScreenTools } from '../screen-or-browser'

const tool = (name: string, category = 'filesystem'): MCPToolDefinition => ({
  name, description: name, inputSchema: { type: 'object', properties: {} }, category, source: 'builtin',
} as MCPToolDefinition)
const catalog = [
  ...['file_read', 'file_write', 'file_edit', 'todo_write', 'file_list', 'file_search', 'shell_execute', 'web_research', 'web_fetch'].map((n) => tool(n)),
  ...['browser_open', 'browser_scroll', 'browser_click_link'].map((n) => tool(n, 'web')),
  tool('computer_task', 'desktop'),
]
const open = {} as PermissionMap
const route = (message: string, permissions = open) => {
  const allowed = catalog.filter((t) => !(browserStepsAside(message, true) && isLuBrowserTool(t.name)))
  return withScreenTools(selectRelevantTools(message, allowed, permissions), allowed, permissions).map((t) => t.name)
}

describe('Computer Control and the LU browser', () => {
  it.each([
    'open my browser and go to youtube',
    'control my pc and open the browser',
    'öffne den browser und such nach katzen',
    'click the save button in notepad',
    'steuere meinen pc',
  ])('"%s" gets the screen tool and no LU browser', (message) => {
    const names = route(message)
    expect(names).toContain('computer_task')
    expect(names.filter(isLuBrowserTool)).toEqual([])
  })

  it('the LU browser stays reachable when the user names it', () => {
    expect(namesTheLuBrowser('open this in the LU browser')).toBe(true)
    expect(namesTheLuBrowser('nimm den LU-Browser')).toBe(true)
    expect(namesTheLuBrowser('open my browser')).toBe(false)
    expect(route('open example.com in the LU browser')).toContain('browser_open')
  })

  it('with the switch off nothing changes', () => {
    expect(browserStepsAside('open my browser', false)).toBe(false)
  })

  it('a blocked permission keeps the screen tool out', () => {
    const blocked = { desktop: 'blocked' } as unknown as PermissionMap
    expect(withScreenTools([tool('file_read')], catalog, blocked).map((t) => t.name)).toEqual(['file_read'])
  })

  it('survives the small-model cap', () => {
    const capped = applyMaxTools(catalog, 6)
    expect(capped.map((t) => t.name)).not.toContain('computer_task')
    expect(withScreenTools(capped, catalog, open).map((t) => t.name)).toContain('computer_task')
  })

  it('the agent loop filters list and execution through the same check', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../../../hooks/useAgentChat.ts'), 'utf8')
    const check = source.slice(source.indexOf('const toolMatchesCurated'), source.indexOf('const createLive'))
    expect(check).toContain('browserAside && isLuBrowserTool(name)')
    expect(source).toContain('toolMatchesCurated(name) ? toolRegistry.resolveExecutable(name)')
    expect(source).toContain('withScreenTools(routed')
  })
})
