// Agent Mode — Type Definitions
// Part of the Agent Mode feature (coding-orch branch)

import type { JSONSchemaProp, ToolArgs } from '../api/mcp/types'

// Permission tiers (auto-approve reads, confirm writes)
export type ToolPermission = 'auto' | 'confirm'

// Tool definition for internal use
export interface AgentToolDef {
  name: string
  description: string
  /**
   * The same schema the MCP registry hands out (`MCPToolDefinition.inputSchema`),
   * because that is literally where these come from (tool-registry.ts maps
   * `inputSchema` onto this field). The local copy of the shape had drifted:
   * it forced `type: string` and a mandatory `description`, so a tool with a
   * union type (`['string','array']`, the multi-LoRA param) or a bare property
   * could not be described here at all.
   */
  parameters: {
    type: 'object'
    properties: Record<string, JSONSchemaProp>
    required: string[]
    additionalProperties?: boolean
  }
  permission: ToolPermission
}

// Ollama tool format (sent in API request)
export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    /**
     * The registry copies `MCPToolDefinition.inputSchema` in here verbatim
     * (tool-registry.toOllamaTools), so the property map carries the same
     * JSONSchemaProp shape rather than an untyped bag — which is what let the
     * Hermes prompt builder be handed this object behind an `as any`.
     */
    parameters: {
      type: 'object'
      properties: Record<string, JSONSchemaProp>
      required: string[]
      additionalProperties?: boolean
    }
  }
}

// What Ollama returns when the model calls a tool
export interface OllamaToolCall {
  function: {
    name: string
    /* Was `Record<string, any>`. It is the project's own ToolArgs — every
       consumer already reads these through the argString/argNumber guards in
       builtin-tools.ts, so the `any` was not carrying anything: swapping it
       for the real type left tsc at 0 errors across the whole program. */
    arguments: ToolArgs
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
  args: ToolArgs
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
  /** Unified diff for file_write/file_edit, rendered by ToolCallBlock
   *  (audit D5) instead of raw result text. */
  diff?: string
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

// ── Enhanced Memory System ────────────────────────────────────

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
  // ── Staleness / supersession (Feature FF, v2.5.0) ─────────────
  // All OPTIONAL so pre-v2.5 persisted memories rehydrate unchanged; the
  // store's migrate() leaves them undefined and the retrieval layer treats
  // undefined as "not stale".
  /** Id of the newer entry that replaced this one (UPDATE write-decision). */
  supersededBy?: string
  /** Id of the entry this one replaced — back-pointer for audit / UI. */
  supersedesId?: string
  /** Explicitly flagged outdated → excluded from live retrieval, kept on disk. */
  stale?: boolean
  /** Epoch ms from which this fact is considered valid (set on UPDATE). */
  validFrom?: number
}

export interface MemorySettings {
  autoExtractEnabled: boolean    // default false — opt-in (costs extra inference)
  autoExtractInAllModes: boolean // default false — whether to also extract outside agent mode
  maxMemoriesInPrompt: number    // default 10 (legacy; retrieval uses the budget tier / override)
  maxMemoryChars: number         // default 3000
  // User override for how many memories get injected into the prompt. null =
  // auto (derive from the model's context size via MEMORY_BUDGET_TIERS).
  // Set a number to take manual control instead of "32k ctx = 15 memories"
  // (David 2026-06-07). The token budget scales with it so the extra entries
  // actually fit. Optional for back-compat with pre-2.5.1 persisted settings.
  maxMemoriesOverride?: number | null
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
