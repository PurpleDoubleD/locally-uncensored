import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SandboxLevel } from '../types/agent-mode'

interface AgentModeState {
  // Per-conversation agent mode toggle
  agentModeActive: Record<string, boolean>

  // Settings
  sandboxLevel: SandboxLevel
  tutorialCompleted: boolean
  newChatHintDismissed: boolean

  // Actions
  toggleAgentMode: (conversationId: string) => void
  setAgentModeActive: (conversationId: string, active: boolean) => void
  setSandboxLevel: (level: SandboxLevel) => void
  setTutorialCompleted: () => void
  resetTutorial: () => void
  setNewChatHintDismissed: (dismissed: boolean) => void
  isActive: (conversationId: string) => boolean
}

export const useAgentModeStore = create<AgentModeState>()(
  persist(
    (set, get) => ({
      agentModeActive: {},
      sandboxLevel: 'restricted',
      tutorialCompleted: false,
      newChatHintDismissed: false,

      toggleAgentMode: (conversationId) =>
        set((state) => ({
          agentModeActive: {
            ...state.agentModeActive,
            [conversationId]: !state.agentModeActive[conversationId],
          },
        })),

      setAgentModeActive: (conversationId, active) =>
        set((state) => ({
          agentModeActive: {
            ...state.agentModeActive,
            [conversationId]: active,
          },
        })),

      setSandboxLevel: (level) => set({ sandboxLevel: level }),

      setTutorialCompleted: () => set({ tutorialCompleted: true }),

      resetTutorial: () => set({ tutorialCompleted: false }),

      setNewChatHintDismissed: (dismissed) => set({ newChatHintDismissed: dismissed }),

      isActive: (conversationId) => {
        return get().agentModeActive[conversationId] ?? false
      },
    }),
    { name: 'locally-uncensored-agent-mode' }
  )
)
