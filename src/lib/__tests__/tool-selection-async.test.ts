import { describe, it, expect, beforeEach, vi } from 'vitest'
import { selectRelevantToolsAsync, EMBEDDING_ROUTING_THRESHOLD } from '../tool-selection'
import { clearEmbeddingCache } from '../../api/agents/embedding-router'
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
}

const mkTool = (name: string, description: string, category: keyof PermissionMap = 'system'): MCPToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {}, required: [] },
  category,
  source: 'builtin',
})

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

describe('tool-selection — selectRelevantToolsAsync', () => {
  beforeEach(() => clearEmbeddingCache())

  it('below threshold: keyword path only, never calls embed', async () => {
    const tools = [
      mkTool('file_read', 'read a file on disk', 'filesystem'),
      mkTool('file_write', 'write a file on disk', 'filesystem'),
      mkTool('get_current_time', 'return current local time', 'system'),
    ]
    const embedSpy = vi.fn(fakeEmbed)
    const out = await selectRelevantToolsAsync(
      'what time is it',
      tools,
      fullPerms,
      { embed: embedSpy, embeddingThreshold: EMBEDDING_ROUTING_THRESHOLD }
    )
    expect(embedSpy).not.toHaveBeenCalled()
    expect(out.some((t) => t.name === 'get_current_time')).toBe(true)
  })

  it('no embed fn provided: keyword path', async () => {
    const tools = Array.from({ length: 20 }, (_, i) =>
      mkTool(`tool_${i}`, `description number ${i}`)
    )
    const out = await selectRelevantToolsAsync('random query', tools, fullPerms)
    // keyword path unions with ALWAYS_INCLUDE so size > 0
    expect(out.length).toBeGreaterThan(0)
  })

  it('above threshold with embed: union of semantic + keyword selection', async () => {
    const tools = [
      mkTool('file_read', 'read a file on disk', 'filesystem'),
      mkTool('file_write', 'write a file on disk', 'filesystem'),
      mkTool('web_search', 'search the web for current information', 'web'),
      mkTool('web_fetch', 'fetch a URL and return text', 'web'),
      mkTool('get_current_time', 'return current local date time', 'system'),
      mkTool('shell_execute', 'run a terminal command', 'terminal'),
      mkTool('code_execute', 'execute python code', 'terminal'),
      mkTool('system_info', 'os architecture hostname', 'system'),
      mkTool('process_list', 'list running processes', 'system'),
      mkTool('screenshot', 'take a screenshot', 'desktop'),
      mkTool('image_generate', 'generate an image from prompt', 'image'),
      mkTool('run_workflow', 'run a saved workflow', 'workflow'),
      mkTool('file_list', 'list directory contents', 'filesystem'),
      mkTool('file_search', 'search file contents with regex', 'filesystem'),
      mkTool('custom_mcp_1', 'some external tool about search indexing', 'workflow'),
      mkTool('custom_mcp_2', 'some external tool about image analysis', 'workflow'),
    ]
    // > EMBEDDING_ROUTING_THRESHOLD — embedding path triggers.
    const out = await selectRelevantToolsAsync(
      'please read the file on disk',
      tools,
      fullPerms,
      { embed: fakeEmbed, topN: 3 }
    )
    // ALWAYS_INCLUDE means file_read and file_write + get_current_time are in.
    expect(out.some((t) => t.name === 'file_read')).toBe(true)
    expect(out.some((t) => t.name === 'get_current_time')).toBe(true)
  })

  it('embed failure falls back silently to keyword', async () => {
    const tools = Array.from({ length: 20 }, (_, i) =>
      mkTool(`t${i}`, `desc ${i}`, 'filesystem')
    )
    const broken = vi.fn(async () => {
      throw new Error('Ollama down')
    }) as any
    const out = await selectRelevantToolsAsync('any', tools, fullPerms, {
      embed: broken,
      embeddingThreshold: 5, // force embedding path
    })
    // keyword fallback still returns something usable
    expect(out.length).toBeGreaterThan(0)
  })

  it('permission-blocked categories are filtered out in either path', async () => {
    const restricted: PermissionMap = { ...fullPerms, filesystem: 'blocked' }
    const tools = [
      mkTool('file_read', 'read disk', 'filesystem'),
      mkTool('web_search', 'search', 'web'),
    ]
    const out = await selectRelevantToolsAsync('read a file please', tools, restricted)
    expect(out.some((t) => t.name === 'file_read')).toBe(false)
  })
})
