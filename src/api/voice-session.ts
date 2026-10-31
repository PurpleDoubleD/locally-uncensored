// One voice session, from the Start click to Stop.
//
// The order of a start is fixed by what each step needs:
//
//   1. Microphone and audio context, synchronously inside the click. WebKit
//      only hands out both while the click is still fresh. From here on the
//      user can talk: what is said before step 4 is held and sent with it.
//   2. The voice loop process. Cold, it loads its speech models first.
//   3. The brain: the selected chat model, resolved through the provider
//      system, plus the tools and permissions the agent chat would use.
//   4. The connection: one request with the session configuration, then the
//      WebSocket the audio and the events travel on.
//
// A session is never resumed. The ticket for the WebSocket works once, so
// when a connection drops the session ends with an error and the user starts
// a new one. The launch token and a provider key exist only in local
// variables of `start()` and in the one request to the voice loop.

import { LogLevel, PipecatClient, RTVIEvent } from '@pipecat-ai/client-js'
import { SELF_GATED_TOOLS } from '../lib/agent-approval-policy'
import { withComputerUsePrompt } from '../lib/computer/prompt'
import { WebSocketTransport } from '@pipecat-ai/websocket-transport'
import { beginAgentRun, endAgentRun, renderWorkspaceSection } from './agent-context'
import type { AgentRunContext } from './agent-context'
import { resolveWorkspace } from './agents/workspace-resolve'
import { toolRegistry } from './mcp'
import { isSettingsToolName } from '../lib/settings-tool-names'
import type { MCPToolDefinition } from './mcp/types'
import { resolveVoiceBrain, describeVoiceBrain, takesTheEngineFrom, VoiceBrainError } from './voice-brain'
import type { VoiceBrain } from './voice-brain'
import { VoiceHistory, voiceModelRecord } from './voice-history'
import { getVoiceLoopStatus, startVoiceLoop, stopVoiceLoop } from './voice-loop'
import { listRunningModels, unloadModel } from './ollama'
import { getProviderForModel, getProviderIdFromModel, isOpenAISlotModel } from './providers'
import type { VoiceLoopSession } from './voice-loop'
import { SIGNED_OUT_MESSAGE, cloudKeyStep } from '../lib/voice/cloud-key'
import { getAccessToken } from './cloud/supabase'
import { noteUserAskedAgain } from './computer-use'
import { announceComputerControl, endScreenWorkOutOfScope, voiceAnswered, voiceSaidStop } from './voice-computer'
import { AnswerGate } from '../lib/voice/answer-gate'
import { TASK_TIME_LIMIT_MS } from './computer-task'
import { COMPUTER_TASK_TOOL_NAME } from '../lib/computer/prompt'
import { COMPUTER_TASK_TOOL } from './computer-task'
import { backendCall, isTauri } from './backend'
import { voiceSessionSpeech } from './voice-speech'
import { rememberedFolderRefusal } from './agents/workspace-validate'
import { levelInScope, scopePromptLine, scopeRefusal, thinkingBudgetStep, toolInScope } from '../lib/voice/work-scope'
import type { VoiceWork } from '../lib/voice/work-scope'
import type { AgentWorkspace } from '../types/agent-workspace'
import { spokenCommand } from '../lib/voice/commands'
import { HeardUtterances } from '../lib/voice/heard-utterances'
import { readLoopError } from '../lib/voice/loop-errors'
import { voiceContextLimit, voiceToolSet } from '../lib/voice/tool-set'
import { useComputerStore } from '../stores/computerStore'
import { LuVoiceMediaManager, VoiceMicError } from './voice-media'
import { listMicrophones, onMicrophoneChosen } from './microphone'
import { VoiceToolBridge, voiceToolLevel } from './voice-tool-bridge'
import type { VoiceToolEvent, VoiceToolPermissions } from './voice-tool-bridge'
import { resolveChatWorkspaceSlug } from './workspace-slug'
import { getModelMaxTokens } from '../lib/context-compaction'
import { detailOf } from '../lib/error-text'
import { log } from '../lib/logger'
import { resolveExecutor } from './computer-executor'
import { gatePlanTool, planToolAllowed } from '../lib/plan-gate'
import { buildChatSystemPrompt } from '../lib/system-prompt'
import { withChatPersona } from '../lib/chat-persona'
import { applyMaxTools, toolSelectionOpts } from '../lib/tool-selection'
import { yieldSilentRunsTo } from '../lib/silent-runs-yield'
import { startTimeout } from '../lib/voice/session-state'
import type { VoiceError, VoiceEvent, VoiceStartStep } from '../lib/voice/session-state'
import { buildVoiceSystemPrompt } from '../lib/voice/voice-prompt'
import { useChatStore } from '../stores/chatStore'
import { useMemoryStore } from '../stores/memoryStore'
import { useModelStore } from '../stores/modelStore'
import { usePermissionStore } from '../stores/permissionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { createVoiceLoopStore } from '../stores/voiceLoopStore'
import { useVoiceSessionStore } from '../stores/voiceSessionStore'
import { useVoiceStore } from '../stores/voiceStore'
import { useProviderStore } from '../stores/providerStore'

/** The voice loop accepts tool names of this shape only. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,100}$/
/** The voice loop's own ceiling, with room for the cancel tools it adds. */
const MAX_VOICE_TOOLS = 60
/** How long one tool may take, including the wait for an approval. */
const TOOL_TIMEOUT_MS = 300_000
/** The voice of an engine that names none (an older build of the engine). */
const DEFAULT_VOICE = 'alba'
/** A screen task has its own time limit; the tool call around it gets a little more. */
const TASK_TOOL_TIMEOUT_MS = TASK_TIME_LIMIT_MS + 60_000
/** An answer to "Whole computer" that takes longer than this is the user being asked in a window of the system. */
const ASKING_AFTER_MS = 400
/** How long a start waits for a local model to read its instructions. */
const WARM_WAIT_MS = 60_000
/** How often a cloud session looks whether its sign-in was renewed. */
const KEY_CHECK_MS = 60_000
/**
 * The voice engine stays loaded after Stop, so the next Start is instant.
 * Nobody starting again for this long, and it is shut down: it holds about a
 * gigabyte of speech models in memory.
 */
export const VOICE_ENGINE_IDLE_MS = 5 * 60 * 1000

export const NO_TOOLS_NOTICE = 'This model cannot use tools, so this session is conversation only.'
export const AGENT_OFF_NOTICE = 'The agent is off, so this session talks and looks things up on the web, without files, commands or the screen.'
export const WHOLE_COMPUTER_DECLINED_NOTICE = 'Files stay in the workspace folder: the whole computer was not allowed.'
export const WHOLE_COMPUTER_APP_ONLY_NOTICE = 'Files stay in the workspace folder: the whole computer needs the desktop app.'

interface ActiveSession {
  media: LuVoiceMediaManager
  abort: AbortController
  client: PipecatClient | null
  bridge: VoiceToolBridge | null
  history: VoiceHistory | null
  run: AgentRunContext | null
  timer: ReturnType<typeof setTimeout> | null
  /** Kept only to strike it from an error text before that text is shown. */
  secret: string | null
  ended: boolean
  /** Things to undo when the session ends: store subscriptions, timers. */
  cleanup: Array<() => void>
  /** Resolved by the voice loop's report that the model read its instructions. */
  warmed: (() => void) | null
  startedAt: number
  /** When the session went live, null while it is still starting. */
  liveAt: number | null
  /** What the switches of the surface need to act on a running session. */
  work: SessionWork | null
}

/**
 * What a change of the switches at the top of the surface (Agent, Where it
 * may work, Thinking) needs while a session runs: the brain, every tool the
 * voice loop knows, and the parts the instructions are built from.
 */
interface SessionWork {
  brain: VoiceBrain
  /** Every tool the voice loop registered at the start. The model sees a selection. */
  all: MCPToolDefinition[]
  /** The id of the session's folder under the app's workspace directory. */
  slug: string
  prompt: { base: string; memory: string }
  /** The session's files may leave the workspace right now. */
  wholeComputer: boolean
  /** Why files stay in the folder although "Whole computer" is chosen. */
  filesNote: string | null
}

let active: ActiveSession | null = null
let idleStop: ReturnType<typeof setTimeout> | null = null
/** The voice engine is being shut down right now. A start waits for that. */
let engineStopping: Promise<void> | null = null

/**
 * The chat model a voice session loaded, when it was not loaded before. Only
 * that model is unloaded with Voice: a model the chat had in memory already
 * is the chat's, and taking it away would make the next message wait.
 */
type LoadedForVoice = { kind: 'ollama'; model: string } | { kind: 'engine' }
let loadedForVoice: LoadedForVoice | null = null

/** Whether the next unload takes a chat model with it. */
export function voiceLoadedChatModel(): boolean {
  return loadedForVoice !== null
}

/** Look at what is in memory before a session touches the model. Never throws. */
async function noteModelBeforeSession(activeModel: string | null): Promise<void> {
  if (!activeModel || loadedForVoice) return
  try {
    const providerId = getProviderIdFromModel(activeModel)
    if (providerId === 'ollama') {
      const { modelId } = getProviderForModel(activeModel)
      const running = await listRunningModels()
      if (!running.includes(modelId)) loadedForVoice = { kind: 'ollama', model: modelId }
    } else if (isOpenAISlotModel(activeModel) && useProviderStore.getState().providers.openai.managed === true && isTauri()) {
      const status = await backendCall<{ running?: boolean }>('bundled_engine_status')
      if (status?.running !== true) loadedForVoice = { kind: 'engine' }
    }
  } catch { /* unknown counts as "not ours": nothing is unloaded */ }
}

function cancelIdleStop(): void {
  if (idleStop) clearTimeout(idleStop)
  idleStop = null
}

/** Shut the voice engine down when nobody starts a session for a while. */
function scheduleIdleStop(): void {
  cancelIdleStop()
  idleStop = setTimeout(() => {
    idleStop = null
    if (active) return
    const stopping = stopVoiceLoop().then(() => undefined, () => undefined).finally(() => {
      if (engineStopping === stopping) engineStopping = null
    })
    engineStopping = stopping
  }, VOICE_ENGINE_IDLE_MS)
}

function dispatch(event: VoiceEvent): void {
  useVoiceSessionStore.getState().dispatch(event)
}

class SessionOver extends Error {}

function guard(session: ActiveSession): void {
  if (session.ended || session.abort.signal.aborted) throw new SessionOver()
}

/** Text from outside, cut to a line and without the session's credential. */
function safeDetail(text: unknown, secret: string | null): string {
  let detail = detailOf(text)
  if (secret) detail = detail.split(secret).join('[key]')
  detail = detail.replace(/\s+/g, ' ').trim()
  return detail.length > 300 ? `${detail.slice(0, 300)}...` : detail
}

function micError(error: VoiceMicError): VoiceError {
  switch (error.kind) {
    case 'denied':
      return { kind: 'microphone-denied', message: 'LU is not allowed to use the microphone.' }
    case 'missing':
      return { kind: 'microphone-missing', message: 'No microphone was found. Connect one and start again.' }
    case 'busy':
      return { kind: 'microphone-busy', message: 'The microphone could not be opened. Another app may be using it. Close that app and start again.' }
    default:
      return { kind: 'microphone-busy', message: error.message }
  }
}

function toError(error: unknown, secret: string | null): VoiceError {
  if (error instanceof VoiceMicError) return micError(error)
  if (error instanceof VoiceBrainError) {
    const kind = error.kind === 'no-model' ? 'no-model'
      : error.kind === 'unsupported-model' ? 'unsupported-model'
        : error.kind === 'signed-out' ? 'signed-out' : 'model-error'
    return { kind, message: safeDetail(error.message, secret) }
  }
  const detail = safeDetail(error, secret)
  return { kind: 'start-failed', message: detail || 'Voice did not start.' }
}

function teardown(session: ActiveSession): void {
  session.ended = true
  if (session.timer) clearTimeout(session.timer)
  session.timer = null
  session.abort.abort()
  for (const undo of session.cleanup.splice(0)) {
    try { undo() } catch { /* the session ends either way */ }
  }
  session.warmed?.()
  session.warmed = null
  session.bridge?.stop()
  // The files of this session are back in their folder, whatever it was allowed.
  if (session.work?.wholeComputer && isTauri()) {
    void backendCall('fs_whole_computer', { chatId: session.work.slug, on: false }).catch(() => {})
  }
  session.work = null
  session.history?.finish()
  endAgentRun(session.run)
  const client = session.client
  session.client = null
  // disconnect() closes the socket and, through the transport, the media
  // manager. Without a client the microphone still has to be released.
  if (client) void client.disconnect().catch(() => {}).finally(() => { void session.media.disconnect() })
  else void session.media.disconnect()
  session.secret = null
  if (active === session) active = null
  scheduleIdleStop()
}

/**
 * Every end of a session is in the log file with its reason and how long it
 * lasted. `log.info` would not do: in the app only warn and error reach the
 * file, and the build strips the console.
 */
function logEnd(session: ActiveSession, reason: string): void {
  const now = Date.now()
  log.event('voice.session_ended', {
    reason,
    sinceStartMs: now - session.startedAt,
    liveMs: session.liveAt === null ? null : now - session.liveAt,
  })
}

function fail(session: ActiveSession, error: VoiceError): void {
  if (session.ended) return
  logEnd(session, error.kind)
  teardown(session)
  dispatch({ type: 'failed', error })
}

async function publishMics(session: ActiveSession): Promise<void> {
  const mics = await listMicrophones()
  if (session.ended) return
  const selected = session.media.selectedMic
  dispatch({ type: 'mics', mics, micId: 'deviceId' in selected ? selected.deviceId || null : null })
}

/** A microphone picked while the session runs is the one it listens to from then on. */
async function switchMic(session: ActiveSession, deviceId: string): Promise<void> {
  try {
    await session.media.updateMic(deviceId)
    await publishMics(session)
  } catch (error) {
    fail(session, toError(error, session.secret))
  }
}

interface SessionTools {
  defs: MCPToolDefinition[]
  /** Tools that may wait for an approval. The voice loop keeps talking meanwhile. */
  longRunning: string[]
}

/** The switches at the top of the surface, as they stand right now. */
export function voiceWork(): VoiceWork {
  const prefs = useVoiceStore.getState()
  return { agent: prefs.loopAgent, scope: prefs.loopScope }
}

/** The folder a voice session works in: the one picked on the surface, else the default, else its own. */
function voiceWorkspace(): AgentWorkspace | null {
  return resolveWorkspace({
    perChat: useVoiceStore.getState().loopWorkspace ?? undefined,
    defaultWorkspace: useSettingsStore.getState().settings.defaultWorkspace,
  })
}

/**
 * Every tool this session may ever show the model, whatever the switches say
 * right now. The voice loop registers all of them once, and the switches pick
 * among them while the session runs (`shownTools`). The screen task is in it
 * even while computer control is off, so "Whole computer" can switch it on
 * without a new session; until then the tool is not in the app's catalog and
 * a call to it finds nothing to run.
 */
function selectTools(brain: VoiceBrain, conversationId: string, run: AgentRunContext, permissions: () => VoiceToolPermissions): SessionTools {
  if (!brain.toolsSupported) return { defs: [], longRunning: [] }
  const settings = useSettingsStore.getState().settings
  const categories = usePermissionStore.getState().getEffectivePermissions(conversationId)
  // The agent chat's catalog: everything a permission does not block, without
  // the plan tool unless a plan was asked for (nobody asked for one yet).
  let defs = gatePlanTool(
    toolRegistry.getAvailableTools(categories),
    planToolAllowed({ mode: null, userText: '', todos: [] }),
  // Nobody sees a card while speaking: no settings changes by voice (A11).
  ).filter((tool) => TOOL_NAME.test(tool.name) && !isSettingsToolName(tool.name) && voiceToolLevel(tool.name, toolRegistry, permissions(), run) !== 'blocked')
  if (!defs.some((tool) => tool.name === COMPUTER_TASK_TOOL_NAME) && categories[COMPUTER_TASK_TOOL.category] !== 'blocked') {
    defs.push(COMPUTER_TASK_TOOL)
  }
  // A voice session fixes its tools at the start, there is no message to
  // route by yet. A local model gets the short set (lib/voice/tool-set.ts).
  defs = voiceToolSet(defs, brain.local)
  // Small-Model Mode keeps its cap.
  defs = applyMaxTools(defs, toolSelectionOpts(!!settings.smallModelMode).maxTools ?? MAX_VOICE_TOOLS)
  defs = defs.slice(0, MAX_VOICE_TOOLS)
  const names = new Set(defs.map((tool) => tool.name))
  const mayAsk = (name: string) => {
    const level = voiceToolLevel(name, toolRegistry, permissions(), run)
    // "Workspace only" asks before every command, whatever the permission says.
    return level === 'confirm' || levelInScope(name, level === 'blocked' ? 'auto' : level, { agent: true, scope: 'workspace' }) === 'confirm'
  }
  const longRunning = defs
    // A tool with its own gate (computer_use) asks the user inside the call,
    // so it can wait just as long as one that waits for an approval card.
    .filter((tool) => SELF_GATED_TOOLS.has(tool.name) || mayAsk(tool.name))
    .map((tool) => tool.name)
    // The voice loop reserves `cancel_<name>` for each of these.
    .filter((name) => !names.has(`cancel_${name}`))
  return { defs, longRunning }
}

/** The tools the model is shown under the switches as they stand. */
function shownTools(all: readonly MCPToolDefinition[], work: VoiceWork): string[] {
  return all
    .map((tool) => tool.name)
    // A tool that is not in the catalog (computer control is off) is not shown.
    .filter((name) => toolInScope(name, work) && toolRegistry.getToolByName(name) !== undefined)
}

function sessionPrompt(parts: SessionWork['prompt'], workspace: AgentWorkspace | null, shown: readonly string[], work: VoiceWork): string {
  const prompt = buildVoiceSystemPrompt({
    base: parts.base,
    memory: parts.memory,
    workspace: [renderWorkspaceSection(workspace).trim(), shown.length > 0 ? scopePromptLine(work) : ''].filter(Boolean).join('\n'),
    toolsOffered: shown.length > 0,
  })
  return withComputerUsePrompt(prompt, shown)
}

/**
 * What the voice loop is told about thinking, from the switch and the length
 * in the settings. A model that always thinks gets no limit: the voice loop
 * lets it finish, keeps the thought to itself and speaks the answer.
 */
function thinkingConfig(brain: VoiceBrain): { wanted: boolean; budget_tokens: number | null; extra: Record<string, unknown>; direct_extra: Record<string, unknown> } {
  const prefs = useVoiceStore.getState()
  const plan = brain.thinking(prefs.loopThinking)
  return {
    wanted: plan.wanted || plan.always,
    budget_tokens: plan.always ? null : thinkingBudgetStep(prefs.loopThinkingBudget),
    extra: plan.extra,
    direct_extra: plan.directExtra,
  }
}

/** Thoughts are shown when the user switched thinking on, never otherwise, and never for a model whose switch is locked. */
function showsThoughts(brain: VoiceBrain | undefined): boolean {
  const wanted = useVoiceStore.getState().loopThinking
  return wanted && brain?.thinking(wanted).always !== true
}

function sessionNotice(session: ActiveSession, shown: readonly string[]): string | null {
  const work = session.work
  if (!work) return null
  if (!work.brain.toolsSupported) return NO_TOOLS_NOTICE
  if (!voiceWork().agent) return AGENT_OFF_NOTICE
  if (shown.length > 0 && voiceWork().scope === 'computer' && work.filesNote) return work.filesNote
  return null
}

/**
 * Let the session's files out of the workspace folder, or take them back in.
 * The Rust side asks the user in a window of the system the first time after
 * the app started; a no leaves the files in the folder and says so.
 */
async function syncWholeComputer(session: ActiveSession, asking?: () => void): Promise<void> {
  const work = session.work
  if (!work) return
  const want = voiceWork().agent && voiceWork().scope === 'computer' && work.brain.toolsSupported
  if (!isTauri()) {
    work.wholeComputer = false
    work.filesNote = want ? WHOLE_COMPUTER_APP_ONLY_NOTICE : null
    return
  }
  if (!want && !work.wholeComputer) {
    work.filesNote = null
    return
  }
  // Only an answer that takes a moment is the user being asked: after the
  // first yes of this start of the app the call returns at once.
  const slow = want && asking ? setTimeout(asking, ASKING_AFTER_MS) : null
  try {
    work.wholeComputer = await backendCall<boolean>('fs_whole_computer', { chatId: work.slug, on: want })
    work.filesNote = want && !work.wholeComputer ? WHOLE_COMPUTER_DECLINED_NOTICE : null
  } catch (error) {
    work.wholeComputer = false
    work.filesNote = want ? WHOLE_COMPUTER_DECLINED_NOTICE : null
    log.warn('voice.whole_computer_failed', { message: error instanceof Error ? error.message : String(error) })
  } finally {
    if (slow) clearTimeout(slow)
  }
}

/**
 * A switch at the top of the surface moved while a session runs. The session
 * follows at once: the model sees the tools that fit, is told where it stands,
 * and the next request thinks or does not.
 */
async function applyWork(session: ActiveSession): Promise<void> {
  const work = session.work
  const client = session.client
  if (!work || session.ended) return
  if (session.run) session.run.workspace = voiceWorkspace()
  await syncWholeComputer(session)
  if (session.ended) return
  const now = voiceWork()
  // A screen task that began under "Whole computer" does not outlive it.
  await endScreenWorkOutOfScope(now)
  if (session.ended) return
  const shown = shownTools(work.all, now)
  dispatch({ type: 'brain', modelLabel: work.brain.modelLabel, notice: sessionNotice(session, shown) })
  if (!client?.connected) return
  try {
    client.sendClientMessage('session-tools', { names: shown, system_prompt: sessionPrompt(work.prompt, session.run?.workspace ?? null, shown, now) })
    client.sendClientMessage('thinking', thinkingConfig(work.brain))
  } catch { /* the connection is going down; the session ends by itself */ }
}

/** Follow the switches for as long as the session lives. */
function followSwitches(session: ActiveSession): void {
  const key = () => {
    const prefs = useVoiceStore.getState()
    return JSON.stringify([prefs.loopAgent, prefs.loopScope, prefs.loopWorkspace, prefs.loopThinking, prefs.loopThinkingBudget, useComputerStore.getState().enabled])
  }
  let before = key()
  let queue: Promise<void> = Promise.resolve()
  const changed = () => {
    const now = key()
    if (now === before) return
    before = now
    // One change at a time, in the order the user made them.
    queue = queue.then(() => applyWork(session)).catch(() => {})
  }
  session.cleanup.push(useVoiceStore.subscribe(changed))
  session.cleanup.push(useComputerStore.subscribe(changed))
}

/**
 * Start a session. Call it directly from the click handler, without anything
 * awaited in between: the first thing it does needs the user gesture.
 */
export async function startVoiceSession(): Promise<void> {
  if (active) return
  cancelIdleStop()
  const prefs = useVoiceStore.getState()
  const muted = prefs.loopStartMuted
  const media = new LuVoiceMediaManager({ micId: prefs.micId || null, micEnabled: !muted })
  const session: ActiveSession = {
    media, abort: new AbortController(), client: null, bridge: null, history: null, run: null,
    timer: null, secret: null, ended: false, cleanup: [], warmed: null, startedAt: Date.now(), liveAt: null, work: null,
  }
  active = session
  session.cleanup.push(onMicrophoneChosen((deviceId) => { void switchMic(session, deviceId) }))
  dispatch({ type: 'start', at: Date.now(), muted })
  // The limit of the start, set again for a step that has its own.
  const limit = (step: VoiceStartStep | null) => {
    if (session.timer) clearTimeout(session.timer)
    const { ms, message } = startTimeout(step)
    session.timer = setTimeout(() => fail(session, { kind: 'start-failed', message }), ms)
  }
  limit(null)

  try {
    // 1. Microphone. The synchronous part of initialize() runs in the click.
    await media.initialize()
    guard(session)
    void publishMics(session)

    // 2. The voice loop process. A shutdown for idleness that is under way
    // finishes first: a start that met it half way got a process that was
    // about to exit, and the session ended a moment after it began.
    if (engineStopping) await engineStopping
    guard(session)
    const before = await getVoiceLoopStatus().catch(() => null)
    guard(session)
    dispatch({ type: 'start-step', step: 'engine', coldStart: !before?.ready })
    const loop = await startVoiceLoop()
    guard(session)

    // 3. The brain, its tools and what it is told.
    dispatch({ type: 'start-step', step: 'model' })
    const activeModel = useModelStore.getState().activeModel
    // The session talks to the model in a moment. A memory extraction that
    // still holds it steps aside, or the first answer waits behind it.
    yieldSilentRunsTo(activeModel)
    await noteModelBeforeSession(activeModel)
    guard(session)
    const brain = await resolveVoiceBrain(activeModel, prefs.loopThinking)
    session.secret = brain.llm.api_key ?? null
    guard(session)
    log.info('voice.session_brain', describeVoiceBrain(brain))

    const settings = useSettingsStore.getState().settings
    const chat = useChatStore.getState()
    const shown = chat.activeConversationId
    const conversationId = chat.createConversation(activeModel!, '')
    // The new conversation is the session's record, not a place the user
    // asked to go. Whatever chat was open stays open.
    useChatStore.getState().setActiveConversation(shown)
    const conversation = useChatStore.getState().conversations.find((c) => c.id === conversationId)
    session.history = new VoiceHistory({ conversationId, modelId: voiceModelRecord(brain.providerId, brain.llm.model), memoryScope: conversation?.memoryScope })

    let workspace = voiceWorkspace()
    // A remembered folder is asked, not believed: one the file jail no longer
    // knows would answer every file tool with a refusal nobody can act on.
    if (workspace?.kind === 'folder' && workspace.path && await rememberedFolderRefusal(workspace.path)) workspace = null
    const slug = await resolveChatWorkspaceSlug(conversationId, conversation?.title)
    guard(session)
    const run = beginAgentRun({ chatId: slug, conversationId, workspace, mode: null })
    run.abortSignal = session.abort.signal
    // One run from Start to Stop: open is not the same as working.
    run.standing = true
    session.run = run

    const permissions = (): VoiceToolPermissions => ({
      categories: usePermissionStore.getState().getEffectivePermissions(conversationId),
      overrides: usePermissionStore.getState().perToolOverrides,
    })
    const tools = selectTools(brain, conversationId, run, permissions)

    let memory = ''
    try {
      const contextTokens = Math.min(await getModelMaxTokens(activeModel!), 8192)
      memory = (await useMemoryStore.getState().getMemoryContextAsync('', contextTokens, { scope: conversation?.memoryScope })).text
    } catch { /* a session without remembered context is still a session */ }
    guard(session)
    session.work = {
      brain,
      all: tools.defs,
      slug,
      // GH #170: the persona of THIS chat, the one its Plugins menu names.
      prompt: {
        base: buildChatSystemPrompt(
          conversation
            ? withChatPersona(conversation, useSettingsStore.getState().personas, useSettingsStore.getState().activePersonaId)
            : {},
          settings.personasEnabled !== false,
        ),
        memory,
      },
      wholeComputer: false,
      filesNote: null,
    }
    // "Whole computer" is asked for in a window of the system, once per start
    // of the app. While that window waits, the status says so, and the wait
    // does not count as a start that hangs.
    let asked = false
    await syncWholeComputer(session, () => {
      if (session.ended) return
      asked = true
      dispatch({ type: 'start-step', step: 'permission' })
      limit('permission')
    })
    guard(session)
    if (asked) {
      dispatch({ type: 'start-step', step: 'model' })
      limit('model')
    }
    const work = voiceWork()
    const offered = shownTools(tools.defs, work)
    const systemPrompt = sessionPrompt(session.work.prompt, workspace, offered, work)
    dispatch({ type: 'brain', modelLabel: brain.modelLabel, notice: sessionNotice(session, offered) })
    const hasTask = tools.defs.some((tool) => tool.name === COMPUTER_TASK_TOOL_NAME)
    const thinking = thinkingConfig(brain)

    // N1: hear and speak through LFM3 Audio when Settings, Voice says so.
    const speech = await voiceSessionSpeech()
    guard(session)

    // 4. The connection.
    dispatch({ type: 'start-step', step: 'connecting' })
    const response = await fetch(`${loop.baseUrl}/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loop.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llm: brain.llm,
        system_prompt: systemPrompt,
        tools: tools.defs.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description.slice(0, 8000), parameters: tool.inputSchema },
        })),
        active_tools: offered,
        long_running_tools: tools.longRunning,
        thinking: { wanted: thinking.wanted, budget_tokens: thinking.budget_tokens, direct_extra: thinking.direct_extra },
        tool_timeout_secs: (hasTask ? TASK_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS) / 1000 + 10,
        voice: loop.voice || DEFAULT_VOICE,
        // A local server evaluates the system prompt and the tools once and
        // keeps them. Without this the first answer waits for that.
        prewarm: brain.local,
        context_limit_tokens: voiceContextLimit(brain.local),
        ...speech,
      }),
      signal: session.abort.signal,
    }).catch((error: unknown) => {
      if (session.abort.signal.aborted) throw new SessionOver()
      // "Failed to fetch" says nothing to a user. The process is gone or not listening.
      log.warn('voice.session_request_failed', { error: error instanceof Error ? error.name : 'unknown' })
      throw new Error('The voice engine did not answer. Start again. If this keeps happening, run Repair in the voice settings.')
    })
    const ticket = (await response.json().catch(() => null)) as { wsUrl?: string; token?: string; error?: string } | null
    guard(session)
    if (!response.ok || !ticket?.wsUrl || !ticket.token) {
      throw new Error(ticket?.error || `The voice engine refused the session (HTTP ${response.status}).`)
    }

    const transport = new WebSocketTransport({ mediaManager: media, recorderSampleRate: 16_000 })
    const client = new PipecatClient({
      transport,
      // Mute may have been switched while the session was starting.
      enableMic: media.isMicEnabled,
      enableCam: false,
      callbacks: {
        onAvailableMicsUpdated: () => { void publishMics(session) },
        onMicUpdated: () => { void publishMics(session) },
      },
    })
    // The client's debug level prints every message, transcripts included.
    client.setLogLevel(LogLevel.WARN)
    session.client = client
    const hold = brainHold(session, client, brain)
    wire(session, client, tools.defs.map((tool) => tool.name), run, permissions, hold.release)
    const warm = brain.local
      ? new Promise<void>((resolve) => { session.warmed = resolve })
      : Promise.resolve()
    await client.connect({ wsUrl: ticket.wsUrl, token: ticket.token })
    guard(session)
    // connect() resolves on the voice loop's ready message. What the user
    // said since the click goes out now, ahead of what is said from here on.
    media.sendHeld()
    if (brain.local) {
      // The microphone is live from here on. What is said now is answered as
      // soon as the model is through its instructions.
      dispatch({ type: 'start-step', step: 'warming' })
      await Promise.race([warm, new Promise<void>((resolve) => setTimeout(resolve, WARM_WAIT_MS))])
      session.warmed = null
      guard(session)
    }
    if (brain.providerId === 'lu-cloud') keepCloudKeyFresh(session, client)
    // A switch moved while the session was starting is applied now, and
    // every later one as it happens.
    followSwitches(session)
    if (JSON.stringify(offered) !== JSON.stringify(shownTools(tools.defs, voiceWork())) || JSON.stringify(thinking) !== JSON.stringify(thinkingConfig(brain))) {
      await applyWork(session)
      guard(session)
    }
    // Computer control and the voice: see voice-computer.ts.
    session.cleanup.push(announceComputerControl((kind, data) => {
      if (session.ended || !client.connected) return
      try { client.sendClientMessage(kind, data) } catch { /* the connection is going down; the session ends by itself */ }
    }, hold.take))
    // A stop the user gave by voice or by button ends with the session, so the
    // next session starts clean.
    session.cleanup.push(() => noteUserAskedAgain(run))
    if (session.timer) clearTimeout(session.timer)
    session.timer = null
    session.liveAt = Date.now()
    dispatch({ type: 'ready' })
    // The session listens from here on, and says so with a short quiet sound.
    if (prefs.loopStartSound) media.playStartSound()
  } catch (error) {
    if (error instanceof SessionOver || session.ended) return
    fail(session, toError(error, session.secret))
  }
}

function wire(
  session: ActiveSession,
  client: PipecatClient,
  offeredTools: string[],
  run: AgentRunContext,
  permissions: () => VoiceToolPermissions,
  releaseBrain: () => Promise<void>,
): void {
  const history = session.history
  const live = <T extends unknown[]>(handler: (...args: T) => void) => (...args: T) => {
    if (!session.ended) handler(...args)
  }

  // Tokens of an answer the user spoke over still arrive after the cut.
  const gate = new AnswerGate()

  client.on(RTVIEvent.UserStartedSpeaking, live(() => {
    // Whatever speech is still queued for the speaker must stop now.
    session.media.interrupt()
    gate.userStarted()
    history?.botTurnEnded()
    dispatch({ type: 'user-started' })
  }))
  client.on(RTVIEvent.UserStoppedSpeaking, live(() => dispatch({ type: 'user-stopped' })))
  // A spoken command that the voice loop took out is an answer to the app.
  // It is neither a line of the transcript nor part of the record.
  const heard = new HeardUtterances(live((text: string) => {
    dispatch({ type: 'user-text', text, final: true })
    history?.userSaid(text)
    // A new request lifts an earlier stop of computer control, as a new chat
    // message does. "Stop", "yes" and "no" are answers, not requests.
    if (!spokenCommand(text)) noteUserAskedAgain(run)
  }))
  session.cleanup.push(() => heard.drop())
  client.on(RTVIEvent.UserTranscript, live((data) => {
    if (data.final) heard.final(data.text)
    else if (data.text.trim()) dispatch({ type: 'user-text', text: data.text, final: false })
  }))
  client.on(RTVIEvent.BotLlmStarted, live(() => {
    // The model answers: what the user said last was meant for it.
    heard.release()
    gate.responseStarted()
    dispatch({ type: 'bot-thinking' })
  }))
  client.on(RTVIEvent.BotLlmText, live((data) => {
    if (!gate.accepts()) return
    dispatch({ type: 'bot-text', text: data.text })
    history?.botText(data.text)
  }))
  client.on(RTVIEvent.BotStartedSpeaking, live(() => dispatch({ type: 'bot-speaking' })))
  client.on(RTVIEvent.BotStoppedSpeaking, live(() => {
    history?.botTurnEnded()
    dispatch({ type: 'bot-silent' })
  }))
  client.on(RTVIEvent.ServerMessage, live((data: unknown) => {
    const message = data as { type?: unknown; total_secs?: unknown; id?: unknown; answer?: unknown; phase?: unknown; text?: unknown; secs?: unknown; cut?: unknown } | null
    if (message?.type === 'thought') {
      // What the model thinks is never spoken. It is shown when the user
      // switched thinking on; a model that thinks anyway thinks unseen.
      if (!showsThoughts(session.work?.brain) || !gate.accepts()) return
      if (message.phase === 'text' && typeof message.text === 'string') {
        dispatch({ type: 'thought-text', text: message.text })
        history?.botThought(message.text)
      } else if (message.phase === 'end') {
        dispatch({ type: 'thought-end', secs: typeof message.secs === 'number' ? message.secs : undefined, cut: message.cut === true })
      }
    } else if (message?.type === 'latency' && typeof message.total_secs === 'number') {
      dispatch({ type: 'latency', ms: message.total_secs * 1000 })
    } else if (message?.type === 'warm') {
      session.warmed?.()
    } else if (message?.type === 'voice-stop') {
      voiceSaidStop()
    } else if (message?.type === 'voice-answer' && (message.answer === 'yes' || message.answer === 'no')) {
      voiceAnswered(message.id, message.answer)
    }
  }))
  client.on(RTVIEvent.Error, live((message) => {
    const error = readLoopError(message?.data, (text) => safeDetail(text, session.secret))
    if (error.fatal) {
      fail(session, { kind: 'model-error', message: error.detail ? `The session stopped: ${error.detail}` : 'The session stopped because of an error.' })
      return
    }
    // One piece of work failed. The session is still there.
    log.warn('voice.loop_error', { detail: error.detail })
    if (error.hint) dispatch({ type: 'hint', text: error.hint })
  }))
  client.on(RTVIEvent.Disconnected, live(() => {
    fail(session, { kind: 'connection-lost', message: 'The connection to the voice engine was lost. Start a new session.' })
  }))

  const store = createVoiceLoopStore('local', 'assistant')
  const onCall = (event: VoiceToolEvent) => {
    if (session.ended) return
    history?.toolEvent(event)
    if (event.type === 'approval') dispatch({ type: 'tool-waiting', id: event.id, name: event.name, args: event.args })
    else if (event.type === 'started') dispatch({ type: 'tool-running', id: event.id, name: event.name, args: event.args })
    else dispatch({ type: 'tool-done', id: event.id, status: event.status, result: event.result, durationMs: event.durationMs })
  }
  session.bridge = new VoiceToolBridge({
    client, registry: toolRegistry, run, store, offeredTools, permissions, toolTimeoutMs: TOOL_TIMEOUT_MS, onCall,
    toolTimeouts: { [COMPUTER_TASK_TOOL_NAME]: TASK_TOOL_TIMEOUT_MS },
    beforeResult: (name) => (name === COMPUTER_TASK_TOOL_NAME ? releaseBrain() : Promise.resolve()),
    // The switches at the top of the surface, read at the moment of the call.
    refuse: (name, args) => {
      const folder = run.workspace?.kind === 'folder' ? run.workspace.path ?? null : null
      return scopeRefusal({ name, args }, voiceWork(), folder)
    },
    narrow: (name, level) => levelInScope(name, level, voiceWork()),
  })
  store.subscribe((state) => {
    if (state.status === 'error' && !session.ended) {
      fail(session, { kind: 'model-error', message: state.error ?? 'The session stopped safely. Start a new session to continue.' })
    }
  })
}

/**
 * A screen task with its own local model takes the app's engine away from the
 * brain, because the engine holds one model at a time. From the start of such
 * a task the voice loop is told not to ask the brain (`take`), and before the
 * result of the task goes out the brain is loaded again (`release`). Without
 * this a word during the task ended the session, and after the task the
 * screen model answered as the brain.
 */
function brainHold(session: ActiveSession, client: PipecatClient, brain: VoiceBrain): { take: () => void; release: () => Promise<void> } {
  const send = (on: boolean) => {
    if (session.ended || !client.connected) return
    try { client.sendClientMessage('hold', { on }) } catch { /* the connection is going down; the session ends by itself */ }
  }
  let held = false
  return {
    take: () => {
      void resolveExecutor().then((executor) => {
        // The task can be over before the answer is here; then nothing is held.
        if (!executor || useComputerStore.getState().task === null || !takesTheEngineFrom(brain, executor.model)) return
        held = true
        send(true)
        log.info('voice.session_brain_on_hold', { screenModel: executor.label })
      }).catch(() => { /* no screen model, no hold */ })
    },
    release: async () => {
      if (!held) return
      held = false
      try {
        await brain.restore?.()
      } catch (error) {
        log.warn('voice.session_brain_restore_failed', { message: error instanceof Error ? error.message : String(error) })
      } finally {
        send(false)
      }
    },
  }
}

/**
 * A cloud sign-in is good for about an hour, and a session can be longer.
 * The account renews the sign-in by itself; this hands the renewed one to the
 * voice loop before the old one runs out. When the sign-in is gone for good
 * the session ends with a sentence that says so.
 */
function keepCloudKeyFresh(session: ActiveSession, client: PipecatClient): void {
  const timer = setInterval(() => {
    void (async () => {
      let token: string | null
      try {
        token = await getAccessToken()
      } catch {
        // Offline for a moment. The current key may well still be good.
        return
      }
      if (session.ended) return
      const step = cloudKeyStep(session.secret, token)
      if (step.kind === 'signed-out') fail(session, { kind: 'signed-out', message: SIGNED_OUT_MESSAGE })
      if (step.kind !== 'renew') return
      session.secret = step.key
      try { client.sendClientMessage('llm-key', { api_key: step.key }) } catch { /* the session is ending */ }
    })()
  }, KEY_CHECK_MS)
  session.cleanup.push(() => clearInterval(timer))
}

/** Who ended a session that did not fail. */
export type VoiceStopReason = 'user' | 'left' | 'repair' | 'uninstall' | 'unload'

/**
 * What the surface says after a session that ended without the Stop button.
 * The Stop button needs no sentence, the user pressed it.
 */
export const VOICE_END_NOTES: Partial<Record<VoiceStopReason, string>> = {
  left: 'The session ended when you left Voice. Start again to continue.',
  repair: 'The session ended for the repair. Start again when it is done.',
  unload: 'Voice is unloaded. Start again to load it.',
  // Removing Voice replaces the whole surface with the setup, which says it.
}

/** End the session. Safe at any time, also while it is still starting. */
export function stopVoiceSession(reason: VoiceStopReason = 'user'): void {
  const session = active
  if (!session) return
  logEnd(session, reason)
  dispatch({ type: 'stopping' })
  teardown(session)
  dispatch({ type: 'stopped', note: VOICE_END_NOTES[reason] })
}

export function answerVoiceApproval(approved: boolean): void {
  active?.bridge?.answer(approved)
}

export function setVoiceMuted(muted: boolean): void {
  const session = active
  if (session?.client) session.client.enableMic(!muted)
  else session?.media.enableMic(!muted)
  dispatch({ type: 'muted', muted })
}

/** Loudness of microphone and answer, 0 to 1. Zero without a session. */
export function voiceLevels(): { mic: number; bot: number } {
  return active ? active.media.levels() : { mic: 0, bot: 0 }
}

/**
 * Use the voice engine outside a session, for the sample of a voice. Starts
 * it when it is not running, waits for a shutdown that is under way, and puts
 * it back on the idle clock afterwards, so listening to a voice never leaves
 * a gigabyte of speech models in memory for good.
 */
export async function withVoiceEngine<T>(work: (loop: VoiceLoopSession) => Promise<T>): Promise<T> {
  cancelIdleStop()
  try {
    if (engineStopping) await engineStopping
    return await work(await startVoiceLoop())
  } finally {
    if (!active) scheduleIdleStop()
  }
}

export interface VoiceUnloadResult {
  /** Memory the voice engine held right before it was stopped, in bytes. */
  freedBytes: number | null
  /** The chat model was unloaded too, because Voice had loaded it. */
  modelUnloaded: boolean
  /** The voice engine process is gone, as the app's own status reports it. */
  gone: boolean
}

/**
 * Unload Voice: end the session, stop the voice engine and give its memory
 * back. The chat model goes too when a voice session loaded it. Resolves when
 * the process is gone, with what was measured right before.
 */
export async function unloadVoiceEngine(): Promise<VoiceUnloadResult> {
  stopVoiceSession('unload')
  cancelIdleStop()
  const before = await getVoiceLoopStatus().catch(() => null)
  const stopping = stopVoiceLoop().then(() => undefined, () => undefined).finally(() => {
    if (engineStopping === stopping) engineStopping = null
  })
  engineStopping = stopping
  await stopping
  let modelUnloaded = false
  const loaded = loadedForVoice
  loadedForVoice = null
  if (loaded) {
    try {
      if (loaded.kind === 'ollama') {
        if ((await listRunningModels()).includes(loaded.model)) {
          await unloadModel(loaded.model)
          modelUnloaded = true
        }
      } else {
        await backendCall('stop_bundled_engine')
        modelUnloaded = true
      }
    } catch (error) {
      log.warn('voice.unload_model_failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }
  const after = await getVoiceLoopStatus().catch(() => null)
  const result = { freedBytes: before?.memoryBytes ?? null, modelUnloaded, gone: after !== null && !after.running }
  log.event('voice.unloaded', { freedBytes: result.freedBytes, modelUnloaded, gone: result.gone })
  return result
}

export function voiceSessionActive(): boolean {
  return active !== null
}
