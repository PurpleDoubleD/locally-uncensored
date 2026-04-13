/**
 * Tool Selection Tests
 *
 * Tests selectRelevantTools() from tool-selection.ts:
 * - Keyword-based tool group matching
 * - ALWAYS_INCLUDE tools are always present
 * - Permission filtering (blocked categories)
 * - Fallback behavior for generic messages
 *
 * Run: npx vitest run src/lib/__tests__/tool-selection.test.ts
 */
import { describe, it, expect } from 'vitest'
import { selectRelevantTools } from '../tool-selection'
import type { MCPToolDefinition, ToolCategory, PermissionMap } from '../../api/mcp/types'

// ── Helpers ────────────────────────────────────────────────────

function makeTool(name: string, category: ToolCategory): MCPToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
    category,
    source: 'builtin' as const,
  }
}

const ALL_TOOLS: MCPToolDefinition[] = [
  makeTool('web_search', 'web'),
  makeTool('web_fetch', 'web'),
  makeTool('file_read', 'filesystem'),
  makeTool('file_write', 'filesystem'),
  makeTool('file_list', 'filesystem'),
  makeTool('file_search', 'filesystem'),
  makeTool('shell_execute', 'terminal'),
  makeTool('code_execute', 'terminal'),
  makeTool('system_info', 'system'),
  makeTool('process_list', 'system'),
  makeTool('screenshot', 'desktop'),
  makeTool('image_generate', 'image'),
  makeTool('run_workflow', 'workflow'),
]

const ALL_ALLOWED: PermissionMap = {
  filesystem: 'auto',
  terminal: 'auto',
  desktop: 'auto',
  web: 'auto',
  system: 'auto',
  image: 'auto',
  video: 'auto' as any,
  workflow: 'auto',
}

function toolNames(tools: MCPToolDefinition[]): string[] {
  return tools.map(t => t.name).sort()
}

describe('tool-selection', () => {
  // ── ALWAYS_INCLUDE ───────────────────────────────────────────

  describe('ALWAYS_INCLUDE tools', () => {
    it('always includes file_read and file_write', () => {
      const result = selectRelevantTools('search the web for news', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('file_read')
      expect(names).toContain('file_write')
    })

    it('includes file_read and file_write even for empty message', () => {
      const result = selectRelevantTools('', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('file_read')
      expect(names).toContain('file_write')
    })
  })

  // ── selectRelevantTools ──────────────────────────────────────

  describe('selectRelevantTools', () => {
    it('selects web tools for search-related keywords', () => {
      const result = selectRelevantTools('search for the latest news about AI', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('web_search')
      expect(names).toContain('web_fetch')
    })

    it('selects web tools for "google" keyword', () => {
      const result = selectRelevantTools('can you google this for me', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('web_search')
    })

    it('selects web tools for "internet" keyword', () => {
      const result = selectRelevantTools('find this on the internet', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('web_search')
    })

    it('selects file_read for "read" keyword', () => {
      const result = selectRelevantTools('read the config file', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('file_read')
    })

    it('selects file_write for "create" keyword', () => {
      const result = selectRelevantTools('create a new file called test.js', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('file_write')
    })

    it('selects file_list for "directory" keyword', () => {
      const result = selectRelevantTools('list the directory contents', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('file_list')
    })

    it('selects file_list for "ls" keyword', () => {
      const result = selectRelevantTools('run ls in the current folder', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('file_list')
    })

    it('selects file_search for "grep" keyword', () => {
      const result = selectRelevantTools('grep for the error message', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('file_search')
    })

    it('selects shell/code tools for "run" keyword', () => {
      const result = selectRelevantTools('run npm install', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('shell_execute')
      expect(names).toContain('code_execute')
    })

    it('selects shell/code tools for "git" keyword', () => {
      const result = selectRelevantTools('check the git status', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('shell_execute')
    })

    it('selects shell/code tools for "python" keyword', () => {
      const result = selectRelevantTools('run this python script', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('shell_execute')
      expect(names).toContain('code_execute')
    })

    it('selects system tools for "cpu" keyword', () => {
      const result = selectRelevantTools('how much cpu am I using', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('system_info')
      expect(names).toContain('process_list')
    })

    it('selects system tools for "memory" keyword', () => {
      const result = selectRelevantTools('check memory usage', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('system_info')
    })

    it('selects screenshot tool for "screenshot" keyword', () => {
      const result = selectRelevantTools('take a screenshot of my desktop', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('screenshot')
    })

    it('selects image_generate for "generate image" keyword', () => {
      const result = selectRelevantTools('generate image of a sunset', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('image_generate')
    })

    it('selects run_workflow for "workflow" keyword', () => {
      const result = selectRelevantTools('run workflow for deployment', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('run_workflow')
    })

    it('matches keywords case-insensitively', () => {
      const result = selectRelevantTools('SEARCH the WEB for NEWS', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('web_search')
    })

    it('matches multiple tool groups from one message', () => {
      const result = selectRelevantTools('search the web and take a screenshot', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      expect(names).toContain('web_search')
      expect(names).toContain('screenshot')
    })
  })

  // ── Fallback behavior ────────────────────────────────────────

  describe('fallback for generic messages', () => {
    it('adds common tools when few keywords match (generic message)', () => {
      // "hello" matches no keywords, so only ALWAYS_INCLUDE (2 tools) + <= 3 threshold
      const result = selectRelevantTools('hello there', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      // Should include fallback tools: shell_execute, file_list, file_search, web_search
      expect(names).toContain('shell_execute')
      expect(names).toContain('file_list')
      expect(names).toContain('file_search')
      expect(names).toContain('web_search')
    })

    it('returns all available tools if nothing matches at all', () => {
      // Empty tools array: nothing can match, falls through to safety return
      const result = selectRelevantTools('hello', [], ALL_ALLOWED)
      expect(result).toEqual([])
    })

    it('does not add fallback tools when enough keywords match', () => {
      // "search the web and take a screenshot" matches web + screenshot groups = 4+ tools
      const result = selectRelevantTools('search the web and take a screenshot and run npm test', ALL_TOOLS, ALL_ALLOWED)
      const names = toolNames(result)
      // Has more than 3 selected tools, so no generic fallback
      expect(names).toContain('web_search')
      expect(names).toContain('screenshot')
      expect(names).toContain('shell_execute')
    })
  })

  // ── Permission filtering ─────────────────────────────────────

  describe('permission filtering', () => {
    it('excludes tools from blocked categories', () => {
      const permissions: PermissionMap = {
        ...ALL_ALLOWED,
        web: 'blocked',
      }
      const result = selectRelevantTools('search the internet for news', ALL_TOOLS, permissions)
      const names = toolNames(result)
      expect(names).not.toContain('web_search')
      expect(names).not.toContain('web_fetch')
    })

    it('excludes filesystem tools when filesystem is blocked', () => {
      const permissions: PermissionMap = {
        ...ALL_ALLOWED,
        filesystem: 'blocked',
      }
      const result = selectRelevantTools('read the file', ALL_TOOLS, permissions)
      const names = toolNames(result)
      expect(names).not.toContain('file_read')
      expect(names).not.toContain('file_write')
      expect(names).not.toContain('file_list')
    })

    it('allows tools from confirm categories (not blocked)', () => {
      const permissions: PermissionMap = {
        ...ALL_ALLOWED,
        terminal: 'confirm',
      }
      const result = selectRelevantTools('run npm install', ALL_TOOLS, permissions)
      const names = toolNames(result)
      expect(names).toContain('shell_execute')
    })

    it('returns all available if all selected tools are blocked', () => {
      // Block everything except system
      const permissions: PermissionMap = {
        filesystem: 'blocked',
        terminal: 'blocked',
        desktop: 'blocked',
        web: 'blocked',
        system: 'auto',
        image: 'blocked',
        video: 'blocked' as any,
        workflow: 'blocked',
      }
      // Message that matches web tools (blocked) and filesystem (blocked)
      const result = selectRelevantTools('search and read', ALL_TOOLS, permissions)
      // All selected tools blocked -> returns all available (system_info + process_list)
      const names = toolNames(result)
      expect(names).toContain('system_info')
      expect(names).toContain('process_list')
    })
  })
})
