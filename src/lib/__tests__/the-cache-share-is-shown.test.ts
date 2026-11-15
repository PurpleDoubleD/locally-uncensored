/**
 * CA (14.11.2026): customers paid full price on every step of long agent runs
 * with no prompt-cache hit, and nothing in the app showed it. The cache share
 * the backend reports is now read and shown under the answer.
 */
import { describe, it, expect } from 'vitest'
import { addCallUsage, requestUsageLine } from '../request-usage'
import { cachedPromptTokensOf } from '../../api/providers/openai-provider'

describe('cachedPromptTokensOf', () => {
  it('reads both spellings, and nothing from nothing', () => {
    expect(cachedPromptTokensOf({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } })).toBe(80)
    expect(cachedPromptTokensOf({ prompt_tokens: 100, prompt_cache_hit_tokens: 64 })).toBe(64)
    expect(cachedPromptTokensOf({ prompt_tokens: 100 })).toBe(0)
    expect(cachedPromptTokensOf(null)).toBe(0)
  })
})

describe('the line under an answer', () => {
  it('sums the cached share over the calls and shows it', () => {
    let u = addCallUsage(undefined, { promptEvalCount: 20_000, evalCount: 300, cachedPromptCount: 0 })
    u = addCallUsage(u, { promptEvalCount: 22_000, evalCount: 300, cachedPromptCount: 19_800 })
    u = addCallUsage(u, { promptEvalCount: 24_000, evalCount: 300, cachedPromptCount: 21_900, billing: 'credits' })
    expect(u!.cachedTokens).toBe(41_700)
    const line = requestUsageLine(u)!
    expect(line.text).toBe('66,000 in · 900 out · 63% cached · Credits')
    expect(line.title).toMatch(/41,700 of the input tokens came from the model's prompt cache/)
  })

  it('says nothing about a cache nobody reported', () => {
    const u = addCallUsage(undefined, { promptEvalCount: 1000, evalCount: 10 })
    expect(u!.cachedTokens).toBeUndefined()
    expect(requestUsageLine(u)!.text).not.toMatch(/cached/)
  })

  it('never claims more cached than sent', () => {
    const u = addCallUsage(undefined, { promptEvalCount: 100, evalCount: 1, cachedPromptCount: 500 })
    expect(u!.cachedTokens).toBe(100)
  })
})
