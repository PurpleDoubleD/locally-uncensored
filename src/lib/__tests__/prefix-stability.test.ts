/**
 * A5: prefix stability and plan pruning (2.6.6 plan).
 *
 * An upstream prefix cache matches from byte 0 and stops at the first
 * difference, so anything volatile near the front of the prompt costs the whole
 * prompt. Three things were sitting there:
 *
 *  1. the clock, which changes every minute,
 *  2. the RAG block, which changes every turn,
 *  3. twenty near-identical copies of the same todo list, which change every
 *     step and are read past by the model anyway.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { hostClockLine, hostEnvironmentBlock, platformPromptLine } from '../host-platform'
import { pruneSupersededPlans, buildRequestMessages, SUPERSEDED_PLAN_NOTE, type DecayMessage } from '../context-decay'
import type { ToolCall } from '../../api/providers/types'

const src = (...p: string[]) => readFileSync(resolve(__dirname, '..', '..', ...p), 'utf8')

describe('A5.1: the clock is its own line and it goes last', () => {
  it('two prompts two minutes apart share an identical stable half', () => {
    const stable = platformPromptLine('macos')
    const a = `${stable}\n\n${hostClockLine(new Date('2026-08-21T12:00:00Z'))}`
    const b = `${stable}\n\n${hostClockLine(new Date('2026-08-21T12:02:00Z'))}`
    expect(a).not.toBe(b)
    // Everything up to the clock is byte-identical, and the clock is at the end.
    expect(a.slice(0, stable.length)).toBe(b.slice(0, stable.length))
    expect(a.indexOf(stable)).toBe(0)
  })

  it('the clock line still names the date, so the retired clock tool is covered', () => {
    const line = hostClockLine(new Date('2026-08-21T12:00:00Z'))
    expect(line).toMatch(/August 2026/)
    expect(line).toMatch(/Trust this line/)
  })

  it('the combined block is still the two halves joined, for callers that want it', () => {
    const now = new Date('2026-08-21T12:00:00Z')
    expect(hostEnvironmentBlock('linux', now))
      .toBe(`${platformPromptLine('linux')}\n${hostClockLine(now)}`)
  })

  it('the coding loop appends the clock AFTER architect and repo map', () => {
    const codex = src('hooks', 'useCodex.ts')
    const clockAt = codex.indexOf('systemPrompt += `\\n\\n${hostClockLine()}`')
    const repoMapAt = codex.indexOf('renderRepoMapSection(repoMap)')
    const memoryAt = codex.indexOf('remembered context from previous conversations')
    expect(clockAt).toBeGreaterThan(-1)
    expect(clockAt).toBeGreaterThan(repoMapAt)
    expect(clockAt).toBeGreaterThan(memoryAt)
  })

  it('the agent loop appends the clock after persona, memory and caveman', () => {
    const agent = src('hooks', 'useAgentChat.ts')
    const clockAt = agent.indexOf('agentSystemPrompt += `\\n\\n${hostClockLine()}`')
    const cavemanAt = agent.indexOf('agent.caveman_load_failed')
    expect(clockAt).toBeGreaterThan(-1)
    expect(clockAt).toBeGreaterThan(cavemanAt)
  })
})

describe('A5.3: the RAG block moved from byte 0 to the end', () => {
  it('the plain chat appends retrieval instead of prepending it', () => {
    const chat = src('hooks', 'useChat.ts')
    expect(chat).not.toMatch(/systemPrompt = ragPrefix \+/)
    expect(chat).toMatch(/ragSuffix = /)
    expect(chat).toMatch(/if \(ragSuffix\) systemPrompt = \(systemPrompt \|\| ''\) \+ ragSuffix/)
  })

  it('the append lands after the memory block, not before it', () => {
    const chat = src('hooks', 'useChat.ts')
    const memoryAt = chat.indexOf('remembered context from previous conversations')
    const appendAt = chat.indexOf("if (ragSuffix) systemPrompt = (systemPrompt || '') + ragSuffix")
    expect(memoryAt).toBeGreaterThan(-1)
    expect(appendAt).toBeGreaterThan(memoryAt)
  })

  it('the agent surface got the same treatment', () => {
    const agent = src('hooks', 'useAgentChat.ts')
    expect(agent).toMatch(/ragSuffix = /)
    expect(agent).toMatch(/agentSystemPrompt \+= ragSuffix/)
  })
})

/** A history with `n` plan updates, each one a complete rewrite of the list. */
function planHistory(n: number, mixed = false): DecayMessage[] {
  const out: DecayMessage[] = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'build it' },
  ]
  for (let i = 1; i <= n; i++) {
    const calls: ToolCall[] = [{ id: `t${i}`, function: { name: 'todo_write', arguments: { todos: [`step ${i}`] } } }]
    if (mixed) calls.push({ id: `r${i}`, function: { name: 'file_read', arguments: { path: 'a.ts' } } })
    out.push({ role: 'assistant', content: '', tool_calls: calls })
    out.push({ role: 'tool', content: `plan v${i}: ${'item '.repeat(200)}`, tool_call_id: `t${i}` })
    if (mixed) out.push({ role: 'tool', content: `file body ${i}`, tool_call_id: `r${i}` })
  }
  return out
}

describe('A5.2: only the newest plan state survives', () => {
  it('five plan updates leave exactly one todo_write pair', () => {
    const { messages, prunedCount } = pruneSupersededPlans(planHistory(5))
    const remaining = messages.filter(
      (m) => Array.isArray(m.tool_calls) && JSON.stringify(m.tool_calls).includes('todo_write'),
    )
    expect(remaining).toHaveLength(1)
    expect(prunedCount).toBe(8) // four pairs
  })

  it('the survivor is the NEWEST plan, not the first', () => {
    const { messages } = pruneSupersededPlans(planHistory(5))
    const results = messages.filter((m) => m.role === 'tool')
    expect(String(results[results.length - 1].content)).toContain('plan v5')
    expect(messages.some((m) => String(m.content ?? '').includes('plan v1'))).toBe(false)
  })

  it('a single plan update is left completely alone', () => {
    const history = planHistory(1)
    const { messages, prunedCount } = pruneSupersededPlans(history)
    expect(prunedCount).toBe(0)
    expect(messages.map((m) => m.content)).toEqual(history.map((m) => m.content))
  })

  it('in a mixed batch the call stays and only the result text is replaced', () => {
    // Dropping half a batch would leave a tool_call with no result, which
    // strict OpenAI-compatible providers reject outright.
    const history = planHistory(3, true)
    const { messages } = pruneSupersededPlans(history)
    expect(messages).toHaveLength(history.length)
    const superseded = messages.filter((m) => m.content === SUPERSEDED_PLAN_NOTE)
    expect(superseded).toHaveLength(2)
    // The file results in the same batches are untouched.
    expect(messages.some((m) => m.content === 'file body 1')).toBe(true)
  })

  it('saves real tokens on a long run', () => {
    const history = planHistory(10)
    const pruned = buildRequestMessages(history, { budgetTokens: 100000 })
    const raw = buildRequestMessages(history, { budgetTokens: 100000, prunePlans: false })
    expect(pruned.prunedPlans).toBe(18)
    expect(pruned.promptTokens).toBeLessThan(raw.promptTokens / 2)
  })

  it('negative control: with pruning off every copy still rides along', () => {
    const raw = buildRequestMessages(planHistory(5), { budgetTokens: 100000, prunePlans: false })
    const plans = raw.messages.filter((m) => String(m.content ?? '').startsWith('plan v'))
    expect(plans).toHaveLength(5)
  })

  it('the notaus switches plan pruning off with the decay', () => {
    const off = buildRequestMessages(planHistory(5), { budgetTokens: 100000, enabled: false })
    expect(off.prunedPlans).toBe(0)
  })
})
