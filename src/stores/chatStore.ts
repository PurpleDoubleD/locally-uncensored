import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { Conversation, Message, ChatArtifact, CompactionRecord } from '../types/chat'
import type { AgentBlock } from '../types/agent-mode'
import { idbStorage } from '../lib/idbStorage'
import { coalescedJSONStorage } from '../lib/coalescedStorage'
import { migrateBlockInPlace } from '../api/agents/block-helpers'
import { useGenerationStore } from './generationStore'
import { useRemoteStore } from './remoteStore'
import { useRAGStore } from './ragStore'
import { useTodoStore } from './todoStore'
import { usePermissionStore } from './permissionStore'
import { useStagedChangesStore } from './stagedChangesStore'
import { useCodexStore } from './codexStore'
import { useAgentTaskStore } from './agentTaskStore'
import { log } from '../lib/logger'
import { isRecord, prop } from '../types/json-guards'

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
    const messages = prop(conv, 'messages')
    if (!Array.isArray(messages)) continue
    for (const msg of messages) {
      const blocks = prop(msg, 'agentBlocks')
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        // migrateBlockInPlace reads `toolCall` and `toolCalls` and writes
        // `toolCalls`; the cast claims no more than those three, and the
        // record check above is what makes even that much true.
        if (isRecord(block)) migrateBlockInPlace(block as unknown as AgentBlock)
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

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  createConversation: (model: string, systemPrompt: string, mode?: 'lu' | 'codex' | 'openclaw' | 'remote') => string
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setActiveConversation: (id: string | null) => void
  /** Toggle the active persona on/off for a specific chat — mirrors the
   *  mobile chat's `personaEnabled` flag so the user can suppress the
   *  persona's systemPrompt without changing the global Settings
   *  selection. */
  setConversationPersonaEnabled: (id: string, enabled: boolean) => void
  /** Group chat v1: the models that answer in turn (capped at 4). */
  setGroupModels: (id: string, models: string[]) => void
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
  /** Append a compaction record (2.6.8). Newest last; only the newest is applied. */
  recordCompaction: (conversationId: string, record: CompactionRecord) => void
  insertMessageBefore: (conversationId: string, beforeId: string, message: Message) => void
  insertMessagesBefore: (conversationId: string, beforeId: string, messages: Message[]) => void
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void
  updateMessageThinking: (conversationId: string, messageId: string, thinking: string) => void
  updateMessageUsage: (conversationId: string, messageId: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean }) => void
  updateMessageFinishReason: (conversationId: string, messageId: string, finishReason: string) => void
  /** Z36 finding 3: links in the agent answer no tool returned. */
  updateMessageUnbackedLinks: (conversationId: string, messageId: string, unbackedLinks: string[]) => void
  updateMessageAgentBlocks: (conversationId: string, messageId: string, blocks: AgentBlock[]) => void
  updateMessageArtifacts: (conversationId: string, messageId: string, artifacts: ChatArtifact[]) => void
  deleteMessagesAfter: (conversationId: string, messageId: string) => void
  /** Remove a single message by id (D#81). Leaves the rest of the thread intact,
   *  so the user can prune one line from the model's context without nuking the
   *  whole chat or truncating everything after it. */
  deleteMessage: (conversationId: string, messageId: string) => void
  getActiveConversation: () => Conversation | undefined
  searchConversations: (query: string) => Conversation[]
  /** Bulk-import conversations from an exported backup (konata 2026-06-28: the
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
const chatStorage = coalescedJSONStorage<ChatState>(idbStorage)

/**
 * Write the chat history out NOW instead of waiting for the coalescing window.
 * Call it when a turn finishes: an IndexedDB write cannot complete during
 * unload, so the only reliable durability point is the moment the answer is
 * complete, not the moment the user closes the app.
 */
export function flushChatPersist(): Promise<void> {
  return chatStorage.flush()
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
 * David am 02.09.2026: "Code bereich heisst im Chat immer nur Coding Chat. da
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
function isStillDefaultTitle(title: string): boolean {
  return title === NEW_CHAT_TITLE || title === CODEX_DEFAULT_TITLE
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,

      createConversation: (model, systemPrompt, mode) => {
        const id = uuid()
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
          messages: [],
          model,
          systemPrompt,
          mode: mode || 'lu',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          // Per David's request: persona starts OFF by default on every
          // new conversation. The user has to flip it on explicitly via
          // the Plugins dropdown toggle. Without this, a globally
          // selected persona (e.g. "Devil's Advocate") would silently
          // hijack every new chat — including agent / codex tasks where
          // the persona conflicts with the autonomy contract.
          personaEnabled: false,
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
        // is gone (David 2026-06-15).
        try { useGenerationStore.getState().abortConversation(id) } catch { /* best-effort */ }
        // If this is the dispatched Remote chat, deleting/closing it must also
        // tear down the whole Remote session — stop the axum server AND kill
        // the Cloudflare tunnel/cloudflared process (David 2026-06-15: closing
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

      setActiveConversation: (id) => set({ activeConversationId: id }),

      setConversationPersonaEnabled: (id, enabled) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, personaEnabled: enabled } : c
          ),
        })),

      setGroupModels: (id, models) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, groupModels: models.slice(0, 4), updatedAt: Date.now() } : c
          ),
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

      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: [...c.messages, message],
                updatedAt: Date.now(),
                title:
                  isStillDefaultTitle(c.title) && message.role === 'user'
                    ? message.content.slice(0, 50)
                    : c.title,
              }
              : c
          ),
        })),

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
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: c.messages.filter((m) => m.id !== messageId),
                updatedAt: Date.now(),
              }
              : c
          ),
        })),

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
        return { ...currentState, ...(isRecord(migrated) ? migrated : {}) }
      },
    }
  )
)
