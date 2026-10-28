/**
 * A4 wiring: the three conversation surfaces actually go through the budget,
 * and the two agent loops inherit the image rule without being touched.
 *
 * There is no render harness for these hooks in this repo, so the contract is
 * guarded at the source the way decay-wiring.test.ts guards A1/A2. These are
 * exactly the lines a well-meaning refactor undoes for free: sending
 * `chatMessages` instead of the budgeted copy leaves compare uncapped while
 * every unit test still passes, and resolving the budget from anything other
 * than the provider id would quietly put a ceiling on local backends.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', ...p), 'utf8')
const chat = read('useChat.ts')
const compare = read('useABCompare.ts')
const decay = read('..', 'lib', 'context-decay.ts')
const codex = read('useCodex.ts')
const agent = read('useAgentChat.ts')

describe('plain chat sends under the A2 budget', () => {
  it('routes the built array through the budget', () => {
    expect(chat).toMatch(/applyChatSendBudget\(/)
    expect(chat).toMatch(/sendWindowTokens: sendWindowFor\(settings, \w+\)/)
  })

  it('keeps the message-count cap as the second barrier', () => {
    expect(chat).toMatch(/capMessageCount\(\[/)
  })

  it('resolves the cap from the provider, so local backends stay uncapped', () => {
    expect(chat).toMatch(/providerId,\n\s+modelWindow:/)
  })

  it('honours the contextDecay notaus', () => {
    expect(chat).toMatch(/contextDecay: settings\.contextDecay/)
  })
})

describe('a group round is budgeted per model', () => {
  it('resolves the window for the model whose turn it is', () => {
    const groupTurn = chat.slice(
      chat.indexOf('async function runGroupTurn'),
      chat.indexOf('export function useChat'),
    )
    expect(groupTurn).toMatch(/applyChatSendBudget\(/)
    expect(groupTurn).toMatch(/await getChatWindowTokens\(model\)/)
    expect(groupTurn).toMatch(/capMessageCount\(\[/)
    expect(groupTurn).toMatch(/contextDecay: settings\.contextDecay/)
  })

  it('names the multiplier above the composer', () => {
    const view = read('..', 'components', 'chat', 'ChatView.tsx')
    expect(view).toMatch(/<GroupCostHint \/>/)
  })
})

describe('compare caps the shared base before the fan-out', () => {
  it('takes the tightest budget of the two sides', () => {
    expect(compare).toMatch(/sharedChatSendBudget\(/)
    // GH #201: with the hysteresis only where a side is paid.
    expect(compare).toMatch(/applySendBudget\(chatMessages, budget, \{ hysteresis, notice: 'chat' \}\)/)
  })

  it('streams the budgeted array to BOTH sides, not the raw history', () => {
    expect(compare.match(/chatStream\(modelId, sendMessages,/g)).toHaveLength(2)
    expect(compare).not.toMatch(/chatStream\(modelId, chatMessages,/)
  })

  it('honours the contextDecay notaus', () => {
    expect(compare).toMatch(/contextDecay: settings\.contextDecay/)
  })

  it('does not spend a context lookup on a pairing it cannot cap', () => {
    expect(compare).toMatch(/chatBudgetApplies\(providerId, settings\.contextDecay\)/)
    expect(chat).toMatch(/chatBudgetApplies\(providerId, settings\.contextDecay\)/)
  })
})

describe('the agent and coding loops get the image rule for free', () => {
  it('the rule lives in the shared builder, not in the hooks', () => {
    expect(decay).toMatch(/ageOutImages\(/)
    expect(codex).not.toMatch(/ageOutImages\(/)
    expect(agent).not.toMatch(/ageOutImages\(/)
  })

  it('both loops still build their request through it', () => {
    expect(codex).toMatch(/buildRequestMessages\(/)
    expect(agent).toMatch(/buildRequestMessages\(/)
  })

  it('the rule is behind the same notaus as the decay', () => {
    expect(decay).toMatch(/opts\.enabled !== false && opts\.ageImages !== false/)
  })
})
