import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { Conversation, Message, MessageError, ChatArtifact, CompactionRecord, RequestUsage } from '../types/chat'
import type { AgentBlock } from '../types/agent-mode'
import { clampSampling, storedTemperature, type SamplingOverrides } from '../lib/sampling'
import { cleanCustomParams, type CustomParam } from '../lib/custom-params'
import { idbStorage } from '../lib/idbStorage'
import { externalizeConversations, hasInlineImages } from '../lib/chat-attachments'
import { FILE_ONLY_TEXT } from '../lib/chat-files'
import { holdBackup, releaseBackup } from '../lib/backup-hold'
import { coalescedJSONStorage } from '../lib/coalescedStorage'
import { isMobile } from '../lib/device-kind'
import { plainChatTitle } from '../lib/chat-title'
import { migrateBlockInPlace } from '../api/agents/block-helpers'
import { markStaleWorkflowProgressStoppedOnBlock, extractWorkflowNameFromProgressMessage } from '../lib/workflow-progress-view'
import { markStaleBackgroundCallOnBlock } from '../lib/background-tools'
import { cancelBackgroundJobsOf } from '../lib/background-cancels'
import { useGenerationStore } from './generationStore'
import { useRemoteStore } from './remoteStore'
import { useSettingsStore } from './settingsStore'
import { useRAGStore } from './ragStore'
import { useTodoStore } from './todoStore'
import { usePermissionStore } from './permissionStore'
import { useStagedChangesStore } from './stagedChangesStore'
import { useCodexStore } from './codexStore'
import { useAgentTaskStore } from './agentTaskStore'
import { useAgentModeStore } from './agentModeStore'
import { log } from '../lib/logger'
import { isRecord, prop } from '../types/json-guards'
import { activeConversationAtStart } from '../lib/conversation-mode'
import { cardChatStart } from '../lib/character-card'
import { personaPromptOf } from '../lib/chat-persona'
import type { Persona } from '../types/settings'
import { copyConversation, forgetForkKey, forkFrom, forkKeyAt, restoreEmptyFork, switchFork } from '../lib/chat-forks'
import { savedUserEdit } from '../lib/message-edit'

/** GH #169: give each group turn of these models that carries no persona yet
 *  the persona its model played (model name to persona id). A turn that
 *  already names its persona keeps it. Returns the same array when nothing
 *  changes. */
function stampGroupPersonas(messages: Message[], played: Record<string, string>): Message[] {
  let changed = false
  const out = messages.map((m) => {
    if (m.role !== 'assistant' || !m.modelId || m.groupPersonaId || m.noGroupPersona) return m
    const personaId = played[m.modelId]
    if (!personaId) return m
    changed = true
    return { ...m, groupPersonaId: personaId }
  })
  return changed ? out : messages
}

/**
 * Rehydration migration for Phase 1 (v2.4.0) — wraps legacy
 * `AgentBlock.toolCall` (singular) into the new `toolCalls: AgentToolCall[]`
 * form. Idempotent: safe to run on already-migrated data. Leaves the legacy
 * field in place during a transition window so reads via either shape work.
 */
export function migratePersistedChat(state: unknown): unknown {
  const conversations = prop(state, 'conversations')
  if (!Array.isArray(conversations)) return state
  for (const conv of conversations) {
    // A33 (3.0.8): a chat whose own temperature sits above TEMPERATURE_MAX
    // (the popup slider ran to 2.0 until 3.0.7) loses that one value and
    // follows the Settings page again; its other sampling values stay.
    const sampling = prop(conv, 'sampling')
    if (isRecord(sampling) && 'temperature' in sampling && storedTemperature(sampling.temperature) === undefined) {
      delete sampling.temperature
    }
    const messages = prop(conv, 'messages')
    if (!Array.isArray(messages)) continue
    for (const msg of messages) {
      const blocks = prop(msg, 'agentBlocks')
      if (!Array.isArray(blocks)) continue
      // Runde 3, B2 (review-wfprogress.md): the workflow's own name lives on
      // the TRIGGER message's content ("Running workflow: **<name>**"), not
      // on the block or the tool call, so it has to be pulled out here, once
      // per message, and threaded into the block-level fix below.
      const workflowName = extractWorkflowNameFromProgressMessage(prop(msg, 'content'))
      for (const block of blocks) {
        // migrateBlockInPlace reads `toolCall` and `toolCalls` and writes
        // `toolCalls`; the cast claims no more than those three, and the
        // record check above is what makes even that much true.
        if (!isRecord(block)) continue
        const typedBlock = block as unknown as AgentBlock
        migrateBlockInPlace(typedBlock)
        // Runde 2 Blocker (app-restart case, workflow-progress-view.ts),
        // fixed properly in Runde 3 (B2): a block still 'running' here means
        // the app closed mid-run, since this migration only ever sees what
        // was persisted, never a live in-session update (those go through
        // addBlock/updateBlockById on the live Zustand state directly).
        // Rewrite it as honestly stopped - on BOTH the legacy `toolCall` and
        // the `toolCalls` array, since after a JSON persist round-trip they
        // are separate objects and the chat surface (`groupAgentBlocks`,
        // tool-call-groups.ts) renders only the legacy singular field.
        markStaleWorkflowProgressStoppedOnBlock(typedBlock, workflowName)
        // 3.0.8 (A2): same reason for a generation that went on in the
        // background: its job lived in the window that closed.
        markStaleBackgroundCallOnBlock(typedBlock)
      }
    }
  }
  return state
}

/**
 * Everything OUTSIDE this store that is keyed by conversation id.
 *
 * Deleting a chat used to remove exactly one row — the one in `conversations` —
 * and leave five other stores holding that id forever. Nothing ever collects
 * them, because the id is the only thing that could prove they are orphans and
 * the id is what was just thrown away.
 *
 * Two of the five are expensive, for different reasons:
 *
 *  - RAG: its 768-float embedding vectors stay in IndexedDB AND keep being
 *    exported to rag_chunks_backup.json every 30 s for the lifetime of the
 *    installation.
 *  - codex: a Coding-Agent thread carries an event ring of up to 500 entries,
 *    and each entry is either an UNTRUNCATED terminal result (the 60k cap in
 *    useCodex applies to what goes back to the model, not to what is stored)
 *    or a full unified diff — tens of megabytes for a chat that is gone. Its
 *    status also keeps voting in `lib/run-idle.ts`, so a chat deleted mid-run
 *    could leave a thread stuck at 'running' and defer every idle-gated dialog
 *    for the rest of the session. And `codexStore.modeByConversation` is
 *    PERSISTED, which is the difference between leaking until the next restart
 *    and leaking for good.
 *
 * The list below ran with FOUR entries while this comment said five (and the
 * one below it said "the other four") — codex was the missing step, and the
 * mismatch between the two numbers was the only sign of it. Number and list
 * are now the same thing; keep them that way.
 *
 * Each store is its own try/catch: one of them failing must not leave the other
 * four uncleaned, and none of them may stop the chat from being deleted.
 *
 * Exported so a test can assert the sweep without going through the store.
 */
export function dropConversationSideState(id: string): void {
  const steps: [string, () => void][] = [
    ['rag', () => useRAGStore.getState().removeConversation(id)],
    ['todos', () => useTodoStore.getState().clearTodos(id)],
    ['permissions', () => usePermissionStore.getState().clearConversationOverrides(id)],
    ['staged-changes', () => useStagedChangesStore.getState().clear(id)],
    ['codex', () => useCodexStore.getState().dropConversation(id)],
    // 3.0.8 (A2): a picture or video still rendering in the background for
    // this chat has nowhere to land any more, so it stops instead of burning
    // the card for nothing.
    ['background-jobs', () => { cancelBackgroundJobsOf(id) }],
    // 2.6.8: Hintergrundagenten. Diese Zeile fehlte, und sie ist die einzige
    // in der Liste, die etwas ABBRICHT statt nur zu vergessen — ein
    // delegierter Agent laeuft in einem eigenen Versprechen weiter, auch wenn
    // sein Chat weg ist.
    ['agent-tasks', () => useAgentTaskStore.getState().clearConv(id)],
  ]
  for (const [what, run] of steps) {
    try { run() } catch (err) {
      log.warn('[chatStore] could not clear side state for a deleted chat', { store: what, err: String(err) })
    }
  }
}

/**
 * The settings of a chat that live OUTSIDE this store, carried over to a
 * duplicate or a branch (GH #174): Agent on or off and its working folder,
 * the Code mode, the tool permissions, the attached documents. A full
 * duplicate also takes the task list; a branch ends earlier, where that list
 * would describe work that is not in it.
 *
 * Not copied on purpose: Create orders (they are bookings, and a copy would
 * count their cost twice), the staged changes of a running agent and its
 * background tasks (they belong to a run, not to the chat).
 *
 * One try per store, like dropConversationSideState: a failure in one of
 * them must not stop the others or the copy.
 */
export function copyConversationSideState(fromId: string, toId: string, opts: { withTodos: boolean }): void {
  const steps: [string, () => void][] = [
    ['agent-mode', () => {
      const agent = useAgentModeStore.getState()
      if (agent.agentModeActive[fromId] !== undefined) agent.setAgentModeActive(toId, agent.agentModeActive[fromId])
      const workspace = agent.workspaces[fromId]
      if (workspace) agent.setWorkspace(toId, structuredClone(workspace))
    }],
    ['codex', () => {
      const mode = useCodexStore.getState().modeByConversation[fromId]
      if (mode) useCodexStore.setState((s) => ({ modeByConversation: { ...s.modeByConversation, [toId]: mode } }))
    }],
    ['permissions', () => {
      const overrides = usePermissionStore.getState().conversationOverrides[fromId]
      if (overrides) usePermissionStore.setState((s) => ({ conversationOverrides: { ...s.conversationOverrides, [toId]: { ...overrides } } }))
    }],
    ['todos', () => {
      if (!opts.withTodos) return
      const todos = useTodoStore.getState().byConversation[fromId]
      if (todos?.length) useTodoStore.getState().setTodos(toId, structuredClone(todos))
    }],
    ['rag', () => {
      void useRAGStore.getState().copyConversation(fromId, toId).catch((err) => {
        log.warn('[chatStore] could not copy the documents of a chat', { err: String(err) })
      })
    }],
  ]
  for (const [what, run] of steps) {
    try { run() } catch (err) {
      log.warn('[chatStore] could not copy side state for a chat copy', { store: what, err: String(err) })
    }
  }
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  /** `opts.persona`: the persona the chat starts with, passed by the plain
   *  chat entry points only. A character card persona turns the chat into a
   *  role play chat: its prompt with the macros filled in, the persona
   *  switched on for this chat, and the card's greeting as the first answer. */
  createConversation: (
    model: string,
    systemPrompt: string,
    mode?: 'lu' | 'codex' | 'openclaw' | 'remote',
    opts?: { persona?: Persona | null },
  ) => string
  /** Show another of the opening greetings of a character card chat. Does
   *  nothing once the user has written. */
  selectGreeting: (conversationId: string, messageId: string, index: number) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  /** "Continue on phone" on or off for one chat (CHATS-V1.md). */
  setRemoteShared: (id: string, shared: boolean) => void
  /** Mark a message as written on the phone. */
  markFromPhone: (conversationId: string, messageId: string) => void
  setActiveConversation: (id: string | null) => void
  setConversationMemoryScope: (id: string, scope?: string) => void
  /** Toggle the active persona on/off for a specific chat — mirrors the
   *  mobile chat's `personaEnabled` flag so the user can suppress the
   *  persona's systemPrompt without changing the global Settings
   *  selection. */
  setConversationPersonaEnabled: (id: string, enabled: boolean) => void
  /** GH #170: the persona THIS chat speaks as, picked in its Plugins menu.
   *  Records the id and refreshes the kept copy of the prompt. */
  setConversationPersona: (id: string, persona: Persona) => void
  /** R5-10/R5-11 (3.0.1-Liste): merge sampling values into ONE chat. Only the
   *  keys in the patch move, the rest keep whatever the chat already had,
   *  which is how "send only what THIS chat changed" survives a second visit
   *  to the popup. */
  setConversationSampling: (id: string, patch: SamplingOverrides) => void
  /** Delete this chat's own sampling values entirely (the popup's Reset),
   *  so it goes back to following the Settings page instead of pinning
   *  today's defaults into the conversation forever. */
  resetConversationSampling: (id: string) => void
  /** GH #198: replace this chat's custom sampling rows. An empty list
   *  deletes the field, so the chat follows its persona's rows again. */
  setConversationCustomParams: (id: string, rows: CustomParam[]) => void
  /** Group chat v1: the models that answer in turn (capped at 4). */
  setGroupModels: (id: string, models: string[]) => void
  /** Group chat: the persona ONE participant speaks as in this chat, or
   *  `null` to let it follow the chat's own persona setting again. */
  setGroupPersona: (id: string, model: string, personaId: string | null) => void
  /** Group chat (GH #200): who sits out the next round. An empty list takes
   *  the pick away. */
  setGroupSitOut: (id: string, models: string[]) => void
  /** Write the model the open chat is actually running on.
   *
   *  Befund 4 of the abnahme counter-check (2026-08-29): switching the model
   *  mid-chat left conversation.model on whatever was picked when the chat
   *  was created. The saved chat said Hermes while the wire of that same turn
   *  already went to Qwen3. The request was right, the record was not, and
   *  the record is what an export, a reopened chat and every later reader see.
   *
   *  No updatedAt bump on purpose: picking a model is not activity in the
   *  chat, and bumping it would jump the chat to the top of the sidebar. */
  setActiveConversationModel: (model: string) => void
  addMessage: (conversationId: string, message: Message) => void
  /** Append a compaction record (2.6.8). Newest last; every record up to the
   *  cut is applied, not only the newest. Until 2026-09-05 only the newest one
   *  went out, and since each run deliberately summarises only what the
   *  previous one did not cover, a second compaction dropped the first
   *  section entirely. See `applyStoredCompaction`. */
  recordCompaction: (conversationId: string, record: CompactionRecord) => void
  insertMessageBefore: (conversationId: string, beforeId: string, message: Message) => void
  insertMessagesBefore: (conversationId: string, beforeId: string, messages: Message[]) => void
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void
  updateMessageThinking: (conversationId: string, messageId: string, thinking: string) => void
  updateMessageUsage: (conversationId: string, messageId: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean }) => void
  /** The summed counts of one request (lib/request-usage.ts), replaced whole. */
  updateMessageRequestUsage: (conversationId: string, messageId: string, requestUsage: RequestUsage) => void
  updateMessageFinishReason: (conversationId: string, messageId: string, finishReason: string) => void
  /** GH #201: how much older history the request behind this answer left
   *  out, or null when it went out whole. */
  updateMessageHistoryTrim: (conversationId: string, messageId: string, trim: Message['historyTrim'] | null) => void
  /** The kind of error a run ended with, or null to take it away again. */
  updateMessageError: (conversationId: string, messageId: string, error: MessageError | null) => void
  /** How long the model thought before it answered, in milliseconds. */
  updateMessageThinkingMs: (conversationId: string, messageId: string, thinkingMs: number) => void
  /** The document passages this answer was given (Document Chat). */
  updateMessageSources: (conversationId: string, messageId: string, sources: NonNullable<Message['sources']>) => void
  /** Z36 finding 3: links in the agent answer no tool returned. */
  updateMessageUnbackedLinks: (conversationId: string, messageId: string, unbackedLinks: string[]) => void
  updateMessageAgentBlocks: (conversationId: string, messageId: string, blocks: AgentBlock[]) => void
  updateMessageArtifacts: (conversationId: string, messageId: string, artifacts: ChatArtifact[]) => void
  deleteMessagesAfter: (conversationId: string, messageId: string) => void
  /** Resend and regenerate (GH #172, #174): take `messageId` and everything
   *  after it out of the shown thread and keep it as a version, instead of
   *  deleting it. Returns the key of the fork, or null when the message is
   *  not in the chat. */
  forkFrom: (conversationId: string, messageId: string) => string | null
  /** Show another kept version ("< 1/2 >"). */
  switchFork: (conversationId: string, key: string, index: number) => void
  /** A resend that wrote nothing goes back to what was shown before. */
  restoreEmptyFork: (conversationId: string, key: string) => void
  /** "Save" on an edited user message (GH #172): new text, nothing sent,
   *  every later turn stays. */
  saveUserEdit: (conversationId: string, messageId: string, typed: string) => void
  /** GH #174: a full, independent copy of a chat, or with `endAt` a
   *  new chat that ends with that message. Opens it and returns its id. */
  duplicateConversation: (id: string, opts?: { endAt?: string }) => string | null
  /** Remove a single message by id (D#81). Leaves the rest of the thread intact,
   *  so the user can prune one line from the model's context without nuking the
   *  whole chat or truncating everything after it. */
  deleteMessage: (conversationId: string, messageId: string) => void
  getActiveConversation: () => Conversation | undefined
  searchConversations: (query: string) => Conversation[]
  /** Bulk-import conversations from an exported backup (a user 2026-06-28: the
   *  web build has no store_backup.json, so a tunnel/origin change loses chats).
   *  merge = add unseen ids + refresh ones with a newer updatedAt; existing
   *  chats are never dropped. replace = swap the whole list. Returns counts. */
  importConversations: (incoming: Conversation[], mode?: 'merge' | 'replace') => { added: number; skipped: number }
}

/**
 * Coalescing persist backend (2.6.3). Every message update — including the
 * once-per-frame flush that drives the streaming bubble — used to serialise the
 * entire chat history and queue another IndexedDB write. With images in the
 * history that was gigabytes of live strings per answer and an Out of Memory in
 * the renderer. Now the newest state is written at most once per window.
 */
const MIGRATION_HOLD = 'chat-attachment-migration'
const durableAttachments = typeof indexedDB !== 'undefined'
// Released by the first write after hydration, or right at hydration when
// there is nothing to move. See lib/backup-hold.ts.
if (durableAttachments) holdBackup(MIGRATION_HOLD)

const chatStorage = coalescedJSONStorage<ChatState>(idbStorage, {
  // Hydration first, then writes: see `ready` in coalescedStorage.ts. Without
  // it a set() during hydration (picking a model does one) wrote an empty
  // history over the real one, and a crash before the next write kept it.
  // try: a write offered while create() itself runs sees the store before its
  // binding exists, and that write is one of the ones to drop.
  ready: (): boolean => { try { return useChatStore.persist.hasHydrated() } catch { return false } },
  // Keep synchronous fallback hydration in environments without durable blobs.
  ...(durableAttachments ? {
    prepare: async (value) => {
      if (!Array.isArray(value.state?.conversations)) return value
      const conversations = await externalizeConversations(value.state.conversations)
      // Whatever could move has moved. If a disk error kept some images
      // inline, the backup goes on as it always did rather than stay held.
      if (conversations === value.state.conversations) releaseBackup(MIGRATION_HOLD)
      return conversations === value.state.conversations ? value : { ...value, state: { ...value.state, conversations } }
    },
    prepared: (before, after) => {
      releaseBackup(MIGRATION_HOLD)
      if (before === after) return
      // Replace only the exact image arrays we migrated. Streaming content,
      // deleted chats and new messages that arrived while saving win.
      const replacements = new Map(before.state.conversations.flatMap((c, ci) =>
        c.messages.flatMap((m, mi) => m.images && m.images !== after.state.conversations[ci].messages[mi].images
          ? [[m.images, after.state.conversations[ci].messages[mi].images] as const] : [])))
      useChatStore.setState(state => ({ conversations: state.conversations.map(c => ({ ...c,
        messages: c.messages.map(m => m.images && replacements.has(m.images) ? { ...m, images: replacements.get(m.images) } : m),
      })) }))
    },
  } : {}),
})

/**
 * Write the chat history out NOW instead of waiting for the coalescing window.
 * Call it when a turn finishes: an IndexedDB write cannot complete during
 * unload, so the only reliable durability point is the moment the answer is
 * complete, not the moment the user closes the app.
 */
export function flushChatPersist(): Promise<void> {
  return chatStorage.flush()
}

/**
 * A phone writes the chat the moment the user's message is in it.
 *
 * Finding N2 (iPhone review): a new chat, the app killed 2 to 2.4 s after the
 * first send, and the whole chat was gone without a word. The answer was
 * streaming, so the store changed every frame and the coalescing window only
 * wrote at its 2 s cap; a kill before that write had landed took the chat and
 * the question with it. The sweep of interrupted runs can put a half answer
 * back (lib/partial-answer-checkpoint.ts), but only into a chat that exists.
 *
 * So the write is started in the same tick as the message, before any hook
 * goes on to wait for a model slot or to send the request. It is one write per
 * question, not one per token. The desktop keeps its window: its process ends
 * through pagehide, where the store is flushed.
 */
function flushQuestionOnPhone(): void {
  if (!isMobile()) return
  const write = chatStorage.flush().catch(() => {})
  questionWrite = write
  void write.then(() => { if (questionWrite === write) questionWrite = null })
}

/** The write the last question started, while it has not landed (phone only). */
let questionWrite: Promise<void> | null = null

/** The longest a send waits for the write of its question. */
export const QUESTION_WRITE_MAX_MS = 300

/**
 * Resolves when the write of the last question has landed, or after
 * `maxMs`, whichever comes first.
 *
 * The rest of finding N2: the write was started in the tick of the message,
 * but nothing waited for it, and a kill in the milliseconds until it landed
 * still took the question along. The sending hooks of the phone wait here
 * before they ask a model. The cap is what keeps a storage that hangs from
 * ever holding a send back: after it the request goes out and the write
 * lands when it lands. Never rejects. Resolves at once when no such write is
 * on its way, which is always the case on a desktop.
 */
export function questionOnDisk(maxMs: number = QUESTION_WRITE_MAX_MS): Promise<void> {
  const write = questionWrite
  if (!write) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const cap = setTimeout(resolve, maxMs)
    void write.then(() => {
      clearTimeout(cap)
      resolve()
    })
  })
}

/** Verify the explicit project save instead of trusting a best-effort flush. */
export async function persistConversationMemoryScope(id: string, scope?: string): Promise<boolean> {
  try {
    await flushChatPersist()
    const stored = await idbStorage.getItem('chat-conversations')
    if (!stored) return false
    const conversations = prop(prop(JSON.parse(stored), 'state'), 'conversations')
    if (!Array.isArray(conversations)) return false
    return conversations.some(c => prop(c, 'id') === id && prop(c, 'memoryScope') === scope)
  } catch {
    return false
  }
}

// Best effort on the way out — the browser may not give the write time to
// land, which is exactly why it is not the primary durability mechanism.
// pagehide is what actually fires on close in a webview; visibilitychange
// covers a minimise/background the OS never lets return.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pagehide', () => { void chatStorage.flush() })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void chatStorage.flush()
  })
}

/**
 * Die Titel, die eine Konversation TRAEGT, bis sie einen eigenen bekommt.
 *
 * Sie stehen hier als Konstanten und nicht als Literale an den beiden
 * Verwendungsstellen, weil genau ihr Auseinanderlaufen der Fehler war:
 * `createConversation` vergab fuer den Code-Modus 'Coding Agent',
 * `addMessage` benannte aber nur um, wenn der Titel exakt 'New Chat' war.
 * Eine Code-Sitzung startete also mit einem Namen, den die Umbenennung nicht
 * kannte, und behielt ihn fuer immer — zehn Sitzungen hiessen zehnmal gleich
 * und waren in der Seitenleiste nur am Datum auseinanderzuhalten.
 *
 * Am 02.09.2026: "Code bereich heisst im Chat immer nur Coding Chat. da
 * brauchen wir das selbe verhalten wie im normalen Chat, das sauber erkennbar
 * ist, welche Session, welche war."
 */
const NEW_CHAT_TITLE = 'New Chat'
const CODEX_DEFAULT_TITLE = 'Coding Agent'

/**
 * Traegt diese Konversation noch den Namen ihrer Gattung?
 *
 * Nur dann darf die erste Nutzernachricht ihn ersetzen. Wer selbst umbenannt
 * hat, behaelt seinen Namen — das ist der Fall, an dem eine zu grosszuegige
 * Bedingung zerbraeche.
 *
 * Remote ist ABSICHTLICH nicht dabei: 'Remote Chat 1', '… 2', '… 3' tragen
 * eine laufende Nummer und sind damit bereits unterscheidbar, was der Grund
 * fuer die Nummerierung war. Die Auslassung ist eine Entscheidung, kein
 * vergessener Fall, und code-sessions-heissen-verschieden.test.ts haelt sie
 * fest, damit sie es bleibt.
 */
/**
 * The name a chat takes from its first user message.
 *
 * A message with attached files carries their summaries in `content`, for the
 * model. The title comes from what the user typed, and when nothing was typed
 * from the name of the first file, never from a hex dump.
 */
function titleFromMessage(message: Message): string {
  // The phone shows the title in a list line, where Markdown marks read as noise (F1 of short check 7); the desktop keeps the raw start.
  const cut = (text: string) => (isMobile() ? plainChatTitle(text, 50) : text.slice(0, 50))
  if (!message.files?.length) return cut(message.content)
  const typed = (message.displayContent ?? '').trim()
  return typed && typed !== FILE_ONLY_TEXT ? cut(typed) : message.files[0].name.slice(0, 50)
}

function isStillDefaultTitle(title: string): boolean {
  return title === NEW_CHAT_TITLE || title === CODEX_DEFAULT_TITLE
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,

      createConversation: (model, systemPrompt, mode, opts) => {
        const id = uuid()
        // Character card chats: plain chats only, never Code, Remote or the
        // agent entry points (they do not pass a persona).
        const rp = (mode ?? 'lu') === 'lu' && opts?.persona ? cardChatStart(opts.persona) : null
        // Auto-number remote chats so users can distinguish sessions in the sidebar
        let title: string
        // 'codex' is the internal back-compat mode id; the user-facing
        // default title is "Coding Agent".
        if (mode === 'codex') title = CODEX_DEFAULT_TITLE
        else if (mode === 'remote') {
          const state = get()
          const nextNum = state.conversations.filter((c) => c.mode === 'remote').length + 1
          title = `Remote Chat ${nextNum}`
        } else title = NEW_CHAT_TITLE
        const conversation: Conversation = {
          id,
          title,
          messages: rp && rp.greetings.length
            ? [{
                id: uuid(),
                role: 'assistant',
                content: rp.greetings[0],
                timestamp: Date.now(),
                // Also with one greeting: the field marks the opening
                // message, which has no user turn to regenerate from.
                greetings: rp.greetings,
                greetingIndex: 0,
              }]
            : [],
          model,
          systemPrompt: rp ? rp.systemPrompt : systemPrompt,
          mode: mode || 'lu',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          // Per the owner's request: persona starts OFF by default on every
          // new conversation. The user has to flip it on explicitly via
          // the Plugins dropdown toggle. Without this, a globally
          // selected persona (e.g. "Devil's Advocate") would silently
          // hijack every new chat — including agent / codex tasks where
          // the persona conflicts with the autonomy contract.
          // A character card chat is the exception: the user picked a
          // character to talk to, and its greeting would make no sense
          // without its prompt.
          personaEnabled: !!rp,
          // GH #170: the chat remembers WHICH persona it started with, so a
          // later pick in the Plugins menu of this chat can replace it.
          ...(opts?.persona ? { personaId: opts.persona.id } : {}),
          // "Share new chats with paired phones" (CHATS-V1.md).
          ...(useSettingsStore.getState().settings.shareNewChatsWithPhone ? { remoteShared: true } : {}),
        }
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }))
        return id
      },

      deleteConversation: (id) => {
        // Stop any in-flight turn (chat stream OR agent loop) for this chat
        // BEFORE dropping it, so deleting/closing a chat halts its activity
        // completely — no orphaned stream burning tokens / GPU after the chat
        // is gone (2026-06-15).
        try { useGenerationStore.getState().abortConversation(id) } catch { /* best-effort */ }
        // If this is the dispatched Remote chat, deleting/closing it must also
        // tear down the whole Remote session — stop the axum server AND kill
        // the Cloudflare tunnel/cloudflared process (2026-06-15: closing
        // the remote chat has to stop *everything*, not leave the server +
        // tunnel running in the background). undispatch() → stopServer() →
        // stop_remote_server (taskkill /T /F on the tunnel PID + abort serve).
        try {
          const remote = useRemoteStore.getState()
          if (remote.dispatchedConversationId === id) {
            void remote.undispatch()
          }
        } catch { /* best-effort */ }
        dropConversationSideState(id)
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          activeConversationId:
            state.activeConversationId === id ? null : state.activeConversationId,
        }))
      },

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        })),

      setRemoteShared: (id, shared) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== id) return c
            const { remoteShared: _, ...rest } = c
            return shared ? { ...rest, remoteShared: true } : rest
          }),
        })),

      markFromPhone: (conversationId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => c.id !== conversationId ? c : {
            ...c,
            messages: c.messages.map((m) => (m.id === messageId ? { ...m, fromPhone: true as const } : m)),
          }),
        })),

      setActiveConversation: (id) => set({ activeConversationId: id }),
      setConversationMemoryScope: (id, scope) => {
        const value = scope?.trim()
        if (value && value.length > 128) return
        set(state => ({
          conversations: state.conversations.map(c => c.id === id
            ? { ...c, memoryScope: value || undefined, updatedAt: Date.now() } : c),
        }))
      },

      selectGreeting: (conversationId, messageId, index) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const at = c.messages.findIndex((m) => m.id === messageId)
            const msg = c.messages[at]
            if (!msg?.greetings || index < 0 || index >= msg.greetings.length) return c
            // Only while the greeting is still the last word: after the user
            // answered, swapping it would rewrite what they answered to.
            if (c.messages.slice(at + 1).some((m) => !m.hidden && m.role !== 'system')) return c
            const messages = c.messages.slice()
            messages[at] = { ...msg, content: msg.greetings[index], greetingIndex: index }
            return { ...c, messages }
          }),
        })),

      setConversationPersonaEnabled: (id, enabled) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, personaEnabled: enabled } : c
          ),
        })),

      setConversationPersona: (id, persona) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id
              ? { ...c, personaId: persona.id, systemPrompt: personaPromptOf(persona), updatedAt: Date.now() }
              : c
          ),
        })),

      setConversationSampling: (id, patch) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id
              ? { ...c, sampling: { ...c.sampling, ...clampSampling(patch) }, updatedAt: Date.now() }
              : c
          ),
        })),

      setConversationCustomParams: (id, rows) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== id) return c
            const clean = cleanCustomParams(rows)
            const next: Conversation = { ...c, customParams: clean, updatedAt: Date.now() }
            if (clean.length === 0) delete next.customParams
            return next
          }),
        })),

      resetConversationSampling: (id) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== id) return c
            const next = { ...c, updatedAt: Date.now() }
            delete next.sampling
            // GH #198: the chat's custom rows are its own values too.
            delete next.customParams
            return next
          }),
        })),

      setGroupModels: (id, models) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== id) return c
            const groupModels = models.slice(0, 4)
            const next = { ...c, groupModels, updatedAt: Date.now() }
            // A model that left the group takes its persona pick with it, so
            // the pick does not come back as a surprise when the model is
            // added again weeks later.
            const kept = Object.entries(c.groupPersonas ?? {}).filter(([model]) => groupModels.includes(model))
            if (kept.length > 0) next.groupPersonas = Object.fromEntries(kept)
            else delete next.groupPersonas
            // GH #169: the turns it wrote keep the persona it played, so that
            // persona stays their author once another model takes it over.
            const leaving = Object.entries(c.groupPersonas ?? {}).filter(([model]) => !groupModels.includes(model))
            if (leaving.length > 0) next.messages = stampGroupPersonas(c.messages, Object.fromEntries(leaving))
            // GH #200: a member that left cannot sit out a round either.
            const sitOut = (c.groupSitOut ?? []).filter((m) => groupModels.includes(m))
            if (sitOut.length > 0) next.groupSitOut = sitOut
            else delete next.groupSitOut
            return next
          }),
        })),

      setGroupSitOut: (id, models) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== id) return c
            const sitOut = models.filter((m) => c.groupModels?.includes(m))
            const next = { ...c }
            if (sitOut.length > 0) next.groupSitOut = sitOut
            else delete next.groupSitOut
            return next
          }),
        })),

      setGroupPersona: (id, model, personaId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== id) return c
            const personas = { ...(c.groupPersonas ?? {}) }
            const before = personas[model]
            if (personaId) personas[model] = personaId
            else delete personas[model]
            const next = { ...c, updatedAt: Date.now() }
            // GH #169: what this model wrote as its previous persona stays that
            // persona's. A model that had none hands its older turns to the new
            // one, which is the only way to give turns from before personas
            // existed an author.
            if (before && before !== personaId) next.messages = stampGroupPersonas(c.messages, { [model]: before })
            // No pick left: the field goes, so the chat is stored exactly as a
            // group from before this feature.
            if (Object.keys(personas).length > 0) next.groupPersonas = personas
            else delete next.groupPersonas
            return next
          }),
        })),

      setActiveConversationModel: (model) =>
        set((state) => {
          const id = state.activeConversationId
          if (!id || !model) return state
          const open = state.conversations.find((c) => c.id === id)
          if (!open || open.model === model) return state
          return {
            conversations: state.conversations.map((c) =>
              c.id === id ? { ...c, model } : c
            ),
          }
        }),

      recordCompaction: (conversationId, record) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              // updatedAt deliberately NOT touched: a compaction changes what
              // is SENT, not what the user wrote, and bumping it would reorder
              // the sidebar as if the chat had new activity.
              ? { ...c, compactions: [...(c.compactions ?? []), record] }
              : c
          ),
        })),

      addMessage: (conversationId, message) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: [...c.messages, message],
                updatedAt: Date.now(),
                title:
                  isStillDefaultTitle(c.title) && message.role === 'user'
                    ? titleFromMessage(message)
                    : c.title,
              }
              : c
          ),
        }))
        // A question is on its way to the disk before anything asks a model
        // (phone only, see flushQuestionOnPhone).
        if (message.role === 'user') flushQuestionOnPhone()
      },

      insertMessageBefore: (conversationId, beforeId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const idx = c.messages.findIndex((m) => m.id === beforeId)
            if (idx < 0) return { ...c, messages: [...c.messages, message], updatedAt: Date.now() }
            const msgs = [...c.messages]
            msgs.splice(idx, 0, message)
            return { ...c, messages: msgs, updatedAt: Date.now() }
          }),
        })),

      // Batch variant (audit E2): the Codex run-end used to insert its whole
      // tool history in a loop, one set() per message — several hundred store
      // updates back to back, each cloning the conversation array while the
      // coalesced persist serialised behind it. That was the visible hang at
      // the end of a long run. One set(), one clone, one persist.
      insertMessagesBefore: (conversationId, beforeId, messages) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const idx = c.messages.findIndex((m) => m.id === beforeId)
            const msgs = [...c.messages]
            if (idx < 0) msgs.push(...messages)
            else msgs.splice(idx, 0, ...messages)
            return { ...c, messages: msgs, updatedAt: Date.now() }
          }),
        })),

      updateMessageContent: (conversationId, messageId, content) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageThinking: (conversationId, messageId, thinking) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, thinking } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageUsage: (conversationId, messageId, usage) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, usage } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageRequestUsage: (conversationId, messageId, requestUsage) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, requestUsage } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageSources: (conversationId, messageId, sources) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, sources } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageFinishReason: (conversationId, messageId, finishReason) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, finishReason } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageHistoryTrim: (conversationId, messageId, trim) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m
                if (trim && trim.dropped > 0) return { ...m, historyTrim: trim }
                if (!m.historyTrim) return m
                const next = { ...m }
                delete next.historyTrim
                return next
              }),
            }
          }),
        })),

      updateMessageError: (conversationId, messageId, error) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => {
                  if (m.id !== messageId) return m
                  if (error) return { ...m, error }
                  const { error: _gone, ...rest } = m
                  void _gone
                  return rest
                }),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageThinkingMs: (conversationId, messageId, thinkingMs) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, thinkingMs } : m)),
              }
              : c
          ),
        })),

      updateMessageUnbackedLinks: (conversationId, messageId, unbackedLinks) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, unbackedLinks } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageAgentBlocks: (conversationId, messageId, agentBlocks) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, agentBlocks } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      updateMessageArtifacts: (conversationId, messageId, artifacts) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.map((m) => (m.id === messageId ? { ...m, artifacts } : m)),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

      deleteMessagesAfter: (conversationId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const idx = c.messages.findIndex((m) => m.id === messageId)
            if (idx < 0) return c
            return { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() }
          }),
        })),

      deleteMessage: (conversationId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            // A fork keyed by this message moves to the one before it first,
            // or its kept versions would hang off a message that is gone.
            const kept = forgetForkKey(c, messageId)
            return {
              ...kept,
              messages: kept.messages.filter((m) => m.id !== messageId),
              updatedAt: Date.now(),
            }
          }),
        })),

      forkFrom: (conversationId, messageId) => {
        const conv = get().conversations.find((c) => c.id === conversationId)
        const at = conv ? conv.messages.findIndex((m) => m.id === messageId) : -1
        if (!conv || at < 0) return null
        const key = forkKeyAt(conv.messages, at)
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...forkFrom(c, messageId), updatedAt: Date.now() } : c
          ),
        }))
        return key
      },

      // No updatedAt bump: looking at another version is not activity, and
      // the bump would move the chat to the top of the sidebar.
      switchFork: (conversationId, key, index) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? switchFork(c, key, index) : c
          ),
        })),

      restoreEmptyFork: (conversationId, key) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? restoreEmptyFork(c, key) : c
          ),
        })),

      saveUserEdit: (conversationId, messageId, typed) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId || m.role !== 'user') return m
                const fields = savedUserEdit(m, typed)
                const next: Message = { ...m, content: fields.content }
                if (fields.displayContent === undefined) delete next.displayContent
                else next.displayContent = fields.displayContent
                return next
              }),
              updatedAt: Date.now(),
            }
          }),
        })),

      duplicateConversation: (id, opts) => {
        const conv = get().conversations.find((c) => c.id === id)
        if (!conv) return null
        const copy = copyConversation(conv, uuid(), {
          endAt: opts?.endAt,
          title: `${conv.title} (${opts?.endAt ? 'branch' : 'copy'})`,
          now: Date.now(),
        })
        if (!copy) return null
        // Side state first, so the chat opens with its Agent switch and its
        // documents already in place.
        copyConversationSideState(id, copy.id, { withTodos: !opts?.endAt })
        set((state) => ({
          conversations: [copy, ...state.conversations],
          activeConversationId: copy.id,
        }))
        return copy.id
      },

      getActiveConversation: () => {
        const { conversations, activeConversationId } = get()
        return conversations.find((c) => c.id === activeConversationId)
      },

      searchConversations: (query) => {
        const { conversations } = get()
        const lower = query.toLowerCase()
        return conversations.filter(
          (c) =>
            c.title.toLowerCase().includes(lower) ||
            c.messages.some((m) => m.content.toLowerCase().includes(lower))
        )
      },

      importConversations: (incoming, mode = 'merge') => {
        // Normalize legacy block shapes on the way in (the same migration the
        // persist layer runs on load), so an older export hydrates cleanly.
        // It mutates the array it is handed and returns the same object, so
        // `incoming` IS the normalised list afterwards — no cast needed, and
        // the old `?? incoming` fallback could never fire.
        migratePersistedChat({ conversations: incoming })
        const clean = incoming
        let added = 0
        let skipped = 0
        set((state) => {
          if (mode === 'replace') {
            added = clean.length
            return { conversations: [...clean].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) }
          }
          const byId = new Map(state.conversations.map((c) => [c.id, c]))
          for (const conv of clean) {
            const existing = byId.get(conv.id)
            if (!existing) {
              byId.set(conv.id, conv)
              added++
            } else if ((conv.updatedAt || 0) > (existing.updatedAt || 0)) {
              byId.set(conv.id, conv) // imported copy is newer → refresh it
              added++
            } else {
              skipped++ // already present and not newer
            }
          }
          const merged = Array.from(byId.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          return { conversations: merged }
        })
        return { added, skipped }
      },
    }),
    {
      name: 'chat-conversations',
      // IndexedDB (disk-backed, tens of GB) instead of localStorage's ~5 MB cap —
      // chat history with inline images needs the room. idbStorage migrates existing
      // localStorage data on first read. coalescedJSONStorage does the object<->string
      // (de)serialisation createJSONStorage used to do (zustand v5 wants a
      // PersistStorage; a raw StateStorage → "[object Object]", see FIX-3), and adds
      // the write coalescing this store needs.
      storage: chatStorage,
      // Phase 1 (v2.4.0) — rehydrate legacy singular `toolCall` into `toolCalls[]`.
      // Persisted shape is whatever was last written; migration runs on every load
      // and is idempotent, so version bumps are not required.
      //
      // Deliberately still NO `version` here, and the 2.6.8 audit's argument for
      // adding one does not survive contact with zustand 5.0.12. It assumed an
      // unversioned store writes no version, so a later `version: 1` would find
      // `undefined` and skip migrate for every existing user. It writes 0 —
      // `version: 0` is persistImpl's own default and it goes into the blob — and
      // a v0 blob DOES reach a migrate declared at 1. See persist-version.ts for
      // the executable proof.
      //
      // Adding a number is not free either: an older build declaring no version
      // reads its own 0, sees a blob at 1, has no migrate, and throws the entire
      // chat history away. That is the R1 DOWNGRADE-KONTRAKT (see codexStore) —
      // 2.6.x builds share one WebView profile — so stamping a number here would
      // buy nothing and cost a reset on every downgrade.
      merge: (persistedState, currentState) => {
        const migrated = migratePersistedChat(persistedState)
        const merged = { ...currentState, ...(isRecord(migrated) ? migrated : {}) }
        // The app starts in the Chat tab; see activeConversationAtStart.
        return { ...merged, activeConversationId: activeConversationAtStart(merged.conversations, merged.activeConversationId) }
      },
    }
  )
)

/**
 * After hydration, move a legacy history's images out through the ordinary
 * write path. Nothing here blocks the app: the chats are on screen already,
 * the old value stays on disk untouched until the lighter one has landed, and
 * an interruption at any point leaves one of the two complete.
 */
function afterHydration(): void {
  if (!durableAttachments) return
  const state = useChatStore.getState()
  if (!hasInlineImages(state.conversations)) {
    releaseBackup(MIGRATION_HOLD)
    return
  }
  const { name, version, partialize } = useChatStore.persist.getOptions()
  if (!name) return
  const persisted = (partialize ? partialize({ ...state }) : { ...state }) as ChatState
  void chatStorage.setItem(name, { state: persisted, version })
}
if (useChatStore.persist.hasHydrated()) afterHydration()
else useChatStore.persist.onFinishHydration(afterHydration)
