/**
 * A37, Discord "Ghidra and REA", xxcoder, 26.10.2026:
 *
 *   "that after I had to restart llm since it was repeating"
 *   "looks like rea only work on first run of llm, and if restarted, it wont work"
 *
 * and the model's own words: "I don't have that tool directly available."
 *
 * REA's 207 tools are routed per turn on the user's words. The words were the
 * newest message only, so the turn after a stopped run ("continue", "start making
 * the project", "list the procedures again") was offered no REA tool at all,
 * while REA itself was running fine. Asking the first question again brought
 * them back, which is why it looked like a restart problem.
 *
 * Run: npx vitest run src/lib/plugins/__tests__/rea-tools-stay-for-a-follow-up.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { reaRoutingText, REA_ROUTING_HISTORY, REA_SERVER_ID } from '../rea-tools'
import { selectRelevantTools, selectRelevantToolsAsync } from '../../tool-selection'
import { DEFAULT_PERMISSIONS, type MCPToolDefinition } from '../../../api/mcp/types'

const REA = ['open_binary', 'binary_session', 'list_procedures', 'procedure_pseudo_code', 'search_strings', 'xrefs',
  'inspect_artifact', 'binary_overview', 'inspect_pe_resources', 'inspect_managed_artifact']

function tool(name: string, serverId?: string): MCPToolDefinition {
  return {
    name, description: name, inputSchema: { type: 'object', properties: {}, required: [] }, category: 'workflow',
    ...(serverId ? { source: 'external' as const, serverId } : { source: 'builtin' as const }),
  }
}

const CATALOG = [tool('shell_execute'), tool('file_read'), tool('file_write'), ...REA.map((n) => tool(n, REA_SERVER_ID))]
const FIRST = 'Use Ghidra to reverse engineer PE file GIFAnimator.exe'
const names = (defs: MCPToolDefinition[]) => defs.map((t) => t.name)

describe('the turn after a stopped run keeps the REA tools', () => {
  it('a follow-up without reverse engineering words still gets them from the conversation', () => {
    const followUp = 'it was repeating itself, continue from where you stopped'
    const got = names(selectRelevantTools(followUp, CATALOG, DEFAULT_PERMISSIONS, undefined, reaRoutingText(followUp, [FIRST])))
    expect(got).toEqual(expect.arrayContaining(['open_binary', 'list_procedures', 'procedure_pseudo_code']))
  })

  it('the same through the async router the small-model mode uses', async () => {
    const followUp = 'start making the project'
    const got = names(await selectRelevantToolsAsync(followUp, CATALOG, DEFAULT_PERMISSIONS, { reaText: reaRoutingText(followUp, [FIRST]) }))
    expect(got).toContain('open_binary')
  })

  it('negative control: the follow-up alone is offered no REA tool, which is what the model ran into', () => {
    const got = names(selectRelevantTools('continue from where you stopped', CATALOG, DEFAULT_PERMISSIONS))
    expect(got.filter((n) => REA.includes(n))).toEqual([])
  })

  it('a conversation that never was about it stays without them', () => {
    const t = reaRoutingText('and now a haiku', ['write me a poem about autumn'])
    const got = names(selectRelevantTools('and now a haiku', CATALOG, DEFAULT_PERMISSIONS, undefined, t))
    expect(got.filter((n) => REA.includes(n))).toEqual([])
  })

  it('only the last few user messages count', () => {
    const old = Array.from({ length: REA_ROUTING_HISTORY + 3 }, (_, i) => `message ${i}`)
    const text = reaRoutingText('now', [FIRST, ...old])
    expect(text).not.toContain('Ghidra')
    expect(text.split('\n')).toHaveLength(REA_ROUTING_HISTORY + 1)
  })

  it('both agent loops route REA on the conversation', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const read = (f: string) => readFileSync(resolve(here, '../../../hooks', f), 'utf8')
    expect(read('useCodex.ts')).toMatch(/selectRelevantTools\(lastUserMsg, codexTools, permissions, undefined, reaText\)/)
    expect(read('useCodex.ts')).toMatch(/maxTools: SMALL_MODEL_MAX_TOOLS,\s+reaText,/)
    // Since the phone line joined (3.0.8) the options go through withPhoneToolCap
    // first; reaText rides next to it in the same object.
    expect(read('useAgentChat.ts').match(/phoneToolCtx, SMALL_MODEL_MAX_TOOLS,\s+\),\s+(?:\.\.\.\(compactRun \? \{ maxTools: COMPACT_MAX_TOOLS, prefer: COMPACT_PREFER \} : \{\}\),\s+)?reaText,\s+\}/g)).toHaveLength(2)
  })
})
