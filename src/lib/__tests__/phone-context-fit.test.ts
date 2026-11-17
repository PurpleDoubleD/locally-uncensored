/**
 * Mobile, acceptance on Android with 8 GB, B1: a tool result must never push a
 * request past the window of the model on a phone.
 *
 * Run: npx vitest run src/lib/__tests__/phone-context-fit.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let phone = true
vi.mock('../capabilities', async (orig) => ({ ...(await orig() as object), singleModelSlot: () => phone }))

import {
  fitRequestForPhone, fitToWindow, phoneFitApplies, phonePromptLimit, phoneResultChars, phoneTokens,
  PHONE_AGED_RESULT_CHARS,
} from '../phone-context-fit'
import { CONTEXT_OVERFLOW_DETAIL, isContextOverflow } from '../context-overflow'
import { viewAnswer } from '../message-error'

interface Msg { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }

const words = (n: number, word = 'Iceland') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')
const sizeOf = (list: Msg[]) => list.reduce((sum, m) => sum + phoneTokens(m.content) + 6 + (m.tool_calls ? phoneTokens(JSON.stringify(m.tool_calls)) : 0), 0)

/** The run of the acceptance: tool list in the system prompt, a search, then a page of 24 000 characters. */
function researchRun(pageChars = 24000): Msg[] {
  return [
    { role: 'system', content: `You are a function calling AI model.\n<tools>\n${'x'.repeat(5500)}\n</tools>` },
    { role: 'user', content: 'Use web search: what is the current population of Iceland?' },
    { role: 'assistant', content: '<tool_call>\n{"name": "web_search", "arguments": {"query": "population of Iceland"}}\n</tool_call>' },
    { role: 'user', content: `<tool_response>\n${words(220, 'hit')}\n</tool_response>` },
    { role: 'assistant', content: '<tool_call>\n{"name": "web_fetch", "arguments": {"url": "https://www.worldometers.info/world-population/iceland-population/", "maxLength": 24000}}\n</tool_call>' },
    { role: 'user', content: `<tool_response>\nTitle: Iceland Population\nStatus: 200\n\n${'The population of Iceland is 398,266. '.repeat(Math.ceil(pageChars / 37)).slice(0, pageChars)}\nEND OF PAGE\n</tool_response>` },
  ]
}

beforeEach(() => { phone = true })

describe('the estimate errs on the careful side', () => {
  it('counts more tokens than characters by four, and a character outside ASCII as one token', () => {
    const text = 'The population of Iceland is 398,266 as of today.'
    expect(phoneTokens(text)).toBeGreaterThan(Math.ceil(text.length / 4))
    expect(phoneTokens('日本語のページ')).toBe(7)
    expect(phoneTokens('')).toBe(0)
  })

  it('keeps the reserve of the engine free: 512 of 4096, a quarter of a smaller window', () => {
    // 128 on top since round 9: the frame of the template and what the estimate misses.
    expect(phonePromptLimit(4096)).toBe(4096 - 512 - 128)
    expect(phonePromptLimit(2048)).toBe(2048 - 512 - 128)
    expect(phonePromptLimit(1024)).toBe(1024 - 256 - 128)
  })
})

describe('B1: a page read by the agent fits the window of the phone', () => {
  it('the run of the acceptance is cut to the window, the page keeps its head and its end', () => {
    const run = researchRun()
    expect(sizeOf(run)).toBeGreaterThan(4096)
    const fit = fitToWindow(run, 4096)
    expect(fit.changed).toBe(true)
    expect(fit.over).toBe(false)
    expect(fit.tokens).toBeLessThanOrEqual(phonePromptLimit(4096))
    expect(sizeOf(fit.messages)).toBe(fit.tokens)
    // Nothing is dropped: the system prompt word for word, the question, both calls, both results.
    expect(fit.messages).toHaveLength(run.length)
    expect(fit.messages[0]).toBe(run[0])
    expect(fit.messages[1]).toBe(run[1])
    const page = fit.messages[5].content
    expect(page.startsWith('<tool_response>\nTitle: Iceland Population')).toBe(true)
    expect(page.endsWith('END OF PAGE\n</tool_response>')).toBe(true)
    expect(page).toContain('[truncated ')
    // Round 9: this page is a number in every sentence, and a digit is a
    // token. What is left of it is shorter than it was at 3.3 characters per
    // token, and it now really fits (phone-token-estimate.test.ts).
    expect(page.length).toBeGreaterThan(1500)
    // The input is not touched: the chat keeps the whole result.
    expect(run[5].content.length).toBeGreaterThan(24000)
  })

  it('a result of an earlier step is cut to a few lines before the fresh one loses anything', () => {
    const run = researchRun()
    const fit = fitToWindow(run, 4096)
    expect(fit.messages[3].content.length).toBeLessThanOrEqual(PHONE_AGED_RESULT_CHARS + 64)
    expect(fit.messages[3].content.length).toBeLessThan(fit.messages[5].content.length)
  })

  it('a request that fits comes back as the same array', () => {
    const run = researchRun(900)
    run[3] = { role: 'user', content: '<tool_response>\nThree results about Iceland and its population.\n</tool_response>' }
    const fit = fitToWindow(run, 4096)
    expect(fit.changed).toBe(false)
    expect(fit.messages).toBe(run)
  })

  it('fits for every window a phone may open, and for pages in other scripts', () => {
    for (const ctx of [1024, 2048, 3072, 4096, 8192]) {
      const run = researchRun()
      if (ctx <= 2048) run[0] = { role: 'system', content: 'Short system prompt.' }
      const fit = fitToWindow(run, ctx)
      expect(fit.over, String(ctx)).toBe(false)
      expect(fit.tokens, String(ctx)).toBeLessThanOrEqual(phonePromptLimit(ctx))
    }
    const cjk = researchRun()
    cjk[5] = { role: 'user', content: `<tool_response>\n${'人口は三十九万人です。'.repeat(2000)}\n</tool_response>` }
    const fit = fitToWindow(cjk, 4096)
    expect(fit.over).toBe(false)
    expect(fit.tokens).toBeLessThanOrEqual(phonePromptLimit(4096))
  })

  it('native tool results (role tool) are cut the same way, several fresh ones share the room', () => {
    const run: Msg[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Read both pages.' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'web_fetch', arguments: '{"url":"https://a.example"}' } }, { id: 'b', function: { name: 'web_fetch', arguments: '{"url":"https://b.example"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: words(4000, 'a') },
      { role: 'tool', tool_call_id: 'b', content: words(4000, 'b') },
    ]
    const fit = fitToWindow(run, 4096, 900)
    expect(fit.over).toBe(false)
    expect(fit.tokens).toBeLessThanOrEqual(phonePromptLimit(4096) - 900)
    const [a, b] = [fit.messages[3].content, fit.messages[4].content]
    expect(Math.abs(a.length - b.length)).toBeLessThan(200)
    expect(fit.messages[2]).toBe(run[2])
  })

  it('a long chat loses its oldest turns, never the system prompt and never the question being answered', () => {
    const run: Msg[] = [{ role: 'system', content: 'You are an agent.' }]
    for (let i = 0; i < 12; i++) {
      run.push({ role: 'user', content: `Question ${i}: ${words(120, 'q')}` })
      run.push({ role: 'assistant', content: `Answer ${i}: ${words(160, 'a')}` })
    }
    run.push({ role: 'user', content: 'The question being answered now.' })
    run.push({ role: 'assistant', content: '<tool_call>\n{"name": "file_read", "arguments": {"path": "notes.md"}}\n</tool_call>' })
    run.push({ role: 'user', content: `<tool_response>\n${words(300, 'line')}\n</tool_response>` })
    const fit = fitToWindow(run, 4096)
    expect(fit.over).toBe(false)
    expect(fit.messages[0]).toBe(run[0])
    expect(fit.messages[1].role).toBe('user')
    expect(fit.messages.map((m) => m.content)).toContain('The question being answered now.')
    expect(fit.messages.at(-1)!.content).toContain('<tool_response>')
    expect(fit.messages.length).toBeLessThan(run.length)
    // What stays alternates as a strict chat template wants it: no answer right behind the system prompt.
    expect(fit.messages.some((m) => m.content.startsWith('Question 0'))).toBe(false)
  })

  it('one question longer than the window is cut as the last resort', () => {
    const run: Msg[] = [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: `Summarise this: ${words(6000, 'w')}` },
    ]
    const fit = fitToWindow(run, 4096)
    expect(fit.over).toBe(false)
    expect(fit.messages[1].content.startsWith('Summarise this:')).toBe(true)
  })

  it('says so when the system prompt alone is longer than the window', () => {
    const run: Msg[] = [{ role: 'system', content: words(8000, 's') }, { role: 'user', content: 'Hi' }]
    expect(fitToWindow(run, 2048).over).toBe(true)
  })
})

describe('only on a phone, only for the window of a phone', () => {
  it('a desktop gets its array back untouched and keeps its own numbers', () => {
    phone = false
    const run = researchRun()
    expect(phoneFitApplies(4096)).toBe(false)
    expect(fitRequestForPhone(run, 4096)).toBe(run)
    expect(phoneResultChars(4096, 60000)).toBe(60000)
    expect(phoneResultChars(4096, 1500)).toBe(1500)
  })

  it('a cloud model on a phone has room and is left alone', () => {
    const run = researchRun()
    expect(phoneFitApplies(131072)).toBe(false)
    expect(fitRequestForPhone(run, 131072)).toBe(run)
    expect(phoneResultChars(131072, 60000)).toBe(60000)
  })

  it('on a phone a result enters the run at a share of the window, small model mode keeps its tighter number', () => {
    expect(phoneResultChars(4096, 60000)).toBe(Math.floor(4096 * 0.35 * 3.3))
    expect(phoneResultChars(4096, 1500)).toBe(1500)
    expect(phoneResultChars(1024, 60000)).toBe(Math.floor(1024 * 0.35 * 3.3))
    expect(fitRequestForPhone(researchRun(), 4096)).not.toHaveLength(0)
    expect(sizeOf(fitRequestForPhone(researchRun(), 4096))).toBeLessThanOrEqual(phonePromptLimit(4096))
  })
})

describe('when it happened anyway: a true sentence with a way out', () => {
  const ENGINE = 'the request exceeds the available context size (4289 prompt tokens, context 4096)'

  it('knows the sentence of the engine and of the usual servers', () => {
    expect(isContextOverflow(ENGINE)).toBe(true)
    expect(isContextOverflow("This model's maximum context length is 8192 tokens")).toBe(true)
    expect(isContextOverflow('Connection failed')).toBe(false)
    expect(isContextOverflow('')).toBe(false)
  })

  it('the agent error of the acceptance is shown as what happened, without token counts', () => {
    const view = viewAnswer({ content: `I looked it up.\n\nAgent error: ${ENGINE}` })
    expect(view.body).toBe('I looked it up.')
    expect(view.error).toEqual({ kind: 'generic', detail: CONTEXT_OVERFLOW_DETAIL })
    expect(CONTEXT_OVERFLOW_DETAIL).not.toMatch(/\d/)
    expect(CONTEXT_OVERFLOW_DETAIL).toContain('Start a new chat')
  })

  it('the same for the field of the chat hook and for an "Error:" tail', () => {
    expect(viewAnswer({ content: '', error: { kind: 'generic', detail: ENGINE, at: 0 } }).error?.detail).toBe(CONTEXT_OVERFLOW_DETAIL)
    expect(viewAnswer({ content: `Error: ${ENGINE}` }).error?.detail).toBe(CONTEXT_OVERFLOW_DETAIL)
  })

  it('another error keeps its own reason', () => {
    expect(viewAnswer({ content: 'Agent error: something else broke' }).error?.detail).toBe('something else broke')
  })
})

describe('the agent loop asks', () => {
  const hook = readFileSync(resolve(__dirname, '../../hooks/useAgentChat.ts'), 'utf8')

  it('fits the request right before it goes out, after the builder of the desktop', () => {
    const built = hook.indexOf('const built = buildRequestMessages(stepWindow')
    const fit = hook.indexOf('sendMessages = fitRequestForPhone(sendMessages, agentCtx, 0, runQuestion, phoneMeasured)')
    const sent = hook.indexOf("if (strategy === 'native') {", fit)
    expect(built).toBeGreaterThan(0)
    expect(fit).toBeGreaterThan(built)
    expect(sent).toBeGreaterThan(fit)
  })

  it('reads the question before the loop appends a message of its own with the role user', () => {
    const begun = hook.indexOf('let agentMessages: ChatMessage[] = [')
    const asked = hook.indexOf('const runQuestion = questionOf(agentMessages)')
    expect(begun).toBeGreaterThan(0)
    expect(asked).toBeGreaterThan(begun)
    // Nothing is pushed between the build of the run and the reading of the question.
    expect(hook.slice(begun, asked)).not.toContain('agentMessages.push(')
    expect(hook.indexOf('agentMessages.push(', asked)).toBeGreaterThan(asked)
  })

  it('hands the count of the engine for the first request of the first request to the fit, from both ways a turn can come back (round 9)', () => {
    expect(hook).toContain('phoneMeasured = measuredRequest(sendMessages, promptTokens)')
    expect(hook).toContain('notePhoneCount(turn.promptEvalCount)')
    expect(hook).toContain('notePhoneCount(hermesTurn.promptEvalCount)')
  })

  it('caps a result where it enters the run, with the numbers of the desktop as the fallback', () => {
    expect(hook).toContain('truncateToolResult(text, phoneResultChars(agentCtx, resultCharsFor(agentProfile)))')
  })
})
