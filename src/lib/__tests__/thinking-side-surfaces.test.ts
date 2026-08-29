/**
 * Loch 5, 6 und 7 des Denk-Audits (2.6.7, 2026-08-29): the three surfaces
 * beside chat, agent and coding.
 *
 *   5. Workflow engine — carried its own hand-written copy of the balanced
 *      `<think>` regex. It missed the pre-opened Qwen3 shape (closer without
 *      opener), a turn cut off mid-thought, and every non-canonical marker.
 *      A workflow step's output is not only shown, it becomes a workflow
 *      VARIABLE and rides into every later step's prompt, so leaked reasoning
 *      compounds down the chain.
 *   6. A/B compare — sent no thinking signal at all and stripped nothing, so
 *      the comparison ran on whatever the backend happened to default to and
 *      the raw reasoning was part of what the user was comparing.
 *   7. Benchmark — counted a reasoning chunk only on the NATIVE channel. A
 *      backend without one sends the thought inline as `<think>` inside the
 *      content (Ollama with the flag unset, llama.cpp with reasoning-format
 *      none, LM Studio), so it landed in the answer text the correctness
 *      check scores, and thinkShare read 0 on exactly the local backends the
 *      board exists to compare.
 *
 * Run: npx vitest run src/lib/__tests__/thinking-side-surfaces.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { measureRun } from '../benchmark-run'
import { settleThinking } from '../thinking-stripper'
import type { ChatStreamChunk } from '../../api/providers/types'

const read = (p: string) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), p), 'utf8')

async function* streamOf(chunks: Partial<ChatStreamChunk>[]): AsyncGenerator<ChatStreamChunk> {
  for (const c of chunks) yield { content: '', done: false, ...c } as ChatStreamChunk
}
const steppedClock = (...values: number[]) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

// ── Loch 5: the workflow engine ────────────────────────────────
describe('a workflow step hands the next step an answer, not a thought', () => {
  const src = read('../workflow-engine.ts')

  it('the step output goes through the shared settlement', () => {
    expect(src).toContain("settleThinking(output, '', false).content")
  })

  it('and the hand-written regex copy is gone', () => {
    expect(src).not.toMatch(/output\.replace\(\/<think>/)
  })

  it('which is what makes the pre-opened shape survive the step', () => {
    const raw = 'Weighing the options here.</think>rename the file to build.log'
    expect(settleThinking(raw, '', false).content).toBe('rename the file to build.log')
  })

  it('NEGATIVE CONTROL: the old copy left the whole thought in the variable', () => {
    const raw = 'Weighing the options here.</think>rename the file to build.log'
    const old = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    expect(old).toContain('Weighing the options here.')
    expect(old).toContain('</think>')
  })
})

// ── Loch 6: A/B compare ────────────────────────────────────────
describe('A/B compare asks for thinking and never shows it', () => {
  const src = read('../../hooks/useABCompare.ts')

  it('both sides carry the tri-state, per model', () => {
    expect(src).toContain('thinking: thinkOptFor(modelA)')
    expect(src).toContain('thinking: thinkOptFor(modelB)')
  })

  it('the switch only applies where the model has one', () => {
    expect(src).toContain('isThinkingCompatible(model) ? settings.thinkingEnabled === true : undefined')
  })

  it('the live stream is split, so no raw tag ever flashes into the pane', () => {
    expect(src.split('createThinkStreamSplitter()').length - 1).toBe(2)
  })

  it('and the finished pane is settled once more', () => {
    expect(src.split("settleThinking(fullContent, '', false).content").length - 1).toBe(2)
  })
})

// ── Loch 7: the benchmark board ────────────────────────────────
describe('the benchmark counts an inline thought as a thought', () => {
  it('inline reasoning is kept out of the answer the check scores', async () => {
    // A model that reasons its way past a wrong number and prints the right
    // one. Scoring the raw stream would score the reasoning too.
    const m = await measureRun(
      streamOf([
        { content: '<think>Maybe 17. No, all but 9 remain, ' },
        { content: 'so the answer is 9.</think>' },
        { content: '9 sheep are left.' },
        { done: true, finishReason: 'stop' },
      ]),
      (text: string) => text.trim() === '9 sheep are left.',
      { clock: steppedClock(0, 100, 200, 300, 1000) },
    )
    expect(m.correct).toBe(true)
    expect(m.thinkTokens).toBeGreaterThan(0)
  })

  it('NEGATIVE CONTROL: a run with no reasoning at all reports none', async () => {
    const m = await measureRun(
      streamOf([
        { content: '9 sheep are left.' },
        { done: true, finishReason: 'stop' },
      ]),
      (text: string) => text.trim() === '9 sheep are left.',
      { clock: steppedClock(0, 100, 1000) },
    )
    expect(m.correct).toBe(true)
    expect(m.thinkTokens).toBe(0)
  })

  it('the native reasoning channel still counts, it was never the broken half', async () => {
    const m = await measureRun(
      streamOf([
        { thinking: 'working it out ' },
        { content: '9 sheep are left.' },
        { done: true, finishReason: 'stop' },
      ]),
      (text: string) => text.trim() === '9 sheep are left.',
      { clock: steppedClock(0, 100, 200, 1000) },
    )
    expect(m.correct).toBe(true)
    expect(m.thinkTokens).toBeGreaterThan(0)
  })
})

// ── Loch 11: the two silent agents ─────────────────────────────
describe('what a hidden agent hands back is an answer, not a thought', () => {
  it('the architect plan is settled before it becomes a system prompt', () => {
    // The plan is pasted into the EDITOR's system prompt verbatim, so leaked
    // reasoning rides into every coding turn after it.
    expect(read('../../api/agents/architect.ts')).toContain("settleThinking(content ?? '', '', false).content")
  })

  it('a sub-agent result is settled before it becomes a tool result', () => {
    expect(read('../../api/agents/sub-agent.ts')).toContain("settleThinking(turn.content || '', '', false).content")
  })

  it('which is what keeps a pre-opened thought out of the parent context', () => {
    const raw = 'The plan, roughly.</think>1. read the file\n2. patch it'
    expect(settleThinking(raw, '', false).content).toBe('1. read the file\n2. patch it')
  })

  it('NEGATIVE CONTROL: a plan without reasoning is passed through as it is', () => {
    expect(settleThinking('1. read the file', '', false).content).toBe('1. read the file')
  })
})
