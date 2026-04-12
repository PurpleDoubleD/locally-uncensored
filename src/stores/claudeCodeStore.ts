/**
 * Claude Code Store — manages Claude Code sessions and state.
 *
 * Tracks CLI installation status, active sessions, working directory,
 * and streamed events from the Claude Code subprocess.
 * Requires Ollama 0.14+ (native Anthropic API compatibility).
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ── Types ──────────────────────────────────────────────────────

export type ClaudeCodeEventType =
  | 'text'              // assistant text content
  | 'tool_use'          // tool invocation (file read, write, shell)
  | 'tool_result'       // tool execution result
  | 'permission_request'// needs user approval
  | 'error'             // error occurred
  | 'done'              // task complete

export interface ClaudeCodeEvent {
  id: string
  type: ClaudeCodeEventType
  content: string
  timestamp: number
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  filePath?: string
  diff?: string
}

export interface ClaudeCodeSession {
  id: string
  conversationId: string
  events: ClaudeCodeEvent[]
  status: 'idle' | 'running' | 'waiting_permission' | 'error'
  workingDirectory: string
  pid: number | null
}

// ── Recommended models for Claude Code ─────────────────────────

export const CLAUDE_CODE_RECOMMENDED_MODELS = [
  { name: 'glm5.1', label: 'GLM 5.1', reason: 'Latest GLM, strong tool calling, 128K context' },
  { name: 'qwen3.5-coder', label: 'Qwen 3.5 Coder', reason: 'Best open-source coding model, native tool calling' },
  { name: 'qwen3.5-coder-abliterated', label: 'Qwen 3.5 Coder (Uncensored)', reason: 'Abliterated variant, no refusals' },
  { name: 'glm4.7', label: 'GLM 4.7 Flash', reason: '128K context, MoE, runs on 16GB RAM' },
  { name: 'qwen3-coder', label: 'Qwen 3 Coder', reason: 'Strong coding, 128K context' },
  { name: 'hermes3', label: 'Hermes 3', reason: 'Uncensored, good tool calling' },
] as const

// ── Store ──────────────────────────────────────────────────────

interface ClaudeCodeState {
  installed: boolean
  version: string | null
  cliPath: string | null
  sessions: Record<string, ClaudeCodeSession>
  workingDirectory: string

  setInstalled: (installed: boolean, version?: string, path?: string) => void
  setWorkingDirectory: (dir: string) => void

  getSession: (conversationId: string) => ClaudeCodeSession | undefined
  initSession: (conversationId: string, workingDir: string) => string
  addEvent: (conversationId: string, event: ClaudeCodeEvent) => void
  setSessionStatus: (conversationId: string, status: ClaudeCodeSession['status']) => void
  setSessionPid: (conversationId: string, pid: number | null) => void
  clearSession: (conversationId: string) => void
}

export const useClaudeCodeStore = create<ClaudeCodeState>()(
  persist(
    (set, get) => ({
      installed: false,
      version: null,
      cliPath: null,
      sessions: {},
      workingDirectory: '',

      setInstalled: (installed, version, path) =>
        set({ installed, version: version || null, cliPath: path || null }),

      setWorkingDirectory: (dir) => set({ workingDirectory: dir }),

      getSession: (conversationId) => get().sessions[conversationId],

      initSession: (conversationId, workingDir) => {
        const id = `claude-code-${Date.now()}`
        set((state) => ({
          sessions: {
            ...state.sessions,
            [conversationId]: {
              id,
              conversationId,
              events: [],
              status: 'idle',
              workingDirectory: workingDir,
              pid: null,
            },
          },
        }))
        return id
      },

      addEvent: (conversationId, event) =>
        set((state) => {
          const session = state.sessions[conversationId]
          if (!session) return state
          return {
            sessions: {
              ...state.sessions,
              [conversationId]: {
                ...session,
                events: [...session.events, event],
              },
            },
          }
        }),

      setSessionStatus: (conversationId, status) =>
        set((state) => {
          const session = state.sessions[conversationId]
          if (!session) return state
          return {
            sessions: {
              ...state.sessions,
              [conversationId]: { ...session, status },
            },
          }
        }),

      setSessionPid: (conversationId, pid) =>
        set((state) => {
          const session = state.sessions[conversationId]
          if (!session) return state
          return {
            sessions: {
              ...state.sessions,
              [conversationId]: { ...session, pid },
            },
          }
        }),

      clearSession: (conversationId) =>
        set((state) => {
          const { [conversationId]: _, ...rest } = state.sessions
          return { sessions: rest }
        }),
    }),
    {
      name: 'locally-uncensored-claude-code',
      partialize: (state) => ({
        installed: state.installed,
        version: state.version,
        cliPath: state.cliPath,
        workingDirectory: state.workingDirectory,
      }),
    }
  )
)
