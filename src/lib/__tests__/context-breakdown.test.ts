/**
 * U5: what fills the context window, split by kind, and the small window note.
 *
 * Run: npx vitest run src/lib/__tests__/context-breakdown.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  breakdownOf,
  estimateNextStep,
  layoutBreakdown,
  smallWindowNote,
  splitSections,
  withNewerMessages,
  BREAKDOWN_ORDER,
  SMALL_WINDOW_FIX_TOKENS,
} from '../context-breakdown'
import { estimateTokens } from '../token-estimate'
import { estimateMessageTokens } from '../context-compaction'
import { computeContextFill } from '../token-usage'
import { renderProjectFileSection } from '../project-instructions'
import { renderRulesSection } from '../lurules'
import { MEMORY_PREAMBLE, buildTurnContext } from '../turn-context'

const BASE = 'You are the coding agent. Work in the workspace.'
const AGENTS = renderProjectFileSection({ name: 'AGENTS.md', text: 'Use pnpm. Tabs, not spaces.', truncated: false, warnings: [] })
const RULES = renderRulesSection({ path: '.lurules', text: 'No new dependencies.', truncated: false })
const MEMORY = `\n\n${MEMORY_PREAMBLE}\n<remembered_context>\nThe user prefers short answers.\n</remembered_context>`
const SYSTEM = `${BASE}${MEMORY}${AGENTS}${RULES}\n\nSkills the user approved.`

const row = (b: ReturnType<typeof breakdownOf>, key: string) => b.rows.find((r) => r.key === key)!

describe('splitSections', () => {
  it('cuts project files and memory out by their own fences', () => {
    const s = splitSections(SYSTEM)
    expect(s.projectFiles).toContain('Use pnpm')
    expect(s.projectFiles).toContain('No new dependencies')
    expect(s.memory).toContain('The user prefers short answers')
    expect(s.rest).toContain(BASE)
    expect(s.rest).toContain('Skills the user approved')
    expect(s.rest).not.toContain('pnpm')
    expect(s.rest).not.toContain('short answers')
  })

  it('finds memory in the turn note behind the user message, and leaves the clock', () => {
    const note = buildTurnContext({ memory: 'Lives in Berlin.', clock: 'Date and time: Friday 10:00' })
    const s = splitSections(note)
    expect(s.memory).toContain('Lives in Berlin')
    expect(s.rest).toContain('Friday 10:00')
  })

  it('a text without fences is all rest', () => {
    expect(splitSections('hello')).toEqual({ projectFiles: '', memory: '', rest: 'hello' })
  })
})

describe('breakdownOf', () => {
  const tools = [{ type: 'function', function: { name: 'file_read', description: 'Read a file', parameters: {} } }]
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Fix the build.' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_read', arguments: { path: 'a.ts' } } }] },
    { role: 'tool', content: 'export const a = 1\n'.repeat(40) },
    { role: 'user', content: '<tool_response>{"ok":true}</tool_response>' },
    { role: 'assistant', content: 'Done.' },
  ]

  it('has every category in order, and the total is their sum', () => {
    const b = breakdownOf(messages, tools)
    expect(b.rows.map((r) => r.key)).toEqual([...BREAKDOWN_ORDER])
    expect(b.total).toBe(b.rows.reduce((a, r) => a + r.tokens, 0))
    expect(b.kind).toBe('step')
    for (const r of b.rows) expect(r.unknown).toBeUndefined()
  })

  it('puts each part where it belongs', () => {
    const b = breakdownOf(messages, tools)
    expect(row(b, 'tools').tokens).toBe(estimateTokens(JSON.stringify(tools)))
    expect(row(b, 'projectFiles').tokens).toBeGreaterThan(0)
    expect(row(b, 'memory').tokens).toBeGreaterThan(0)
    expect(row(b, 'system').tokens).toBeLessThan(estimateTokens(SYSTEM))
    expect(row(b, 'toolResults').tokens).toBe(
      estimateTokens('export const a = 1\n'.repeat(40)) + estimateTokens('<tool_response>{"ok":true}</tool_response>') + 8,
    )
    // The model's own tool call arguments are part of the conversation.
    const noCall = breakdownOf(messages.filter((m) => !('tool_calls' in m)), tools)
    expect(row(b, 'conversation').tokens).toBeGreaterThan(row(noCall, 'conversation').tokens)
  })

  it('adds up to what the request builder counts, so it matches the meter', () => {
    const b = breakdownOf(messages, tools)
    expect(b.total).toBe(
      estimateMessageTokens(messages as never) + estimateTokens(JSON.stringify(tools)),
    )
  })

  it('takes a token count for the tools when the loop already has one', () => {
    expect(row(breakdownOf(messages, 1234), 'tools').tokens).toBe(1234)
    expect(row(breakdownOf(messages, []), 'tools').tokens).toBe(0)
  })

  it('carries the message count it was measured at', () => {
    expect(breakdownOf([], 0, { atMessageCount: 7 }).atMessageCount).toBe(7)
  })
})

describe('estimateNextStep', () => {
  const stored = [
    { role: 'system', content: 'a notice the model never sees' },
    { role: 'user', content: 'Hello there' },
    { role: 'assistant', content: 'Hi.' },
    { role: 'assistant', content: '   ' },
  ]

  it('is labelled an estimate', () => {
    expect(estimateNextStep(stored, { agent: false }).kind).toBe('estimate')
  })

  it('on an agent surface it does not invent the parts assembled at run time', () => {
    const b = estimateNextStep(stored, { agent: true, systemPrompt: 'ignored' })
    for (const k of ['system', 'tools', 'projectFiles', 'memory']) {
      expect(row(b, k).unknown).toBe(true)
      expect(row(b, k).tokens).toBe(0)
    }
    expect(row(b, 'conversation').tokens).toBe(estimateTokens('Hello there') + estimateTokens('Hi.') + 8)
    expect(row(b, 'conversation').unknown).toBeUndefined()
  })

  it('in a plain chat it counts the stored system prompt and has no project files', () => {
    const b = estimateNextStep(stored, { agent: false, systemPrompt: 'You are a pirate.' })
    expect(row(b, 'system').tokens).toBe(estimateTokens('You are a pirate.') + 4)
    expect(row(b, 'projectFiles').unknown).toBeUndefined()
    expect(row(b, 'tools').unknown).toBe(true)
    expect(row(b, 'memory').unknown).toBe(true)
  })
})

describe('layoutBreakdown', () => {
  const b = breakdownOf([{ role: 'user', content: 'x'.repeat(4000) }], 2000)

  it('free space is the window minus the total, never below zero', () => {
    const l = layoutBreakdown(b, 32768, null)
    expect(l.free).toBe(32768 - b.total)
    expect(layoutBreakdown(b, 100, null).free).toBe(0)
    expect(layoutBreakdown(b, 100, null).usedShare).toBe(1)
  })

  it('places the compaction mark on the window, or none when off', () => {
    const l = layoutBreakdown(b, 32768, 0.75)
    expect(l.thresholdShare).toBe(0.75)
    expect(l.thresholdTokens).toBe(24576)
    expect(layoutBreakdown(b, 32768, null).thresholdShare).toBeNull()
  })
})

describe('smallWindowNote', () => {
  const base = { provider: 'ollama' as const, window: 8192, modelMax: 131072, use: 'agent' as const }

  it('warns a local model under 16K on an agent surface, with a 32K fix', () => {
    const n = smallWindowNote(base)!
    expect(n.text).toBe('Small window: agent runs may forget files.')
    expect(n.fix).toBe(SMALL_WINDOW_FIX_TOKENS)
    expect(smallWindowNote({ ...base, provider: 'lmstudio' })?.fix).toBe(32768)
    expect(smallWindowNote({ ...base, provider: 'builtin', modelMax: 0 })?.fix).toBe(32768)
  })

  it('the threshold is 16K: 16K itself is fine', () => {
    expect(smallWindowNote({ ...base, window: 16383 })).not.toBeNull()
    expect(smallWindowNote({ ...base, window: 16384 })).toBeNull()
    expect(smallWindowNote({ ...base, window: 32768 })).toBeNull()
  })

  it('never warns a cloud model, an unknown one, or a window not known yet', () => {
    expect(smallWindowNote({ ...base, provider: 'cloud' })).toBeNull()
    expect(smallWindowNote({ ...base, provider: 'unknown' })).toBeNull()
    expect(smallWindowNote({ ...base, window: 0 })).toBeNull()
  })

  it('only where agent work happens', () => {
    expect(smallWindowNote({ ...base, use: 'chat' })).toBeNull()
  })

  it('no action where LU cannot set the window', () => {
    const custom = smallWindowNote({ ...base, provider: 'custom' })!
    expect(custom.fix).toBeNull()
    expect(custom.hint).toMatch(/server/)
    const tiny = smallWindowNote({ ...base, modelMax: 8192 })!
    expect(tiny.fix).toBeNull()
    expect(tiny.hint).toMatch(/cannot go to 32K/)
  })
})

describe('withNewerMessages', () => {
  const step = breakdownOf([{ role: 'user', content: 'Fix it' }], 500, { atMessageCount: 2 })

  it('adds what the chat gained after the step, the way the meter does', () => {
    const stored = [
      { role: 'user', content: 'Fix it' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'already inside the step', hidden: true },
      { role: 'system', content: 'an app notice' },
      { role: 'assistant', content: 'Done, the test passes now.' },
    ]
    const b = withNewerMessages(step, stored)
    const extra = estimateTokens('Done, the test passes now.') + 4
    expect(b.since).toBe(extra)
    expect(b.total).toBe(step.total + extra)
    expect(row(b, 'conversation').tokens).toBe(row(step, 'conversation').tokens + extra)
    expect(b.total).toBe(computeContextFill(stored, { tokens: step.total, atMessageCount: 2 }).used)
  })

  it('leaves an estimate and a stale anchor alone', () => {
    expect(withNewerMessages(step, [{ role: 'user', content: 'x' }]).since).toBe(0)
    const est = estimateNextStep([{ role: 'user', content: 'x' }], { agent: false })
    expect(withNewerMessages(est, [{ role: 'user', content: 'x' }, { role: 'user', content: 'y' }]).since).toBe(0)
  })
})
