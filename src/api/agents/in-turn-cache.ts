/**
 * Phase 6 (v2.4.0) — In-turn tool-result cache.
 *
 * Dedupes identical (toolName, argsHash) calls within a single agent run.
 *
 * Scope is deliberately narrow: one agent TURN (from sendAgentMessage or
 * sendInstruction start until the ReAct loop exits). We do NOT cache across
 * turns because many tools return time-sensitive data (web_search results,
 * file_read on a file that may have just been overwritten). Scoping to a single turn keeps the semantics trivial:
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
import { toolResultIsFailure } from '../../lib/tool-result-failure'
import { MUTATING_TOOLS } from '../../lib/mutating-tools'
import { toolRegistry } from '../mcp/tool-registry'

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
/**
 * Tools whose results must NEVER be served from the in-turn cache. These are
 * non-idempotent (side-effecting or state-dependent): a repeated
 * shell_execute("npm test") has to actually re-run, a file_write has to
 * actually write, and git_* reflects mutable working-tree state. Serving a
 * cached payload here silently breaks the core edit -> test -> verify loop: the
 * pre-fix test failure from an early iteration would be replayed after the fix
 * landed, and the model concludes its fix did nothing.
 */
const NON_CACHEABLE_TOOLS = new Set<string>([
  'file_write',
  'file_edit',
  'shell_execute',
  // Retired names (2.6.6 merge) still execute via the registry redirect and
  // must keep exactly these semantics under their old names.
  'shell_execute_background',
  'code_execute',
  'run_tests',
  // Writes the plan the user watches. Today it is idempotent, so a cache hit
  // would do no visible harm, but a write served from cache never reaches the
  // store — and a plan that silently stops updating is the one failure mode
  // that makes the whole feature untrustworthy.
  'todo_write',
  // Puts an order into the conversation's store. Served from cache, the text
  // would arrive but no order the customer could approve.
  'create_order',
  // Asks how the background agents stand right now. Served from cache, an
  // agent that waits for a task would read "running" for the rest of the turn.
  'check_tasks',
  // Sends a message to another agent. The same words twice are two messages.
  'message_agent',
  // A11: reads settings that set_setting just changed, and set_setting asks
  // the user every time. Neither may be answered from an earlier call.
  'get_settings',
  'set_setting',
  // C60: the batch change and the actions read and change live state.
  'set_settings',
  'lu_models',
  'lu_service',
  'lu_download',
  'lu_open_settings',
])

/**
 * Of the non-cacheable tools, the ones that touch the WORKSPACE. Only these
 * invalidate a cached read.
 *
 * The two sets used to be one, which was right while every non-cacheable tool
 * also wrote to disk. todo_write broke that: it must always really run, but it
 * changes no file. Folding it into one set would throw away every cached
 * file_read on each plan update — and the plan updates after every step.
 */
const WORKSPACE_MUTATING_TOOLS = new Set<string>([
  'file_write',
  'file_edit',
  'shell_execute',
  // Redirect-era names, same reasoning as above.
  'shell_execute_background',
  'code_execute',
  'run_tests',
])

/** Reads whose cached payload is invalidated by a later workspace mutation. */
const READ_TOOLS = new Set<string>(['file_read', 'file_list'])

function isNonCacheableTool(name: string): boolean {
  // Whatever acts outside the conversation has to act every time it is
  // called. The screen is the plainest case (box, 09.10.2026): a model called
  // `computer_use` with action "screenshot" and "focus_window" in turns, the
  // cache answered 97 of 101 calls with the picture and the sentence of the
  // first ones, no window moved, and the model never saw that.
  if (MUTATING_TOOLS.has(name)) return true
  // A tool of a connected MCP server acts in a program LU knows nothing
  // about. Whether it reads or writes there is not ours to guess.
  if (toolRegistry.getToolByName(name)?.source === 'external') return true
  // git_* covers the redirected typed git tools, reads and writes alike.
  return NON_CACHEABLE_TOOLS.has(name) || name.startsWith('git_')
}

/** A workspace-mutating call, the disk-touching subset plus redirected git_*. */
function isMutatingTool(name: string): boolean {
  return WORKSPACE_MUTATING_TOOLS.has(name) || name.startsWith('git_')
}

/**
 * True when any workspace-mutating call ran after `afterMs` in this turn.
 * shell_execute can touch any path, so rather than parse an opaque shell
 * command we conservatively invalidate ALL cached reads on ANY mutation that
 * happened after the cached read. Re-reading is cheap and always correct.
 */
function hasMutationSince(convId: string, afterMs: number): boolean {
  const list = useToolAuditStore.getState().forConversation(convId)
  for (const e of list) {
    if (e.startedAt <= afterMs) continue
    if (isMutatingTool(e.toolName)) return true
  }
  return false
}

export function makeInTurnCacheLookup(opts: InTurnCacheOptions) {
  const { convId, turnStartMs } = opts
  return (req: ExecutionRequest, argsHash: string): string | undefined => {
    // Never serve non-idempotent tools from cache (see NON_CACHEABLE_TOOLS).
    if (isNonCacheableTool(req.toolName)) return undefined

    const store = useToolAuditStore.getState()
    const candidate = store.findCacheCandidate(convId, req.toolName, argsHash, turnStartMs)
    if (!candidate) return undefined

    // A cached file_read / file_list is stale the moment any mutating call ran
    // after it. Miss -> the executor re-reads the current bytes.
    if (READ_TOOLS.has(req.toolName) && hasMutationSince(convId, candidate.startedAt)) {
      return undefined
    }

    // Serve the FULL retained result, never the 500-char audit preview. When
    // the full result was not retained (absent, or clipped for size) treat it
    // as a miss so the model re-reads the whole file instead of a silently
    // truncated slice. Empty strings are a legitimate cached payload.
    if (typeof candidate.fullResult !== 'string') return undefined
    // A failure is not an answer to keep (bug hunt 01.10.2026, A5). Tools
    // report most failures as text with status 'completed', so the audit kept
    // a timed-out web_fetch or a file_read of a file not written yet as a hit,
    // and every retry in the same turn got the old error back without the
    // call running again.
    if (toolResultIsFailure(candidate.fullResult)) return undefined
    return candidate.fullResult
  }
}
