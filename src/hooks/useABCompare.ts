/**
 * A/B Compare Hook: sends the same prompt to two models in parallel.
 */

import { sendWindowFor } from '../lib/send-window'
import { useCallback, useRef } from 'react'
import { useCompareStore } from '../stores/compareStore'
import { useSettingsStore } from '../stores/settingsStore'
import { getProviderForModel, getProviderIdFromModel } from '../api/providers'
import { getChatWindowTokens } from '../lib/context-compaction'
import { applySendBudget, chatBudgetApplies, chatBudgetHysteresis, sharedChatSendBudget } from '../lib/chat-send-budget'
import { sendsToALanBackend } from '../lib/lan-openai-slot'
import { buildChatSystemPrompt } from '../lib/system-prompt'
import { v4 as uuid } from 'uuid'
import type { ChatMessage } from '../api/providers/types'
import type { Message } from '../types/chat'
import { createThinkStreamSplitter } from '../lib/hermes-stream'
import { settleThinking } from '../lib/thinking-stripper'
import { isThinkingCompatible } from '../lib/model-compatibility'
import { buildSamplingRequest } from '../lib/sampling'
import { runInLane } from '../lib/run-slot'
import { laneOf, currentLaneFacts } from '../lib/run-lane-of-model'
import { useGenerationStore } from '../stores/generationStore'

/**
 * Booking identity for the local lane, standing in for a `conversationId`.
 *
 * Runde 5 (review-lanes.md Runde 2, Nachtrag nach dem Grep-Audit dieser
 * Runde): A/B Compare fires two genuine `provider.chatStream` calls per
 * round, one per model, entirely outside `run-lanes.ts`. If both sides
 * resolve to the local lane (the same shared, one-slot built-in engine),
 * `Promise.all([streamA(), streamB()])` sent both at once against that one
 * slot, the exact VRAM-swap this module exists to prevent, just triggered
 * from the Compare pane instead of the composer. Even with only ONE local
 * side, the round needs to book the lane so it does not race a separate,
 * unrelated local conversation running elsewhere in the app. A fixed,
 * single id is enough, the same reasoning as `useBenchmark.ts`'s
 * `BENCHMARK_LANE_ID`: the Compare pane disables its own Send button while
 * a round is in flight (`isStreaming`), so this id is never held by two
 * Compare rounds at once.
 */
export const COMPARE_LANE_ID = 'lib:ab-compare'

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
    //
    // R2-8, zweite Haelfte, Entscheid vom 12.09.2026: der Vergleich
    // schickt KEINE Person mehr mit, nur die Frage. Er nahm bis dahin die
    // global gewaehlte Person ohne Nachfrage, waehrend der Chat sie je
    // Unterhaltung unterdrueckt. Wer zwei Modelle nebeneinander stellt, will
    // die Modelle vergleichen; eine Rolle, die beide Seiten gleich faerbt und
    // im Vergleichsfenster nirgends zu sehen ist, verfaelscht genau das.
    //
    // Der Hausteil bleibt. Ohne Systemtext antwortet ein Modell aus der
    // Haltung seines Anbieters, und ein Vergleich, dessen beide Seiten so
    // antworten, vergleicht nicht LU. `buildChatSystemPrompt({})` ist genau
    // der Grundtext ohne Person, denselben schickt der Chat ohne Person.
    const chatMessages: ChatMessage[] = []
    chatMessages.push({ role: 'system', content: buildChatSystemPrompt({}) })

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
              ? await getChatWindowTokens(m)
              : 0,
            sendWindowTokens: sendWindowFor(settings, m),
            contextDecay: settings.contextDecay,
            localBackend: sendsToALanBackend(providerId, m),
            answerTokens: settings.maxTokens,
          }
        }),
      ),
    )
    // GH #201: two local sides are trimmed to their budget and no deeper, and
    // the note they read is a conversation's, not an agent's.
    const hysteresis = [modelA, modelB].some((m) => {
      const id = getProviderIdFromModel(m)
      return chatBudgetHysteresis({ providerId: id, localBackend: sendsToALanBackend(id, m) })
    })
    const sendMessages = applySendBudget(chatMessages, budget, { hysteresis, notice: 'chat' }).messages

    // R5-10/R5-11: Compare has no conversation of its own (compareStore, not
    // chatStore), so there is no per-chat override to read; only the "omit a
    // field still at the app default" half of the rule applies here.
    const opts = {
      ...buildSamplingRequest(settings),
      topK: settings.topK,
      // Both sides run in the chat window of their model, like a chat turn.
      window: 'chat' as const,
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

    // Runde 5: the round holds the local lane whenever either side touches
    // it. Two models that BOTH resolve to local would otherwise fire at the
    // one-slot built-in engine at the same time; those two run one after the
    // other, still under the SAME held booking (not queued behind each
    // other, which would just lock the round out against itself). A mixed
    // or all-cloud pairing keeps the original parallel behaviour, since at
    // most one side ever touches the shared engine.
    const facts = currentLaneFacts()
    const laneA = laneOf(modelA, facts)
    const laneB = laneOf(modelB, facts)
    const bothLocal = laneA === 'local' && laneB === 'local'
    const lane = laneA === 'local' || laneB === 'local' ? 'local' : 'cloud'

    await runInLane(
      {
        conversationId: COMPARE_LANE_ID,
        lane,
        abort: () => { abortA.current?.abort(); abortB.current?.abort() },
      },
      async () => {
        if (bothLocal) {
          await streamA()
          await streamB()
        } else {
          await Promise.all([streamA(), streamB()])
        }
      },
    )
  }, [settings, store])

  const stopCompare = useCallback(() => {
    abortA.current?.abort()
    abortB.current?.abort()
    // Reaches a round still queued on the local lane behind a running
    // conversation: at that point neither stream has started, so the two
    // lines above alone do nothing. `abortConversation` calls the abort
    // callback `runInLane` registered at admission time, which for a
    // queued run dequeues it instead of aborting streams that do not exist
    // yet (see run-slot.ts).
    useGenerationStore.getState().abortConversation(COMPARE_LANE_ID)
    store.setStreamingA(false)
    store.setStreamingB(false)
  }, [store])

  return { sendCompare, stopCompare }
}
