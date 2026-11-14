/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// CA audit (14.11.2026): the Architect pass in Code is one paid model call
// per plan, and it was the last agent step on LU Cloud outside the hour.
const chatWithTools = vi.fn()
vi.mock('../../providers', () => ({
  getProviderForModel: (name: string) => ({ provider: { chatWithTools }, modelId: name }),
}))
vi.mock('../../../lib/agent-core/credit-rates', () => ({
  creditRatesOf: (m: string) => (m === 'lu-cloud::paid' ? { inputPerMillion: 1_000, outputPerMillion: 4_000 } : null),
  billingOf: () => undefined,
}))

import { planWithArchitect } from '../architect'
import { _resetCreditLedger, hourCredits } from '../../../lib/agent-core/credit-ledger'

beforeEach(() => {
  chatWithTools.mockReset()
  _resetCreditLedger()
})

describe('the Architect plan step', () => {
  it('counts its credits toward the hour on a priced model', async () => {
    chatWithTools.mockResolvedValueOnce({ content: '## Plan', toolCalls: [], promptEvalCount: 20_000, evalCount: 1_000 })
    await planWithArchitect({ model: 'lu-cloud::paid', userInstruction: 'x', workingDirectory: '/w' })
    expect(hourCredits()).toBeCloseTo(24, 5) // 20k × 1000/M + 1k × 4000/M
  })

  it('counts nothing on a model without a price', async () => {
    chatWithTools.mockResolvedValueOnce({ content: '## Plan', toolCalls: [], promptEvalCount: 20_000, evalCount: 1_000 })
    await planWithArchitect({ model: 'ollama::local', userInstruction: 'x', workingDirectory: '/w' })
    expect(hourCredits()).toBe(0)
  })
})
