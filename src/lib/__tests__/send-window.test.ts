/**
 * A2: the cost ceiling for one sent step, and the meter that has to be honest
 * about it (2.6.6 plan).
 *
 * Before this, a 262k-context cloud model let a coding step grow to 209k tokens
 * and every step of a long run was billed at that size, while the token counter
 * divided by 262k and sat green at 25 percent. Both halves are tested here: the
 * budget itself, and the denominator the user sees.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  effectiveSendWindow,
  isPaidProvider,
  DEFAULT_SEND_WINDOW_TOKENS, budgetBesideTheCatalog, MIN_MESSAGE_BUDGET } from '../send-window'
import { computeContextFill } from '../token-usage'
import { DEFAULT_SETTINGS } from '../constants'
import { useSendSizeStore } from '../../stores/sendSizeStore'

describe('A2: the paid-provider send cap', () => {
  it('gives a 262k cloud model a 64k budget, not 209k', () => {
    const budget = effectiveSendWindow({ providerId: 'lu-cloud', modelWindow: 262144 })
    expect(budget).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('the decay switch does not lift the cap on a paid provider any more (CA, 14.11.2026)', () => {
    // Decay off used to mean 0.8 of the window, 209k per step on this model.
    // The support logs of that week show runs sending 120-278k per paid step.
    const budget = effectiveSendWindow({
      providerId: 'lu-cloud',
      modelWindow: 262144,
      capEnabled: false,
    })
    expect(budget).toBe(DEFAULT_SEND_WINDOW_TOKENS)
  })

  it('negative control: a local backend still gets 0.8 of its window', () => {
    const budget = effectiveSendWindow({ providerId: 'ollama', modelWindow: 262144, capEnabled: false })
    expect(budget).toBe(Math.floor(262144 * 0.8))
  })

  it('never RAISES a small model to the cap', () => {
    // 32k model: 0.8 x 32768 = 26214, well under 64k, so the cap does nothing.
    expect(effectiveSendWindow({ providerId: 'lu-cloud', modelWindow: 32768 }))
      .toBe(Math.floor(32768 * 0.8))
  })

  it('leaves a local Ollama model exactly where it was', () => {
    for (const window of [8192, 32768, 262144]) {
      expect(effectiveSendWindow({ providerId: 'ollama', modelWindow: window }))
        .toBe(Math.floor(window * 0.8))
    }
  })

  it('applies to every provider that bills, and to no other', () => {
    expect(isPaidProvider('lu-cloud')).toBe(true)
    expect(isPaidProvider('openai')).toBe(true)
    expect(isPaidProvider('anthropic')).toBe(true)
    expect(isPaidProvider('ollama')).toBe(false)
  })

  it('lets a power user raise the ceiling', () => {
    expect(effectiveSendWindow({
      providerId: 'lu-cloud',
      modelWindow: 262144,
      sendWindowTokens: 120000,
    })).toBe(120000)
  })

  it('keeps Small-Model Mode tighter than the cap', () => {
    expect(effectiveSendWindow({
      providerId: 'lu-cloud',
      modelWindow: 262144,
      smallModelMode: true,
    })).toBe(6000)
  })

  it('survives a model whose window is unknown', () => {
    expect(effectiveSendWindow({ providerId: 'lu-cloud', modelWindow: 0 })).toBe(0)
  })
})

describe('A2: the shipped defaults', () => {
  it('ships the cap at 32K and the decay switch on', () => {
    expect(DEFAULT_SETTINGS.codexSendWindowTokens).toBe(32768)
    expect(DEFAULT_SETTINGS.contextDecay).toBe(true)
  })
})

describe('A2 meter honesty: the numerator is what was actually built', () => {
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 } },
  ]

  it('uses the built-request size over the usage anchor', () => {
    const fill = computeContextFill(msgs, { tokens: 58000, atMessageCount: 2 })
    expect(fill.source).toBe('built')
    expect(fill.used).toBe(58000)
  })

  it('adds messages that arrived after the request was built', () => {
    const later = [...msgs, { role: 'user', content: 'a'.repeat(400) }]
    const fill = computeContextFill(later, { tokens: 58000, atMessageCount: 2 })
    expect(fill.used).toBeGreaterThan(58000)
    expect(fill.used).toBeLessThan(58200)
  })

  it('falls back to the usage anchor when nothing was built yet', () => {
    expect(computeContextFill(msgs).source).toBe('usage')
  })

  it('ignores a stale report that names more messages than exist', () => {
    const fill = computeContextFill(msgs, { tokens: 58000, atMessageCount: 99 })
    expect(fill.source).toBe('usage')
  })
})

describe('A2: the counter divides by the send window', () => {
  const src = readFileSync(
    resolve(__dirname, '..', '..', 'components', 'chat', 'TokenCounter.tsx'),
    'utf8',
  )

  // There is no render harness in this repo, so the wiring is guarded at the
  // source, the way host-platform.test.ts guards the prompt.
  it('takes its denominator from ctx.sendWindow, not ctx.contextWindow', () => {
    expect(src).toMatch(
      /const window = ctx\.sendWindow > 0 \? ctx\.sendWindow : ctx\.contextWindow/,
    )
    expect(src).toMatch(/const maxTokens = window\n/)
    // No stand-in denominator any more: an unknown window shows no counter
    // (Gegenprobe 01.10.2026, "18/16K" then "30/32K").
    expect(src).not.toMatch(/: 16384/)
    expect(src).toMatch(/if \(ctx\.sendWindow <= 0 && ctx\.contextWindow <= 0\) return null/)
  })

  it('feeds the built-request size in as the numerator', () => {
    expect(src).toMatch(/useSendSizeStore/)
    expect(src).toMatch(/atMessageCount: sent\.atMessageCount/)
  })

  it('explains the cap and the decay in the tooltip', () => {
    expect(src).toMatch(/a step sends at most/)
    expect(src).toMatch(/older than the newest step go out shortened/)
  })
})

describe('A2 meter honesty: the tool catalog is part of the request', () => {
  const step = {
    tokens: 732,
    window: 64000,
    atMessageCount: 2,
    trimmedResults: 0,
    savedChars: 0,
  }

  beforeEach(() => {
    useSendSizeStore.setState({ byConv: {} })
  })

  it('the builder reports the messages, the router reports the catalog', () => {
    const store = useSendSizeStore.getState()
    store.report('c1', step)
    expect(useSendSizeStore.getState().get('c1')!.toolsTokens).toBe(0)
    store.reportTools('c1', 1856)
    const entry = useSendSizeStore.getState().get('c1')!
    expect(entry.tokens).toBe(732)
    expect(entry.toolsTokens).toBe(1856)
  })

  it('the next step keeps the catalog while its own router is still running', () => {
    const store = useSendSizeStore.getState()
    store.report('c1', step)
    store.reportTools('c1', 1856)
    store.report('c1', { ...step, tokens: 9000, atMessageCount: 6 })
    // A reset to zero here would dip the meter by the whole catalog once per
    // step, for as long as the embedding router takes.
    expect(useSendSizeStore.getState().get('c1')!.toolsTokens).toBe(1856)
  })

  it('a catalog for a conversation that never built anything is dropped', () => {
    useSendSizeStore.getState().reportTools('ghost', 1856)
    expect(useSendSizeStore.getState().get('ghost')).toBeUndefined()
  })

  it('the counter adds the catalog to its numerator', () => {
    const src = readFileSync(
      resolve(__dirname, '..', '..', 'components', 'chat', 'TokenCounter.tsx'),
      'utf8',
    )
    expect(src).toMatch(/tokens: sent\.tokens \+ sent\.toolsTokens/)
  })

  it('the numerator really moves by the catalog, it is not a cosmetic field', () => {
    const msgs = [
      { role: 'user', content: 'refactor the parser' },
      { role: 'assistant', content: '' },
    ]
    const withoutCatalog = computeContextFill(msgs, { tokens: 732, atMessageCount: 2 })
    const withCatalog = computeContextFill(msgs, { tokens: 732 + 1856, atMessageCount: 2 })
    expect(withCatalog.used - withoutCatalog.used).toBe(1856)
  })
})

describe('sendWindowFor: the per-model pick from the context dropdown', () => {
  it('a pick for this model wins, other models keep the default', async () => {
    const { sendWindowFor } = await import('../send-window')
    const settings = { codexSendWindowTokens: 32768, cloudSendWindowByModel: { 'lu-cloud::Kimi': 131072 } }
    expect(sendWindowFor(settings, 'lu-cloud::Kimi')).toBe(131072)
    expect(sendWindowFor(settings, 'lu-cloud::GLM')).toBe(32768)
    expect(sendWindowFor({ codexSendWindowTokens: 32768 }, 'lu-cloud::Kimi')).toBe(32768)
  })
})

describe('the tool catalogue has its place in the window', () => {
  it('box, 09.10.2026: 80 % of a 32K window for the messages plus a 7K catalogue was more than the window', () => {
    const messages = effectiveSendWindow({ providerId: 'openai', modelWindow: 32768, localBackend: true })
    expect(messages).toBe(26214)
    const beside = budgetBesideTheCatalog(messages, 6955)
    expect(beside).toBe(26214 - 6955)
    // Even at the point where compaction starts (15 % over), messages and catalogue fit.
    expect(beside * 1.15 + 6955).toBeLessThan(32768)
  })

  it('never takes the messages below their minimum and never adds to the budget', () => {
    expect(budgetBesideTheCatalog(8000, 7000)).toBe(MIN_MESSAGE_BUDGET)
    expect(budgetBesideTheCatalog(3000, 7000)).toBe(3000)
    expect(budgetBesideTheCatalog(26214, 0)).toBe(26214)
    expect(budgetBesideTheCatalog(26214, Number.NaN)).toBe(26214)
  })
})
