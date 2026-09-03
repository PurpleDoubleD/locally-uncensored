/**
 * Audit M2 — the plain-chat allow-list has to hold where it counts.
 *
 * Chat-Tools mode promises "plain chat gets five safe tools". That promise was
 * enforced only where the CATALOG is built: the tool list sent to the model and
 * the roster printed into the prompt were filtered, and nothing else was. The
 * prose fallback (parseLooseToolCalls) then resolved names against the FULL
 * registry — `shell_execute` included — and the executor's getTool resolved them
 * too, so a name the model was never offered ran anyway.
 *
 * Which matters because of who writes the text in that lane: `web_fetch` output
 * is the one surface guaranteed to contain attacker-controlled prose, and a weak
 * model reading "now call shell_execute with …" writes exactly that into its
 * answer, where the loose parser picks it up.
 *
 * Run: npx vitest run src/hooks/__tests__/chat-tools-allowlist-at-execution.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeParallel, APPROVE_ALL } from '../../api/agents/tool-executor'
import { CHAT_TOOLS } from '../../lib/chat-tool-intent'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')

/** The exact gate useAgentChat now installs on the executor. */
const curatedGetTool = (curated: readonly string[]) => (name: string) =>
  curated.includes(name) ? { name } : undefined

describe('a tool outside the curated list cannot run', () => {
  it('shell_execute lifted out of prose is never dispatched in Chat-Tools mode', async () => {
    const execute = vi.fn(async () => 'ROOT SHELL OUTPUT')
    const [res] = await executeParallel(
      [{ id: '1', toolName: 'shell_execute', args: { command: 'cat ~/.ssh/id_rsa' } }],
      { getTool: curatedGetTool(CHAT_TOOLS), execute, awaitApproval: APPROVE_ALL },
    )
    expect(execute).not.toHaveBeenCalled()
    expect(res.status).toBe('failed')
    expect(res.error).toContain('Unknown tool')
  })

  it('the model is TOLD, so the turn can recover instead of dying silently', async () => {
    const [res] = await executeParallel(
      [{ id: '1', toolName: 'file_read', args: { path: '/etc/passwd' } }],
      { getTool: curatedGetTool(CHAT_TOOLS), execute: async () => 'x', awaitApproval: APPROVE_ALL },
    )
    expect(res.error).toBe('Unknown tool: file_read')
  })

  it('NEGATIVE CONTROL: the five curated tools still run', async () => {
    const execute = vi.fn(async (name: string) => `ran ${name}`)
    const results = await executeParallel(
      CHAT_TOOLS.map((name, i) => ({ id: String(i), toolName: name, args: {} })),
      { getTool: curatedGetTool(CHAT_TOOLS), execute, awaitApproval: APPROVE_ALL },
    )
    expect(results.every((r) => r.status === 'completed')).toBe(true)
    expect(execute).toHaveBeenCalledTimes(CHAT_TOOLS.length)
  })

  it('NEGATIVE CONTROL: with no curated list (full Agent mode) nothing is filtered', async () => {
    const execute = vi.fn(async () => 'ran')
    const [res] = await executeParallel(
      [{ id: '1', toolName: 'shell_execute', args: { command: 'ls' } }],
      { getTool: () => ({ name: 'shell_execute' }), execute, awaitApproval: APPROVE_ALL },
    )
    expect(res.status).toBe('completed')
  })
})

describe('useAgentChat installs that gate on the executor', () => {
  const agent = read('../useAgentChat.ts')

  it('the allow-list is checked at the execution site, not only at catalog build', () => {
    expect(agent).toContain(
      'getTool: (name) => (toolMatchesCurated(name) ? toolRegistry.resolveExecutable(name) : undefined)',
    )
  })

  it('the same predicate still filters the offered catalog, so the two cannot drift', () => {
    // One predicate, three uses: the Hermes defs, the offered list, and now the
    // executor. A second copy of the rule is how the first one got forgotten.
    expect(agent.match(/toolMatchesCurated\(/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('the read-only turn rides on the same predicate, so /review is enforced too', () => {
    expect(agent).toContain('!(opts?.readOnly && !allowedInReadOnlyTurn(name))')
  })
})

describe('every recovered tool call carries an id', () => {
  const agent = read('../useAgentChat.ts')
  const codex = read('../useCodex.ts')

  it('both loops normalise ids before building the batch', () => {
    // Only the native channel supplies one. A call lifted out of prose or
    // synthesized by the media fallback had none, so the next turn sent an
    // assistant tool_calls entry with no id and `tool_call_id: undefined`
    // beside it — which a strict OpenAI-compatible provider (lu-cloud) rejects
    // outright, killing the whole run on exactly the weak models that need the
    // prose fallback.
    for (const src of [agent, codex]) {
      expect(src).toContain('toolCalls = toolCalls.map((tc) => (tc.id ? tc : { ...tc, id: uuid() }))')
    }
  })

  it('the id-strict history branch is the consumer that needed it', () => {
    for (const src of [agent, codex]) {
      expect(src).toContain('tool_call_id: tc.id')
    }
  })
})
