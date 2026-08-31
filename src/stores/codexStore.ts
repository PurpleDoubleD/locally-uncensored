import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatMode, CodexThread, CodexEvent } from '../types/codex'
import { resolveCodexMode, type CodexMode } from '../lib/codex-mode'

/**
 * A finished plan waiting for "Approve and run" (plan 2.6.6, C1 / blocker S7).
 * `planText` is the model's FULL final answer, not the todo titles: the user is
 * approving concrete commands and target paths, and the titles alone are not a
 * basis for that.
 */
export interface CodexPlanApproval {
  planText: string
  /** Message id the plan came from, so a later run does not resurrect it. */
  messageId: string
  createdAt: number
}

/**
 * Ring size for a thread's event log.
 *
 * The log grew without a ceiling and kept every event of the session: each
 * terminal_output carries the UNTRUNCATED shell result (the 60k-char cap in
 * useCodex applies to what goes back to the MODEL, not to what is stored here)
 * and each file_change carries a full unified diff. A 200-iteration run is tens
 * of megabytes held for as long as the app is open.
 *
 * Nothing reads the CONTENT. The only consumer in the tree is CodexView, which
 * uses `events.length` as one trigger of its auto-scroll key — and that hook
 * re-pins through a ResizeObserver on every content-height change anyway, with
 * the last message's text as the other half of the key. So a length that stops
 * growing at the cap costs the pin nothing. 500 keeps the log long enough to be
 * worth having if it ever gains a real reader.
 */
const CODEX_EVENT_LOG_MAX = 500

interface CodexState {
  chatMode: ChatMode
  threads: Record<string, CodexThread>
  workingDirectory: string
  /**
   * Bump counter, incremented every time a Codex run mutates the working
   * directory (file_write, file_change, terminal commands that can modify
   * files). The explorer panel subscribes to this and reloads when it changes,
   * so new/deleted files appear without a manual refresh.
   */
  fileTreeVersion: number

  /**
   * Ask / Bypass / Plan per conversation (plan 2.6.6, C1). The ONLY persisted
   * part of the mode slice, and additive: codexStore stays at persist version 0
   * so a 2.6.5 build can read this state back without zustand discarding it
   * (R1 DOWNGRADE-KONTRAKT). A downgrade plus re-upgrade loses the conversation
   * modes and nothing else, and they fall back to settings.codexDefaultMode.
   */
  modeByConversation: Record<string, CodexMode>
  /**
   * A mode picked while a run is in flight. It does NOT touch the running turn:
   * a switch takes effect from the next send, which is what the dropdown says.
   * Transient on purpose, an app restart has no run to park anything for.
   */
  parkedModeByConversation: Record<string, CodexMode>
  /** The mode this conversation had before it went into Plan mode. */
  prePlanModeByConversation: Record<string, CodexMode>
  /** Plan finished, waiting for approval. Cleared when the run is approved. */
  planApprovalByConversation: Record<string, CodexPlanApproval>

  setChatMode: (mode: ChatMode) => void
  setWorkingDirectory: (dir: string) => void
  bumpFileTreeVersion: () => void

  /**
   * The user picked a mode in the dropdown. While a run is active the pick is
   * PARKED and applied by the next send; otherwise it lands immediately.
   */
  chooseCodexMode: (conversationId: string, mode: CodexMode, runActive: boolean) => void
  /** Apply a parked pick. Called once at the start of every send. */
  applyParkedMode: (conversationId: string) => void
  /** The conversation's mode, falling back to the global default. */
  codexModeFor: (conversationId: string | null | undefined, defaultMode: unknown) => CodexMode
  setPlanApproval: (conversationId: string, approval: CodexPlanApproval | null) => void

  getThread: (conversationId: string) => CodexThread | undefined
  initThread: (conversationId: string, workingDir: string) => string
  addEvent: (conversationId: string, event: CodexEvent) => void
  setThreadStatus: (conversationId: string, status: CodexThread['status']) => void
}

/** Drop one key from a record without leaving an undefined hole behind. */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

export const useCodexStore = create<CodexState>()(
  persist(
    (set, get) => ({
      chatMode: 'lu',
      threads: {},
      workingDirectory: '',
      fileTreeVersion: 0,
      modeByConversation: {},
      parkedModeByConversation: {},
      prePlanModeByConversation: {},
      planApprovalByConversation: {},

      setChatMode: (mode) => set({ chatMode: mode }),
      setWorkingDirectory: (dir) => set({ workingDirectory: dir }),
      bumpFileTreeVersion: () => set((state) => ({ fileTreeVersion: state.fileTreeVersion + 1 })),

      chooseCodexMode: (conversationId, mode, runActive) =>
        set((state) => {
          // Parked either way: it is the user's last VISIBLE choice, which is
          // what "Approve and run" reads to decide its target mode. While a run
          // is active that is all it is, the running turn keeps its own mode.
          const parked = { ...state.parkedModeByConversation, [conversationId]: mode }
          if (runActive) return { parkedModeByConversation: parked }
          const current = state.modeByConversation[conversationId]
          const prePlan =
            mode === 'plan' && current !== 'plan' && current
              ? { ...state.prePlanModeByConversation, [conversationId]: current }
              : state.prePlanModeByConversation
          return {
            parkedModeByConversation: parked,
            prePlanModeByConversation: prePlan,
            modeByConversation: { ...state.modeByConversation, [conversationId]: mode },
          }
        }),

      applyParkedMode: (conversationId) =>
        set((state) => {
          const parked = state.parkedModeByConversation[conversationId]
          if (!parked) return state
          const current = state.modeByConversation[conversationId]
          const prePlan =
            parked === 'plan' && current !== 'plan' && current
              ? { ...state.prePlanModeByConversation, [conversationId]: current }
              : state.prePlanModeByConversation
          return {
            parkedModeByConversation: omit(state.parkedModeByConversation, conversationId),
            prePlanModeByConversation: prePlan,
            modeByConversation: { ...state.modeByConversation, [conversationId]: parked },
          }
        }),

      codexModeFor: (conversationId, defaultMode) =>
        resolveCodexMode(
          conversationId ? get().modeByConversation[conversationId] : undefined,
          defaultMode,
        ),

      setPlanApproval: (conversationId, approval) =>
        set((state) => ({
          planApprovalByConversation: approval
            ? { ...state.planApprovalByConversation, [conversationId]: approval }
            : omit(state.planApprovalByConversation, conversationId),
        })),

      getThread: (conversationId) => get().threads[conversationId],

      initThread: (conversationId, workingDir) => {
        const id = `codex-${Date.now()}`
        set((state) => ({
          threads: {
            ...state.threads,
            [conversationId]: {
              id,
              conversationId,
              events: [],
              status: 'idle',
              workingDirectory: workingDir,
            },
          },
        }))
        return id
      },

      addEvent: (conversationId, event) =>
        set((state) => {
          const thread = state.threads[conversationId]
          if (!thread) return state
          // Auto-bump fileTreeVersion for events that can mutate the working
          // directory. The explorer panel watches this and re-reads.
          const mutatesFs =
            event.type === 'file_change' ||
            event.type === 'terminal_output' // shell/code execution can touch files
          const next = [...thread.events, event]
          return {
            threads: {
              ...state.threads,
              [conversationId]: {
                ...thread,
                events: next.length > CODEX_EVENT_LOG_MAX
                  ? next.slice(next.length - CODEX_EVENT_LOG_MAX)
                  : next,
              },
            },
            fileTreeVersion: mutatesFs ? state.fileTreeVersion + 1 : state.fileTreeVersion,
          }
        }),

      setThreadStatus: (conversationId, status) =>
        set((state) => {
          const thread = state.threads[conversationId]
          if (!thread) return state
          return {
            threads: {
              ...state.threads,
              [conversationId]: { ...thread, status },
            },
          }
        }),
    }),
    {
      // Persist key kept as 'locally-uncensored-codex' for storage
      // back-compat — renaming it would orphan every existing user's
      // coding working-directory. Internal id only; user-facing label is
      // "Coding Agent".
      name: 'locally-uncensored-codex',
      // chatMode is intentionally NOT persisted: newcomers should always land in
      // the Chat tab on startup, not whatever tab they left off in. If a user
      // wants to stay in the Coding Agent, they pick it from the sidebar
      // each session. workingDirectory still persists so it remembers the
      // last project path.
      // ADDITIVE ONLY, and the store version stays 0 (plan R1
      // DOWNGRADE-KONTRAKT). The D1 A/B has a 2.6.5 build and a 2.6.6 build
      // sharing one WebView profile, and zustand is hard about a version
      // mismatch: without a migrate it throws the whole persisted state away,
      // with one the old build stamps its version back and the migration runs
      // AGAIN on the next 2.6.6 start. Staying at version 0 and only adding a
      // key means the old build reads what it knows and ignores the rest; a
      // downgrade plus re-upgrade costs the conversation modes and nothing
      // else, and those fall back to settings.codexDefaultMode.
      partialize: (state) => ({
        workingDirectory: state.workingDirectory,
        modeByConversation: state.modeByConversation,
      }),
      // Existing installs have a persisted `chatMode: 'codex'` (or similar) in
      // localStorage from v2.3.8 and earlier. partialize only affects writes,
      // so rehydration would still restore the old value until the user next
      // switches tabs. Force it back to the default on every rehydrate so the
      // fix takes effect on existing users too, not just fresh installs.
      onRehydrateStorage: () => (state) => {
        if (state) state.chatMode = 'lu'
      },
    }
  )
)
