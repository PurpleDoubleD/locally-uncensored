import { create } from 'zustand'

/**
 * Phase 2 (v2.4.0) — per-conversation ring-buffered tool-call audit log.
 *
 * Ephemeral by default: entries live for the session and are not persisted.
 * This keeps the store cheap, avoids localStorage bloat, and matches the
 * privacy model (tool-call args can contain file contents / shell output).
 *
 * A capped number of entries is retained per conversation so the debug
 * panel (Phase 5+) can render a scroll-back without unbounded growth.
 *
 * Identity:
 *   - toolCallId: stable per call (from AgentToolCall.id)
 *   - argsHash: canonical stableArgsHash(args) for cache lookup (Phase 6)
 */

import { stableArgsHash } from '../api/agents/block-helpers'

export type ToolAuditStatus =
  | 'pending_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cached'

export interface ToolAuditEntry {
  /** Internal audit row id. */
  id: string
  /** Conversation this call was made in. */
  convId: string
  /** AgentToolCall.id — correlates with the block. */
  toolCallId: string
  toolName: string
  args: Record<string, any>
  /** Deterministic hash of args for cache / dedup. */
  argsHash: string
  status: ToolAuditStatus
  /** Epoch ms when dispatched (after approval). */
  startedAt: number
  /** Epoch ms when result landed. May be missing for still-running. */
  completedAt?: number
  /** Convenience — derived when completedAt is set. */
  durationMs?: number
  /** True when served from in-turn cache (Phase 6). */
  cacheHit?: boolean
  /** Parent toolCallId when spawned by a sub-agent (Phase 13). */
  parentToolCallId?: string
  /** Structured error hint (Phase 7). */
  errorHint?: string
  /** String preview of result, clipped to keep panel performant. */
  resultPreview?: string
  /** Raw error string when status=failed. */
  error?: string
}

/** Max retained entries per conversation. Oldest evicted on overflow. */
export const AUDIT_MAX_PER_CONV = 500

/** Max length of result preview kept in the store. */
export const AUDIT_RESULT_PREVIEW_CHARS = 500

interface ToolAuditState {
  /** convId → entries (newest last for cheap append; query helpers reverse). */
  entries: Record<string, ToolAuditEntry[]>
  /**
   * Record the dispatch of a tool call. Call this after permission approval
   * and BEFORE actual execution. Returns the inserted entry id.
   */
  record: (input: {
    id?: string
    convId: string
    toolCallId: string
    toolName: string
    args: Record<string, any>
    parentToolCallId?: string
    startedAt?: number
    status?: ToolAuditStatus
  }) => string
  /** Update an in-progress entry with completion data. */
  complete: (
    entryId: string,
    patch: {
      status: ToolAuditStatus
      completedAt?: number
      resultPreview?: string
      error?: string
      errorHint?: string
      cacheHit?: boolean
    }
  ) => void
  /** Query entries for a conversation, newest first. */
  forConversation: (convId: string) => ToolAuditEntry[]
  /** Find entry by toolCallId across all conversations (or within one). */
  findByToolCallId: (toolCallId: string, convId?: string) => ToolAuditEntry | undefined
  /**
   * In-turn cache lookup (Phase 6 helper): return most recent completed entry
   * matching (toolName, argsHash, convId) since a cut-off epoch ms.
   */
  findCacheCandidate: (
    convId: string,
    toolName: string,
    argsHash: string,
    sinceMs: number
  ) => ToolAuditEntry | undefined
  /** Aggregate status counts per conversation for the debug panel. */
  countsByStatus: (convId: string) => Record<ToolAuditStatus, number>
  /** Drop all entries for a conversation (called on conversation delete). */
  clearConversation: (convId: string) => void
  /** Drop everything (dev utility / tests). */
  clearAll: () => void
}

let _seq = 0
const newId = (): string => {
  _seq = (_seq + 1) & 0x7fffffff
  return `audit-${Date.now().toString(36)}-${_seq.toString(36)}`
}

export const useToolAuditStore = create<ToolAuditState>((set, get) => ({
  entries: {},

  record: ({
    id,
    convId,
    toolCallId,
    toolName,
    args,
    parentToolCallId,
    startedAt,
    status,
  }) => {
    const entryId = id ?? newId()
    const entry: ToolAuditEntry = {
      id: entryId,
      convId,
      toolCallId,
      toolName,
      args,
      argsHash: stableArgsHash(args),
      status: status ?? 'running',
      startedAt: startedAt ?? Date.now(),
      parentToolCallId,
    }
    set((state) => {
      const existing = state.entries[convId] ?? []
      const next = existing.length >= AUDIT_MAX_PER_CONV
        ? [...existing.slice(existing.length - AUDIT_MAX_PER_CONV + 1), entry]
        : [...existing, entry]
      return { entries: { ...state.entries, [convId]: next } }
    })
    return entryId
  },

  complete: (entryId, patch) =>
    set((state) => {
      const next: Record<string, ToolAuditEntry[]> = {}
      for (const [convId, list] of Object.entries(state.entries)) {
        let mutated = false
        const updated = list.map((e) => {
          if (e.id !== entryId) return e
          mutated = true
          const completedAt = patch.completedAt ?? Date.now()
          const durationMs = completedAt - e.startedAt
          return {
            ...e,
            ...patch,
            completedAt,
            durationMs,
            resultPreview: patch.resultPreview?.slice(0, AUDIT_RESULT_PREVIEW_CHARS),
          }
        })
        next[convId] = mutated ? updated : list
      }
      return { entries: next }
    }),

  forConversation: (convId) => {
    const list = get().entries[convId] ?? []
    // Newest first.
    return [...list].reverse()
  },

  findByToolCallId: (toolCallId, convId) => {
    const state = get()
    const pools = convId ? [state.entries[convId] ?? []] : Object.values(state.entries)
    for (const pool of pools) {
      for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].toolCallId === toolCallId) return pool[i]
      }
    }
    return undefined
  },

  findCacheCandidate: (convId, toolName, argsHash, sinceMs) => {
    const list = get().entries[convId] ?? []
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if (e.startedAt < sinceMs) return undefined
      if (e.status !== 'completed') continue
      if (e.toolName !== toolName) continue
      if (e.argsHash !== argsHash) continue
      return e
    }
    return undefined
  },

  countsByStatus: (convId) => {
    const list = get().entries[convId] ?? []
    const counts: Record<ToolAuditStatus, number> = {
      pending_approval: 0,
      running: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      cached: 0,
    }
    for (const e of list) counts[e.status] = (counts[e.status] ?? 0) + 1
    return counts
  },

  clearConversation: (convId) =>
    set((state) => {
      const { [convId]: _dropped, ...rest } = state.entries
      return { entries: rest }
    }),

  clearAll: () => set({ entries: {} }),
}))
