import { useRef, useState, useCallback, useEffect } from 'react'
import { frameFlush } from '../lib/frame-flush'
import { useRunActivityStore, toolProgressActivity, waitBeforeRetry, readingActivity, endFirstWait, hiddenThoughtArrived, waitForChatCard } from '../stores/runActivityStore'
import { markCannotThink } from '../lib/model-compatibility'
import {
  type ApprovalEntry,
  subscribeApprovals,
  headApproval,
  enqueueApproval,
  dequeueApproval,
  removeApproval,
  drainApprovals,
} from '../lib/approval-queue'
import { v4 as uuid } from 'uuid'
import { streamProviderTurn, type StreamedProviderTurn } from '../lib/provider-stream'
import { requestUsageTracker } from '../lib/request-usage'
import { createHermesDisplayFilter, createThinkStreamSplitter, createTurnThinkingSink } from '../lib/hermes-stream'
import { beginAgentRun, endAgentRun, setActiveAgentModel, renderWorkspaceSection, takeChatArtifacts, type AgentRunContext } from '../api/agent-context'
import { resolveChatWorkspaceSlug } from '../api/workspace-slug'
import { isOllamaLocal } from '../api/backend'
import { requestGenerationCancel } from '../api/vram-handoff'
import { resolveWorkspace } from '../api/agents/workspace-resolve'
import { useAgentModeStore } from '../stores/agentModeStore'
import { streamOllamaChatWithTools } from '../lib/ollama-stream-tools'
import { questionOnDisk, useChatStore } from '../stores/chatStore'
import { endTurnDurably } from '../stores/durability'
import { useGenerationStore } from '../stores/generationStore'
import { runInLane } from '../lib/run-slot'
import { laneOf, currentLaneFacts } from '../lib/run-lane-of-model'
import { useModelStore } from '../stores/modelStore'
import { useSettingsStore } from '../stores/settingsStore'
import { agentTemperature, buildSamplingRequest, effectiveSampling } from '../lib/sampling'
import { conversationChunksNow, useRAGStore } from '../stores/ragStore'
import { singleModelSlot } from '../lib/capabilities'
import { documentJobRunning, whenSlotIdle } from '../lib/model-slot'
import { retrieveContext } from '../api/rag'
import { isSearchStopped } from '../lib/slot-wait'
import { sourcesFromChunks } from '../lib/rag-sources'
import { buildRagSuffix, RETRIEVAL_FAILED_MESSAGE } from '../lib/rag-prompt'
import { toolRegistry } from '../api/mcp'
import { usePermissionStore } from '../stores/permissionStore'
import { CODEX_CONFIRM_TOOLS, codexConfirmEnabled } from './codexShellGate'
import { isThinkingCompatible, isPlainTextPlanner, declaredVision, isVisionCompatible } from '../lib/model-compatibility'
import { resolveToolCallingStrategy } from '../lib/agent-strategy'
import { isMultimodalUnsupportedError, MULTIMODAL_UNSUPPORTED_MESSAGE } from '../lib/ollama-errors'
import { stripVisionFeedbackMessages, reportMultimodalRefusal } from '../lib/vision-heal'
import { log } from '../lib/logger'
import { gatePlanTool, planToolAllowed } from '../lib/plan-gate'
import { buildHermesToolPrompt, buildHermesToolResult, buildHermesToolCall, parseHermesToolCalls, stripToolCallTags, hasToolCallTags } from '../api/hermes-tool-calling'
import { parseLooseToolCalls, stripMatchedCalls, stripToolCallText, repairToolCall } from '../lib/loose-tool-parse'
import { isMediaTool, mediaCallSucceeded } from '../lib/media-result'
import { isLocalModelByName } from '../api/agents/model-locality'
import {
  mayRunInBackground,
  generationOwnerFor,
  runWithBackgroundGrace,
  startedResult,
  isStartedResult,
  jobIdOfStartedResult,
  newJobId,
  backgroundLabel,
  backgroundGraceMs,
} from '../lib/background-tools'
import { detachToolCall, runMessageStarted, runMessageEnded } from '../stores/backgroundJobStore'
import { summarizeTurn } from '../lib/turn-summary'
import { buildVisionFeedback, dropOlderScreenFrames } from '../api/vision-feedback'
import { COMPUTER_USE_TOOL_NAME, onlyTheTaskForTheScreen, withComputerUsePrompt } from '../lib/computer/prompt'
import { memoryPairForRun } from '../lib/computer/memory-policy'
import { getModelMaxTokens, estimateTokens } from '../lib/context-compaction'
import { buildRequestMessages, trimWorkingHistory } from '../lib/context-decay'
import { budgetBesideTheCatalog, effectiveSendWindow, sendWindowFor } from '../lib/send-window'
import { sendsToALanBackend } from '../lib/lan-openai-slot'
import { speaksOpenAIProtocol } from '../api/providers/compat-id'
import { useSendSizeStore } from '../stores/sendSizeStore'
import { resolveAgentNumCtx } from '../lib/agent-num-ctx'
import { ensureBuiltinAgentCtx } from '../api/builtin-ensure'
import { approvalIsMoot } from '../api/mcp/builtin-tools'
import { useMemoryStore } from '../stores/memoryStore'
import { useVoiceStore } from '../stores/voiceStore'
import { autoSpeak } from '../lib/ttsBridge'
import { getProviderIdFromModel } from '../api/providers'
import { markToolsUnsupported } from '../api/tool-capability'
import { extractMemoriesFromPair } from './useMemory'
import { createSystemText, isCreateToolName, withCreateText } from '../lib/create/chat-switch'
import { isSettingsToolName, SETTINGS_PROMPT_LINE } from '../lib/settings-tool-names'
// Create in chat only where the order card exists: not on the phone (lib/create-order-surface.ts).
import { createLiveHere } from '../lib/create-order-surface'
import {
  CREATE_CLAIM_NOTE, CREATE_CLAIM_STEER, CREATE_ORDER_CLAIM_NOTE, CREATE_ORDER_CLAIM_STEER, CREATE_ORDER_TOOL, claimsCreateOrder, claimsCreateWork, createCallAllowed, createCallSteer, openOrder,
  newCreateCallState, noteCreateResult,
} from '../lib/create/chat-control'
import { useCreateOrderStore } from '../stores/createOrderStore'
import { attachmentNote, registerMessageMedia, sendImagesToModel, type PendingMedia } from '../lib/create/chat-attachments'
import { attachmentLabel, chatImageAttachments, imageAttachmentNote } from '../lib/chat-attachment-input'
import { isMlxImageHost } from '../api/mlx-image'
import { useAgentWorkflowStore } from '../stores/agentWorkflowStore'
import { localMediaToolsExist, workflowsForThisDevice } from '../lib/mobile-tools'
import { isMobile } from '../lib/device-kind'
import { withoutUnansweredTurns } from '../lib/unanswered-turns'
import { platformText } from '../lib/platform-text'
import {
  buildMobileAgentSystemPrompt, buildMobileAgentSystemPromptLean, buildMobileChatToolsSystemPrompt,
} from '../lib/mobile-agent-prompts'
import { WorkflowEngine, describeWorkflowCompletion, describeWorkflowStepFailure } from '../lib/workflow-engine'
import type { AgentBlock, AgentToolCall } from '../types/agent-mode'
import { selectRelevantToolsAsync, toolSelectionOpts, ALWAYS_INCLUDE, SMALL_MODEL_MAX_TOOLS } from '../lib/tool-selection'
import { explicitSearchQuery, searchFallbackQuery, withOrderedQuery } from '../lib/explicit-search'
import { reaRoutingText } from '../lib/plugins/rea-tools'
import { renderToolRoster, renderToolNames } from '../lib/tool-roster'
import { MUTATING_TOOLS, allowedInReadOnlyTurn } from '../lib/mutating-tools'
import { resolveApprovalLevel } from '../lib/agent-approval-policy'
import {
  parseFanoutRequest,
  resolveRequestedModel,
  fanoutDirective,
  unresolvedModelNote,
} from '../lib/agent-fanout'
import { setExplicitFanout, buildSubAgentGates } from '../api/agents/sub-agent'
import { appendTaskReport } from '../lib/agent-task-report'
import { useAgentTaskStore } from '../stores/agentTaskStore'
import { useAgentGoalStore, renderGoalSection } from '../stores/agentGoalStore'
import { endLoopUnlessRearmed, useAgentLoopStore } from '../stores/agentLoopStore'
import { beginRun, isRunStopped, stopRun } from '../lib/run-stop'
import { noteStoppedIfEmpty } from '../lib/stopped-note'
import { REJECTED_CALL_FOR_MODEL } from '../lib/rejected-call'
import { buildLoopRecheck, loopPassSaysDone } from '../lib/agent-commands'
import { applyStoredCompaction } from '../lib/compact-summary'
import { maybeAutoCompact } from '../lib/run-compact-command'
import { autoCompactOn } from '../lib/compact-trigger'
import { compactRunMidway, newRunCompactState } from '../lib/run-compact-midway'
import { generateEmbeddings } from '../api/rag'
import { truncateToolResult } from '../lib/truncate-tool-result'
import { fitRequestForPhone, measuredRequest, phoneFitApplies, phoneResultChars, questionOf, withPhoneToolCap, type PhoneMeasure } from '../lib/phone-context-fit'
import { toolFailureNote } from '../lib/tool-failure-note'
import { toolCallCapMs, raceWithToolTimeout, SHELL_EXECUTE_DEFAULT_TIMEOUT_MS } from '../lib/tool-timeout'
import { AgentLoopGuard } from '../lib/agent-loop-guard'
import { budgetFromSettings } from '../api/agents/budget'
import type { ChatMessage, ToolCall, ToolCallProgress, ToolDefinition } from '../api/providers/types'
import type { WorkflowEngineCallbacks } from '../types/agent-workflows'
import { renderWorkflowStepList, workflowProgressHeader, type WorkflowStepView } from '../lib/workflow-progress-view'
import { executeParallel, applyResultToToolCall, resultFailed, type ExecutionRequest } from '../api/agents/tool-executor'
import { useToolAuditStore } from '../stores/toolAuditStore'
import { makeInTurnCacheLookup } from '../api/agents/in-turn-cache'
import { explainError as explainToolError } from '../api/agents/error-hints'
import { hasUnrecoveredOutsideRefusal, OUTSIDE_WORKSPACE_NOTICE } from '../lib/workspace-refusal'
import { useChatNoticeStore, CHAT_NOTICE_MS } from '../stores/chatNoticeStore'
import { copyFailedMessage, fileMessageFields, filesWithoutWorkspace, placeChatFiles, toolRoutingText, type ChatFileInput } from '../lib/chat-files'
import { fitFilesForSend, requestTextOf } from './chat-file-room'
import { settleThinking } from '../lib/thinking-stripper'
import { openPlanGap, planReconcileSteer, PLAN_RECONCILE_BUDGET } from '../lib/plan-reconcile'
import { planResumeAnchor } from '../lib/plan-resume'
import { reasoningOnlyRound, REASONING_CONTINUE_BUDGET, REASONING_CONTINUE_STEER } from '../lib/reasoning-round'
import { findUnbackedLinks, steerReplyIsNoAnswer, unbackedLinksSteer } from '../lib/unbacked-links'
import { useTodoStore } from '../stores/todoStore'
import { platformPromptLine, hostClockLine } from '../lib/host-platform'
import { buildTurnContext, withTurnContext } from '../lib/turn-context'
import { explainSendRefusal } from '../lib/template-refusal'
import { emptyAnswerExplanation } from '../lib/answer-notes'
import { beginModelSwitchWatch, cutByModelSwitch, finishReasonAfterSwitch, MODEL_SWITCH_FINISH } from '../lib/model-switch-stop'
import { httpStatusOf, isTerminalModelError, retryDelayMs } from '../lib/http-status'
import { requestLimitMessageOf } from '../lib/request-limit'
import { shouldDowngradeThinking, engineDeniedThinking } from './codex/thinking-downgrade'
import { capHiddenToolHistory } from './codex/hidden-history'
// Derselbe Satz wie im Code Reiter, aus derselben Datei: der Fall ist
// derselbe, und zwei Wortlaute fuer einen abgeschnittenen Zug waeren zwei
// Stellen, von denen eine gepflegt wird.
import { codexCutoffNote, dropCutOffCall } from './codex/turn-cutoff'
import { asString, errorText, isRecord, prop } from '../types/json-guards'
import type { ToolArgs } from '../api/mcp/types'
import { CREDITS_EXHAUSTED_MESSAGE } from '../lib/credits-exhausted'
import { buildChatSystemPrompt } from '../lib/system-prompt'
import { withChatPersona, samplingPresetFor, speakerCustomParams, speakerPersonaFor } from '../lib/chat-persona'
import { injectPersonaNote, noteTokens, personaNoteOf } from '../lib/persona-note'

// ── Hook ──────────────────────────────────────────────────────

/**
 * The pending next /loop pass, PER CONVERSATION. MODULE scope, not a hook
 * ref (audit A3): the chat view unmounts on a view switch, and a timer
 * parked in an unmounted instance's ref was unreachable for the remounted
 * hook, stopAgent cleared its own (empty) ref while the old timer kept
 * firing new passes.
 *
 * B2: was a single module VARIABLE, not a map, until this commit. Two
 * conversations each waiting out a /loop interval shared the one handle,
 * the second conversation's `setTimeout` result overwrote the first's, and
 * `clearTimeout` on that overwritten handle canceled the WRONG conversation's
 * pending pass, while the one it meant to cancel kept its real timer running
 * untouched. Keyed by conversation now, the same shape as `agentLoopStore`.
 */
const agentLoopTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Test-only: which conversations currently have a pending /loop timer. */
export function __pendingAgentLoopTimersForTests(): string[] {
  return [...agentLoopTimers.keys()]
}

/**
 * One sendAgentMessage() call's own mutable run state, created fresh inside
 * the call and threaded through the whole turn by closure (the ReAct loop,
 * the streaming callbacks, the tool executor, the error and finally
 * handlers) instead of through hook-instance refs.
 *
 * B2 NEUER FUND: useAgentChat carried the SAME defect useChat.ts fixed in
 * commit 1 (a content ref, a thinking ref and a blocks ref, ONE set per hook
 * instance, and the app mounts exactly one instance), plus a hook-instance
 * abort controller ref, its owning-conversation ref, and a running flag on
 * top. Unlike useChat's plain-text path, this one also had an explicit
 * re-entry guard on that running flag, added 2026-06-16 against a real
 * double-submit bug. That guard turned the
 * SAME defect into a worse symptom for a second, DIFFERENT conversation: a
 * running agent turn in conversation A made a send in conversation B fail
 * SILENTLY (`agent.duplicate_send_blocked`, no message, no error) instead of
 * corrupting A's buffers. Named `runState`, not `run`: `run` already names
 * the AgentRunContext from beginAgentRun() below (the tool-gate scope),
 * unrelated to this buffer.
 */
interface AgentRunState {
  readonly convId: string
  content: string
  thinking: string
  blocks: AgentBlock[]
  readonly abort: AbortController
}

/**
 * Runs currently in flight, keyed by conversation. Doubles as the re-entry
 * guard (a key present means that conversation already has a live run) and
 * as the register stopAgent()/the /loop timer look up by conversation,
 * same shape as agentLoopTimers above, module scope for the same reason: the
 * chat view unmounts on a tab switch, so nothing a run needs afterwards can
 * live in a hook ref.
 */
const activeAgentRuns = new Map<string, AgentRunState>()

/** Test-only: which conversations currently have a live agent run. */
export function __activeAgentRunConvIdsForTests(): string[] {
  return [...activeAgentRuns.keys()]
}

/**
 * Stop the repeat task (/loop) of ONE conversation from outside the hook.
 *
 * The hook's own stopAgent() needs a mounted hook instance. A surface that
 * shows the loop line without holding the hook (the mobile chat notice, a
 * task list) could only set the stop mark and wait for the pending timer to
 * read it. This clears the timer itself, so nothing fires later.
 *
 *   1. marks the run as stopped (the finally of a running pass reads it and
 *      does not arm a next pass),
 *   2. clears the pending timer of the next pass,
 *   3. clears the loop from the store, so the loop line disappears at once,
 *   4. aborts the pass that is running right now. Its own finally frees the
 *      run slot and the generating flag, the same way a finished pass does.
 *
 * It does NOT cancel background tasks or media generation of the
 * conversation: that is what the full Stop (stopAgent) is for.
 *
 * Returns true when there was a loop to stop.
 */
export function stopAgentLoop(conversationId: string | null | undefined): boolean {
  if (!conversationId) return false
  const pendingTimer = agentLoopTimers.get(conversationId)
  const hadLoop = !!pendingTimer || !!useAgentLoopStore.getState().loops[conversationId]
  // No loop: nothing to stop. An ordinary answer of this chat keeps running.
  if (!hadLoop) return false
  stopRun(conversationId)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    agentLoopTimers.delete(conversationId)
  }
  useAgentLoopStore.getState().clear(conversationId)
  const registered = useGenerationStore.getState().aborters[conversationId]
  const run = activeAgentRuns.get(conversationId)
  try {
    if (registered) registered()
    else run?.abort.abort()
  } catch {
    /* the pass is going away anyway */
  }
  return true
}

export function useAgentChat() {
  const [isAgentRunning, setIsAgentRunning] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<AgentToolCall | null>(null)

  // ── Approval callbacks ────────────────────────────────────
  //
  // The queue lives at module scope, keyed by conversation (G29b), so what the
  // user sees is whatever the ACTIVE conversation is waiting on, no matter how
  // many times this view has been torn down since the run started.

  const activeConversationId = useChatStore((s) => s.activeConversationId)

  useEffect(() => {
    const sync = () => setPendingApproval(headApproval(activeConversationId))
    sync() // on mount, adopt an approval a previous instance left behind
    return subscribeApprovals(sync)
  }, [activeConversationId])

  const approveToolCall = useCallback(() => {
    dequeueApproval(useChatStore.getState().activeConversationId)?.resolve(true)
  }, [])

  const rejectToolCall = useCallback(() => {
    dequeueApproval(useChatStore.getState().activeConversationId)?.resolve(false)
  }, [])

  // ── Wait for user approval (enqueues; UI shows head of queue) ──

  function waitForApproval(convId: string, toolCall: AgentToolCall, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      // Audit A4: this promise used to resolve ONLY on a click. Stop while a
      // tool sat awaiting approval meant the resolver was never called, the
      // loop's finally never ran, and the conversation was wedged with the
      // typing dots on forever. An abort now answers "no" for the user.
      if (signal?.aborted) {
        resolve(false)
        return
      }
      const entry: ApprovalEntry = { toolCall, resolve, owner: signal }
      enqueueApproval(convId, entry)
      signal?.addEventListener(
        'abort',
        () => {
          // False when a click already answered it, and then the promise is
          // long settled.
          if (removeApproval(convId, entry)) resolve(false)
        },
        { once: true },
      )
    })
  }

  // ── Add agent block and sync to store ─────────────────────
  // All three take the CALLING TURN's runState (B2) instead of a hook ref,
  // so two conversations adding blocks at the same time write into their
  // own arrays, not a shared one.

  function addBlock(runState: AgentRunState, convId: string, msgId: string, block: AgentBlock) {
    runState.blocks = [...runState.blocks, block]
    useChatStore.getState().updateMessageAgentBlocks(convId, msgId, runState.blocks)
  }

  /**
   * ID-keyed block update — used by the parallel tool executor (Phase 5) so
   * N concurrent tool-call blocks can update independently as their results
   * land out of order. Falls back to no-op on unknown id.
   */
  function updateBlockById(
    runState: AgentRunState,
    convId: string,
    msgId: string,
    blockId: string,
    updates: Partial<AgentBlock>
  ) {
    const idx = runState.blocks.findIndex((b) => b.id === blockId)
    if (idx < 0) return
    const blocks = [...runState.blocks]
    blocks[idx] = { ...blocks[idx], ...updates }
    runState.blocks = blocks
    useChatStore.getState().updateMessageAgentBlocks(convId, msgId, blocks)
  }

  // ── Main agent message handler ────────────────────────────

  const sendAgentMessage = useCallback(async (
    userContent: string,
    userImages?: import('../types/chat').ImageAttachment[],
    // Chat-Tools mode (2026-06-11): plain chat routes a tool-worthy turn
    // here with a CURATED allow-list (the 5 chat tools) + a chat-style prompt,
    // so web/file/image/video work without flipping to full Agent mode. When
    // unset, this is the normal autonomous-agent path (full tool catalog).
    // displayContent: a slash command shows the raw "/commit" the user typed
    // while `userContent` carries the expanded instruction the model receives.
    opts?: {
      curatedTools?: readonly string[]
      chatToolsMode?: boolean
      displayContent?: string
      // A read-only slash command (/review, /plan, /diff, …). Strips the
      // mutating tools for this turn so the command cannot do what it just
      // told the user it would not do.
      readOnly?: boolean
      /** Carried by the /loop driver so a pass knows which pass it is. */
      loop?: { pass: number; intervalMs: number; task: string; startedAt: number }
      // Chat-tools router hint (2026-06-20): when a bare follow-up like
      // "nochmal"/"ok generiere jetzt" continues an in-progress media task, the
      // router passes the task kind + the prior generation's exact args so a weak
      // model that can't emit the call still gets the SAME media synthesized.
      mediaHint?: { kind: 'image' | 'video'; args?: Record<string, unknown> }
      /** Create in chat is on: create_options and create_order go along, the
       *  system prompt gets the Create paragraph, and the loop lets one order
       *  through per reply (lib/create/chat-control.ts). */
      createTools?: boolean
      /** A11: the message is about LU's settings. get_settings and set_setting
       *  go along; every change waits for the user's yes on the card. */
      settingsTools?: boolean
      /** Clips and sound tracks for Create in chat. The message keeps only
       *  the facts, the bytes stay in the session. */
      media?: PendingMedia[]
      /**
       * Die Nutzernachricht dieses Zuges reist versteckt.
       *
       * Fuer den Weckzug eines fertigen Hintergrundagenten: ein Zug braucht
       * eine Nutzernachricht, aber im Verlauf stuende sonst ein Satz, den der
       * Mensch nie geschrieben hat. Der Nutzlastbau filtert `role:'system'`
       * und NICHT `hidden` — die Zeile erreicht also das Modell und nicht das
       * Auge. Denselben Weg nimmt schon die Werkzeugkette, die useCodex nach
       * einem Lauf zurueckschreibt.
       */
      hiddenUser?: boolean
      /**
       * Files attached to this message (3.0.5). In Agent mode they are copied
       * into the chat's working folder before the turn starts, so the file
       * tools can work on the real bytes; in Chat Tools mode (plain chat) the
       * model gets their summaries only. See lib/chat-files.ts.
       */
      files?: ChatFileInput[]
    },
  ) => {
    const { activeModel } = useModelStore.getState()
    const { settings } = useSettingsStore.getState()
    const store = useChatStore.getState()
    const persona = useSettingsStore.getState().getActivePersona()

    if (!activeModel) return

    // ── Workflow trigger detection ──────────────────────────
    // R2, bau/review-wfgate.md klein 1: "run workflow <name>: <input>" lets
    // the text after the FIRST colon answer the workflow's first
    // `user_input` step, the same convention `run_workflow`'s own `input`
    // argument uses (builtin-tools.ts).
    //
    // Nachtrag 1, Runde 3 (bau/review-wfgate.md): a workflow name is a free
    // text field (WorkflowBuilder.tsx), so it can itself contain a colon.
    // Splitting at the FIRST colon unconditionally broke that case
    // silently: "run workflow Deploy: staging" against a workflow actually
    // named "Deploy: staging" used to look for name "Deploy" instead, find
    // nothing, and fall through to an ordinary chat message. Fix: look up
    // the LONGEST workflow name (from the store, case-insensitive like the
    // rest of this match) that the text after "run workflow" starts with,
    // and only take whatever follows it as the ": <input>" answer. Only
    // when no stored name matches at all does this fall back to the old
    // split-at-first-colon behaviour (whose result then simply won't be
    // found below either, same as an unrecognised name always was).
    const runWorkflowMatch = userContent.match(/^run\s+workflow\s+([\s\S]+)$/i)
    let workflowName = ''
    let workflowInput: string | undefined
    if (runWorkflowMatch) {
      const rest = runWorkflowMatch[1].trim()
      const wfStore = { workflows: workflowsForThisDevice(useAgentWorkflowStore.getState().workflows) }
      const byLongestName = [...wfStore.workflows].sort((a, b) => b.name.length - a.name.length)
      const nameMatch = byLongestName.find(w => {
        if (rest.length < w.name.length) return false
        if (rest.slice(0, w.name.length).toLowerCase() !== w.name.toLowerCase()) return false
        const after = rest.slice(w.name.length).trimStart()
        return after === '' || after.startsWith(':')
      })
      if (nameMatch) {
        workflowName = nameMatch.name
        workflowInput = rest.slice(nameMatch.name.length).trimStart().replace(/^:\s*/, '').trim() || undefined
      } else {
        const fallback = rest.match(/^([^:]+?)\s*(?::\s*([\s\S]*))?$/)
        workflowName = fallback?.[1]?.trim() ?? rest
        workflowInput = fallback?.[2]?.trim()
      }
      const workflow = wfStore.workflows.find(
        w => w.name.toLowerCase() === workflowName.toLowerCase()
      )
      if (workflow) {
        // Delegate to workflow engine
        let convId = store.activeConversationId
        if (!convId) {
          convId = store.createConversation(activeModel, persona?.systemPrompt || '')
        }

        // R2-1, bau/review-wfgate.md (blockierend): `activeAgentRuns` is the
        // re-entry guard documented above (a key present means THIS
        // conversation already has a live run), and this trigger used to
        // register its OWN run before that check ever ran, below at the
        // guard for the normal send path. A workflow started while an
        // ordinary agent turn (or a second workflow) was already running in
        // the SAME conversation overwrote that turn's `AgentRunState` in the
        // map: `stopAgent` then found only the new workflow, and the
        // displaced turn's own `finally` removed the entry out from under
        // it, orphaning its abort handle entirely. Same check as the
        // existing guard, moved in front of every side effect this trigger
        // has (the chat messages included), so a "run workflow" sent while a
        // turn is live is cleanly refused instead of stealing its slot.
        if (activeAgentRuns.has(convId)) {
          log.info('agent.duplicate_send_blocked', { activeModel, convId })
          return
        }

        // R2, bau/review-wfgate.md klein 1/2: a workflow that asks a
        // question (`user_input`) cannot be answered while it runs -
        // neither this trigger nor `run_workflow` wires anything to
        // `provideUserInput`, so without a prefilled answer the FIRST such
        // step would wait forever, stoppable only by hand. Refuse up front
        // with the fix instead of starting a run nobody can finish.
        const firstAsk = workflow.steps.find(s => s.type === 'user_input')
        if (firstAsk && !workflowInput) {
          useChatStore.getState().addMessage(convId, {
            id: uuid(), role: 'user', content: userContent, timestamp: Date.now(),
          })
          useChatStore.getState().addMessage(convId, {
            id: uuid(),
            role: 'assistant',
            content: `Workflow "${workflow.name}" starts by asking "${firstAsk.userInputPrompt || 'for input'}", and nothing can answer that while it runs. Send "run workflow ${workflow.name}: <your answer>" to provide it up front.`,
            timestamp: Date.now(),
          })
          return
        }

        useChatStore.getState().addMessage(convId, {
          id: uuid(), role: 'user', content: userContent, timestamp: Date.now(),
        })
        // klein 2 (bau/wfprogress.md): this message used to end on a bare
        // "...", never changing for the whole run: the ONLY feedback a
        // multi-minute workflow gave was three static dots, unlike every
        // other tool call, which shows a running/working status block. The
        // trailing "..." is dropped here; `progressMessageId` below carries
        // the SAME per-step ToolCallBlock/ToolCallBand pattern real tool
        // calls use instead, updated live from the engine's onStepStart/
        // onStepComplete/onStepError callbacks.
        const progressMessageId = uuid()
        useChatStore.getState().addMessage(convId, {
          id: progressMessageId, role: 'assistant', content: `Running workflow: **${workflow.name}**`, timestamp: Date.now(),
        })

        // B1 (lu-301/bau/klaerung-n7.md): a workflow that ends in
        // `memory_save` (every built-in one does) used to show only that
        // step's own receipt ("Saved to memory: ...") at the end, because
        // the old `onComplete` picked `results.filter(r => r.output).pop()`,
        // the LAST step with any output, which memory_save always is.
        // That buried the actual content (a `prompt` step's summary) behind
        // a cryptic one-liner indistinguishable from a hang. Fix lives in
        // `describeWorkflowCompletion` (workflow-engine.ts), shared with
        // `builtin-tools.ts`'s `run_workflow` tool so the two do not drift.
        //
        // `hadStepError` mirrors that same shared engine's other caller: a
        // failed step's `onStepError` already posts a message, and `runSteps`
        // (workflow-engine.ts) still calls `onComplete` right after that
        // break, so without this flag a second message would follow,
        // repeating whatever ran before the failure.
        //
        // Auflage 2.1 (review-offload2.md): the box's "Research Topic" run
        // finished "successfully" in seconds with idle GPU because
        // `executeWebSearch`/`executeWebFetch` returned failure text that did
        // not start with "Error:", so `executeToolStep` never marked the step
        // failed. Those tool responses are fixed at the source now
        // (builtin-tools.ts), and a failure IS reported here with WHERE it
        // happened, not a bare "Workflow error: ...".
        // Nebenbefund, bau/review-wfplay.md Teil B: this trigger used to hand
        // the engine no gate at all, so a workflow's own tool steps ran
        // unattended. Reusing `buildSubAgentGates` (audit AGT-1's fix, same
        // approach a delegated sub-agent already gets) reaches the SAME
        // conversation-keyed approval queue and permission store the rest of
        // Agent mode uses, so the user sees the same "Requesting approval"
        // block, not a bespoke one for workflows.
        //
        // Auflage 8, bau/review-wfgate.md: without an `abortSignal` here, the
        // abort listener inside `buildSubAgentGates`'s gate never fired, and
        // this run was never registered in `activeAgentRuns`, so `stopAgent`
        // had no handle to actually cancel the engine's own in-flight prompt
        // step, only `drainApprovals` happened to also clear a QUEUED
        // approval as an accident of being keyed on the same `convId`.
        // Registering this run the same way every other agent turn does
        // gives Stop both a real `abortSignal` to close the gate with and a
        // live engine to call `cancel()` on.
        //
        // Declared here (before `callbacks`) because onStepStart/onStepComplete
        // below write into `workflowRunState.blocks` the same way the normal
        // tool-call loop writes into its own run state (see addBlock/
        // updateBlockById above).
        const workflowAbort = new AbortController()
        const workflowRunState: AgentRunState = { convId, content: '', thinking: '', blocks: [], abort: workflowAbort }

        // klein 2 (bau/wfprogress.md) + Zusatz vom Eigner, 20.09.2026: ONE
        // AgentToolCall-shaped block for the whole run, added once and
        // updated in place, the exact addBlock/updateBlockById pattern the
        // normal agent tool loop already uses (see the `run_workflow`-less
        // path below), so this is the SAME clickable, downward-expanding
        // ToolCallBlock a real tool call gets: same header/spinner while
        // running, same "click to expand" body. The body (`result`, rendered
        // in the block's existing details pane) is the full step list from
        // `workflow-progress-view.ts`: every step's status (waiting/running/
        // done/failed), each finished step's truncated args+result (tool
        // steps) or the start of the model's answer (prompt steps), and the
        // currently running step's LIVE text as it streams in
        // (`onStepProgress`). The block stays mounted and expandable after
        // the run ends; the existing honest completion/error message still
        // follows as its own chat message, unchanged.
        const stepViews: WorkflowStepView[] = workflow.steps.map((step) => ({ step, status: 'pending' as const }))
        const progressBlockId = uuid()
        const progressToolCallId = uuid()
        const progressStartedAt = Date.now()

        type ProgressStatus = 'running' | 'completed' | 'failed' | 'stopped'
        // klein 4 (Runde 2 review): `onStepProgress` fires per STREAM CHUNK,
        // and a fast local model produces thousands of them per step. Writing
        // the store on every one is the exact thing the normal agent turn's
        // own `scheduleUIUpdate` (above, the main loop further down this
        // file) already avoids with a `requestAnimationFrame` coalesce; this
        // is the same pattern, scoped to the workflow's own block. Every
        // call that reaches a TERMINAL or step-boundary state (onStepStart/
        // onStepComplete/onStepError/onComplete/onError/onStopped) still
        // writes immediately, never through this throttle, so "the final
        // state at the end of a step is written for sure" holds regardless
        // of whatever frame is or is not pending.
        let currentProgressStatus: ProgressStatus = 'running'
        let progressFrameScheduled = false

        const pushProgressBlock = (status: ProgressStatus) => {
          currentProgressStatus = status
          if (!convId) return
          const now = Date.now()
          // B1 (Blocker, Runde 2): a genuine Stop gets its own honest label
          // and status ('stopped', not 'failed'), since nothing broke, the
          // run was simply cancelled. `workflowProgressHeader` only knows "running step
          // X" and "(n/m steps)", neither of which is true here.
          const toolName = status === 'stopped'
            ? `Workflow: ${workflow.name} (stopped)`
            : workflowProgressHeader(workflow.name, stepViews)
          const ac: AgentToolCall = {
            id: progressToolCallId,
            toolName,
            args: {},
            status,
            result: renderWorkflowStepList(stepViews),
            timestamp: progressStartedAt,
            startedAt: progressStartedAt,
            completedAt: status === 'running' ? undefined : now,
            duration: status === 'running' ? undefined : now - progressStartedAt,
          }
          updateBlockById(workflowRunState, convId, progressMessageId, progressBlockId, {
            content: ac.toolName,
            toolCall: ac,
            toolCalls: [ac],
          })
        }

        // Reads `currentProgressStatus` at FIRE time, not a captured
        // 'running', so a stray frame that outlives the step (or the whole
        // run) then writes whatever the run's real, current status is
        // instead of stomping a terminal write that already landed.
        const scheduleProgressUpdate = () => {
          if (progressFrameScheduled) return
          progressFrameScheduled = true
          requestAnimationFrame(() => {
            progressFrameScheduled = false
            pushProgressBlock(currentProgressStatus)
          })
        }

        // Mounted once, before the engine starts, so the block exists and is
        // already expandable (every step listed as "waiting") the instant
        // the run begins, not only once the first step starts.
        addBlock(workflowRunState, convId, progressMessageId, {
          id: progressBlockId,
          phase: 'tool_call',
          content: workflowProgressHeader(workflow.name, stepViews),
          toolCall: {
            id: progressToolCallId, toolName: workflowProgressHeader(workflow.name, stepViews), args: {},
            status: 'running', result: renderWorkflowStepList(stepViews), timestamp: progressStartedAt, startedAt: progressStartedAt,
          },
          toolCalls: [{
            id: progressToolCallId, toolName: workflowProgressHeader(workflow.name, stepViews), args: {},
            status: 'running', result: renderWorkflowStepList(stepViews), timestamp: progressStartedAt, startedAt: progressStartedAt,
          }],
          timestamp: progressStartedAt,
        })

        let hadStepError = false
        const callbacks: WorkflowEngineCallbacks = {
          onStepStart: (stepIndex, step) => {
            const view = stepViews[stepIndex]
            if (view) {
              view.status = 'running'
              view.step = step
            }
            pushProgressBlock('running')
          },
          onStepProgress: (stepIndex, partialOutput) => {
            const view = stepViews[stepIndex]
            if (view) view.output = partialOutput
            scheduleProgressUpdate()
          },
          onStepComplete: (stepIndex, result) => {
            const view = stepViews[stepIndex]
            if (view) {
              view.status = 'completed'
              view.output = result.output
              view.args = result.toolCalls?.[0]?.args
            }
            pushProgressBlock('running')
          },
          onStepError: (i, error) => {
            hadStepError = true
            const view = stepViews[i]
            if (view) {
              view.status = 'failed'
              view.error = error
            }
            pushProgressBlock('failed')
            if (convId) {
              useChatStore.getState().addMessage(convId, {
                id: uuid(), role: 'assistant', content: describeWorkflowStepFailure(workflow, i, error), timestamp: Date.now(),
              })
            }
          },
          onWaitingForInput: () => {},
          onComplete: (allResults) => {
            // Any step neither completed nor failed never ran (a condition
            // branched past it, or the chain stopped before reaching it), so
            // it is named "skipped" (the SAME StepStatus a real skip already
            // uses) instead of staying "waiting" forever after the run is over.
            for (const result of allResults) {
              const idx = workflow.steps.findIndex((s) => s.id === result.stepId)
              const view = idx >= 0 ? stepViews[idx] : undefined
              if (view && view.status !== 'failed') {
                view.status = result.status === 'failed' ? 'failed' : 'completed'
                view.output = result.output
                view.args = result.toolCalls?.[0]?.args ?? view.args
              }
            }
            for (const view of stepViews) {
              if (view.status === 'pending' || view.status === 'running') view.status = 'skipped'
            }
            pushProgressBlock(hadStepError ? 'failed' : 'completed')
            if (hadStepError || !convId) return
            useChatStore.getState().addMessage(convId, {
              id: uuid(), role: 'assistant', content: describeWorkflowCompletion(workflow, allResults), timestamp: Date.now(),
            })
          },
          onError: (err) => {
            for (const view of stepViews) {
              if (view.status === 'pending' || view.status === 'running') view.status = 'skipped'
            }
            pushProgressBlock('failed')
            if (convId) {
              useChatStore.getState().addMessage(convId, {
                id: uuid(), role: 'assistant', content: `Workflow error: ${err}`, timestamp: Date.now(),
              })
            }
          },
          // B1 (Blocker, Runde 2): the ONE remaining terminal state, for
          // when Stop fired between two steps, or during a step that finished
          // normally despite the abort signal, so neither `onStepError` nor
          // `onError` ever reported a terminal outcome. Whatever the engine
          // DID complete before the stop is folded in the same way
          // `onComplete` folds it; whatever never ran (still 'pending') or
          // was interrupted mid-run ('running') is marked skipped, same
          // vocabulary a real branch-skip already uses. No chat message is
          // added: Stop has never added one for the ordinary agent loop
          // either, the block itself is the honest record.
          onStopped: (partialResults) => {
            for (const result of partialResults) {
              const idx = workflow.steps.findIndex((s) => s.id === result.stepId)
              const view = idx >= 0 ? stepViews[idx] : undefined
              if (view && view.status !== 'failed') {
                view.status = result.status === 'failed' ? 'failed' : 'completed'
                view.output = result.output
                view.args = result.toolCalls?.[0]?.args ?? view.args
              }
            }
            for (const view of stepViews) {
              if (view.status === 'pending' || view.status === 'running') view.status = 'skipped'
            }
            pushProgressBlock('stopped')
          },
        }

        const gates = await buildSubAgentGates({
          token: `workflow-trigger-${convId}`,
          chatId: null,
          conversationId: convId,
          workspace: null,
          artifactMode: false,
          readOnlyShellTurn: false,
          mode: null,
          artifacts: [],
          abortSignal: workflowAbort.signal,
        })
        // `workflowInput` (the text after "run workflow <name>:") answers
        // this run's first `user_input` step the same way `run_workflow`'s
        // own `input` argument does (klein 1 above); `undefined` when the
        // workflow needs no answer at all, matched by the `!firstAsk` branch
        // that skipped the refusal above.
        const initialVars: Record<string, string> | undefined = workflowInput
          ? { user_input: workflowInput, last_output: workflowInput }
          : undefined
        const engine = new WorkflowEngine(workflow, convId, callbacks, gates.awaitApproval, initialVars)
        workflowAbort.signal.addEventListener('abort', () => engine.cancel(), { once: true })
        activeAgentRuns.set(convId, workflowRunState)
        setIsAgentRunning(true)
        try {
          await engine.run()
        } finally {
          if (activeAgentRuns.get(convId) === workflowRunState) {
            activeAgentRuns.delete(convId)
            setIsAgentRunning(activeAgentRuns.size > 0)
          }
        }
        return
      }
    }

    // ── Resolve provider + tool calling strategy ────────────
    // G26/G32/G37b: the SAME layered resolution as Code, the Agent toggle and
    // the workflow engine (proven capability cache > the server's own answer >
    // family name), for EVERY provider. This block used to be an inline copy
    // of resolveToolCallingStrategy and the copies drifted (that was G32b);
    // now there is one resolution and every surface calls it.
    const { strategy, modelToUse, modelId, providerId, provider } = await resolveToolCallingStrategy(activeModel)

    // Create or get conversation. Resolved HERE, before the guard below, so
    // the guard is keyed to the conversation this call belongs to instead of
    // the whole hook instance (B2 NEUER FUND, see the AgentRunState doc
    // comment above this hook).
    let convId = store.activeConversationId
    if (!convId) {
      convId = store.createConversation(activeModel, persona?.systemPrompt || '')
    }

    // ── Re-entry guard (double-submit), PER CONVERSATION ─────────────────
    // An accidental double-send (two Enters before the React `isGenerating`
    // prop flips Send → Stop) used to start a SECOND agent loop for the SAME
    // conversation. Both loops shared the streaming refs AND each kept its
    // OWN per-turn over-generation caps (maxImageGen/maxVideoGen), so each
    // fired its own image/video tool, live repro: ONE prompt sent twice ran
    // video_generate 4x (gemma4:e4b + SVD-XT, 2026-06-16). Claim the
    // lock synchronously HERE, strategy resolution above can await, the
    // critical section (message add, run state, the loop) is all below, so
    // a racing second call for the SAME conversation bails before
    // duplicating anything.
    //
    // B2 NEUER FUND: the guard used to be keyed to the whole hook instance,
    // not to `convId`. A run in flight for conversation A then blocked a
    // send in a completely different conversation B just as silently as a
    // real double-submit, no message, no error, the run simply never
    // started. Keying it to `convId` restores the original double-submit
    // protection and drops the cross-conversation false positive.
    if (activeAgentRuns.has(convId)) {
      log.info('agent.duplicate_send_blocked', { activeModel, convId })
      return
    }
    const abort = new AbortController()
    const runState: AgentRunState = { convId, content: '', thinking: '', blocks: [], abort }
    activeAgentRuns.set(convId, runState)
    // A brand-new instruction clears a previous stop; a /loop pass inherits it,
    // which is what makes Stop end the LOOP and not just the pass in flight.
    // Cleared HERE, in the same beat as the claim, because the Stop button is
    // live from the next line on: cleared after the awaits below, it wiped a
    // Stop pressed right after Send and the run went on (Gegenprobe 01.10.2026).
    if (!opts?.loop) beginRun(convId)
    beginModelSwitchWatch(convId)
    // Flip the INPUT gate true in the SAME synchronous beat as the claim
    // above (2026-06-16, bug A). The input shows Send vs Stop off
    // `isAgentRunning`, which used to flip true only ~80 lines down, AFTER
    // the RAG + memory-retrieval awaits. In that window the guard was
    // already claimed (so it silently dropped a resend) while the input
    // still showed Send, so the first message right after a generation
    // looked like it "didn't go through". Both signals now go true together
    // here; "true" means "at least one conversation has a run in flight",
    // same meaning as before now that more than one CAN be in flight at
    // once. The only early return before the try (no conv) undoes both.
    setIsAgentRunning(true)

    // Lane admission (Runde 4, review-lanes.md Blocker 1+6): everything from
    // here to the end of this call (RAG, memory, the tool loop, the /loop
    // driver) runs inside runInLane's body, so a local turn that has to wait
    // for the built-in engine's one llama-server slot has not yet touched the
    // chat store when it is queued, so nothing has been added that a cancelled
    // wait would need to unwind. The re-entry guard above already claimed
    // activeAgentRuns/isAgentRunning synchronously, before any await, so a
    // second send on the SAME conversation is refused before it ever reaches
    // the lane; a wait here is always a DIFFERENT conversation's turn.
    //
    // 'cancelled-while-queued' means Stop was pressed while this run was
    // still in the waiting room: the body (and its own finally below) never
    // ran, so the guard this call claimed above has to be freed here instead.
    const lane = laneOf(activeModel, currentLaneFacts())
    const laneOutcome = await runInLane(
      { conversationId: convId, lane, abort: () => abort.abort() },
      async (heldLocalLane) => {

    // Z36 finding 2: an agent turn carries the tool catalogue and outgrows
    // the built-in engine's 8192 start default, and llama-server's ctx is a
    // start-time flag no per-request option can raise. Lift the engine to
    // the agent ceiling (min of the GGUF's trained ctx and AGENT_CONTEXT_CAP)
    // BEFORE resolveAgentNumCtx reads the started ctx as the run budget.
    // No-op for every other provider; never throws.
    try {
      await ensureBuiltinAgentCtx(modelToUse)
    } catch { /* run with whatever the engine has */ }

    const memoryScope = store.conversations.find(c => c.id === convId)?.memoryScope

    // Publish a HUMAN-READABLE slug ("create-an-index-7f2c3d") so
    // built-in tools land in `~/agent-workspace/<slug>/`. Previously
    // this was the raw conversation UUID — folders were technically
    // isolated but the user couldn't tell which chat owned which
    // workspace by looking.
    //
    // Resolved, not recomputed: the name is pinned to the conversation the
    // first time it is needed and frozen there. Deriving it from the title on
    // every turn meant the app's own auto-rename moved the folder mid-run and
    // the agent lost its files between round one and round two (counter-check
    // round 2, 2026-08-29). See api/workspace-slug.ts.
    const convForSlug = useChatStore.getState().conversations.find((c) => c.id === convId)
    const slug = await resolveChatWorkspaceSlug(convId, convForSlug?.title)

    // Multi-Repo Agent (B15) + workspace unification (B17): pin the
    // resolved workspace so chatCtx() in builtin-tools.ts threads it
    // through to the Tauri side, and the system-prompt section can
    // list any extra repo paths. Precedence: per-chat pick →
    // settings.defaultWorkspace → null (bridge keeps using the slug
    // sandbox under ~/agent-workspace/<slug>/).
    const resolvedWorkspace = resolveWorkspace({
      perChat: useAgentModeStore.getState().workspaces[convId],
      defaultWorkspace: settings.defaultWorkspace,
    })

    // Open the run context (plan 2.6.6 C1, ERZWINGUNG). Everything a tool gate
    // needs travels on THIS object and is handed to each tool call, so a
    // Coding run that starts or ends while this one is in flight cannot flip
    // our read-only flag, repoint our workspace, or capture our writes.
    //
    // Read-only turn: shell_execute stays offered (it carries the git
    // inspectors since the 2.6.6 merge), the executor refuses everything that
    // is not an inspection command.
    //
    // Chat-tools (plain chat) → "file writes" become in-chat artifacts
    // (preview + download), never disk writes (ChatGPT-style, the owner
    // 2026-06-12). Full Agent mode keeps writing to disk, so artifactMode is
    // ON only for chatToolsMode.
    const run: AgentRunContext = beginAgentRun({
      chatId: slug,
      conversationId: convId,
      workspace: resolvedWorkspace,
      readOnlyShellTurn: opts?.readOnly === true,
      artifactMode: opts?.chatToolsMode === true,
      // The Ask/Bypass/Plan presets are a Code-tab concept. The Agent surface
      // keeps reading the plain settings, which is the whole point of C1's
      // BINDUNG: a Bypass in a coding conversation must not reach here.
      mode: null,
      // This chat draws the set_setting card (ToolCallBlock).
      settingsCard: true,
    })

    // Feature EE (v2.5.0) — pin the text model driving this loop so the VRAM
    // hand-off orchestrator (image/video generation) knows which model to
    // evict-then-reload around a ComfyUI run. We use the already-resolved
    // `modelToUse` (the `-agent` variant when one exists) so a reload hits the
    // same runner this chat is using. `remote` is true for a non-local Ollama
    // base (LAN / Docker / cluster) — those hold no LOCAL VRAM, so the
    // orchestrator will skip all juggling. Cloud providers are caught by
    // providerId !== 'ollama' on the orchestrator side.
    setActiveAgentModel({
      name: modelToUse,
      providerId,
      remote: providerId === 'ollama' ? !isOllamaLocal() : false,
    })

    // Attached files. Full Agent mode works in a real folder, so the file goes
    // there first and the message names its path; Chat Tools writes nothing to
    // disk (artifact mode), so there the summary is all the model gets. A copy
    // that fails never stops the turn: the block then says that only the
    // summary is available, and the line above the transcript tells the user.
    let attachedFiles = filesWithoutWorkspace(opts?.files)
    if (opts?.files?.length && opts.chatToolsMode !== true) {
      const placed = await placeChatFiles(opts.files, {
        chatId: slug,
        ...(resolvedWorkspace?.kind === 'folder' && resolvedWorkspace.path
          ? { workingDirectory: resolvedWorkspace.path }
          : {}),
      })
      attachedFiles = placed.files
      if (placed.failed.length) {
        useChatNoticeStore.getState().show('file-attach', copyFailedMessage(placed.failed), 'ruhig', CHAT_NOTICE_MS)
      }
    }
    // GH #171: an attached text goes out whole when it fits, and as far as it
    // fits otherwise, with a line saying so. Chat Tools sends in the chat
    // window; full Agent mode in the agent window, beside its tool catalogue.
    const fileSurface = opts?.chatToolsMode === true ? 'chat' : 'workspace'
    attachedFiles = await fitFilesForSend({
      files: attachedFiles,
      models: [modelToUse],
      use: fileSurface === 'chat' ? 'chat' : 'agent',
      otherText: requestTextOf(useChatStore.getState().conversations.find((c) => c.id === convId), userContent),
      surface: fileSurface,
    })
    const fileFields = fileMessageFields(userContent, attachedFiles, fileSurface)

    // Create on: the model learns what hangs on the message (a model without
    // eyes would not see an image, and no model sees a clip). The customer
    // still sees only their own text.
    const media = opts?.media ?? []
    // A12 (Discord 20.10.2026): an attached picture is the input of
    // image_generate / video_generate by its number in the chat, never by a
    // filename the model has to guess (lib/chat-attachment-input). Create in
    // chat has its own handles; a Mac's image engine takes no input picture.
    const imageToolTakesAttachments = !opts?.createTools && !opts?.readOnly && !isMlxImageHost()
      && !!toolRegistry.getToolByName('image_generate')
      && (!opts?.curatedTools || opts.curatedTools.includes('image_generate'))
    const imageToolNote = imageToolTakesAttachments && !!userImages?.length
    const priorImages = chatImageAttachments(useChatStore.getState().conversations.find((c) => c.id === convId)?.messages ?? []).length
    const createNote = opts?.createTools
      ? attachmentNote(userImages ?? [], media)
      : imageToolNote ? imageAttachmentNote(userImages ?? [], priorImages + 1) : ''

    // Add user message
    const userMessage = {
      id: uuid(),
      role: 'user' as const,
      // With files: the typed text plus one summary block per file, and the
      // typed text alone as what the bubble shows. `userContent` itself stays
      // the typed text for retrieval, memory and tool selection below.
      ...fileFields,
      ...(createNote ? { content: `${fileFields.content}\n\n${createNote}`, displayContent: fileFields.displayContent ?? userContent } : {}),
      // Slash command: show "/commit" to the user, keep the expansion in content.
      ...(opts?.displayContent ? { displayContent: opts.displayContent } : {}),
      ...(opts?.hiddenUser ? { hidden: true } : {}),
      ...(media.length ? { media: media.map(({ kind, mimeType, name, size }) => ({ kind, mimeType, name, size })) } : {}),
      images: userImages,
      timestamp: Date.now(),
    }
    registerMessageMedia(userMessage.id, media.map((m) => m.blob))
    useChatStore.getState().addMessage(convId, userMessage)

    // Add empty assistant message
    const assistantMessage = {
      id: uuid(),
      role: 'assistant' as const,
      content: '',
      thinking: '',
      // Same record the plain path writes (Meldung 4, R5 re-measure
      // 2026-08-30): the answer names the model that produced it. modelToUse
      // rather than activeModel, because that is the runner this turn goes to,
      // including the "-agent" variant when one exists.
      modelId: modelToUse,
      timestamp: Date.now(),
      agentBlocks: [],
    }
    useChatStore.getState().addMessage(convId, assistantMessage)
    // The request's sum over every model call of this run, the line under
    // the answer (lib/request-usage). `usage` keeps only the last call.
    const requestUsage = requestUsageTracker(convId, assistantMessage.id)

    // Build conversation context
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId)
    if (!conv) {
      activeAgentRuns.delete(convId)
      setIsAgentRunning(activeAgentRuns.size > 0)
      return
    }

    // RAG context injection
    // Per-chat persona toggle — default OFF. Only apply persona prompt
    // when user explicitly flipped it on. See useChat.ts for the
    // full rationale (Devil's Advocate hijack bug).
    // GH #170: the persona of THIS chat, the one its Plugins menu names.
    const { personas, activePersonaId } = useSettingsStore.getState()
    const systemPrompt = buildChatSystemPrompt(withChatPersona(conv, personas, activePersonaId), settings.personasEnabled !== false)
    // Phone only (the rest of N2): the question is on the disk before a
    // model is asked. Same short cap as in useChat (questionOnDisk). No
    // await at all on a desktop.
    if (isMobile()) await questionOnDisk()
    // Phone only: a document that is being read right now belongs to this
    // answer. Wait for it before looking at the documents at all, or the run
    // goes on with the list from before the reading (N3 on Android). Stop
    // ends the wait through the run's own signal. Resolves at once on a desktop.
    if (singleModelSlot() && documentJobRunning()) await whenSlotIdle(abort.signal)
    let ragState = useRAGStore.getState()
    const ragEnabled = ragState.ragEnabled[convId] ?? false
    let ragSuffix = ''

    // One model slot (a phone): the slot may also be taken by something other
    // than a document (the model answering in another chat). The run waits
    // HERE, with its own abort as the handle, so Stop ends the wait at once
    // (lib/model-slot.ts). Resolves at once on a desktop and whenever the slot
    // is free. A stopped run skips the search; the loop below sees the
    // aborted signal and ends without a request.
    await whenSlotIdle(abort.signal)

    if (ragEnabled && !abort.signal.aborted) {
      // Guard the lock: a throw here (before the main try/finally below) would
      // otherwise leave activeAgentRuns stuck claimed and wedge the chat (the
      // re-entry guard set it above). Degrade gracefully to no RAG context on
      // failure.
      try { await ragState.loadChunksFromDB(convId) } catch (e) { log.error('RAG chunk load failed', { e }) }
      const chunks = ragState.getConversationChunks(convId)
      if (chunks.length > 0) {
        try {
          // Phone only: the search waits while the model on this device
          // answers in another chat, and Stop ends that wait (api/rag.ts).
          // On a desktop the options are not read.
          const { context: ragContext } = await retrieveContext(
            userContent,
            // Taken again once the search has the slot (see useChat).
            singleModelSlot() ? () => conversationChunksNow(convId) : chunks,
            ragState.embeddingModel, undefined,
            { conversationId: convId, signal: abort.signal },
          )
          ragState = useRAGStore.getState()
          // Same builder plain chat uses (lib/rag-prompt.ts), so the two
          // surfaces cannot drift apart. It rides at the END of the prompt,
          // behind persona and memory, because retrieval changes every turn and
          // at offset 0 it cost the upstream prefix cache the whole prompt
          // (plan A5). Empty in, empty out: a turn without a hit spends no
          // tokens on an instruction pointing at no context.
          ragSuffix = buildRagSuffix(ragContext.chunks)
          // Same record plain chat writes (lib/rag-sources.ts).
          if (ragContext.chunks.length > 0) {
            useChatStore.getState().updateMessageSources(
              convId,
              assistantMessage.id,
              sourcesFromChunks(ragContext.chunks, ragState.documents[convId] ?? []),
            )
          }
          ragState.setRetrievalError(null)
        } catch (err) {
          // Stop during the wait for the slot is no failed search: the loop
          // below sees the aborted signal and ends without a request.
          if (!isSearchStopped(err)) {
            log.error('RAG retrieval failed', { err })
            // Same statement plain chat makes (review S4). An agent run that
            // quietly lost its documents is worse, not better: it goes on to act
            // on what it did not read.
            ragState.setRetrievalError(RETRIEVAL_FAILED_MESSAGE)
          }
        }
      }
    }

    // Memory context injection (context-aware, sanitized)
    let memoryContext = ''
    try {
      const memContextTokens = await getModelMaxTokens(activeModel)
      // Small-Model Mode: clamp the memory budget tier so only the few
      // highest-signal memories inject (≤4096 tier = 3 memories, user+feedback
      // types only). Stops stale project/reference lore (e.g. an old image/video
      // generation note) from leaking into an unrelated tool turn and diluting a
      // small model's limited attention — extra context measurably hurts
      // small-model tool-calling (LongFuncEval, arXiv 2505.10570).
      const memTier = settings.smallModelMode ? Math.min(memContextTokens, 4096) : memContextTokens
      // Embedding-first retrieval; falls back to keyword scoring offline.
      const selectedMemory = await useMemoryStore.getState().getMemoryContextAsync(userContent, memTier, { scope: memoryScope })
      // Behind the newest message, not in the system prompt: the pick
      // changes with every message (lib/turn-context.ts, A7).
      memoryContext = selectedMemory.text
    } catch {
      // Memory injection is non-critical
    }

    // Get effective permissions for this conversation
    const permissions = usePermissionStore.getState().getEffectivePermissions(convId!)

    // Chat-Tools mode: restrict the catalog to the curated allow-list so the
    // model in plain chat only ever sees the 5 chat tools (and small models
    // aren't drowned in the full ~24-tool set).
    const curated = opts?.curatedTools
    // A local model does a screen task in a conversation of its own
    // (computer_task): a short loop with its own history and its own rules
    // for when to stop. Step by step in this chat (computer_use) it carried
    // every look in the history of the chat and went in circles (box,
    // 09.10.2026). A cloud model keeps both.
    const screenByTaskOnly = onlyTheTaskForTheScreen(providerId, (name) => !!toolRegistry.getToolByName(name), activeModel)
    // Cloud mode makes pictures and clips through Create, never through this
    // computer's pipeline: plain chat already strips the local pair (useChat),
    // Agent mode offered it next to create_order, and a small model then
    // rendered locally what the customer meant to order (A13).
    const localMediaOff = useSettingsStore.getState().settings.appMode === 'cloud'
    // The settings pair rides only on a turn about settings (A11).
    const toolMatchesCurated = (name: string) =>
      (!curated || curated.includes(name)) && !(opts?.readOnly && !allowedInReadOnlyTurn(name)) && !(screenByTaskOnly && name === COMPUTER_USE_TOOL_NAME)
      && !(localMediaOff && isMediaTool(name))
      && (opts?.settingsTools === true || !isSettingsToolName(name))
    // Cloud mode AND Create in chat released for the account. Without the
    // release every text and rule in this loop is the one that shipped before.
    const createLive = createLiveHere()
    // Create on: the two tools go along with every message. The relevance
    // router knows no keyword for them and would drop them on "what a nice
    // day"; they are put back, whatever it chose.
    // The settings pair likewise: the router has no say once the message is
    // about settings.
    const withCreateTools = <T extends { name: string }>(chosen: T[], all: T[]): T[] => {
      const extra = (n: string) => (opts?.createTools && isCreateToolName(n)) || (opts?.settingsTools && isSettingsToolName(n))
      return opts?.createTools || opts?.settingsTools
        ? [...chosen, ...all.filter((t) => extra(t.name) && toolMatchesCurated(t.name) && !chosen.some((c) => c.name === t.name))]
        : chosen
    }

    // ── Die Werkzeugliste fuer den Rueckfallweg ─────────────────────────────
    //
    // Hier stand `toolRegistry.toHermesToolDefs(permissions)` — also der ganze
    // Katalog, nur nach Berechtigungen gefiltert. Der native Zweig weiter
    // unten laesst dieselbe Menge durch `selectRelevantToolsAsync` laufen und
    // deckelt unter Small-Model-Mode auf SMALL_MODEL_MAX_TOOLS; dieser Zweig
    // tat beides nicht.
    //
    // Das war genau herum falsch. `hermes_xml` ist kein Weg, den man waehlt,
    // sondern der RUECKFALL fuer Modelle, deren Template kein natives
    // Werkzeug-Feld kann (agent-strategy.ts, applyLiveCapabilities). Die
    // schwaechsten Modelle bekamen also die LAENGSTE Liste — und weil Hermes
    // die Schemata nicht als `tools`-Feld auf die Leitung legen kann, sondern
    // als Text in den Systemprompt schreibt, bezahlt jeder Zug sie voll.
    //
    // Gemessen am 02.09.2026: 17 Werkzeuge = 19.459 Zeichen ≈ 4.866 Token.
    // smollm2:135m/360m melden Ollama kein `tools`, landen also hier, haben
    // 8k Fenster und damit unter Small-Model-Mode ein Sendefenster von 4.096
    // Token. Die Werkzeugliste ALLEIN war 119 % davon — die Anfrage konnte
    // gar nicht passen, bevor eine Frage darin stand.
    //
    // Nur im hermes_xml-Fall berechnet: sonst zahlte jeder native Zug eine
    // Einbettungsabfrage fuer eine Liste, die er nie benutzt.
    // Planning is opt-in (lib/plan-gate.ts). Decided once per run: the tool
    // list of a run must not change mid-way, and a plan the model cannot open
    // cannot become an open plan inside this run either.
    const planAllowed = planToolAllowed({
      mode: null,
      userText: userContent,
      todos: convId ? useTodoStore.getState().getTodos(convId) : [],
    })
    // Round 9, N15: a phone with a small window gets the short tool list
    // (lib/phone-context-fit.ts). 0 everywhere else, and then nothing changes.
    const phoneToolCtx: number = singleModelSlot()
      ? await resolveAgentNumCtx(modelId, providerId, settings.contextWindowOverride, activeModel).catch(() => 0)
      : 0
    // REA's tools follow the conversation, not only this message: a
    // follow-up after a stopped run lost them all (A37).
    const reaText = reaRoutingText(userContent, (useChatStore.getState().conversations
      .find((c) => c.id === convId)?.messages ?? [])
      .filter((m) => m.role === 'user').map((m) => m.content))
    const hermesToolDefs = strategy === 'hermes_xml'
      ? withCreateTools(gatePlanTool(await selectRelevantToolsAsync(
          toolRoutingText(userContent, attachedFiles),
          toolRegistry.getAll().filter((t) => toolMatchesCurated(t.name)),
          permissions,
          {
            ...withPhoneToolCap(
              toolSelectionOpts(!!settings.smallModelMode, (texts) => generateEmbeddings(texts, undefined, { purpose: 'tool-selection' })),
              phoneToolCtx, SMALL_MODEL_MAX_TOOLS,
            ),
            reaText,
          },
        ), planAllowed), toolRegistry.getAll())
      : []
    // Small-Model Mode (Knob 2): swap the ~3000-char agent prompt for a lean
    // ~750-char one on the native path. Der Hermes-Zweig behaelt seine eigene
    // Anweisung — nicht weil sie kuerzer waere (sie ist es nicht: 1.112
    // Zeichen wie ausgeliefert gegen ~750), sondern weil sie der PROTOKOLL-
    // VERTRAG ist. In ihr steht, dass ein Aufruf als <tool_call>-Block kommt,
    // und genau danach sucht parseHermesToolCalls. Tauscht man sie gegen die
    // schlanke, ruft das Modell weiter Werkzeuge — nur erkennt sie niemand.
    //
    // Was diesen Zweig frueher gesprengt hat, war ohnehin nie die Huelle,
    // sondern die LISTE darin: 18.347 der 19.459 Zeichen, also 94 %. Die zieht
    // jetzt oben durch dieselbe Vorauswahl wie der native Zweig.
    // Chat-Tools mode uses a conversational prompt (NOT the autonomous-agent
    // one) so plain chat keeps its normal voice and only reaches for a tool
    // when the user actually needs it.
    // The roster the prompt shows comes from the same filtered registry the
    // request draws on, so the prompt can never advertise a tool a permission
    // blocked or omit one that was added since (audit 2026-08-05).
    const offeredTools = gatePlanTool(
      toolRegistry.getAvailableTools(permissions).filter((t) => toolMatchesCurated(t.name)),
      planAllowed,
    )
    let agentSystemPrompt = strategy === 'hermes_xml'
      ? buildHermesToolPrompt(hermesToolDefs) + (systemPrompt ? `\n\n${systemPrompt}` : '')
      : opts?.chatToolsMode
        // A turn that carries only the Create tools gets the plain assistant
        // line (their paragraph is appended below); one that carries Create
        // next to web and file does not name the two local media tools.
        ? buildChatToolsSystemPrompt(systemPrompt, opts.createTools
            ? { media: false, tools: !curated || curated.some((n) => !isCreateToolName(n) && !isSettingsToolName(n)) }
            : curated && curated.every(isSettingsToolName) ? { tools: false } : {})
        : settings.smallModelMode
          // Lean names only what survives the 6-tool cap, which is exactly the
          // always-included set; the rest is in the request's tool list.
          ? buildAgentSystemPromptLean(
              systemPrompt,
              renderToolNames(offeredTools.filter((t) => ALWAYS_INCLUDE.includes(t.name))),
            )
          : buildAgentSystemPrompt(systemPrompt, renderToolRoster(offeredTools))
    // Computer control: the rules for the screen travel with the tool. The
    // section is only there when the user switched the tool on.
    agentSystemPrompt = withComputerUsePrompt(agentSystemPrompt, offeredTools.map((t) => t.name))
    if (opts?.settingsTools) agentSystemPrompt += `\n\n${SETTINGS_PROMPT_LINE}`
    // Create in chat: on = the paragraph; outside Cloud mode and without the
    // account's release not a word. Off = not a word, unless the customer
    // plainly asks for a medium in this message: then the note that points at
    // the switch, for this turn only. Same text as the plain chat
    // (hooks/useChat.ts). Read is what the customer typed, not the expansion
    // of a slash command.
    agentSystemPrompt = withCreateText(agentSystemPrompt, createSystemText(settings, activeModel, createLive, opts?.displayContent ?? userContent))
    // Standing goal (/goal) — same section Code injects, so the objective
    // survives a switch between the two surfaces.
    agentSystemPrompt += renderGoalSection(useAgentGoalStore.getState().getGoal(convId))

    // Multi-Repo (Sprint C #8): when the agent workspace has extra paths,
    // append a "Workspaces" section so the model can reference them by
    // absolute path. Tool resolution still anchors relatives at the
    // primary path via chatCtx → activeWorkspace.
    {
      const ws = useAgentModeStore.getState().workspaces[convId]
      if (ws?.kind === 'folder' && (ws.extraPaths?.length ?? 0) > 0) {
        agentSystemPrompt += renderWorkspaceSection(ws)
      }
    }

    // Caveman mode: append as response style modifier AFTER agent instructions
    // This ensures the model understands its agent role first, then applies terse
    // style. Wrapped so a failed dynamic import can't throw OUT of the setup
    // region (which runs before the main try/finally) and leave the
    // activeAgentRuns claim + isAgentRunning stuck true, that would wedge
    // the chat (bug A class).
    let cavemanReminder = ''
    try {
      if (settings.cavemanMode && settings.cavemanMode !== 'off') {
        const { CAVEMAN_PROMPTS, CAVEMAN_REMINDERS } = await import('../lib/constants')
        const cavemanPrompt = CAVEMAN_PROMPTS[settings.cavemanMode]
        if (cavemanPrompt) {
          agentSystemPrompt += `\n\nResponse style: ${cavemanPrompt}`
        }
        // Per-message Caveman reminder for non-thinking models
        cavemanReminder = CAVEMAN_REMINDERS?.[settings.cavemanMode as 'lite' | 'full' | 'ultra'] || ''
      }
    } catch (e) {
      log.warn('agent.caveman_load_failed', { e: String(e) })
    }

    // Nothing volatile in here any more (A7, lib/turn-context.ts): the
    // retrieval chunks, the memories and the clock change with every message,
    // and the system prompt sits in front of the whole conversation. At its
    // end they still cost the cache every message of the chat. They ride
    // behind the newest user message instead, see turnContext below.
    //
    // Not on a phone, as in the plain chat (hooks/useChat.ts): there they stay
    // at the end of the system prompt, where the phone was built and checked;
    // the note behind the question was measured on the desktop only. Inside a
    // run the system prompt does not change, so the steps still reuse the cache.
    const phoneSystemNote = isMobile()
    const contextNote = buildTurnContext({ memory: memoryContext, rag: ragSuffix, clock: hostClockLine() })
    if (phoneSystemNote && contextNote) agentSystemPrompt += `\n\n${contextNote}`
    const turnContext = phoneSystemNote ? '' : contextNote

    // 2.6.8 auto-compact, once per user turn — deliberately outside the
    // iteration loop below. Inside it, every step would re-ask and a long run
    // would summarise itself again and again; the cooldown in
    // shouldAutoCompact would catch it, but relying on a guard to undo a
    // wrong call site is not the same as calling it in the right place.
    // Inside the loop, the run's own working payload has its own check with
    // its own cooldown (compactRunMidway, before trimWorkingHistory).
    // Not for a run that was stopped while it waited for the slot: a summary
    // is a request of its own and would wait for the document again.
    if (!abort.signal.aborted && autoCompactOn(useSettingsStore.getState().settings)) {
      await maybeAutoCompact({ conversationId: convId, activeModel })
    }
    const convForPayload =
      useChatStore.getState().conversations.find((c) => c.id === convId) ?? conv

    // Build messages array
    // Die Werkzeugkette dieses Laufs, mitgeschrieben waehrend sie entsteht.
    //
    // Persona-Befund 6 (03.09.2026): nach Runde 1 stand im naechsten Payload
    // nur noch der Text der Assistentenantwort — das Aufruf/Ergebnis-Paar mit
    // dem echten Seiteninhalt fehlte, und die Nachfrage holte die Seite ein
    // zweites Mal. `useCodex` legt diese Kette laengst als versteckte
    // Nachrichten ab; dieser Lauf tat es nicht, seine Aufrufe lebten nur in
    // den Anzeige-Bloecken. Was der Nutzer als Karte SIEHT, sah das Modell in
    // der naechsten Runde nicht mehr.
    //
    // Eigener Sammler statt eines Index in `agentMessages`: das Arbeitsfenster
    // wird waehrend des Laufs beschnitten und neu zugewiesen
    // (trimWorkingHistory), ein gemerkter Startindex waere danach falsch.
    const werkzeugKette: ChatMessage[] = []
    // Create on and a model without eyes: the image is the template for an
    // order, the model knows it from the note on the message.
    const seesImages = declaredVision(useModelStore.getState().models.find((m) => m.name === activeModel)) ?? isVisionCompatible(activeModel)
    // The same for a model without eyes whose chat can hand a picture to the
    // image tool: the note names it, the bytes would only be refused, on this
    // turn and on every later one that carries the history.
    const imagesToModel = sendImagesToModel(!!opts?.createTools || imageToolTakesAttachments, seesImages)
    let agentMessages: ChatMessage[] = [
      ...(agentSystemPrompt ? [{ role: 'system' as const, content: agentSystemPrompt }] : []),
      // 2.6.8: a recorded compaction stands in for everything up to its
      // anchor. On the stored messages, before the wire map — the record's
      // anchor is a message id, and the wire shape has none. See
      // lib/run-compact-command.ts.
      ...applyStoredCompaction(
        // `|| m.hidden`: eine Assistentennachricht, die NUR tool_calls traegt,
        // hat leeren Text. Ohne diese Ausnahme fiele sie hier heraus und das
        // Ergebnis stuende ohne seinen Aufruf da — genau der 422-Fall, den der
        // Waisenschnitt beim Ablegen schon vermeidet. useCodex filtert seit je so.
        // Phone: a round that was stopped before any answer is not sent along as an open question (lib/unanswered-turns.ts).
        (isMobile() ? withoutUnansweredTurns(convForPayload.messages) : convForPayload.messages).filter((m) => m.role !== 'system' && (m.content.trim() !== '' || m.hidden)),
        convForPayload.compactions,
      ).messages
        .map((m) => ({
          role: m.role as 'user' | 'assistant' | 'tool',
          content: m.role === 'user' && cavemanReminder
            ? `${cavemanReminder}\n${m.content}`
            : m.content,
          ...(m.images?.length && imagesToModel ? { images: m.images.map(img => ({ data: img.data, mimeType: img.mimeType })) } : {}),
          // Bug B3 round 2: the store persists tool_calls and tool_call_id
          // (types/chat.ts says so, and says why), and this rebuild threw both
          // away. From the second user message of a chat on, the model got a
          // tool RESULT with no call in front of it and no id to tie it to
          // one. A mutilated history on a tolerant template, and on the id
          // strict cloud shape a 422 on every follow-up turn. Carried through
          // now; where the template cannot render them, the contract in
          // api/providers/normalize-system.ts turns both into prompt text.
          ...(m.tool_calls?.length ? { tool_calls: m.tool_calls as unknown as ChatMessage['tool_calls'] } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
    ]
    // Clock, memories and retrieval behind the user's message (A7). Pushed
    // once, before the loop: every step of this run sends it at the same
    // place, so the steps after the first reuse the cache.
    agentMessages = withTurnContext(agentMessages, turnContext)

    // G22: once the model proved it cannot read images (multimodal error on a
    // loop-attached picture), no further vision feedback this run.
    let visionRefused = false

    // Setup. `abort`/`runState` were already created and claimed at the
    // re-entry guard above (B2), reused here, not recreated, so Stop is
    // wired to the SAME controller from the moment the guard let this call
    // through.
    // Hand Stop to everything this run starts, including the nested ReAct loop
    // a delegate_task sub-agent runs (audit AGT-1). Assigned here rather than
    // in beginAgentRun because the controller does not exist that early.
    run.abortSignal = abort.signal
    // The proof `run-slot.ts`s `runsInHeldLane` checks (Opus-Review Runde 4,
    // bau/review-w2lane.md): a nested run_workflow or a foreground
    // delegate_task threads this straight back into runInLane instead of
    // guessing it holds the lane.
    run.heldLocalLane = heldLocalLane
    // Bind the generating flag to THIS conversation so the typing indicator
    // shows only in the chat whose turn is in flight (2026-06-12).
    // A Stop that landed before this point already released the slot, so the
    // finally below will not clear what is set here: marking the run as
    // generating now left "Working" counting with nothing behind it until a
    // second Stop (Gegenprobe 01.10.2026). The loop below sees the aborted
    // signal and ends without a request.
    const stoppedBeforeStart = abort.signal.aborted
    if (!stoppedBeforeStart) useGenerationStore.getState().setGenerating(convId, true)
    // A run that threw mid-call left its label behind; this run starts clean.
    useRunActivityStore.getState().setActivity(convId, null)
    // Register so deleting/closing this chat stops the agent loop (Bug C).
    // requestGenerationCancel too, so a ComfyUI gen the agent kicked off is
    // interrupted when the chat is deleted mid-generation (gated to a no-op when
    // nothing is in flight). Scoped to THIS conversation (Blocker 4,
    // review-lanes.md): passed bare this used to cancel whichever generation
    // happened to be running app-wide, so Stop in conversation B could kill an
    // image/video conversation A's agent was still producing.
    if (!stoppedBeforeStart) useGenerationStore.getState().registerAborter(convId, () => { abort.abort(); requestGenerationCancel(convId) })
    // A refusal no retry can fix has to end the loop as well. `return` in the
    // catch does not skip the finally, so without this the driver fires the
    // next pass into the same refusal and the credits dialog reopens every
    // interval until the user finds Stop.
    let loopHalt: string | null = null
    runState.content = ''
    runState.thinking = ''
    runState.blocks = []

    // Closed at the final write and in the catch, so a late frame never lands
    // on the closing line or the error (lib/frame-flush).
    const frames = frameFlush()

    function scheduleUIUpdate() {
      frames.schedule(() => {
        const cId = convId!
        const mId = assistantMessage.id
        useChatStore.getState().updateMessageContent(cId, mId, runState.content)
        if (runState.thinking) {
          useChatStore.getState().updateMessageThinking(cId, mId, runState.thinking)
        }
      })
    }

    // Phase 6: lock in the start-of-turn timestamp so the in-turn cache
    // only serves results from calls made during THIS user prompt.
    const turnStartMs = Date.now()
    // Phase 10: hard caps on tool calls and loop iterations. Halts cleanly
    // with a synthetic assistant message when the budget is exhausted —
    // no wedged agent, no runaway token burn.
    const budget = budgetFromSettings({
      agentMaxToolCalls: settings.agentMaxToolCalls ?? 50,
      agentMaxIterations: settings.agentMaxIterations ?? 25,
    })

    // ── Over-loop guard (2026-06-04) ──────────────────────────────
    // LIVE: "mach mir ein bild von einer katze" made the SAME image 13× then
    // invented new prompts and ran 4min+. Root cause: the loop only ends at 0
    // tool calls, so a chatty model keeps emitting image_generate/video_generate.
    // Fix: generate ONLY what the user asked for, exactly once each, then stop —
    // plus a duplicate-call breaker so any tool repeated with identical args is
    // skipped. Caps derive from the user's actual request.
    // The note of the turn (A7) rides as a user message of its own behind the
    // user's; the user's own words are the message before it.
    const userPromptText =
      [...agentMessages].reverse().find((m) => m.role === 'user' && !(turnContext && m.content === turnContext))?.content || ''
    // G27b, parity with useCodex: a new turn on a conversation whose plan is
    // still open carries the plan instead of hoping the model digs it back out
    // of the history. The stored chain is capped, so the last todo_write may
    // already be outside it.
    // The plan state comes from the todoStore, which is what the PlanBar shows.
    // Pushed LAST, behind the user's own message: volatile tail, stable head
    // (plan A5). Deliberately after userPromptText above, so the media-intent
    // regexes keep reading the user's words instead of this line.
    // Phone only (lib/phone-context-fit.ts): what the user asked, read before
    // the loop appends anything of its own with the role `user`. Unused on a
    // desktop, where the fit below returns its input.
    const runQuestion = questionOf(agentMessages)
    // Phone only: the first request of this run with the size the engine
    // counted for it. What a later request starts with is then known, not
    // estimated (lib/phone-context-fit.ts, measuredRequest). Stays null on a
    // desktop and for a cloud model.
    let phoneMeasured: PhoneMeasure | null = null
    let phoneMeasureTaken = false
    {
      const resume = planResumeAnchor(useTodoStore.getState().getTodos(convId))
      if (resume) {
        log.info('agent.plan_resume_anchor', { done: resume.gap.done, total: resume.gap.total })
        agentMessages.push({ role: 'user', content: resume.text })
      }
    }
    // ── „nutze 5 glm 5.2 agenten" ────────────────────────────────────────
    //
    // Ausdrueckliche Anweisung des Nutzers, deterministisch aus dem Text
    // gelesen statt dem Modell ueberlassen. Der Grund steht in
    // lib/agent-fanout.ts und ist gemessen: ein 4B-Modell antwortete auf
    // „call delegate_task with background true" mit PROSA („Task ID: t12345")
    // und rief nie ein Werkzeug. Eine genannte Zahl darf daran nicht
    // scheitern.
    //
    // Als NUTZER-Material, wie jede andere Notiz in diesem Verlauf: eine
    // System-Nachricht an anderer Stelle als Index 0 weisen strenge
    // Jinja-Vorlagen ab, eine Werkzeugantwort braeuchte eine echte
    // tool_call_id.
    {
      const wunsch = parseFanoutRequest(userContent)
      if (wunsch) {
        const modelle = useModelStore.getState().models
        const treffer = wunsch.modelPhrase
          ? resolveRequestedModel(wunsch.modelPhrase, modelle)
          : null
        const note = wunsch.modelPhrase && !treffer
          ? unresolvedModelNote(wunsch.modelPhrase, modelle.map((m) => m.name))
          : undefined
        // Die Schranke folgt der Ansage. SUB_AGENT_MAX_PARALLEL (4) bremst
        // eine Fan-out-Schleife des MODELLS; sagt der NUTZER „nutze 5", ist
        // sie keine Sicherheitsgrenze mehr, sondern Bevormundung.
        setExplicitFanout(convId, wunsch.count)
        agentMessages.push({
          role: 'user',
          content: fanoutDirective(wunsch, treffer ? treffer.name : null, note),
        })
      }
    }

    // Seed the media intent from the router's continuation hint too (the owner
    // 2026-06-20): "ok generiere jetzt" carries no noun, so detecting wants from
    // the last message alone left wantsVideo=false and the synth fallback never
    // fired on a "regenerate the clip" follow-up. The hint says it's a video task.
    const hintKind = opts?.mediaHint?.kind
    // With the Create tools in the turn, create_order makes the media, and an
    // order is never rebuilt from prose: it needs the customer's approval.
    const wantsImage = !opts?.createTools && (hintKind === 'image' || /\b(bild|bilder|foto|image|picture|pic|draw|zeichne|mal(e|en)?|grafik|illustration|render)\b/i.test(userPromptText))
    const wantsVideo = !opts?.createTools && (hintKind === 'video' || /\b(video|clip|animier\w*|animate|film|gif|bewegt|motion|mp4|webm)\b/i.test(userPromptText))
    const maxImageGen = wantsVideo && !wantsImage ? 0 : 1
    // Video generation is turned OFF in the chat tools (video defaults to
    // 'blocked' + locked toggle, 2026-06-04). Respect that here so the
    // deterministic media-synthesis fallback below never force-creates a video
    // the user disabled.
    const videoAllowed = permissions.video !== 'blocked'
    const maxVideoGen = wantsVideo && videoAllowed ? 1 : 0
    let imageGenDone = 0
    let videoGenDone = 0
    // Track whether the generated media was actually fed back to the model
    // (vision feedback). When it wasn't — video is never fed back, and a
    // text-only model can't see an image — we suppress the generic "your media
    // is above" closing line so the finished tool call + inline media stands on
    // its own with no hollow comment behind it (2026-06-16).
    let visionFeedbackGiven = false
    let mediaSteered = false
    // Create in chat: one order per reply, none after a refusal of the content
    // check, and no claim that something is being made without an order.
    const createCalls = newCreateCallState()
    let createClaimSteered = false
    let createOrderClaimSteered = false
    let mediaSynthesized = false
    // One search made by the loop for an explicit order (lib/explicit-search.ts).
    let searchSynthesized = false
    // Phone: while such an order is open, what the model writes is not put on the screen as it arrives. Either
    // the model calls the search itself, or the loop does and drops that text (below). Shown while it streamed,
    // it flashed up as an answer and vanished when the search began (small iPhone, K8: 2 of 3 runs).
    const searchOrdered = isMobile() && opts?.readOnly !== true && explicitSearchQuery(userContent) !== null && offeredTools.some((t) => t.name === 'web_search')
    // Phone only: the answer the link steer was about, the note it was put in, and how many calls had run by then.
    // A small model replies to the steer instead of following it; then this answer stays the answer (below).
    let steeredAnswer: { text: string; blockId: string; calls: number; links: string[] } | null = null
    // And while the round after the link steer writes (below): whether that text is an answer or a reply to
    // the steer is known only when it is whole, and an apology that flashes up and goes is still read.
    const holdLiveText = () => (searchOrdered && !searchSynthesized && executedCallKeys.size === 0) || (steeredAnswer !== null && executedCallKeys.size === steeredAnswer.calls)
    // The first search of an ordered run was given the words of the user (lib/explicit-search.ts, withOrderedQuery).
    let searchQueryPinned = false
    let forceNoThink = false
    let dudRetried = false
    // Z36 finding 3: one corrective steer for a final answer citing links no
    // tool returned. A second offence keeps the model's text (G14-2) and
    // flags the message instead, never a retry loop.
    let linksSteered = false
    // Arms the fabrication guard, exactly the Z36 trigger: it fired only once
    // a REAL success sat in the history. Counts completed and cached calls
    // after the D#81 media reclassification, so a failed render never arms it.
    let anyToolSucceeded = false
    // G16, parity with useCodex: a final turn that leaves the model's own todo
    // list unfinished gets a bounded contradiction instead of ending the run.
    let planReconcilesRemaining = PLAN_RECONCILE_BUDGET
    // G17: budget for continuing past reasoning-only rounds mid-run.
    let reasoningContinuesRemaining = REASONING_CONTINUE_BUDGET
    const executedCallKeys = new Set<string>()
    /** Size of the tool catalogue the step before sent. Zero before the first step. */
    let catalogTokens = 0
    const callKey = (tc: { function: { name: string; arguments: unknown } }) =>
      tc.function.name + '|' + JSON.stringify(tc.function.arguments ?? {})
    // Loop-detection (audit follow-up): agent-loop-guard's own header says it
    // covers "Codex + Chat agent", but only Codex ever wired it — the agent
    // loop relied on the exact-repeat set alone, which the epoch reset (B1)
    // rightly weakened. Windowed batch repeats, per-epoch identical reads and
    // repeated narration now watch this loop too.
    const loopGuard = new AgentLoopGuard()
    // The closing line a turn gets when the model itself said nothing usable.
    // Read from the live counters at call time, so both the normal end of the
    // run and the swallowed multimodal refusal below produce the same text.
    const closingSummary = () =>
      summarizeTurn({
        calls: runState.blocks
          .filter((b) => b.phase === 'tool_call' && b.toolCall)
          .map((b) => ({
            toolName: b.toolCall!.toolName,
            status: b.toolCall!.status,
            result: b.toolCall!.result,
            // Fuer die Datei-Zaehlung: zwei Schreibvorgaenge auf denselben
            // Pfad sind eine Datei, nicht zwei (Persona-Befund 10).
            args: b.toolCall!.args as Record<string, unknown> | undefined,
          })),
        imageGenDone,
        videoGenDone,
        visionFeedbackGiven,
        planGap: openPlanGap(useTodoStore.getState().getTodos(convId!)),
      })
    // Which read produced which result message, so the request builder can
    // tell the guard that a re-read of a CAPPED result is legitimate rather
    // than a loop (plan A1, LOOP-GUARD). Keyed by the message object, which
    // works across all three transports.
    const guardKeyOfResult = new WeakMap<object, string>()
    const guardKeyFor = (tc: { function: { name: string; arguments?: unknown } }): string =>
      `${tc.function.name}|${JSON.stringify(tc.function.arguments ?? {})}`
    const NO_TRIMMED_KEYS: ReadonlySet<string> = new Set<string>()

    // Step number for the decay audit trail. The loop is a while, so it has
    // no index of its own.
    let stepNo = 0
    // Auto-compact in the middle of this run (3.0.7): one state for the whole
    // run, so it cools down between summaries and gives up after failures.
    const laufVerdichtung = newRunCompactState()
    try {
      // Background jobs this turn hands over wait with their result until the
      // turn has stopped writing this message (stores/backgroundJobStore.ts).
      runMessageStarted(assistantMessage.id)
      // ── Agent Loop ──────────────────────────────────────────
      // A separate running flag used to be checked here too; it was only
      // ever flipped false by the same three places that call
      // `abort.abort()` (the aborter callback, the finally below,
      // stopAgent), so the signal alone
      // is the whole condition.
      while (!abort.signal.aborted) {
        stepNo++
        // Fertige Hintergrundagenten melden sich hier, oben in der Iteration:
        // vor dem Modellaufruf und nach den Werkzeugantworten der vorigen
        // Runde. Als NUTZER-Material — die Begruendung steht in
        // lib/agent-task-report.ts und ist dieselbe Regel, an der schon die
        // Verdichtungsnotiz haengt.
        appendTaskReport(
          agentMessages,
          () => useAgentTaskStore.getState().takeUnreported(convId),
          Date.now(),
        )
        // One card, and a render from the chat has the chat model off it
        // (3.0.8, A2): wait for it here, visibly, instead of inside the
        // provider without a word.
        await waitForChatCard(convId, isLocalModelByName(activeModel), abort.signal)
        if (abort.signal.aborted) break
        budget.addIteration()
        const exceed = budget.exceeded()
        if (exceed.kind !== 'none') {
          runState.content =
            (runState.content ? runState.content + '\n\n' : '') + budget.haltMessage()
          scheduleUIUpdate()
          break
        }
        let toolCalls: ToolCall[] = []
        let turnContent = ''
        let turnThinking = ''
        // Warum DIESER Zug endete. Nur `length` wird ausgewertet, und nur ganz
        // unten in der Weiche ohne Werkzeugaufruf: ein abgeschnittener Zug sah
        // dort genauso aus wie ein fertiges Modell (Fehler D, Symptom 2, im
        // Code Reiter am 11.09.2026 geschlossen, hier stand es noch offen).
        let turnFinishReason: string | undefined

        // Plain-text-planner escape: Gemma 3/4 with think=false drops
        // into structured plain-text planning (Plan: / Constraint
        // Checklist: / Confidence Score:) with no tags to strip. Pass
        // `undefined` instead so Ollama keeps the model in tagged-
        // thinking mode; the stripper removes the tags silently.
        // Server-declared think capability wins over the name-heuristic
        // (same precedence as useChat): 'always'/'never' cloud models get
        // no reasoning_effort knob at all; 'toggle' follows the switch.
        const agentMeta = useModelStore.getState().models.find((m) => m.name === activeModel)
        const agentThinkMode = agentMeta && 'thinkMode' in agentMeta ? agentMeta.thinkMode : undefined
        const canThinkAgent = agentThinkMode ? agentThinkMode === 'toggle' : isThinkingCompatible(activeModel)
        // Same ladder as the composer shows and as useChat sends. An agent run
        // that quietly kept the old fixed 'high' would make the control a lie
        // on the surface where the token bill is largest.
        const agentEffortLevels = agentMeta && 'effortLevels' in agentMeta ? agentMeta.effortLevels : undefined
        const agentEffortDefault = agentMeta && 'effortDefault' in agentMeta ? agentMeta.effortDefault : undefined
        const plainPlanAgent = isPlainTextPlanner(activeModel)
        // forceNoThink: set by the dud-turn recovery below — a thinking model
        // (gemma4) dumped its whole answer into the thinking channel and emitted
        // nothing usable, so we retry this turn with thinking OFF.
        const thinkOpt: boolean | undefined = forceNoThink
          ? (canThinkAgent ? false : undefined)
          : canThinkAgent
            ? (settings.thinkingEnabled === false && plainPlanAgent
                ? undefined
                : settings.thinkingEnabled === true)
            : undefined
        // Hoisted above the transport branches (G35): the hermes stream
        // splitter needs the same gate the end-of-turn routing uses.
        const keepThinking = agentThinkMode === 'always' || (settings.thinkingEnabled === true && canThinkAgent)

        // The window of this run, as a number for the budgets below. What an
        // Ollama model is SENT is the same number, resolved where the request
        // is built from `window: 'agent'` (api/ollama.ts).
        const agentCtx: number = await resolveAgentNumCtx(
          modelId, providerId, settings.contextWindowOverride, activeModel,
        )
        // R5-10/R5-11: this chat's own sampling, falling back to the Settings
        // page for whatever field it never touched. buildSamplingRequest
        // omits a field left at the app default; Small-Model Mode below
        // overrides temperature regardless, so it is not subject to that
        // omission (it never was: the owner's clamp is a correctness measure,
        // not a preference the user can leave untouched).
        const samplingConv = store.conversations.find((c) => c.id === convId)
        const convSampling = samplingConv?.sampling
        // GH #175: the chat persona's preset sits under this chat's own values,
        // while the persona is on for the chat, as its prompt is.
        const { personas: allPersonas, activePersonaId: pickedPersonaId } = useSettingsStore.getState()
        const speaker = samplingConv
          ? samplingPresetFor(samplingConv, activeModel, allPersonas, pickedPersonaId, settings.personasEnabled !== false)
          : undefined
        const personaPreset = speaker?.preset
        // GH #198: the custom rows go along here too, the chat's over the persona's.
        const customParams = samplingConv ? speakerCustomParams(samplingConv, speaker?.persona) : {}
        const sampling = {
          topK: settings.topK,
          ...buildSamplingRequest(settings, convSampling, personaPreset),
          ...(Object.keys(customParams).length > 0 ? { customParams } : {}),
        }
        // Small-Model Mode (Knob 6): gently clamp temperature for tool turns.
        // FOLKLORE, not measured — research found NO temperature finding for
        // tool-calling. A low, low-entropy setting is *plausible* for valid
        // tool-call JSON, so we cap downward (never raise) rather than force.
        // Without it the Agent still holds its own ceiling (A33): a chat set
        // to a creative temperature must not break the tool calls.
        const agentTemp = agentTemperature(
          effectiveSampling(settings, convSampling, personaPreset).temperature,
          sampling.temperature,
          settings.smallModelMode === true,
        )
        if (agentTemp === undefined) delete sampling.temperature
        else sampling.temperature = agentTemp
        const chatOptions = {
          ...sampling,
          window: 'agent' as const,
          thinking: thinkOpt as unknown as boolean,
          reasoningEffort: settings.reasoningEffort,
          localEffortChosen: settings.localEffortChosen,
          // Think budget (D12): only the backends that take a count read it.
          thinkingBudget: settings.thinkingBudget,
          effortLevels: agentEffortLevels,
          effortDefault: agentEffortDefault,
          signal: abort.signal,
        }

        // Context compaction — keep the trim target in sync with the 8192 num_ctx
        // above so a generated image fed back for vision isn't trimmed right out.
        // Keep the compaction budget == the actual num_ctx we send, so we never
        // trim to the model's full context (e.g. 128k) while Ollama only has the
        // capped num_ctx allocated — that mismatch caused prompt overflow.
        // ── Request build (2.6.6, plan A1/A2/A3) ─────────────────────
        // Age decay, then the send budget, then compaction, in that order:
        // reversed, the budget counts full results and drops whole messages
        // to make room the decay would have freed anyway.
        //
        // agentMessages itself is never decayed. The store, the transcript
        // and the next turn keep the complete result; only the copy on the
        // wire is shortened, which is what makes it reversible from one
        // settings switch. Small-Model Mode (Knob 4) and the paid-provider
        // send cap both live in effectiveSendWindow.
        const decayOn = settings.contextDecay !== false
        const sendWindow = effectiveSendWindow({
          providerId,
          modelWindow: agentCtx,
          sendWindowTokens: sendWindowFor(settings, activeModel),
          capEnabled: decayOn,
          smallModelMode: settings.smallModelMode,
          localBackend: sendsToALanBackend(providerId, activeModel),
        })
        // The tool catalogue rides on the wire next to the messages and is
        // not in their estimate. On a local 32K window that was the overflow
        // (box, 09.10.2026: "request (33005 tokens) exceeds the available
        // context size (32768 tokens)"): the messages alone were allowed 80 %
        // of the window, and the catalogue came on top. So the catalogue of
        // the step before comes off the budget of the messages.
        // GH #181: the chat persona's reminder, as in plain chat: while the
        // persona is on for the chat, near the end of what this step sends.
        // Its cost comes off the history's budget like the catalogue's, and
        // it goes on the send copy only, never into agentMessages.
        const personaNote = samplingConv
          ? personaNoteOf(speakerPersonaFor(samplingConv, activeModel, allPersonas, pickedPersonaId, settings.personasEnabled !== false))
          : null
        const besideCatalog = budgetBesideTheCatalog(sendWindow, catalogTokens)
        const sendBudget = personaNote ? Math.max(1, besideCatalog - noteTokens(personaNote)) : besideCatalog
        let sendMessages: ChatMessage[] = agentMessages.slice()
        let trimmedReadKeys: ReadonlySet<string> = NO_TRIMMED_KEYS
        try {
          // Bound the carried history FIRST, in whole blocks and measured on
          // the decayed sizes. Trimming to the exact budget inside the builder
          // would move the window start every single step, and a window that
          // moves every step is a prompt prefix that is never the same twice.
          // Whole messages are dropped here, never shortened: decay stays on
          // the send copy alone, so the store keeps every result complete.
          // Before the trim: when the run nears the window, its older steps
          // are summarised by the run's own model instead of only dropped.
          // Copies only, so the chain saved at the end (werkzeugKette) keeps
          // every result complete. The trim below stays the safety net.
          const verdichtet = await compactRunMidway({
            messages: agentMessages,
            budgetTokens: sendBudget,
            modelWindow: agentCtx,
            activeModel,
            convId,
            beforeMessageId: assistantMessage.id,
            signal: abort.signal,
            state: laufVerdichtung,
            decay: { enabled: decayOn },
          })
          if (verdichtet.compacted) agentMessages = verdichtet.messages
          agentMessages = trimWorkingHistory(agentMessages, sendBudget, { enabled: decayOn, hysteresis: decayOn }).messages
          const built = buildRequestMessages(agentMessages, {
            budgetTokens: sendBudget,
            enabled: decayOn,
            hysteresis: decayOn,
            keyOf: (m) => guardKeyOfResult.get(m as unknown as object),
          })
          sendMessages = built.messages
          trimmedReadKeys = new Set(built.trimmedKeys)
          if (convId) {
            useSendSizeStore.getState().report(convId, {
              tokens: built.promptTokens,
              window: sendWindow,
              atMessageCount:
                useChatStore.getState().conversations.find((c) => c.id === convId)?.messages.length ?? 0,
              trimmedResults: built.trimmedCount,
              savedChars: built.savedChars,
            })
            if (built.trimmedCount > 0 || built.prunedPlans > 0 || built.droppedImages > 0) {
              const auditId = useToolAuditStore.getState().record({
                convId,
                toolCallId: `decay-${stepNo}`,
                toolName: 'context_decay',
                args: {
                  step: stepNo,
                  trimmedResults: built.trimmedCount,
                  savedChars: built.savedChars,
                  prunedPlanMessages: built.prunedPlans,
                  droppedImages: built.droppedImages,
                  savedImageChars: built.savedImageChars,
                  sendWindow,
                },
              })
              useToolAuditStore.getState().complete(auditId, {
                status: 'completed',
                completedAt: Date.now(),
                resultPreview:
                  `Shortened ${built.trimmedCount} aged tool result${built.trimmedCount === 1 ? '' : 's'} ` +
                  `and dropped ${built.prunedPlans} superseded plan message${built.prunedPlans === 1 ? '' : 's'}, ` +
                  (built.droppedImages > 0
                    ? `aged out ${built.droppedImages} old image${built.droppedImages === 1 ? '' : 's'} (${built.savedImageChars} chars kept off the wire), `
                    : '') +
                  `saving ${built.savedChars} characters. Request: ~${built.promptTokens} of ${sendWindow} tokens.`,
              })
            }
          }
        } catch {
          sendMessages = agentMessages.slice()
        }
        sendMessages = injectPersonaNote(sendMessages, personaNote)
        // Phone only (lib/phone-context-fit.ts): the window of the model on a
        // phone is 4096 tokens at most, smaller than the floors the builder
        // above keeps. Returns the same array on a desktop and for a cloud model.
        sendMessages = fitRequestForPhone(sendMessages, agentCtx, 0, runQuestion, phoneMeasured)
        // Phone only: the engine's own count of the first request of the run.
        const notePhoneCount = (promptTokens: number | undefined) => {
          if (phoneMeasureTaken || !promptTokens || !phoneFitApplies(agentCtx)) return
          phoneMeasureTaken = true
          phoneMeasured = measuredRequest(sendMessages, promptTokens)
        }

        // Honouring a long `retry-after` means the run goes quiet for up to a
        // minute, and a silent gap reads as a freeze (which is exactly the
        // complaint the credits work came from). Only a wait the SERVER asked
        // for gets a line; the 1.5 s connection-blip ladder is not worth one.
        const announceWait = (err: unknown, ms: number) => {
          const asked = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs
          if (typeof asked !== 'number' || ms < 3000) return
          addBlock(runState, convId!, assistantMessage.id, {
            id: uuid(),
            phase: 'reflection',
            content: `Rate limited by the server, which asked for ${Math.round(ms / 1000)} seconds. Waiting, then carrying on.`,
            timestamp: Date.now(),
          })
        }

        if (strategy === 'native') {
          // No placeholder block while the model works: an "Analyzing..."
          // thinking block showed as a "Thinking" chip, also for models that
          // do not think, next to the status line that already says Working
          // (Gegenprobe 01.10.2026). The status line is the one sign of life.

          // Intelligent tool selection — keyword for small lists, embedding
          // routing once the total tool count grows past the threshold
          // (Phase 9). The embedding call is best-effort: if Ollama is
          // unreachable it silently falls back to keyword-only.
          // Route on the USER's instruction, never on the newest user-role
          // message (audit B6): steers, over-loop notes and read-only blocks
          // are pushed as role 'user', and routing on those swapped the tool
          // list mid-run to whatever the harness said last.
          const lastUserMsg = toolRoutingText(userContent, attachedFiles)
          // Small-Model Mode (Knob 1): tighten the tool cap and force the
          // embedding router even on a modest catalog (threshold 6) so a 3B-8B
          // model sees ≤6 semantically-ranked tools. Default mode keeps the
          // permissive selection unchanged for big models.
          // Die Zahlen dahinter stehen in `toolSelectionOpts`, nicht hier.
          // Als sie hier standen, gab es sie nur an DIESER Stelle — der
          // hermes_xml-Zweig oben nahm stattdessen den ganzen Katalog, und
          // niemandem fiel es auf, weil nichts brach.
          const relevantDefs = withCreateTools(gatePlanTool(await selectRelevantToolsAsync(
            lastUserMsg,
            toolRegistry.getAll().filter((t) => toolMatchesCurated(t.name)),
            permissions,
            {
              ...withPhoneToolCap(
                toolSelectionOpts(!!settings.smallModelMode, (texts) => generateEmbeddings(texts, undefined, { purpose: 'tool-selection' })),
                phoneToolCtx, SMALL_MODEL_MAX_TOOLS,
              ),
              reaText,
            },
          ), planAllowed), toolRegistry.getAll())
          const tools: ToolDefinition[] = relevantDefs.map(t => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          }))
          // Same reason as the coding loop: the catalog rides as its own field
          // on the wire, so the message estimate the builder reported never saw
          // it and the meter read low by the whole catalog.
          if (convId) {
            useSendSizeStore.getState().reportTools(convId, estimateTokens(JSON.stringify(tools)))
          }
          catalogTokens = estimateTokens(JSON.stringify(tools))

          // Aus den beiden Transporten abgeleitet statt abgeschrieben. Die
          // abgeschriebene Fassung kannte `doneReason` nicht, und ein Feld, das
          // ein Transport liefert und diese Zeile verschweigt, ist genau die
          // Sorte Drift, die den abgeschnittenen Zug lange unsichtbar hielt.
          let turn!:
            | Awaited<ReturnType<typeof streamOllamaChatWithTools>>
            | Awaited<ReturnType<typeof streamProviderTurn>>

          // Token counter (2026-06-12): reflect the REAL prompt size — system
          // prompt + tool defs + history — immediately, not a char/4 guess of just
          // the visible messages. Provisional estimate the model's exact count
          // overwrites below; only set while no real count has landed yet.
          const estPrompt =
            estimateTokens(sendMessages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')) +
            estimateTokens(JSON.stringify(tools))
          {
            const existingUsage = useChatStore.getState().conversations
              .find((c) => c.id === convId)?.messages.find((m) => m.id === assistantMessage.id)?.usage
            if (!existingUsage || existingUsage.estimated) {
              useChatStore.getState().updateMessageUsage(convId!, assistantMessage.id, {
                promptTokens: estPrompt, completionTokens: 0, totalTokens: estPrompt, estimated: true,
              })
            }
          }
          // A7: the first wait of a turn is the model reading the request.
          // Said in words and with its size instead of a bare "Starting"; the
          // first word, shown thought or tool call takes the line back.
          if (stepNo === 1) useRunActivityStore.getState().setActivity(convId, readingActivity(estPrompt))
          // A7: one line in the log file per message, with where the first
          // wait went: the setup before the request, and the model reading
          // until its first word, thought or call. Measured instead of
          // guessed the next time a start feels slow.
          const requestAt = Date.now()
          let firstSignAt = 0
          const markFirstSign = () => { if (!firstSignAt) firstSignAt = Date.now() }
          const logFirstWait = () => {
            if (stepNo !== 1) return
            log.event('agent.first_wait', {
              provider: providerId,
              setupMs: requestAt - userMessage.timestamp,
              readMs: (firstSignAt || Date.now()) - requestAt,
              promptTokens: estPrompt,
              tools: tools.length,
            })
          }
          if (providerId === 'ollama') {
            // Streaming path — parity with desktop Codex. Without this
            // the user stared at a frozen chat for 30-90 s while Gemma
            // thought (no tokens, no 3-dot, just dead air). Now content
            // and thinking land in real time.
            // Connection-failure retry (2026-06-04): right after a VRAM
            // hand-off reloads the text model, the very next call can race the
            // still-warming model and die as "Agent error: Connection failed"
            // (seen on gemma4 after its image). Retry transient errors a couple
            // times before surfacing. The inner branch still handles the
            // does-not-support-thinking downgrade.
            // Der Zug dieses Zweiges, mit dem Typ SEINES Transports. Die
            // Schleife darunter wirft und faengt, und ein `turn` der beiden
            // Transporte zusammen waere danach wieder die weite Fassung, in der
            // `doneReason` nicht mehr sichtbar ist.
            let ollamaTurn!: Awaited<ReturnType<typeof streamOllamaChatWithTools>>
            let connRetries = 0
            for (;;) {
              try {
                ollamaTurn = await streamOllamaChatWithTools(
                  modelToUse,
                  sendMessages,
                  tools,
                  {
                    temperature: chatOptions.temperature,
                    thinking: chatOptions.thinking,
                    maxTokens: chatOptions.maxTokens,
                    window: chatOptions.window,
                    signal: abort.signal,
                  },
                  (c) => {
                    markFirstSign()
                    if (holdLiveText()) return
                    runState.content = c
                    scheduleUIUpdate()
                  },
                  (t) => {
                    markFirstSign()
                    // The one gate for the whole step. Reading the raw setting
                    // here disagreed with the end-of-turn routing for an
                    // 'always' reasoner: nothing streamed live, then the whole
                    // thought appeared at once when the turn ended.
                    if (keepThinking) {
                      runState.thinking = t
                      scheduleUIUpdate()
                    } else {
                      hiddenThoughtArrived(convId)
                    }
                  },
                )
                break
              } catch (thinkErr) {
                // G22: OUR image attachment on a model that cannot see. Strip
                // it to its text fallback and retry — the run must survive a
                // wrong vision guess. A user-attached image stays untouched.
                if (isMultimodalUnsupportedError(errorText(thinkErr)) && stripVisionFeedbackMessages(agentMessages)) {
                  // The send copy carries the same attachment; strip it there
                  // too or the retry resends exactly what just failed.
                  stripVisionFeedbackMessages(sendMessages)
                  visionRefused = true
                  log.warn('agent.vision_feedback_healed', { model: modelToUse })
                  continue
                }
                // The ONE place that answers "must thinking be downgraded?" —
                // codex/thinking-downgrade.ts. It carries both halves: the
                // error shape (400/422, or the model saying so) and the guard
                // that there is something to drop at all. Passing this
                // branch's OWN options keeps that guard real; a hardcoded
                // `true` would opt out of it through the back door and resend
                // a byte-identical request, charging the user twice (review
                // 2026-08-14).
                if (shouldDowngradeThinking(chatOptions.thinking, thinkErr)) {
                  // Die Absage der Engine ueberlebt diesen Zug: sonst kostet
                  // sie bei JEDER weiteren Nachricht wieder eine verlorene
                  // Anfrage (Testlauf 03.09.2026).
                  if (engineDeniedThinking(thinkErr)) markCannotThink(modelToUse)
                  ollamaTurn = await streamOllamaChatWithTools(
                    modelToUse,
                    sendMessages,
                    tools,
                    {
                      temperature: chatOptions.temperature,
                      thinking: undefined,
                      maxTokens: chatOptions.maxTokens,
                      window: chatOptions.window,
                      signal: abort.signal,
                    },
                    (c) => {
                      if (holdLiveText()) return
                      runState.content = c
                      scheduleUIUpdate()
                    },
                    () => {},
                  )
                  break
                }
                // Retry ONLY transient failures. A deterministic client error
                // (context overflow, empty wallet) repeats itself, so it has to
                // surface at once instead of costing the user two backoffs.
                const transient = asString(prop(thinkErr, 'name')) !== 'AbortError' && !isTerminalModelError(thinkErr) && !cutByModelSwitch(convId)
                if (transient && connRetries < 2) {
                  connRetries++
                  const wait = retryDelayMs(thinkErr, connRetries)
                  log.warn('agent.model_call_retry', { attempt: connRetries, waitMs: wait, err: errorText(thinkErr) })
                  announceWait(thinkErr, wait)
                  await waitBeforeRetry(convId, wait, abort.signal)
                  continue
                }
                throw thinkErr
              }
            }
            endFirstWait(convId)
            logFirstWait()
            turn = ollamaTurn
            // Ollama nennt den Grund `done_reason`; `lib/ollama-stream-tools.ts`
            // reicht ihn seit Fehler D durch.
            turnFinishReason = ollamaTurn.doneReason
          } else {
            // ── Streaming path for openai-compat / Anthropic / LU Cloud ──
            // Parity with the Ollama branch above: chatStream carries the
            // tool defs (ChatOptions.tools), tool-call deltas accumulate in
            // the provider and arrive on the done chunk. Until 2.6.0 this
            // branch waited on chatWithTools and painted the whole turn at
            // once (2026-07-31).
            //
            // Connection-failure retry kept from the non-streaming days: a
            // LOCAL LM Studio model gets unloaded + JIT-reloaded around an
            // image/video VRAM hand-off (detectLmsTextModel juggling,
            // v2.5.3); a request that races that reload window dies as
            // "LM Studio: Request failed". Retry transient failures a couple
            // of times; a 4xx is deterministic and still surfaces.
            const onLiveContent = (c: string) => {
              markFirstSign()
              if (holdLiveText()) return
              runState.content = c
              scheduleUIUpdate()
            }
            const onLiveThinking = (t: string) => {
              markFirstSign()
              // Same gate as the end-of-turn routing, see the Ollama branch.
              if (keepThinking) {
                runState.thinking = t
                scheduleUIUpdate()
              } else {
                hiddenThoughtArrived(convId)
              }
            }
            // A call still being written names itself on the run anchor
            // (stores/runActivityStore, realtime pass R1).
            const onToolProgress = (p: ToolCallProgress) => {
              markFirstSign()
              useRunActivityStore.getState().setActivity(convId, toolProgressActivity(p))
            }
            const streamOpts = { ...chatOptions, tools }
            // Dasselbe wie im Ollama-Zweig, aus demselben Grund.
            let providerTurn!: Awaited<ReturnType<typeof streamProviderTurn>>
            let connRetries = 0
            for (;;) {
              try {
                providerTurn = await streamProviderTurn(provider, modelToUse, sendMessages, streamOpts, onLiveContent, onLiveThinking, onToolProgress)
                break
              } catch (thinkErr) {
                // G22 parity with the Ollama branch: heal a wrong vision
                // guess instead of ending the run (R20 witness: LM Studio,
                // gemma-3-4b-it-abliterated, text-only conversion).
                if (isMultimodalUnsupportedError(errorText(thinkErr)) && stripVisionFeedbackMessages(agentMessages)) {
                  stripVisionFeedbackMessages(sendMessages)
                  visionRefused = true
                  log.warn('agent.vision_feedback_healed', { model: modelToUse, provider: providerId })
                  continue
                }
                // Same one place as the Ollama branch above. This is also the
                // transport where the 422 lives: `streamProviderTurn` calls
                // provider.chatStream, and the upstream behind the LU Cloud proxy
                // answers a bad parameter with 422 rather than 400. That
                // number used to be in useChat.ts only, so this branch ended
                // the whole run where plain chat just retried.
                if (shouldDowngradeThinking(streamOpts.thinking, thinkErr)) {
                  providerTurn = await streamProviderTurn(provider, modelToUse, sendMessages, { ...streamOpts, thinking: undefined as unknown as boolean }, onLiveContent, () => {}, onToolProgress)
                  break
                }
                const transient = asString(prop(thinkErr, 'name')) !== 'AbortError' && !isTerminalModelError(thinkErr) && !cutByModelSwitch(convId)
                if (transient && connRetries < 2) {
                  connRetries++
                  const wait = retryDelayMs(thinkErr, connRetries)
                  log.warn('agent.model_call_retry', { attempt: connRetries, provider: providerId, waitMs: wait, err: errorText(thinkErr) })
                  announceWait(thinkErr, wait)
                  await waitBeforeRetry(convId, wait, abort.signal)
                  continue
                }
                throw thinkErr
              }
            }
            useRunActivityStore.getState().setActivity(convId, null)
            logFirstWait()
            turn = providerTurn
            // Und jeder andere Transport nennt ihn `finish_reason`.
            turnFinishReason = providerTurn.finishReason
          }

          toolCalls = turn.toolCalls
          turnContent = turn.content || ''
          notePhoneCount(turn.promptEvalCount)
          // Real consumed-context usage for THIS turn (system + tools + RAG +
          // history + input). The agent loop runs multiple model calls; the
          // latest one has the fullest prompt, so storing each turn (last wins)
          // keeps the TokenCounter on the true current fill instead of a char/4
          // estimate. Ollama reports it natively; openai providers via usage.
          if (turn.promptEvalCount || turn.evalCount) {
            useChatStore.getState().updateMessageUsage(convId!, assistantMessage.id, {
              promptTokens: turn.promptEvalCount || 0,
              completionTokens: turn.evalCount || 0,
              totalTokens: (turn.promptEvalCount || 0) + (turn.evalCount || 0),
              estimated: false,
            })
          }
          requestUsage.add(turn)
          // Native thinking field (Ollama; LU Cloud reasoning_content)
          if (turn.thinking) turnThinking = turn.thinking

        } else {
          // ── Hermes XML prompt-based tool calling ──
          // Streamed like every other transport now (2026-07-31): the
          // display filter keeps <tool_call> XML from ever flashing into the
          // bubble while prose lands token by token. The parse below still
          // runs on the FULL raw text, so extraction cannot differ from the
          // old non-streaming path. This also retires chatNonStreaming here,
          // which spoke Ollama's /api/chat and quietly mis-routed hermes
          // turns on every other provider.
          const display = createHermesDisplayFilter()
          // G35 (2026-08-07): the thought streams inside the SAME
          // bounded 3-line ThinkingBlock window as the native path, never
          // full-height into the bubble. On this transport the reasoning
          // arrives inline as <think> text, and the Qwen3 templates pre-open
          // the thought in the PROMPT, so the stream begins mid-thought and
          // only ever sends the closer — startInThink covers exactly that.
          // With thinking OFF the thought is not shown live at all; the
          // end-of-turn parse on the full raw text stays authoritative.
          const splitter = createThinkStreamSplitter({ startInThink: keepThinking })
          let shown = ''
          // Two live reasoning sources on this transport, merged by the one
          // shared sink so neither can overwrite the other: the <think> spans
          // the splitter pulls out of the text stream, and the native
          // reasoning channel the backend may fill instead. Paint only; the
          // end-of-turn parse on the full raw text stays authoritative.
          const thinkSink = createTurnThinkingSink()
          const paintThink = () => {
            if (!keepThinking) return
            runState.thinking = thinkSink.live()
            scheduleUIUpdate()
          }
          const feedUI = (chunk: { prose: string; thinking: string }) => {
            if (chunk.thinking && keepThinking) {
              thinkSink.inline(chunk.thinking)
              paintThink()
            }
            if (chunk.prose) shown += chunk.prose
            if (!holdLiveText()) runState.content = shown
            scheduleUIUpdate()
          }
          // The tri-state, not a hole. Until the 2.6.7 Denk-Audit this branch
          // passed `thinking: undefined` and threw the switch away, in both
          // directions: ON never reached the model, and OFF never turned
          // anything off either, because undefined means "server decides" and
          // the Qwen3 family decides yes. The prompt transport is where every
          // strict template and every tool-less local model lands, the
          // built-in engine included, so that was a whole transport with a
          // dead Think button. The tool contract travels as TEXT here, so a
          // thinking flag cannot disturb it.
          const hermesOpts = { ...chatOptions }
          let hermesTurn: StreamedProviderTurn
          const runHermes = (opts: typeof hermesOpts) => streamProviderTurn(
            provider,
            modelToUse,
            // Bug B3 round 2: this used to rebuild every message as bare
            // role+content, which dropped tool_calls, tool_call_id AND image
            // attachments on the prompt-transport path only. The provider
            // contract decides what a template can render; it must be given
            // the whole message to decide on.
            sendMessages,
            opts,
            (_full, delta) => feedUI(splitter.feed(display.feed(delta))),
            // A prompt-transport backend can still answer on the NATIVE
            // reasoning channel: the built-in engine extracts <think> into
            // reasoning_content itself and the provider yields it as
            // `thinking`. This branch passed no thinking callback and never
            // read hermesTurn.thinking either, so that reasoning fell on the
            // floor and the block stayed empty with the Think button on.
            (full) => { thinkSink.native(full); paintThink() },
          )
          try {
            hermesTurn = await runHermes(hermesOpts)
          } catch (thinkErr) {
            // Same downgrade the native branches carry, from the same one
            // place: an old Ollama build or an endpoint that predates the knob
            // answers 400 (the hosted backend: 422), and the run must survive that
            // instead of ending on it.
            if (shouldDowngradeThinking(hermesOpts.thinking, thinkErr)) {
              hermesTurn = await runHermes({ ...hermesOpts, thinking: undefined as unknown as boolean })
            } else {
              throw thinkErr
            }
          }
          feedUI(splitter.feed(display.flush()))
          feedUI(splitter.flush())
          // Derselbe Transport wie im Zweig darueber, also derselbe Grund. Ein
          // Prompt-Transport kann den Zug genauso mitten im `<tool_call>`
          // abschneiden, und dann steht hier ebenfalls kein Werkzeugaufruf.
          turnFinishReason = hermesTurn.finishReason
          requestUsage.add(hermesTurn)
          notePhoneCount(hermesTurn.promptEvalCount)
          if (hermesTurn.thinking) {
            turnThinking = turnThinking
              ? `${turnThinking}\n\n${hermesTurn.thinking}`
              : hermesTurn.thinking
          }
          const rawContent = hermesTurn.content

          if (hasToolCallTags(rawContent)) {
            toolCalls = parseHermesToolCalls(rawContent).map(tc => ({
              function: { name: tc.name, arguments: tc.arguments },
            }))
            turnContent = stripToolCallTags(rawContent)
          } else {
            turnContent = rawContent
          }
        }

        // End-of-turn settlement, through the ONE shared routine every path
        // uses now (lib/thinking-stripper settleThinking): balanced blocks,
        // the pre-opened Qwen3 thought that only ever sends its closer, a
        // turn cut off mid-thought, and the non-canonical markers. Routed
        // into the collapsible block only when the user asked for thinking:
        // reasoners emit the tags unconditionally and OFF has to mean off.
        {
          const settled = settleThinking(turnContent, turnThinking, keepThinking)
          turnContent = settled.content
          turnThinking = settled.thinking
        }

        // Update UI — but DON'T overwrite contentRef during intermediate
        // turns. Previously every iteration did `runState.content =
        // turnContent`, which wiped any narration the model emitted
        // before a tool call ("I'll create an index, then write the file
        // …") the moment the next iteration produced an empty-content
        // tool call. The user saw the message disappear, then reappear
        // 3× as more tool calls fired, and finally a fresh final answer
        // — losing all the intermediate context.
        //
        // Now: intermediate `turnContent` (with tool_calls > 0) is
        // preserved as a `reflection` block so it renders above the tool
        // calls in chronological order. Only the final-turn content (no
        // tool_calls) becomes the message body.
        const knownToolNames = toolRegistry.getAll().map((t) => t.name)

        // Canonicalize near-miss tool names (2026-06-03): gemma4 emitted a
        // NATIVE call to `video_generation` (not `video_generate`) → "Unknown
        // tool" → it gave up. Map such close misses to the registered name.
        if (toolCalls.length > 0) {
          const tools = toolRegistry.getAll()
          toolCalls = toolCalls.map((tc) => {
            const fixed = repairToolCall(tc.function.name, isRecord(tc.function.arguments) ? tc.function.arguments : {}, tools)
            return fixed.name === tc.function.name ? tc : { ...tc, function: { ...tc.function, name: fixed.name, arguments: fixed.arguments } }
          })
        }

        // Loose tool-call fallback (2026-06-03): weak local models often
        // WRITE the call into their answer text instead of using the structured
        // tool_calls channel — gemma4:e4b answers in prose; qwen2.5-coder:14b
        // wrote `image_generate(prompt="…")` as plain text and never emitted a
        // real call, so the image/video flow never fired. If the native/Hermes
        // channel produced nothing, lift any recognizable call out of the
        // content (known tool names only) and strip it from the visible prose.
        if (toolCalls.length === 0 && turnContent.trim()) {
          const loose = parseLooseToolCalls(turnContent, knownToolNames)
          if (loose.calls.length > 0) {
            toolCalls = loose.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }))
            turnContent = stripMatchedCalls(turnContent, loose.matched)
            log.info('agent.loose_tool_call_recovered', { count: toolCalls.length, names: toolCalls.map((t) => t.function.name) })
          }
        }

        // Clean any tool-call text the model echoed into its prose (the owner
        // 2026-06-04) — raw JSON like {"name":"image_generate",…} was leaking
        // into the chat as a "notes"/JSON block. Runs even when a proper native
        // call was emitted alongside the echo. Tool args/results stay in the
        // agent's internal history; this only cleans the visible bubble.
        turnContent = stripToolCallText(turnContent, knownToolNames)

        // A turn cut off by the token limit: its last call may stop halfway
        // (dropCutOffCall). Checked after the loose fallback, which reads the
        // same cut text.
        {
          const cut = dropCutOffCall(toolCalls, turnFinishReason)
          if (cut.dropped) {
            toolCalls = cut.calls
            log.info('agent.cut_off_call_dropped', { name: cut.dropped.function.name })
          }
        }

        // The user ordered a web search and the model makes the call itself: the
        // first search of the run asks for what the user wrote, not for the
        // model's rewording of it (check on Android with 4 GB, F4). Phone only,
        // `searchOrdered` is false on a desktop.
        if (searchOrdered && !searchQueryPinned && toolCalls.some((tc) => tc.function.name === 'web_search')) {
          searchQueryPinned = true
          const pinned = withOrderedQuery(toolCalls, userContent)
          if (pinned !== toolCalls) {
            toolCalls = pinned as ToolCall[]
            log.info('agent.ordered_search_query_kept')
          }
        }

        // Over-loop guard: keep only the media the user asked for (once each) and
        // drop any tool call that exactly repeats one already run this turn.
        if (toolCalls.length > 0) {
          let allowImg = maxImageGen - imageGenDone
          let allowVid = maxVideoGen - videoGenDone
          let blocked = false
          let blockedNonMedia = false
          let blockedCreate = false
          let createInTurn = 0
          const kept: ToolCall[] = []
          for (const tc of toolCalls) {
            const name = tc.function.name
            if (name === CREATE_ORDER_TOOL) {
              if (createCallAllowed(createCalls, createInTurn)) { createInTurn++; kept.push(tc) } else { blocked = true; blockedCreate = true }
            } else if (name === 'image_generate') {
              if (allowImg > 0) { allowImg--; kept.push(tc) } else { blocked = true }
            } else if (name === 'video_generate') {
              if (allowVid > 0) { allowVid--; kept.push(tc) } else { blocked = true }
            } else if (executedCallKeys.has(callKey(tc))) {
              blocked = true
              blockedNonMedia = true
            } else {
              kept.push(tc)
            }
          }
          if (kept.length !== toolCalls.length) {
            log.info('agent.over_loop_blocked', {
              kept: kept.map((t) => t.function.name),
              dropped: toolCalls.length - kept.length,
            })
          }
          toolCalls = kept
          // Everything filtered out → the requested work is already done. Steer
          // the model to a short final reply ONCE; if it STILL only emits blocked
          // calls, fall through to the empty-content summary and stop cleanly.
          if (toolCalls.length === 0 && blocked) {
            if (!mediaSteered) {
              mediaSteered = true
              if (turnContent.trim()) {
                addBlock(runState, convId!, assistantMessage.id, {
                  id: uuid(), phase: 'reflection', content: turnContent, timestamp: Date.now(),
                })
              }
              // Tool-aware wording: telling a coding model "the media is
              // already created" when its duplicate file_read got dropped
              // reads like nonsense and derails it further.
              agentMessages.push({
                role: 'user',
                content: blockedNonMedia
                  ? 'Stop: you are repeating tool calls that already ran this turn — their results are shown above and have not changed. Do not call the same tool with the same arguments again. Use the results you already have and write your final answer now, without calling any tool.'
                  : blockedCreate
                  ? createCallSteer(createCalls)
                  : 'Stop, the media you were asked for is already created and shown. Write ONLY a short, friendly closing line to the user in their own language (e.g. that their picture/clip is ready). Do not output JSON, do not repeat this note, and do not call any tool.',
              } as ChatMessage)
              continue
            }
            runState.content = turnContent
            scheduleUIUpdate()
            break
          }
        }

        let isFinalTurn = toolCalls.length === 0
        // Recovery for a final turn that emitted NO tool call on a media request.
        // A weak model (gemma4:e4b) fails this two ways (2026-06-20, live
        // chat):
        //   1. EMPTY content — it dumped everything into the thinking channel and
        //      emitted nothing usable (the classic "dud turn").
        //   2. FAKE-GEN PROSE — it WROTE "(generating the video…)" / "the video
        //      has been generated" as plain text and never called the tool, so the
        //      user got a confident lie and no media. Every "regenerate" after the
        //      first clip did exactly this.
        // Never synthesize a local image/video tool call in cloud mode — the
        // tools run the LOCAL ComfyUI pipeline, which a cloud-tier user
        // doesn't have (media belongs to the Create tab there).
        // Nor on a phone, where the two tools are not registered at all.
        const mediaPending =
          settings.appMode !== 'cloud' &&
          localMediaToolsExist() &&
          ((wantsImage && maxImageGen > 0 && imageGenDone === 0) ||
            (wantsVideo && maxVideoGen > 0 && videoGenDone === 0))
        const emptyTurn = !turnContent.trim()
        const fakeGenProse = mediaPending && !emptyTurn && FAKE_MEDIA_GEN_RE.test(turnContent)
        if (isFinalTurn && executedCallKeys.size === 0 && (emptyTurn || fakeGenProse)) {
          // 1st EMPTY dud → retry once with thinking OFF (gemma4 dumps its whole
          // response into the thinking channel). Fake-gen prose is non-empty, so it
          // skips the retry and goes straight to synthesis.
          if (emptyTurn && !dudRetried && canThinkAgent && !forceNoThink) {
            dudRetried = true
            forceNoThink = true
            log.info('agent.dud_turn_retry_no_think', { model: activeModel })
            continue
          }
          // The user clearly asked for media but the model couldn't emit the call.
          // SYNTHESIZE it. Prefer the EXACT args of the media being re-made (passed
          // as mediaHint by the chat-tools router — same prompt, inputImage,
          // duration) so "nochmal"/"again" reproduces it faithfully; else extract a
          // prompt from the user's text.
          if (!mediaSynthesized && mediaPending) {
            mediaSynthesized = true
            const useVideo = wantsVideo && maxVideoGen > 0 && videoGenDone === 0
            const hintArgs =
              opts?.mediaHint && opts.mediaHint.kind === (useVideo ? 'video' : 'image')
                ? opts.mediaHint.args
                : undefined
            // A picture attached to this message is what the user wants
            // worked on, by its number in the chat (A12).
            const synthArgs =
              hintArgs && Object.keys(hintArgs).length > 0
                ? hintArgs
                : { prompt: extractMediaPrompt(userPromptText), ...(imageToolNote ? { inputImage: attachmentLabel(priorImages + 1) } : {}) }
            toolCalls = [{
              function: {
                name: useVideo ? 'video_generate' : 'image_generate',
                arguments: synthArgs,
              },
            }] as ToolCall[]
            isFinalTurn = false
            // Drop the hallucinated "(generating…)" prose so it never renders above
            // the real media that is about to be produced.
            if (fakeGenProse) turnContent = ''
            log.info('agent.media_fallback_synthesized', {
              tool: toolCalls[0].function.name,
              fromHint: !!(hintArgs && Object.keys(hintArgs).length),
              fakeGenProse,
            })
          }
        }
        // Create in chat: a closing text that claims something is being made or
        // is ready, although this reply placed no order and none is running in
        // the conversation. One objection; if the model stays with it, the
        // app's correction stands under its text.
        if (
          isFinalTurn && opts?.createTools && !opts?.hiddenUser && !createCalls.placed
          && claimsCreateWork(turnContent)
          && !useCreateOrderStore.getState().ordersFor(convId).some((o) => o.state === 'running')
        ) {
          if (!createClaimSteered) {
            createClaimSteered = true
            agentMessages.push({ role: 'assistant', content: turnContent } as ChatMessage)
            agentMessages.push({ role: 'user', content: CREATE_CLAIM_STEER } as ChatMessage)
            continue
          }
          turnContent = `${turnContent.trim()}\n\n${CREATE_CLAIM_NOTE}`
        }
        // The same for the order itself: a closing text that says an order
        // exists ("Here is your order") although this reply placed none and
        // none is open in the conversation. The usual way there is a
        // create_order call that was refused. One objection; if the model
        // stays with it, the app's correction stands under its text.
        if (
          isFinalTurn && opts?.createTools && !opts?.hiddenUser && !createCalls.placed
          && claimsCreateOrder(turnContent)
          && !openOrder(useCreateOrderStore.getState().ordersFor(convId))
        ) {
          if (!createOrderClaimSteered) {
            createOrderClaimSteered = true
            agentMessages.push({ role: 'assistant', content: turnContent } as ChatMessage)
            agentMessages.push({ role: 'user', content: CREATE_ORDER_CLAIM_STEER } as ChatMessage)
            continue
          }
          if (!turnContent.includes(CREATE_CLAIM_NOTE)) turnContent = `${turnContent.trim()}\n\n${CREATE_ORDER_CLAIM_NOTE}`
        }
        // The user ordered a web search in so many words and the model ended
        // its first answer without calling anything (re-check on Android 8 GB,
        // N2: a 2B model invented a winner, or said it cannot search, with the
        // search tool in its list). Same answer as for a picture above: the
        // loop makes the one call the user asked for, through the normal path
        // (permission, approval, result to the model), and the model answers
        // from what came back. What it wrote before is dropped: it is not the
        // result of a search. Phone only, the desktop is left as it was.
        if (isMobile() && !searchSynthesized) {
          const query = searchFallbackQuery({
            userText: userContent,
            finalTurnWithoutCall: isFinalTurn,
            callsRunSoFar: executedCallKeys.size,
            searchOffered: offeredTools.some((t) => t.name === 'web_search'),
            readOnly: opts?.readOnly === true,
            alreadyDone: searchSynthesized,
          })
          if (query) {
            searchSynthesized = true
            toolCalls = [{ function: { name: 'web_search', arguments: { query } } }] as ToolCall[]
            isFinalTurn = false
            log.info('agent.search_fallback_synthesized', { answered: !emptyTurn })
            turnContent = ''
            runState.content = ''
            scheduleUIUpdate()
          }
        }
        if (isFinalTurn) {
          // G16: ending the run is only legitimate when the model's own plan
          // is done. A read-only turn answers in text and is exempt. The
          // steer goes through agentMessages (NOT `messages`, see the
          // read-only guard above for the ReferenceError that name cost), and
          // the model's claim is appended first so it argues against its own
          // words, not against a hole in the history.
          if (!opts?.readOnly && planReconcilesRemaining > 0) {
            const gap = openPlanGap(useTodoStore.getState().getTodos(convId!))
            if (gap) {
              planReconcilesRemaining--
              if (turnContent.trim()) {
                agentMessages.push({ role: 'assistant', content: turnContent })
                addBlock(runState, convId!, assistantMessage.id, {
                  id: uuid(),
                  phase: 'reflection',
                  content: turnContent,
                  timestamp: Date.now(),
                })
              }
              agentMessages.push({ role: 'user', content: planReconcileSteer(gap) })
              continue
            }
          }
          // G17: a reasoning-only round mid-run is not an ending. Layer 1 is
          // the dud retry above (fires only before ANY tool ran), layer 2 is
          // the G16 reconcile (needs an open plan). This is layer 3: work has
          // started, there is no plan to lean on, and the round was thought
          // with no words and no call. R17 died exactly here, step 1 of 31.
          if (
            !opts?.readOnly &&
            executedCallKeys.size > 0 &&
            reasoningContinuesRemaining > 0 &&
            reasoningOnlyRound(turnContent, turnThinking)
          ) {
            reasoningContinuesRemaining--
            agentMessages.push({ role: 'user', content: REASONING_CONTINUE_STEER })
            continue
          }
          // Z36 finding 3: with one real success in the history the model
          // starts fabricating the next ones, confident links no tool ever
          // returned. The G14 guards cover text the APP invents; this one
          // catches the MODEL inventing, deterministically: a URL absent from
          // everything the model was shown cannot have come from a tool. One
          // steer to really search or retract; if it insists, the text stands
          // (it is the model's answer, G14-2) and the bubble gets a labelled
          // notice via unbackedLinks instead.
          //
          // The notice is NOT gated on a prior success: the Z36 counter-check
          // (2026-08-22, persona run) watched Hermes-3-3B write its tool
          // calls as prose, so no call ever really ran, and the invented
          // links stood unmarked because the old anyToolSucceeded gate never
          // armed. On an agent turn any link no tool returned is unverified
          // by definition, so the label always tells the truth. Only the
          // corrective STEER stays gated on a real success (the original Z36
          // trigger), so a run that never used tools is not sent into an
          // extra round.
          // Phone only (short check on Android, package 8, N1). The link steer below was sent, no tool ran since,
          // and what came back is not an answer to the user but a reply to the steer ("I apologize for the
          // confusion ... I will rephrase my answer without this link."), or nothing. That text stood in the
          // chat as the answer, and the real one sat in a folded note. The first answer stays the answer; its
          // link gets the label below, as for a model that insists. The reply to the steer is shown nowhere.
          if (isMobile() && steeredAnswer && executedCallKeys.size === steeredAnswer.calls && steerReplyIsNoAnswer(turnContent, steeredAnswer.text)) {
            log.info('agent.unbacked_links_steer_reply_dropped', { chars: turnContent.length })
            const noteId = steeredAnswer.blockId
            runState.blocks = runState.blocks.filter((b) => b.id !== noteId)
            useChatStore.getState().updateMessageAgentBlocks(convId!, assistantMessage.id, runState.blocks)
            turnContent = steeredAnswer.text
            // Labelled here: the check below reads what the model was shown, and by now that holds the link
            // (its own first answer and the steer that names it).
            useChatStore.getState().updateMessageUnbackedLinks(convId!, assistantMessage.id, steeredAnswer.links)
          }
          steeredAnswer = null
          if (turnContent.trim()) {
            const shownToModel = agentMessages
              .map((m) => {
                const c = (m as { content?: unknown }).content
                if (typeof c === 'string') return c
                if (Array.isArray(c)) {
                  return c
                    .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
                    .join('\n')
                }
                return ''
              })
              .join('\n')
            const invented = findUnbackedLinks(turnContent, shownToModel)
            if (invented.length > 0) {
              if (anyToolSucceeded && !linksSteered) {
                linksSteered = true
                log.info('agent.unbacked_links_steer', { count: invented.length, links: invented })
                agentMessages.push({ role: 'assistant', content: turnContent })
                const noteId = uuid()
                addBlock(runState, convId!, assistantMessage.id, {
                  id: noteId,
                  phase: 'reflection',
                  content: turnContent,
                  timestamp: Date.now(),
                })
                if (isMobile()) steeredAnswer = { text: turnContent, blockId: noteId, calls: executedCallKeys.size, links: invented }
                agentMessages.push({ role: 'user', content: unbackedLinksSteer(invented) })
                continue
              }
              log.info('agent.unbacked_links_flagged', { count: invented.length, links: invented })
              useChatStore.getState().updateMessageUnbackedLinks(convId!, assistantMessage.id, invented)
            }
          }
          runState.content = turnContent
          // G21-2: after tool activity the closing thought belongs in the
          // block sequence too, in position before the final answer, not in
          // the one top-of-bubble field. A run with NO tool activity keeps
          // the classic bubble (plain chat look, and the tool-intent hint
          // in MessageBubble reads message.thinking).
          if (executedCallKeys.size > 0 && turnThinking.trim() && keepThinking) {
            addBlock(runState, convId!, assistantMessage.id, {
              id: uuid(),
              phase: 'thinking',
              content: turnThinking,
              timestamp: Date.now(),
            })
            runState.thinking = ''
            useChatStore.getState().updateMessageThinking(convId!, assistantMessage.id, '')
          } else {
            runState.thinking = turnThinking
          }
          // Fehler D, Symptom 2, jetzt fuer den Agenten Reiter. Bis hierher war
          // ein Zug, den das Modell nie zu Ende schreiben konnte, von einem
          // fertigen Modell nicht zu unterscheiden: derselbe leere
          // Werkzeugsatz, derselbe wortlose Schluss, und der Plan blieb auf
          // seinem offenen Schritt stehen. Der Grund lag die ganze Zeit auf der
          // Leitung (`done_reason` bei Ollama, `finish_reason` bei den
          // uebrigen), nur las ihn hier niemand aus. Sichtbar an ZWEI Stellen,
          // wie im Code Reiter: an der Antwort und als Block im Faden, sonst
          // kann die beiden Faelle spaeter niemand auseinanderhalten.
          // A stream that closed because the person picked another model: the
          // answer carries that as its marker (lib/model-switch-stop.ts).
          if (convId && turnFinishReason && finishReasonAfterSwitch(turnFinishReason, convId) === MODEL_SWITCH_FINISH) {
            useChatStore.getState().updateMessageFinishReason(convId, assistantMessage.id, MODEL_SWITCH_FINISH)
          }
          const cutoff = codexCutoffNote(
            turnFinishReason,
            convId ? openPlanGap(useTodoStore.getState().getTodos(convId)) : null,
          )
          if (cutoff && convId) {
            runState.content =
              (runState.content ? runState.content + '\n\n' : '') + `_(${cutoff})_`
            addBlock(runState, convId, assistantMessage.id, {
              id: uuid(),
              phase: 'reflection',
              content: `\u26d4 ${cutoff}`,
              timestamp: Date.now(),
            })
          }
          scheduleUIUpdate()
          break
        }

        // G21-2 (2026-08-07): each round's thought becomes its OWN block
        // in chronological position, before this round's calls, instead of all
        // rounds piling into the one thinking field the bubble renders on top.
        // The top-level field is cleared so the same thought never shows twice;
        // the next round's live stream refills it while streaming and lands
        // here again when that round completes.
        if (turnThinking.trim() && keepThinking) {
          addBlock(runState, convId!, assistantMessage.id, {
            id: uuid(),
            phase: 'thinking',
            content: turnThinking,
            timestamp: Date.now(),
          })
        }
        if (turnContent.trim()) {
          addBlock(runState, convId!, assistantMessage.id, {
            id: uuid(),
            phase: 'reflection',
            content: turnContent,
            timestamp: Date.now(),
          })
        }
        runState.thinking = ''
        useChatStore.getState().updateMessageThinking(convId!, assistantMessage.id, '')
        scheduleUIUpdate()

        // Phase 5b (v2.4.0) — parallel tool execution via tool-executor.
        //
        // Pre-create AgentToolCall + block per tc so the UI can render all
        // of them concurrently before any runs. Then executeParallel runs
        // them respecting sideEffectKey (file_write same-path serializes,
        // shell/code share an 'exec' queue, image/workflow share 'comfyui',
        // pure reads fully parallel).
        if (abort.signal.aborted) break

        // Same execution-time guard as Code: the catalog filter is not enough on
        // its own, because the loose-parse fallback lifts a call the model wrote
        // as TEXT and the executor resolves it by name without asking whether
        // this turn was allowed to offer it. Proven live on the Code side
        // 2026-07-25, where a read-only /plan created a file while every request
        // carried a read-only catalog.
        const refusalsFrom = agentMessages.length
        if (opts?.readOnly) {
          const blocked = toolCalls.filter((tc) => !allowedInReadOnlyTurn(tc.function?.name ?? ''))
          if (blocked.length) {
            toolCalls = toolCalls.filter((tc) => allowedInReadOnlyTurn(tc.function?.name ?? ''))
            const names = [...new Set(blocked.map((tc) => tc.function.name))].join(', ')
            // `agentMessages`, not `messages` (audit follow-up): this guard was
            // copied from useCodex, whose history array IS called messages. In
            // this hook that name does not exist, so the first read-only turn
            // that actually blocked a mutating call died on a ReferenceError.
            agentMessages.push({
              role: 'user',
              content: `${names} is not available on this turn, it is a read-only command. Do not try to change anything. Finish with the written answer using what you have already read.`,
            })
          }
        }

        // A tool switched off in the permissions is refused, not offered for
        // approval (bug hunt 01.10.2026, A4). The approval below asked for
        // every level that was not 'auto', 'blocked' included, so one click on
        // Approve ran a tool the user had turned off. Leaving it out of the
        // catalog is not a gate: the loose parser lifts a call written as text
        // and the executor resolves it by name. Same level, same inputs as the
        // approval, and the same refusal the Code tab gives.
        {
          const overrides = usePermissionStore.getState().perToolOverrides
          const isBlocked = (tc: ToolCall) => resolveApprovalLevel(tc.function.name, {
            categoryLevel: toolRegistry.getPermissionLevelWithOverrides(tc.function.name, permissions, {}),
            override: overrides[tc.function.name],
            codexMode: null,
            readOnlyRun: run.readOnlyShellTurn,
          }) === 'blocked'
          const refused = toolCalls.filter(isBlocked)
          if (refused.length) {
            toolCalls = toolCalls.filter((tc) => !isBlocked(tc))
            const names = [...new Set(refused.map((tc) => tc.function.name))].join(', ')
            agentMessages.push({
              role: 'user',
              content: `${names} is switched off for this conversation in the tool permissions, so it was not run. Do not call it again. Continue with the tools you have, or say what you would need.`,
            })
          }
        }

        // Every call of this turn was refused (bug hunt 01.10.2026, A9). The
        // turn went on with an empty batch and wrote `tool_calls: []` into the
        // history, which a strict upstream rejects, behind the refusal it
        // answers. The model's own words go in first, then the refusal, and
        // the next round answers it.
        if (toolCalls.length === 0 && agentMessages.length > refusalsFrom) {
          if (turnContent.trim()) {
            agentMessages.splice(refusalsFrom, 0, { role: 'assistant', content: turnContent })
          }
          continue
        }

        // Loop-detector, parity with Codex: narration first (the same line
        // re-emitted every iteration), then the batch (windowed signature
        // repeats + identical reads against an unchanged workspace). Steer is
        // held and appended AFTER this iteration's history (audit F2), so it
        // never sits chronologically before the calls it refers to.
        const narrationVerdict = loopGuard.recordNarration(turnContent)
        const recordedVerdict = narrationVerdict.action === 'halt'
          ? narrationVerdict
          : loopGuard.recordBatch(
              toolCalls.map((tc) => ({ name: tc.function.name, args: JSON.stringify(tc.function.arguments ?? {}) })),
              // Reads the builder just sent capped: re-reading those is the
              // decay working as designed, not a loop (plan A1, LOOP-GUARD).
              { trimmedReadKeys },
            )
        // A plan the model keeps restating steers like a repeated batch does;
        // the batch's own verdict wins where it has one (A37).
        const batchVerdict = recordedVerdict.action === 'ok' ? narrationVerdict : recordedVerdict
        if (batchVerdict.action === 'halt') {
          runState.content =
            (runState.content ? runState.content + '\n\n' : '') +
            `_(halted: ${batchVerdict.reason}. The model is looping. Try a stronger model for multi-step tasks, or rephrase the instruction.)_`
          scheduleUIUpdate()
          addBlock(runState, convId!, assistantMessage.id, {
            id: uuid(),
            phase: 'reflection',
            content: `⛔ Loop guard halted the run: ${batchVerdict.reason}.`,
            timestamp: Date.now(),
          })
          break
        }
        const pendingSteer = batchVerdict.action === 'steer' ? batchVerdict.message : null
        if (pendingSteer) {
          addBlock(runState, convId!, assistantMessage.id, {
            id: uuid(),
            phase: 'reflection',
            content: `↻ Loop guard steered the model: ${pendingSteer}`,
            timestamp: Date.now(),
          })
        }

        // Every call carries an id from here on. Only the NATIVE channel gives
        // us one; a call lifted out of prose (parseLooseToolCalls) or
        // synthesized by the media fallback had none, so the next turn pushed
        // an assistant `tool_calls` entry with no id AND a tool result with
        // `tool_call_id: undefined`. A strict OpenAI-compatible provider
        // (lu-cloud) rejects the whole conversation for that — and
        // the prose fallback exists precisely for the weak models that can
        // least afford to lose the run.
        toolCalls = toolCalls.map((tc) => (tc.id ? tc : { ...tc, id: uuid() }))

        type BatchEntry = { tc: typeof toolCalls[number]; ac: AgentToolCall; blockId: string }
        const batch: BatchEntry[] = []
        budget.addToolCalls(toolCalls.length)
        const perToolOverrides = usePermissionStore.getState().perToolOverrides
        for (const tc of toolCalls) {
          const toolCallId = uuid()
          const blockId = uuid()
          // Die Stufe kommt aus der gemeinsamen Tabelle (Auftrag 2.3), nicht
          // mehr direkt aus der Registry: sonst haette der Hauptlauf hier eine
          // andere Rechnung als der Unterauftrag in sub-agent.ts, und genau
          // dieses Paar ist in diesem Baum schon mehrfach auseinandergelaufen.
          // Was sich sichtbar aendert: delegate_task oeffnet keinen Dialog
          // mehr. Drei Unteragenten waren vorher drei Unterbrechungen, weil
          // die Kategorie 'workflow' auf 'confirm' steht.
          const permLevel = resolveApprovalLevel(tc.function.name, {
            categoryLevel: toolRegistry.getPermissionLevelWithOverrides(
              tc.function.name,
              permissions,
              {},
            ),
            override: perToolOverrides[tc.function.name],
            // Die Presets sind ein Begriff des Code-Tabs. Hier gilt der
            // Berechtigungs-Store, das ist die BINDUNG aus Plan C1.
            codexMode: null,
            readOnlyRun: run.readOnlyShellTurn,
          })
          // One cloud shell rule for BOTH surfaces (G15a, 2026-08-07): the
          // Code tab and Agent mode read the same helper and the same setting,
          // so the same cloud model cannot be stricter in one tab than the
          // other (R23). The owner's decision of 2026-08-22 made that setting an
          // opt-in that defaults OFF, so this arm normally does nothing and
          // permission level auto runs unattended on a cloud model too. For a
          // user who opted in it rides ON TOP of the per-tool permission
          // level, never loosens it.
          const cloudShellConfirm =
            CODEX_CONFIRM_TOOLS.has(tc.function.name) &&
            codexConfirmEnabled({
              confirmShell: false,
              cloudOptIn: settings.codexCloudConfirmOptIn,
              providerId,
            })
          const needsApproval = (permLevel !== 'auto' || cloudShellConfirm)
            && !(await approvalIsMoot(tc.function.name, tc.function.arguments ?? {}, run))
          // Exec-timeout parity with the Code tab (audit B8): without an
          // injected default the Rust side used its 120 s fallback, so the
          // same npm install that passed in Code died here after 2 minutes.
          // The model's own timeout still wins when it sends one.
          const toolArgs = { ...tc.function.arguments }
          if (tc.function.name === 'shell_execute' && !toolArgs.timeout) {
            toolArgs.timeout = SHELL_EXECUTE_DEFAULT_TIMEOUT_MS
          }
          const ac: AgentToolCall = {
            id: toolCallId,
            toolName: tc.function.name,
            args: toolArgs,
            status: needsApproval ? 'pending_approval' : 'running',
            timestamp: Date.now(),
          }
          addBlock(runState, convId!, assistantMessage.id, {
            id: blockId,
            phase: 'tool_call',
            content: needsApproval
              ? `Requesting approval: ${tc.function.name}`
              : `Running: ${tc.function.name}`,
            toolCall: ac,
            toolCalls: [ac],
            timestamp: Date.now(),
          })
          batch.push({ tc, ac, blockId })
        }

        // A generation that may go on in the background is booked under its
        // own owner, not under the conversation (lib/background-tools.ts): a
        // Stop of a LATER turn here must not cancel it. While this turn waits
        // for it, runWithBackgroundGrace below hands this turn's Stop on.
        const requests: ExecutionRequest[] = batch.map((e) => ({
          id: e.ac.id,
          toolName: e.ac.toolName,
          args: e.ac.args,
          run: mayRunInBackground(e.ac.toolName, settings)
            ? { ...run, generationOwner: generationOwnerFor(e.ac.id) }
            : run,
        }))
        const auditIds = new Map<string, string>()

        const results = await executeParallel(requests, {
          // The curated allow-list is enforced HERE, where it decides what
          // runs, not only where the catalog is built (audit M2). Filtering the
          // offered tools shaped what the model was TOLD about; the prose
          // fallback then lifted any name out of the full registry —
          // shell_execute included — so the "plain chat gets five safe tools"
          // contract held everywhere except at the point of execution. The one
          // surface that is guaranteed to carry attacker-controlled text
          // (web_fetch output) is the one that can talk a weak model into
          // naming a terminal tool. A tool the run never offered does not
          // exist for this run, and the model gets told so and can retry with
          // one that does.
          getTool: (name) => (toolMatchesCurated(name) ? toolRegistry.resolveExecutable(name) : undefined),
          // Timeout backstop shared with Codex (audit B9): before this the
          // Agent loop had NO ceiling around a tool call, so one hung tool
          // wedged the whole run with no way out but a restart.
          execute: (name: string, args: ToolArgs, callRun?: AgentRunContext, signal?: AbortSignal) => {
            const timed = (base: AbortSignal) => raceWithToolTimeout(
              name,
              toolCallCapMs(name, args, settings),
              // The run's Stop travels into the tool itself (audit M1), not
              // just to the batch scheduler. `raced` also carries the race's
              // OWN timeout abort now (klaerung-n5a Fix 2), so a timed-out
              // call is cancelled for real instead of left running orphaned.
              (raced) => toolRegistry.execute(name, args, 1, callRun, raced),
              base,
            )
            const owner = callRun?.generationOwner
            const toolCallId = callRun?.toolCallId
            if (!owner || !toolCallId || !convId) return timed(signal ?? abort.signal)
            // 3.0.8 (A2): a picture or video that is not done after a short
            // wait goes on in the background, and the turn moves on. Its
            // own signal, not the turn's: after the hand-over the turn ends,
            // and its Stop must not reach the job any more.
            return runWithBackgroundGrace({
              graceMs: backgroundGraceMs(),
              turnSignal: signal ?? abort.signal,
              start: (jobSignal) => timed(jobSignal),
              cancelGeneration: () => requestGenerationCancel(owner),
              onDetach: (work, stop) => {
                const jobId = newJobId()
                detachToolCall({
                  jobId,
                  toolCallId,
                  toolName: name,
                  convId,
                  messageId: assistantMessage.id,
                  startedAt: Date.now(),
                  work,
                  stop,
                })
                return startedResult(name, jobId)
              },
            })
          },
          lookupCache: convId ? makeInTurnCacheLookup({ convId, turnStartMs }) : undefined,
          explainError: (toolName, err) => explainToolError(toolName, err),
          awaitApproval: async (req) => {
            const entry = batch.find((e) => e.ac.id === req.id)
            if (!entry) return true
            // Phase 12 — tools whose AC was marked 'running' at batch
            // creation (permission level 'auto') bypass the approval
            // gate entirely. Only 'pending_approval' tools enqueue.
            if (entry.ac.status !== 'pending_approval') return true
            const approved = await waitForApproval(convId!, entry.ac, abort.signal)
            if (approved) {
              entry.ac.status = 'running'
              updateBlockById(runState, convId!, assistantMessage.id, entry.blockId, {
                toolCall: { ...entry.ac },
                toolCalls: [{ ...entry.ac }],
                content: `Running: ${entry.ac.toolName}`,
              })
            }
            return approved
          },
          recordAudit: (entry) => {
            if (!convId) return
            if (entry.kind === 'start') {
              const aid = useToolAuditStore.getState().record({
                convId,
                toolCallId: entry.id,
                toolName: entry.toolName,
                args: entry.args,
                startedAt: entry.startedAt,
                parentToolCallId: entry.parentToolCallId,
              })
              auditIds.set(entry.id, aid)
            } else {
              const aid = auditIds.get(entry.id)
              if (aid) {
                useToolAuditStore.getState().complete(aid, {
                  status: entry.status,
                  completedAt: entry.completedAt,
                  resultPreview: entry.resultPreview,
                  error: entry.error,
                  errorHint: entry.errorHint,
                  cacheHit: entry.cacheHit,
                })
              }
            }
          },
        }, {
          // ExecutorOptions, not the runtime: abortSignal has always belonged
          // to the third argument, and passing it inside the runtime object
          // meant Stop never kept the not-yet-started calls of a batch from
          // firing. A stopped run has to stop doing things.
          abortSignal: abort.signal,
        })

        // Apply results back onto blocks + memory + LLM history.
        for (const entry of batch) {
          const result = results.find((r) => r.id === entry.ac.id)
          if (!result) continue
          applyResultToToolCall(entry.ac, result)
          // Over-loop accounting (2026-06-04): remember every executed call
          // (so an identical repeat is skipped) and count successful media gens
          // against the per-turn cap that stops "13× the same cat".
          executedCallKeys.add(callKey(entry.tc))
          // D#81 (TheRealNovelist, 2026-07-21): a ComfyUI 400/500 does not reject
          // — the media tools RETURN their error as a normal result string, so
          // status is 'completed' and every consumer below used to treat a failed
          // generation as a delivered one. Reclassify it once, here, and the cap,
          // the label, the memory write and the "is now displayed" note all
          // follow. Non-media tools are unaffected.
          const mediaOk = mediaCallSucceeded(entry.ac.toolName, entry.ac.result)
          if (!mediaOk) entry.ac.status = 'failed'
          // Went on in the background (3.0.8, A2): the call is not over, it
          // just no longer holds the turn. It keeps its spinner and gets its
          // result from the job (stores/backgroundJobStore.ts). Counted
          // against the media cap like a delivered one, so the model cannot
          // start the same render a second time in this turn.
          const bgJobId = jobIdOfStartedResult(entry.ac.result)
          if (bgJobId) {
            entry.ac.status = 'running'
            entry.ac.background = { jobId: bgJobId, startedAt: entry.ac.startedAt ?? Date.now(), state: 'running' }
          }
          if ((result.status === 'completed' || result.status === 'cached') && mediaOk) {
            anyToolSucceeded = true
            if (entry.ac.toolName === 'image_generate') imageGenDone++
            else if (entry.ac.toolName === 'video_generate') videoGenDone++
          }
          if (entry.ac.toolName === CREATE_ORDER_TOOL) noteCreateResult(createCalls, result.result)
          const contentLabel =
            bgJobId
              ? backgroundLabel(entry.ac.toolName)
              : !mediaOk
              ? `Failed: ${entry.ac.toolName}`
              : result.status === 'completed'
                ? `Completed: ${entry.ac.toolName}`
                : result.status === 'cached'
                  ? `Cached: ${entry.ac.toolName}`
                  : result.status === 'rejected'
                    ? `Rejected: ${entry.ac.toolName}`
                    : `Failed: ${entry.ac.toolName}`
          updateBlockById(runState, convId!, assistantMessage.id, entry.blockId, {
            toolCall: { ...entry.ac },
            toolCalls: [{ ...entry.ac }],
            content: contentLabel,
          })

          // Per-tool-call memory writes were removed here (audit E1): every
          // successful call became a permanent 'reference' memory, so a long
          // run left hundreds of file_read/shell entries competing for the
          // memory budget of every FUTURE conversation, plus one embedding
          // call each against the same backend the chat was using. The
          // curated turn-level extractor (extractMemoriesFromPair) is the
          // memory path; raw tool results were never memories.
        }

        // Epoch reset (audit B1). The over-loop guard blocks a call whose
        // name+args exactly repeat one already run THIS turn. But after a
        // mutation the same call is legitimately new: edit → test → edit →
        // test repeats `run_tests` with identical args and MUST re-run.
        // Same dividing line the loop guard and the in-turn cache use: any
        // side-effecting call may change what the next identical call
        // returns, so the repeat set starts over. Media stays capped via
        // imageGenDone/videoGenDone, which this reset does not touch.
        if (batch.some((e) => MUTATING_TOOLS.has(e.ac.toolName))) {
          executedCallKeys.clear()
        }

        // Feed results back into LLM history. Format differs per provider:
        //   OpenAI / Anthropic / Ollama native: ONE assistant message with
        //   tool_calls[] + N tool messages (one per result). This preserves
        //   the provider's expected structure when multiple tool calls come
        //   back in one assistant turn.
        //   Hermes XML fallback: pairs (assistant <tool_call> → user result),
        //   kept per-call for compatibility with how the non-native path
        //   parses history.
        const resultTextFor = (r: typeof results[number]): string => {
          const text =
            r.status === 'rejected'
              ? REJECTED_CALL_FOR_MODEL
              : r.status === 'completed' || r.status === 'cached'
                ? (r.result ?? '')
                : r.errorHint
                  ? `${r.error ?? 'Tool failed'}, ${r.errorHint}`
                  : (r.error ?? 'Tool failed')
          // Small-Model Mode (Knob 3): truncate long tool outputs (head+tail)
          // before re-injecting into history. No-op for big models. The short
          // mediaNote appended at the push sites is left intact.
          // Head+tail cap for everyone: small-model mode keeps its tight 1500
          // chars, big models get 60k (~15k tokens) so one giant tool result
          // can never ride along verbatim in every following request via
          // compaction's KEEP_RECENT window (225k-token prompts, 2026-07-26).
          // Die Notiz haengt NACH dem Kuerzen dran, sonst schneidet ein
          // langes Fehlerprotokoll sie gerade dann weg, wenn sie gebraucht wird.
          return (
            truncateToolResult(text, phoneResultChars(agentCtx, settings.smallModelMode ? 1500 : 60000)) +
            toolFailureNote(r.status)
          )
        }
        // After a successful image/video gen, nudge a NATURAL closing comment so
        // the model doesn't silently loop another generation (2026-06-04).
        // The media-cap is the hard stop; this makes the normal path end with a
        // friendly sentence instead of a blocked-then-steered robotic one.
        const mediaNote = (name: string, r: typeof results[number]): string => {
          // Never claim the media is on screen when the generation failed (D#81)
          // — that injected sentence is what made the model cheerfully announce
          // an image the user never got.
          if (!mediaCallSucceeded(name, r.result)) return ''
          // Still rendering in the background: nothing is on screen yet, and
          // the started result already says what to tell the user.
          if (isStartedResult(r.result)) return ''
          if ((r.status === 'completed' || r.status === 'cached') &&
              (name === 'image_generate' || name === 'video_generate')) {
            const kind = name === 'video_generate' ? 'video' : 'image'
            // A12 box run: qwen3:4b reported the snow it had asked for as if it
            // had seen it. The note says what is known: the media is shown,
            // what is in it is not, until a picture is attached for a model
            // that can see (vision-feedback).
            return `\n\n(The ${kind} is now displayed to the user. You have not seen it: say in a short, natural sentence in the user's language that it is ready, and do not claim what it shows. Do NOT generate another ${kind} unless the user explicitly asks.)`
          }
          return ''
        }

        // lu-cloud is OpenAI-compatible and STRICTLY validates the
        // OpenAI tool shape: assistant tool_calls carry ids and every tool-result
        // message needs a matching tool_call_id. Route it through the id-based
        // branch (not the id-less `native` one below) — otherwise the upstream 422s
        // "ChatCompletionToolMessage.tool_call_id: Field required" and every
        // follow-up turn fails. Ollama/LM-Studio are lenient; only cloud bit.
        // Remember which read produced which result message, so a later step
        // that sends that result capped can tell the loop guard the re-read is
        // legitimate. Registered on the pushed OBJECT, so it works for all
        // three transports even though only one of them carries call ids.
        const rememberResult = (msg: ChatMessage, tc: { function: { name: string; arguments?: unknown } }) => {
          guardKeyOfResult.set(msg as unknown as object, guardKeyFor(tc))
          return msg
        }
        // Bug B3 round 2, the first cause the counter-check proved on the
        // real engine: this chain asked WHICH PROVIDER, never WHICH TRANSPORT.
        // The built-in engine and LM Studio are providerId 'openai', so a run
        // on the prompt transport still wrote its results into the native
        // `tool` role, a role the model's template has no branch for, and no
        // `tools` payload anywhere in the request to justify it. The wire read
        // [system, user, assistant, tool] and the strict template raised on
        // the next round. The transport decides the shape; the provider only
        // decides whether the native shape needs ids.
        // Was dieser Durchgang an die Historie haengt, wird gleich auch fuer
        // die naechste RUNDE aufbewahrt (siehe `werkzeugKette` oben). Der
        // Index ist blockoertlich und damit unempfindlich gegen das
        // Beschneiden, das erst zu Beginn des naechsten Durchgangs laeuft.
        const kettenStart = agentMessages.length
        if (strategy === 'hermes_xml') {
          for (const { tc } of batch) {
            const result = results.find((r) => r.id === batch.find((b) => b.tc === tc)?.ac.id)!
            agentMessages.push({
              role: 'assistant',
              content: buildHermesToolCall(tc.function.name, tc.function.arguments),
            })
            agentMessages.push(rememberResult({
              role: 'user',
              content: buildHermesToolResult(tc.function.name, resultTextFor(result) + mediaNote(tc.function.name, result)),
            }, tc))
          }
        } else if (speaksOpenAIProtocol(providerId) || providerId === 'anthropic') {
          agentMessages.push({
            role: 'assistant',
            content: turnContent || '',
            tool_calls: toolCalls,
          })
          for (const { tc } of batch) {
            const result = results.find((r) => r.id === batch.find((b) => b.tc === tc)?.ac.id)!
            agentMessages.push(rememberResult({
              role: 'tool',
              content: resultTextFor(result) + mediaNote(tc.function.name, result),
              tool_call_id: tc.id,
            }, tc))
          }
        } else if (strategy === 'native') {
          // Ids kept on the native channel too (bug hunt 01.10.2026, A7). Ollama
          // ignores them, but this chain is saved as hidden history: a switch to
          // LU Cloud in the same conversation sent id-less calls and results,
          // which a strict upstream 422s, or at best a prompt prefix that changed
          // every step and missed the upstream cache.
          agentMessages.push({
            role: 'assistant',
            content: turnContent || '',
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          })
          for (const { tc } of batch) {
            const result = results.find((r) => r.id === batch.find((b) => b.tc === tc)?.ac.id)!
            agentMessages.push(rememberResult({
              role: 'tool',
              content: resultTextFor(result) + mediaNote(tc.function.name, result),
              tool_call_id: tc.id,
            }, tc))
          }
        } else {
          // Ollama on a non-native strategy that is not hermes_xml. Same
          // prompt transport, same dialect, written by the same builders as
          // the branch above so the two can never drift apart again.
          for (const { tc } of batch) {
            const result = results.find((r) => r.id === batch.find((b) => b.tc === tc)?.ac.id)!
            agentMessages.push({
              role: 'assistant',
              content: buildHermesToolCall(tc.function.name, tc.function.arguments),
            })
            agentMessages.push(rememberResult({
              role: 'user',
              content: buildHermesToolResult(tc.function.name, resultTextFor(result) + mediaNote(tc.function.name, result)),
            }, tc))
          }
        }
        werkzeugKette.push(...agentMessages.slice(kettenStart))

        // Loop-detector, result side: a round where every call failed changed
        // nothing, so a run of them is a stall the call-shape detectors above
        // cannot see (they only look at what was asked for, and they skip
        // shell on purpose).
        const failVerdict = loopGuard.recordResults(
          results.map((r) => ({ name: r.toolName, failed: resultFailed(r), rejected: r.status === 'rejected', error: r.error ?? (resultFailed(r) ? r.result?.split('\n')[0].slice(0, 300) : undefined), args: r.dispatchedArgs })),
        )
        if (failVerdict.action === 'halt') {
          addBlock(runState, convId!, assistantMessage.id, {
            id: uuid(),
            phase: 'reflection',
            content: `⛔ Loop guard halted the run: ${failVerdict.reason}.`,
            timestamp: Date.now(),
          })
          runState.content =
            (runState.content ? runState.content + '\n\n' : '') +
            `_(halted: ${failVerdict.reason}. The model is looping. Try a stronger model for multi-step tasks, or rephrase the instruction.)_`
          scheduleUIUpdate()
          break
        }

        // Now the steer sits AFTER the calls it refers to (audit F2).
        if (pendingSteer) {
          agentMessages.push({ role: 'user', content: pendingSteer })
        }
        if (failVerdict.action === 'steer') {
          agentMessages.push({ role: 'user', content: failVerdict.message })
        }

        // Vision feedback (2026-06-03): after image_generate, hand the
        // generated picture to a vision-capable model so it SEES the result and
        // can comment — and learns the filename to chain into video_generate.
        // Provider-aware (a user 2026-06-21: a non-Ollama vision model never got
        // the image → it described from the prompt and hallucinated). Now runs
        // for every provider; buildVisionFeedback no-ops for text-only models,
        // video results, or fetch failures — and on non-Ollama only feeds models
        // whose name matches a vision family (so a text LM Studio model isn't
        // sent an image and made to SSE-error).
        //
        // Runde 4 / Nebenbefund N3 (D1 counter-check, Windows build
        // 2026-08-29): the app's own capability answer now goes in with the
        // call. For the built-in engine that is the vision projector on disk,
        // the same file the engine passes as --mmproj, so a text-only
        // conversion of a vision family is never handed a picture again.
        const declaredSight = declaredVision(
          useModelStore.getState().models.find((m) => m.name === activeModel),
        )
        // A screenshot is only worth showing when it is the newest one: with
        // several computer_use calls in a batch, the last result wins.
        const feedbackOrder = batch.some(({ tc }) => tc.function.name === COMPUTER_USE_TOOL_NAME) ? [...batch].reverse() : batch
        for (const { tc, ac } of feedbackOrder) {
          const result = results.find((r) => r.id === ac.id)
          // G22: once this run proved the model text-only, stop attaching.
          if (visionRefused) break
          if (result?.status === 'completed' && result.result) {
            try {
              const vf = await buildVisionFeedback(modelToUse, tc.function.name, result.result, providerId, declaredSight)
              if (vf) {
                // Only the newest screenshot stays a picture. The ones before
                // it are out of date and would fill the context window.
                if (vf.screenFrame) dropOlderScreenFrames(agentMessages)
                agentMessages.push(vf as unknown as ChatMessage)
                visionFeedbackGiven = true
                log.info('agent.vision_feedback_attached', { tool: tc.function.name, provider: providerId })
                break // one image per batch is enough context
              }
            } catch { /* non-fatal — flow still works without the visual */ }
          }
        }

        // Reset content for next iteration
        runState.content = ''
        runState.thinking = ''
      }

      // Fallback summary — parity with useCodex.ts. When the model's
      // last turn returned empty (it claimed completion in an earlier
      // intermediate turn, ran tools, then emitted nothing on the
      // wrap-up), the assistant message would otherwise stay empty and
      // leave the user looking at a chat with reflection blocks +
      // tool-call rows but no closing line. Build a concise summary
      // from the actually-completed blocks so there is always a final
      // answer at the bottom of the bubble.
      // A stopped run gets the stop note in the finally instead: "rephrase, or
      // turn off Think" blamed the prompt for the user's own Stop.
      if (!runState.content.trim() && !abort.signal.aborted) {
        // Closing line when the model said nothing itself. Pure logic lives in
        // summarizeTurn so the D#81 rules (a failed picture is not a completed
        // task, and its reason gets shown) are locked by tests.
        // G27: the reconcile steers above have a budget of two; when it is
        // spent the run ends with the plan still open, and this line is the
        // last thing the user reads. It may not say "completed" while the
        // PlanBar next to it says otherwise. closingSummary carries that rule.
        runState.content = closingSummary()
      }

      // Final store update
      frames.close()
      useChatStore.getState().updateMessageContent(convId!, assistantMessage.id, runState.content)
      if (runState.thinking) {
        useChatStore.getState().updateMessageThinking(convId!, assistantMessage.id, runState.thinking)
      }

    } catch (err) {
      frames.close()
      if ((err as Error).name !== 'AbortError') {
        const errorMsg = errorText(err) || 'Connection failed'
        // Bug B3 round 2: a refusal that produced nothing at all (the model's
        // chat template raised, or the backend 400'd) gets its own English
        // sentence instead of the raw Jinja trace under an "Agent error" head.
        const sendRefusal = explainSendRefusal(err)

        if (cutByModelSwitch(convId)) {
          // The engine was taken away by the person's own pick of another
          // model (lib/model-switch-stop.ts). That is the reason, not a
          // backend that "may have crashed": what was written stays, with the
          // marker under it, and a run that had written nothing says so.
          useChatStore.getState().updateMessageFinishReason(convId!, assistantMessage.id, MODEL_SWITCH_FINISH)
          if (!runState.content.trim()) {
            useChatStore.getState().updateMessageContent(
              convId!, assistantMessage.id,
              emptyAnswerExplanation({ finishReason: MODEL_SWITCH_FINISH, captured: false, keepThinking: false }),
            )
          }
        } else if ((err as { code?: string })?.code === 'outage') {
          // LU Cloud has an outage the server announced (lib/cloud-outage.ts).
          // Its sentence instead of "Agent error: ...", and the loop stops:
          // the next round would fail the same way.
          loopHalt = 'LU Cloud outage'
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            (runState.content ? runState.content + '\n\n' : '') + errorMsg
          )
          // The server's sentence: no reader knows it by its wording (lib/logic-notes.ts).
          useChatStore.getState().updateMessageError(convId!, assistantMessage.id, { kind: 'generic', detail: errorMsg, at: runState.content.length })
        } else if (isMultimodalUnsupportedError(errorMsg)) {
          // N3: only a picture the USER attached earns this error. When the run
          // attached its own render and the model turned out unable to look at
          // it, the render still succeeded and is on screen, so the turn closes
          // with its normal summary instead of a red line under a finished
          // image (D1 counter-check, Windows build 2026-08-29).
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            reportMultimodalRefusal(visionFeedbackGiven)
              ? MULTIMODAL_UNSUPPORTED_MESSAGE
              : (runState.content.trim() || closingSummary())
          )
        } else if ((err as { code?: string })?.code === 'tools_unsupported' || errorMsg.includes('does not support tools')) {
          // G26: record the refusal so the layered resolution (toolStrategyFor)
          // routes the NEXT run through the prompt transport on a local
          // provider. Only LU Cloud is terminal here: the server already does
          // its own prompt translation, so its `false` means never.
          markToolsUnsupported(modelToUse)
          const hasPromptFallback = getProviderIdFromModel(activeModel) !== 'lu-cloud'
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            hasPromptFallback
              ? platformText('agentToolTransportSwitched')
              : platformText('agentNoToolSupport')
          )
        } else if (errorMsg.includes('does not support thinking')) {
          // Graceful message for thinking errors (shouldn't reach here after retry, but just in case)
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            `This model does not support thinking mode. Disable the Think button or switch to a compatible model (Qwen 3, DeepSeek-R1, Gemma 4).`
          )
        } else if ((err as { code?: string })?.code === 'credits_exhausted') {
          loopHalt = 'out of credits'
          // No retry fixes an empty wallet, and on a long run this line is the
          // only thing left on screen once the dialog is dismissed. Name where
          // the plan stopped, so "it froze" reads as "it was refused" (Morgan,
          // 2026-08-10), and say how to resume without paying twice.
          const todos = useTodoStore.getState().getTodos(convId!)
          const done = todos.filter((t) => t.status === 'completed').length
          const planLine = todos.length
            ? `\n\nThe plan stopped at ${done} of ${todos.length}. Everything finished so far stays in this chat. Once you top up, send a new message naming only what is still left, rather than the original prompt, so the finished steps are not paid for twice.`
            : ''
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            (runState.content ? runState.content + '\n\n' : '') + CREDITS_EXHAUSTED_MESSAGE + planLine
          )
        } else if ((err as { code?: string })?.code === 'signed_out'
          || (httpStatusOf(err) === 401 && (err as { provider?: string })?.provider === 'lu-cloud')) {
          // The retries above already re-minted the token twice, so reaching
          // here means the session is really gone, not merely aged out. Before
          // this branch existed the run ended on "Agent error: unauthenticated"
          // or, on an opaque body, "Invalid API key for LU Cloud. Check
          // Settings > Providers." for a provider that has no API key field.
          loopHalt = 'signed out of LU Cloud'
          const todos = useTodoStore.getState().getTodos(convId!)
          const done = todos.filter((t) => t.status === 'completed').length
          const planLine = todos.length
            ? `\n\nThe plan stopped at ${done} of ${todos.length}. Everything finished so far stays in this chat. After signing in, send a new message naming only what is still left, rather than the original prompt.`
            : ''
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            (runState.content ? runState.content + '\n\n' : '') +
            platformText('cloudSessionEndedMidRun') + planLine
          )
        } else if (httpStatusOf(err) === 429) {
          // Reaching here means the wait above was already honoured and the
          // window still had not cleared. The server's sentence is shown word
          // for word, because only the server knows whose limit it was and
          // how long it lasts; without one the app's own sentence names the
          // wait and nothing else (lib/request-limit.ts).
          // No loopHalt on purpose: a throttle passes, unlike an empty wallet,
          // and killing a long /loop over one busy minute would be worse than
          // letting its next round wait its turn.
          const limitText = requestLimitMessageOf(err, { nothingCharged: getProviderIdFromModel(activeModel) === 'lu-cloud' })
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            (runState.content ? runState.content + '\n\n' : '') + limitText
          )
          // The server's sentence has no wording a reader could know it by, so
          // the field says what it is and where the answer ends. The desktop
          // bubble does not read the field; the phone draws its box from it.
          useChatStore.getState().updateMessageError(
            convId!, assistantMessage.id,
            { kind: 'limit', detail: limitText, at: runState.content.length },
          )
        } else if ((err as { code?: string })?.code === 'flash_timeout') {
          // R5-53: isTerminalModelError now stops this from being retried at
          // all, so this branch is reached after exactly one attempt, not
          // three. The server's own line already says exactly what happened
          // ("reached its four-minute limit"), so it is left standing.
          loopHalt = 'flash timeout'
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            (runState.content ? runState.content + '\n\n' : '') + errorMsg
          )
        } else if (sendRefusal) {
          // Bug B3 round 2, nebenbefund 3: a chat-tools turn in PLAIN chat
          // runs through this same executor, so the template's own Jinja
          // stack trace used to reach the user under the heading "Agent
          // error" with Agent mode switched off. It is neither the agent's
          // failure nor a sentence anyone can act on.
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            (runState.content ? runState.content + '\n\n' : '') + sendRefusal,
          )
        } else if (/failed to fetch|connection refused|connection reset|error sending request|proxy_localhost|network ?error|timed out|timeout|tcp connect|llama runner process|backend unreachable|HTTP 5\d\d/i.test(errorMsg)) {
          // Connection-class failure — after the transient retries above this
          // means the backend really dropped mid-run (crashed, was killed, or
          // is busy swapping models). A bare "Agent error: Connection failed"
          // gave users nothing to act on (Discord 2026-06-10, Win11).
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            (runState.content ? runState.content + '\n\n' : '') +
            platformText('agentBackendLost', { details: errorMsg })
          )
        } else {
          useChatStore.getState().updateMessageContent(
            convId!, assistantMessage.id,
            runState.content + '\n\nAgent error: ' + errorMsg
          )
        }
      }
    } finally {
      // Identity check (B2): only clean up if this run still OWNS the slot.
      // stopAgent() can already have deleted and even replaced it (Stop, then
      // an immediate resend on the same conversation) by the time this
      // finally runs. Blocker 2 (review-lanes.md): the three neighbouring
      // cleanup calls below used to run unconditionally, so run A's delayed
      // finally would clear run B's aborter, flip B's generating flag back
      // to false, and reject B's pending approvals, leaving the NEW run
      // unstoppable through generationStore (Stop button, sign-out, window
      // close, app quit) even though activeAgentRuns still pointed at it.
      // A Stop before anything was written leaves a line, not an empty bubble.
      // Discord 2026-09-28: a file outside the chat's folder was
      // refused in a collapsed tool block, and the model alone was left to
      // explain it. The user gets the way out above the chat, whatever the
      // model makes of the refusal (lib/workspace-refusal.ts). Only when the
      // run did not fix it itself: a model that retried inside its folder
      // and succeeded left a "then ask again" over a finished task
      // (Gegenprobe 01.10.2026). file_edit returns its refusal as text, and
      // only applyResultToToolCall turned that into the failure read here.
      const steps = runState.blocks.flatMap((b) => (b.phase === 'tool_call' && b.toolCall ? [b.toolCall] : []))
      // Only over the conversation it is about: a run that ends after the user
      // moved on does not put its line over another chat.
      if (hasUnrecoveredOutsideRefusal(steps) && useChatStore.getState().activeConversationId === convId) {
        useChatNoticeStore.getState().show('agent-outside-workspace', OUTSIDE_WORKSPACE_NOTICE)
      }
      if (abort.signal.aborted || isRunStopped(convId)) noteStoppedIfEmpty(convId, assistantMessage.id)
      const stillOwnsSlot = activeAgentRuns.get(convId) === runState
      if (stillOwnsSlot) {
        useGenerationStore.getState().clearAborter(convId)
        activeAgentRuns.delete(convId)
      }
      // Die Werkzeugkette als versteckte Nachrichten ablegen, VOR der
      // Assistentenantwort. Im finally, nicht am Ende des Erfolgswegs: ein Lauf,
      // der mit einem Fehler oder Abbruch endete, verlor sonst seine ganze Kette,
      // und "continue" fing von vorn an (Kundenfall a user, 30.09.2026).
      // Genau wie useCodex (dieselbe Deckelung und
      // derselbe Waisenschnitt aus hooks/codex/hidden-history.ts: ein Fenster,
      // das mit einem Ergebnis ohne seinen Aufruf beginnt, laesst strenge
      // Anbieter mit 422 antworten). Ohne das hier sah die naechste Runde nur
      // noch den Antworttext und holte dieselbe Seite ein zweites Mal.
      if (werkzeugKette.length > 0 && convId) {
        const kette = capHiddenToolHistory(werkzeugKette)
        const store = useChatStore.getState()
        const convNow = store.conversations.find((c) => c.id === convId)
        const idx = convNow?.messages.findIndex((m) => m.id === assistantMessage.id) ?? -1
        if (kette.length > 0 && idx > 0) {
          store.insertMessagesBefore(convId, assistantMessage.id, kette.map((tm) => ({
            id: uuid(),
            role: tm.role as import('../types/chat').Message['role'],
            content: tm.content || '',
            timestamp: Date.now(),
            hidden: true,
            ...(tm.tool_calls ? { tool_calls: tm.tool_calls as import('../types/chat').Message['tool_calls'] } : {}),
            ...(tm.tool_call_id ? { tool_call_id: tm.tool_call_id } : {}),
          })))
        }
      }

      // Chat-tools artifact mode: attach any files the model "wrote" (captured
      // in-memory, NOT on disk) to the assistant message so they render inline
      // with a preview + Download button. takeChatArtifacts drains this run's
      // buffer; endAgentRun() then closes the run context.
      const capturedArtifacts = takeChatArtifacts(run)
      if (capturedArtifacts.length) {
        useChatStore.getState().updateMessageArtifacts(
          convId!, assistantMessage.id,
          capturedArtifacts.map((a) => ({ id: uuid(), name: a.name, content: a.content, mime: a.mime })),
        )
      }
      // The run is done, including the artifacts attached just above, so it
      // goes on disk — and only THEN does the app report the run finished.
      // Persistence is coalesced while the run streams (2.6.3 — see
      // coalescedStorage); an agent turn is long and its blocks are big, so
      // this is where the result becomes durable. Same contract as Chat and
      // Code; stores/durability.ts carries the measurement, including why the
      // call stays in the statement the old `void flushChatPersist()` occupied
      // rather than moving to the bottom of the block.
      await endTurnDurably(() => {
        // "true" means "at least one conversation has a run in flight" (see
        // the claim above), false only once THIS was the last one, so a
        // still-running conversation B does not lose its Stop button just
        // because conversation A's turn ended first.
        setIsAgentRunning(activeAgentRuns.size > 0)
        if (stillOwnsSlot) {
          useGenerationStore.getState().setGenerating(convId, false)
        }
      })
      // Drop the per-run workspace scope so standalone tool calls from
      // other tabs don't accidentally land in this chat's folder. Only when
      // this run still owns the shared mirror, so a Coding run that outlives
      // us keeps its own jail root (plan C1 ERZWINGUNG).
      endAgentRun(run)
      // Reject any pending approvals so their promises don't hang forever,
      // but only THIS run's: a replaced slot means a NEW run's approvals are
      // waiting under the same convId, and they must survive.
      if (stillOwnsSlot) {
        drainApprovals(convId, abort.signal)
      }
      // Last write of this run into its message is behind us: a background
      // job that ended meanwhile may now put its result in.
      runMessageEnded(assistantMessage.id)

      // Auto-read the finished response when the user opted in (#77). Default
      // OFF, additionally gated on ttsEnabled; getState() so this callback never
      // subscribes to the voice store's isSpeaking churn during playback.
      {
        const voice = useVoiceStore.getState()
        if (voice.ttsEnabled && voice.autoReadAloud && runState.content.trim()) {
          autoSpeak(convId!, assistantMessage.id)
        }
      }

      // Auto-extract memories (fire-and-forget). The shared extractor carries
      // the A7 cost policy: no silent lu-cloud call without the opt-in, then
      // the cheapest catalogue model, plus the every-3rd-turn rate limit the
      // agent loop never had.
      // Not for the hidden report after a Create run: that "question" is the
      // app talking, not the customer, and nothing in it is worth remembering.
      if (runState.content.trim() && convId && !(opts?.hiddenUser && opts.createTools)) {
        // A run that looked at the screen is remembered by the user's own
        // words only (lib/computer/memory-policy.ts).
        const pair = memoryPairForRun({
          user: userContent,
          assistant: runState.content,
          toolNames: runState.blocks.flatMap((b) => (b.toolCalls ?? (b.toolCall ? [b.toolCall] : [])).map((call) => call.toolName)),
          sourceKind: 'chat',
        })
        void extractMemoriesFromPair(pair.user, pair.assistant, convId, { scope: memoryScope, sourceKind: pair.sourceKind }).catch(() => {})
      }

      // ── /loop driver ───────────────────────────────────────────────────
      // Same driver as Code, because a loop that only worked in one of the two
      // agent surfaces is not a feature. No pass ceiling unless the user set
      // one: a loop someone asked to keep going keeps going until it says done
      // or they stop it. The loop bar above the composer is what keeps that
      // honest rather than invisible.
      if (opts?.loop && convId && !stillOwnsSlot) {
        // This run was replaced (Stop, then an immediate resend on the same
        // conversation) before its own finally ran. The NEW run owns convId
        // now; scheduling or clearing the /loop driver on its behalf would
        // be this same finally-runs-late class of bug from Blocker 2, just
        // aimed at the loop timer instead of the generation store.
      } else if (opts?.loop && convId && loopHalt) {
        // Same rule as the coding surface: no retry fixes an empty wallet, so
        // the loop ends here instead of refiring into the same refusal.
        useAgentLoopStore.getState().clear(convId)
        useChatStore.getState().addMessage(convId, {
          id: uuid(), role: 'assistant', timestamp: Date.now(),
          content: `The loop stopped because the run was ${loopHalt}. Start it again once that is sorted.`,
        })
      } else if (opts?.loop && convId && !isRunStopped(convId)) {
        const loopState = opts.loop
        const saidDone = loopPassSaysDone(runState.content.trim())
        const cap = Math.max(0, useSettingsStore.getState().settings.loopMaxPasses ?? 0)
        const nextPass = loopState.pass + 1

        if (saidDone) {
          useAgentLoopStore.getState().clear(convId)
        } else if (cap > 0 && nextPass > cap) {
          useAgentLoopStore.getState().clear(convId)
          useChatStore.getState().addMessage(convId, {
            id: uuid(), role: 'assistant', timestamp: Date.now(),
            content: `Stopped after ${cap} passes, which is the limit set in Settings. What is above is where it got to. Raise the limit or set it to unlimited to keep going.`,
          })
        } else {
          const convForLoop = convId
          useAgentLoopStore.getState().start({
            conversationId: convForLoop, pass: nextPass, cap,
            task: loopState.task, intervalMs: loopState.intervalMs,
            nextAt: Date.now() + loopState.intervalMs,
          })
          agentLoopTimers.set(convForLoop, setTimeout(() => {
            agentLoopTimers.delete(convForLoop)
            // Blocker 3 (review-lanes.md): stopAllBackgroundWork() (sign-out,
            // window close, app quit) clears the loop STORE via
            // useAgentLoopStore.clear, but this timer lives in a module Map
            // it never touches; clearTimeout only happens inside stopAgent.
            // Without this check, a pass whose interval elapses AFTER the
            // user signed out fired a real paid request into a session the
            // app had already told the user it ended. isRunStopped is the
            // same sticky per-conversation flag stopAllBackgroundWork sets
            // via stopRun(), so it is exactly what survives here.
            if (isRunStopped(convForLoop)) {
              useAgentLoopStore.getState().clear(convForLoop)
              return
            }
            // A skipped pass clears the loop store too (audit A3) — leaving
            // it standing painted a LoopBar promising a pass that never came.
            //
            // B2 NEUER FUND: this used to read a single hook-wide running
            // flag, so a run in an UNRELATED conversation B left
            // standing at this instant made conversation A's own due pass
            // look "still running" and skip it, while a genuinely still-
            // running A could (once B finished first) fire a pass on top of
            // itself. Keyed to `convForLoop` now, so only A's own run in
            // flight skips A's own pass.
            if (activeAgentRuns.has(convForLoop)) {
              useAgentLoopStore.getState().clear(convForLoop)
              return
            }
            if (useChatStore.getState().activeConversationId !== convForLoop) {
              useAgentLoopStore.getState().clear(convForLoop)
              return
            }
            // A pass that ends before it reaches this driver must not leave
            // the bar "running" (GH #140, same gap as the Code view's).
            void endLoopUnlessRearmed(
              convForLoop,
              sendRef.current?.(buildLoopRecheck(loopState.task, nextPass), undefined, {
                displayContent: cap > 0 ? `pass ${nextPass} of ${cap}` : `pass ${nextPass}`,
                loop: { ...loopState, pass: nextPass },
              }),
              () => agentLoopTimers.has(convForLoop),
            )
          }, loopState.intervalMs))
        }
      }
    }
      },
    )
    if (laneOutcome === 'cancelled-while-queued' && activeAgentRuns.get(convId) === runState) {
      // Stop pulled this run out of the local lane's waiting room before its
      // own finally ever ran (that finally lives inside the body above), so
      // the guard this call claimed synchronously at the top has to be freed
      // here instead. Nothing else needs undoing: the body never started, so
      // it never added a message, registered its own aborter, or booked a
      // loop timer.
      activeAgentRuns.delete(convId)
      setIsAgentRunning(activeAgentRuns.size > 0)
    }
  }, [])

  // Self-reference so the /loop driver can start the next pass.
  const sendRef = useRef<typeof sendAgentMessage | null>(null)
  sendRef.current = sendAgentMessage

  // ── Stop the agent ────────────────────────────────────────────

  const stopAgent = useCallback((conversationId?: string | null) => {
    // Stop means stop: also cancel a /loop pass waiting out its interval,
    // otherwise the run the user just killed comes back by itself. Recorded per
    // CONVERSATION so the finally of a pass started by a previous hook instance
    // (the chat view unmounts on a view switch) sees it too, and so the flag is
    // cleared again by the next real instruction instead of standing for the
    // rest of the session.
    //
    // B2 Commit 5: the caller NAMES the run it means to stop instead of this
    // function re-reading "whichever conversation happens to be visible
    // right now", the visible one is only ever correct because today's one
    // caller (useChat.ts's stopGeneration) already resolved it that way. A
    // future caller that stops a run the user is NOT looking at (a per-item
    // Stop in a task list, say) would otherwise silently stop the wrong one.
    // Only a real id counts: handed to an onClick as is, this got the click
    // event as the id and stopped nothing (GH #140, the Code view's copy).
    const stoppedConvId = typeof conversationId === 'string' || conversationId === null
      ? conversationId
      : useChatStore.getState().activeConversationId
    stopRun(stoppedConvId)
    // B1 (3.0.1, Orchestrator-Entscheid): "Stop means stop" gilt auch fuer
    // Hintergrundauftraege dieser Unterhaltung, die per delegate_task
    // background gestartet wurden. Vorher endete Stop nur die Hauptantwort,
    // ein laufender Unteragent kostete unbemerkt weiter Rechenzeit, bis er von
    // selbst fertig wurde. cancelAll bricht jeden `running`-Eintrag dieser
    // Unterhaltung ab (siehe agentTaskStore.ts), derselbe Griff wie der
    // "Stop all"-Knopf im Aufgabenpanel.
    useAgentTaskStore.getState().cancelAll(stoppedConvId ?? '')
    // Nur DIESER Unterhaltung Zeitgeber - ein Stop in B darf den wartenden
    // Pass von A nicht treffen (B2 Commit 4, derselbe Fehler wie beim
    // vorherigen einzelnen `agentLoopTimer`, nur beim Zeitgeber statt beim
    // Store).
    const pendingLoopTimer = agentLoopTimers.get(stoppedConvId ?? '')
    if (pendingLoopTimer) {
      clearTimeout(pendingLoopTimer)
      agentLoopTimers.delete(stoppedConvId ?? '')
    }
    useAgentLoopStore.getState().clear(stoppedConvId ?? '')
    // NUR den eigenen Lauf. B2 NEUER FUND: `activeAgentRuns` ist jetzt je
    // Unterhaltung gefuehrt (vorher zwei Refs plus ein Flag, Eigentum der
    // Hook-Instanz, nicht der Unterhaltung); ohne den `.get()` auf genau
    // `stoppedConvId` wuerde Stop in einer zweiten Unterhaltung den
    // Agentenlauf der ersten treffen (T1 Punkt 4). Laeuft der Agent woanders,
    // hat `stopRun` oben den Stopp fuer DIESE Unterhaltung vermerkt und mehr
    // ist hier nicht zu tun.
    const runToStop = stoppedConvId ? activeAgentRuns.get(stoppedConvId) : undefined
    if (runToStop) {
      runToStop.abort.abort()
      activeAgentRuns.delete(stoppedConvId!)
      setIsAgentRunning(activeAgentRuns.size > 0)
    }
    // Interrupt any in-flight ComfyUI gen too — the main Stop button only aborted
    // the agent loop before, so a running image/video kept burning unless the user
    // happened to click the small in-chat tool Stop. Now both Stops agree.
    // Scoped to stoppedConvId (Blocker 4, review-lanes.md): a bare call used
    // to cancel whichever generation happened to be running app-wide, so a
    // Stop in conversation B killed conversation A's still-producing
    // image/video.
    requestGenerationCancel(stoppedConvId)
    drainApprovals(stoppedConvId)
  }, [])

  return {
    sendAgentMessage,
    stopAgent,
    approveToolCall,
    rejectToolCall,
    isAgentRunning,
    pendingApproval,
  }
}

// ── Agent System Prompt Builder ─────────────────────────────────

/**
 * Turn a user request like "mach mir ein bild von einem hund" into a clean
 * generation prompt ("einem hund") by stripping the leading command phrase
 * (DE + EN). Used by the dud-turn media fallback when a weak model can't emit
 * the tool call itself. Falls back to the full text if nothing strips.
 */
/**
 * Detects a model "pretending" to generate media in plain prose without ever
 * calling the tool (2026-06-20: gemma4 wrote "(Generating 2-second
 * zoom-in video…)", "the video has been successfully generated", "I am
 * initiating the generation process" — and produced nothing). Only consulted on
 * a final, tool-call-less turn where media is still pending, so legitimate
 * mid-loop narration (which precedes a real tool call) is never affected.
 */
export const FAKE_MEDIA_GEN_RE =
  /\b(generating|regenerat\w*|i('|\s+a)m\s+(now\s+)?(generating|creating|initiat\w*)|i\s+(will|have)\s+(now\s+)?(re)?generat\w*|i\s+am\s+initiat\w*|video\s+generation|image\s+generation|in\s+progress|has\s+been\s+(successfully\s+)?(generated|created|regenerated)|wird\s+(gerade\s+)?(erstellt|generiert)|generiere\s+(jetzt|das|es)|in\s+arbeit)\b|\(\s*(generat|re-?generat|video\s+generat|image\s+generat)/i

export function extractMediaPrompt(text: string): string {
  const p = String(text || '').trim()
  const stripped = p.replace(
    /^(bitte\s+)?(mach(e|st)?|erstell(e)?|generier(e)?|zeichne|mal(e|en)?|create|make|draw|generate|gib\s+mir|show\s+me|zeig(e)?\s+mir)\s+(mir\s+)?(ein(e|en)?\s+)?(bild(er)?|foto|image|picture|pic|video|clip|grafik|illustration|animation)\s*(von|of|mit|with|from|über|about)?\s*/i,
    '',
  ).trim()
  return stripped || p
}

export function buildAgentSystemPrompt(basePrompt: string, roster: string): string {
  // A phone gets its own text: no computer, no shell, no media tools.
  if (isMobile()) return buildMobileAgentSystemPrompt(basePrompt, roster)
  const agentInstructions = `You are an autonomous AI agent inside LU with full access to this computer. You execute tasks end-to-end by using tools, you do NOT just describe what to do.

${platformPromptLine()}

Available tools:
${roster}

That list is what LU can do. Your request carries the subset that fits the task at hand, and on a local model it is a subset. Only ever call a tool that is in your tool list. Calling one that is not there fails as an unknown tool and wastes a step. If you need one that is missing, name it in your answer and carry on with what you have.

WORK IN BATCHES (every step resends the whole conversation and costs the user money):
- Put independent tool calls into ONE response: several reads, searches or edits at once.
- Never spend a step on bookkeeping alone. If a todo_write tool is offered, send the updated list together with your next real tool call.

AUTONOMY CONTRACT (read carefully, this is the most important rule):
- When the user asks you to BUILD, CREATE, MAKE, or WRITE something (a file, a website, a script, a folder structure), you MUST execute it via tools, typically file_write.
- NEVER produce a code block in your reply followed by "save this as index.html". That is a FAILURE, it means you talked instead of acted.
- NEVER say "Now I will create X" or "Next I'll write Y" as plain prose and then stop. The model is supposed to DO the next step right now, as a tool call.
- When the task has N steps, execute ALL N as tool calls in one session. The user does not want a tutorial, they want the result on disk.
- The ONLY reasons to finish without calling another tool are: (a) the task is genuinely complete, or (b) you are stuck and need user input.

Workflow for build / create tasks:
1. (Optional) file_list to scout the target directory.
2. file_write the artefact(s) directly. For a website: write index.html, style.css, script.js as separate file_write calls.
3. After the LAST file_write, write a 1 to 3 sentence final answer ("Done — wrote 3 files to <path>"). Nothing in between.

Creative tools, image_generate, video_generate:
- When the user asks for an image / picture / drawing, CALL image_generate. You HAVE this tool, do NOT reply with prose about DALL-E, Midjourney, or "as a text model I can't". Just call it.
- After image_generate runs you will be shown the generated image; LOOK at it and briefly describe what you actually see.
- To make a video, CALL video_generate. To animate an image you just generated, call video_generate with inputImage set to that image's filename (it is in the image_generate result).
- Emit these as REAL tool calls through the tool channel — never write the call as plain text like image_generate(prompt="…") in your answer.

Other rules:
- You MUST use tools — NEVER answer from memory or guess file contents.
- To CHANGE part of an existing file use file_edit (replace a UNIQUE old_string with new_string), never file_write: rewriting a large file to change three lines truncates it and costs a fortune in tokens. file_write is for creating a new file or fully replacing one.
- PATHS: use paths relative to your working directory (e.g. \`package.json\`, \`src/app.ts\`, \`.\` for the current folder). Never start a path with \`/\` or a drive letter (\`C:\\\`), that escapes your workspace and fails. To list the current folder, use file_list with path \`.\`.
- For filesystem READ tasks: file_list first if needed, then file_read.
- For web tasks: web_search → web_fetch on the best URL → answer based on real data. web_search returns ONLY short snippets, ALWAYS call web_fetch to read the page.
- OS, clock and timezone are stated in this prompt (platform up top, clock at the very end, where a volatile line cannot spoil the prompt cache), so do not spend a call finding them out. For hardware details or running processes, use shell_execute (macOS/Linux: \`uname -a\`, \`ps aux\`; Windows: \`Get-ComputerInfo\`, \`Get-Process\`).
- Chain multiple tools as needed. If a tool fails, try a different approach.
- Be concise in text. All the work happens in tool calls.
- Respond in the same language the user uses.`

  if (basePrompt) {
    return `${agentInstructions}\n\n${basePrompt}`
  }
  return agentInstructions
}

// Small-Model Mode (Knob 2): a lean agent prompt (~750 chars vs ~3000 above)
// for 3B-8B models. Long prompts + big tool catalogs measurably degrade
// small-model tool-calling (LongFuncEval, arXiv 2505.10570) and small models
// have a limited instruction-following budget. Keep only what a small model
// needs to ACT — same tool names + native call format as the full prompt.
export function buildAgentSystemPromptLean(basePrompt: string, alwaysThere: string): string {
  if (isMobile()) return buildMobileAgentSystemPromptLean(basePrompt, alwaysThere)
  const lean = `You are an autonomous agent in LU with tools on this computer. Do tasks by CALLING tools, do not just describe them.

${platformPromptLine()}

You always have: ${alwaysThere}. Your request carries the other tools that fit the task. Read their names there, do not guess.

Rules:
- Put independent tool calls into one response (several reads or edits at once). Every step costs the user money.
- To build/create/write something, CALL the tool (usually file_write), never paste a code block and say "save this".
- To change an existing file use file_edit with a unique old_string, not file_write.
- PATHS: use relative paths (e.g. \`package.json\`, \`.\`). Never start with \`/\` or a drive letter, it escapes your workspace and fails.
- Emit the tool call as your FIRST output, no "Okay, let me…" preamble. Valid JSON. Never guess file contents, file_read first.
- After each tool result, if a step remains, immediately call the next tool. Do not narrate "I will now…" and then stop.
- For images/video call image_generate / video_generate as real tool calls.
- When everything is done, reply with one short sentence in the user's language.`
  return basePrompt ? `${lean}\n\n${basePrompt}` : lean
}

/**
 * Chat-Tools prompt (2026-06-11). Plain chat with a curated 5-tool set:
 * the model stays a normal conversational assistant but CAN reach for a tool
 * when the user actually needs one. Deliberately NOT the autonomous-agent
 * "you MUST use tools / execute end-to-end" prompt — that would turn ordinary
 * chat into an agent. Kept short so it doesn't crowd a small model's context.
 */
export function buildChatToolsSystemPrompt(
  basePrompt: string,
  /** Both only with Create in chat on. `media: false`: Create makes images and
   *  clips in this turn, the two local tools are not offered. `tools: false`:
   *  the turn carries only the Create tools, whose paragraph is appended
   *  separately. */
  opts: { media?: boolean; tools?: boolean } = {},
): string {
  if (opts.tools === false) {
    const plain = 'You are a helpful chat assistant in LU, having a normal conversation. Reply in the user\'s language.'
    return basePrompt ? `${plain}\n\n${basePrompt}` : plain
  }
  // A phone has its own wording and never carries the two local media tools
  // (lib/mobile-tools.ts), so `media` changes nothing there.
  if (isMobile()) return buildMobileChatToolsSystemPrompt(basePrompt)
  const media = opts.media === false ? '' : `
- image_generate, create an image when the user asks for a picture/drawing/logo
- video_generate, create a short video/animation when the user asks for one (to animate an image you just made, pass its filename as inputImage)`
  const example = opts.media === false ? 'web_search("…")' : 'image_generate("…")'
  const p = `You are a helpful chat assistant in LU, having a normal conversation. You also have a few tools for things you cannot do from memory, use one ONLY when the user's request actually needs it, otherwise just reply normally:
- web_search, look up current/real-world facts (returns short snippets)
- web_fetch, read a specific web page or URL (after a search, or when the user gives a link)
- file_write, save text to a file when the user asks you to write/create/save a file${media}

Emit tool calls through the real tool channel, never as plain text like ${example}. After a tool runs, give a short, natural reply about the result. For web questions, prefer web_search then web_fetch on the best result before answering. Reply in the user's language.`
  return basePrompt ? `${p}\n\n${basePrompt}` : p
}
