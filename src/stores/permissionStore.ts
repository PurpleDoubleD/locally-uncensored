import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import type { PermissionMap, PermissionLevel, ToolCategory } from '../api/mcp/types'
import { DEFAULT_PERMISSIONS } from '../api/mcp/types'
import { isRecord, prop, asString } from '../types/json-guards'

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
    {
      name: 'locally-uncensored-permissions',
      storage: safeJSONStorage(),
      version: 3,
      migrate: migratePermissionState,
    }
  )
)

/** v2 (v2.5.3): video generation went live — the category was 'blocked'
 *  AND UI-locked since 2026-06-04, so a persisted 'blocked' can only be the
 *  old default, never a user's choice (the toggle was disabled). Lift exactly
 *  that value to the new default; everything else persists. Exported for
 *  direct unit-testing (the persist internals aren't reachable in vitest). */
export function migratePermissionState(persisted: unknown, version: number): PermissionState {
  // Foreign at read time — an older build wrote this. A read that throws in a
  // migrate costs the whole store: zustand abandons hydration and the next
  // write persists the empty default over the blob.
  const globals = prop(persisted, 'globalPermissions')
  if (version < 2 && isRecord(globals) && globals.video === 'blocked') {
    globals.video = DEFAULT_PERMISSIONS.video
  }
  // v3 (2.6.6 tool merge): the typed shell wrappers are gone, their calls run
  // through shell_execute now. A per-tool override on a retired name would be
  // silently dead, so lift the overrides onto shell_execute. Most restrictive
  // wins: a user who forced confirmation on git_push keeps that protection on
  // the tool the push actually runs through.
  const overrides = prop(persisted, 'perToolOverrides')
  if (version < 3 && isRecord(overrides)) {
    // Frozen copy of the names retired in 2.6.6, NOT imported from
    // builtin-tools: a migration describes the past and must not drift with
    // the live registry (and the import would drag the whole tool module
    // into store init).
    const RETIRED_V3 = [
      'git_status', 'git_log', 'git_diff', 'git_commit', 'git_push',
      'run_tests', 'gh_pr_create', 'project_init', 'code_execute',
      'system_info', 'process_list', 'get_current_time',
      'shell_execute_background', 'shell_task_status', 'shell_task_kill', 'shell_task_list',
    ]
    const RANK: Record<string, number> = { auto: 0, confirm: 1, blocked: 2 }
    let strictest: string | undefined
    for (const name of RETIRED_V3) {
      const level = asString(overrides[name])
      if (!level) continue
      delete overrides[name]
      if (strictest === undefined || (RANK[level] ?? 0) > (RANK[strictest] ?? 0)) strictest = level
    }
    if (strictest !== undefined) {
      const own = asString(overrides['shell_execute'])
      if (own === undefined || (RANK[strictest] ?? 0) > (RANK[own] ?? 0)) {
        overrides['shell_execute'] = strictest
      }
    }
  }
  // zustand types migrate as returning the FULL store, but a blob only ever
  // carries the partialized slice and `merge` puts the actions back.
  return persisted as PermissionState
}

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
