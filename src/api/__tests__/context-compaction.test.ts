/**
 * Context Compaction Tests
 *
 * Tests token estimation, message compaction, and provider-aware context limits.
 * Run: npx vitest run src/api/__tests__/context-compaction.test.ts
 */
import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessageTokens, compactMessages } from '../../lib/context-compaction'
import type { OllamaChatMessage } from '../../types/agent-mode'

// ── Token Estimation ────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello world')).toBeGreaterThanOrEqual(3)
    expect(estimateTokens('hello world')).toBeLessThanOrEqual(5)
  })

  it('empty string returns 1 (overhead)', () => {
    expect(estimateTokens('')).toBe(1)
  })

  it('long text scales linearly', () => {
    const short = estimateTokens('hello')
    const long = estimateTokens('hello'.repeat(100))
    // 500 chars / 4 ≈ 126 tokens, short ≈ 3 tokens → ratio ~42x (not exactly 100x due to overhead)
    expect(long).toBeGreaterThan(short * 20)
  })
})

describe('estimateMessageTokens', () => {
  it('sums tokens across messages', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]
    const total = estimateMessageTokens(messages)
    expect(total).toBeGreaterThan(0)
  })

  it('includes role overhead', () => {
    const withContent = estimateMessageTokens([{ role: 'user', content: 'hi' }])
    const withEmpty = estimateMessageTokens([{ role: 'user', content: '' }])
    expect(withContent).toBeGreaterThan(withEmpty)
  })

  it('includes tool call overhead', () => {
    const withoutTools = estimateMessageTokens([{ role: 'assistant', content: 'hi' }])
    const withTools = estimateMessageTokens([{
      role: 'assistant',
      content: 'hi',
      tool_calls: [{ function: { name: 'web_search', arguments: { query: 'test' } } }],
    }])
    expect(withTools).toBeGreaterThan(withoutTools)
  })
})

// ── Message Compaction ──────────────────────────────────────────

describe('compactMessages', () => {
  it('returns messages unchanged if within budget', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]
    const result = compactMessages(messages, 10000)
    expect(result).toEqual(messages)
  })

  it('compacts old messages when over budget', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'First question with lots of text '.repeat(50) },
      { role: 'assistant', content: 'First answer with lots of text '.repeat(50) },
      { role: 'user', content: 'Second question with lots of text '.repeat(50) },
      { role: 'assistant', content: 'Second answer with lots of text '.repeat(50) },
      { role: 'user', content: 'Recent question' },
      { role: 'assistant', content: 'Recent answer' },
    ]
    const result = compactMessages(messages, 200)
    // The token load shrinks; the message COUNT may not, because the pinned
    // task (audit C5) rides along where dropped content used to be.
    expect(estimateMessageTokens(result)).toBeLessThan(estimateMessageTokens(messages))
    // System prompt always preserved
    expect(result[0].role).toBe('system')
    expect(result[0].content).toBe('System prompt')
    // The ORIGINAL TASK is pinned right after the system prompt (audit C5) —
    // before the pin, the oldest message was exactly the first to be dropped,
    // so a long run forgot what it was asked to do.
    expect(result[1].role).toBe('user')
    expect(result[1].content).toContain('First question')
    // Recent messages preserved
    const lastMsg = result[result.length - 1]
    expect(lastMsg.content).toBe('Recent answer')
  })

  it('caps a giant pinned task instead of carrying it forever', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'fix this file: ' + 'x'.repeat(50_000) },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
        content: `Message ${i} `.repeat(80),
      })),
    ]
    const result = compactMessages(messages, 500)
    const pinned = result[1]
    expect(pinned.role).toBe('user')
    expect(pinned.content).toContain('fix this file')
    expect(pinned.content.length).toBeLessThan(10_000)
  })

  it('does not duplicate the task when it already survived into the suffix', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'the only question' },
      { role: 'assistant', content: 'Answer '.repeat(400) },
    ]
    const result = compactMessages(messages, 120)
    const userCopies = result.filter((m) => m.role === 'user' && m.content.includes('the only question'))
    expect(userCopies.length).toBe(1)
  })

  it('preserves system prompt always', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'Important system prompt' },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with lots of content `.repeat(20),
      })),
    ]
    const result = compactMessages(messages, 100)
    expect(result[0].role).toBe('system')
    expect(result[0].content).toBe('Important system prompt')
  })

  it('keeps at least KEEP_RECENT messages', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'user', content: 'old '.repeat(500) },
      { role: 'assistant', content: 'old reply '.repeat(500) },
      { role: 'user', content: 'recent 1' },
      { role: 'assistant', content: 'recent 2' },
      { role: 'user', content: 'recent 3' },
      { role: 'assistant', content: 'recent 4' },
    ]
    const result = compactMessages(messages, 100)
    // Last 4 messages should be preserved
    expect(result.some(m => m.content === 'recent 4')).toBe(true)
  })

  it('handles tool call + result pairs in compaction', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'search for cats' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'web_search', arguments: { query: 'cats' } } }],
      },
      { role: 'tool', content: 'Found 10 results about cats...' },
      { role: 'assistant', content: 'Here are the results about cats.' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'welcome' },
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: 'new answer' },
    ]
    const result = compactMessages(messages, 50)
    // Oldest messages (incl. the tool call pair) are dropped, not summarized.
    expect(result.length).toBeLessThanOrEqual(messages.length)
  })

  it('keeps a recent tool result verbatim — never a char-truncated slice', () => {
    // A file the agent read must survive compaction intact, or the model edits
    // against content it can no longer see.
    const bigResult = 'export const config = {\n' + '  key: "value",\n'.repeat(60) + '}'
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old '.repeat(400) },
      { role: 'assistant', content: 'old '.repeat(400) },
      { role: 'user', content: 'read the config' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_read', arguments: { path: 'config.ts' } } }] },
      { role: 'tool', content: bigResult },
      { role: 'assistant', content: 'done' },
    ]
    const result = compactMessages(messages, 150)
    const toolMsg = result.find((m) => m.role === 'tool')
    // Full content, not a 80-char summary line.
    expect(toolMsg?.content).toBe(bigResult)
  })

  it('drops oldest messages behind a notice, not a lossy summary', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `msg ${i} ${'x'.repeat(200)}`,
      })),
      { role: 'user', content: 'latest' },
    ]
    const result = compactMessages(messages, 120)
    // Real system prompt stays first.
    expect(result[0].content).toBe('sys')
    // A trim notice is present (not a "[Previous conversation summary]") and
    // it rides inside user material: a system message mid conversation makes
    // strict Jinja templates raise "System message must be at the beginning"
    // (Discord #bug-reports 2026-08-21).
    expect(result.some((m) => m.role === 'user' && m.content.includes('trimmed to fit'))).toBe(true)
    expect(result.some((m, i) => m.role === 'system' && i > 0)).toBe(false)
    // Newest message preserved verbatim.
    expect(result[result.length - 1].content).toBe('latest')
  })
})

// ── Oversized tool results (2.5.10) ────────────────────────────────
// KEEP_RECENT keeps the newest messages even over budget — before the cap,
// one giant file_read result rode along VERBATIM in every request (live
// 2026-07-26: ~225k-token prompts against a 6.5k trim target).

describe('compactMessages — oversized tool results', () => {
  const giant = 'A'.repeat(3000) + 'M'.repeat(6000) + 'Z'.repeat(3000) // 12k chars

  const history = (): OllamaChatMessage[] => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old '.repeat(400) },
    { role: 'assistant', content: 'old '.repeat(400) },
    { role: 'user', content: 'read it' },
    { role: 'tool', content: giant },
    { role: 'assistant', content: 'done' },
  ]

  it('caps a giant kept tool result head+tail instead of keeping it verbatim', () => {
    const messages = history()
    const result = compactMessages(messages, 150)
    const toolMsg = result.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content.length).toBeLessThan(giant.length)
    expect(toolMsg!.content).toMatch(/truncated \d+ chars/)
    // Head and tail survive — that is where the signal lives.
    expect(toolMsg!.content.startsWith('AAAA')).toBe(true)
    expect(toolMsg!.content.endsWith('ZZZZ')).toBe(true)
    // The caller's array is never mutated.
    expect(messages[4].content).toBe(giant)
  })

  it('never caps user or assistant text, only tool results', () => {
    const bigUser = 'u'.repeat(9000)
    const messages: OllamaChatMessage[] = [
      { role: 'user', content: 'old '.repeat(400) },
      { role: 'assistant', content: 'old '.repeat(400) },
      { role: 'user', content: bigUser },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: 'sure' },
    ]
    const result = compactMessages(messages, 150)
    expect(result.some((m) => m.content === bigUser)).toBe(true)
  })

  it('touches nothing while the history is within budget', () => {
    const messages = history()
    expect(compactMessages(messages, 100000)).toEqual(messages)
  })

  it('caps Hermes-style <tool_response> results carried on user messages too', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'user', content: 'old '.repeat(400) },
      { role: 'assistant', content: 'old '.repeat(400) },
      { role: 'assistant', content: 'reading' },
      { role: 'user', content: `<tool_response>${giant}</tool_response>` },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ]
    const result = compactMessages(messages, 150)
    const carrier = result.find((m) => typeof m.content === 'string' && m.content.includes('<tool_response>'))
    expect(carrier).toBeDefined()
    expect(carrier!.content.length).toBeLessThan(giant.length)
  })

  it('the trim notice no longer instructs a blanket re-read', () => {
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `msg ${i} ${'x'.repeat(200)}`,
      })),
    ]
    const result = compactMessages(messages, 120)
    // The notice rides user material since the Jinja fix, never role:system.
    const notice = result.find((m) => m.role === 'user' && m.content.includes('trimmed to fit'))
    expect(notice).toBeDefined()
    // The old wording ("Re-read any file you still need with file_read.")
    // actively FED the re-read loop.
    expect(notice!.content).not.toContain('Re-read any file you still need')
    expect(notice!.content).toMatch(/never repeat a call/)
  })
})

// ── Message-count ceiling (2026-08-21) ────────────────
// A chat of many SHORT turns sits under every token budget while the count
// grows past the LU Cloud proxy's 400-message gate; from then on every send
// 400s ("too many messages") and the chat is a permanent dead end. The cap
// must fire on COUNT alone.

import { MAX_SEND_MESSAGES, capMessageCount } from '../../lib/context-compaction'

describe('message-count ceiling', () => {
  const tiny = (n: number): OllamaChatMessage[] => [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    })),
  ]

  it('compactMessages shrinks a count-heavy history even under the token budget', () => {
    const messages = tiny(450)
    // Huge token budget: the OLD code returned this unchanged.
    const out = compactMessages(messages, 10_000_000)
    expect(out.length).toBeLessThanOrEqual(MAX_SEND_MESSAGES)
    expect(out[0].role).toBe('system')
    expect(out[out.length - 1].content).toBe('m449')
  })

  it('compactMessages leaves a history under both budgets alone', () => {
    const messages = tiny(100)
    expect(compactMessages(messages, 10_000_000)).toEqual(messages)
  })

  it('count trim announces itself like a token trim, riding user material', () => {
    const out = compactMessages(tiny(450), 10_000_000)
    // The notice rides inside a user message since the Jinja fix: a system
    // message mid conversation makes strict chat templates raise "System
    // message must be at the beginning" (Discord #bug-reports 2026-08-21).
    // A count-driven trim announces itself exactly like a token-driven one.
    const notice = out.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('trimmed'),
    )
    expect(notice).toBeTruthy()
    expect(out.some((m, i) => m.role === 'system' && i > 0)).toBe(false)
  })

  it('capMessageCount keeps system prompt and the newest messages', () => {
    const out = capMessageCount(tiny(450))
    // 3.1.1: the oldest go in whole blocks of 64, so the start of the request
    // stands still for the next sends instead of moving by one each time.
    expect(out.length).toBeLessThanOrEqual(MAX_SEND_MESSAGES)
    expect(out.length).toBeGreaterThan(MAX_SEND_MESSAGES - 64)
    expect(out[1].content).toBe(capMessageCount([...tiny(450), { role: 'user', content: 'one more' }])[1].content)
    expect(out[0].content).toBe('sys')
    expect(out[out.length - 1].content).toBe('m449')
  })

  it('capMessageCount never starts the window on an orphan tool result', () => {
    const msgs: OllamaChatMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 500 }, (_, i) => ({
        role: (i % 2 === 0 ? 'assistant' : 'tool') as 'assistant' | 'tool',
        content: `m${i}`,
      })),
    ]
    const out = capMessageCount(msgs)
    expect(out[1].role).not.toBe('tool')
    expect(out.length).toBeLessThanOrEqual(MAX_SEND_MESSAGES)
  })

  it('capMessageCount is the identity under the ceiling', () => {
    const messages = tiny(50)
    expect(capMessageCount(messages)).toBe(messages)
  })
})
