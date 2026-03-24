import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuid } from 'uuid'
import type { Conversation, Message } from '../types/chat'

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  createConversation: (model: string, systemPrompt: string) => string
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setActiveConversation: (id: string | null) => void
  addMessage: (conversationId: string, message: Message) => void
  updateMessageContent: (conversationId: string, messageId: string, content: string) => void
  updateMessageThinking: (conversationId: string, messageId: string, thinking: string) => void
  getActiveConversation: () => Conversation | undefined
  searchConversations: (query: string) => Conversation[]
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,

      createConversation: (model, systemPrompt) => {
        const id = uuid()
        const conversation: Conversation = {
          id,
          title: 'New Chat',
          messages: [],
          model,
          systemPrompt,
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
    { name: 'chat-conversations' }
  )
)
