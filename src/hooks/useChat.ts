import { useState, useCallback, useEffect } from "react"
import { create } from "zustand"
import { frameFlush } from '../lib/frame-flush'
import { sendWindowFor } from '../lib/send-window'
import { markCannotThink } from '../lib/model-compatibility'
import { v4 as uuid } from "uuid"
import { questionOnDisk, useChatStore } from "../stores/chatStore"
import { errorText } from "../types/json-guards"
import { endTurnDurably } from "../stores/durability"
import { useModelStore } from "../stores/modelStore"
import { chatToolsReach } from "../lib/chat-tools-reach"
import { useSettingsStore } from "../stores/settingsStore"
import { conversationChunksNow, useRAGStore } from "../stores/ragStore"
import { useMemoryStore } from "../stores/memoryStore"
import { useVoiceStore } from "../stores/voiceStore"
import { useRunActivityStore, readingActivity, endFirstWait, hiddenThoughtArrived, waitForChatCard } from "../stores/runActivityStore"
import { autoSpeak } from "../lib/ttsBridge"
import { retrieveContext } from "../api/rag"
import { NO_EMBED_MODEL_MOBILE_MESSAGE, isSingleSlotConflict } from "../lib/model-slot"
import { singleModelSlot } from "../lib/capabilities"
import { continuesInPlace, markContinuation, wireForContinue, withLead } from "../lib/continue-answer"
import { isMobile } from "../lib/device-kind"
import { withoutUnansweredTurns } from "../lib/unanswered-turns"
import { fitChatForPhone, meterOfFit, phoneFitApplies } from "../lib/phone-context-fit"
import { usePhoneMeterStore } from "../stores/phoneMeterStore"
import { explicitSearchQuery } from "../lib/explicit-search"
import { isSearchStopped, waitForSlotOrStop } from "../lib/slot-wait"
import { sourcesFromChunks } from "../lib/rag-sources"
import { buildRagSuffix, RETRIEVAL_FAILED_MESSAGE } from "../lib/rag-prompt"
import { buildTurnContext, withTurnContext } from "../lib/turn-context"
import { getChatWindowTokens, capMessageCount, compactMessages, compactMessagesWithCount, estimateMessageTokens } from "../lib/context-compaction"
import { contextOverflowOf, shrunkSendWindow } from "./codex/context-overflow"
import { applyChatSendBudget, chatBudgetApplies, sendBudgetWouldTrim } from "../lib/chat-send-budget"
import { sendsToALanBackend } from "../lib/lan-openai-slot"
import { isTooManyMessagesError, halveHistory, TOO_MANY_MESSAGES_MAX_HALVINGS } from "../lib/too-many-messages"
import { requestGenerationCancel } from "../api/vram-handoff"
import { useAgentChat } from "./useAgentChat"
import { parseAgentCommand, parseLoopSpec } from '../lib/agent-commands'
import { runCompactForConversation, compactOutcomeMessage, maybeAutoCompact } from '../lib/run-compact-command'
import { autoCompactOn } from '../lib/compact-trigger'
import { applyStoredCompaction } from '../lib/compact-summary'
import { planResend } from '../lib/resend-plan'
import { isOrphanRun } from '../lib/orphan-run'
import { applyGoalCommand } from '../lib/goal-command'
import { useMemory } from "./useMemory"
import { yieldMemoryLearning } from "../lib/memory-learning-yield"
import { useAgentModeStore } from "../stores/agentModeStore"
import { useGenerationStore } from "../stores/generationStore"
import { runInLane } from "../lib/run-slot"
import { laneOf, currentLaneFacts } from "../lib/run-lane-of-model"
import { yieldSilentRunsTo } from "../lib/silent-runs-yield"
import { yieldSilentLocalRuns } from "../lib/silent-runs"
import { resolveChatToolRoute, CHAT_TOOLS, type ChatToolRouteMsg } from "../lib/chat-tool-intent"
import { localMediaToolsExist } from "../lib/mobile-tools"
import { asksForLocalFiles, LOCAL_FILES_NOTICE } from "../lib/local-file-intent"
import { useChatNoticeStore } from "../stores/chatNoticeStore"
import { getProviderForModel, getProviderIdFromModel } from "../api/providers"
import { modelOutOfMode } from "../lib/modeGate"
import { syncOllamaHealthFromError } from "../lib/sync-ollama-health"
import { isThinkingCompatible, isPlainTextPlanner, declaredVision, modelNameSuggestsVision } from "../lib/model-compatibility"
import { stripNonCanonicalTags, finalStripThinkingTags, settleThinking } from "../lib/thinking-stripper"
import { isLocalModelByName } from "../api/agents/model-locality"
import { isMultimodalUnsupportedError, MULTIMODAL_UNSUPPORTED_MESSAGE } from "../lib/ollama-errors"
import type { ImageAttachment, Message } from "../types/chat"
import { fileMessageFields, filesWithoutWorkspace, type ChatFileInput } from "../lib/chat-files"
import { fitFilesForSend, requestTextOf } from "./chat-file-room"
import { isGroupChat, availableGroupMembers, groupSystemPrompt, groupHistory, groupSpeakers, stripImpersonatedSpeakers, hasGroupHistory, soloSpeakers, soloTurnAuthorFields, soloHistoryTag, SOLO_HISTORY_LINE } from "../lib/group-chat"
import { explainSendRefusal } from "../lib/template-refusal"
import { laterAnswersInRound, nextRoundSpeakers, regenerateSpeakers, copiesForNewVersion } from "../lib/group-rounds"
import { groupTurnStarted, groupRoundEnded } from "../stores/groupRoundStore"
import { forkStart } from "../lib/chat-forks"
import { builtinReloadNeeded, ensureBuiltinEngineAlive } from "../api/builtin-ensure"
import { emptyAnswerExplanation } from "../lib/answer-notes"
import { beginModelSwitchWatch, cutByModelSwitch, finishReasonAfterSwitch, MODEL_SWITCH_FINISH } from "../lib/model-switch-stop"
import { log } from "../lib/logger"
import { CREDITS_EXHAUSTED_MESSAGE } from '../lib/credits-exhausted'
import { messageErrorFor } from '../lib/message-error'
import { thinkingClock } from '../lib/thinking-clock'
import { shouldDowngradeThinking, engineDeniedThinking } from './codex/thinking-downgrade'
import { ProviderError } from '../api/providers/types'
import { useBackgroundAgentWake } from './useBackgroundAgentWake'
import { buildChatSystemPrompt } from '../lib/system-prompt'
import { withChatPersona, speakerSamplingOptions, plainChatSpeaker, speakerPersonaFor } from '../lib/chat-persona'
import { personaNoteOf } from '../lib/persona-note'
import { toolRegistry } from '../api/mcp'
import { syncCreateTools } from '../api/mcp/create-tools'
import { isSettingsToolName, SETTINGS_TOOL_NAMES } from '../lib/settings-tool-names'
import { asksAboutSettings } from '../lib/tool-selection'
import { CREATE_TOOL_NAMES, createSystemText, withCreateText } from '../lib/create/chat-switch'
// Create in chat only where the order card exists: not on the phone (lib/create-order-surface.ts).
import { createActiveHere, createLiveHere } from '../lib/create-order-surface'
import { decideCreateReply, ordersInView } from '../lib/create/chat-control'
import { applyCreateReply, setCreateFollowUp, type FollowUpMode } from '../lib/create/chat-run'
import { useCreateOrderStore } from '../stores/createOrderStore'
import { pendingMediaOf, type PendingMedia } from '../lib/create/chat-attachments'
import { watchOrderResults } from '../lib/create/chat-gallery'
import { lastRequestUsageNotice, requestUsageTracker } from '../lib/request-usage'

/** First half of RETRIEVAL_FAILED_MESSAGE, in front of a reason the phone knows. */
const RETRIEVAL_FAILED_PREFIX = "Your documents could not be searched for this message, so the answer was written without them. "

/**
 * Pull the most recent media generation (image/video) out of an assistant
 * message's agent blocks, with the exact args used. Lets the chat-tools router
 * reproduce the SAME media for a bare "nochmal"/"again" follow-up. Reads both
 * the v2.4+ `toolCalls` array and the legacy singular `toolCall`.
 */
function lastMediaFromBlocks(m: Message): { kind: 'image' | 'video'; args?: Record<string, unknown> } | null {
  if (!m.agentBlocks?.length) return null
  for (let i = m.agentBlocks.length - 1; i >= 0; i--) {
    const b = m.agentBlocks[i]
    const calls = b.toolCalls?.length ? b.toolCalls : (b.toolCall ? [b.toolCall] : [])
    for (let j = calls.length - 1; j >= 0; j--) {
      const name = calls[j].toolName
      if (name === 'video_generate') return { kind: 'video', args: calls[j].args }
      if (name === 'image_generate') return { kind: 'image', args: calls[j].args }
    }
  }
  return null
}

/** A11: the message is about LU's settings, or answers a question the model
 *  asked while it was reading or changing one ("80", "yes, dark"). */
export function wantsSettingsTools(content: string, history: readonly Message[]): boolean {
  if (asksAboutSettings(content)) return true
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')
  return !!lastAssistant?.agentBlocks?.some((b) =>
    (b.toolCalls?.length ? b.toolCalls : b.toolCall ? [b.toolCall] : []).some((c) => isSettingsToolName(c.toolName)))
}

/** One model's turn in a group round. Deliberately the PLAIN conversation
 *  path only: no RAG, no memory injection, no chat-tools, no caveman. The
 *  group is talk between models; every knob it skips belongs to the
 *  single-model paths and their tests. */
async function runGroupTurn(convId: string, model: string, allModels: string[], abort: AbortController) {
  const { settings } = useSettingsStore.getState()
  const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
  if (!conv) return
  const { personas, activePersonaId } = useSettingsStore.getState()
  // `allModels` is who takes a turn this round: a member whose model left the
  // list sits out (GH #165) and is neither asked nor named to the others.
  const speakers = groupSpeakers(allModels, conv.groupPersonas, personas)

  const assistantMessage: Message = {
    id: uuid(),
    role: 'assistant',
    content: '',
    thinking: '',
    modelId: model,
    // GH #169: the turn remembers the persona it was written as, so it stays
    // that persona's when another model takes the persona over.
    ...(speakers[model]?.personaId
      ? { groupPersonaId: speakers[model].personaId, groupSpeakerName: speakers[model].name }
      : {}),
    timestamp: Date.now(),
  }
  useChatStore.getState().addMessage(convId, assistantMessage)

  // Der Grundtext gilt unabhaengig vom Personenschalter: der Schalter
  // entscheidet ueber die PERSON, nicht darueber, ob ueberhaupt ein Systemtext
  // rausgeht. Siehe lib/system-prompt.ts.
  //
  // 3.0.5 (Discord): a participant can have a persona of its own.
  // Then ITS prompt is that persona and the others are named to it, so two
  // models no longer answer as the same character. A participant without one
  // gets the chat's persona setting, exactly as before.
  //
  // Not gated on the Personas switch in Settings, for the same reason the
  // line for the chat's own persona below never was in a group: that switch
  // is off by default, and a persona picked for one participant in this
  // chat's group menu is as explicit as a choice gets. Picking "Chat persona"
  // there takes it back.
  const ownPersona = speakers[model]?.personaPrompt
  const personaPrompt = ownPersona !== undefined
    ? buildChatSystemPrompt({ systemPrompt: ownPersona, personaEnabled: true })
    : buildChatSystemPrompt(withChatPersona(conv, personas, activePersonaId))
  const providerId = getProviderIdFromModel(model)
  // Same count cap as the plain path: a long group chat must not outgrow the
  // proxy's message gate either.
  //
  // And the same TOKEN budget, per model per round (plan A4, GELTUNG). This is
  // the most multiplied surface in the app: one round sends the whole shared
  // history to two to four models, so an uncapped group chat bills history
  // level times N every time the user says anything. The budget is resolved per
  // model because the line-up can mix a 262k cloud model with a local one: the
  // paid member is held to the cost ceiling, the local one to 0.8 of its own
  // window (2.6.8, Compact-Schritt 2). Neither is skipped any more — a local
  // member with a small window was the one most likely to be silently
  // truncated in a group round, because it carries the same shared history as
  // the 262k model beside it.
  // GH #181: each member carries the reminder of the persona it plays, in
  // its own request only, by the same rule as its prompt and its sampling.
  const note = personaNoteOf(speakerPersonaFor(conv, model, personas, activePersonaId, true))
  // Only asked where the answer can change something — which, since the
  // notaus is now the only thing that closes the gate, means: unless the
  // user switched capping off. The lookup is cached per model, so a group
  // round does not pay an /api/show per member per turn.
  //
  // GH #201: the window is THIS speaker's, as picked for its model, and a
  // local speaker's budget is that window less the answer's room
  // (chatSendBudget). It used to end at 0.56 of the window: 128K-131K of a
  // 256K pick, every round.
  const modelWindow = chatBudgetApplies(providerId, settings.contextDecay)
    ? await getChatWindowTokens(model)
    : 0
  const full = [
    { role: 'system' as const, content: groupSystemPrompt(model, allModels, personaPrompt, speakers) },
    ...groupHistory(conv.messages, model, speakers, { groupPersonas: conv.groupPersonas, personas }),
  ]
  const counted = capMessageCount([...full])
  const sent = applyChatSendBudget(counted, {
    note,
    providerId,
    modelWindow,
    sendWindowTokens: sendWindowFor(settings, model),
    contextDecay: settings.contextDecay,
    localBackend: sendsToALanBackend(providerId, model),
    answerTokens: settings.maxTokens,
    notice: 'chat',
  })
  let messages = sent.messages
  // Said in the chat, next to this answer: older turns did not go out.
  let dropped = full.length - counted.length + sent.droppedMessages
  const noteTrim = () => useChatStore.getState().updateMessageHistoryTrim(
    convId, assistantMessage.id, dropped > 0 ? { dropped, window: modelWindow } : null,
  )
  noteTrim()

  const canThink = isThinkingCompatible(model)
  const useThinking: boolean | undefined = canThink ? settings.thinkingEnabled === true : undefined
  const keepThinking = useThinking === true

  let contentAcc = ''
  let thinkingAcc = ''
  let inThink = false
  const thinkClock = thinkingClock((ms) => useChatStore.getState().updateMessageThinkingMs(convId, assistantMessage.id, ms))
  let discardBuf = ''
  const frames = frameFlush()
  let groupFinish: string | undefined
  // A model's own lines are untagged; a "[other-model]" tag in its OWN reply is
  // it speaking for someone else, which v1 must not show.
  // The others can show up under their model name or under their persona
  // name, so both spellings of the tag are cut.
  const others = allModels
    .filter((m) => m !== model)
    .flatMap((m) => (speakers[m].name === m ? [m] : [m, speakers[m].name]))
  // A stopped or skipped turn keeps what it had written. The stream is written
  // to the store once per frame, and a window in the background paints no
  // frames: on the Mac build a skipped speaker's words had never reached the
  // store, so the turn read as empty and was removed (GH #200).
  const keepWhatWasWritten = () => {
    if (abort.signal.aborted && contentAcc.trim()) {
      useChatStore.getState().updateMessageContent(convId, assistantMessage.id, stripImpersonatedSpeakers(stripNonCanonicalTags(contentAcc), others))
    }
  }

  try {
    // Local speakers share ONE engine process. llama-server holds a single
    // model and answers with it whatever the request's `model` field says, so
    // a group round used to send every speaker's turn to whichever model
    // happened to be loaded: the user saw two names and got one model
    // (counter-check on the Windows box, 2026-08-28). The engine loads this
    // speaker's model before its turn now.
    //
    // Announced first, because a swap stops and restarts llama-server and a
    // large GGUF takes long enough that a silent wait reads as a hang. The
    // line is overwritten by the first token, or by the empty-answer note if
    // no token ever comes.
    if (providerId === 'openai') {
      const toLoad = await builtinReloadNeeded(model)
      if (toLoad) {
        useChatStore.getState().updateMessageContent(
          convId,
          assistantMessage.id,
          `Loading ${toLoad} into the LU Engine for this turn...`,
        )
        await ensureBuiltinEngineAlive(model)
        // A stop during the load must not leave the loading line standing in
        // the bubble as if it were the model's answer.
        useChatStore.getState().updateMessageContent(convId, assistantMessage.id, '')
        if (abort.signal.aborted) return
      }
    }

    const { provider, modelId } = getProviderForModel(model)

    // GH #175: each member runs on the values of its own persona, the chat's
    // own Sampling values on top. Not gated on the Personas switch, the same
    // rule as the member's prompt above.
    const streamOpts = {
      ...speakerSamplingOptions(settings, conv, model, personas, activePersonaId, true),
      window: 'chat' as const,
      thinking: useThinking,
      signal: abort.signal,
    }
    // The same one retry as plain chat: the engine refused the prompt as
    // larger than its context, because its own count ran ahead of the
    // estimate. Cut once under what it named and send again; the refusal
    // comes before any token, so nothing shows twice.
    async function* streamWithOverflowRetry() {
      try {
        yield* provider.chatStream(modelId, messages, streamOpts)
      } catch (err) {
        const overflow = contextOverflowOf(err)
        if (!overflow) throw err
        type Wire = Parameters<typeof estimateMessageTokens>[0]
        const size = estimateMessageTokens(messages as unknown as Wire)
        const next = shrunkSendWindow(size, overflow, size)
        const cut = next !== null ? compactMessagesWithCount(messages as unknown as Wire, next, { notice: 'chat' }) : null
        if (!cut || cut.messages.length >= messages.length) throw err
        log.info('chat.group_context_overflow_retry', { sent: size, next, window: overflow.window, promptTokens: overflow.promptTokens, kept: cut.messages.length })
        messages = cut.messages as unknown as typeof messages
        dropped += cut.dropped
        noteTrim()
        yield* provider.chatStream(modelId, messages, streamOpts)
      }
    }
    const stream = streamWithOverflowRetry()

    for await (const chunk of stream) {
      if (abort.signal.aborted) break
      if (chunk.thinking && keepThinking) thinkingAcc += chunk.thinking
      if (chunk.content) {
        for (const char of chunk.content) {
          if (!inThink) {
            contentAcc += char
            if (contentAcc.endsWith('<think>')) {
              contentAcc = contentAcc.slice(0, -7)
              inThink = true
            }
          } else if (keepThinking) {
            thinkingAcc += char
            if (thinkingAcc.endsWith('</think>')) {
              thinkingAcc = thinkingAcc.slice(0, -8)
              inThink = false
            }
          } else {
            discardBuf += char
            if (discardBuf.endsWith('</think>')) {
              discardBuf = ''
              inThink = false
            }
          }
        }
      }
      thinkClock.tick(thinkingAcc, contentAcc)
      if (chunk.content || (chunk.thinking && keepThinking)) {
        frames.schedule(() => {
          useChatStore.getState().updateMessageContent(convId, assistantMessage.id, stripImpersonatedSpeakers(stripNonCanonicalTags(contentAcc), others))
          if (keepThinking && thinkingAcc) {
            useChatStore.getState().updateMessageThinking(convId, assistantMessage.id, thinkingAcc)
          }
        })
      }
      if (chunk.done) {
        frames.close()
        if (chunk.finishReason) groupFinish = chunk.finishReason
        // Same settlement as every other path (2.6.7 Denk-Audit): the state
        // machine above only fires on a literal `<think>`, and a Qwen3
        // template pre-opens the thought in the prompt, so a group speaker
        // used to put its whole reasoning plus a raw closer in the bubble.
        {
          const settled = settleThinking(contentAcc, thinkingAcc, keepThinking)
          contentAcc = stripImpersonatedSpeakers(settled.content, others)
          thinkingAcc = settled.thinking
        }
        useChatStore.getState().updateMessageContent(convId, assistantMessage.id, contentAcc)
        if (keepThinking && thinkingAcc) {
          useChatStore.getState().updateMessageThinking(convId, assistantMessage.id, thinkingAcc)
        }
        if (groupFinish) useChatStore.getState().updateMessageFinishReason(convId, assistantMessage.id, groupFinish)
        if (chunk.promptEvalCount || chunk.evalCount) {
          const promptTokens = chunk.promptEvalCount || 0
          const completionTokens = chunk.evalCount || 0
          useChatStore.getState().updateMessageUsage(convId, assistantMessage.id, {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          })
        }
        // One speaker, one call: the line under this bubble (lib/request-usage).
        requestUsageTracker(convId, assistantMessage.id).add(chunk)
      }
    }
    thinkClock.end()
    frames.close()
    keepWhatWasWritten()
    if (!abort.signal.aborted && !contentAcc.trim()) {
      // Empty turn: say WHY, length-aware, not a flat "didn't return an answer".
      // The bubble already labels the speaker, so no model prefix here.
      useChatStore.getState().updateMessageContent(
        convId,
        assistantMessage.id,
        emptyAnswerExplanation({ finishReason: groupFinish, captured: !!thinkingAcc.trim(), keepThinking }),
      )
    }
  } catch (err) {
    frames.close()
    keepWhatWasWritten()
    if ((err as Error).name !== 'AbortError') {
      syncOllamaHealthFromError(err)
      // Bug B3 round 2: a group round on a strict template used to paste the
      // template's own Jinja trace into the bubble. Say what happened instead,
      // and keep the raw text underneath it for support.
      const refusal = explainSendRefusal(err)
      useChatStore.getState().updateMessageContent(
        convId,
        assistantMessage.id,
        refusal ?? `Error from ${model}: ${errorText(err) || 'Connection failed'}`,
      )
      // The kind of the failure as a field, for a reader that draws its own
      // error box (lib/message-error.ts). The sentence above replaces the
      // whole bubble, so none of it is answer text.
      if (!refusal) {
        useChatStore.getState().updateMessageError(
          convId,
          assistantMessage.id,
          messageErrorFor(err, { cloud: getProviderIdFromModel(model) === 'lu-cloud' }, ''),
        )
      }
    }
  }
}

/**
 * One `sendMessage()` call's own mutable streaming state, created fresh
 * inside the call and threaded through the whole turn by closure (the
 * `for await` loop, the `requestAnimationFrame` flush, the error and
 * `finally` handlers) instead of through hook-instance refs.
 *
 * B2: `contentRef` / `thinkingRef` / `isThinkingRef` / `discardedThinkBufRef`
 * used to be ONE set of `useRef`s per `useChat()` instance, and the app
 * mounts exactly one instance. Two overlapping `sendMessage()` calls, send
 * in conversation A, switch tabs, send in conversation B before A's stream
 * ends, wrote into the SAME refs, and a chunk from either run could land in
 * either bubble depending on which call's flush ran last (see
 * useChat-zwei-laeufe-vermischen-nicht.test.ts). A plain local variable
 * captured by closure is exactly as fast and cannot be shared between two
 * calls, because there is no second call it could belong to.
 */
interface ChatRun {
  readonly convId: string
  content: string
  thinking: string
  isThinking: boolean
  /** Chars of a `<think>…</think>` block we're discarding (Thinking toggled
   *  off) but still have to scan, to detect the closing tag. */
  discardedThinkBuf: string
}

/**
 * Runs currently in flight in PLAIN chat's `sendMessage`, keyed by
 * conversation. The re-entry guard `useAgentChat.ts` (`activeAgentRuns`) and
 * `useCodex.ts` (`activeCodexRuns`) already have; `sendMessage` had none
 * (Runde 5 Folgeposten 2, review-lanes.md Runde 2 Punkt 4).
 *
 * Blocker A's fix (`run-slot.ts`, this round) gives every `runInLane` call
 * its own booking identity, so two sends on the same conversation can no
 * longer both hold the LOCAL lane at once, but that only serializes the
 * lane a local model uses. A CLOUD model's lane always returns `'started'`
 * immediately (`admit`, `run-lanes.ts`): nothing there stops a double-click
 * on a cloud conversation from firing two real, simultaneous requests, each
 * writing into its OWN fresh assistant message. That is the exact live money
 * bug this house has already paid for once (one prompt, two Enters,
 * `video_generate` four times, 2026-06-16). Blocker A closed the
 * local half of it and left the cloud half open, because a cloud send was
 * never anyone's re-entry guard's job before.
 *
 * Same shape and same placement as the sister hooks: claimed synchronously
 * right after `convId` is resolved, no `await` in between, freed in the
 * `finally` only if this run still owns the entry (a Stop-then-resend on the
 * same conversation must not have the OLD run's cleanup evict the NEW run's
 * claim).
 */
const activeChatRuns = new Map<string, symbol>()

/** A group round that answers again instead of starting from a new user
 *  line (GH #199): who speaks, and what to do once the round holds its
 *  claim, before the first speaker (move the old answers into a version). */
interface GroupRoundAgain {
  speakers: string[]
  prepare: () => void
}

/**
 * "A send of this conversation is on its way", from the tap to the end.
 *
 * `generationStore.generating` only turns true once the request is about to
 * go out: after the documents were searched, the memories picked and the
 * lane was free. On a phone that takes a tenth of a second to several
 * seconds (the model loads, the document model takes its turn), and for that
 * long the chat held an empty answer nobody was writing yet. The phone drew
 * it as "No answer came back" with "Try again", and a tap there sent twice
 * (acceptance on Android, H1). This is the earlier, wider truth: set with the
 * claim in `activeChatRuns`, cleared in the outermost `finally` of the send.
 * Reactive, so a screen can wait with its verdict on an empty answer.
 */
export const useChatSendPending = create<{ pending: Record<string, symbol> }>(() => ({ pending: {} }))

function markSendPending(convId: string, token: symbol): void {
  useChatSendPending.setState((s) => ({ pending: { ...s.pending, [convId]: token } }))
}

function clearSendPending(convId: string, token: symbol): void {
  useChatSendPending.setState((s) => {
    if (s.pending[convId] !== token) return s
    const { [convId]: _gone, ...rest } = s.pending
    void _gone
    return { pending: rest }
  })
}

/** Is a plain chat send of this conversation between its tap and its end. */
export function useIsSendPending(convId: string | null | undefined): boolean {
  return useChatSendPending((s) => !!convId && convId in s.pending)
}

/** Test-only: which conversations currently have a live plain-chat send. */
export function __activeChatRunConvIdsForTests(): string[] {
  return [...activeChatRuns.keys()]
}

export function useChat() {
  const [isGenerating, setIsGenerating] = useState(false)
  const [isLoadingModel, setIsLoadingModel] = useState(false)

  // Agent mode composition
  const agentChat = useAgentChat()
  // `useAgentChat()` gibt bei jedem Render ein frisches Objektliteral zurueck —
  // das ist die instabile Referenz, wegen der `sendMessage` seine Abhaengigkeit
  // nicht nennen konnte. Der einzige Teil davon, den `sendMessage` braucht, ist
  // `sendAgentMessage`, und das ist ein useCallback mit leerer Dep-Liste, also
  // ueber die Lebensdauer des Hooks stabil.
  // Dasselbe gilt fuer `stopAgent`, das `stopGeneration` unten immer ruft.
  const { sendAgentMessage, stopAgent } = agentChat
  const { extractAndSave } = useMemory()

  // Create in chat: after a run the model gets a short report as a hidden
  // message and comments on the result. Only for the open conversation.
  // 'note' (a click on "Not now"): the message is only laid into the history,
  // hidden, without a call. The model reads it with the customer's next
  // message, on both paths and also when Create has been switched off since.
  const sendCreateReport = useCallback((conversationId: string, report: string, mode: FollowUpMode = 'answer') => {
    if (mode === 'note') {
      useChatStore.getState().addMessage(conversationId, {
        id: uuid(), role: "user", content: report, hidden: true, timestamp: Date.now(),
      })
      return
    }
    if (useChatStore.getState().activeConversationId !== conversationId) return
    const { activeModel } = useModelStore.getState()
    const { settings } = useSettingsStore.getState()
    if (!createActiveHere(settings, activeModel)) return
    syncCreateTools(toolRegistry, true)
    // Returned, so a Regenerate of the comment can wait for the turn before
    // it checks whether anything was written (GH #174).
    return sendAgentMessage(report, undefined, {
      curatedTools: CREATE_TOOL_NAMES,
      chatToolsMode: true,
      createTools: true,
      hiddenUser: true,
    })
  }, [sendAgentMessage])

  useEffect(() => {
    setCreateFollowUp(sendCreateReport)
    // A finished item of an order goes onto the Create tab's shelf.
    const unwatch = watchOrderResults()
    return () => {
      setCreateFollowUp(null)
      unwatch()
    }
  }, [sendCreateReport])


  // G29: a run outlives this hook instance when the chat view unmounts on a
  // view switch, so the conversation's own flag is the only honest source for
  // "is something still in flight here". Without it the composer showed Send
  // next to a running clock and the user had no way to end the run.
  const activeConversationId = useChatStore((s) => s.activeConversationId)

  // Ein fertiger Hintergrundagent holt den Hauptagenten zurueck. Hier montiert
  // und nicht in useAgentChat: `sendAgentMessage` entsteht dort, aber der Hook
  // bekommt den Sendeweg von aussen, damit derselbe Hook auch den Codex-Weg
  // bedienen kann. Er kostet nichts, solange es keine Hintergrundaufgaben
  // gibt — `shouldWakeParent` faellt auf der ersten Bedingung heraus.
  //
  // NACH `activeConversationId`, weil der Hook die REAKTIVE Kennung braucht:
  // ein `getState()` im Render liefert eine Momentaufnahme, und nach einem
  // Gespraechswechsel weckte der Hook still das falsche Gespraech.
  useBackgroundAgentWake(activeConversationId, sendAgentMessage)

  const storeGenerating = useGenerationStore((s) => !!s.generating[activeConversationId ?? ''])
  const orphanRun = isOrphanRun(storeGenerating, isGenerating, agentChat.isAgentRunning)

  /** One group round: the user's line goes in once, then every group model
   *  answers in turn on the shared, attribution-tagged history. One abort
   *  controller spans the whole round, so Stop ends the round, not just the
   *  model that happened to be talking.
   *
   * Runde 5 (review-lanes.md Blocker B): the round now books the local lane
   * for its ENTIRE span, all speakers included, exactly like the other two
   * send paths. Before this, `fbfe15c3` (Runde 4) removed the app-wide
   * composer lock that used to cover a group round as a side effect, without
   * putting the round on the lane that replaced it: a local group chat and
   * a second local conversation could stream from the built-in engine at the
   * same time, silently, because `localLaneHolder()` never heard about the
   * group round at all. */
  const runGroupRound = useCallback(async (convId: string, content: string, images: ImageAttachment[] | undefined, members: string[], files?: ChatFileInput[], again?: GroupRoundAgain): Promise<boolean> => {
    // Auflage 3 (Review composer, 19.09.2026): derselbe Wiedereintritts-Riegel
    // wie sendMessage oben ("Re-entry guard"). Ohne ihn ueberschrieb ein
    // doppeltes Enter auf einem Gruppenchat den Token der ersten Runde weiter
    // unten in `activeChatRuns`, ohne einen Haenger zu erzeugen (die erste
    // Runde loescht wegen der Identitaetspruefung im `finally` unten nichts,
    // die zweite raeumt am Ende auf) - aber der Doppelklick-Schutz griff fuer
    // Gruppenrunden bisher nicht, und ein doppelter Nutzerzug landete im
    // Verlauf. Claim synchron, vor der ersten Nachricht, exakt wie dort.
    if (activeChatRuns.has(convId)) {
      log.info('chat.duplicate_group_round_blocked', { convId })
      return false
    }
    const myRunToken = Symbol(convId)
    activeChatRuns.set(convId, myRunToken)

    // Auflage 8 (Review composer, 19.09.2026): der Claim oben und dieser
    // `try` muessen luecklos aneinanderliegen. Ein Wurf zwischen ihnen (zum
    // Beispiel aus `addMessage` oder `currentLaneFacts`, beide unten im
    // Rumpf) haette den Eintrag in `activeChatRuns` fuer immer stehen lassen
    // - der Gruppenchat waere dauerhaft gesperrt gewesen, und `size > 0`
    // haette "Stop generation" nach jedem spaeteren Lauf angezeigt, also
    // genau der Geisterzustand, den dieser Zweig repariert, aus einer neuen
    // Ecke. Das innere `finally` weiter unten raeumt den Normalfall (und den
    // Abbruch waehrend des Laufs) schon auf; dieses AEUSSERE `finally` ist
    // nur fuer den Fall da, dass der Rumpf nie bis dorthin kommt, und ist
    // deshalb ein reiner No-op, wenn das innere schon geraeumt hat
    // (Identitaetspruefung, wie ueberall in dieser Datei).
    try {
      // GH #165: a member whose model is not in the model list right now sits
      // this round out. Asking for it anyway is how the backend came to answer
      // under its name with whatever model it had loaded. It stays a member,
      // shown as unavailable in the group menu, and speaks again once its
      // model is listed again.
      const listed = useModelStore.getState()
      // Everyone at the table: named to each speaker and tagged in its history.
      const table = availableGroupMembers(members, listed.models, listed.inventoryLoaded)
      // Who answers THIS round. A regenerate (GH #199) names its speakers and
      // adds no user line; a new round takes the group's order less whoever
      // was set to sit it out (GH #200), and that pick is used up here.
      let models: string[]
      if (again) {
        models = again.speakers.filter((m) => table.includes(m))
        if (models.length === 0) return false
        again.prepare()
      } else {
        const sitOut = useChatStore.getState().conversations.find((c) => c.id === convId)?.groupSitOut
        models = nextRoundSpeakers(table, sitOut)
        if (sitOut?.length) useChatStore.getState().setGroupSitOut(convId, [])

        // GH #171: an attached text goes out whole when it fits, and as far as
        // it fits otherwise. One user line reaches every speaker, so it is
        // fitted to the smallest window at the table (all members when none is
        // listed: then nobody answers and the size does not matter).
        const sendFiles = await fitFilesForSend({
          files: filesWithoutWorkspace(files),
          models: models.length ? models : members,
          use: 'chat',
          otherText: requestTextOf(useChatStore.getState().conversations.find((c) => c.id === convId), content),
        })
        useChatStore.getState().addMessage(convId, {
          id: uuid(),
          role: 'user',
          // An attached file reaches every speaker as its summary, inside the
          // one user line they all share (lib/chat-files.ts).
          ...fileMessageFields(content, sendFiles),
          images,
          timestamp: Date.now(),
        })

        if (models.length === 0) {
          useChatStore.getState().addMessage(convId, {
            id: uuid(),
            role: 'system',
            notice: 'info',
            content: 'No model of this group is in the model list right now, so nobody answered. Load one of them again, or change the group under Plugins.',
            timestamp: Date.now(),
          })
          return true
        }
      }

      // The round holds the lane its SPEAKERS need. Mixed local+cloud speakers
      // hold the local lane: a single local speaker anywhere in the round still
      // ties up the one engine slot for the whole round's duration, and the
      // safe reading is "this round touches the local card", not "every
      // speaker does". Getting this wrong the other way (treating a mixed
      // round as cloud) would let a local speaker in the round run alongside
      // an unrelated local conversation, the exact VRAM swap this module
      // exists to prevent.
      const facts = currentLaneFacts()
      const lane = models.some((model) => laneOf(model, facts) === 'local') ? 'local' : 'cloud'
      // A round with a local speaker in it, whatever the picker stands on.
      if (lane === 'local') yieldSilentLocalRuns()
      const abort = new AbortController()
      // Runs this hook-global `isGenerating` boolean unconditionally down to
      // (see Ghost-Stop-Fix note above `activeChatRuns`): registered/removed by
      // its OWN identity, independent of `generationStore.aborters`. Der Token
      // selbst ist jetzt oben entstanden (Auflage 3), zusammen mit dem Claim.
      const laneOutcome = await runInLane({ conversationId: convId, lane, abort: () => abort.abort() }, async () => {
        // The generationStore aborter map IS the run register, keyed by convId,
        // see the ChatRun doc comment above sendMessage. Nothing else needs to
        // remember this controller: Stop looks it up there, by conversation, not
        // through a hook-instance ref that a second overlapping run would
        // overwrite.
        const myAborter = () => abort.abort()
        useGenerationStore.getState().registerAborter(convId, myAborter)
        setIsGenerating(true)
        useGenerationStore.getState().setGenerating(convId, true)
        try {
          for (const [index, model] of models.entries()) {
            if (abort.signal.aborted) break
            // Each turn has a controller of its own under the round's: Stop
            // ends the round, "Skip speaker" (GH #200) ends this turn only and
            // the next speaker takes over.
            const turn = new AbortController()
            const endTurn = () => turn.abort()
            abort.signal.addEventListener('abort', endTurn)
            groupTurnStarted(convId, { speaker: model, index, total: models.length }, endTurn)
            const before = useChatStore.getState().conversations.find((c) => c.id === convId)?.messages.length ?? 0
            try {
              await runGroupTurn(convId, model, table, turn)
            } finally {
              abort.signal.removeEventListener('abort', endTurn)
            }
            if (turn.signal.aborted && !abort.signal.aborted) {
              // Skipped before a word: no empty bubble is left standing for it.
              // What it had written stays, as with Stop.
              const said = useChatStore.getState().conversations.find((c) => c.id === convId)?.messages[before]
              if (said?.role === 'assistant' && said.modelId === model && !said.content.trim()) {
                useChatStore.getState().deleteMessage(convId, said.id)
              }
              log.info('chat.group_speaker_skipped', { convId, index })
            }
          }
        } finally {
          groupRoundEnded(convId)
          // Same identity check as the single-model turn below (Blocker 2,
          // review-lanes.md): a Stop followed by an immediate resend on this
          // conversation can register a new aborter before this round's
          // finally runs.
          const stillOwnsSlot = useGenerationStore.getState().aborters[convId] === myAborter
          if (stillOwnsSlot) {
            useGenerationStore.getState().clearAborter(convId)
          }
          if (activeChatRuns.get(convId) === myRunToken) {
            activeChatRuns.delete(convId)
          }
          // The round is over, so it goes on disk BEFORE the app says so. Same
          // contract as the single-model turn below and as the Agent and Coding
          // runs; see stores/durability.ts for the measurement that made the
          // order matter.
          await endTurnDurably(() => {
            // Ghost-Stop-Fix (G31 Nachbesserung, 3.0.1): `isGenerating` is
            // recomputed from the live run registry (`activeChatRuns.size`),
            // NOT gated on `stillOwnsSlot` the way `generationStore`'s OWN
            // per-conversation flag still is below. An external abort (Stop
            // button on ANOTHER conversation never reaches here, but sign-out,
            // window close and app quit all call
            // `generationStore.abortConversation(convId)` directly, see
            // lib/background-shutdown.ts) clears `aborters[convId]` WITHOUT
            // starting a replacement round, so `stillOwnsSlot` is false here,
            // and nothing else was ever going to flip this hook's global flag
            // back to false. `activeChatRuns` has its own, independent identity
            // check just above and is authoritative for "is a plain-chat or
            // group round still actually running", exactly like
            // `activeAgentRuns.size > 0` in useAgentChat.ts.
            setIsGenerating(activeChatRuns.size > 0)
            if (stillOwnsSlot) {
              useGenerationStore.getState().setGenerating(convId, false)
            }
          })
        }
      })
      if (laneOutcome === 'cancelled-while-queued' && activeChatRuns.get(convId) === myRunToken) {
        // Wie bei sendMessage weiter unten: Stop hat die Runde aus der
        // Warteschlange der lokalen Spur geholt, bevor ihr eigenes `finally`
        // je lief (das lebt im Rumpf oben) - der oben synchron beanspruchte
        // Eintrag muss deshalb hier freigegeben werden.
        activeChatRuns.delete(convId)
      }
      return true
    } finally {
      if (activeChatRuns.get(convId) === myRunToken) {
        activeChatRuns.delete(convId)
        setIsGenerating(activeChatRuns.size > 0)
      }
    }
  }, [])

  // The fifth argument is the phone's (round 10): the fourth stays the
  // pending media of Create in the chat, as on the desktop.
  const sendMessage = useCallback(async (content: string, images?: ImageAttachment[], files?: ChatFileInput[], media?: PendingMedia[], opts?: { continueFrom?: string }) => {
    // A new question comes before learning from the last answer (phone only, see yieldMemoryLearning).
    yieldMemoryLearning()
    const { activeModel } = useModelStore.getState()
    const { settings } = useSettingsStore.getState()
    const store = useChatStore.getState()
    const persona = useSettingsStore.getState().getActivePersona()

    // The Cloud switch is a MONEY gate, so the send path enforces it itself
    // instead of trusting the AppShell reselect effect: when that effect found
    // no in-mode fallback (Ollama down, engine off), the old mode's model
    // silently stayed active and every chat kept billing cloud credits with
    // the switch on Local (Discord bug-reports 2026-08-09).
    // A model from the wrong mode never reaches a provider: clear it and let
    // the picker's empty state ask for a real selection.
    if (modelOutOfMode(activeModel, settings.appMode)) {
      useModelStore.getState().setActiveModel(null)
      return
    }

    // What the person just sent outranks what the app runs on its own: a
    // memory extraction that still holds the local model steps aside, for a
    // plain turn, an agent turn and /compact alike (lib/silent-runs-yield.ts).
    yieldSilentRunsTo(activeModel)

    // /compact — BEFORE the agent delegation, because this one command is not
    // an agent task. It belongs to the conversation, and both surfaces this
    // hook serves (plain chat and agent mode) have one. Putting it after the
    // delegation would have meant a second, identical branch inside
    // useAgentChat for no reason; putting it before means the scope decides.
    //
    // The scope also does the refusing: in plain chat parseAgentCommand only
    // recognises commands marked for it, so "/fix the login" stays literal
    // text there instead of quietly becoming an agent instruction on a
    // surface with no tools to carry it out.
    {
      const convId = store.activeConversationId
      const agentOn = convId ? useAgentModeStore.getState().isActive(convId) : false
      const cmd = parseAgentCommand(content, agentOn ? 'agent' : 'chat')
      if (cmd?.command.name === 'usage') {
        // Both lines are app notices, like /compact below: the command and its
        // answer never reach a model and never cost a round trip.
        if (!convId) return
        const messages = store.conversations.find((c) => c.id === convId)?.messages ?? []
        store.addMessage(convId, { id: uuid(), role: 'system', notice: 'info', content, timestamp: Date.now() })
        store.addMessage(convId, {
          id: uuid(), role: 'system', notice: 'info', content: lastRequestUsageNotice(messages), timestamp: Date.now(),
        })
        return
      }
      if (cmd?.command.name === 'compact') {
        if (!convId) return
        // BEIDE Zeilen sind App-Hinweise, keine Modell-Turns.
        //
        // Bis 2.6.8 standen sie als `role:'user'` und `role:'assistant'` im
        // Verlauf — und die Nutzlast filtert nur `role:'system'`. Also fuhr
        // ein erfundener Assistentenzug („Summarised 12 earlier messages …")
        // in JEDE spaetere Anfrage mit, sass im geschuetzten Schwanz der
        // letzten sechs Nachrichten und wurde bei der naechsten Verdichtung
        // als Protokoll mitzusammengefasst. Das Modell las sich selbst dabei
        // zu, wie es angeblich zusammengefasst hatte.
        //
        // In der Claude-Code-Desktop-App sind Schraegstrich-Befehle und ihre
        // Ausgabe rein oertlich und erreichen das Modell nie. Der Mechanismus
        // dafuer gibt es hier schon: `notice` auf einer System-Nachricht, von
        // der Nutzlast verworfen, von der Ansicht als schlichte Zeile
        // gezeigt. Er wurde nur nie benutzt.
        store.addMessage(convId, {
          id: uuid(), role: 'system', notice: 'info', content, timestamp: Date.now(),
        })
        // Writing the summary is a real round trip, and a composer that just
        // goes quiet for ten seconds reads as a hang. Until 3.0.8 a placeholder
        // notice said so; now runCompactForConversation shows the line
        // "Compacting conversation…" while it runs, and the record it stores
        // stays as "Compacted, 28.9K → 17.9K". Only a run that changed nothing
        // still gets a sentence, because then there is no record to draw.
        const reportUnlessDone = (outcome: Parameters<typeof compactOutcomeMessage>[0]) => {
          if (outcome.ok) return
          useChatStore.getState().addMessage(convId, {
            id: uuid(), role: 'system', notice: 'info',
            content: compactOutcomeMessage(outcome), timestamp: Date.now(),
          })
        }
        // Runde 5 Nachtrag (review-lanes.md Runde 2, Grep-Audit dieser Runde):
        // this used to call runCompactForConversation straight away, a real
        // inference call that never touched run-lanes.ts. A local /compact
        // could stream from the built-in engine at the same time as an
        // unrelated local conversation, the same VRAM-swap Blocker A and B
        // this round were about, just triggered from a slash command instead
        // of a send. It now books the same lane a normal turn would, with a
        // real AbortController so Stop reaches it, whether Stop lands while
        // it is still queued (nothing was ever asked of the model, the
        // outcome is reported the same way an aborted summary call itself
        // would report it) or while it is actually running.
        const compactAbort = new AbortController()
        // Auflage 2 (Review composer, 19.09.2026): dieselbe Invariante wie
        // sendMessage und runGroupRound. Ohne Eintrag in `activeChatRuns`
        // haette ein `/compact` in Unterhaltung B das hook-globale
        // `isGenerating` unbedingt geloescht, waehrend A noch streamt (der
        // Schaden blieb bisher klein, weil `composerBusy` die Store-Fahne je
        // Unterhaltung ohnehin mitliest, aber diese Stelle war die einzige,
        // die aus der Reihe fiel).
        const myRunToken = Symbol(convId)
        activeChatRuns.set(convId, myRunToken)
        // Auflage 8 (Review composer, 19.09.2026): die beiden Zustandssetzer
        // waren bisher NACH dem Claim, aber NOCH VOR dem `try`. Sie werfen
        // praktisch nie, aber "praktisch nie" ist nicht "kann nicht" - ein
        // Wurf dort haette den `finally` unten uebersprungen und den Eintrag
        // in `activeChatRuns` fuer immer stehen lassen. Jetzt liegen sie IM
        // `try`, direkt hinter dem Claim, luecklos.
        try {
          setIsGenerating(true)
          useGenerationStore.getState().setGenerating(convId, true)
          // No model selected: `runCompactForConversation` reports `no-model`
          // on its own without touching any provider, so there is nothing
          // local to guard against; `'cloud'` starts immediately and never
          // queues, same as any other lane-less no-op would.
          const lane = activeModel ? laneOf(activeModel, currentLaneFacts()) : 'cloud'
          const laneOutcome = await runInLane(
            { conversationId: convId, lane, abort: () => compactAbort.abort() },
            async () => {
              const outcome = await runCompactForConversation({
                conversationId: convId,
                activeModel,
                trigger: 'manual',
                focus: cmd.args || undefined,
                signal: compactAbort.signal,
              })
              reportUnlessDone(outcome)
            },
          )
          if (laneOutcome === 'cancelled-while-queued') reportUnlessDone({ ok: false, reason: 'aborted' })
        } finally {
          if (activeChatRuns.get(convId) === myRunToken) {
            activeChatRuns.delete(convId)
          }
          // The summary (or the "Stopped" notice) is already in the store by
          // this point; only the announcement that flips Stop back to Send
          // waits for the write, same contract as the send path below and
          // runGroupRound above (stores/durability.ts has the measurement
          // that made the order matter).
          await endTurnDurably(() => {
            // Auflage 2: wie in runGroupRound/sendMessage errechnet aus der
            // Laufregistry, nicht unbedingt auf false gesetzt, sonst reisst
            // ein `/compact` in B die Fahne unter einem noch streamenden A weg.
            setIsGenerating(activeChatRuns.size > 0)
            useGenerationStore.getState().setGenerating(convId, false)
          })
        }
        return
      }
    }

    // Create in chat (the switch under Plugins; Cloud mode only, and only for
    // an account the server has released: createLive). The registry follows
    // the switch with every message: off means the two tools are in no
    // catalogue and every call is refused. Without the release this chat is
    // the one that shipped before. A group round is a conversation between
    // models and never carries the tools.
    const createLive = createLiveHere()
    const inGroup = isGroupChat(store.conversations.find((c) => c.id === store.activeConversationId)?.groupModels)
    const createOn = !inGroup && createActiveHere(settings, activeModel, createLive)
    syncCreateTools(toolRegistry, createOn)
    // A11: the settings pair rides along on a message about settings.
    const settingsOn = !inGroup && wantsSettingsTools(
      content,
      store.conversations.find((c) => c.id === store.activeConversationId)?.messages ?? [],
    )

    // The short answer to an order on the table: "yes", "ja", "go" approves
    // it, "stop" halts it. Only a short message of the customer's own, and
    // only for the order laid out last in this conversation; everything else
    // goes to the model below as an ordinary message.
    if (createOn && store.activeConversationId) {
      // Only an order whose card is still in the thread: after Edit or
      // Regenerate it is gone, and an "ok" no longer means it.
      const shownConv = store.conversations.find((c) => c.id === store.activeConversationId)
      const decision = decideCreateReply(
        content,
        ordersInView(shownConv?.messages ?? [], useCreateOrderStore.getState().ordersFor(store.activeConversationId)),
        !!images?.length || !!media?.length || !!files?.length,
      )
      if (decision) {
        useChatStore.getState().addMessage(store.activeConversationId, {
          id: uuid(), role: "user", content, timestamp: Date.now(),
        })
        applyCreateReply(decision)
        return
      }
    }

    // Agent mode delegation: if active for this conversation, use agent chat.
    //
    // 2.5.9: slash commands work here too. They were Code-only, which meant the
    // Agent — same tool catalog, same executor — could not use a single one of
    // them. The expansion goes to the model, the raw "/cmd" stays on screen, and
    // a read-only command has the mutating tools stripped for the turn exactly
    // like it does in Code. In PLAIN chat (no agent mode) a "/cmd" is still just
    // text: there is no tool catalog there for the templates to drive.
    if (store.activeConversationId && useAgentModeStore.getState().isActive(store.activeConversationId)) {
      // Der Rat aus der Zeile unten ist befolgt, sobald im Agent gefragt wird.
      useChatNoticeStore.getState().dismiss('agent-for-local-files')
      const slash = parseAgentCommand(content)
      if (slash?.command.handledLocally && slash.command.name === 'goal') {
        // Bookkeeping, not a prompt — never spend a round-trip on it.
        const convId = store.activeConversationId
        const res = applyGoalCommand(convId, slash.args)
        store.addMessage(convId, { id: uuid(), role: 'user', content, timestamp: Date.now() })
        store.addMessage(convId, { id: uuid(), role: 'assistant', content: res.message, timestamp: Date.now() })
        return
      }
      if (slash) {
        // /loop seeds the driver so pass 2 onward fires by itself, exactly as
        // it does in Code. Nobody should have to re-type a loop.
        const loop = slash.command.name === 'loop'
          ? (() => {
              const { intervalMs, rest } = parseLoopSpec(slash.args)
              return { pass: 1, intervalMs, task: rest || content, startedAt: Date.now() }
            })()
          : undefined
        return sendAgentMessage(slash.expanded, images, {
          displayContent: content,
          readOnly: slash.command.readOnly === true,
          ...(loop ? { loop } : {}),
          files,
          createTools: createOn && slash.command.readOnly !== true,
          settingsTools: settingsOn,
        })
      }
      // Agent mode: an attached file is also copied into this chat's working
      // folder, where the file tools can open it (useAgentChat).
      if (createOn) return sendAgentMessage(content, images, { files, createTools: true, media, settingsTools: settingsOn })
      if (settingsOn) return sendAgentMessage(content, images, { files, settingsTools: true })
      return sendAgentMessage(content, images, { files })
    }

    // Discord 28.09.2026: im normalen Chat liest kein Werkzeug die
    // Dateien dieses Rechners, auch nicht mit Chat Tools, und das Modell sagt
    // dann nur "I cannot access files". Die Zeile ueber dem Verlauf nennt den
    // Weg dorthin (lib/local-file-intent.ts). Gesendet wird trotzdem, die Zeile
    // ersetzt keine Antwort.
    if (asksForLocalFiles(content)) {
      useChatNoticeStore.getState().show('agent-for-local-files', LOCAL_FILES_NOTICE)
    }

    // Group chat v1 (a user): two to four models answer in turn in
    // ONE conversation. Runs BEFORE the chat-tools router on purpose: a
    // group round is a conversation, never a tool run, and the agent path
    // has already delegated above.
    {
      const groupConv = store.conversations.find((c) => c.id === store.activeConversationId)
      if (groupConv && isGroupChat(groupConv.groupModels)) {
        await runGroupRound(groupConv.id, content, images, groupConv.groupModels, files)
        return
      }
    }

    // Chat-Tools routing (2026-06-11): web/file/image/video should work
    // in PLAIN chat without flipping to full Agent mode. We route a turn through
    // the chat-tools executor when it needs one of those capabilities — either
    // DIRECTLY (verb+noun in this message) or as a CONTINUATION of a recent
    // image/video task (2026-06-20: "ok go" / "2 seconds zoom" / "nochmal
    // neu" / "ok generiere jetzt" used to miss and drop to plain chat, where the
    // tool is absent → the model planned in circles or faked "(generating…)" and
    // the token counter halved as the prompt lost its tools+image). For a
    // continuation we pass the prior generation's args so a bare "nochmal" / "go"
    // reproduces the SAME media. Pure conversation still falls through to the fast
    // plain path below, untouched. (Agent mode already returned above.)
    // Phone only (round 10, lib/continue-answer.ts): "Continue" on a cut
    // answer goes on inside that answer. Agent mode and a group chat have
    // returned above, so what is left to ask is the model. False on the
    // desktop and for every send that did not name an answer to go on from.
    const continueInPlace = typeof opts?.continueFrom === 'string'
      && continuesInPlace({ model: activeModel, agentOn: false, group: false })

    // Always on since 3.0.7, wherever the model can call tools; a model that
    // cannot goes on in plain chat (lib/chat-tools-reach.ts).
    if (activeModel && chatToolsReach(activeModel, useModelStore.getState().models) && !continueInPlace) {
      const activeConv = store.conversations.find((c) => c.id === store.activeConversationId)
      const recent: ChatToolRouteMsg[] = (activeConv?.messages ?? [])
        .slice(-12)
        .map((m) => {
          const media = m.role === 'assistant' ? lastMediaFromBlocks(m) : null
          return { role: m.role, content: m.content, mediaKind: media?.kind, mediaArgs: media?.args }
        })
      const route = resolveChatToolRoute(content, !!images?.length, recent)
      // Cloud mode has no local ComfyUI pipeline: media intents stay on the
      // plain-chat path (cloud renders live in the Create tab) instead of
      // dead-ending in the local image/video tools, and the media pair is
      // stripped from the curated list so a web/file turn can't call it.
      // A phone is the same case whatever the mode: the two media tools are
      // not registered there (lib/mobile-tools.ts).
      const cloudMode = settings.appMode === 'cloud' || !localMediaToolsExist()
      // Phone only (round 10, the rest of N2): an order to search the web that
      // the router above does not know ("Websuche: X", lib/explicit-search.ts)
      // goes to the tools all the same. Without it the turn was a plain chat,
      // and the loop that holds such an order never saw it. Always false on
      // the desktop, where the router alone decides as before.
      const orderedSearch = !route && isMobile() && explicitSearchQuery(content) !== null
      if ((route && !(cloudMode && route.mediaHint)) || orderedSearch) {
        return sendAgentMessage(content, images, {
          // Create on (Cloud mode only): its two tools ride along with web
          // and file.
          curatedTools: cloudMode
            ? [...CHAT_TOOLS.filter((t) => t !== 'image_generate' && t !== 'video_generate'), ...(createOn ? CREATE_TOOL_NAMES : []), ...(settingsOn ? SETTINGS_TOOL_NAMES : [])]
            : [...CHAT_TOOLS, ...(settingsOn ? SETTINGS_TOOL_NAMES : [])],
          chatToolsMode: true,
          mediaHint: route?.mediaHint,
          files,
          createTools: createOn,
          settingsTools: settingsOn,
          media: createOn ? media : undefined,
        })
      }
      // A11: "stell Auto Compact auf 80". Only the settings pair (and Create's
      // two when Create is on); nothing changes without the card.
      if (settingsOn) {
        return sendAgentMessage(content, images, {
          curatedTools: [...SETTINGS_TOOL_NAMES, ...(createOn ? CREATE_TOOL_NAMES : [])],
          chatToolsMode: true,
          settingsTools: true,
          createTools: createOn,
          files,
          media: createOn ? media : undefined,
        })
      }
    }

    // Create on: every message goes through the tool loop with the two Create
    // tools, without a word filter. The model decides in context; an
    // overeager one costs nothing, because every order needs the customer's
    // approval.
    if (activeModel && createOn) {
      return sendAgentMessage(content, images, {
        curatedTools: CREATE_TOOL_NAMES,
        chatToolsMode: true,
        createTools: true,
        files,
        media,
      })
    }

    if (!activeModel) return

    let convId = store.activeConversationId
    if (!convId) {
      convId = store.createConversation(activeModel, persona?.systemPrompt || "", undefined, {
        persona: settings.personasEnabled ? persona : null,
      })
    }

    // Re-entry guard (Runde 5 Folgeposten 2): claimed synchronously, no
    // `await` since `convId` was resolved above, same discipline as
    // `activeAgentRuns`/`activeCodexRuns`. A second `sendMessage` for the
    // SAME conversation while the first is still in flight is refused here,
    // before it can add its own message pair or fire its own request.
    if (activeChatRuns.has(convId)) {
      log.info('chat.duplicate_send_blocked', { activeModel, convId })
      return
    }
    const myRunToken = Symbol(convId)
    activeChatRuns.set(convId, myRunToken)
    markSendPending(convId, myRunToken)

    // Auflage 1 (Review Teil 13, 19.09.2026): the claim above and this `try`
    // must lie back to back, same discipline as the outer `try`/`finally` in
    // `runGroupRound` and in the `/compact` branch above. Roughly 89 lines
    // used to sit unprotected between the claim and the body's own inner
    // `try` (the RAG load at `ragState.loadChunksFromDB(convId)` among them,
    // plain IndexedDB, outside its own nested `try`): a throw anywhere in
    // there left the entry in `activeChatRuns` standing forever, and the
    // conversation was locked (`chat.duplicate_send_blocked`) with "Stop
    // generation" stuck on screen, no second send ever able to start. This
    // outer `finally` is a no-op on every path that already cleans up by
    // identity below (the inner `finally` further down, the early return
    // right after this comment, and the `cancelled-while-queued` follow-up
    // at the end all check `activeChatRuns.get(convId) === myRunToken`
    // first); it only fires on a path the body never reaches.
    try {
    const memoryScope = store.conversations.find(c => c.id === convId)?.memoryScope
    // GH #171: an attached text goes out whole when it fits the model's
    // context, and as far as it fits otherwise, with a line saying so.
    const sendFiles = await fitFilesForSend({
      files: filesWithoutWorkspace(files),
      models: [activeModel],
      use: 'chat',
      otherText: requestTextOf(useChatStore.getState().conversations.find((c) => c.id === convId), content),
    })
    const userMessage = {
      id: uuid(),
      role: "user" as const,
      // Plain chat has no file tools, so an attached file is its summary and
      // nothing else: name, type, hash, a hex dump of the start and the
      // readable strings, or the text of a text file (lib/chat-files.ts).
      // `content` below stays the typed text, which is what retrieval and
      // memory search with.
      ...fileMessageFields(content, sendFiles),
      images,
      timestamp: Date.now(),
    }
    useChatStore.getState().addMessage(convId, userMessage)

    // GH #180: in a thread that has been a group, this turn records who wrote
    // it, the chat's persona or the model alone, so turning group chat back
    // on keeps it this speaker's.
    const soloConv = useChatStore.getState().conversations.find((c) => c.id === convId)
    const soloPersona = soloConv && hasGroupHistory(soloConv)
      ? { persona: plainChatSpeaker(soloConv, useSettingsStore.getState().personas, useSettingsStore.getState().activePersonaId, settings.personasEnabled !== false) }
      : null
    const assistantMessage = {
      id: uuid(),
      role: "assistant" as const,
      content: "",
      thinking: "",
      // The answer records the model that produced it (Meldung 4, R5
      // re-measure 2026-08-30). The conversation field alone could not: it
      // holds one name for a chat two models may have answered in, and it is
      // rewritten every time the picker moves. Written here, at the turn, so
      // it is a measurement and not a guess.
      modelId: activeModel,
      ...(soloPersona ? soloTurnAuthorFields(soloPersona.persona) : {}),
      timestamp: Date.now(),
    }
    useChatStore.getState().addMessage(convId, assistantMessage)

    const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
    if (!conv) {
      // Practically unreachable (nothing awaited since the message pair was
      // just added to this exact conversation), but the guard claimed above
      // must not survive an early return regardless.
      if (activeChatRuns.get(convId) === myRunToken) activeChatRuns.delete(convId)
      return
    }

    // RAG context injection
    // Per-chat persona toggle (mobile-parity, mirrors mobile's
    // `personaEnabled`). Default OFF — only when the user explicitly
    // flipped it on via the Plugins dropdown does the persona prompt
    // apply. Undefined / unset → suppress, so a globally selected
    // persona never silently hijacks a new chat.
    // GH #170: the persona of THIS chat, the one its Plugins menu names.
    const { personas, activePersonaId } = useSettingsStore.getState()
    let systemPrompt = buildChatSystemPrompt(withChatPersona(conv, personas, activePersonaId), settings.personasEnabled !== false)
    // Create: this plain path only runs with Create off (or with a model it
    // does not work with). The system prompt then stays character for
    // character what it was; only when this message plainly asks for a medium
    // does a note point at the switch, for this one turn. Empty outside Cloud
    // mode and for an account that is not released.
    systemPrompt = withCreateText(systemPrompt, createSystemText(settings, activeModel, createLive, content))
    let ragSuffix = ''

    // Phone only (the rest of N2): the question is on the disk before a
    // model is asked, so a kill right after the send cannot take it along.
    // The wait has a short cap (stores/chatStore.ts questionOnDisk), a
    // storage that hangs never holds the send back. No await at all on a
    // desktop.
    if (isMobile()) await questionOnDisk()

    // One model slot: while a document is being read the chat model is
    // unloaded (api/rag.ts). Wait for it to come back instead of loading it
    // beside the document model. Resolves at once everywhere else. Stop ends
    // the wait (lib/slot-wait.ts): the question stays, the empty answer goes,
    // and the outer `finally` frees the claim.
    if ((await waitForSlotOrStop(convId)) === 'stopped') {
      useChatStore.getState().deleteMessage(convId, assistantMessage.id)
      return
    }

    // Read after the wait, not before it: a document that was being read
    // while the question waited is in the chat now, and may be the one that
    // switched Document Chat on (N3 on Android).
    let ragState = useRAGStore.getState()
    const ragEnabled = ragState.ragEnabled[convId] ?? false

    if (ragEnabled) {
      // Ensure chunks are loaded from IndexedDB before retrieval
      await ragState.loadChunksFromDB(convId)

      const chunks = ragState.getConversationChunks(convId)
      if (chunks.length > 0) {
        try {
          // Phone only: the search waits while the model on this device
          // answers in another chat, and Stop in this chat ends that wait
          // (api/rag.ts). A reading may start and end in that wait, so the
          // passages are taken again once the search has the slot. On a
          // desktop the options are not read and the list is the one above.
          const { context: ragContext, scoredChunks } = await retrieveContext(
            content,
            singleModelSlot() ? () => conversationChunksNow(convId) : chunks,
            ragState.embeddingModel,
            undefined,
            { conversationId: convId },
          )
          ragState = useRAGStore.getState()

          // Store scored chunks for display in RAGPanel
          ragState.setLastRetrievedChunks(scoredChunks)

          // One builder for plain chat, Agent mode and the tests
          // (lib/rag-prompt.ts). It is a SUFFIX: the retrieval block is the
          // most volatile thing in the prompt, and at byte 0 it made the
          // upstream prefix cache miss everything on every RAG turn (plan A5).
          // The result is appended to the system prompt below, which is what
          // makes Document Chat work on a cloud model as well as a local one.
          ragSuffix = buildRagSuffix(ragContext.chunks)
          // The answer says which passages it was given (lib/rag-sources.ts).
          // The field had a display and an export and no writer.
          if (ragContext.chunks.length > 0) {
            useChatStore.getState().updateMessageSources(
              convId,
              assistantMessage.id,
              sourcesFromChunks(ragContext.chunks, ragState.documents[convId] ?? []),
            )
          }
          // A clean turn clears any previous complaint.
          ragState.setRetrievalError(null)
        } catch (err) {
          // Stop during the wait for the slot: the same ending as the wait
          // above. The question stays, the empty answer goes.
          if (isSearchStopped(err)) {
            useChatStore.getState().deleteMessage(convId, assistantMessage.id)
            return
          }
          log.error("RAG retrieval failed, continuing without context", { err })
          // Silence here was the defect (review S4): the model answered from
          // nothing while the user watched a green Docs badge and believed the
          // PDF had been read. The panel and the composer both show this.
          // On a phone the reason is memory or a missing document model,
          // and the sentence about "the embedding engine" names a thing the
          // user cannot check there. The slot error carries its own sentence.
          const phoneReason = err instanceof Error && (isSingleSlotConflict(err) || err.message === NO_EMBED_MODEL_MOBILE_MESSAGE)
            ? err.message : ''
          ragState.setRetrievalError(phoneReason ? `${RETRIEVAL_FAILED_PREFIX}${phoneReason}` : RETRIEVAL_FAILED_MESSAGE)
        }
      }
    }

    // The model's context window, resolved once: the memory budget below reads
    // it, and so does the send budget further down (plan A4). Zero means the
    // lookup failed, and a zero window resolves to no cap at all, which is the
    // pre-2.6.6 payload.
    let modelWindowTokens = 0

    // Memory context injection (context-aware, sanitized)
    let memoryContext = ''
    try {
      const contextTokens = await getChatWindowTokens(activeModel)
      modelWindowTokens = contextTokens
      // Embedding-first retrieval; falls back to keyword scoring offline.
      // excludeToolResults: this is a PLAIN chat (agent already delegated
      // above) — remembered tool RESULTS read as worked tool-call examples
      // and prime the model to attempt tools it doesn't have here (live find
      // 2026-06-11: gemma4 answered web-search questions with a silent empty
      // bubble because it spent the whole turn "deciding to call web_search").
      const selectedMemory = await useMemoryStore.getState().getMemoryContextAsync(content, contextTokens, { excludeToolResults: true, scope: memoryScope })
      // Behind the newest message, not in the system prompt: the pick
      // changes with every message (lib/turn-context.ts, A7).
      memoryContext = selectedMemory.text
    } catch {
      // Memory injection is non-critical
    }

    // For non-Ollama providers, inject thinking via system prompt — but ONLY
    // for endpoints that declared nothing about think capability (generic
    // OpenAI-compat: LM Studio, vLLM, …). Models with a server-declared
    // thinkMode (LU Cloud /models carries `think`) must NOT get the tag
    // injection on top of reasoning_effort: the upstream already runs its
    // native reasoning template/parser (reasoning_content channel), and a
    // second, conflicting "write <think> tags, answer outside them"
    // instruction can trap the model in a reasoning loop until the budget is
    // gone — the owner's cloud Qwen3.6 burned 40k chars of thinking on "6×9" and
    // never answered (2026-07-12). 'always' reasoners use their native
    // channel untouched; 'never' instruct models get nothing (the blanket
    // injection made them burn billed tokens on reasoning we then discard);
    // 'toggle' models get reasoning_effort only.
    const providerId = getProviderIdFromModel(activeModel)
    const activeMeta = useModelStore.getState().models.find((m) => m.name === activeModel)
    const thinkMode = activeMeta && 'thinkMode' in activeMeta ? activeMeta.thinkMode : undefined
    const canThink = thinkMode ? thinkMode === 'toggle' : isThinkingCompatible(activeModel)
    // The reasoning ladder the server declared for THIS model. Absent on every
    // local backend and on a cloud deployment that predates 2.6.8, and absent
    // means the provider keeps sending exactly what it sent before.
    const effortLevels = activeMeta && 'effortLevels' in activeMeta ? activeMeta.effortLevels : undefined
    const effortDefault = activeMeta && 'effortDefault' in activeMeta ? activeMeta.effortDefault : undefined
    // And not for a LOCAL OpenAI-compatible backend any more (2.6.7
    // Denk-Audit): the built-in engine, LM Studio, llama.cpp and friends
    // render the model's own template, which has a real thinking switch the
    // provider now flips through chat_template_kwargs. Asking for tags on top
    // of a template that already opened the thought is the same double
    // instruction that trapped the cloud reasoners in a loop, one layer down.
    if (settings.thinkingEnabled && providerId !== 'ollama' && canThink && thinkMode === undefined
        && !isLocalModelByName(activeModel)) {
      systemPrompt = (systemPrompt || '') + '\n\nBefore answering, reason through your thinking inside <think></think> tags. Your thinking will be hidden from the user. After thinking, provide your answer outside the tags.'
    }

    // Caveman mode: prepend terse-style prompt
    if (settings.cavemanMode && settings.cavemanMode !== 'off') {
      const { CAVEMAN_PROMPTS } = await import('../lib/constants')
      const cavemanPrompt = CAVEMAN_PROMPTS[settings.cavemanMode]
      if (cavemanPrompt) {
        systemPrompt = cavemanPrompt + '\n\n' + (systemPrompt || '')
      }
    }

    // Per-message Caveman reminder for non-thinking models (ensures style adherence)
    const cavemanReminder = (settings.cavemanMode && settings.cavemanMode !== 'off')
      ? (await import('../lib/constants')).CAVEMAN_REMINDERS?.[settings.cavemanMode as 'lite' | 'full' | 'ultra'] || ''
      : ''

    // Memories and retrieval change with every message, so neither goes into
    // the system prompt, which sits in front of the whole conversation: at its
    // end they still cost the prefix cache every message of the chat (A7).
    // They ride as one note behind the newest user message, see the payload.
    //
    // Not on a phone: there they stay at the end of the system prompt, in
    // front of the question, as the phone was built and checked (M9 on the
    // small iPhone). The phone's models run from 0.36B up, and the note
    // behind the question has only been measured on the desktop. The
    // window of a phone is 4096 tokens at most, so a re-read costs less.
    const phoneSystemNote = isMobile()
    const contextNote = buildTurnContext({ memory: memoryContext, rag: ragSuffix })
    if (phoneSystemNote && contextNote) systemPrompt = `${systemPrompt || ''}\n\n${contextNote}`
    const turnContext = phoneSystemNote ? '' : contextNote

    // Count cap (web parity, MAX_SEND_MESSAGES): plain chat sends the whole
    // history verbatim, and a long chat of many short turns stays under every
    // token budget while the count climbs past the LU Cloud proxy's
    // 400-message gate — after which EVERY send 400s and the chat is a
    // permanent dead end (2026-08-21).
    // Token budget (plan A4), on top of the count cap. Plain chat rebuilt the
    // ENTIRE history on every send, so turn 60 of a long chat paid for turns 1
    // to 59 again just to ask "and shorter please", and every attachment ever
    // made rode along with it, invisible to the token estimator the whole way.
    //
    // Since 2.6.8 this holds on a local backend too, at 0.8 of its own window
    // instead of a cost ceiling — a local chat that outgrew its window used to
    // be truncated by the model itself, from the front, without a word. Below
    // 92% of the window (the A3 hysteresis on top of that 0.8) the payload is
    // byte-identical to 2.6.7. The contextDecay notaus still returns every
    // surface to the untouched array.
    //
    // The window is already resolved above for the memory budget, so this
    // costs nothing extra on this path.
    // 2.6.8 auto-compact, immediately before the payload is assembled.
    //
    // HERE and not earlier: the fill number this reads is "what the NEXT
    // request will carry", and the user's message plus the assistant
    // placeholder are already in the store by now, so it is measuring the
    // request that is actually about to go out. Earlier would measure the
    // previous turn; later would be after the budget already trimmed.
    //
    // Costs nothing when auto-compact is switched off: maybeAutoCompact reads
    // the switch first and returns on the cheap path.
    if (autoCompactOn(settings)) {
      // 3.0.7: would the send budget below trim this payload? Then the
      // summary goes first. The trim measures with the token estimate and the
      // auto compact ratio with the server's own count; on text the tokenizer
      // packs densely the estimate runs ahead, and the trim used to cut old
      // turns while auto compact still read 'below' (Windows run, 32K). The
      // probe is the payload below without its per message decorations, which
      // are a few tokens each and do not move a 15 percent trigger.
      const convBefore = useChatStore.getState().conversations.find((c) => c.id === convId) ?? conv
      const trimImminent = sendBudgetWouldTrim(
        [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...applyStoredCompaction(
            convBefore.messages.filter((m) => m.role !== 'system' && m.content.trim() !== ''),
            convBefore.compactions,
          ).messages.map((m) => ({ role: m.role, content: m.content, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) })),
        ],
        {
          providerId,
          modelWindow: modelWindowTokens,
          sendWindowTokens: sendWindowFor(settings, activeModel),
          contextDecay: settings.contextDecay,
          localBackend: sendsToALanBackend(providerId, activeModel),
          answerTokens: settings.maxTokens,
        },
      )
      await maybeAutoCompact({
        conversationId: convId,
        activeModel,
        window: modelWindowTokens,
        // Plain chat resolves the window through getChatWindowTokens: on
        // Ollama the num_ctx this turn is sent with (GH #166), on cloud the
        // catalogue value. Zero means the lookup failed, and
        // shouldAutoCompact refuses a zero window outright.
        windowIsTrue: modelWindowTokens > 0,
        trimImminent,
      })
    }
    // Re-read: a compaction just wrote a record, and the payload below has to
    // see it. The binding above was taken before the turn started.
    const convNow = useChatStore.getState().conversations.find((c) => c.id === convId) ?? conv

    // GH #180: a thread that has been a group keeps who said what. The other
    // speakers' turns go out as tagged user turns, as in the group itself,
    // instead of as this model's own.
    const soloSpeakerMap = soloPersona ? soloSpeakers(activeModel, soloPersona.persona) : null
    const soloAuthors = { groupPersonas: convNow.groupPersonas, personas }
    const soloTagOf = (m: Message) => soloSpeakerMap ? soloHistoryTag(m, activeModel, soloSpeakerMap, soloAuthors) : null
    if (soloSpeakerMap && convNow.messages.some((m) => soloTagOf(m))) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${SOLO_HISTORY_LINE}` : SOLO_HISTORY_LINE
    }

    // GH #181: the chat persona's reminder, near the end of the payload and
    // inside its budget, while the persona is on for the chat as its prompt
    // is. On the wire only; the store keeps the transcript as written.
    const personaNote = personaNoteOf(speakerPersonaFor(convNow, activeModel, personas, activePersonaId, settings.personasEnabled !== false))
    // A13 box run: a picture attached earlier (an edit through image_generate)
    // stayed in the history, and every later plain message to a model without
    // eyes was refused with "This model can't read images", although the user
    // attached nothing new. Earlier pictures go to such a model by their note
    // only; a picture on THIS message still goes along, so the refusal and its
    // advice stay where the user just attached one. Strict on purpose: the
    // model's own answer, else its name family (as vision-feedback asks),
    // never the lenient guess that calls every unknown model sighted.
    const historyImagesToModel = declaredVision(useModelStore.getState().models.find((x) => x.name === activeModel)) ?? modelNameSuggestsVision(activeModel)
    const lastUserMessage = [...convNow.messages].reverse().find((x) => x.role === 'user')
    const candidate = capMessageCount(withTurnContext([
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        // Bug B3: a stored role:'system' message is an APP notice, never a
        // model turn. MessageList hides it, useCodex and useAgentChat both
        // drop it from their payloads, and staged-apply.ts writes one on the
        // promise that "it still never reaches the model". Plain chat was the
        // one path that did not filter, so such a message rode along at
        // whatever index it happened to sit at, and a strict Jinja template
        // answers a mid-conversation system message with "System message must
        // be at the beginning" instead of a reply.
        // 2.6.8: a recorded compaction stands in for everything up to its
        // anchor. Applied HERE — on the stored messages, before the wire map —
        // for two reasons: the record's anchor is a message id and the wire
        // shape does not carry one, and the filter above has to have run first
        // so the anchor is looked up in the same array the payload is built
        // from. A record whose anchor is gone applies nothing and the full
        // history goes out, which is the honest answer to a stale record.
        ...applyStoredCompaction(
          // Phone: a round that was stopped before any answer is not sent along as an open question (lib/unanswered-turns.ts).
          (isMobile() ? withoutUnansweredTurns(convNow.messages) : convNow.messages).filter((m) => m.role !== 'system' && m.content.trim() !== ''),
          convNow.compactions,
        ).messages
          .map((m) => ({ m, tag: soloTagOf(m) }))
          .map(({ m, tag }) => ({
            role: (tag ? 'user' : m.role) as 'user' | 'assistant' | 'tool',
            content: tag
              ? `[${tag}] ${m.content}`
              : m.role === 'user' && cavemanReminder
                ? `${cavemanReminder}\n${m.content}`
                : m.content,
            ...(m.images?.length && (historyImagesToModel || m.id === lastUserMessage?.id) ? { images: m.images.map(img => ({ data: img.data, mimeType: img.mimeType })) } : {}),
            // Bug B3 round 2: a plain chat can hold tool turns, because the
            // chat tools (web_search and friends) run inside it by default.
            // The store keeps tool_calls and tool_call_id for exactly this
            // rebuild, and this rebuild dropped both, so every later send
            // showed the model a tool RESULT with no call in front of it.
            // Where the model's template cannot render them, the contract in
            // api/providers/normalize-system.ts carries them as prompt text.
            ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
      ], turnContext))
    // Phone only, and only for the small window of its own engine: ONE rule decides what a request leaves out,
    // the one below (fitChatForPhone), which is also the rule the context chip runs over the chat. The send
    // budget of the desktop ran in front of it and had its own idea: it cut the first long message of a chat
    // down to a third and kept it, where the rule of the phone leaves the oldest turns out. So the same chat
    // went out without its long note once and with a third of it the next time, and the chip said "9%, older
    // left out", then "63%" without a word (check 4 on Android, F7). On a desktop and for a cloud model
    // nothing changes: the budget runs as before.
    const phoneOwnsFit = isMobile() && phoneFitApplies(modelWindowTokens)
    const budgetedBySendWindow = phoneOwnsFit ? candidate : applyChatSendBudget(
      candidate,
      {
        note: personaNote,
        providerId,
        modelWindow: modelWindowTokens,
        sendWindowTokens: sendWindowFor(settings, activeModel),
        contextDecay: settings.contextDecay,
        // R2-3: der Hauptpfad des einfachen Chats liess dieses Feld weg, also
        // galt hier die Deckelung fuer bezahlte Anbieter und der eigene
        // LAN-Server wurde bei 64000 gekappt statt bei 209715. Ein Server im
        // eigenen Netz stellt keine Rechnung; jeder andere Sendepfad gibt es
        // schon mit (useAgentChat, useCodex, useABCompare, run-compact-command).
        localBackend: sendsToALanBackend(providerId, activeModel),
        answerTokens: settings.maxTokens,
        notice: 'chat',
        // GH #201: older turns that did not go out are said next to the answer.
        onTrimmed: (dropped) => useChatStore.getState().updateMessageHistoryTrim(convId, assistantMessage.id, {
          dropped,
          window: modelWindowTokens,
        }),
      },
    ).messages
    // Phone only: the request ends with the cut answer instead of the
    // request to continue, and the answer being written is marked as its
    // direct continuation. null on every other send, and then nothing changes.
    // Phone only, and only for the small window of its own engine: the oldest turns that do not fit are left
    // out here, by the counting the context chip shows, so the engine has nothing left to drop on its own and
    // the figure on the screen is the request that went out (lib/phone-context-fit.ts, round 16 F11). On a
    // desktop and for a cloud model `budgeted` is the array from above, by reference.
    const phoneFit = phoneOwnsFit ? fitChatForPhone(budgetedBySendWindow, modelWindowTokens) : null
    const budgeted = phoneFit ? phoneFit.messages : budgetedBySendWindow
    if (phoneFit) {
      let sentCount = convNow.messages.length
      // The answer being written stands in the chat already, empty: it is not part of the request.
      while (sentCount > 0 && convNow.messages[sentCount - 1].role === 'assistant' && !convNow.messages[sentCount - 1].content.trim()) sentCount -= 1
      usePhoneMeterStore.getState().report(convId, {
        meter: meterOfFit(budgetedBySendWindow.length, phoneFit, modelWindowTokens, candidate.length - budgetedBySendWindow.length),
        window: modelWindowTokens,
        atMessageCount: sentCount,
      })
    }
    const continued = continueInPlace ? wireForContinue(budgeted, opts?.continueFrom ?? '') : null
    if (continued) markContinuation(convId, assistantMessage.id)
    const messages = continued ?? budgeted

    // Lane admission (Runde 4, review-lanes.md Blocker 1+6): the built-in
    // engine runs llama-server with n_parallel=1, so two local sends racing
    // it at once queue instead of both landing on the one slot. Cloud lanes
    // start right away, same as before this round. Nothing has touched the
    // store yet (no message added below this point), so a send that Stop
    // pulls out of the queue before its turn leaves nothing to unwind.
    const lane = laneOf(activeModel, currentLaneFacts())
    const abort = new AbortController()
    const laneOutcome = await runInLane({ conversationId: convId, lane, abort: () => abort.abort() }, async () => {
    // Register so deleting/closing this chat aborts the in-flight stream (Bug C).
    // Also requestGenerationCancel so a running ComfyUI job is interrupted when
    // the chat goes away mid-generation (the _activeHandoffs gate makes it a
    // no-op when no media gen is in flight). Without it a long video kept
    // rendering after the chat was deleted.
    //
    // Kept as a named reference (not inlined) so the `finally` below can tell
    // whether THIS run still owns the aborter slot for `convId` before
    // touching anything keyed only by conversation (Blocker 2,
    // review-lanes.md): Stop, then an immediate resend on the same
    // conversation, can register a NEW aborter here before this run's
    // `finally` executes, and the old run's cleanup must not reach past it.
    // Blocker 4 (review-lanes.md): scoped to THIS conversation. A bare call
    // used to cancel whichever generation happened to be running app-wide,
    // so Stop in one chat could kill an image/video another chat's agent
    // was still producing.
    const myAborter = () => { abort.abort(); requestGenerationCancel(convId) }
    beginModelSwitchWatch(convId)
    useGenerationStore.getState().registerAborter(convId, myAborter)
    setIsGenerating(true)
    // Bind the generating flag to THIS conversation so the typing indicator
    // only shows in the chat whose turn is in flight — not in every other chat
    // the user switches to (2026-06-12). Cleared in finally.
    useGenerationStore.getState().setGenerating(convId, true)
    // Only a local model is loaded before it answers. A cloud model read
    // "Loading model" under every reply and spun the picker as if it were
    // switching models, until the first token arrived.
    if (isLocalModelByName(activeModel)) {
      setIsLoadingModel(true)
      useModelStore.getState().setIsModelLoading(true)
    }
    // Owns this turn's streamed text end to end, see the ChatRun doc comment
    // above. `convId` is fixed at this point: the `if (!convId)` branch above
    // already resolved it to a real string.
    const run: ChatRun = { convId, content: "", thinking: "", isThinking: false, discardedThinkBuf: "" }
    // Before the try, so the catch can close it (lib/frame-flush).
    const frames = frameFlush()

    try {
      // ── Multi-Provider: resolve provider for active model ──
      const { provider, modelId } = getProviderForModel(activeModel)

      // Tri-state: only thinking-compatible models get an explicit flag
      // (true or false). For every other model we leave `thinking`
      // undefined so the provider omits `think` entirely and Ollama does
      // whatever it normally does.
      //
      // Exception: plain-text-planner models (Gemma 3/4). Their `think:
      // false` path emits structured plain-text planning that has no
      // tags. We pass `undefined` instead (= Ollama default) so the model
      // stays in tagged-thinking mode; the thinking-stripper then removes
      // the tags silently and keepThinking=false below drops the native
      // thinking field, so the user sees a clean answer without a
      // planning preamble.
      // Server-declared think capability (resolved above, alongside the
      // system-prompt injection): 'always' and 'never' models get no
      // thinking BOOLEAN, because there is no switch to report. 'toggle' and
      // unknown fall through to the name-heuristic plus the settings switch.
      //
      // That is not the same as getting no reasoning_effort (2.6.8). An
      // 'always' model whose catalogue entry declares a ladder gets the chosen
      // rung, defaulting to high, which is what the web app has done all along.
      // Only a model without a declared ladder keeps deciding entirely for
      // itself. A 'never' model is declared without a ladder, so nothing
      // reaches it either way.
      const plainTextPlanner = isPlainTextPlanner(activeModel)
      const useThinking: boolean | undefined = canThink
        ? (settings.thinkingEnabled === false && plainTextPlanner
            ? undefined
            : settings.thinkingEnabled === true)
        : undefined
      const chatOpts = {
        // GH #175: the chat persona's preset under this chat's own values.
        ...speakerSamplingOptions(settings, conv, activeModel, personas, activePersonaId, settings.personasEnabled !== false),
        // An Ollama model runs this turn in its chat window. The number is
        // resolved where the request is built (api/ollama.ts), the same place
        // every other call to this model gets its window from.
        window: 'chat' as const,
        thinking: useThinking,
        // The rung, and the rungs this model has. Sent on every turn so Chat,
        // Agent mode and the Coding Agent cannot drift apart; the provider
        // clamps the wish onto the ladder and ignores both without one.
        reasoningEffort: settings.reasoningEffort,
        // A local model's rung only once the user picked one there (3.0.7).
        localEffortChosen: settings.localEffortChosen,
        // Think budget (D12): only the backends that take a count read it.
        thinkingBudget: settings.thinkingBudget,
        effortLevels,
        effortDefault,
        ...(continued ? { continueFinalMessage: true } : {}),
        signal: abort.signal,
      }

      // Helper: create stream, retrying without the think field if the
      // provider rejects it (old Ollama builds, edge-case models), and
      // retrying with a halved history when the hosted backend refuses the
      // message COUNT ("HTTP 400 too many messages", a user 2026-08-21).
      // Plain chat sends the whole conversation, so without this a long
      // hosted chat is stuck forever: every further turn only grows the
      // payload the server just refused. The 400 fires on request
      // validation, before any token streams, so a retry never duplicates
      // visible output. The conversation itself is never touched.
      async function* createStreamWithFallback() {
        // One card and a render from the chat holds it (3.0.8, A2): wait
        // visibly here instead of inside the provider without a word.
        await waitForChatCard(convId, !!activeModel && isLocalModelByName(activeModel), abort.signal)
        try {
          yield* provider.chatStream(modelId, messages, chatOpts)
        } catch (err) {
          if (isTooManyMessagesError(err)) {
            let trimmed = halveHistory(messages)
            for (let attempt = 0; trimmed; attempt++) {
              try {
                log.info('chat.too_many_messages_retry', { sent: trimmed.length, attempt })
                yield* provider.chatStream(modelId, trimmed, chatOpts)
                return
              } catch (retryErr) {
                if (!isTooManyMessagesError(retryErr) || attempt >= TOO_MANY_MESSAGES_MAX_HALVINGS) throw retryErr
                trimmed = halveHistory(trimmed)
              }
            }
            throw err
          }
          // 3.0.7: the engine refused the prompt as larger than its context
          // ("request (38214 tokens) exceeds the available context size
          // (32768 tokens)", Windows run, 32K window). The estimate that sized
          // this payload ran short of the server's own count. Cut the history
          // once to a budget under what the server named and send again; the
          // refusal comes before any token, so nothing shows twice. A second
          // refusal ends the turn as before. The store is never touched.
          const overflow = contextOverflowOf(err)
          if (overflow) {
            type Wire = Parameters<typeof estimateMessageTokens>[0]
            const sent = estimateMessageTokens(messages as unknown as Wire)
            const next = shrunkSendWindow(sent, overflow, sent)
            const cut = next !== null
              ? (compactMessages(messages as unknown as Wire, next, { notice: 'chat' }) as unknown as typeof messages)
              : messages
            if (cut === messages || cut.length >= messages.length) throw err
            log.info('chat.context_overflow_retry', { sent, next, window: overflow.window, promptTokens: overflow.promptTokens, kept: cut.length })
            yield* provider.chatStream(modelId, cut, chatOpts)
            return
          }
          // The ONE place that answers "must thinking be downgraded?" —
          // hooks/codex/thinking-downgrade.ts. It reads the status through
          // `httpStatusOf`, so the `statusCode` spelling of the Ollama
          // streaming path reaches the downgrade too instead of ending the
          // turn.
          //
          // The 422 this line used to carry alone is IN there now, not lost:
          // it is the upstream's bad-parameter status coming through the LU Cloud
          // proxy, and it arrives on `provider.chatStream` — the very call
          // below, and the one `streamProviderTurn` makes for the agent and
          // codex paths. So it was never a peculiarity of this transport, it
          // was missing from the others. See that module's "DIE 422-FRAGE".
          if (shouldDowngradeThinking(useThinking, err)) {
            // Die Absage der Engine ueberlebt diesen Zug: sonst kostet sie bei
            // JEDER weiteren Nachricht wieder eine verlorene Anfrage
            // (Testlauf 03.09.2026).
            if (engineDeniedThinking(err)) markCannotThink(modelId)
            yield* provider.chatStream(modelId, messages, { ...chatOpts, thinking: undefined })
          } else {
            throw err
          }
        }
      }

      const stream = createStreamWithFallback()

      let firstChunk = true
      // Thinking visibility is driven by the toggle. When OFF, we still
      // have to parse <think>…</think> so the state-machine closes
      // correctly, but we discard the captured text instead of rendering
      // it. Thinking-native models (QwQ, DeepSeek-R1) emit tags / the
      // native `thinking` field regardless of the `think: true` flag —
      // without this gate the block would show up even with the toggle OFF.
      // 'always' reasoners surface their native channel unconditionally —
      // their thinking can't be turned off, so hiding it would just burn
      // tokens invisibly.
      const keepThinking = useThinking === true || thinkMode === 'always'
      // Reasoning we'd otherwise throw away (Think toggle OFF). Kept so a
      // thought-only completion — model reasons, emits ZERO content, stops —
      // can still explain itself instead of rendering as a silent empty
      // bubble (live find 2026-06-11: gemma4 + remembered tool results).
      let hiddenThinking = ""
      const thinkClock = thinkingClock((ms) => useChatStore.getState().updateMessageThinkingMs(run.convId, assistantMessage.id, ms))
      // Why the backend said generation ended ('length', 'disconnect', …) —
      // drives the honest empty-reply explanation below.
      let finishReason: string | undefined

      // A7: until the first token the model reads the request; say so, with
      // its size, instead of a bare "Starting" (stores/runActivityStore).
      useRunActivityStore.getState().setActivity(convId, readingActivity(estimateMessageTokens(messages as unknown as Parameters<typeof estimateMessageTokens>[0])))

      for await (const chunk of stream) {
        // Abort fast-path: if the user hit Stop while a thinking-heavy model
        // (Gemma 4, QwQ) is still generating its thinking block, the fetch
        // AbortController alone can take 30-60 s to actually close the HTTP
        // stream — during that time Ollama keeps emitting `thinking` chunks
        // that we'd otherwise spin on. Check the flag every chunk so Stop
        // feels instant even mid-thinking.
        if (abort.signal.aborted) break

        if (firstChunk) {
          firstChunk = false
          setIsLoadingModel(false)
          useModelStore.getState().setIsModelLoading(false)
        }

        // Ollama native thinking field (Gemma 4, Qwen 3.5, etc.) or the
        // cloud reasoning channel (delta.reasoning_content via the provider).
        if (chunk.thinking && keepThinking) {
          run.thinking += chunk.thinking
        } else if (chunk.thinking) {
          hiddenThoughtArrived(convId)
          hiddenThinking += chunk.thinking
        }

        if (chunk.content) {
          const text = chunk.content

          for (const char of text) {
            if (!run.isThinking) {
              run.content += char
              if (run.content.endsWith("<think>")) {
                run.content = run.content.slice(0, -7)
                run.isThinking = true
              }
            } else {
              if (keepThinking) {
                run.thinking += char
                if (run.thinking.endsWith("</think>")) {
                  run.thinking = run.thinking.slice(0, -8)
                  run.isThinking = false
                }
              } else {
                // Discard char-by-char but still detect tag close so the
                // state machine resumes sending to content afterwards.
                hiddenThinking += char
                run.discardedThinkBuf += char
                if (run.discardedThinkBuf.endsWith("</think>")) {
                  run.discardedThinkBuf = ""
                  run.isThinking = false
                }
              }
            }
          }

        }

        // Coalesced store flush (≤1 per animation frame) for BOTH the answer
        // and the reasoning block — so the Thinking panel fills live during
        // the reasoning-only phase too (cloud reasoners stream all their
        // thinking before the first answer token; previously the flush only
        // ran on content chunks and the chat sat in dead air).
        thinkClock.tick(run.thinking, run.content)
        if (chunk.content || (chunk.thinking && keepThinking)) {
          frames.schedule(() => {
            const cId = run.convId
            const mId = assistantMessage.id
            // Always strip non-canonical thinking markers (Gemma channel
            // tags, `<thought>`, `<reasoning>`, `<reflect>`, `<deepthink>`)
            // from the streaming bubble. The canonical `<think>…</think>`
            // is already handled by the char-by-char state-machine above,
            // so we leave those alone here.
            // `continued` is phone only (lib/continue-answer.ts): the blank a continuation opens with is kept.
            const displayContent = continued ? withLead(run.content, stripNonCanonicalTags(run.content)) : stripNonCanonicalTags(run.content)
            useChatStore.getState().updateMessageContent(cId, mId, displayContent)
            if (keepThinking && run.thinking) {
              useChatStore.getState().updateMessageThinking(cId, mId, run.thinking)
            }
          })
        }

        if (chunk.done) {
          frames.close()
          if (chunk.finishReason) {
            // A stream that closed because the person picked another model
            // says that, not "connection dropped" (lib/model-switch-stop.ts).
            finishReason = finishReasonAfterSwitch(chunk.finishReason, run.convId)
            useChatStore.getState().updateMessageFinishReason(run.convId, assistantMessage.id, finishReason)
          }
          // Final settlement, the shared one, so plain chat catches the same
          // orphan shapes the agent loops do. Before this the char-by-char
          // machine above was the whole story here, and it only ever fires on
          // a literal `<think>`: a Qwen3 template that pre-opens the thought
          // in the prompt left the whole reasoning plus a raw closer standing
          // in the answer with the Think button ON and the block empty.
          {
            const settled = settleThinking(run.content, run.thinking, keepThinking)
            run.content = continued ? withLead(run.content, settled.content) : settled.content
            run.thinking = settled.thinking
          }
          useChatStore
            .getState()
            .updateMessageContent(run.convId, assistantMessage.id, run.content)
          if (run.thinking) {
            useChatStore
              .getState()
              .updateMessageThinking(run.convId, assistantMessage.id, run.thinking)
          }
          // Real token usage from the model's final chunk — promptEvalCount is
          // the FULL consumed context (system+tools+RAG+history+input), so the
          // TokenCounter can show 100%-real usage instead of a char/4 estimate.
          if (chunk.promptEvalCount || chunk.evalCount) {
            const promptTokens = chunk.promptEvalCount || 0
            const completionTokens = chunk.evalCount || 0
            useChatStore
              .getState()
              .updateMessageUsage(run.convId, assistantMessage.id, {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
              })
          }
          // The line under the answer (lib/request-usage). Plain chat makes one
          // call per answer, so the sum is this chunk.
          requestUsageTracker(run.convId, assistantMessage.id).add(chunk)
        }
      }
      thinkClock.end()
      // A stream can end without a done chunk; the lines below write the
      // bubble directly and a late frame must not land on top of them.
      frames.close()

      // Thought-only completion: the model reasoned and then STOPPED without
      // a single visible token (gemma4 primed by remembered tool results does
      // this on "search the web…" prompts in plain chats). Persist the
      // otherwise-discarded reasoning onto the message so the bubble can show
      // an honest explanation (MessageBubble renders the thinking block + an
      // Enable-Agent nudge when the reasoning is tool intent) instead of
      // leaving the user staring at silent dead air forever.
      if (!abort.signal.aborted && run.content.trim() === "") {
        const captured = (run.thinking || finalStripThinkingTags(hiddenThinking, false)).trim()
        // Honest, reason-specific note for the empty bubble. Before this, a
        // thought-only turn with Thinking ON stored the reasoning but left
        // content EMPTY — the user saw a collapsed Thinking pill and nothing
        // else, which reads as a hang/crash (the owner, cloud Qwen3.6 2026-07-12:
        // 40k chars of looped reasoning, token budget gone, zero answer).
        const explanation = emptyAnswerExplanation({ finishReason, captured: !!captured, keepThinking })
        if (captured && keepThinking) {
          // Thinking ON: surface the reasoning AND say why there's no answer
          // (the collapsed thinking pill alone reads as dead air).
          useChatStore
            .getState()
            .updateMessageThinking(run.convId, assistantMessage.id, captured)
          useChatStore
            .getState()
            .updateMessageContent(run.convId, assistantMessage.id, explanation)
        } else if (captured) {
          // Thinking OFF but the model still reasoned (Gemma keeps reasoning when
          // we pass `think:undefined`) and produced no visible answer. The owner
          // 2026-06-20: OFF must mean NO reasoning shown — never leak the hidden
          // thinking into the bubble. Leave a short honest note so it isn't
          // silent dead air. (Media follow-ups now route to the tool path and
          // won't reach here; this covers a plain Q&A that thought itself out.)
          useChatStore
            .getState()
            .updateMessageContent(run.convId, assistantMessage.id, explanation)
        } else if (finishReason === 'length' || finishReason === 'disconnect' || finishReason === MODEL_SWITCH_FINISH) {
          // No reasoning captured either — the turn produced literally
          // nothing because the budget ran out / the stream was cut. Still
          // explain instead of leaving dead air.
          useChatStore
            .getState()
            .updateMessageContent(run.convId, assistantMessage.id, explanation)
        }
      }
    } catch (err) {
      frames.close()
      if ((err as Error).name !== "AbortError") {
        // Bug C — translate Ollama provider errors into health-store
        // updates so the header chip + top banner light up reactively.
        // Helper-extracted so additional catch sites (useABCompare etc.)
        // can call the same translation without re-implementing it.
        syncOllamaHealthFromError(err)

        // The codes that already carry a finished sentence for the user. They
        // live on ProviderError, so this is a real `instanceof` narrowing
        // instead of three casts through `any` onto whatever was thrown.
        const code = err instanceof ProviderError ? err.code : undefined
        // Ein `invoke()`-Fehler aus Tauri ist eine ZEICHENKETTE, kein Error.
        // Gegenprobe G1, 04.09.2026: der Waehler zeigte zur kaputten GGUF die
        // ganze Diagnose samt Rat, derselbe Fehler ueber das Absenden nur
        // "Error: Connection failed" nach 16,9 s. Die Ursache war diese Zeile:
        // `instanceof Error` ist bei einer Zeichenkette falsch, also blieb der
        // Text leer und der Notnagel sprang ein. `errorText` liest beide
        // Formen, so wie der Waehlerweg und der Coding-Agent es laengst tun.
        const rawMessage = errorText(err)
        const isCloudRun = getProviderIdFromModel(activeModel) === 'lu-cloud'
        const errorMsg = code === 'auth' || code === 'signed_out' || code === 'rate_limit'
          ? rawMessage
          : `Error: ${rawMessage || 'Connection failed'}`
        // Bug B3 round 2: a refusal that produced nothing at all gets its own
        // English sentence, not the template's raw Jinja trace.
        const sendRefusal = explainSendRefusal(err)

        // The engine was taken away by the person's own pick of another
        // model. That is the reason, and the raw transport error is not: what
        // was written stays, with the marker under it, and an answer that had
        // not started says so in a sentence.
        if (cutByModelSwitch(run.convId)) {
          useChatStore.getState().updateMessageFinishReason(run.convId, assistantMessage.id, MODEL_SWITCH_FINISH)
          if (!run.content.trim()) {
            useChatStore.getState().updateMessageContent(
              run.convId,
              assistantMessage.id,
              emptyAnswerExplanation({ finishReason: MODEL_SWITCH_FINISH, captured: false, keepThinking: false }),
            )
          }
        // Image attached to a non-vision model → friendly guidance instead of
        // the raw 400 JSON (gthvidsten, GH Discussion #67).
        // LU Cloud has an outage the server announced (lib/cloud-outage.ts):
        // its sentence, not the raw error, and no "Error:" in front of it.
        } else if (code === 'outage') {
          useChatStore.getState().updateMessageContent(
            run.convId,
            assistantMessage.id,
            (run.content ? run.content + '\n\n' : '') + rawMessage,
          )
          // The sentence is the server's, so no reader knows it by its wording
          // (lib/logic-notes.ts): the field says it is not the answer.
          useChatStore.getState().updateMessageError(run.convId, assistantMessage.id, { kind: 'generic', detail: rawMessage, at: run.content.length })
        } else if (isMultimodalUnsupportedError(errorMsg)) {
          useChatStore.getState().updateMessageContent(
            run.convId,
            assistantMessage.id,
            MULTIMODAL_UNSUPPORTED_MESSAGE
          )
        // An empty wallet gets the same plain explanation everywhere, next to
        // the dialog that offers the top-up (lib/credits-exhausted.ts).
        } else if ((err as { code?: string })?.code === 'credits_exhausted') {
          useChatStore.getState().updateMessageContent(
            run.convId,
            assistantMessage.id,
            (run.content ? run.content + '\n\n' : '') + CREDITS_EXHAUSTED_MESSAGE
          )
          useChatStore.getState().updateMessageError(
            run.convId,
            assistantMessage.id,
            messageErrorFor(err, { cloud: isCloudRun }, run.content),
          )
        // Show user-friendly message for thinking errors
        // Bug B3 round 2: same treatment as the agent path. A template that
        // raised produced nothing at all, and its Jinja trace is not an
        // answer to anything the user asked.
        } else if (sendRefusal) {
          useChatStore.getState().updateMessageContent(
            run.convId,
            assistantMessage.id,
            (run.content ? run.content + "\n\n" : "") + sendRefusal,
          )
        } else if (errorMsg.includes('does not support thinking')) {
          useChatStore.getState().updateMessageContent(
            run.convId,
            assistantMessage.id,
            'This model does not support thinking mode. Disable the Think button or switch to a compatible model (Qwen 3, DeepSeek-R1, Gemma 4).'
          )
        } else {
          useChatStore.getState().updateMessageContent(
            run.convId,
            assistantMessage.id,
            run.content + "\n\n" + errorMsg
          )
          // The same failure as a field (lib/message-error.ts): a reader that
          // draws its own error box no longer has to recognise the sentence
          // above by its wording. The text of the bubble stays as it was.
          useChatStore.getState().updateMessageError(
            run.convId,
            assistantMessage.id,
            messageErrorFor(err, { cloud: isCloudRun }, run.content),
          )
        }
      }
    } finally {
      // Identity check (B2/Blocker 2): only clean up if this run still owns
      // the aborter slot for run.convId. A replaced slot means a NEW run
      // (Stop, then an immediate resend on the same conversation) is now in
      // flight, and clearing its aborter or flipping its generating flag
      // back to false out from under it would make the new run unstoppable
      // through generationStore, exactly like the useAgentChat.ts case.
      const stillOwnsSlot = useGenerationStore.getState().aborters[run.convId] === myAborter
      if (stillOwnsSlot) {
        useGenerationStore.getState().clearAborter(run.convId)
        // A reply that never came (error, Stop, empty) leaves no reading line behind.
        endFirstWait(run.convId)
      }
      // Re-entry guard release (Runde 5 Folgeposten 2): its own identity
      // check, same reasoning as `stillOwnsSlot` above but a SEPARATE map.
      // A Stop-then-resend on the same conversation must free only the run
      // that actually still holds the claim, never a newer one's.
      if (activeChatRuns.get(run.convId) === myRunToken) {
        activeChatRuns.delete(run.convId)
      }
      setIsLoadingModel(false)
      useModelStore.getState().setIsModelLoading(false)

      // The turn is done, so it goes on disk — and only then does the app say
      // it is done. Persistence is coalesced while tokens stream (2.6.3 — see
      // coalescedStorage), and an IndexedDB write cannot finish during unload,
      // so THIS is the point that makes a finished answer durable, not the
      // pagehide handler. It used to fire the write and announce the turn
      // finished in the same breath, which under load meant announcing it
      // ~300 ms early; stores/durability.ts carries the measurement.
      //
      // Position matters as much as the await, and cost a regression to learn:
      // moving this call below the TTS and memory blocks pushed the START of
      // the write ~5 ms past the paint, and the reload race in
      // e2e/chat-streaming-persist.spec.ts went from never to 3 runs in 10.
      // The write begins in the same statement it always began in; the only
      // thing that changed is that the announcement now waits for it.
      //
      // The answer itself is already painted, so what waits here is the Stop
      // button turning back into Send, not the text.
      await endTurnDurably(() => {
        // Ghost-Stop-Fix (G31 Nachbesserung, 3.0.1 box test Z2/Nebenfund 3):
        // `isGenerating` used to be gated on `stillOwnsSlot`, same as
        // `generationStore`'s per-conversation flag below. That is right for
        // the STORE flag (review-lanes.md point 1: a still-running resend on
        // the same conversation must not be reported idle), but wrong for
        // THIS hook-global boolean: `generationStore.abortConversation`
        // (called by the Stop button, sign-out, window close and app quit,
        // lib/background-shutdown.ts) clears `aborters[run.convId]`
        // synchronously and WITHOUT starting a replacement run, so
        // `stillOwnsSlot` is false here even though nobody else will ever
        // flip this flag back to false. The composer then reads `isGenerating`
        // (hooks/useChat.ts's return value, fed into `composerBusy`) as
        // permanently "Stop", with no run in sight, measured on the box
        // after a window-close (BERICHT.md Nebenfund 3). `activeChatRuns` is
        // cleared by its OWN identity check just above, independent of
        // `generationStore`, so its size is authoritative for "is a plain
        // chat send still actually running", same pattern as
        // `activeAgentRuns.size > 0` in useAgentChat.ts, which never had
        // this bug.
        setIsGenerating(activeChatRuns.size > 0)
        if (stillOwnsSlot) {
          useGenerationStore.getState().setGenerating(run.convId, false)
        }
      })

      // Auto-read the finished response when the user opted in (#77).
      // Default OFF and additionally gated on ttsEnabled; getState() (not the
      // hook) so this callback never subscribes to the voice store's isSpeaking
      // churn during playback.
      {
        const voice = useVoiceStore.getState()
        if (voice.ttsEnabled && voice.autoReadAloud && run.content.trim()) {
          autoSpeak(run.convId, assistantMessage.id)
        }
      }

      // Auto-extract memories (fire-and-forget)
      const memSettings = useMemoryStore.getState().settings
      if (memSettings.autoExtractEnabled && memSettings.autoExtractInAllModes && run.content.trim() && run.convId) {
        extractAndSave(content, run.content, run.convId, { scope: memoryScope }).catch(() => {})
      }
    }
    })
    if (laneOutcome === 'cancelled-while-queued' && activeChatRuns.get(convId) === myRunToken) {
      // Stop pulled this send out of the local lane's waiting room before its
      // own `finally` ever ran (that `finally` lives inside the body above),
      // so the guard claimed synchronously at the top has to be freed here
      // instead. Nothing else needs undoing beyond that: the body never
      // started, so it never registered an aborter or set `generating`.
      activeChatRuns.delete(convId)
    }
    } finally {
      // Same identity check as everywhere else in this file: a no-op when a
      // path above already released the claim (the normal send, the early
      // "conversation vanished" return, or the cancelled-while-queued
      // follow-up just above), and the only thing that actually fires when a
      // throw between the claim and the first inner `try` skipped all of
      // them.
      if (activeChatRuns.get(convId) === myRunToken) {
        activeChatRuns.delete(convId)
        setIsGenerating(activeChatRuns.size > 0)
      }
      clearSendPending(convId, myRunToken)
    }
    // Alle drei Referenzen sind konstant: `extractAndSave` kommt aus dem
    // Modul-Singleton MEMORY_API, `runGroupRound` ist ein useCallback mit
    // leerer Dep-Liste, `sendAgentMessage` ebenfalls. `sendMessage` behaelt
    // damit ueber die gesamte Hook-Lebensdauer dieselbe Identitaet wie vorher.
  }, [extractAndSave, runGroupRound, sendAgentMessage])

  /**
   * EIN Stop, der alles beendet, was dieses Gespraech Geld kosten kann.
   *
   * ── WARUM ES NUR NOCH EINEN GIBT (Fehler s der 3.0.0-Liste) ───────────────
   *
   * Hier standen drei Stops, und der Rueckgabewert waehlte per Bedingung einen
   * davon aus: `stopAgent`, wenn DIESE Hook-Instanz gerade einen Agentenlauf
   * fuehrt, sonst ein Abbruch ueber den Speicher fuer einen verwaisten Lauf,
   * sonst der blosse Stream-Abbruch. Nur der erste kannte die Schleife.
   *
   * Das traf genau den Zustand ZWISCHEN zwei /loop-Paessen: es generiert
   * nichts, die Instanz fuehrt nichts, also landete der Knopf auf dem dritten
   * Stop. Der brach einen AbortController ab, den es nicht gab, und der
   * Zeitgeber des naechsten Passes lief unberuehrt weiter. Der Nutzer sah die
   * Schleifenleiste mit ihrem Stopp-Knopf, drueckte ihn, und der naechste Pass
   * ging trotzdem in die Wolke — jedes Mal, beliebig lange. A user am
   * 03.09.2026: "i stopped it but that boy is still working and ready for the
   * next prompt", "its not even doing anything jus eating away".
   *
   * Eine Auswahl zwischen drei Stops ist dasselbe Muster wie zwei Pfade und
   * einer gepflegt, nur in der Stelle, an der es am teuersten ist. Also gibt es
   * keine Auswahl mehr: jeder Griff wird gerufen, jeder ist fuer sich
   * wirkungslos, wenn es nichts zu beenden gibt.
   *
   *  - `stopAgent`   Agentenlauf, wartender /loop-Pass, Freigaben, ComfyUI.
   *                  Setzt den Stop-Merker des Gespraechs (lib/run-stop), an
   *                  dem auch der Schleifentreiber und das Aufwecken haengen.
   *  - `abortConversation` erreicht den einfachen Chat-Stream UND den
   *                  Gruppenlauf, gleich welche Hook-Instanz oder welcher
   *                  ueberlappende `sendMessage()`-Aufruf ihn gestartet hat:
   *                  `generationStore.aborters` ist das Lauf-Register, per
   *                  Konversation gefuehrt (B2). Ein Hook-Instanz-Ref, den
   *                  der naechste ueberlappende Lauf ueberschreibt, wird
   *                  dafuer nicht mehr gebraucht.
   */
  const stopGeneration = useCallback(() => {
    const convId = useChatStore.getState().activeConversationId
    // B2 Commit 5: name the run explicitly instead of letting stopAgent
    // re-read "the active conversation" itself.
    stopAgent(convId)
    useGenerationStore.getState().abortConversation(convId)
    // Also interrupt an in-flight ComfyUI image/video gen, not just the JS loop —
    // otherwise the main Stop button leaves ComfyUI burning (only the in-chat
    // tool Stop did this before; now both affordances agree). Scoped to convId
    // (Blocker 4, review-lanes.md): a bare call used to cancel whichever
    // generation happened to be running app-wide, killing another
    // conversation's still-producing image/video.
    requestGenerationCancel(convId)
  }, [stopAgent])

  /**
   * Regenerate and Edit both replace the turn: the question leaves the thread
   * together with everything after it and goes back in through sendMessage,
   * attachments included. Deleting only the ANSWER left the question in place
   * for sendMessage to add a second time — the thread grew one more copy of it
   * per click and the model was asked it twice.
   *
   * "Leaves the thread" means it is KEPT as a version since GH #172 and #174:
   * it used to be deleted for good, and one click on an early message threw
   * away hours of a story. `forkFrom` moves it aside, the new turn is the
   * newest version, and "< 1/2 >" goes back. Returns false when nothing was
   * sent, so the edit field can keep the text instead of losing it.
   */
  const resend = useCallback((conversationId: string, targetId: string, override?: string): boolean => {
    // sendMessage bails without a model, with a model from the other mode, and
    // while this conversation's run is in flight; deleting first would eat
    // the question. The last two were missing (bug hunt 01.10.2026, H9).
    const { activeModel } = useModelStore.getState()
    if (!activeModel || modelOutOfMode(activeModel, useSettingsStore.getState().settings.appMode)) return false
    if (activeChatRuns.has(conversationId)) return false
    // While an order of this chat is rendering, its card must stay: Regenerate
    // and Edit move messages aside, and a card out of view would leave a run
    // that still books credits with nothing on screen to stop it.
    if (useCreateOrderStore.getState().ordersFor(conversationId).some((o) => o.state === 'running')) return false
    const conv = useChatStore.getState().conversations.find(c => c.id === conversationId)
    if (!conv) return false
    const plan = planResend(conv.messages, targetId, override)
    if (!plan) return false
    if (plan.createReport) {
      // The comment after a Create run answers a hidden report. It goes out
      // hidden again; sent as an ordinary message it would stand in the chat
      // as something the customer wrote.
      if (!createActiveHere(useSettingsStore.getState().settings, activeModel)) return false
      const key = useChatStore.getState().forkFrom(conversationId, plan.deleteFromId)
      void Promise.resolve(sendCreateReport(conversationId, plan.content))
        .finally(() => { if (key) useChatStore.getState().restoreEmptyFork(conversationId, key) })
      return true
    }
    // Clips and sound tracks of the question, as far as the session still
    // holds their bytes.
    const anchor = conv.messages.find((m) => m.id === plan.deleteFromId)
    const media = anchor ? pendingMediaOf(anchor) : []
    const key = useChatStore.getState().forkFrom(conversationId, plan.deleteFromId)
    // sendMessage has refusals of its own past the checks above. When one of
    // them wrote nothing, the version that was shown comes back instead of a
    // chat that ends where the question was.
    void sendMessage(plan.content, plan.images, plan.files?.map((attachment) => ({ attachment })), media.length ? media : undefined)
      .finally(() => { if (key) useChatStore.getState().restoreEmptyFork(conversationId, key) })
    return true
  }, [sendMessage, sendCreateReport])

  const regenerateMessage = useCallback((conversationId: string, assistantMessageId: string) => {
    resend(conversationId, assistantMessageId)
  }, [resend])

  /**
   * GH #199: one speaker of a group round answers again, and only that
   * speaker ('only'), or it and every speaker after it in the round
   * ('from-here'). The answers before it stay as they are.
   *
   * The old answer is not lost: it moves into a version like every
   * regenerate since GH #172, and "< 1/2 >" sits on the new answer. With
   * 'only', the later answers of the round come back after the new one, as
   * copies, so each version holds its own. Regenerating the whole round is
   * still `regenerateMessage`.
   *
   * Resolves false when nothing ran (another run in flight, no such speaker
   * at the table any more) or nothing was written; the version shown before
   * comes back then.
   */
  const regenerateSpeaker = useCallback(async (conversationId: string, messageId: string, mode: 'only' | 'from-here'): Promise<boolean> => {
    if (activeChatRuns.has(conversationId)) return false
    const conv = useChatStore.getState().conversations.find((c) => c.id === conversationId)
    if (!conv || !isGroupChat(conv.groupModels)) return false
    const listed = useModelStore.getState()
    const table = availableGroupMembers(conv.groupModels, listed.models, listed.inventoryLoaded)
    const speakers = regenerateSpeakers(conv.messages, messageId, mode, table)
    if (speakers.length === 0) return false
    const kept = mode === 'only' ? laterAnswersInRound(conv.messages, messageId) : []
    const fork = { key: null as string | null }
    const ran = await runGroupRound(conversationId, '', undefined, conv.groupModels, undefined, {
      speakers,
      prepare: () => { fork.key = useChatStore.getState().forkFrom(conversationId, messageId) },
    })
    const key = fork.key
    if (!ran || key === null) return false
    const store = useChatStore.getState()
    const now = store.conversations.find((c) => c.id === conversationId)
    if (!now) return true
    const start = forkStart(now.messages, key)
    const fresh = start < 0 ? [] : now.messages.slice(start)
    if (fresh.every((m) => m.role === 'assistant' && !m.content.trim())) {
      for (const m of fresh) store.deleteMessage(conversationId, m.id)
      store.restoreEmptyFork(conversationId, key)
      return false
    }
    for (const m of copiesForNewVersion(kept, uuid)) store.addMessage(conversationId, m)
    return true
  }, [runGroupRound])

  const editAndResend = useCallback((conversationId: string, messageId: string, newContent: string): boolean => {
    return resend(conversationId, messageId, newContent)
  }, [resend])

  return {
    sendMessage,
    stopGeneration,
    isGenerating: isGenerating || agentChat.isAgentRunning || orphanRun,
    isLoadingModel,
    regenerateMessage,
    regenerateSpeaker,
    editAndResend,
    // Agent mode additions
    isAgentRunning: agentChat.isAgentRunning,
    pendingApproval: agentChat.pendingApproval,
    approveToolCall: agentChat.approveToolCall,
    rejectToolCall: agentChat.rejectToolCall,
  }
}
