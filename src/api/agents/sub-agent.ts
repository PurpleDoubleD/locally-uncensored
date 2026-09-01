/**
 * Phase 13 (v2.4.0) — Sub-agent delegation.
 *
 * Exposes a `delegate_task` builtin tool that spawns a nested ReAct loop
 * with a sub-goal, its own isolated AgentBudget, and the same tool
 * registry minus `delegate_task` itself (so a sub-agent cannot fork-bomb
 * a tree of delegations).
 *
 * Depth is capped at 2 globally — a sub-agent that attempts to call
 * delegate_task returns a refusal string. Combined with the tool-list
 * filtering, the model has no syntactically valid path to recurse.
 */

import { settleThinking } from '../../lib/thinking-stripper'
// M7 / Audit W-T2: hier stand zweimal `await import('../mcp')`. Gesplittet hat
// das nie — die Tonne mcp/index.ts hängt über useAgentChat, useCodex und
// api/tool-registry.ts ohnehin statisch im Graph, also meldete Rolldown
// INEFFECTIVE_DYNAMIC_IMPORT. Der import() war auch nie fürs Splitten da,
// sondern um den Zyklus mcp/index → builtin-tools → sub-agent → mcp/index zu
// brechen.
//
// Die ehrliche Auflösung ist ein statischer Import auf das Modul, das hier
// wirklich gebraucht wird, statt auf die Tonne: `mcp/tool-registry` hält den
// Singleton und importiert selbst nichts aus diesem Cluster (seit die
// retired-Kante invertiert ist), der Zyklus entsteht also gar nicht erst.
// Die Registrierung der Builtins ist dabei garantiert schon gelaufen: beide
// Einstiegspunkte dieser Datei hängen am `delegate_task`-Executor, den erst
// registerBuiltinTools() verdrahtet.
import { toolRegistry } from '../mcp/tool-registry'
import type { MCPToolDefinition, ToolArgs } from '../mcp/types'
import type { ChatMessage } from '../providers/types'
import type { AgentToolCall } from '../../types/agent-mode'
import type { ApprovalEntry } from '../../lib/approval-queue'
import {
  executeParallel,
  type ExecutionRequest,
  type ApprovalGate,
  type AuditRecorder,
} from './tool-executor'
import type { AgentRunContext } from '../agent-context'
import { AgentBudget } from './budget'
import { explainError as explainToolError } from './error-hints'
import { platformPromptLine, hostClockLine } from '../../lib/host-platform'

// NOTE: the toolRegistry import is done LAZILY inside defaultSubAgentRunner
// to avoid a circular dependency with src/api/mcp/builtin-tools.ts, which
// pulls DELEGATE_TASK_TOOL_DEF + buildDelegateExecutor from this file at
// module init.

// Recursion note: a sub-agent's tool list is filtered so it never SEES
// `delegate_task`, which is what discourages nesting in practice. It is not a
// hard block — the runner resolves over the full registry — but the in-flight
// concurrency cap below (SUB_AGENT_MAX_PARALLEL) plus each sub-agent's tight
// budget bound the blast radius. (A former SUB_AGENT_MAX_DEPTH constant claimed
// to enforce a depth limit but was never read; removed in 2.5.9. The design
// deliberately uses one in-flight counter as the concurrency gate rather than a
// separate nesting-depth counter, so parallel siblings are not throttled.)

/**
 * Max sub-agents in flight at the same time (Bonus, 2026-05). Parallel
 * siblings let the model fan out research tasks — e.g. "for each of these
 * 4 files, summarize the public surface" — without the historic serial
 * pressure from the depth counter doubling as a concurrency gate.
 */
export const SUB_AGENT_MAX_PARALLEL = 4

/** Tight caps so a sub-agent cannot runaway inside the parent's budget. */
export const SUB_AGENT_BUDGET = { maxToolCalls: 10, maxIterations: 5 } as const

export const DELEGATE_TASK_TOOL_DEF: MCPToolDefinition = {
  name: 'delegate_task',
  description:
    'Spawn a focused sub-agent to work on a sub-goal autonomously. '
    + 'USE for self-contained research or analysis tasks that would pollute the main conversation with tool-call chatter. '
    + 'The sub-agent has its own tight budget (max 10 tool calls, 5 ReAct iterations) and returns a concise final answer. '
    + 'PARALLELIZE: emit multiple delegate_task tool calls in the SAME assistant turn '
    + 'to fan out (e.g. one sub-agent per file) — up to 4 run concurrently. '
    + 'DO NOT call from inside another delegate_task — recursion is filtered by the harness. '
    + 'NOT a replacement for a regular tool call when one direct tool would do.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'One-sentence statement of what the sub-agent should accomplish.',
      },
      context: {
        type: 'string',
        description: 'Optional background information the sub-agent needs but should not search for.',
      },
    },
    required: ['goal'],
  },
  category: 'workflow',
  source: 'builtin',
}

/**
 * In-flight counter — module-scoped so parallel siblings + nested
 * children share one bound. Reset only by successful return or thrown
 * error; see the try/finally in the executor.
 *
 * Pre-Bonus this was named `_depth` and doubled as a concurrency gate,
 * which made three parallel siblings impossible. Now strictly counts
 * concurrent sub-agents; the description forbids recursion and the
 * registry filter enforces it.
 */
let _inFlight = 0

/** Exposed for tests. */
export function _getDepth(): number {
  return _inFlight
}
/** Exposed for tests. */
export function _setDepth(n: number): void {
  _inFlight = n
}

export type SubAgentRunner = (
  goal: string,
  context: string,
  options: { budget: AgentBudget; run?: AgentRunContext }
) => Promise<string>

/**
 * The sub-agent system prompt, in the same two halves the main loops use
 * (2.6.6, plan A5 and E3).
 *
 * A sub-agent runs the same tool registry on the same machine, so it needs the
 * same environment block: the platform sentence tells it which shell
 * shell_execute will open and how to open a file, and the clock line replaces
 * the retired clock tool. Without them a delegated step spent its tiny budget
 * probing the machine, or guessed `explorer` on a Mac.
 *
 * The order is the point. The role text and the platform sentence read the
 * same on every delegation, so they stay in front and a prefix cache can match
 * them. The clock changes every minute and closes the message, where a miss
 * costs only the last line instead of the whole prompt.
 */
export function buildSubAgentSystemPrompt(
  platformLine: string = platformPromptLine(),
  clockLine: string = hostClockLine(),
): string {
  const stable =
    'You are a focused sub-agent. Work autonomously toward the goal. '
    + 'Be concise, return a direct final answer without filler. '
    + 'Do NOT attempt to call delegate_task; it is not available to you.'
  return `${stable}\n\n${platformLine}\n\n${clockLine}`
}

/**
 * The gates a delegated tool call has to pass. Same three the parent loop
 * installs on its own executeParallel call, resolved for the sub-run.
 */
export interface SubAgentGates {
  awaitApproval: ApprovalGate
  recordAudit?: AuditRecorder
  abortSignal?: AbortSignal
  /**
   * id → why the gate said no, for refusals that are NOT a user clicking
   * reject. The executor's generic 'User rejected tool call' would otherwise
   * tell the sub-agent's model a story that never happened.
   */
  refusals: Map<string, string>
}

/**
 * Build the gates for one delegated run (audit AGT-1).
 *
 * A sub-agent runs a full ReAct loop over the whole tool registry minus
 * delegate_task — shell_execute, file_write and file_edit included, all three
 * 'confirm' by default. Until 2.6.7 it called executeParallel with getTool +
 * execute + explainError and NOTHING else: no approval gate (the executor's
 * was optional and therefore skipped), no audit trail, no abort signal. One
 * approved delegate_task bought an unattended, unlogged, uninterruptible
 * shell. Threading `run` (plan 2.6.6 C1) did not fix that: the run context
 * carries the conversation, workspace, artifact and read-only flags, so it
 * scopes WHERE a tool writes and whether shell_execute is read-only — it never
 * asked the user anything.
 *
 * The gates are resolved here rather than handed down from the hook on
 * purpose. All three live in module-scoped, conversation-keyed state (the
 * approval FIFO, the audit store, the permission store), so the run's
 * conversation id is enough to reach the SAME queue the parent loop uses —
 * the pending approval surfaces in the same UI, the tool call lands in the
 * same audit list. The parent's own awaitApproval closure could not be reused:
 * it resolves a request id against the batch it was built for and answers
 * "true" for anything it does not recognise, so a sub-agent's id would sail
 * straight through it.
 *
 * Fail closed: with no conversation to ask in, a 'confirm' tool is refused
 * rather than run.
 */
export async function buildSubAgentGates(run?: AgentRunContext): Promise<SubAgentGates> {
  const convId = run?.conversationId ?? null
  const abortSignal = run?.abortSignal
  const refusals = new Map<string, string>()

  const [{ usePermissionStore }, approvals] = await Promise.all([
    import('../../stores/permissionStore'),
    import('../../lib/approval-queue'),
  ])

  const awaitApproval: ApprovalGate = async (req) => {
    if (abortSignal?.aborted) {
      refusals.set(req.id, 'Aborted: the user stopped the run before this delegated tool call ran.')
      return false
    }
    const perm = usePermissionStore.getState()
    const level = toolRegistry.getPermissionLevelWithOverrides(
      req.toolName,
      perm.getEffectivePermissions(convId ?? undefined),
      perm.perToolOverrides,
    )
    if (level === 'blocked') {
      refusals.set(req.id, `Blocked: ${req.toolName} is not permitted in this conversation.`)
      return false
    }
    if (level === 'auto') return true
    // 'confirm' — the user decides, in the conversation that owns this run.
    if (!convId) {
      refusals.set(
        req.id,
        `Blocked: ${req.toolName} needs confirmation and this delegated run has no conversation to ask in.`,
      )
      return false
    }
    return new Promise<boolean>((resolve) => {
      const toolCall: AgentToolCall = {
        id: req.id,
        toolName: req.toolName,
        args: req.args,
        status: 'pending_approval',
        timestamp: Date.now(),
      }
      const entry: ApprovalEntry = { toolCall, resolve }
      approvals.enqueueApproval(convId, entry)
      // Stop has to answer a question nobody clicked, or the delegation (and
      // with it the parent turn) waits forever — same lesson as audit A4.
      abortSignal?.addEventListener(
        'abort',
        () => {
          if (approvals.removeApproval(convId, entry)) {
            refusals.set(req.id, 'Aborted: the user stopped the run while this tool call awaited approval.')
            resolve(false)
          }
        },
        { once: true },
      )
    })
  }

  if (!convId) return { awaitApproval, abortSignal, refusals }

  const { useToolAuditStore } = await import('../../stores/toolAuditStore')
  const auditIds = new Map<string, string>()
  const recordAudit: AuditRecorder = (entry) => {
    if (entry.kind === 'start') {
      auditIds.set(
        entry.id,
        useToolAuditStore.getState().record({
          convId,
          toolCallId: entry.id,
          toolName: entry.toolName,
          args: entry.args,
          startedAt: entry.startedAt,
          parentToolCallId: entry.parentToolCallId,
        }),
      )
      return
    }
    const aid = auditIds.get(entry.id)
    if (!aid) return
    useToolAuditStore.getState().complete(aid, {
      status: entry.status,
      completedAt: entry.completedAt,
      resultPreview: entry.resultPreview,
      error: entry.error,
      errorHint: entry.errorHint,
      cacheHit: entry.cacheHit,
    })
  }

  return { awaitApproval, recordAudit, abortSignal, refusals }
}

/**
 * Default sub-agent runner. Pulls in the active provider + model via
 * dynamic import to keep this module standalone and testable with a
 * stub runner. The real hook wiring lives in buildDelegateExecutor().
 */
export async function defaultSubAgentRunner(
  goal: string,
  context: string,
  options: { budget: AgentBudget; run?: AgentRunContext }
): Promise<string> {
  const { useModelStore } = await import('../../stores/modelStore')
  const { getProviderForModel } = await import('../providers')
  const activeModel = useModelStore.getState().activeModel
  if (!activeModel) return 'Error: No active model configured.'
  const { provider, modelId } = getProviderForModel(activeModel)

  const tools: MCPToolDefinition[] = toolRegistry
    .getAll()
    .filter((t) => t.name !== DELEGATE_TASK_TOOL_DEF.name)

  const llmTools = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))

  // The sub-agent's own conversation — data this file writes, so it gets the
  // declared type `provider.chatWithTools` reads rather than a guard.
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSubAgentSystemPrompt(),
    },
    {
      role: 'user',
      content: context ? `Goal: ${goal}\n\nContext:\n${context}` : `Goal: ${goal}`,
    },
  ]

  // Approval + audit + Stop for every tool this sub-run fires (AGT-1).
  const gates = await buildSubAgentGates(options.run)

  let finalContent = ''
  for (let i = 0; i < SUB_AGENT_BUDGET.maxIterations; i++) {
    if (gates.abortSignal?.aborted) {
      return finalContent || '(sub-agent stopped by the user)'
    }
    options.budget.addIteration()
    const ex = options.budget.exceeded()
    if (ex.kind !== 'none') {
      return `${options.budget.haltMessage()} ${finalContent || '(no partial answer)'}`
    }
    const turn = await provider.chatWithTools(modelId, messages, llmTools, {})
    // What a sub-agent returns becomes a TOOL RESULT in the parent's context,
    // so leaked reasoning floods the run it was supposed to shorten (2.6.7
    // Denk-Audit, Loch 11). Same settlement as every visible surface.
    const settled = settleThinking(turn.content || '', '', false).content
    finalContent = settled || finalContent
    if (!turn.toolCalls || turn.toolCalls.length === 0) break

    options.budget.addToolCalls(turn.toolCalls.length)
    const requests: ExecutionRequest[] = turn.toolCalls.map((tc, idx) => ({
      id: `sub-${Date.now()}-${idx}`,
      toolName: tc.function.name,
      args: tc.function.arguments,
      parentToolCallId: 'sub-agent',
      // A sub-agent inherits its parent's run, so its tool calls are gated by
      // the same conversation and mode instead of whatever the process-wide
      // singleton happens to hold (plan 2.6.6 C1).
      run: options.run,
    }))
    const registry = toolRegistry
    const results = await executeParallel(
      requests,
      {
        getTool: (name) => registry.resolveExecutable(name),
        execute: (name: string, args: ToolArgs, callRun?: AgentRunContext) =>
          registry.execute(name, args, 1, callRun),
        explainError: (toolName, err) => explainToolError(toolName, err),
        // The three gates the nested loop used to run without.
        awaitApproval: gates.awaitApproval,
        recordAudit: gates.recordAudit,
      },
      { abortSignal: gates.abortSignal },
    )

    messages.push({ role: 'assistant', content: turn.content || '', tool_calls: turn.toolCalls })
    // Map each result back to its ORIGINATING call by index. executeParallel
    // preserves input order (results[i] <-> requests[i] <-> turn.toolCalls[i]),
    // so zipping by index gives every tool message the correct tool_call_id —
    // even when the turn fired the same tool twice. The previous find-by-name
    // matched the FIRST call for both duplicates, leaving the second call's id
    // with no result; strict OpenAI-compatible providers (lu-cloud/DeepInfra,
    // openai, anthropic) then 400/422'd on the next turn and delegate_task
    // aborted. The main loop already handles this the same way (useCodex.ts).
    results.forEach((r, i) => {
      messages.push({
        role: 'tool',
        // A gate refusal explains itself; only a real user rejection falls
        // through to the executor's own wording.
        content: r.result ?? gates.refusals.get(r.id) ?? r.error ?? '(no output)',
        tool_call_id: turn.toolCalls[i]?.id,
      })
    })
  }

  return finalContent || '(sub-agent produced no final answer)'
}

/**
 * Build a tool executor suitable for toolRegistry.registerBuiltin. The
 * runner is injectable so tests can stub the whole LLM round-trip.
 */
export function buildDelegateExecutor(
  runner: SubAgentRunner = defaultSubAgentRunner
): (args: ToolArgs, run?: AgentRunContext) => Promise<string> {
  return async (args: ToolArgs, run?: AgentRunContext) => {
    if (_inFlight >= SUB_AGENT_MAX_PARALLEL) {
      return `Error: Maximum sub-agent concurrency (${SUB_AGENT_MAX_PARALLEL}) reached. Wait for a running sub-agent to finish, or continue the task yourself.`
    }
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''
    if (!goal) return 'Error: delegate_task requires a "goal" argument.'
    const context = typeof args.context === 'string' ? args.context.trim() : ''

    _inFlight++
    try {
      const budget = new AgentBudget({ ...SUB_AGENT_BUDGET })
      return await runner(goal, context, { budget, run })
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      _inFlight--
    }
  }
}
