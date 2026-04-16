import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PermissionMap, PermissionLevel, ToolCategory } from '../api/mcp/types'
import { DEFAULT_PERMISSIONS } from '../api/mcp/types'

/** Per-tool override: takes precedence over the tool's category default. */
export type ToolOverrides = Record<string, PermissionLevel>

/**
 * Agent mode scope — filters which tool categories the model can see at
 * tools[] payload construction time. v2.4.0 introduces this so the same
 * agent code can serve a read-only "chat" scope, an edit-capable "edit"
 * scope, or the full "agent" scope.
 *
 *   chat  → no filesystem-write, no terminal, no image_generate, no workflow
 *   edit  → filesystem + web only (no shell, no codegen, no comfy)
 *   agent → everything (current default behaviour)
 */
export type ModeScope = 'chat' | 'edit' | 'agent'

interface PermissionState {
  globalPermissions: PermissionMap
  conversationOverrides: Record<string, Partial<PermissionMap>>
  /** Per-tool-name override (applies to every conversation). */
  perToolOverrides: ToolOverrides
  /** Current mode scope. 'agent' preserves v2.3 behaviour. */
  modeScope: ModeScope

  // Getters
  getEffectivePermissions: (conversationId?: string) => PermissionMap
  /**
   * Effective level for a specific tool, consulting:
   *   1. perToolOverrides[toolName]   (wins if set)
   *   2. category default from getEffectivePermissions(convId)
   */
  getEffectivePermissionForTool: (
    toolName: string,
    toolCategory: ToolCategory,
    conversationId?: string
  ) => PermissionLevel

  // Setters
  setGlobalPermission: (category: ToolCategory, level: PermissionLevel) => void
  setConversationOverride: (convId: string, category: ToolCategory, level: PermissionLevel) => void
  clearConversationOverrides: (convId: string) => void
  setToolOverride: (toolName: string, level: PermissionLevel) => void
  clearToolOverride: (toolName: string) => void
  setModeScope: (scope: ModeScope) => void
  resetToDefaults: () => void
}

export const usePermissionStore = create<PermissionState>()(
  persist(
    (set, get) => ({
      globalPermissions: { ...DEFAULT_PERMISSIONS },
      conversationOverrides: {},
      perToolOverrides: {},
      modeScope: 'agent',

      getEffectivePermissions: (conversationId?) => {
        const global = get().globalPermissions
        if (!conversationId) return global
        const overrides = get().conversationOverrides[conversationId]
        if (!overrides) return global
        return { ...global, ...overrides }
      },

      getEffectivePermissionForTool: (toolName, toolCategory, conversationId?) => {
        const perTool = get().perToolOverrides[toolName]
        if (perTool) return perTool
        const categoryMap = get().getEffectivePermissions(conversationId)
        return categoryMap[toolCategory]
      },

      setGlobalPermission: (category, level) =>
        set((state) => ({
          globalPermissions: { ...state.globalPermissions, [category]: level },
        })),

      setConversationOverride: (convId, category, level) =>
        set((state) => ({
          conversationOverrides: {
            ...state.conversationOverrides,
            [convId]: {
              ...(state.conversationOverrides[convId] || {}),
              [category]: level,
            },
          },
        })),

      clearConversationOverrides: (convId) =>
        set((state) => {
          const { [convId]: _, ...rest } = state.conversationOverrides
          return { conversationOverrides: rest }
        }),

      setToolOverride: (toolName, level) =>
        set((state) => ({
          perToolOverrides: { ...state.perToolOverrides, [toolName]: level },
        })),

      clearToolOverride: (toolName) =>
        set((state) => {
          const { [toolName]: _, ...rest } = state.perToolOverrides
          return { perToolOverrides: rest }
        }),

      setModeScope: (scope) => set({ modeScope: scope }),

      resetToDefaults: () =>
        set({
          globalPermissions: { ...DEFAULT_PERMISSIONS },
          conversationOverrides: {},
          perToolOverrides: {},
          modeScope: 'agent',
        }),
    }),
    { name: 'locally-uncensored-permissions' }
  )
)

/**
 * Tool categories allowed by each mode scope (Phase 12). Keep these
 * conservative — a more permissive scope only adds categories that the
 * less permissive one already has.
 */
export const MODE_SCOPE_ALLOWED_CATEGORIES: Record<ModeScope, ReadonlyArray<ToolCategory>> = {
  // Read-only conversation: filesystem READ-style tools, web lookup, system probes.
  chat: ['web', 'system'],
  // Editing: adds filesystem writes. No shell, no codegen, no ComfyUI.
  edit: ['filesystem', 'web', 'system'],
  // Full agent: everything.
  agent: ['filesystem', 'terminal', 'desktop', 'web', 'system', 'image', 'video', 'workflow'],
}

/**
 * Given a mode scope and a tool category, return true if the category is
 * allowed at that scope. Used by tool-registry callers to filter tools[]
 * payloads before the LLM even sees them.
 */
export function modeAllowsCategory(scope: ModeScope, category: ToolCategory): boolean {
  return MODE_SCOPE_ALLOWED_CATEGORIES[scope].includes(category)
}
