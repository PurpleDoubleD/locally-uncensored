/**
 * 3.1.1: a long conversation on a paid provider keeps its prompt prefix.
 *
 * Support case E8b (16.11.2026): an agent session of about 190k tokens sent
 * every step with only the system prompt and the tool catalogue cached, and a
 * step cost about 4,000 credits instead of 150 to 400. The upstream cache
 * matches from byte 0, so a request is cheap only while it STARTS with the
 * request before it.
 *
 * These tests walk 20 steps over the threshold and count how many requests
 * start with the one before: a send is a hit when at least nine tenths of
 * the request before it come back as the first bytes of this one. (Not all
 * of it: an agent shortens a long result two steps after it arrived, by
 * design, and the request changes from there on.)
 *
 * Measured on 3.1.0 (4486bf5a4) with OLD=1, hits of 20: chat 0, chat with a
 * long first message 0, group round 13, chat of many short messages 0, agent
 * run with a very long task 0, agent run of many small steps 0. The two
 * other agent walks already held there.
 */
import { describe, it, expect } from 'vitest'
import { applyChatSendBudget } from '../chat-send-budget'
import { trimWorkingHistory, buildRequestMessages, type DecayMessage } from '../context-decay'
import * as fit from '../fit-to-window'
import { budgetBesideTheCatalog, effectiveSendWindow } from '../send-window'
import { capMessageCount, COMPACT_TRIGGER_RATIO, shortenLongTurns, stableCutIndex, stableDropBlock, steadyKeep } from '../context-compaction'

const { fitToWindow } = fit

type Msg = { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }

/** About `tokens` tokens of text that is different for every `seed`. */
function text(seed: number, tokens: number): string {
  let out = ''
  let i = 0
  while (out.length < tokens * 4) out += `line ${seed}-${i++} of the work done so far, with some words in it\n`
  return out.slice(0, tokens * 4)
}

/** How much of `prev` is the start of `next`, 0 to 1. */
function sharedStart(next: Msg[], prev: Msg[]): number {
  const a = JSON.stringify(prev).slice(0, -1)
  const b = JSON.stringify(next)
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return i / a.length
}

function hits(sends: Msg[][]): number {
  let n = 0
  for (let i = 1; i < sends.length; i++) if (sharedStart(sends[i], sends[i - 1]) >= 0.9) n += 1
  return n
}

const WINDOW = 64000
const STEPS = 20
/** The hooks as 3.1.0 had them, for the numbers in the header: OLD=1. */
const OLD = process.env.OLD === '1'

describe('a paid chat over the threshold keeps its prefix', () => {
  function chat(turnTokens: number, firstTurnTokens = turnTokens): Msg[][] {
    const history: Msg[] = [{ role: 'system', content: text(0, 400) }]
    history.push({ role: 'user', content: text(2, firstTurnTokens) })
    history.push({ role: 'assistant', content: text(3, turnTokens) })
    // Well over the trigger from the first send on.
    for (let i = 2; i <= 80; i++) {
      history.push({ role: 'user', content: text(i * 2, turnTokens) })
      history.push({ role: 'assistant', content: text(i * 2 + 1, turnTokens) })
    }
    const sends: Msg[][] = []
    for (let step = 0; step <= STEPS; step++) {
      history.push({ role: 'user', content: text(1000 + step * 2, turnTokens) })
      const sent = applyChatSendBudget(history, {
        providerId: 'lu-cloud',
        modelWindow: WINDOW,
        sendWindowTokens: WINDOW,
        notice: 'chat',
      }).messages
      sends.push(OLD ? fitToWindow(sent, WINDOW).messages : fitToWindow(sent, WINDOW, 0, { steady: true }).messages)
      history.push({ role: 'assistant', content: text(1001 + step * 2, turnTokens) })
    }
    return sends
  }

  it('at least 18 of 20 sends start with the send before', () => {
    expect(hits(chat(500))).toBeGreaterThanOrEqual(18)
  })

  it('also when the chat began with a very long message', () => {
    expect(hits(chat(500, 20000))).toBeGreaterThanOrEqual(18)
  })

  it('a chat of many short messages, past the message count cap', () => {
    // hooks/useChat.ts: the count cap first, then the budget.
    const history: Msg[] = [{ role: 'system', content: text(0, 400) }]
    for (let i = 1; i <= 450; i++) history.push({ role: i % 2 ? 'user' : 'assistant', content: text(i, 40) })
    const sends: Msg[][] = []
    for (let step = 0; step <= STEPS; step++) {
      history.push({ role: 'user', content: text(1000 + step * 2, 40) })
      sends.push(applyChatSendBudget(capMessageCount([...history]), {
        providerId: 'lu-cloud', modelWindow: 400000, sendWindowTokens: 200000, notice: 'chat',
      }).messages)
      history.push({ role: 'assistant', content: text(1001 + step * 2, 40) })
    }
    expect(hits(sends)).toBeGreaterThanOrEqual(18)
  })

  it('a group round shortens its longest turn to a fixed length', () => {
    // hooks/useChat.ts, buildGroupSend: the budget, then the long turns.
    const history: Msg[] = [{ role: 'system', content: text(0, 400) }, { role: 'user', content: text(1, 30000) }]
    for (let i = 1; i <= 20; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: text(i + 1, 500) })
    const sends: Msg[][] = []
    for (let step = 0; step <= STEPS; step++) {
      history.push({ role: 'user', content: text(1000 + step * 2, 300) })
      const sent = applyChatSendBudget(history, { providerId: 'lu-cloud', modelWindow: WINDOW, sendWindowTokens: WINDOW, notice: 'chat' })
      const limit = OLD ? sent.budget! : Math.floor(sent.budget! * COMPACT_TRIGGER_RATIO)
      sends.push(shortenLongTurns(sent.messages, limit, undefined, OLD ? {} : { steady: true }).messages)
      history.push({ role: 'assistant', content: text(1001 + step * 2, 300) })
    }
    expect(hits(sends)).toBeGreaterThanOrEqual(18)
  })
})

describe('a paid agent run over the threshold keeps its prefix', () => {
  const catalogTokens = 3000

  /** One request, built the way hooks/useAgentChat.ts builds it. */
  function request(run: { messages: Msg[] }, WINDOW = 64000, pick = WINDOW): Msg[] {
    const sendWindow = effectiveSendWindow({ providerId: 'lu-cloud', modelWindow: WINDOW, sendWindowTokens: pick })
    const besideCatalog = budgetBesideTheCatalog(sendWindow, catalogTokens)
    if (OLD) {
      run.messages = trimWorkingHistory(run.messages as DecayMessage[], besideCatalog, { enabled: true, hysteresis: true }).messages as Msg[]
      const built = buildRequestMessages(run.messages as DecayMessage[], { budgetTokens: besideCatalog, enabled: true, hysteresis: true })
      return fitToWindow(built.messages as Msg[], WINDOW, catalogTokens).messages
    }
    const budget = fit.budgetBelowTheFit(besideCatalog, WINDOW, catalogTokens, true)
    const stepWindow = trimWorkingHistory(run.messages as DecayMessage[], budget, { enabled: true, hysteresis: true }).messages
    const built = buildRequestMessages(stepWindow, { budgetTokens: budget, enabled: true, hysteresis: true })
    return fitToWindow(built.messages as Msg[], WINDOW, catalogTokens, { steady: true }).messages
  }

  function toolStep(messages: Msg[], i: number, tokens: number) {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }],
    })
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: text(i, tokens) })
  }

  /** One long run: `before` steps done, then 20 more, one request each. */
  function oneRun(task: string, before: number, tokens: number, window?: number, pick?: number): Msg[][] {
    const run = { messages: [{ role: 'system', content: text(0, 400) }, { role: 'user', content: task }] as Msg[] }
    for (let i = 0; i < before; i++) toolStep(run.messages, i, tokens)
    const sends: Msg[][] = []
    for (let s = 0; s <= STEPS; s++) {
      sends.push(request(run, window, pick))
      toolStep(run.messages, before + s, tokens)
    }
    return sends
  }

  it('a run of many small steps, past the message count cap: the shape of E8b', () => {
    // 500 messages of about 100 tokens: far under every token budget, over
    // the 380 messages a request may carry.
    expect(hits(oneRun('Refactor the project, file by file.', 250, 100, 400000, 200000))).toBeGreaterThanOrEqual(18)
  })

  it('one long run, at least 18 of 20 steps', () => {
    expect(hits(oneRun('Refactor the project, file by file.', 70, 700))).toBeGreaterThanOrEqual(18)
  })

  it('a run whose task is a very long message, at least 18 of 20 steps', () => {
    expect(hits(oneRun(text(1, 40000), 30, 300))).toBeGreaterThanOrEqual(18)
  })

  it('many short turns: every turn starts from the stored conversation again', () => {
    // The stored conversation keeps everything. Each turn is one step with a
    // tool call and one with the answer.
    const stored: Msg[] = [{ role: 'system', content: text(0, 400) }, { role: 'user', content: 'Help me with this project.' }]
    for (let i = 0; i < 70; i++) toolStep(stored, i, 700)
    stored.push({ role: 'assistant', content: 'Done so far.' })
    const sends: Msg[][] = []
    for (let turn = 0; sends.length <= STEPS; turn++) {
      stored.push({ role: 'user', content: `And now part ${turn}.` })
      const run = { messages: stored.slice() }
      sends.push(request(run))
      toolStep(run.messages, 500 + turn, 700)
      sends.push(request(run))
      run.messages.push({ role: 'assistant', content: `Part ${turn} is done.` })
      // What the run added goes into the store whole, whatever the run trimmed.
      stored.push(...run.messages.slice(-3))
    }
    expect(hits(sends.slice(0, STEPS + 1))).toBeGreaterThanOrEqual(18)
  })
})

describe('the parts', () => {
  it('the block does not move with a budget that moves a little', () => {
    expect(stableDropBlock(160000)).toBe(stableDropBlock(158500))
    expect(stableDropBlock(160000)).toBeGreaterThan(160000 * 0.24)
    expect(stableDropBlock(160000)).toBeLessThanOrEqual(160000 * 0.3)
  })

  it('the cut is the first mark behind which the rest fits, and new messages move no mark', () => {
    const sizes = new Array(40).fill(100)
    const rest = (list: number[], at: number) => list.slice(at).reduce((a, b) => a + b, 0)
    const cutOf = (list: number[]) => stableCutIndex(list, 1000, list.length - 4, (at) => rest(list, at) <= 2500)
    expect(cutOf(sizes)).toBe(20)
    expect(cutOf([...sizes, 100, 100, 100, 100, 100])).toBe(20)
    expect(cutOf([...sizes, ...new Array(6).fill(100)])).toBe(30)
  })

  it('a shortened turn keeps a rung of the ladder', () => {
    expect(steadyKeep(5000)).toBe(steadyKeep(4500))
    expect(steadyKeep(5000)).toBeLessThanOrEqual(5000)
    expect(steadyKeep(5000)).toBeGreaterThan(5000 / 1.5 - 2)
  })

  it('the trim engages before the last check does', () => {
    const budget = fit.budgetBelowTheFit(51200, 64000, 3000, true)
    expect(Math.floor(budget * COMPACT_TRIGGER_RATIO) + 3000).toBeLessThanOrEqual(64000 - fit.answerRoom(64000))
    // A small send window on a large model is left alone.
    expect(fit.budgetBelowTheFit(32768, 262144, 3000, true)).toBe(32768)
  })
})
