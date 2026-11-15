/**
 * The commands the user said "always allow here" for (CA K4).
 *
 * Keyed by scope: a picked folder's path, or `chat:<id>` for a chat that works
 * in its own sandbox folder. Rules never cross folders: `npm test` allowed in
 * one project asks again in the next one. The pure matching lives in
 * lib/agent-core/command-rules.ts.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { safeJSONStorage } from '../lib/storage-quota'
import { commandAllowedByRules } from '../lib/agent-core/command-rules'

/** More than this per folder is a list nobody reads any more. */
export const MAX_RULES_PER_SCOPE = 50

interface CommandRulesState {
  rules: Record<string, string[]>
  allow: (scope: string, rule: string) => void
  remove: (scope: string, rule: string) => void
  clearScope: (scope: string) => void
}

export const useCommandRulesStore = create<CommandRulesState>()(
  persist(
    (set) => ({
      rules: {},
      allow: (scope, rule) =>
        set((s) => {
          const r = rule.trim()
          if (!scope || !r) return s
          const list = s.rules[scope] ?? []
          if (list.includes(r)) return s
          return { rules: { ...s.rules, [scope]: [...list, r].slice(-MAX_RULES_PER_SCOPE) } }
        }),
      remove: (scope, rule) =>
        set((s) => {
          const list = (s.rules[scope] ?? []).filter((x) => x !== rule)
          const next = { ...s.rules }
          if (list.length) next[scope] = list
          else delete next[scope]
          return { rules: next }
        }),
      clearScope: (scope) =>
        set((s) => {
          const next = { ...s.rules }
          delete next[scope]
          return { rules: next }
        }),
    }),
    {
      name: 'locally-uncensored-command-rules',
      storage: safeJSONStorage(),
      version: 1,
      // First version: nothing older to carry over.
      migrate: (persisted) => persisted as CommandRulesState,
      partialize: (s) => ({ rules: s.rules }),
    },
  ),
)

/** The scope a run's rules live under. */
export function ruleScope(workspace: { kind?: string; path?: string } | null | undefined, conversationId: string | null | undefined): string | null {
  if (workspace?.kind === 'folder' && workspace.path) return workspace.path
  return conversationId ? `chat:${conversationId}` : null
}

/** Is this shell command covered by a rule of this scope? */
export function commandAllowedHere(scope: string | null, command: unknown): boolean {
  if (!scope || typeof command !== 'string' || !command.trim()) return false
  return commandAllowedByRules(command, useCommandRulesStore.getState().rules[scope] ?? [])
}
