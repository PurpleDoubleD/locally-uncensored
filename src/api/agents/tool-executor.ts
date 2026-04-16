/**
 * Phase 5 (v2.4.0) — Parallel tool executor.
 *
 * Replaces the serial for-loop in useAgentChat / useCodex / mobile ReAct
 * with a scheduler that:
 *
 *   1. Validates args via args-validator (Phase 4).
 *   2. Records dispatch to toolAuditStore (Phase 2).
 *   3. Groups calls by sideEffectKey (Phase 5) — same key serial, different
 *      keys parallel. Pure reads (no key) run fully in parallel.
 *   4. Uses Promise.allSettled so one failure does not abort siblings.
 *   5. Reports per-call completion back to the caller via onComplete.
 *
 * The executor is deliberately framework-agnostic — no React, no Zustand
 * calls (stores are plumbed in via dependency injection). This keeps it
 * testable in node-env vitest and keeps the hook integration thin.
 */

import type { AgentToolCall } from '../../types/agent-mode'
import { deriveSideEffectKey } from './side-effect-key'
import { validateToolArgs, formatValidationErrors, type JsonSchema } from './args-validator'
import { stableArgsHash } from './block-helpers'

export interface ExecutorToolDef {
  name: string
  inputSchema?: JsonSchema
}

export interface ExecutionRequest {
  /** Unique id for this tool call, matches AgentToolCall.id. */
  id: string
  /** Tool name — must be registered in the executor's runtime. */
  toolName: string
  /** Raw args from the LLM. */
  args: Record<string, any>
  /** Optional parent id for sub-agent lineage. */
  parentToolCallId?: string
}

export interface ExecutionResult {
  id: string
  toolName: string
  status: 'completed' | 'failed' | 'rejected' | 'cached'
  /** String result (executor outputs). */
  result?: string
  error?: string
  /** Human-readable retry hint (filled by Phase 7 error-hints module). */
  errorHint?: string
  /** Validated + coerced args that were actually dispatched. */
  dispatchedArgs: Record<string, any>
  argsHash: string
  sideEffectKey?: string
  startedAt: number
  completedAt: number
  durationMs: number
  cacheHit: boolean
  /** True when args-validator accepted the args (or no schema was provided). */
  schemaValidated: boolean
  /** When validation failed, the error text sent to the next LLM turn. */
  validationError?: string
}

export type ExecutorFn = (args: Record<string, any>) => Promise<string>

export interface ExecutorRuntime {
  /** Resolve a tool by name — returns undefined for unknown tools. */
  getTool: (name: string) => ExecutorToolDef | undefined
  /** Execute a registered tool against args; returns string result. */
  execute: ExecutorFn & ((name: string, args: Record<string, any>) => Promise<string>)
  /** Optional — called before dispatch to gate on user approval. */
  awaitApproval?: (req: ExecutionRequest, tool: ExecutorToolDef) => Promise<boolean>
  /** Optional — cache lookup pre-dispatch (Phase 6). Returns a cached result or undefined. */
  lookupCache?: (
    req: ExecutionRequest,
    argsHash: string
  ) => string | undefined
  /** Optional — audit recorder (Phase 2). Called at dispatch + completion. */
  recordAudit?: (entry: AuditHook) => void
  /** Optional — error hint mapper (Phase 7). */
  explainError?: (toolName: string, error: string) => string | undefined
}

export type AuditHook =
  | {
      kind: 'start'
      id: string
      toolName: string
      args: Record<string, any>
      argsHash: string
      parentToolCallId?: string
      startedAt: number
    }
  | {
      kind: 'complete'
      id: string
      status: ExecutionResult['status']
      completedAt: number
      durationMs: number
      cacheHit: boolean
      resultPreview?: string
      error?: string
      errorHint?: string
    }

export interface ExecutorOptions {
  /** Fires when a call transitions to running. */
  onStart?: (req: ExecutionRequest) => void
  /** Fires when a call settles. */
  onComplete?: (res: ExecutionResult) => void
  /** Aborts remaining not-yet-started calls when flipped true. */
  abortSignal?: AbortSignal
}

/**
 * Run a batch of tool calls. Returns ordered results matching the input order.
 *
 * Scheduling:
 *  - Calls with no sideEffectKey run in parallel.
 *  - Calls sharing a key run serially within their group.
 *  - Groups with different keys run in parallel with each other and with the
 *    no-key pool.
 */
export async function executeParallel(
  requests: ExecutionRequest[],
  runtime: ExecutorRuntime,
  opts: ExecutorOptions = {}
): Promise<ExecutionResult[]> {
  if (requests.length === 0) return []

  // Tag each request with its side-effect key up front so tests can inspect
  // the schedule and the audit recorder sees consistent keys.
  const tagged = requests.map((req) => ({
    req,
    key: deriveSideEffectKey(req.toolName, req.args),
  }))

  // Index → result slot so we can preserve input order.
  const results: (ExecutionResult | undefined)[] = Array(requests.length).fill(undefined)

  // Group by key. `undefined` means "no shared key" — each goes to its own
  // solo group so it runs concurrently with everything else.
  const groups = new Map<string, number[]>()
  const soloIndices: number[] = []
  tagged.forEach((t, i) => {
    if (!t.key) {
      soloIndices.push(i)
    } else {
      const list = groups.get(t.key) ?? []
      list.push(i)
      groups.set(t.key, list)
    }
  })

  const runOne = async (index: number): Promise<void> => {
    if (opts.abortSignal?.aborted) {
      results[index] = abortedResult(tagged[index])
      opts.onComplete?.(results[index]!)
      return
    }
    const res = await runSingle(tagged[index].req, tagged[index].key, runtime, opts)
    results[index] = res
    opts.onComplete?.(res)
  }

  const solo = soloIndices.map(runOne)

  const grouped = [...groups.values()].map(async (indices) => {
    for (const i of indices) {
      await runOne(i)
    }
  })

  await Promise.all([...solo, ...grouped])
  return results.map((r, i) => r ?? abortedResult(tagged[i]))
}

async function runSingle(
  req: ExecutionRequest,
  sideEffectKey: string | undefined,
  runtime: ExecutorRuntime,
  opts: ExecutorOptions
): Promise<ExecutionResult> {
  const startedAt = Date.now()
  const argsHash = stableArgsHash(req.args ?? {})

  opts.onStart?.(req)
  runtime.recordAudit?.({
    kind: 'start',
    id: req.id,
    toolName: req.toolName,
    args: req.args,
    argsHash,
    parentToolCallId: req.parentToolCallId,
    startedAt,
  })

  const finalize = (partial: Omit<ExecutionResult, 'completedAt' | 'durationMs'>): ExecutionResult => {
    const completedAt = Date.now()
    const durationMs = completedAt - startedAt
    const result: ExecutionResult = { ...partial, completedAt, durationMs }
    runtime.recordAudit?.({
      kind: 'complete',
      id: req.id,
      status: result.status,
      completedAt,
      durationMs,
      cacheHit: result.cacheHit,
      resultPreview: result.result,
      error: result.error,
      errorHint: result.errorHint,
    })
    return result
  }

  const tool = runtime.getTool(req.toolName)
  if (!tool) {
    return finalize({
      id: req.id,
      toolName: req.toolName,
      status: 'failed',
      error: `Unknown tool: ${req.toolName}`,
      dispatchedArgs: req.args,
      argsHash,
      sideEffectKey,
      startedAt,
      cacheHit: false,
      schemaValidated: false,
    })
  }

  // Schema validate (Phase 4).
  let dispatchedArgs = req.args ?? {}
  let schemaValidated = true
  let validationError: string | undefined
  if (tool.inputSchema) {
    const v = validateToolArgs(req.args ?? {}, tool.inputSchema)
    if (!v.valid) {
      schemaValidated = false
      validationError = formatValidationErrors(v.errors)
      return finalize({
        id: req.id,
        toolName: req.toolName,
        status: 'failed',
        error: `Invalid arguments: ${validationError}`,
        errorHint: 'Re-issue the tool call with valid arguments matching the tool schema.',
        dispatchedArgs: req.args,
        argsHash,
        sideEffectKey,
        startedAt,
        cacheHit: false,
        schemaValidated: false,
        validationError,
      })
    }
    if (v.coerced) dispatchedArgs = v.coerced
  }

  // Cache lookup (Phase 6 integration point).
  const cached = runtime.lookupCache?.(req, argsHash)
  if (typeof cached === 'string') {
    return finalize({
      id: req.id,
      toolName: req.toolName,
      status: 'cached',
      result: cached,
      dispatchedArgs,
      argsHash,
      sideEffectKey,
      startedAt,
      cacheHit: true,
      schemaValidated,
    })
  }

  // User approval (desktop only; mobile runtime has no approval gate).
  if (runtime.awaitApproval) {
    const approved = await runtime.awaitApproval(req, tool)
    if (!approved) {
      return finalize({
        id: req.id,
        toolName: req.toolName,
        status: 'rejected',
        error: 'User rejected tool call',
        dispatchedArgs,
        argsHash,
        sideEffectKey,
        startedAt,
        cacheHit: false,
        schemaValidated,
      })
    }
  }

  // Dispatch.
  try {
    const result = await runtime.execute(req.toolName, dispatchedArgs)
    return finalize({
      id: req.id,
      toolName: req.toolName,
      status: 'completed',
      result,
      dispatchedArgs,
      argsHash,
      sideEffectKey,
      startedAt,
      cacheHit: false,
      schemaValidated,
    })
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err)
    const hint = runtime.explainError?.(req.toolName, errorText)
    return finalize({
      id: req.id,
      toolName: req.toolName,
      status: 'failed',
      error: errorText,
      errorHint: hint,
      dispatchedArgs,
      argsHash,
      sideEffectKey,
      startedAt,
      cacheHit: false,
      schemaValidated,
    })
  }
}

function abortedResult(tagged: { req: ExecutionRequest; key?: string }): ExecutionResult {
  const now = Date.now()
  const argsHash = stableArgsHash(tagged.req.args ?? {})
  return {
    id: tagged.req.id,
    toolName: tagged.req.toolName,
    status: 'rejected',
    error: 'Aborted before dispatch',
    dispatchedArgs: tagged.req.args,
    argsHash,
    sideEffectKey: tagged.key,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    cacheHit: false,
    schemaValidated: false,
  }
}

/** Convenience: attach ExecutionResult fields back onto an AgentToolCall. */
export function applyResultToToolCall(call: AgentToolCall, result: ExecutionResult): AgentToolCall {
  call.status =
    result.status === 'completed'
      ? 'completed'
      : result.status === 'cached'
        ? 'cached'
        : result.status === 'rejected'
          ? 'rejected'
          : 'failed'
  if (result.result !== undefined) call.result = result.result
  if (result.error !== undefined) call.error = result.error
  if (result.errorHint !== undefined) call.errorHint = result.errorHint
  call.duration = result.durationMs
  call.startedAt = result.startedAt
  call.completedAt = result.completedAt
  call.cacheHit = result.cacheHit
  call.schemaValidated = result.schemaValidated
  call.sideEffectKey = result.sideEffectKey
  return call
}
