/**
 * 3.0.7, Windows run d307-k (B5b): a plain chat on a 32K window in English
 * words the tokenizer packs cheaply. The send budget measures with the token
 * estimate (about 1.4 times the real count on this text) and trimmed old
 * turns at about 21,000 real tokens; auto compact reads the server's own
 * count and would have fired at about 25,500. So the trim always came first
 * and no summary was ever written.
 *
 * Now plain chat asks the budget first (sendBudgetWouldTrim) and auto compact
 * runs when the trim is imminent, whatever the ratio says.
 *
 * Run: npx vitest run src/lib/__tests__/auto-compact-vor-dem-kuerzen.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldAutoCompact, resolveCompactThreshold } from '../compact-trigger'
import { sendBudgetWouldTrim, applyChatSendBudget } from '../chat-send-budget'
import { cheapWords } from './token-estimate-samples'

/** Real Qwen2.5 tokens of one cheapWords() message (llama-tokenize). */
const REAL_WORDS = 2307
const WINDOW = 32768
const input = { providerId: 'openai', modelWindow: WINDOW, contextDecay: true, localBackend: true }

function chat(turns: number) {
  const msgs: { role: string; content: string }[] = [{ role: 'system', content: 'You are the user\'s own model.' }]
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: cheapWords() })
    if (i < turns - 1) msgs.push({ role: 'assistant', content: 'OK' })
  }
  return msgs
}

describe('the trim no longer runs instead of the summary', () => {
  // Turn 10 of the run, where the trim first cut: ten messages of words,
  // the last one just typed.
  const msgs = chat(10)
  const used = 10 * REAL_WORDS + 9 * 4
  const threshold = resolveCompactThreshold({}, WINDOW)!
  const base = {
    used,
    window: WINDOW,
    source: 'usage' as const,
    real: true,
    windowIsTrue: true,
    messageCount: msgs.length - 1,
    threshold,
  }

  it('the budget would trim this payload', () => {
    expect(sendBudgetWouldTrim(msgs, input)).toBe(true)
    expect(applyChatSendBudget(msgs, input).messages.length).toBeLessThan(msgs.length)
  })

  it('by the server\'s count the ratio is still below the threshold', () => {
    expect(shouldAutoCompact(base).reason).toBe('below')
  })

  it('with the trim imminent, auto compact fires first', () => {
    const verdict = shouldAutoCompact({ ...base, trimImminent: true })
    expect(verdict.shouldCompact).toBe(true)
    expect(verdict.reason).toBe('over')
  })

  it('NEGATIVE CONTROL: off, too short and cooldown still say no', () => {
    expect(shouldAutoCompact({ ...base, threshold: undefined, trimImminent: true }).reason).toBe('off')
    // Below three there is nothing older to summarise. From three on a full
    // chat may compact (CA, 14.11.2026, a-full-context-never-ends-silently).
    expect(shouldAutoCompact({ ...base, messageCount: 2, trimImminent: true }).reason).toBe('too-short')
    expect(shouldAutoCompact({ ...base, lastCompactAtMessageCount: base.messageCount - 1, trimImminent: true }).reason).toBe('cooldown')
    expect(shouldAutoCompact({ ...base, window: 0, trimImminent: true }).reason).toBe('no-window')
  })

  it('NEGATIVE CONTROL: a short chat is not reported as a trim', () => {
    expect(sendBudgetWouldTrim(chat(3), input)).toBe(false)
  })

  it('NEGATIVE CONTROL: with the contextDecay notaus nothing is trimmed, so nothing is imminent', () => {
    expect(sendBudgetWouldTrim(msgs, { ...input, contextDecay: false })).toBe(false)
  })
})

describe('wiring', () => {
  const src = (...p: string[]) => readFileSync(resolve(__dirname, '..', '..', ...p), 'utf8')

  it('plain chat asks the budget before auto compact and hands the answer on', () => {
    const chatSrc = src('hooks', 'useChat.ts')
    const probe = chatSrc.indexOf('const trimImminent = sendBudgetWouldTrim(')
    const compact = chatSrc.indexOf('await maybeAutoCompact({', probe)
    // Since the phone line the budget is skipped where the phone's own rule cuts (phoneOwnsFit).
    const budget = chatSrc.indexOf('const budgetedBySendWindow = phoneOwnsFit ? candidate : applyChatSendBudget(', compact)
    expect(probe).toBeGreaterThan(0)
    expect(compact).toBeGreaterThan(probe)
    expect(budget).toBeGreaterThan(compact)
    expect(chatSrc.slice(compact, budget)).toMatch(/trimImminent,/)
  })

  it('maybeAutoCompact passes it to the verdict', () => {
    expect(src('lib', 'run-compact-command.ts')).toMatch(/trimImminent: opts\.trimImminent/)
  })
})
