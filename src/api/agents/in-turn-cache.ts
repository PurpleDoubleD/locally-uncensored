/**
 * Phase 6 (v2.4.0) — In-turn tool-result cache.
 *
 * Dedupes identical (toolName, argsHash) calls within a single agent run.
 *
 * Scope is deliberately narrow: one agent TURN (from sendAgentMessage or
 * sendInstruction start until the ReAct loop exits). We do NOT cache across
 * turns because many tools return time-sensitive data (web_search results,
 * process_list, get_current_time, file_read on a file that may have just
 * been overwritten). Scoping to a single turn keeps the semantics trivial:
 * everything inside one user prompt sees a consistent view of each tool's
 * output; the next user prompt starts fresh.
 *
 * The implementation delegates to the audit store's findCacheCandidate,
 * which indexes completed entries by (convId, toolName, argsHash, startedAt).
 * Turn start time is passed as the cut-off: anything older is treated as
 * belonging to a previous turn and ignored.
 */

import { useToolAuditStore } from '../../stores/toolAuditStore'
import type { ExecutionRequest } from './tool-executor'

export interface InTurnCacheOptions {
  convId: string
  /** Epoch ms when the current agent run started. Audit entries older than
   *  this are treated as belonging to a previous turn and not served. */
  turnStartMs: number
}

/**
 * Factory producing a `lookupCache` callback suitable for passing into
 * executeParallel's ExecutorRuntime.lookupCache. Returns the cached result
 * string when a matching prior call exists within the current turn.
 */
export function makeInTurnCacheLookup(opts: InTurnCacheOptions) {
  const { convId, turnStartMs } = opts
  return (req: ExecutionRequest, argsHash: string): string | undefined => {
    const candidate = useToolAuditStore
      .getState()
      .findCacheCandidate(convId, req.toolName, argsHash, turnStartMs)
    // Only return a cached payload if the prior call actually produced one.
    // Empty strings are cacheable (tool legitimately returned ""); undefined
    // is not (failed calls record no resultPreview).
    if (!candidate) return undefined
    if (typeof candidate.resultPreview !== 'string') return undefined
    return candidate.resultPreview
  }
}
