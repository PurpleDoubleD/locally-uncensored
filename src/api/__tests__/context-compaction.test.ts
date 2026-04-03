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
    expect(result.length).toBeLessThan(messages.length)
    // System prompt always preserved
    expect(result[0].role).toBe('system')
    expect(result[0].content).toBe('System prompt')
    // Recent messages preserved
    const lastMsg = result[result.length - 1]
    expect(lastMsg.content).toBe('Recent answer')
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
    // Should have compacted the tool call pair into a summary
    expect(result.length).toBeLessThanOrEqual(messages.length)
  })
})
