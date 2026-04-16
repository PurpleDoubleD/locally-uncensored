// Agent Mode — Type Definitions
// Part of the Agent Mode feature (coding-orch branch)

// Permission tiers (Claude Code pattern)
export type ToolPermission = 'auto' | 'confirm'

// Tool definition for internal use
export interface AgentToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, {
      type: string
      description: string
      enum?: string[]
    }>
    required: string[]
  }
  permission: ToolPermission
}

// Ollama tool format (sent in API request)
export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, any>
      required: string[]
    }
  }
}

// What Ollama returns when the model calls a tool
export interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, any>
  }
}

// Ollama chat message format (extended for tool calling)
export interface OllamaChatMessage {
  role: string
  content: string
  tool_calls?: OllamaToolCall[]
}

// Streaming chunk format for agent chat
export interface AgentChatChunk {
  message?: {
    content: string
    role?: string
    tool_calls?: OllamaToolCall[]
  }
  done?: boolean
}

// Tool call lifecycle status
export type ToolCallStatus = 'pending_approval' | 'running' | 'completed' | 'failed' | 'rejected' | 'cached'

// Internal tracking of a tool call.
// Observability fields (startedAt / completedAt / cacheHit / parentToolCallId /
// schemaValidated / sideEffectKey / errorHint) are additive — they were introduced
// in v2.4.0 for the agent overhaul (parallel execution, caching, audit, sub-agents).
// All are optional to preserve rehydration of pre-v2.4 persisted messages.
export interface AgentToolCall {
  id: string
  toolName: string
  args: Record<string, any>
  status: ToolCallStatus
  result?: string
  error?: string
  /** User-facing, model-facing hint appended to error for recovery (Phase 7). */
  errorHint?: string
  duration?: number
  timestamp: number
  /** Epoch ms when dispatch started (after permission approval). */
  startedAt?: number
  /** Epoch ms when result became available. */
  completedAt?: number
  /** True when result came from in-turn cache (Phase 6). */
  cacheHit?: boolean
  /** Parent toolCallId when spawned by a sub-agent delegation (Phase 13). */
  parentToolCallId?: string
  /** True when args passed JSON-schema validation (Phase 4). */
  schemaValidated?: boolean
  /** Group key for serial execution within a parallel batch (Phase 5).
   *  Writes to the same file path or the singleton "shell" share a key. */
  sideEffectKey?: string
}

// Phases rendered as distinct UI blocks in chat
export type AgentPhase = 'thinking' | 'planning' | 'tool_call' | 'reflection' | 'answer'

// A block in the agent's response (tool call, thinking, etc.)
//
// v2.4 migration:
//   `toolCall` (singular) is preserved for legacy rehydration only.
//   New code MUST write to `toolCalls` (plural). Use `getBlockToolCalls(block)`
//   from src/api/agents/block-helpers.ts to read both shapes uniformly.
export interface AgentBlock {
  id: string
  phase: AgentPhase
  content: string
  /** @deprecated since v2.4 — use `toolCalls`. Kept for legacy persist rehydration. */
  toolCall?: AgentToolCall
  /** v2.4+ — array of tool calls attached to this block (enables parallel execution). */
  toolCalls?: AgentToolCall[]
  timestamp: number
}

// Sandbox configuration
export type SandboxLevel = 'restricted' | 'full'

// ── Memory System ─────────────────────────────────────────────

// Legacy categories (kept for migration)
export type MemoryCategory = 'fact' | 'tool_result' | 'decision' | 'context'

export interface MemoryEntry {
  id: string
  category: MemoryCategory
  content: string
  timestamp: number
  source?: string // e.g. "agent:web_search", "user:manual", "auto:extraction"
}

// ── Enhanced Memory System (Claude Code-inspired) ─────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface MemoryFile {
  id: string
  type: MemoryType
  title: string       // ~60 chars, index-friendly
  description: string // ~120 chars, one-line hook for relevance matching
  content: string     // full text
  tags: string[]
  createdAt: number
  updatedAt: number
  source: string      // conversationId | 'manual' | 'auto:extraction'
}

export interface MemorySettings {
  autoExtractEnabled: boolean    // default false — opt-in (costs extra inference)
  autoExtractInAllModes: boolean // default false — whether to also extract outside agent mode
  maxMemoriesInPrompt: number    // default 10
  maxMemoryChars: number         // default 3000
}

// Migration map: old category → new type
export const MEMORY_MIGRATION_MAP: Record<MemoryCategory, MemoryType> = {
  fact: 'user',
  tool_result: 'reference',
  decision: 'project',
  context: 'project',
}

// Context-aware memory budget tiers
export interface MemoryBudgetTier {
  maxContext: number   // upper bound of model context
  budgetTokens: number // tokens allocated for memory
  maxMemories: number  // max entries to inject
  typesAllowed: MemoryType[] | 'all'
}

export const MEMORY_BUDGET_TIERS: MemoryBudgetTier[] = [
  { maxContext: 2048,   budgetTokens: 0,    maxMemories: 0,  typesAllowed: [] },
  { maxContext: 4096,   budgetTokens: 300,  maxMemories: 3,  typesAllowed: ['user', 'feedback'] },
  { maxContext: 8192,   budgetTokens: 800,  maxMemories: 8,  typesAllowed: 'all' },
  { maxContext: 131072, budgetTokens: 2000, maxMemories: 15, typesAllowed: 'all' },
  { maxContext: Infinity, budgetTokens: 4000, maxMemories: 25, typesAllowed: 'all' },
]
