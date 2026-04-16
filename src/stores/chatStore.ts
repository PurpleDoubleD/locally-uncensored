import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { Conversation, Message } from '../types/chat'
import type { AgentBlock } from '../types/agent-mode'
import { createSafeStorage } from '../lib/storage-quota'
import { migrateBlockInPlace } from '../api/agents/block-helpers'

/**
 * Rehydration migration for Phase 1 (v2.4.0) — wraps legacy
 * `AgentBlock.toolCall` (singular) into the new `toolCalls: AgentToolCall[]`
 * form. Idempotent: safe to run on already-migrated data. Leaves the legacy
 * field in place during a transition window so reads via either shape work.
 */
export function migratePersistedChat(state: any): any {
  if (!state || !Array.isArray(state.conversations)) return state
  for (const conv of state.conversations) {
    if (!conv || !Array.isArray(conv.messages)) continue
    for (const msg of conv.messages) {
      if (!msg || !Array.isArray(msg.agentBlocks)) continue
      for (const block of msg.agentBlocks as AgentBlock[]) {
        if (block) migrateBlockInPlace(block)
      }
    }
  }
  return state
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  createConversation: (model: string, systemPrompt: string, mode?: 'lu' | 'codex' | 'openclaw' | 'claude-code' | 'remote') => string
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setActiveConversation: (id: string | null) => void
  addMessage: (conversationId: string, message: Message) => void
  insertMessageBefore: (conversationId: string, beforeId: string, message: Message) => void
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void
  updateMessageThinking: (conversationId: string, messageId: string, thinking: string) => void
  updateMessageAgentBlocks: (conversationId: string, messageId: string, blocks: AgentBlock[]) => void
  deleteMessagesAfter: (conversationId: string, messageId: string) => void
  getActiveConversation: () => Conversation | undefined
  searchConversations: (query: string) => Conversation[]
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
        if (mode === 'codex') title = 'Codex Chat'
        else if (mode === 'claude-code') title = 'Claude Code'
        else if (mode === 'remote') {
          const state = get()
          const nextNum = state.conversations.filter((c) => c.mode === 'remote').length + 1
          title = `Remote Chat ${nextNum}`
        } else title = 'New Chat'
        const conversation: Conversation = {
          id,
          title,
          messages: [],
          model,
          systemPrompt,
          mode: mode || 'lu',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          activeConversationId: id,
        }))
        return id
      },

      deleteConversation: (id) =>
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          activeConversationId:
            state.activeConversationId === id ? null : state.activeConversationId,
        })),

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        })),

      setActiveConversation: (id) => set({ activeConversationId: id }),

      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                ...c,
                messages: [...c.messages, message],
                updatedAt: Date.now(),
                title:
                  c.title === 'New Chat' && message.role === 'user'
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

      deleteMessagesAfter: (conversationId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const idx = c.messages.findIndex((m) => m.id === messageId)
            if (idx < 0) return c
            return { ...c, messages: c.messages.slice(0, idx), updatedAt: Date.now() }
          }),
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
    }),
    {
      name: 'chat-conversations',
      storage: createSafeStorage(),
      // Phase 1 (v2.4.0) — rehydrate legacy singular `toolCall` into `toolCalls[]`.
      // Persisted shape is whatever was last written; migration runs on every load
      // and is idempotent, so version bumps are not required.
      merge: (persistedState: any, currentState: ChatState) => {
        const migrated = migratePersistedChat(persistedState)
        return { ...currentState, ...(migrated || {}) }
      },
    }
  )
)
