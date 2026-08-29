/**
 * A/B Compare Hook — sends the same prompt to two models in parallel.
 */

import { useCallback, useRef } from 'react'
import { useCompareStore } from '../stores/compareStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { getModelMaxTokens } from '../lib/context-compaction'
import { applySendBudget, chatBudgetApplies, sharedChatSendBudget } from '../lib/chat-send-budget'
import { v4 as uuid } from 'uuid'
import type { ChatMessage } from '../api/providers/types'
import type { Message } from '../types/chat'
import { createThinkStreamSplitter } from '../lib/hermes-stream'
import { settleThinking } from '../lib/thinking-stripper'
import { isThinkingCompatible } from '../lib/model-compatibility'

export function useABCompare() {
  const store = useCompareStore()
  const settings = useSettingsStore((s) => s.settings)
  const abortA = useRef<AbortController | null>(null)
  const abortB = useRef<AbortController | null>(null)

  const sendCompare = useCallback(async (text: string) => {
    const { modelA, modelB } = useCompareStore.getState()
    if (!modelA || !modelB || !text.trim()) return

    const userMessage: Message = {
      id: uuid(),
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    }

    store.startRound(userMessage)

    // Build messages for the providers
    const persona = useSettingsStore.getState().getActivePersona()
    const chatMessages: ChatMessage[] = []
    if (persona?.prompt) {
      chatMessages.push({ role: 'system', content: persona.prompt })
    }

    // Include previous messages for context
    const prevMessages = useCompareStore.getState().messagesA.slice(0, -1) // exclude the empty assistant msg
    for (const m of prevMessages) {
      chatMessages.push({ role: m.role as 'user' | 'assistant', content: m.content })
    }

    // Send budget on the SHARED base, before the fan-out (plan A4). Compare was
    // the only surface with no cap of any kind: it sent the full history to two
    // models on every round, so a long comparison billed history level twice
    // per question and grew without end. Capping the shared array rather than
    // each side keeps the comparison honest, since two models that were handed
    // different prompts are not being compared at all. A mixed pairing takes
    // the paid side's budget for both; two local models are untouched.
    const budget = sharedChatSendBudget(
      await Promise.all(
        [modelA, modelB].map(async (m) => {
          const providerId = getProviderIdFromModel(m)
          return {
            providerId,
            // Two local models must not buy two /api/show round trips for a
            // budget that will come back null either way.
            modelWindow: chatBudgetApplies(providerId, settings.contextDecay)
              ? await getModelMaxTokens(m)
              : 0,
            sendWindowTokens: settings.codexSendWindowTokens,
            contextDecay: settings.contextDecay,
          }
        }),
      ),
    )
    const sendMessages = applySendBudget(chatMessages, budget).messages

    const opts = {
      temperature: settings.temperature,
      topP: settings.topP,
      topK: settings.topK,
      maxTokens: settings.maxTokens || undefined,
      // Bug AA v2.5.0 — forward num_ctx override to both A/B sides.
      contextWindow: settings.contextWindowOverride || undefined,
    }
    // 2.6.7 Denk-Audit, Loch 6: this hook sent no thinking signal at all and
    // stripped nothing, so a comparison ran on whatever the backend defaulted
    // to and the raw <think> block was part of what the user compared. Both
    // sides get the same tri-state the plain chat sends, per model, because a
    // line-up can mix a reasoner with an instruct model.
    const thinkOptFor = (model: string): boolean | undefined =>
      isThinkingCompatible(model) ? settings.thinkingEnabled === true : undefined

    // Stream Model A
    abortA.current = new AbortController()
    const streamA = async () => {
      const startTime = Date.now()
      let fullContent = ''
      let tokenCount = 0
      // The pane has no thinking block, so reasoning is never part of what
      // is being compared: it is split out of the live stream and the
      // end-of-turn settlement catches the pre-opened shape the splitter
      // cannot see coming.
      const splitter = createThinkStreamSplitter()
      const show = (part: { prose: string }) => {
        if (!part.prose) return
        fullContent += part.prose
        useCompareStore.getState().addContentA(part.prose)
      }
      try {
        const { provider, modelId } = getProviderForModel(modelA)
        const stream = provider.chatStream(modelId, sendMessages, {
          ...opts, thinking: thinkOptFor(modelA), signal: abortA.current!.signal,
        })
        for await (const chunk of stream) {
          if (chunk.content) {
            tokenCount++
            show(splitter.feed(chunk.content))
          }
        }
        show(splitter.flush())
      } catch { /* aborted or error */ }
      fullContent = settleThinking(fullContent, '', false).content
      const elapsed = Date.now() - startTime
      useCompareStore.getState().finishA(fullContent, {
        tokens: tokenCount,
        timeMs: elapsed,
        tokensPerSec: elapsed > 0 ? (tokenCount / elapsed) * 1000 : 0,
      })
    }

    // Stream Model B
    abortB.current = new AbortController()
    const streamB = async () => {
      const startTime = Date.now()
      let fullContent = ''
      let tokenCount = 0
      // The pane has no thinking block, so reasoning is never part of what
      // is being compared: it is split out of the live stream and the
      // end-of-turn settlement catches the pre-opened shape the splitter
      // cannot see coming.
      const splitter = createThinkStreamSplitter()
      const show = (part: { prose: string }) => {
        if (!part.prose) return
        fullContent += part.prose
        useCompareStore.getState().addContentB(part.prose)
      }
      try {
        const { provider, modelId } = getProviderForModel(modelB)
        const stream = provider.chatStream(modelId, sendMessages, {
          ...opts, thinking: thinkOptFor(modelB), signal: abortB.current!.signal,
        })
        for await (const chunk of stream) {
          if (chunk.content) {
            tokenCount++
            show(splitter.feed(chunk.content))
          }
        }
        show(splitter.flush())
      } catch { /* aborted or error */ }
      fullContent = settleThinking(fullContent, '', false).content
      const elapsed = Date.now() - startTime
      useCompareStore.getState().finishB(fullContent, {
        tokens: tokenCount,
        timeMs: elapsed,
        tokensPerSec: elapsed > 0 ? (tokenCount / elapsed) * 1000 : 0,
      })
    }

    // Run both in parallel
    await Promise.all([streamA(), streamB()])
  }, [settings, store])

  const stopCompare = useCallback(() => {
    abortA.current?.abort()
    abortB.current?.abort()
    store.setStreamingA(false)
    store.setStreamingB(false)
  }, [store])

  return { sendCompare, stopCompare }
}
